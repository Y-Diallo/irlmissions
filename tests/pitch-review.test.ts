import { describe, expect, it } from "vitest"
import {
  parseReviewCommand,
  toPitchReviewItem,
  transitionPitchReview,
  type ReviewRecord,
} from "@/shared/pitches/review"

const now = Date.parse("2026-10-30T21:00:00Z")

function record(overrides: Partial<ReviewRecord> = {}): ReviewRecord {
  return {
    redemptionId: "redemption-1",
    rawText: "Eat ten sandwiches at the cafe",
    viewer: { name: "Viewer", login: "viewer" },
    reviewStatus: "pending_review",
    createdAt: now - 1000,
    updatedAt: now - 1000,
    extraction: {
      placeQuery: "cafe",
      challenge: "Eat ten sandwiches",
      publicLabelSuggestion: "Ten-item speed challenge",
      durationMinutes: 10,
      riskFlags: [],
    },
    destination: {
      placeId: "place-1",
      name: "Demo Cafe",
      address: "123 Demo Street",
      latitude: 37.7,
      longitude: -122.4,
      publicAccess: true,
      businessStatus: "operational",
      hoursText: null,
      googleMapsUri: "https://maps.google.com/?cid=1",
      attributions: [],
    },
    walkingRoute: { distanceMeters: 500, durationSeconds: 400 },
    processing: { status: "complete", attempts: 1 },
    ...overrides,
  }
}

describe("pitch review transitions", () => {
  it("requeues a raw edit and removes all prior enrichment and approval", () => {
    const update = transitionPitchReview(
      record({ reviewStatus: "approved", approvedAt: now - 500 }),
      { action: "edit_raw", rawText: "Visit a public park" },
      now
    )
    expect(update.values).toMatchObject({
      rawText: "Visit a public park",
      reviewStatus: "processing",
      processing: { status: "pending", attempts: 0, nextAttemptAt: now },
    })
    expect(update.deleteFields).toEqual(
      expect.arrayContaining(["approvedAt", "destination", "extraction"])
    )
  })

  it("clears approval when public details change", () => {
    const update = transitionPitchReview(
      record({ reviewStatus: "approved", approvedAt: now - 500 }),
      {
        action: "edit_details",
        publicLabel: "Mystery speed challenge",
        durationMinutes: 12,
      },
      now
    )
    expect(update.values).toMatchObject({
      reviewStatus: "pending_review",
      publicLabel: "Mystery speed challenge",
      durationMinutes: 12,
    })
    expect(update.deleteFields).toContain("approvedAt")
  })

  it("approves flagged pitches only through an explicit human command", () => {
    const flagged = record({
      publicLabel: "Mystery challenge",
      extraction: {
        ...record().extraction!,
        riskFlags: [{ category: "dangerous", reason: "Review this" }],
      },
    })
    expect(
      transitionPitchReview(flagged, { action: "approve" }, now).values
    ).toMatchObject({
      reviewStatus: "approved",
      approvedAt: now,
    })
  })

  it("rejects a public label that reveals the destination", () => {
    expect(() =>
      transitionPitchReview(
        record({ publicLabel: "Demo Cafe challenge" }),
        { action: "approve" },
        now
      )
    ).toThrow("public_label_reveals_destination")
  })

  it("blocks every mutation while a poll or mission owns the pitch", () => {
    expect(() =>
      transitionPitchReview(
        record({ lockedBy: "poll-1" }),
        { action: "reject" },
        now
      )
    ).toThrow("pitch_locked")
  })

  it("manual retry resets a stopped record but not an active one", () => {
    expect(
      transitionPitchReview(
        record({
          reviewStatus: "processing",
          processing: {
            status: "error",
            attempts: 5,
            automaticRetryAt: null,
          },
        }),
        { action: "retry" },
        now
      ).values
    ).toMatchObject({
      processing: { status: "pending", attempts: 0, nextAttemptAt: now },
    })
    expect(() =>
      transitionPitchReview(
        record({
          reviewStatus: "processing",
          processing: { status: "pending" },
        }),
        { action: "retry" },
        now
      )
    ).toThrow("pitch_not_retryable")
  })

  it("queues owner rejection for refund and allows failed Twitch retries", () => {
    const rejected = transitionPitchReview(record(), { action: "reject" }, now)
    expect(rejected.values).toMatchObject({
      reviewStatus: "rejected",
      redemptionResolution: {
        action: "refund",
        status: "pending",
        attempts: 0,
        nextAttemptAt: now,
      },
    })
    expect(
      transitionPitchReview(
        record({
          reviewStatus: "rejected",
          redemptionResolution: {
            action: "refund",
            status: "error",
            attempts: 5,
            errorCode: "provider",
            automaticRetryAt: null,
          },
        }),
        { action: "retry_resolution" },
        now
      ).values
    ).toMatchObject({
      redemptionResolution: {
        action: "refund",
        status: "pending",
        attempts: 0,
        nextAttemptAt: now,
      },
    })
    expect(() =>
      transitionPitchReview(
        record({ reviewStatus: "rejected" }),
        { action: "edit_raw", rawText: "Try to reuse refunded pitch" },
        now
      )
    ).toThrow("pitch_not_editable")
  })

  it("validates commands and returns only the owner queue projection", () => {
    expect(
      parseReviewCommand({
        action: "edit_details",
        publicLabel: " Mystery objective ",
        durationMinutes: 10,
      })
    ).toEqual({
      action: "edit_details",
      publicLabel: "Mystery objective",
      durationMinutes: 10,
    })
    const item = toPitchReviewItem(record())
    expect(item).toMatchObject({
      redemptionId: "redemption-1",
      viewerName: "Viewer",
      publicLabel: "Ten-item speed challenge",
    })
    expect(item).not.toHaveProperty("viewer.id")
  })
})
