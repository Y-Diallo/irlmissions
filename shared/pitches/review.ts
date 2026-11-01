import type {
  DuplicateSuggestion,
  ConsequenceClearRule,
  PitchExtraction,
  PlaceCandidate,
  ProcessingWarning,
  RiskFlag,
  WalkingRoute,
} from "@/shared/pitches/processor"
import {
  MAX_CONSEQUENCE_DURATION_MINUTES,
  MAX_FAIL_CONSEQUENCE_LENGTH,
} from "@/shared/pitches/processor"
import { MAX_POLL_CHOICE_LENGTH, withoutDashes } from "@/shared/polls"
import type { RedemptionResolution } from "@/shared/redemptions"

export type ReviewStatus =
  | "processing"
  | "pending_review"
  | "approved"
  | "rejected"
  | "active_mission"
  | "completed"
  | "failed"

export type ReviewRecord = {
  redemptionId: string
  rawText: string
  viewer?: { name?: string; login?: string }
  reviewStatus: ReviewStatus
  createdAt: number
  updatedAt: number
  processing?: {
    status?: "pending" | "processing" | "error" | "complete"
    attempts?: number
    errorCode?: string
    automaticRetryAt?: number | null
  }
  extraction?: PitchExtraction
  destination?: PlaceCandidate | null
  walkingRoute?: WalkingRoute | null
  duplicateSuggestions?: DuplicateSuggestion[]
  straightLineMeters?: number | null
  processingWarnings?: ProcessingWarning[]
  publicLabel?: string
  durationMinutes?: number
  rejectionReason?: string
  approvedAt?: number
  /** Removed from the producer queue without deleting refund/audit state. */
  hiddenAt?: number
  removedFromStatus?: ReviewStatus
  lockedBy?: string
  /** Owner-forced anywhere mission, kept across reprocessing. */
  noTravel?: boolean
  redemptionStatus?: "unfulfilled" | "fulfilled" | "canceled"
  redemptionResolution?: RedemptionResolution
}

export type PitchReviewItem = {
  redemptionId: string
  rawText: string
  viewerName: string
  reviewStatus: ReviewStatus
  createdAt: number
  updatedAt: number
  processing: {
    status: string
    attempts: number
    errorCode?: string
    automaticRetryAt?: number | null
  } | null
  challenge: string | null
  publicLabel: string
  durationMinutes: number
  riskFlags: RiskFlag[]
  failConsequence: string | null
  consequenceClearRule: ConsequenceClearRule
  consequenceDurationMinutes: number
  /** No place: the mission is done wherever the streamer is. */
  anywhere: boolean
  /** The owner forced no travel (vs. the AI deciding it). */
  noTravel: boolean
  destination: PlaceCandidate | null
  walkingRoute: WalkingRoute | null
  duplicateSuggestions: DuplicateSuggestion[]
  processingWarnings: ProcessingWarning[]
  rejectionReason: string | null
  locked: boolean
  /** Rejected, but its refund hasn't started, so it can still be edited. */
  revivable: boolean
  redemptionResolution: RedemptionResolution | null
}

export type PitchHistoryItem = {
  redemptionId: string
  viewerName: string
  rawText: string
  objective: string
  removedAt: number
  previousStatus: ReviewStatus
  redemptionResolution: RedemptionResolution | null
}

export type ReviewCommand =
  | { action: "edit_raw"; rawText: string }
  | {
      action: "edit_details"
      publicLabel: string
      durationMinutes: number
      failConsequence: string
      consequenceClearRule: ConsequenceClearRule
      consequenceDurationMinutes: number
    }
  | { action: "set_no_travel"; noTravel: boolean }
  | { action: "approve" }
  | { action: "reject" }
  | { action: "remove" }
  | { action: "retry" | "retry_resolution" }

export type ReviewUpdate = {
  values: Record<string, unknown>
  deleteFields: string[]
}

export class PitchReviewError extends Error {
  constructor(
    public readonly code: string,
    public readonly status = 409
  ) {
    super(code)
  }
}

function cleanText(value: unknown, field: string, max: number) {
  if (typeof value !== "string")
    throw new PitchReviewError(`invalid_${field}`, 400)
  const text = value.trim()
  if (!text || text.length > max) {
    throw new PitchReviewError(`invalid_${field}`, 400)
  }
  return text
}

