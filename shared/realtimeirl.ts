import { transitionMission, type MissionRecord } from "@/shared/missions"
import { distanceMeters, type Coordinates } from "@/shared/pitches/processor"

export const DEFAULT_ARRIVAL_RADIUS_METERS = 50
export const DEFAULT_ARRIVAL_SAMPLE_SPAN_MS = 10_000
export const DEFAULT_LOCATION_MAX_AGE_MS = 30_000
const MAX_FUTURE_SKEW_MS = 5_000
/**
 * Reports later than the arrival window still move the map, up to this old.
 * Network lag or a phone clock that runs behind shouldn't freeze the pin.
 */
export const MAX_LATE_SAMPLE_MS = 5 * 60_000
/** A phone clock up to this far ahead is read as "now" rather than dropped. */
const MAX_CLOCK_AHEAD_MS = 5 * 60_000

export type RealtimeIrlSample = Coordinates & {
  observedAt: number
  accuracyMeters?: number
  sessionId?: string
}

export type ArrivalSettings = {
  baseZone: Coordinates & { radiusMeters: number }
  arrivalRadiusMeters: number
  arrivalSampleSpanMs: number
  locationMaxAgeMs: number
}

export type ArrivalConfirmation = {
  missionId: string
  firstObservedAt: number
  lastObservedAt: number
}

export type ArrivalDecision = {
  status:
    | "stale"
    | "duplicate"
    | "no_active_mission"
    | "mission_finished"
    | "already_revealed"
    | "privacy_zone"
    | "awaiting_location"
    | "late"
    | "outside_destination"
    | "confirming"
    | "arrived"
    | "revealed"
  fresh: boolean
  privacyBlocked: boolean
  distanceToDestinationMeters?: number
  nextConfirmation: ArrivalConfirmation | null
  mission?: MissionRecord
}

export class RealtimeIrlError extends Error {
  constructor(
    public readonly code: string,
    public readonly status = 400
  ) {
    super(code)
  }
}

function object(value: unknown, code: string) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new RealtimeIrlError(code)
  }
  return value as Record<string, unknown>
}

function finiteNumber(value: unknown, code: string) {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new RealtimeIrlError(code)
  }
  return value
}

function positiveSetting(value: unknown, fallback: number, code: string) {
  if (value === undefined) return fallback
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new RealtimeIrlError(code, 503)
  }
  const result = value
  if (result <= 0) throw new RealtimeIrlError(code, 503)
  return result
}

export function parseRealtimeIrlSample(value: unknown): RealtimeIrlSample {
  const input = object(value, "invalid_location_sample")
  const latitude = finiteNumber(input.latitude, "invalid_location_sample")
  const longitude = finiteNumber(input.longitude, "invalid_location_sample")
  const observedAt = finiteNumber(input.observedAt, "invalid_location_sample")
  const accuracyMeters = input.accuracyMeters
  const sessionId = parseRealtimeIrlSessionId(input.sessionId)
  if (
    latitude < -90 ||
    latitude > 90 ||
    longitude < -180 ||
    longitude > 180 ||
    !Number.isInteger(observedAt) ||
    observedAt < 0 ||
    (accuracyMeters !== undefined &&
      (typeof accuracyMeters !== "number" ||
        !Number.isFinite(accuracyMeters) ||
        accuracyMeters < 0 ||
        accuracyMeters > 10_000))
  ) {
    throw new RealtimeIrlError("invalid_location_sample")
  }
  return {
    latitude,
    longitude,
    observedAt,
    ...(typeof accuracyMeters === "number" ? { accuracyMeters } : {}),
    ...(sessionId ? { sessionId } : {}),
  }
}

/** An optional RealtimeIRL session id; anything malformed is rejected. */
export function parseRealtimeIrlSessionId(value: unknown) {
  if (value === undefined || value === null) return undefined
  if (typeof value !== "string" || value.length < 1 || value.length > 128) {
    throw new RealtimeIrlError("invalid_location_sample")
  }
  return value
}

/**
 * A heartbeat says the feed is alive, not where the streamer is. It only
 * vouches for a stored position from the same RealtimeIRL session: a new
 * session (the app started late) waits for its first real sample instead
 * of reviving wherever the last one ended. Older overlays send no session.
 */
export function heartbeatVouchesFor(
  storedSessionId: unknown,
  sessionId: string | undefined
) {
  return sessionId === undefined || storedSessionId === sessionId
}

export function parseArrivalSettings(value: unknown): ArrivalSettings {
  const input = object(value, "arrival_configuration")
  const base = object(input.baseZone, "arrival_configuration")
  const latitude = finiteNumber(base.latitude, "arrival_configuration")
  const longitude = finiteNumber(base.longitude, "arrival_configuration")
  const radiusMeters = finiteNumber(base.radiusMeters, "arrival_configuration")
  if (
    latitude < -90 ||
    latitude > 90 ||
    longitude < -180 ||
    longitude > 180 ||
    radiusMeters < 0
  ) {
    throw new RealtimeIrlError("arrival_configuration", 503)
  }
  return {
    baseZone: { latitude, longitude, radiusMeters },
    arrivalRadiusMeters: positiveSetting(
      input.arrivalRadiusMeters,
      DEFAULT_ARRIVAL_RADIUS_METERS,
      "arrival_configuration"
    ),
    arrivalSampleSpanMs: positiveSetting(
      input.arrivalSampleSpanMs,
      DEFAULT_ARRIVAL_SAMPLE_SPAN_MS,
      "arrival_configuration"
    ),
    locationMaxAgeMs: positiveSetting(
      input.arrivalLocationMaxAgeMs,
      DEFAULT_LOCATION_MAX_AGE_MS,
      "arrival_configuration"
    ),
  }
}

