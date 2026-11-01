import { describe, expect, it } from "vitest"
import {
  automationPreset,
  automationThresholdMet,
  canAutoApprove,
  DEFAULT_AUTOMATION_SETTINGS,
  dropsAfterLoss,
  eligibleAfterVeto,
  nextPollAt,
  parseAutomationSettings,
  selectShortlist,
  type AutoApprovalPitch,
  type ShortlistPitch,
} from "@/shared/automation"
import {
  autoApprovePitch,
  dropPitch,
  toPitchReviewItem,
  transitionPitchReview,
  type ReviewRecord,
} from "@/shared/pitches/review"

const now = Date.parse("2026-11-01T20:00:00Z")
const auto = { ...DEFAULT_AUTOMATION_SETTINGS, autoApproval: true }

function clean(overrides: Partial<AutoApprovalPitch> = {}): AutoApprovalPitch {
  return {
    reviewStatus: "pending_review",
    riskFlags: [],
    processingWarnings: [],
    anywhere: false,
    destination: { openNow: true, businessStatus: "operational" },
    viewerTrusted: null,
    ...overrides,
  }
}

function record(overrides: Partial<ReviewRecord> = {}): ReviewRecord {
  return {
    redemptionId: "redemption-1",
    rawText: "Eat a burrito at Chipotle",
    viewer: { id: "5", name: "Viewer", login: "viewer" },
    reviewStatus: "pending_review",
    createdAt: now - 10_000,
    updatedAt: now - 10_000,
    extraction: {
      placeQuery: "Chipotle",
      challenge: "Eat a burrito",
      publicLabelSuggestion: "Burrito at Chipotle",
      durationMinutes: 10,
      riskFlags: [],
    },
    destination: {
      placeId: "place-1",
      name: "Chipotle",
      address: "1 Main Street",
      latitude: 37.7,
      longitude: -122.4,
      publicAccess: true,
      businessStatus: "operational",
      hoursText: null,
      openNow: true,
      googleMapsUri: "https://maps.google.com/?cid=1",
      attributions: [],
    },
    walkingRoute: { distanceMeters: 500, durationSeconds: 400 },
    processing: { status: "complete", attempts: 1 },
    ...overrides,
  }
}

function shortlistPitch(
  redemptionId: string,
  overrides: Partial<ShortlistPitch> = {}
): ShortlistPitch {
  return {
    redemptionId,
    publicLabel: `Label ${redemptionId}`,
    createdAt: now,
    funScore: 50,
    distanceMeters: 500,
    ...overrides,
  }
}

describe("auto approval", () => {
  it("approves only clean pitches with an open place", () => {
    expect(canAutoApprove(clean(), auto, false)).toBe(true)
    expect(canAutoApprove(clean(), auto, true)).toBe(false)
    expect(canAutoApprove(clean(), DEFAULT_AUTOMATION_SETTINGS, false)).toBe(
      false
    )
    expect(
      canAutoApprove(
        clean({
          destination: { openNow: false, businessStatus: "operational" },
        }),
        auto,
        false
      )
    ).toBe(false)
    expect(canAutoApprove(clean({ destination: null }), auto, false)).toBe(
      false
    )
    expect(
      canAutoApprove(
        clean({ processingWarnings: ["stale_location"] }),
        auto,
        false
      )
    ).toBe(false)
    expect(
      canAutoApprove(clean({ reviewStatus: "approved" }), auto, false)
    ).toBe(false)
    // An anywhere mission has no place to be closed.
    expect(
      canAutoApprove(clean({ anywhere: true, destination: null }), auto, false)
    ).toBe(true)
  })

  it("never auto approves a flagged pitch, whatever the settings", () => {
    const flagged = clean({
      riskFlags: [{ category: "dangerous", reason: "traffic" }],
      viewerTrusted: true,
      anywhere: true,
    })
    for (const preset of ["manual", "assisted", "full_auto"] as const) {
      for (const trustedViewersOnly of [false, true]) {
        expect(
          canAutoApprove(
            flagged,
            {
              ...automationPreset(preset),
              autoApproval: true,
              trustedViewersOnly,
            },
            false
          )
        ).toBe(false)
      }
    }
    // The real record path too: a flagged extraction maps to a flag.
    const item = toPitchReviewItem(
      record({
        extraction: {
          ...record().extraction!,
          riskFlags: [{ category: "harassing", reason: "follows someone" }],
        },
      })
    )
    expect(
      canAutoApprove(
        { ...item, viewerTrusted: true },
        automationPreset("full_auto"),
        false
      )
    ).toBe(false)
  })

  it("applies the trust filter only once roles are known", () => {
    const trusted = { ...auto, trustedViewersOnly: true }
    expect(canAutoApprove(clean(), trusted, false)).toBe(false)
    expect(
      canAutoApprove(clean({ viewerTrusted: false }), trusted, false)
    ).toBe(false)
    expect(canAutoApprove(clean({ viewerTrusted: true }), trusted, false)).toBe(
      true
    )
  })
})

