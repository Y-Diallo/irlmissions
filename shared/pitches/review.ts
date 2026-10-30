import type {
  DuplicateSuggestion,
  PitchExtraction,
  PlaceCandidate,
  RiskFlag,
  WalkingRoute,
} from "@/shared/pitches/processor"

export type ReviewStatus =
  "processing" | "pending_review" | "approved" | "rejected"

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
  destination?: PlaceCandidate
  walkingRoute?: WalkingRoute
  duplicateSuggestions?: DuplicateSuggestion[]
  straightLineMeters?: number
  publicLabel?: string
  durationMinutes?: number
  rejectionReason?: string
  approvedAt?: number
  lockedBy?: string
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
  destination: PlaceCandidate | null
  walkingRoute: WalkingRoute | null
  duplicateSuggestions: DuplicateSuggestion[]
  rejectionReason: string | null
  locked: boolean
}

export type ReviewCommand =
  | { action: "edit_raw"; rawText: string }
  | { action: "edit_details"; publicLabel: string; durationMinutes: number }
  | { action: "approve" }
  | { action: "reject" }
  | { action: "retry" }

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
      if (
        !Number.isInteger(durationMinutes) ||
        (durationMinutes as number) < 1 ||
        (durationMinutes as number) > 120
      ) {
        throw new PitchReviewError("invalid_duration", 400)
      }
      return {
        action: "edit_details",
        publicLabel: cleanText(input.publicLabel, "public_label", 80),
        durationMinutes: durationMinutes as number,
      }
    }
    case "approve":
    case "reject":
    case "retry":
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
    destination: record.destination ?? null,
    walkingRoute: record.walkingRoute ?? null,
    duplicateSuggestions: record.duplicateSuggestions ?? [],
    rejectionReason: record.rejectionReason ?? null,
    locked: !!record.lockedBy,
  }
}

function editable(record: ReviewRecord) {
  if (record.lockedBy) throw new PitchReviewError("pitch_locked")
}

function reviewable(record: ReviewRecord) {
  editable(record)
  if (!record.extraction || !record.destination) {
    throw new PitchReviewError("pitch_not_ready")
  }
  if (!record.walkingRoute) throw new PitchReviewError("route_not_ready")
}

function revealsDestination(label: string, destination: PlaceCandidate) {
  const normalized = label.toLocaleLowerCase()
  const name = destination.name.trim().toLocaleLowerCase()
  const address = destination.address.trim().toLocaleLowerCase()
  return (
    (name.length >= 3 && normalized.includes(name)) ||
    (address.length >= 5 && normalized.includes(address))
  )
}

export function transitionPitchReview(
  record: ReviewRecord,
  command: ReviewCommand,
  now: number
): ReviewUpdate {
  editable(record)
  if (command.action === "edit_raw") {
    if (
      !["pending_review", "approved", "rejected"].includes(record.reviewStatus)
    ) {
      throw new PitchReviewError("pitch_not_editable")
    }
    return {
      values: {
        rawText: command.rawText,
        reviewStatus: "processing",
        processing: { status: "pending", attempts: 0, nextAttemptAt: now },
        updatedAt: now,
      },
      deleteFields: [
        "approvedAt",
        "rejectionReason",
        "extraction",
        "destination",
        "walkingRoute",
        "duplicateSuggestions",
        "straightLineMeters",
        "publicLabel",
        "durationMinutes",
      ],
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
      80
    )
    if (revealsDestination(publicLabel, record.destination!)) {
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
        updatedAt: now,
      },
      deleteFields: ["approvedAt"],
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
