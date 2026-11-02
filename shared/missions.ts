import type {
  ConsequenceClearRule,
  PlaceCandidate,
  WalkingRoute,
} from "@/shared/pitches/processor"
import type { PollRecord } from "@/shared/polls"

export type MissionStatus =
  "heading" | "arrived" | "completed" | "failed" | "canceled"

export type MissionRecord = {
  missionId: string
  lockId: string
  /** Twitch poll ID, or "" when the owner picked the pitch directly. */
  pollId: string
  redemptionId: string
  /** Twitch display name of the viewer who pitched it, shown on the overlay. */
  viewerName?: string
  /** The viewer's original request, shown only on the owner's console. */
  request?: string
  /** Viewer's stated penalty, activated on the overlay if the mission fails. */
  failConsequence?: string
  failConsequenceClearRule?: ConsequenceClearRule
  failConsequenceDurationMinutes?: number
  status: MissionStatus
  publicLabel: string
  durationMinutes: number
  /** Null for an "anywhere" mission, which starts with its timer running. */
  destination: PlaceCandidate | null
  walkingRoute: WalkingRoute | null
  activatedAt: number
  updatedAt: number
  arrivedAt?: number
  timerEndsAt?: number
  outcomeAt?: number
  /** A producer veto: terminal like failure, but never activates its consequence. */
  outcome?: "denied"
  destinationRevealedAt?: number
}

export type MissionPitch = {
  redemptionId?: unknown
  reviewStatus?: unknown
  publicLabel?: unknown
  durationMinutes?: unknown
  destination?: unknown
  walkingRoute?: unknown
  lockedBy?: unknown
  viewer?: unknown
  rawText?: unknown
  extraction?: unknown
  noTravel?: unknown
}

export type MissionAction =
  "arrive" | "complete" | "fail" | "deny" | "extend" | "cancel"

export const EXTEND_MS = 5 * 60_000

export type MissionOwnerView = MissionRecord & {
  navigation: {
    googleMaps: string
    appleMaps: string
    waze: string
  } | null
}

export class MissionError extends Error {
  constructor(
    public readonly code: string,
    public readonly status = 409
  ) {
    super(code)
  }
}

function object(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null
}

function validDestination(value: unknown): PlaceCandidate {
  const destination = object(value)
  if (
    !destination ||
    typeof destination.placeId !== "string" ||
    typeof destination.name !== "string" ||
    typeof destination.address !== "string" ||
    typeof destination.latitude !== "number" ||
    !Number.isFinite(destination.latitude) ||
    destination.latitude < -90 ||
    destination.latitude > 90 ||
    typeof destination.longitude !== "number" ||
    !Number.isFinite(destination.longitude) ||
    destination.longitude < -180 ||
    destination.longitude > 180
  ) {
    throw new MissionError("invalid_mission_destination", 500)
  }
  return value as PlaceCandidate
}

function validWalkingRoute(value: unknown): WalkingRoute {
  const route = object(value)
  if (
    !route ||
    typeof route.distanceMeters !== "number" ||
    !Number.isFinite(route.distanceMeters) ||
    route.distanceMeters < 0 ||
    typeof route.durationSeconds !== "number" ||
    !Number.isFinite(route.durationSeconds) ||
    route.durationSeconds < 0
  ) {
    throw new MissionError("invalid_mission_route", 500)
  }
  const mode = route.mode
  return {
    distanceMeters: route.distanceMeters,
    durationSeconds: route.durationSeconds,
    mode:
      mode === "transit" || mode === "drive" || mode === "walk" ? mode : "walk",
    ...(typeof route.encodedPolyline === "string" && route.encodedPolyline
      ? { encodedPolyline: route.encodedPolyline }
      : {}),
  }
}