describe("veto window", () => {
  it("auto approval opens a veto window the owner can reject during", () => {
    const update = autoApprovePitch(record(), now, 60)
    expect(update.values).toMatchObject({
      reviewStatus: "approved",
      autoApprovedAt: now,
      vetoUntil: now + 60_000,
    })
    expect(update.deleteFields).not.toContain("vetoUntil")
    const approved = record({ ...update.values } as Partial<ReviewRecord>)
    expect(toPitchReviewItem(approved)).toMatchObject({
      autoApproved: true,
      vetoUntil: now + 60_000,
    })
    const rejected = transitionPitchReview(
      approved,
      { action: "reject" },
      now + 30_000
    )
    expect(rejected.values).toMatchObject({
      reviewStatus: "rejected",
      redemptionResolution: { action: "refund", status: "pending" },
    })
    expect(rejected.deleteFields).toEqual(
      expect.arrayContaining(["autoApprovedAt", "vetoUntil"])
    )
  })

  it("keeps vetoed pitches out of the shortlist until the window ends", () => {
    expect(eligibleAfterVeto({ vetoUntil: now + 1 }, now)).toBe(false)
    expect(eligibleAfterVeto({ vetoUntil: now }, now)).toBe(true)
    expect(eligibleAfterVeto({}, now)).toBe(true)
    const pitches = [
      shortlistPitch("a"),
      shortlistPitch("b", { vetoUntil: now + 30_000 }),
      shortlistPitch("c"),
    ]
    const settings = { ...auto, shortlistOrdering: "oldest" as const }
    expect(
      selectShortlist(pitches, settings, now).map((p) => p.redemptionId)
    ).toEqual(["a", "c"])
    expect(
      selectShortlist(pitches, settings, now + 30_000).map(
        (p) => p.redemptionId
      )
    ).toEqual(["a", "b", "c"])
  })
})

describe("auto poll threshold", () => {
  const autoPoll = { ...DEFAULT_AUTOMATION_SETTINGS, autoStartPoll: true }

  it("starts only with enough eligible pitches", () => {
    expect(automationThresholdMet(2, autoPoll)).toBe(false)
    expect(automationThresholdMet(3, autoPoll)).toBe(true)
    expect(
      automationThresholdMet(2, { ...autoPoll, minimumEligiblePitches: 2 })
    ).toBe(true)
    expect(automationThresholdMet(5, DEFAULT_AUTOMATION_SETTINGS)).toBe(false)
  })

  it("never accepts a threshold below 2", () => {
    expect(
      parseAutomationSettings({ minimumEligiblePitches: 1 })
        .minimumEligiblePitches
    ).toBe(3)
    expect(
      automationThresholdMet(1, { ...autoPoll, minimumEligiblePitches: 1 })
    ).toBe(false)
  })

  it("waits the post-mission delay so the stamp can land", () => {
    expect(nextPollAt(null, autoPoll)).toBe(0)
    expect(nextPollAt(now, autoPoll)).toBe(now + 15_000)
  })
})

describe("shortlist", () => {
  it("mixes one oldest, one newest, then the most fun", () => {
    const pitches = [
      shortlistPitch("old", { createdAt: now - 3000, funScore: 10 }),
      shortlistPitch("fun", { createdAt: now - 2000, funScore: 95 }),
      shortlistPitch("meh", { createdAt: now - 1000, funScore: 40 }),
      shortlistPitch("new", { createdAt: now, funScore: 20 }),
    ]
    expect(
      selectShortlist(pitches, auto, now).map((p) => p.redemptionId)
    ).toEqual(["old", "new", "fun"])
  })

  it("never shortlists two choices with the same label", () => {
    const pitches = [
      shortlistPitch("a", { publicLabel: "Dance", createdAt: now - 2 }),
      shortlistPitch("b", { publicLabel: "dance", createdAt: now - 1 }),
      shortlistPitch("c", { createdAt: now }),
    ]
    expect(
      selectShortlist(
        pitches,
        { ...auto, shortlistOrdering: "oldest" },
        now
      ).map((p) => p.redemptionId)
    ).toEqual(["a", "c"])
  })
})

describe("poll losses", () => {
  it("drops a pitch at the loss limit only when polls are automatic", () => {
    const autoPoll = { ...DEFAULT_AUTOMATION_SETTINGS, autoStartPoll: true }
    expect(dropsAfterLoss(1, autoPoll)).toBe(false)
    expect(dropsAfterLoss(2, autoPoll)).toBe(true)
    expect(dropsAfterLoss(2, DEFAULT_AUTOMATION_SETTINGS)).toBe(false)
    const dropped = dropPitch(
      record({ reviewStatus: "approved" }),
      "lost_polls",
      now
    )
    expect(dropped.values).toMatchObject({
      reviewStatus: "rejected",
      rejectionReason: "lost_polls",
      redemptionResolution: { action: "refund", status: "pending" },
    })
  })
})
