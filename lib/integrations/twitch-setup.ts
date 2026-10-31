import "server-only"

import { randomUUID } from "node:crypto"
import {
  getTwitchAccessToken,
  readTwitchConfig,
} from "@/shared/auth/twitch"
import {
  createTwitchSetupProvider,
  TwitchSetupError,
} from "@/shared/providers/twitch-setup"
import { loadAuthDependencies } from "@/lib/auth/server"
import { getServerFirebase } from "@/lib/firebase/admin"
import { createIntegrationStore } from "@/lib/integrations/store"

function eventSubSecret() {
  const value = process.env.TWITCH_EVENTSUB_SECRET?.trim()
  if (!value || value.length < 10 || value.length > 100) {
    throw new TwitchSetupError("eventsub_configuration")
  }
  return value
}

export async function processTenantTwitchSetup(tenantId: string) {
  const now = Date.now()
  const leaseId = randomUUID()
  const store = createIntegrationStore(getServerFirebase().db, tenantId)
  const claim = await store.claimSetup(leaseId, now)
  if (!claim) return { status: "skipped" as const }
  try {
    const config = readTwitchConfig(process.env)
    const auth = await loadAuthDependencies(config)
    const provider = createTwitchSetupProvider({
      broadcasterId: tenantId,
      clientId: config.clientId,
      clientSecret: config.clientSecret,
      callbackUrl: `${new URL(config.redirectUri).origin}/api/eventsub`,
      eventSubSecret: eventSubSecret(),
      getUserAccessToken: (forceRefresh = false) =>
        getTwitchAccessToken(config, auth, tenantId, forceRefresh),
    })
    const reward = await provider.provision(claim.storedRewardId, async (value) => {
      if (!(await store.saveProvisionedReward(leaseId, value, Date.now()))) {
        throw new TwitchSetupError("twitch_setup_lease_lost")
      }
    })
    await store.completeSetup(leaseId, reward, Date.now())
    return { status: "ready" as const, rewardId: reward.id }
  } catch (error) {
    await store.failSetup(
      leaseId,
      error instanceof TwitchSetupError ? error.code : "twitch_setup_failed",
      Date.now()
    )
    return { status: "error" as const }
  }
}

export async function setTenantRewardEnabled(
  tenantId: string,
  enabled: boolean
) {
  const config = readTwitchConfig(process.env)
  const auth = await loadAuthDependencies(config)
  const store = createIntegrationStore(getServerFirebase().db, tenantId)
  const integration = await store.read()
  if (typeof integration?.rewardId !== "string") {
    throw new TwitchSetupError("twitch_reward_missing")
  }
  const provider = createTwitchSetupProvider({
    broadcasterId: tenantId,
    clientId: config.clientId,
    clientSecret: config.clientSecret,
    callbackUrl: `${new URL(config.redirectUri).origin}/api/eventsub`,
    eventSubSecret: eventSubSecret(),
    getUserAccessToken: (forceRefresh = false) =>
      getTwitchAccessToken(config, auth, tenantId, forceRefresh),
  })
  await provider.setRewardEnabled(integration.rewardId, enabled)
  await getServerFirebase().db
    .doc(`owners/${tenantId}`)
    .set({ rewardEnabled: enabled, updatedAt: Date.now() }, { merge: true })
  return { rewardEnabled: enabled }
}
