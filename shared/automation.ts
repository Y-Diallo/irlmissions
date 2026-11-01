import { DEFAULT_POLL_DURATION_SECONDS } from "@/shared/polls"

export type AutomationPreset = "manual" | "assisted" | "full_auto"
export type ShortlistOrdering =
  "mixed" | "oldest" | "newest" | "fun" | "closest"

export type AutomationSettings = {
  preset: AutomationPreset
  autoApproval: boolean
  trustedViewersOnly: boolean
  vetoSeconds: number
  shortlistSize: number
  shortlistOrdering: ShortlistOrdering
  pollLossLimit: number
  autoStartPoll: boolean
  pollDurationSeconds: number
  postMissionDelaySeconds: number
  minimumEligiblePitches: number
  capConsequencesAtNextMissionEnd: boolean
}

export const DEFAULT_AUTOMATION_SETTINGS: AutomationSettings = {
  preset: "manual",
  autoApproval: false,
  trustedViewersOnly: false,
  vetoSeconds: 60,
  shortlistSize: 3,
  shortlistOrdering: "mixed",
  pollLossLimit: 3,
  autoStartPoll: false,
  pollDurationSeconds: DEFAULT_POLL_DURATION_SECONDS,
  postMissionDelaySeconds: 15,
  minimumEligiblePitches: 3,
  capConsequencesAtNextMissionEnd: false,
}

export function automationPreset(preset: AutomationPreset): AutomationSettings {
  const common = { ...DEFAULT_AUTOMATION_SETTINGS, preset }
  if (preset === "manual") return common
  if (preset === "assisted") return { ...common, autoApproval: true }
  return {
    ...common,
    autoApproval: true,
    autoStartPoll: true,
    capConsequencesAtNextMissionEnd: true,
  }
}

/** Anything to run on the console heartbeat. */
export function automationEnabled(settings: AutomationSettings) {
  return settings.autoApproval || settings.autoStartPoll
}

function integer(value: unknown, minimum: number, maximum: number) {
  return Number.isInteger(value) &&
    (value as number) >= minimum &&
    (value as number) <= maximum
    ? (value as number)
    : null
}

export function parseAutomationSettings(value: unknown): AutomationSettings {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return DEFAULT_AUTOMATION_SETTINGS
  }
  const input = value as Record<string, unknown>
  const preset =
    input.preset === "assisted" || input.preset === "full_auto"
      ? input.preset
      : "manual"
  const ordering = input.shortlistOrdering
  const shortlistOrdering: ShortlistOrdering =
    ordering === "oldest" ||
    ordering === "newest" ||
    ordering === "fun" ||
    ordering === "closest"
      ? ordering
      : "mixed"
  return {
    preset,
    autoApproval: input.autoApproval === true,
    trustedViewersOnly: input.trustedViewersOnly === true,
    vetoSeconds: integer(input.vetoSeconds, 0, 600) ?? 60,
    shortlistSize: integer(input.shortlistSize, 2, 5) ?? 3,
    shortlistOrdering,
    pollLossLimit: integer(input.pollLossLimit, 1, 20) ?? 3,
    autoStartPoll: input.autoStartPoll === true,
    pollDurationSeconds:
      integer(input.pollDurationSeconds, 15, 1800) ??
      DEFAULT_POLL_DURATION_SECONDS,
    postMissionDelaySeconds:
      integer(input.postMissionDelaySeconds, 0, 300) ?? 15,
    minimumEligiblePitches: integer(input.minimumEligiblePitches, 2, 5) ?? 3,
    capConsequencesAtNextMissionEnd:
      input.capConsequencesAtNextMissionEnd === true,
  }
}

export type AutoApprovalPitch = {
  reviewStatus: string
  riskFlags: unknown[]
  processingWarnings: unknown[]
  /** No place to be open or closed. */
  anywhere: boolean
  destination: { openNow?: boolean; businessStatus?: string } | null
  /** null until the viewer's roles have been looked up. */
  viewerTrusted: boolean | null
}

