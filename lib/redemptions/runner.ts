import "server-only"

import { getTwitchAccessToken, readTwitchConfig } from "@/shared/auth/twitch"
import {
  newRedemptionLeaseId,
  processRedemption,
  type RedemptionDependencies,
} from "@/shared/redemptions"
import { createTwitchRedemptionProvider } from "@/shared/providers/twitch-redemptions"
import { loadAuthDependencies } from "@/lib/auth/server"
import {
  createRedemptionStore,
  findClaimableRedemptionIds,
} from "@/lib/redemptions/store"
import type { Firestore } from "firebase-admin/firestore"

export async function processPendingRedemptions(
  db: Firestore,
  limit = 5,
  now = Date.now()
) {
  const twitch = readTwitchConfig(process.env)
  const auth = await loadAuthDependencies(twitch)
  const deps: RedemptionDependencies = {
    store: createRedemptionStore(db),
    provider: createTwitchRedemptionProvider({
      broadcasterId: twitch.ownerId,
      clientId: twitch.clientId,
      getAccessToken: (forceRefresh = false) =>
        getTwitchAccessToken(twitch, auth, forceRefresh),
    }),
    now: Date.now,
    leaseId: newRedemptionLeaseId,
  }
  const ids = await findClaimableRedemptionIds(db, now, limit)
  const results = await Promise.all(
    ids.map((id) => processRedemption(id, deps))
  )
  return {
    scanned: ids.length,
    completed: results.filter((result) => result.kind === "completed").length,
    retrying: results.filter((result) => result.kind === "retry").length,
    errors: results.filter((result) => result.kind === "error").length,
    skipped: results.filter((result) => result.kind === "not_claimed").length,
  }
}
