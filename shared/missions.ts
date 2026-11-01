import type {
  ConsequenceClearRule,
  PlaceCandidate,
  WalkingRoute,
} from "@/shared/pitches/processor"
import type { PollRecord } from "@/shared/polls"

export type MissionStatus =
  "heading" | "arrived" | "completed" | "failed" | "canceled"

export type ActiveConsequence = {
  consequenceId: string
  text: string
  clearRule: ConsequenceClearRule
  sourceMissionId: string
  setBy: string
  activatedAt: number
  endsAt?: number
}

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
  /** Owed consequences can overlap until each one's rule clears it. */
  activeConsequences?: ActiveConsequence[]
  /** Legacy single-consequence shape, migrated when this session advances. */
  activeConsequence?: {
    text: string
    clearRule: "through_next_mission"
    sourceMissionId: string
  }
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

export function activeConsequences(record: MissionRecord, now: number) {
  const current = (record.activeConsequences ?? []).filter(
    (consequence) => !consequence.endsAt || consequence.endsAt > now
  )
  if (current.length || !record.activeConsequence?.text.trim()) return current
  return [
    {
      consequenceId: `legacy:${record.activeConsequence.sourceMissionId}`,
      text: record.activeConsequence.text.trim().slice(0, 80),
      clearRule: "through_next_mission" as const,
      sourceMissionId: record.activeConsequence.sourceMissionId,
      setBy: record.viewerName ?? "Chat",
      activatedAt: record.outcomeAt ?? record.updatedAt,
    },
  ]
}

// Carry every still-owed consequence onto the next mission. An anywhere
// mission is already at its first stop, so at-next-stop debts clear at once.
export function carryActiveConsequences(
  next: MissionRecord,
  previous: MissionRecord | null,
  now: number
): MissionRecord {
  if (!previous) return next
  const carried = activeConsequences(previous, now).filter(
    (consequence) =>
      next.status !== "arrived" || consequence.clearRule !== "at_next_stop"
  )
  return carried.length ? { ...next, activeConsequences: carried } : next
}

export function payManualConsequence(
  record: MissionRecord,
  consequenceId: string,
  now: number
) {
  const current = activeConsequences(record, now)
  const target = current.find(
    (consequence) => consequence.consequenceId === consequenceId
  )
  if (!target) throw new MissionError("consequence_not_found", 404)
  if (target.clearRule !== "manual") {
    throw new MissionError("consequence_not_manual")
  }
  const next = { ...record, updatedAt: now }
  delete next.activeConsequence
  const remaining = current.filter(
    (consequence) => consequence.consequenceId !== consequenceId
  )
  if (remaining.length) next.activeConsequences = remaining
  else delete next.activeConsequences
  return next
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

export type TransitionOptions = {
  /**
   * Clear every consequence still owed from earlier missions when this one
   * completes or fails, whatever its rule. Rules still apply until then.
   */
  capConsequences?: boolean
}

export function transitionMission(
  record: MissionRecord,
  action: MissionAction,
  now: number,
  options: TransitionOptions = {}
): MissionRecord {
  const current = { ...record }
  delete current.activeConsequence
  const owed = activeConsequences(record, now)
  if (owed.length) current.activeConsequences = owed
  else delete current.activeConsequences
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
    const afterArrival = owed.filter(
      (consequence) => consequence.clearRule !== "at_next_stop"
    )
    const next: MissionRecord = {
      ...current,
      status: "arrived",
      arrivedAt: now,
      timerEndsAt: now + current.durationMinutes * 60_000,
      // The owner's tap reveals the place on the overlay, same as GPS arrival.
      destinationRevealedAt: current.destinationRevealedAt ?? now,
      updatedAt: now,
    }
    if (afterArrival.length) next.activeConsequences = afterArrival
    else delete next.activeConsequences
    return next
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
  const remaining = options.capConsequences
    ? []
    : owed.filter(
        (consequence) => consequence.clearRule !== "through_next_mission"
      )
  const activated =
    action === "fail" && current.failConsequence
      ? ({
          consequenceId: `mission:${current.missionId}`,
          text: current.failConsequence,
          clearRule: current.failConsequenceClearRule ?? "through_next_mission",
          sourceMissionId: current.missionId,
          setBy: current.viewerName ?? "Chat",
          activatedAt: now,
          ...((current.failConsequenceClearRule ?? "through_next_mission") ===
            "timed" && (current.failConsequenceDurationMinutes ?? 0) > 0
            ? {
                endsAt: now + current.failConsequenceDurationMinutes! * 60_000,
              }
            : {}),
        } satisfies ActiveConsequence)
      : null
  const nextConsequences = [...remaining, ...(activated ? [activated] : [])]
  const withoutConsequences = { ...current }
  delete withoutConsequences.activeConsequences
  return {
    ...withoutConsequences,
    ...(nextConsequences.length
      ? { activeConsequences: nextConsequences }
      : {}),
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

export function toMissionOwnerView(
  record: MissionRecord,
  now = Date.now()
): MissionOwnerView {
  const current = { ...record }
  delete current.activeConsequence
  const owed = activeConsequences(record, now)
  if (owed.length) current.activeConsequences = owed
  else delete current.activeConsequences
  return {
    ...current,
    navigation: current.destination
      ? missionNavigation(current.destination, current.walkingRoute?.mode)
      : null,
  }
}