/** Open as far as Google knows: places with no hours (parks) count as open. */
export function placeOpen(
  destination: { openNow?: boolean; businessStatus?: string } | null
) {
  return (
    !!destination &&
    destination.openNow !== false &&
    destination.businessStatus !== "closed_temporarily" &&
    destination.businessStatus !== "closed_permanently"
  )
}

export function canAutoApprove(
  pitch: AutoApprovalPitch,
  settings: AutomationSettings,
  paused: boolean
) {
  if (paused || !settings.autoApproval) return false
  // This is intentionally absolute: no preset or trust status can bypass a flag.
  if (pitch.riskFlags.length > 0) return false
  if (pitch.processingWarnings.length > 0) return false
  if (pitch.reviewStatus !== "pending_review") return false
  if (!pitch.anywhere && !placeOpen(pitch.destination)) return false
  return !settings.trustedViewersOnly || pitch.viewerTrusted === true
}

export type ShortlistPitch = {
  redemptionId: string
  publicLabel: string
  createdAt: number
  funScore: number
  distanceMeters: number
  vetoUntil?: number
}

/** An auto-approved pitch can't go in a poll until its veto window passes. */
export function eligibleAfterVeto(
  pitch: { vetoUntil?: number | null },
  now: number
) {
  return (
    pitch.vetoUntil === undefined ||
    pitch.vetoUntil === null ||
    pitch.vetoUntil <= now
  )
}

// Twitch rejects duplicate choice titles, so only the first of each label
// makes the shortlist.
function unique(pitches: ShortlistPitch[], size: number) {
  const ids = new Set<string>()
  const labels = new Set<string>()
  return pitches.filter((pitch) => {
    const label = pitch.publicLabel.toLocaleLowerCase()
    if (ids.has(pitch.redemptionId) || labels.has(label) || ids.size >= size) {
      return false
    }
    ids.add(pitch.redemptionId)
    labels.add(label)
    return true
  })
}

export function selectShortlist(
  pitches: ShortlistPitch[],
  settings: AutomationSettings,
  now: number
) {
  const available = pitches.filter((pitch) => eligibleAfterVeto(pitch, now))
  const oldest = [...available].sort((a, b) => a.createdAt - b.createdAt)
  const newest = [...oldest].reverse()
  const fun = [...available].sort(
    (a, b) => b.funScore - a.funScore || a.createdAt - b.createdAt
  )
  const closest = [...available].sort(
    (a, b) => a.distanceMeters - b.distanceMeters || a.createdAt - b.createdAt
  )
  const ordered =
    settings.shortlistOrdering === "oldest"
      ? oldest
      : settings.shortlistOrdering === "newest"
        ? newest
        : settings.shortlistOrdering === "fun"
          ? fun
          : settings.shortlistOrdering === "closest"
            ? closest
            : [oldest[0], newest[0], ...fun].filter(
                (pitch): pitch is ShortlistPitch => !!pitch
              )
  return unique(ordered, settings.shortlistSize)
}

export function automationThresholdMet(
  eligibleCount: number,
  settings: AutomationSettings
) {
  return (
    settings.autoStartPoll &&
    eligibleCount >= Math.max(2, settings.minimumEligiblePitches)
  )
}

/**
 * When the next automatic poll may start: after the last mission outcome or
 * poll ending plus the delay, so the stamp can land on the overlay.
 */
export function nextPollAt(
  lastOutcomeAt: number | null,
  settings: AutomationSettings
) {
  return lastOutcomeAt === null
    ? 0
    : lastOutcomeAt + settings.postMissionDelaySeconds * 1000
}

/** A losing pitch drops out (and is refunded) once it hits the limit. */
export function dropsAfterLoss(
  previousLosses: number,
  settings: AutomationSettings
) {
  return settings.autoStartPoll && previousLosses + 1 >= settings.pollLossLimit
}

export type AutomationStatus =
  | { state: "off" }
  | { state: "paused" }
  | { state: "busy" }
  | { state: "cooldown"; startsAt: number }
  | { state: "waiting"; eligible: number; needed: number }
  | { state: "started"; pollAttemptId: string }
  | { state: "error"; code: string }