function cleanOptionalText(value: unknown, field: string, max: number) {
  if (typeof value !== "string") {
    throw new PitchReviewError(`invalid_${field}`, 400)
  }
  const text = withoutDashes(value).replace(/\s+/g, " ").trim()
  if (text.length > max) {
    throw new PitchReviewError(`invalid_${field}`, 400)
  }
  return text
}

export function parseReviewCommand(value: unknown): ReviewCommand {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new PitchReviewError("invalid_command", 400)
  }
  const input = value as Record<string, unknown>
  switch (input.action) {
    case "edit_raw":
      return {
        action: "edit_raw",
        rawText: cleanText(input.rawText, "raw_text", 5000),
      }
    case "edit_details": {
      const durationMinutes = input.durationMinutes
      const failConsequence = cleanOptionalText(
        input.failConsequence,
        "fail_consequence",
        MAX_FAIL_CONSEQUENCE_LENGTH
      )
      const consequenceClearRule = input.consequenceClearRule
      if (
        consequenceClearRule !== "timed" &&
        consequenceClearRule !== "at_next_stop" &&
        consequenceClearRule !== "through_next_mission" &&
        consequenceClearRule !== "manual"
      ) {
        throw new PitchReviewError("invalid_consequence_rule", 400)
      }
      const consequenceDurationMinutes = input.consequenceDurationMinutes
      if (
        !Number.isInteger(durationMinutes) ||
        (durationMinutes as number) < 1 ||
        (durationMinutes as number) > 120 ||
        !Number.isInteger(consequenceDurationMinutes) ||
        (consequenceDurationMinutes as number) < 0 ||
        (consequenceDurationMinutes as number) >
          MAX_CONSEQUENCE_DURATION_MINUTES ||
        (failConsequence &&
          consequenceClearRule === "timed" &&
          (consequenceDurationMinutes as number) < 1)
      ) {
        throw new PitchReviewError("invalid_duration", 400)
      }
      return {
        action: "edit_details",
        publicLabel: cleanText(
          typeof input.publicLabel === "string"
            ? withoutDashes(input.publicLabel)
            : input.publicLabel,
          "public_label",
          MAX_POLL_CHOICE_LENGTH
        ),
        durationMinutes: durationMinutes as number,
        failConsequence,
        consequenceClearRule: failConsequence
          ? consequenceClearRule
          : "through_next_mission",
        consequenceDurationMinutes:
          failConsequence && consequenceClearRule === "timed"
            ? (consequenceDurationMinutes as number)
            : 0,
      }
    }
    case "set_no_travel":
      if (typeof input.noTravel !== "boolean") {
        throw new PitchReviewError("invalid_command", 400)
      }
      return { action: "set_no_travel", noTravel: input.noTravel }
    case "approve":
    case "reject":
    case "remove":
    case "retry":
    case "retry_resolution":
      return { action: input.action }
    default:
      throw new PitchReviewError("invalid_command", 400)
  }
}

export function toPitchReviewItem(record: ReviewRecord): PitchReviewItem {
  return {
    redemptionId: record.redemptionId,
    rawText: record.rawText,
    viewerName: record.viewer?.name || record.viewer?.login || "Viewer",
    reviewStatus: record.reviewStatus,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
    processing: record.processing
      ? {
          status: record.processing.status ?? "unknown",
          attempts: record.processing.attempts ?? 0,
          ...(record.processing.errorCode
            ? { errorCode: record.processing.errorCode }
            : {}),
          ...(record.processing.automaticRetryAt === undefined
            ? {}
            : { automaticRetryAt: record.processing.automaticRetryAt }),
        }
      : null,
    challenge: record.extraction?.challenge ?? null,
    publicLabel:
      record.publicLabel ?? record.extraction?.publicLabelSuggestion ?? "",
    durationMinutes:
      record.durationMinutes ?? record.extraction?.durationMinutes ?? 10,
    riskFlags: record.extraction?.riskFlags ?? [],
    failConsequence: record.extraction?.failConsequence || null,
    consequenceClearRule:
      record.extraction?.consequenceClearRule ?? "through_next_mission",
    consequenceDurationMinutes:
      record.extraction?.consequenceDurationMinutes ?? 0,
    anywhere: isAnywhere(record),
    noTravel: record.noTravel === true,
    destination: record.destination ?? null,
    walkingRoute: record.walkingRoute ?? null,
    duplicateSuggestions: record.duplicateSuggestions ?? [],
    processingWarnings: record.processingWarnings ?? [],
    rejectionReason: record.rejectionReason ?? null,
    locked: !!record.lockedBy,
    revivable: isRevivable(record),
    redemptionResolution: record.redemptionResolution ?? null,
  }
}

