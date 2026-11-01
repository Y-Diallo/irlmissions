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
        failConsequence: "Sing a silly song",
      },
      now
    )
    expect(update.values).toMatchObject({
      reviewStatus: "pending_review",
      publicLabel: "Mystery speed challenge",
      durationMinutes: 12,
      extraction: expect.objectContaining({
        failConsequence: "Sing a silly song",
      }),
    })
    expect(update.deleteFields).toContain("approvedAt")
  })

  it("lets the owner replace or clear the generated fail consequence", () => {
    const source = record({
      extraction: {
        ...record().extraction!,
        failConsequence: "Do ten jumping jacks",
      },
    })
    expect(
      transitionPitchReview(
        source,
        {
          action: "edit_details",
          publicLabel: "Ten-item challenge",
          durationMinutes: 10,
          failConsequence: "Sing a silly song",
        },
        now
      ).values
    ).toMatchObject({
      extraction: { failConsequence: "Sing a silly song" },
      reviewStatus: "pending_review",
    })
    expect(
      transitionPitchReview(
        source,
        {
          action: "edit_details",
          publicLabel: "Ten-item challenge",
          durationMinutes: 10,
          failConsequence: "",
        },
        now
      ).values
    ).toMatchObject({ extraction: { failConsequence: "" } })
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

  it("approves an anywhere pitch without a destination", () => {
    const anywhere = record({
      extraction: {
        placeQuery: "",
        challenge: "Walk backwards while trick or treating",
        publicLabelSuggestion: "Trick or treat backwards",
        durationMinutes: 10,
        riskFlags: [],
        anywhere: true,
      },
      destination: null,
      walkingRoute: null,
    })
    expect(
      transitionPitchReview(anywhere, { action: "approve" }, now).values
    ).toMatchObject({ reviewStatus: "approved" })
    expect(toPitchReviewItem(anywhere)).toMatchObject({
      anywhere: true,
      destination: null,
    })
  })

  it("forces no travel, and only unforces when a place was found", () => {
    const forced = transitionPitchReview(
      record({ reviewStatus: "approved" }),
      { action: "set_no_travel", noTravel: true },
      now
    )
    expect(forced.values).toEqual({ noTravel: true, updatedAt: now })
    expect(toPitchReviewItem({ ...record(), noTravel: true })).toMatchObject({
      anywhere: true,
      noTravel: true,
    })
    expect(() =>
      transitionPitchReview(
        record({ destination: null, noTravel: true }),
        { action: "set_no_travel", noTravel: false },
        now
      )
    ).toThrow("no_destination_found")
    expect(
      parseReviewCommand({ action: "set_no_travel", noTravel: true })
    ).toEqual({ action: "set_no_travel", noTravel: true })
    expect(() =>
      parseReviewCommand({ action: "set_no_travel", noTravel: "yes" })
    ).toThrow("invalid_command")
  })

  it("revives a no-place rejection when no travel is forced", () => {
    const update = transitionPitchReview(
      record({
        reviewStatus: "rejected",
        rejectionReason: "no_public_place",
        redemptionResolution: {
          action: "refund",
          status: "pending",
          attempts: 0,
          nextAttemptAt: now,
        },
      }),
      { action: "set_no_travel", noTravel: true },
      now
    )
    expect(update.values).toMatchObject({
      noTravel: true,
      reviewStatus: "processing",
    })
    expect(update.deleteFields).toContain("redemptionResolution")
  })

  it("lets a rejected pitch be edited only before its refund starts", () => {
    const rejected = record({
      reviewStatus: "rejected",
      rejectionReason: "no_public_place",
      redemptionResolution: {
        action: "refund",
        status: "pending",
        attempts: 0,
        nextAttemptAt: now,
      },
    })
    const update = transitionPitchReview(
      rejected,
      { action: "edit_raw", rawText: "Trick or treat at a costume shop" },
      now
    )
    expect(update.values).toMatchObject({ reviewStatus: "processing" })
    expect(update.deleteFields).toContain("redemptionResolution")
    for (const resolution of [
      { action: "refund", status: "pending", attempts: 1 },
      { action: "refund", status: "processing", attempts: 1 },
      { action: "refund", status: "complete", attempts: 1 },
    ] as const) {
      expect(() =>
        transitionPitchReview(
          { ...rejected, redemptionResolution: resolution },
          { action: "edit_raw", rawText: "Try again" },
          now
        )
      ).toThrow("pitch_not_editable")
    }
  })

  it("rejects a public label that reveals the street address", () => {
    expect(() =>
      transitionPitchReview(
        record({ publicLabel: "Go to 123 Demo Street" }),
        { action: "approve" },
        now
      )
    ).toThrow("public_label_reveals_destination")
  })

  it("allows a public label that names the business", () => {
    expect(
      transitionPitchReview(
        record({ publicLabel: "Demo Cafe challenge" }),
        { action: "approve" },
        now
      ).values
    ).toMatchObject({ reviewStatus: "approved" })
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
        record({
          reviewStatus: "rejected",
          redemptionResolution: {
            action: "refund",
            status: "processing",
            attempts: 1,
          },
        }),
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
        failConsequence: "  Wear a funny hat  ",
      })
    ).toEqual({
      action: "edit_details",
      publicLabel: "Mystery objective",
      durationMinutes: 10,
      failConsequence: "Wear a funny hat",
    })
    const item = toPitchReviewItem(
      record({ processingWarnings: ["stale_location"] })
    )
    expect(item).toMatchObject({
      redemptionId: "redemption-1",
      viewerName: "Viewer",
      publicLabel: "Ten-item speed challenge",
      processingWarnings: ["stale_location"],
    })
    expect(item).not.toHaveProperty("viewer.id")
  })
})
