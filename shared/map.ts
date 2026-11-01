import type { MissionRecord } from "@/shared/missions"

export const FUZZY_DESTINATION_RADIUS_METERS = 250
export const MAX_MAP_ACCURACY_METERS = 50
export const DEFAULT_MAP_LOCATION_MAX_AGE_MS = 120_000

export type MapPoint = {
  latitude: number
  longitude: number
  observedAt: number
  accuracyMeters?: number
}

export type MapProjection = {
  state: "idle" | "heading" | "arrived"
  updatedAt: number
  missionKey?: string
  position?: MapPoint
  /** All suppression reasons intentionally share one public state. */
  positionStatus?: "coarse"
  destination?: {
    latitude: number
    longitude: number
    radiusMeters: number
    name?: string
  }
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

function fuzzyDestination(mission: MissionRecord) {
  if (!mission.destination) return undefined
  const hash = stableHash(mission.missionId)
  const angle = ((hash % 3600) / 10) * (Math.PI / 180)
  const offsetMeters = 60 + ((hash >>> 12) % 81)
  const latitudeOffset = (Math.cos(angle) * offsetMeters) / 111_320
  const longitudeScale = Math.max(
    0.2,
    Math.cos((mission.destination.latitude * Math.PI) / 180)
  )
  const longitudeOffset =
    (Math.sin(angle) * offsetMeters) / (111_320 * longitudeScale)
  return {
    latitude: mission.destination.latitude + latitudeOffset,
    longitude: mission.destination.longitude + longitudeOffset,
    radiusMeters: FUZZY_DESTINATION_RADIUS_METERS - 30 + ((hash >>> 20) % 101),
    ...(mission.destinationRevealedAt
      ? { name: mission.destination.name }
      : {}),
  }
}

function publicPosition(
  location: StoredLocation | null,
  now: number,
  maxAgeMs: number,
  manuallyCoarse: boolean
): Pick<MapProjection, "position" | "positionStatus"> {
  if (manuallyCoarse || !location || location.privacyBlocked) {
    return { positionStatus: "coarse" }
  }
  if (
    typeof location.feedHeartbeatAt !== "number" ||
    now - location.feedHeartbeatAt > maxAgeMs ||
    typeof location.latitude !== "number" ||
    typeof location.longitude !== "number" ||
    typeof location.observedAt !== "number"
  ) {
    return { positionStatus: "coarse" }
  }
  if (
    typeof location.accuracyMeters === "number" &&
    location.accuracyMeters > MAX_MAP_ACCURACY_METERS
  ) {
    return { positionStatus: "coarse" }
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
  }
}

export function createMapProjection(input: {
  mission: MissionRecord | null
  location: StoredLocation | null
  now: number
  locationMaxAgeMs?: number
  manuallyCoarse?: boolean
}): MapProjection {
  const { mission, now } = input
  if (
    !mission ||
    (mission.status !== "heading" && mission.status !== "arrived") ||
    !mission.destination
  ) {
    return { state: "idle", updatedAt: now }
  }
  return {
    state: mission.status,
    updatedAt: now,
    missionKey: String(stableHash(mission.missionId)),
    ...publicPosition(
      input.location,
      now,
      input.locationMaxAgeMs ?? DEFAULT_MAP_LOCATION_MAX_AGE_MS,
      input.manuallyCoarse === true
    ),
    destination: fuzzyDestination(mission),
  }
}