export function toPitchHistoryItem(record: ReviewRecord): PitchHistoryItem {
  if (typeof record.hiddenAt !== "number") {
    throw new PitchReviewError("pitch_not_removed", 500)
  }
  return {
    redemptionId: record.redemptionId,
    viewerName: record.viewer?.name || record.viewer?.login || "Viewer",
    rawText: record.rawText,
    objective:
      record.publicLabel ??
      record.extraction?.challenge ??
      record.rawText.slice(0, 80),
    removedAt: record.hiddenAt,
    previousStatus: record.removedFromStatus ?? record.reviewStatus,
    redemptionResolution: record.redemptionResolution ?? null,
  }
}

function editable(record: ReviewRecord) {
  if (record.lockedBy) throw new PitchReviewError("pitch_locked")
}

function reviewable(record: ReviewRecord) {
  editable(record)
  if (!record.extraction) throw new PitchReviewError("pitch_not_ready")
  if (isAnywhere(record)) return
  if (!record.destination) throw new PitchReviewError("pitch_not_ready")
  if (!record.walkingRoute) throw new PitchReviewError("route_not_ready")
}

// Chain names are allowed (they don't pinpoint a location); the owner decides
// whether a business name is too specific. Only the street address is blocked.
function revealsDestination(label: string, destination: PlaceCandidate) {
  const normalized = label.toLocaleLowerCase()
  const address = destination.address.trim().toLocaleLowerCase()
  const street = address.split(",")[0]!.trim()
  return (
    (address.length >= 5 && normalized.includes(address)) ||
    (street.length >= 5 && normalized.includes(street))
  )
}

// A rejected pitch can be edited and reprocessed only while its refund has
// never been attempted; once Twitch may have returned the points, the
// redemption can no longer be fulfilled.
export function isRevivable(record: ReviewRecord) {
  const resolution = record.redemptionResolution
  return (
    record.reviewStatus === "rejected" &&
    record.redemptionStatus !== "canceled" &&
    record.redemptionStatus !== "fulfilled" &&
    (!resolution ||
      (resolution.action === "refund" &&
        resolution.status === "pending" &&
        resolution.attempts === 0))
  )
}

function reprocess(
  record: ReviewRecord,
  values: Record<string, unknown>,
  now: number
): ReviewUpdate {
  const revive = isRevivable(record)
  if (
    !revive &&
    !["pending_review", "approved"].includes(record.reviewStatus)
  ) {
    throw new PitchReviewError("pitch_not_editable")
  }
  return {
    values: {
      ...values,
      reviewStatus: "processing",
      processing: { status: "pending", attempts: 0, nextAttemptAt: now },
      updatedAt: now,
    },
    deleteFields: [
      ...(revive ? ["redemptionResolution"] : []),
      "approvedAt",
      "rejectionReason",
      "extraction",
      "destination",
      "walkingRoute",
      "duplicateSuggestions",
      "straightLineMeters",
      "processingWarnings",
      "publicLabel",
      "durationMinutes",
    ],
  }
}

/** The pitch runs with no destination: AI-detected or owner-forced. */
export function isAnywhere(record: {
  extraction?: { anywhere?: boolean } | null
  noTravel?: boolean
}) {
  return record.extraction?.anywhere === true || record.noTravel === true
}