export function createMissionFromWinner(
  poll: PollRecord,
  pitch: MissionPitch,
  now: number
): MissionRecord {
  if (
    poll.status !== "completed" ||
    !poll.twitchPollId ||
    !poll.winnerRedemptionId ||
    pitch.redemptionId !== poll.winnerRedemptionId
  ) {
    throw new MissionError("invalid_mission_winner")
  }
  if (pitch.reviewStatus !== "approved" || pitch.lockedBy !== poll.lockId) {
    throw new MissionError("winner_not_available")
  }
  const mission = missionFromPitch(
    pitch,
    `poll:${poll.twitchPollId}`,
    poll.twitchPollId,
    now
  )
  const choice = poll.choices.find(
    (candidate) => candidate.redemptionId === pitch.redemptionId
  )
  if (!choice || choice.title !== mission.publicLabel) {
    throw new MissionError("mission_label_mismatch", 500)
  }
  return mission
}

// The owner skips the poll and makes an approved pitch the mission directly.
// `allowedLock` is the lock of a tied poll the pick is allowed to override.
export function createMissionFromPick(
  pitch: MissionPitch,
  now: number,
  allowedLock?: string
): MissionRecord {
  if (
    pitch.reviewStatus !== "approved" ||
    (pitch.lockedBy !== undefined && pitch.lockedBy !== allowedLock)
  ) {
    throw new MissionError("pitch_not_pickable")
  }
  return missionFromPitch(pitch, `pick:${now}`, "", now)
}

function missionFromPitch(
  pitch: MissionPitch,
  missionId: string,
  pollId: string,
  now: number
): MissionRecord {
  const publicLabel =
    typeof pitch.publicLabel === "string" ? pitch.publicLabel.trim() : ""
  const durationMinutes = pitch.durationMinutes
  if (
    typeof pitch.redemptionId !== "string" ||
    !publicLabel ||
    publicLabel.length > 25 ||
    !Number.isInteger(durationMinutes) ||
    (durationMinutes as number) < 1 ||
    (durationMinutes as number) > 120
  ) {
    throw new MissionError("invalid_mission_details", 500)
  }
  const viewerName = object(pitch.viewer)?.name
  const extraction = object(pitch.extraction)
  const failConsequence = extraction?.failConsequence
  const requestedClearRule = extraction?.consequenceClearRule
  const failConsequenceClearRule: ConsequenceClearRule =
    requestedClearRule === "timed" ||
    requestedClearRule === "at_next_stop" ||
    requestedClearRule === "through_next_mission" ||
    requestedClearRule === "manual"
      ? requestedClearRule
      : "through_next_mission"
  const requestedConsequenceDuration = extraction?.consequenceDurationMinutes
  const failConsequenceDurationMinutes =
    failConsequenceClearRule === "timed" &&
    Number.isInteger(requestedConsequenceDuration) &&
    (requestedConsequenceDuration as number) > 0
      ? (requestedConsequenceDuration as number)
      : 0
  // An anywhere mission has nowhere to travel, so its timer starts at once.
  const anywhere =
    object(pitch.extraction)?.anywhere === true || pitch.noTravel === true
  const place = anywhere
    ? {
        status: "arrived" as const,
        arrivedAt: now,
        timerEndsAt: now + (durationMinutes as number) * 60_000,
        destination: null,
        walkingRoute: null,
      }
    : {
        status: "heading" as const,
        destination: validDestination(pitch.destination),
        walkingRoute: validWalkingRoute(pitch.walkingRoute),
      }
  return {
    ...(typeof failConsequence === "string" && failConsequence.trim()
      ? {
          failConsequence: failConsequence.trim().slice(0, 80),
          failConsequenceClearRule:
            failConsequenceClearRule === "timed" &&
            !failConsequenceDurationMinutes
              ? "through_next_mission"
              : failConsequenceClearRule,
          failConsequenceDurationMinutes,
        }
      : {}),
    missionId,
    lockId: `mission:${missionId}`,
    pollId,
    redemptionId: pitch.redemptionId,
    ...(typeof viewerName === "string" && viewerName.trim()
      ? { viewerName: viewerName.trim().slice(0, 25) }
      : {}),
    ...(typeof pitch.rawText === "string" && pitch.rawText.trim()
      ? { request: pitch.rawText.trim().slice(0, 500) }
      : {}),
    publicLabel,
    durationMinutes: durationMinutes as number,
    ...place,
    activatedAt: now,
    updatedAt: now,
  }
}

