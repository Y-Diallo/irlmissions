import "server-only"
import { getTwitchAccessToken, readTwitchConfig } from "@/shared/auth/twitch"
import { isDemoTenant } from "@/shared/auth/demo-owner"
import { readServerConfig } from "@/shared/config"
import {
  processPitch,
  type ProcessPitchResult,
} from "@/shared/pitches/processor"
import { createFakePitchProviders } from "@/shared/providers/fake-pitch"
import {
  createGooglePlacesProvider,
  createGoogleRoutesProvider,
  readGoogleMapsConfig,
} from "@/shared/providers/google-maps"
import {
  createOpenAIPitchExtractor,
  readOpenAIPitchConfig,
} from "@/shared/providers/openai-pitch"
import { createTwitchAutoModProvider } from "@/shared/providers/twitch-automod"
import { loadAuthDependencies } from "@/lib/auth/server"
import { getServerFirebase } from "@/lib/firebase/admin"
import {
  createDuplicateSuggester,
  createPitchContextProvider,
  createPitchStore,
  findClaimablePitchIds,
} from "@/lib/pitches/store"
import { processPendingPollEnds } from "@/lib/polls/end-store"
import { processPendingRedemptions } from "@/lib/redemptions/runner"

export type ProcessorRunSummary = {
  redemptions: {
    scanned: number
    completed: number
    retrying: number
    errors: number
    skipped: number
  }
  pollEvents: {
    scanned: number
    winners: number
    noWinner: number
    ignored: number
    errors: number
  }
  scanned: number
  readyForReview: number
  rejected: number
  retrying: number
  skipped: number
}

async function dependencies(tenantId: string) {
  const firebase = readServerConfig(process.env)
  const { db } = getServerFirebase()
  const common = {
    store: createPitchStore(db, tenantId),
    context: createPitchContextProvider(db, tenantId),
    duplicates: createDuplicateSuggester(db, tenantId),
    now: Date.now,
  }
  if (firebase.mode === "emulator" || isDemoTenant(tenantId)) {
    return { ...common, ...createFakePitchProviders() }
  }

  const twitch = readTwitchConfig(process.env)
  const auth = await loadAuthDependencies(twitch)
  const maps = readGoogleMapsConfig(process.env)
  return {
    ...common,
    automod: createTwitchAutoModProvider({
      clientId: twitch.clientId,
      broadcasterId: tenantId,
      getAccessToken: (forceRefresh = false) =>
        getTwitchAccessToken(twitch, auth, tenantId, forceRefresh),
    }),
    extractor: {
      extract(text: string) {
        // Keep the LLM genuinely optional: config is required only if settings enable it.
        return createOpenAIPitchExtractor(
          readOpenAIPitchConfig(process.env)
        ).extract(text)
      },
    },
    places: createGooglePlacesProvider(maps),
    routes: createGoogleRoutesProvider(maps),
  }
}

export async function runClaimablePitches(
  tenantId: string,
  limit = 5
): Promise<ProcessorRunSummary> {
  const now = Date.now()
  const { db } = getServerFirebase()
  const firebase = readServerConfig(process.env)
  const pollEvents = await processPendingPollEnds(db, tenantId, limit, now)
  const resolveRedemptions = () =>
    firebase.mode === "live" && !isDemoTenant(tenantId)
      ? processPendingRedemptions(db, tenantId, limit, now)
      : Promise.resolve({
          scanned: 0,
          completed: 0,
          retrying: 0,
          errors: 0,
          skipped: 0,
        })
  const ids = await findClaimablePitchIds(db, tenantId, now, limit)
  if (!ids.length) {
    return {
      redemptions: await resolveRedemptions(),
      pollEvents,
      scanned: 0,
      readyForReview: 0,
      rejected: 0,
      retrying: 0,
      skipped: 0,
    }
  }
  const [redemptions, results] = await Promise.all([
    resolveRedemptions(),
    (async () => {
      const deps = await dependencies(tenantId)
      const processed: ProcessPitchResult[] = []
      // Sequential by design: normal Twitch accounts allow only five AutoMod checks/minute.
      for (const id of ids) processed.push(await processPitch(id, deps))
      return processed
    })(),
  ])
  return {
    redemptions,
    pollEvents,
    scanned: ids.length,
    readyForReview: results.filter(
      (result) => result.kind === "ready_for_review"
    ).length,
    rejected: results.filter((result) => result.kind === "rejected").length,
    retrying: results.filter((result) => result.kind === "retry").length,
    skipped: results.filter((result) => result.kind === "not_claimed").length,
  }
}

export async function runPitchNow(tenantId: string, redemptionId: string) {
  return processPitch(redemptionId, await dependencies(tenantId))
}