export function transitionPitchReview(
  record: ReviewRecord,
  command: ReviewCommand,
  now: number
): ReviewUpdate {
  editable(record)
  if (command.action === "remove") {
    const attempted = ["active_mission", "completed", "failed"].includes(
      record.reviewStatus
    )
    const settled =
      record.redemptionStatus === "canceled" ||
      record.redemptionStatus === "fulfilled" ||
      record.redemptionResolution?.status === "complete"
    const existingRefund =
      record.redemptionResolution?.action === "refund"
        ? record.redemptionResolution
        : null
    return {
      values: {
        hiddenAt: now,
        removedFromStatus: record.reviewStatus,
        updatedAt: now,
        ...(!attempted && !settled
          ? {
              reviewStatus: "rejected",
              rejectionReason: "owner_removed",
              processing: {
                status: "complete",
                attempts: record.processing?.attempts ?? 0,
                completedAt: now,
              },
              redemptionResolution:
                existingRefund ??
                ({
                  action: "refund",
                  status: "pending",
                  attempts: 0,
                  nextAttemptAt: now,
                } satisfies RedemptionResolution),
            }
          : {}),
      },
      deleteFields: ["approvedAt"],
    }
  }
  if (command.action === "edit_raw") {
    return reprocess(record, { rawText: command.rawText }, now)
  }
  if (command.action === "set_no_travel") {
    // Forcing no travel on a pitch rejected for having no place revives it.
    if (command.noTravel && isRevivable(record)) {
      return reprocess(record, { noTravel: true }, now)
    }
    if (!["pending_review", "approved"].includes(record.reviewStatus)) {
      throw new PitchReviewError("pitch_not_editable")
    }
    // Turning it off needs a place the pitch never searched for.
    if (!command.noTravel && !record.destination) {
      throw new PitchReviewError("no_destination_found")
    }
    return {
      values: { noTravel: command.noTravel, updatedAt: now },
      deleteFields: [],
    }
  }
  if (command.action === "edit_details") {
    reviewable(record)
    if (!["pending_review", "approved"].includes(record.reviewStatus)) {
      throw new PitchReviewError("pitch_not_editable")
    }
    return {
      values: {
        publicLabel: command.publicLabel,
        durationMinutes: command.durationMinutes,
        extraction: {
          ...record.extraction!,
          failConsequence: command.failConsequence,
          consequenceClearRule: command.consequenceClearRule,
          consequenceDurationMinutes: command.consequenceDurationMinutes,
        },
        reviewStatus: "pending_review",
        updatedAt: now,
      },
      deleteFields: ["approvedAt"],
    }
  }
  if (command.action === "approve") {
    reviewable(record)
    if (record.reviewStatus !== "pending_review") {
      throw new PitchReviewError("pitch_not_approvable")
    }
    const publicLabel = cleanText(
      record.publicLabel ?? record.extraction?.publicLabelSuggestion,
      "public_label",
      MAX_POLL_CHOICE_LENGTH
    )
    if (
      record.destination &&
      revealsDestination(publicLabel, record.destination)
    ) {
      throw new PitchReviewError("public_label_reveals_destination", 400)
    }
    const durationMinutes =
      record.durationMinutes ?? record.extraction?.durationMinutes
    if (
      !Number.isInteger(durationMinutes) ||
      durationMinutes! < 1 ||
      durationMinutes! > 120
    ) {
      throw new PitchReviewError("invalid_duration", 400)
    }
    return {
      values: {
        publicLabel,
        durationMinutes,
        reviewStatus: "approved",
        approvedAt: now,
        updatedAt: now,
      },
      deleteFields: ["rejectionReason"],
    }
  }
  if (command.action === "reject") {
    if (!["pending_review", "approved"].includes(record.reviewStatus)) {
      throw new PitchReviewError("pitch_not_rejectable")
    }
    return {
      values: {
        reviewStatus: "rejected",
        rejectionReason: "owner",
        redemptionResolution: {
          action: "refund",
          status: "pending",
          attempts: 0,
          nextAttemptAt: now,
        },
        updatedAt: now,
      },
      deleteFields: ["approvedAt"],
    }
  }
  if (command.action === "retry_resolution") {
    const current = record.redemptionResolution
    if (!current || current.status !== "error") {
      throw new PitchReviewError("redemption_not_retryable")
    }
    return {
      values: {
        redemptionResolution: {
          action: current.action,
          status: "pending",
          attempts: 0,
          nextAttemptAt: now,
        },
        updatedAt: now,
      },
      deleteFields: [],
    }
  }
  if (
    record.reviewStatus !== "processing" ||
    record.processing?.status !== "error"
  ) {
    throw new PitchReviewError("pitch_not_retryable")
  }
  return {
    values: {
      processing: { status: "pending", attempts: 0, nextAttemptAt: now },
      updatedAt: now,
    },
    deleteFields: [],
  }
}