export function parseMissionAction(value: unknown): MissionAction {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new MissionError("invalid_mission_action", 400)
  }
  const action = (value as Record<string, unknown>).action
  if (
    action !== "arrive" &&
    action !== "complete" &&
    action !== "fail" &&
    action !== "deny" &&
    action !== "extend" &&
    action !== "cancel"
  ) {
    throw new MissionError("invalid_mission_action", 400)
  }
  return action
}

export function transitionMission(
  record: MissionRecord,
  action: MissionAction,
  now: number
): MissionRecord {
  const current = record
  if (action === "cancel") {
    if (current.status === "canceled") return record
    if (current.status !== "heading") {
      throw new MissionError("mission_not_cancelable")
    }
    return {
      ...current,
      status: "canceled",
      outcomeAt: now,
      updatedAt: now,
    }
  }
  if (action === "arrive") {
    if (current.status === "arrived") return record
    if (current.status !== "heading") throw new MissionError("mission_finished")
    return {
      ...current,
      status: "arrived",
      arrivedAt: now,
      timerEndsAt: now + current.durationMinutes * 60_000,
      // The owner's tap reveals the place on the overlay, same as GPS arrival.
      destinationRevealedAt: current.destinationRevealedAt ?? now,
      updatedAt: now,
    }
  }
  if (action === "extend") {
    if (current.status === "heading") {
      return {
        ...current,
        durationMinutes: current.durationMinutes + EXTEND_MS / 60_000,
        updatedAt: now,
      }
    }
    if (current.status !== "arrived" || !current.timerEndsAt) {
      throw new MissionError("mission_finished")
    }
    // An elapsed timer restarts from now rather than from the past end time.
    return {
      ...current,
      timerEndsAt: Math.max(current.timerEndsAt, now) + EXTEND_MS,
      updatedAt: now,
    }
  }
  const target = action === "complete" ? "completed" : "failed"
  if (current.status === target) return record
  if (
    current.status === "completed" ||
    current.status === "failed" ||
    current.status === "canceled"
  ) {
    throw new MissionError("mission_finished")
  }
  if (current.status !== "arrived") {
    throw new MissionError("mission_not_arrived")
  }
  // Consequences live in their own collection; see shared/consequences.
  return {
    ...current,
    status: target,
    ...(action === "deny" ? { outcome: "denied" as const } : {}),
    outcomeAt: now,
    updatedAt: now,
  }
}

export function missionNavigation(
  destination: PlaceCandidate,
  mode: "walk" | "transit" | "drive" = "walk"
) {
  const coordinates = `${destination.latitude},${destination.longitude}`
  const googleMode =
    mode === "drive" ? "driving" : mode === "transit" ? "transit" : "walking"
  const appleMode = mode === "drive" ? "d" : mode === "transit" ? "r" : "w"
  return {
    googleMaps: `https://www.google.com/maps/dir/?${new URLSearchParams({
      api: "1",
      destination: coordinates,
      travelmode: googleMode,
    })}`,
    appleMaps: `https://maps.apple.com/?${new URLSearchParams({
      daddr: coordinates,
      dirflg: appleMode,
    })}`,
    waze: `https://www.waze.com/ul?${new URLSearchParams({
      ll: coordinates,
      navigate: "yes",
    })}`,
  }
}

export function toMissionOwnerView(record: MissionRecord): MissionOwnerView {
  // Legacy consequence fields are dropped rather than migrated.
  const current: MissionRecord & {
    activeConsequences?: unknown
    activeConsequence?: unknown
  } = { ...record }
  delete current.activeConsequences
  delete current.activeConsequence
  return {
    ...current,
    navigation: current.destination
      ? missionNavigation(current.destination, current.walkingRoute?.mode)
      : null,
  }
}
