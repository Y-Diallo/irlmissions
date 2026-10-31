import type { ReviewRecord, ReviewUpdate } from "@/shared/pitches/review"

export type RefundState =
  | "eligible"
  | "queued"
  | "retry"
  | "refunded"
  | "blocked"
  | "attempted"
  | "unavailable"

export type RefundItem = {
  redemptionId: string
  viewerName: string
  objective: string
  createdAt: number
  state: RefundState
  errorCode?: string
}

export class RefundError extends Error {
  constructor(
    public readonly code: string,
    public readonly status = 400
  ) {
    super(code)
  }
}

export function refundState(record: ReviewRecord): RefundState {
  const resolution = record.redemptionResolution
  if (
    record.redemptionStatus === "canceled" ||
    (resolution?.action === "refund" && resolution.status === "complete")
  ) {
    return "refunded"
  }
  if (
    record.redemptionStatus === "fulfilled" ||
    resolution?.action === "fulfill" ||
    ["active_mission", "completed", "failed"].includes(record.reviewStatus)
  ) {
    return "attempted"
  }
  if (resolution?.action === "refund" && resolution.status === "error") {
    return "retry"
  }
  if (
    resolution?.action === "refund" &&
    ["pending", "processing"].includes(resolution.status)
  ) {
    return "queued"
  }
  if (record.lockedBy) return "blocked"
  if (
    record.redemptionStatus === "unfulfilled" &&
    ["processing", "pending_review", "approved", "rejected"].includes(
      record.reviewStatus
    )
  ) {
    return "eligible"
  }
  return "unavailable"
}

export function toRefundItem(record: ReviewRecord): RefundItem {
  const state = refundState(record)
  return {
    redemptionId: record.redemptionId,
    viewerName: record.viewer?.name || record.viewer?.login || "Viewer",
    objective:
      record.publicLabel ??
      record.extraction?.challenge ??
      record.rawText.slice(0, 80),
    createdAt: record.createdAt,
    state,
    ...(state === "retry" && record.redemptionResolution?.errorCode
      ? { errorCode: record.redemptionResolution.errorCode }
      : {}),
  }
}

export function queueRefund(
  record: ReviewRecord,
  now: number
): ReviewUpdate | null {
  const state = refundState(record)
  if (state !== "eligible" && state !== "retry") return null
  return {
    values: {
      reviewStatus: "rejected",
      rejectionReason: record.rejectionReason ?? "owner_refund",
      processing: {
        status: "complete",
        attempts: record.processing?.attempts ?? 0,
        completedAt: now,
      },
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

export function parseRefundCommand(value: unknown) {
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    (value as Record<string, unknown>).action !== "queue_unused"
  ) {
    throw new RefundError("invalid_refund_command")
  }
  return { action: "queue_unused" as const }
}
