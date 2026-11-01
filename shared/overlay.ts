import type { MissionRecord } from "@/shared/missions"
import { withoutDashes, type PollRecord } from "@/shared/polls"

type RevealedPlace = {
  placeName?: string
  hasPlacePhoto?: true
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
  | {
      state: "heading"
      updatedAt: number
      objective: string
      /** Display name of the viewer who pitched it; "Chat" when unknown. */
      chosenBy: string
    }
  | ({
      state: "arrived"
      updatedAt: number
      objective: string
      timerEndsAt: number
    } & RevealedPlace)
  | ({
      state: "completed" | "failed"
      updatedAt: number
      objective: string
      /** Only on a failed mission whose viewer named a penalty. */
      consequence?: string
    } & RevealedPlace)

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
  if (!mission.destinationRevealedAt) return {}
  return {
    placeName: mission.destination.name,
    hasPlacePhoto: true,
  }
}

export function missionOverlay(mission: MissionRecord): OverlayProjection {
  if (mission.status === "heading") {
    return {
      state: "heading",
      updatedAt: mission.updatedAt,
      objective: mission.publicLabel,
      chosenBy: mission.viewerName ?? "Chat",
    }
  }
  if (mission.status === "arrived") {
    if (!mission.timerEndsAt) throw new OverlayError("mission_timer_missing")
    return {
      state: "arrived",
      updatedAt: mission.updatedAt,
      objective: mission.publicLabel,
      timerEndsAt: mission.timerEndsAt,
      ...revealedPlace(mission),
    }
  }
  return {
    state: mission.status,
    updatedAt: mission.updatedAt,
    objective: mission.publicLabel,
    ...(mission.status === "failed" && mission.failConsequence
      ? { consequence: mission.failConsequence }
      : {}),
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
export function toOverlayView(value: unknown): OverlayProjection {
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
  const place: RevealedPlace =
    input.placeName === undefined
      ? {}
      : {
          placeName: text(input.placeName, 120),
          ...(input.hasPlacePhoto === true ? { hasPlacePhoto: true } : {}),
        }
  if (input.state === "arrived") {
    return {
      state: "arrived",
      updatedAt,
      objective,
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
    }
  }
  return {
    state: input.state,
    updatedAt,
    objective,
    ...(input.state === "failed" && input.consequence !== undefined
      ? { consequence: text(input.consequence, 80) }
      : {}),
    ...place,
  }
}
