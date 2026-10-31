import { describe, expect, it } from "vitest"
import type { MissionRecord } from "@/shared/missions"
import type { PollRecord } from "@/shared/polls"
import {
  idleOverlay,
  missionOverlay,
  toOverlayView,
  votingOverlay,
} from "@/shared/overlay"

const now = Date.parse("2026-10-30T23:30:00Z")
const poll: PollRecord = {
  attemptId: "attempt-1",
  lockId: "poll:attempt-1",
  status: "active",
  title: "What should we do next?",
  durationSeconds: 60,
  choices: [
    {
      redemptionId: "secret-redemption-1",
      title: "Mystery food challenge",
      twitchChoiceId: "secret-choice-1",
    },
    {
      redemptionId: "secret-redemption-2",
      title: "Find something blue",
      twitchChoiceId: "secret-choice-2",
    },
  ],
  requestedAt: now - 1000,
  updatedAt: now,
  twitchPollId: "secret-poll-id",
}
const mission: MissionRecord = {
  missionId: "secret-mission-id",
  lockId: "secret-lock-id",
  pollId: "secret-poll-id",
  redemptionId: "secret-redemption-1",
  status: "heading",
  publicLabel: "Mystery food challenge",
  durationMinutes: 10,
  destination: {
    placeId: "secret-place-id",
    name: "Sample Cafe",
    address: "123 Private Street",
    latitude: 37.78,
    longitude: -122.41,
    publicAccess: true,
    businessStatus: "operational",
    hoursText: ["Open until 9 PM"],
    googleMapsUri: "https://maps.google.com/private",
    attributions: [],
  },
  walkingRoute: { distanceMeters: 800, durationSeconds: 600 },
  activatedAt: now,
  updatedAt: now,
}

describe("public overlay projection", () => {
  it("publishes only ordered approved poll wording", () => {
    const projection = votingOverlay(poll)
    expect(projection).toEqual({
      state: "voting",
      updatedAt: now,
      title: "What should we do next?",
      choices: [
        { position: 1, title: "Mystery food challenge" },
        { position: 2, title: "Find something blue" },
      ],
    })
    expect(JSON.stringify(projection)).not.toContain("secret-")
  })

  it("hides every destination field while heading there", () => {
    const projection = missionOverlay(mission)
    expect(projection).toEqual({
      state: "heading",
      updatedAt: now,
      objective: "Mystery food challenge",
    })
    expect(JSON.stringify(projection)).not.toContain("Sample Cafe")
    expect(JSON.stringify(projection)).not.toContain("37.78")
  })

  it("manual arrival publishes the timer but cannot reveal the place", () => {
    const arrived: MissionRecord = {
      ...mission,
      status: "arrived",
      arrivedAt: now + 1000,
      timerEndsAt: now + 601_000,
      updatedAt: now + 1000,
    }
    expect(missionOverlay(arrived)).toEqual({
      state: "arrived",
      updatedAt: now + 1000,
      objective: "Mystery food challenge",
      timerEndsAt: now + 601_000,
    })
    expect(
      missionOverlay({ ...arrived, destinationRevealedAt: now + 1000 })
    ).toEqual({
      state: "arrived",
      updatedAt: now + 1000,
      objective: "Mystery food challenge",
      timerEndsAt: now + 601_000,
      placeName: "Sample Cafe",
    })
  })

  it("rebuilds an allowlist and drops injected private fields", () => {
    const view = toOverlayView({
      state: "arrived",
      updatedAt: now,
      objective: "Mystery food challenge",
      timerEndsAt: now + 600_000,
      placeName: "Sample Cafe",
      address: "123 Private Street",
      latitude: 37.78,
      rawText: "private pitch",
      safetyFlags: ["private"],
      ownerToken: "secret",
    })
    expect(view).toEqual({
      state: "arrived",
      updatedAt: now,
      objective: "Mystery food challenge",
      timerEndsAt: now + 600_000,
      placeName: "Sample Cafe",
    })
  })

  it("fails closed on malformed stored projections", () => {
    expect(() =>
      toOverlayView({
        state: "voting",
        updatedAt: now,
        title: "Question",
        choices: [{ position: 2, title: "Wrong ordering" }],
      })
    ).toThrow("invalid_overlay_projection")
    expect(idleOverlay(now)).toEqual({ state: "idle", updatedAt: now })
  })
})
