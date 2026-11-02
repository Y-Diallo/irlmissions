import type { MissionRecord } from "@/shared/missions"
import {
  distanceMeters,
  type Coordinates,
  type PlaceCandidate,
  type WalkingRoute,
} from "@/shared/pitches/processor"
import type { PollRecord } from "@/shared/polls"

export const MAX_MAP_ACCURACY_METERS = 50
export const DEFAULT_MAP_LOCATION_MAX_AGE_MS = 30_000
/** A dropped feed keeps its last position on the map, greyed, this long. */
export const MAP_STALE_POSITION_MAX_MS = 15 * 60_000
/** Poll routes are refetched once the streamer has moved this far... */
export const POLL_ROUTE_MOVED_METERS = 150
/** ...and at most this often. */
export const POLL_ROUTE_REFRESH_MS = 60_000

export type MapPoint = {
  latitude: number
  longitude: number
  observedAt: number
  accuracyMeters?: number
}

export type PublicMapDestination = {
  latitude: number
  longitude: number
  name: string
}

export type PublicMapOption = {
  position: number
  title: string
  votes: number
  destination: PublicMapDestination
  /** Route from the streamer's current location; only with a public position. */
  encodedRoute?: string
}

export type MapProjection = {
  state: "idle" | "voting" | "heading" | "arrived" | "recap"
  updatedAt: number
  pollKey?: string
  missionKey?: string
  outcome?: "completed" | "failed"
  position?: MapPoint
  /** The feed has gone quiet: the position is the last one known. */
  positionStale?: true
  options?: PublicMapOption[]
  destination?: PublicMapDestination
  encodedRoute?: string
}

export type MapPitchOption = {
  title: string
  votes?: number
  destination: PlaceCandidate | null
  /** Encoded polyline from the current location, when one was fetched. */
  route?: string
}

/** Private: privateState/pollRoutes. */
export type StoredPollRoutes = {
  attemptId: string
  origin: Coordinates
  /** redemptionId -> encoded polyline */
  routes: Record<string, string>
  computedAt: number
}

// Fetch once per poll, then again only after real movement, so a two-minute
// poll costs a handful of Routes calls rather than one per map refresh.
export function pollRoutesNeedRefresh(
  stored: StoredPollRoutes | null,
  attemptId: string,
  origin: Coordinates,
  now: number
) {
  if (!stored || stored.attemptId !== attemptId) return true
  return (
    now - stored.computedAt >= POLL_ROUTE_REFRESH_MS &&
    distanceMeters(stored.origin, origin) >= POLL_ROUTE_MOVED_METERS
  )
}

type StoredLocation = Partial<MapPoint> & {
  receivedAt?: number
  feedHeartbeatAt?: number
  privacyBlocked?: boolean
}

function stableHash(value: string) {
  let hash = 2166136261
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index)
    hash = Math.imul(hash, 16777619)
  }
  return hash >>> 0
}

function publicDestination(destination: PlaceCandidate): PublicMapDestination {
  return {
    latitude: destination.latitude,
    longitude: destination.longitude,
    name: destination.name.slice(0, 120),
  }
}

function publicPosition(
  location: StoredLocation | null,
  now: number,
  maxAgeMs: number,
  manuallyHidden: boolean
): Pick<MapProjection, "position" | "positionStale"> {
  if (manuallyHidden || !location || location.privacyBlocked) return {}
  if (
    typeof location.feedHeartbeatAt !== "number" ||
    now - location.feedHeartbeatAt > MAP_STALE_POSITION_MAX_MS ||
    typeof location.latitude !== "number" ||
    typeof location.longitude !== "number" ||
    typeof location.observedAt !== "number"
  ) {
    return {}
  }
  if (
    typeof location.accuracyMeters === "number" &&
    location.accuracyMeters > MAX_MAP_ACCURACY_METERS
  ) {
    return {}
  }
  return {
    position: {
      latitude: location.latitude,
      longitude: location.longitude,
      observedAt: location.observedAt,
      ...(typeof location.accuracyMeters === "number"
        ? { accuracyMeters: location.accuracyMeters }
        : {}),
    },
    // Past the live cutoff the map greys the pin and paths rather than
    // dropping them; privacy reasons above still hide them outright.
    ...(now - location.feedHeartbeatAt > maxAgeMs
      ? { positionStale: true as const }
      : {}),
  }
}

function routeGeometry(route: WalkingRoute | null | undefined) {
  return typeof route?.encodedPolyline === "string" && route.encodedPolyline
    ? { encodedRoute: route.encodedPolyline }
    : {}
}

export function createMapProjection(input: {
  mission: MissionRecord | null
  poll?: PollRecord | null
  pollOptions?: MapPitchOption[]
  location: StoredLocation | null
  now: number
  locationMaxAgeMs?: number
  manuallyHidden?: boolean
}): MapProjection {
  const { mission, poll, now } = input
  const location = publicPosition(
    input.location,
    now,
    input.locationMaxAgeMs ?? DEFAULT_MAP_LOCATION_MAX_AGE_MS,
    input.manuallyHidden === true
  )

  if (poll && (poll.status === "active" || poll.status === "tie")) {
    const options = (input.pollOptions ?? []).flatMap((option, index) =>
      option.destination
        ? [
            {
              position: index + 1,
              title: option.title.slice(0, 25),
              votes: Math.max(0, option.votes ?? 0),
              destination: publicDestination(option.destination),
              // A route starts at the streamer, so it is as revealing as the
              // position itself and only shows when the position does.
              ...(location.position && option.route
                ? { encodedRoute: option.route }
                : {}),
            },
          ]
        : []
    )
    if (options.length) {
      return {
        state: "voting",
        updatedAt: now,
        pollKey: String(stableHash(poll.attemptId)),
        ...location,
        options,
      }
    }
  }

  if (!mission?.destination) return { state: "idle", updatedAt: now }
  const missionKey = String(stableHash(mission.missionId))
  const destination = publicDestination(mission.destination)
  if (mission.status === "heading" || mission.status === "arrived") {
    return {
      state: mission.status,
      updatedAt: now,
      missionKey,
      ...location,
      destination,
      ...routeGeometry(mission.walkingRoute),
    }
  }
  if (mission.status === "completed" || mission.status === "failed") {
    return {
      state: "recap",
      updatedAt: now,
      missionKey,
      outcome: mission.status,
      destination,
      ...routeGeometry(mission.walkingRoute),
    }
  }
  return { state: "idle", updatedAt: now }
}
