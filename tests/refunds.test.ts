import { describe, expect, it } from "vitest"
import {
  parseRefundCommand,
  queueRefund,
  refundState,
  toRefundItem,
} from "@/shared/refunds"
import type { ReviewRecord } from "@/shared/pitches/review"

const now = Date.parse("2026-10-31T03:00:00Z")

function record(overrides: Partial<ReviewRecord> = {}): ReviewRecord {
  return {
    redemptionId: "redemption-1",
    rawText: "Visit a cafe",
    viewer: { name: "Viewer" },
    reviewStatus: "approved",
    redemptionStatus: "unfulfilled",
    publicLabel: "Mystery cafe challenge",
    createdAt: now - 1000,
    updatedAt: now - 1000,
    ...overrides,
  }
}

describe("refund screen policy", () => {
  it("offers only unused, unfulfilled, unlocked pitches", () => {
    expect(refundState(record())).toBe("eligible")
    expect(refundState(record({ lockedBy: "poll:1" }))).toBe("blocked")
    expect(refundState(record({ reviewStatus: "active_mission" }))).toBe(
      "attempted"
    )
    expect(refundState(record({ redemptionStatus: "fulfilled" }))).toBe(
      "attempted"
    )
    expect(refundState(record({ redemptionStatus: undefined }))).toBe(
      "unavailable"
    )
  })

  it("distinguishes queued, failed, and confirmed refunds", () => {
    expect(
      refundState(
        record({
          redemptionResolution: {
            action: "refund",
            status: "pending",
            attempts: 0,
          },
        })
      )
    ).toBe("queued")
    expect(
      refundState(
        record({
          redemptionResolution: {
            action: "refund",
            status: "error",
            attempts: 5,
            errorCode: "provider",
          },
        })
      )
    ).toBe("retry")
    expect(
      refundState(
        record({
          redemptionResolution: {
            action: "refund",
            status: "complete",
            attempts: 1,
          },
        })
      )
    ).toBe("refunded")
  })

  it("queues a terminal refund and invalidates in-flight enrichment", () => {
    const update = queueRefund(
      record({
        reviewStatus: "processing",
        processing: {
          status: "processing",
          attempts: 2,
        },
      }),
      now
    )
    expect(update?.values).toMatchObject({
      reviewStatus: "rejected",
      rejectionReason: "owner_refund",
      processing: { status: "complete", attempts: 2, completedAt: now },
      redemptionResolution: {
        action: "refund",
        status: "pending",
        attempts: 0,
        nextAttemptAt: now,
      },
    })
    expect(update?.deleteFields).toContain("approvedAt")
  })

  it("never changes locked, attempted, or already queued records", () => {
    expect(queueRefund(record({ lockedBy: "poll:1" }), now)).toBeNull()
    expect(queueRefund(record({ reviewStatus: "completed" }), now)).toBeNull()
    expect(
      queueRefund(
        record({
          redemptionResolution: {
            action: "refund",
            status: "pending",
            attempts: 0,
          },
        }),
        now
      )
    ).toBeNull()
  })

  it("returns a small owner projection and validates the bulk command", () => {
    expect(toRefundItem(record())).toEqual({
      redemptionId: "redemption-1",
      viewerName: "Viewer",
      objective: "Mystery cafe challenge",
      createdAt: now - 1000,
      state: "eligible",
    })
    expect(parseRefundCommand({ action: "queue_unused" })).toEqual({
      action: "queue_unused",
    })
    expect(() => parseRefundCommand({ action: "refund_everything" })).toThrow(
      "invalid_refund_command"
    )
  })
})
