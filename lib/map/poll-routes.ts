import "server-only"

import type { Firestore } from "firebase-admin/firestore"
import { pollRoutesNeedRefresh, type StoredPollRoutes } from "@/shared/map"
import type {
  Coordinates,
  PlaceCandidate,
  TravelMode,
  WalkingRoute,
} from "@/shared/pitches/processor"
import { tenantDoc } from "@/shared/tenant"

/** One refresher at a time; a crashed one is retried after this long. */
const CLAIM_MS = 20_000

export type RouteWalker = (
  origin: Coordinates,
  destination: Coordinates,
  mode: TravelMode
) => Promise<WalkingRoute>

function storedFrom(data: FirebaseFirestore.DocumentData | undefined) {
  return data &&
    typeof data.attemptId === "string" &&
    typeof data.computedAt === "number" &&
    data.routes &&
    typeof data.routes === "object"
    ? (data as StoredPollRoutes & { claimedAt?: number })
    : null
}

// Routes from the streamer's current location to every poll option, kept
// private and refreshed only after real movement. Returns what is usable for
// this poll, which may be nothing while another request is fetching.
export async function ensurePollRoutes(
  db: Firestore,
  tenantId: string,
  input: {
    attemptId: string
    origin: Coordinates
    mode: TravelMode
    destinations: Array<{ redemptionId: string; destination: PlaceCandidate }>
  },
  walk: RouteWalker,
  now: number
): Promise<Record<string, string>> {
  const ref = db.doc(tenantDoc(tenantId, "privateState/pollRoutes"))
  const claim = await db.runTransaction(async (tx) => {
    const stored = storedFrom((await tx.get(ref)).data())
    if (!pollRoutesNeedRefresh(stored, input.attemptId, input.origin, now)) {
      return { stored, fetch: false }
    }
    if (stored?.claimedAt && now - stored.claimedAt < CLAIM_MS) {
      return { stored, fetch: false }
    }
    tx.set(ref, { claimedAt: now }, { merge: true })
    return { stored, fetch: true }
  })
  const current =
    claim.stored?.attemptId === input.attemptId ? claim.stored.routes : {}
  if (!claim.fetch) return current

  const results = await Promise.allSettled(
    input.destinations.map(async ({ redemptionId, destination }) => {
      const route = await walk(input.origin, destination, input.mode)
      return route.encodedPolyline
        ? ([redemptionId, route.encodedPolyline] as const)
        : null
    })
  )
  const routes: Record<string, string> = {}
  for (const result of results) {
    if (result.status === "fulfilled" && result.value) {
      routes[result.value[0]] = result.value[1]
    }
  }
  // A failed refresh keeps the older routes for this poll rather than none.
  const next: StoredPollRoutes = {
    attemptId: input.attemptId,
    origin: {
      latitude: input.origin.latitude,
      longitude: input.origin.longitude,
    },
    routes: { ...current, ...routes },
    computedAt: now,
  }
  await ref.set({ ...next, claimedAt: 0 })
  return next.routes
}
