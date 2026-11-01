import { activeConsequences, type MissionRecord } from "@/shared/missions"
import type { ConsequenceClearRule } from "@/shared/pitches/processor"
import { withoutDashes, type PollRecord } from "@/shared/polls"

type RevealedPlace = {
  placeName?: string
  hasPlacePhoto?: true
  /** Stable across timer extensions and other updates to the same mission. */
  photoVersion?: number
}

type ConsequenceView = {
  consequences?: Array<{
    consequenceId: string
    text: string
    setBy: string
    clearRule: ConsequenceClearRule
    endsAt?: number
  }>
}

export type OverlayProjection =
  | { state: "idle"; updatedAt: number }
  | {
      state: "voting"
      updatedAt: number
      title: string
      choices: Array<{ position: number; title: string; votes: number }>
      ended?: true
      tie?: true
    }
  | ({
      state: "heading"
      updatedAt: number
      objective: string
      /** Display name of the viewer who pitched it; "Chat" when unknown. */
      chosenBy: string
    } & ConsequenceView)
  | ({
      state: "arrived"
      updatedAt: number
      objective: string
      timerEndsAt: number
    } & RevealedPlace &
      ConsequenceView)
  | ({
      state: "completed" | "failed"
      updatedAt: number
      objective: string
    } & RevealedPlace &
      ConsequenceView)

export class OverlayError extends Error {
  constructor(
    public readonly code: string,
    public readonly status = 503
  ) {
    super(code)
  }
}

export function idleOverlay(updatedAt: number): OverlayProjection {
  return { state: "idle", updatedAt }
}

export function votingOverlay(poll: PollRecord): OverlayProjection {
  if (poll.status !== "active" && poll.status !== "tie") {
    throw new OverlayError("poll_not_public")
  }
  return {
    state: "voting",
    updatedAt: poll.updatedAt,
    title: poll.title,
    choices: poll.choices.map((choice, index) => ({
      position: index + 1,
      title: choice.title,
      votes: choice.votes ?? 0,
    })),
    ...(poll.status === "tie" ? { ended: true, tie: true } : {}),
  }
}

// Apply a Twitch progress/end tally to the live voting card. Returns null when
// the card is no longer showing this poll's choices.
export function tallyOverlay(
  current: unknown,
  tally: { choices: Array<{ title: string; votes: number }>; ended: boolean },
  now: number
): OverlayProjection | null {
  let view: OverlayProjection
  try {
    view = toOverlayView(current)
  } catch {
    return null
  }
  if (
    view.state !== "voting" ||
    view.ended ||
    view.choices.length !== tally.choices.length ||
    view.choices.some(
      (choice, index) =>
        choice.title !== withoutDashes(tally.choices[index]!.title)
    )
  ) {
    return null
  }
  return {
    ...view,
    updatedAt: now,
    // Progress events can arrive out of order; vote totals never decrease.
    choices: view.choices.map((choice, index) => ({
      ...choice,
      votes: tally.ended
        ? tally.choices[index]!.votes
        : Math.max(choice.votes, tally.choices[index]!.votes),
    })),
    ...(tally.ended ? { ended: true } : {}),
  }
}

function revealedPlace(mission: MissionRecord): RevealedPlace {
  if (!mission.destinationRevealedAt || !mission.destination) return {}
  return {
    placeName: mission.destination.name,
    hasPlacePhoto: true,
    photoVersion: mission.destinationRevealedAt,
  }
}

function consequenceView(mission: MissionRecord, now: number): ConsequenceView {
  const consequences = activeConsequences(mission, now).map((consequence) => ({
    consequenceId: consequence.consequenceId,
    text: consequence.text,
    setBy: consequence.setBy,
    clearRule: consequence.clearRule,
    ...(consequence.endsAt ? { endsAt: consequence.endsAt } : {}),
  }))
  return consequences.length ? { consequences } : {}
}

export function missionOverlay(
  mission: MissionRecord,
  now = mission.updatedAt
): OverlayProjection {
  if (mission.status === "canceled") {
    return idleOverlay(mission.updatedAt)
  }
  if (mission.status === "heading") {
    return {
      state: "heading",
      updatedAt: mission.updatedAt,
      objective: mission.publicLabel,
      chosenBy: mission.viewerName ?? "Chat",
      ...consequenceView(mission, now),
    }
  }
  if (mission.status === "arrived") {
    if (!mission.timerEndsAt) throw new OverlayError("mission_timer_missing")
    return {
      state: "arrived",
      updatedAt: mission.updatedAt,
      objective: mission.publicLabel,
      timerEndsAt: mission.timerEndsAt,
      ...consequenceView(mission, now),
      ...revealedPlace(mission),
    }
  }
  return {
    state: mission.status,
    updatedAt: mission.updatedAt,
    objective: mission.publicLabel,
    ...consequenceView(mission, now),
    ...revealedPlace(mission),
  }
}