export function evaluateRealtimeIrlArrival(input: {
  sample: RealtimeIrlSample
  now: number
  settings: ArrivalSettings
  mission: MissionRecord | null
  confirmation: ArrivalConfirmation | null
  latestObservedAt?: number
}): ArrivalDecision & { observedAt?: number } {
  const { now } = input
  const ahead = input.sample.observedAt - now
  if (ahead > MAX_CLOCK_AHEAD_MS || -ahead > MAX_LATE_SAMPLE_MS) {
    return {
      status: "stale",
      fresh: false,
      privacyBlocked: false,
      nextConfirmation: null,
    }
  }
  const sample =
    ahead > MAX_FUTURE_SKEW_MS
      ? { ...input.sample, observedAt: now }
      : input.sample
  const decision = evaluateTimedSample({ ...input, sample })
  // The time the store saves, after any clock correction.
  return decision.fresh
    ? { ...decision, observedAt: sample.observedAt }
    : decision
}

function evaluateTimedSample(input: {
  sample: RealtimeIrlSample
  now: number
  settings: ArrivalSettings
  mission: MissionRecord | null
  confirmation: ArrivalConfirmation | null
  latestObservedAt?: number
}): ArrivalDecision {
  const { sample, now, settings, mission } = input
  if (
    input.latestObservedAt !== undefined &&
    sample.observedAt <= input.latestObservedAt
  ) {
    return {
      status: "duplicate",
      fresh: false,
      privacyBlocked: false,
      nextConfirmation: input.confirmation,
    }
  }

  const insideBase =
    distanceMeters(sample, settings.baseZone) <= settings.baseZone.radiusMeters
  // Too late to count toward arrival, but still the newest position.
  if (now - sample.observedAt > settings.locationMaxAgeMs) {
    return {
      status: "late",
      fresh: true,
      privacyBlocked: insideBase,
      nextConfirmation: input.confirmation,
    }
  }
  if (!mission) {
    return {
      status: "no_active_mission",
      fresh: true,
      privacyBlocked: insideBase,
      nextConfirmation: null,
    }
  }
  if (
    mission.status === "completed" ||
    mission.status === "failed" ||
    mission.status === "canceled"
  ) {
    return {
      status: "mission_finished",
      fresh: true,
      privacyBlocked: insideBase,
      nextConfirmation: null,
    }
  }
  // An anywhere mission has no place to arrive at or reveal.
  if (mission.destinationRevealedAt || !mission.destination) {
    return {
      status: "already_revealed",
      fresh: true,
      privacyBlocked: insideBase,
      nextConfirmation: null,
    }
  }
  if (insideBase) {
    return {
      status: "privacy_zone",
      fresh: true,
      privacyBlocked: true,
      nextConfirmation: null,
    }
  }

  const distanceToDestinationMeters = distanceMeters(
    sample,
    mission.destination
  )
  if (distanceToDestinationMeters > settings.arrivalRadiusMeters) {
    return {
      status: "outside_destination",
      fresh: true,
      privacyBlocked: false,
      distanceToDestinationMeters,
      nextConfirmation: null,
    }
  }

  const previous = input.confirmation
  const usablePrevious =
    previous?.missionId === mission.missionId &&
    previous.firstObservedAt <= previous.lastObservedAt &&
    now - previous.firstObservedAt <= settings.locationMaxAgeMs &&
    previous.lastObservedAt <= sample.observedAt
      ? previous
      : null
  const nextConfirmation = usablePrevious
    ? {
        ...usablePrevious,
        lastObservedAt: Math.max(
          usablePrevious.lastObservedAt,
          sample.observedAt
        ),
      }
    : {
        missionId: mission.missionId,
        firstObservedAt: sample.observedAt,
        lastObservedAt: sample.observedAt,
      }

  if (
    nextConfirmation.lastObservedAt - nextConfirmation.firstObservedAt <
    settings.arrivalSampleSpanMs
  ) {
    return {
      status: "confirming",
      fresh: true,
      privacyBlocked: false,
      distanceToDestinationMeters,
      nextConfirmation,
    }
  }

  const arrived =
    mission.status === "heading"
      ? transitionMission(mission, "arrive", now)
      : mission
  return {
    status: mission.status === "heading" ? "arrived" : "revealed",
    fresh: true,
    privacyBlocked: false,
    distanceToDestinationMeters,
    nextConfirmation: null,
    mission: {
      ...arrived,
      destinationRevealedAt: now,
      updatedAt: now,
    },
  }
}

export function evaluateRealtimeIrlHeartbeat(input: {
  location: Coordinates
  now: number
  settings: ArrivalSettings
  mission: MissionRecord | null
  confirmation: ArrivalConfirmation | null
}) {
  // An authenticated heartbeat confirms that the RealtimeIRL pull session is
  // online. It can keep an unchanged coordinate usable without pretending the
  // provider emitted a new GPS observation.
  return evaluateRealtimeIrlArrival({
    sample: { ...input.location, observedAt: input.now },
    now: input.now,
    settings: input.settings,
    mission: input.mission,
    confirmation: input.confirmation,
  })
}
