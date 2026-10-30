import "server-only"
import { getTwitchAccessToken, readTwitchConfig } from "@/shared/auth/twitch"
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

export type ProcessorRunSummary = {
  scanned: number
  readyForReview: number
  rejected: number
  retrying: number
  skipped: number
}

async function dependencies() {
  const firebase = readServerConfig(process.env)
  const { db } = getServerFirebase()
  const common = {
    store: createPitchStore(db),
    context: createPitchContextProvider(db),
    duplicates: createDuplicateSuggester(db),
    now: Date.now,
  }
  if (firebase.mode === "emulator") {
    return { ...common, ...createFakePitchProviders() }
  }

  const twitch = readTwitchConfig(process.env)
  const auth = await loadAuthDependencies(twitch)
  const maps = readGoogleMapsConfig(process.env)
  return {
    ...common,
    automod: createTwitchAutoModProvider({
      clientId: twitch.clientId,
      broadcasterId: twitch.ownerId,
      getAccessToken: (forceRefresh = false) =>
        getTwitchAccessToken(twitch, auth, forceRefresh),
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
  limit = 5
): Promise<ProcessorRunSummary> {
  const now = Date.now()
  const { db } = getServerFirebase()
  const ids = await findClaimablePitchIds(db, now, limit)
  if (!ids.length) {
    return {
      scanned: 0,
      readyForReview: 0,
      rejected: 0,
      retrying: 0,
      skipped: 0,
    }
  }
  const deps = await dependencies()
  const results: ProcessPitchResult[] = []
  // Sequential by design: normal Twitch accounts allow only five AutoMod checks/minute.
  for (const id of ids) results.push(await processPitch(id, deps))
  return {
    scanned: ids.length,
    readyForReview: results.filter(
      (result) => result.kind === "ready_for_review"
    ).length,
    rejected: results.filter((result) => result.kind === "rejected").length,
    retrying: results.filter((result) => result.kind === "retry").length,
    skipped: results.filter((result) => result.kind === "not_claimed").length,
  }
}