function object(value: unknown) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new OverlayError("invalid_overlay_projection")
  }
  return value as Record<string, unknown>
}

function timestamp(value: unknown) {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
    throw new OverlayError("invalid_overlay_projection")
  }
  return value
}

function text(value: unknown, maximum: number) {
  if (typeof value !== "string") {
    throw new OverlayError("invalid_overlay_projection")
  }
  const result = withoutDashes(value)
  if (!result || result.length > maximum) {
    throw new OverlayError("invalid_overlay_projection")
  }
  return result
}

// Rebuild an allowlisted response instead of returning Firestore data directly.
export function toOverlayView(
  value: unknown,
  now = Date.now()
): OverlayProjection {
  const input = object(value)
  const updatedAt = timestamp(input.updatedAt)
  if (input.state === "idle") return { state: "idle", updatedAt }
  if (input.state === "voting") {
    if (
      !Array.isArray(input.choices) ||
      input.choices.length < 2 ||
      input.choices.length > 5
    ) {
      throw new OverlayError("invalid_overlay_projection")
    }
    return {
      state: "voting",
      updatedAt,
      title: text(input.title, 60),
      choices: input.choices.map((value, index) => {
        const choice = object(value)
        if (choice.position !== index + 1) {
          throw new OverlayError("invalid_overlay_projection")
        }
        const votes = choice.votes ?? 0
        if (!Number.isSafeInteger(votes) || (votes as number) < 0) {
          throw new OverlayError("invalid_overlay_projection")
        }
        return {
          position: index + 1,
          title: text(choice.title, 25),
          votes: votes as number,
        }
      }),
      ...(input.ended === true ? { ended: true as const } : {}),
      ...(input.tie === true ? { tie: true as const } : {}),
    }
  }
  if (
    input.state !== "heading" &&
    input.state !== "arrived" &&
    input.state !== "completed" &&
    input.state !== "failed"
  ) {
    throw new OverlayError("invalid_overlay_projection")
  }
  const objective = text(input.objective, 25)
  let consequence: ConsequenceView = {}
  if (input.consequences !== undefined) {
    if (!Array.isArray(input.consequences) || input.consequences.length > 20) {
      throw new OverlayError("invalid_overlay_projection")
    }
    const consequences = input.consequences
      .map((value) => {
        const item = object(value)
        const clearRule = item.clearRule
        if (
          clearRule !== "timed" &&
          clearRule !== "at_next_stop" &&
          clearRule !== "through_next_mission" &&
          clearRule !== "manual"
        ) {
          throw new OverlayError("invalid_overlay_projection")
        }
        const typedClearRule = clearRule as ConsequenceClearRule
        const endsAt =
          item.endsAt === undefined ? undefined : timestamp(item.endsAt)
        if (clearRule === "timed" && endsAt === undefined) {
          throw new OverlayError("invalid_overlay_projection")
        }
        return {
          consequenceId: text(item.consequenceId, 512),
          text: text(item.text, 80),
          setBy: text(item.setBy, 25),
          clearRule: typedClearRule,
          ...(endsAt === undefined ? {} : { endsAt }),
        }
      })
      .filter((item) => !item.endsAt || item.endsAt > now)
    if (consequences.length) consequence = { consequences }
  } else if (input.consequence !== undefined) {
    // Read legacy projections until the next mission write replaces them.
    consequence = {
      consequences: [
        {
          consequenceId: `legacy:${updatedAt}`,
          text: text(input.consequence, 80),
          setBy: "Chat",
          clearRule: "through_next_mission",
        },
      ],
    }
  }
  const place: RevealedPlace =
    input.placeName === undefined
      ? {}
      : {
          placeName: text(input.placeName, 120),
          ...(input.hasPlacePhoto === true
            ? {
                hasPlacePhoto: true as const,
                // Older stored projections predate photoVersion. They can use
                // updatedAt once; the next mission write publishes the stable
                // destination-reveal timestamp.
                photoVersion:
                  input.photoVersion === undefined
                    ? updatedAt
                    : timestamp(input.photoVersion),
              }
            : {}),
        }
  if (input.state === "arrived") {
    return {
      state: "arrived",
      updatedAt,
      objective,
      ...consequence,
      ...place,
      timerEndsAt: timestamp(input.timerEndsAt),
    }
  }
  if (input.state === "heading") {
    return {
      state: "heading",
      updatedAt,
      objective,
      chosenBy:
        input.chosenBy === undefined ? "Chat" : text(input.chosenBy, 25),
      ...consequence,
    }
  }
  return {
    state: input.state,
    updatedAt,
    objective,
    ...consequence,
    ...place,
  }
}
