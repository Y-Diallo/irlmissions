import "server-only"
import { isDemoTenant } from "@/shared/auth/demo-owner"
import { getTwitchAccessToken, readTwitchConfig } from "@/shared/auth/twitch"
import { readServerConfig } from "@/shared/config"
import {
  getGooglePlaceStatus,
  readGoogleMapsConfig,
} from "@/shared/providers/google-maps"
import { createTwitchRolesProvider } from "@/shared/providers/twitch-roles"
import { loadAuthDependencies } from "@/lib/auth/server"
import {
  runAutomation,
  type AutomationDependencies,
} from "@/lib/automation/runner"
import { getServerFirebase } from "@/lib/firebase/admin"
import { startLivePoll } from "@/lib/polls/service"

async function liveDependencies(
  tenantId: string
): Promise<AutomationDependencies> {
  const startPoll: AutomationDependencies["startPoll"] = (command) =>
    startLivePoll(tenantId, command)
  if (
    readServerConfig(process.env).mode === "emulator" ||
    isDemoTenant(tenantId)
  ) {
    return {
      async isTrusted() {
        return true
      },
      async placeStatus() {
        return { businessStatus: "operational", openNow: true }
      },
      startPoll,
    }
  }
  const twitch = readTwitchConfig(process.env)
  const auth = await loadAuthDependencies(twitch)
  const roles = createTwitchRolesProvider({
    broadcasterId: tenantId,
    clientId: twitch.clientId,
    getAccessToken: (forceRefresh = false) =>
      getTwitchAccessToken(twitch, auth, tenantId, forceRefresh),
  })
  return {
    isTrusted: (viewerId) => roles.isTrusted(viewerId),
    placeStatus: (placeId) =>
      getGooglePlaceStatus(readGoogleMapsConfig(process.env), placeId),
    startPoll,
  }
}

export async function runLiveAutomation(tenantId: string) {
  return runAutomation(
    getServerFirebase().db,
    tenantId,
    await liveDependencies(tenantId),
    Date.now()
  )
}
