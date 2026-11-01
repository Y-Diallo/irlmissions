import { describe, expect, it } from "vitest"
import type { MissionRecord } from "@/shared/missions"
import type { PollRecord } from "@/shared/polls"
import {
  idleOverlay,
  missionOverlay,
  tallyOverlay,
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
        { position: 1, title: "Mystery food challenge", votes: 0 },
        { position: 2, title: "Find something blue", votes: 0 },
      ],
    })
    expect(JSON.stringify(projection)).not.toContain("secret-")
  })

  it("applies live tallies without lowering counts, then final counts", () => {
    const voting = votingOverlay(poll)
    const live = tallyOverlay(
      voting,
      {
        choices: [
          { title: "Mystery food challenge", votes: 3 },
          { title: "Find something blue", votes: 1 },
        ],
        ended: false,
      },
      now + 1000
    )
    expect(live).toMatchObject({
      choices: [{ votes: 3 }, { votes: 1 }],
    })
    expect(live).not.toHaveProperty("ended")
    const stale = tallyOverlay(
      live,
      {
        choices: [
          { title: "Mystery food challenge", votes: 2 },
          { title: "Find something blue", votes: 2 },
        ],
        ended: false,
      },
      now + 2000
    )
    expect(stale).toMatchObject({ choices: [{ votes: 3 }, { votes: 2 }] })
    const final = tallyOverlay(
      stale,
      {
        choices: [
          { title: "Mystery food challenge", votes: 4 },
          { title: "Find something blue", votes: 4 },
        ],
        ended: true,
      },
      now + 3000
    )
    expect(final).toMatchObject({
      ended: true,
      choices: [{ votes: 4 }, { votes: 4 }],
    })
    // A late progress event cannot reopen a closed poll.
    expect(
      tallyOverlay(
        final,
        {
          choices: [
            { title: "Mystery food challenge", votes: 5 },
            { title: "Find something blue", votes: 4 },
          ],
          ended: false,
        },
        now + 4000
      )
    ).toBeNull()
    expect(
      tallyOverlay(missionOverlay(mission), { choices: [], ended: false }, now)
    ).toBeNull()
  })

  it("shows a tied poll as ended and tied", () => {
    expect(
      votingOverlay({
        ...poll,
        status: "tie",
        choices: poll.choices.map((choice) => ({ ...choice, votes: 2 })),
        tiedRedemptionIds: ["secret-redemption-1", "secret-redemption-2"],
      })
    ).toMatchObject({
      ended: true,
      tie: true,
      choices: [{ votes: 2 }, { votes: 2 }],
    })
  })

  it("hides every destination field while heading there", () => {
    const projection = missionOverlay(mission)
    expect(projection).toEqual({
      state: "heading",
      updatedAt: now,
      objective: "Mystery food challenge",
      chosenBy: "Chat",
    })
    expect(
      missionOverlay({ ...mission, viewerName: "CoolViewer" })
    ).toMatchObject({ chosenBy: "CoolViewer" })
    expect(JSON.stringify(projection)).not.toContain("Sample Cafe")
    expect(JSON.stringify(projection)).not.toContain("37.78")
  })

  it("publishes the place only once the arrival reveal is set", () => {
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
      hasPlacePhoto: true,
      photoVersion: now + 1000,
    })
  })

  it("shows an active consequence throughout its clearing mission", () => {
    const withPenalty: MissionRecord = {
      ...mission,
      activeConsequences: [
        {
          consequenceId: "consequence-1",
          text: "Eat a lemon",
          clearRule: "through_next_mission",
          sourceMissionId: "previous-mission",
          setBy: "CoolViewer",
          activatedAt: now - 1000,
        },
      ],
    }
    expect(missionOverlay(withPenalty)).toMatchObject({
      consequences: [
        {
          consequenceId: "consequence-1",
          text: "Eat a lemon",
          clearRule: "through_next_mission",
          setBy: "CoolViewer",
        },
      ],
    })
    expect(
      missionOverlay({
        ...withPenalty,
        status: "arrived",
        timerEndsAt: now + 60_000,
      })
    ).toMatchObject({ consequences: [{ text: "Eat a lemon" }] })
    expect(
      toOverlayView({
        state: "heading",
        updatedAt: now,
        objective: "Go",
        chosenBy: "Chat",
        consequences: [
          {
            consequenceId: "consequence-1",
            text: "Eat a lemon",
            setBy: "CoolViewer",
            clearRule: "through_next_mission",
          },
        ],
      })
    ).toMatchObject({
      consequences: [
        {
          text: "Eat a lemon",
          setBy: "CoolViewer",
          clearRule: "through_next_mission",
        },
      ],
    })
  })

  it("clears a stored timed consequence at endsAt after a reload", () => {
    const stored = {
      state: "heading",
      updatedAt: now,
      objective: "Go",
      chosenBy: "Chat",
      consequences: [
        {
          consequenceId: "timed-1",
          text: "Use a pirate voice",
          setBy: "CoolViewer",
          clearRule: "timed",
          endsAt: now + 600_000,
        },
      ],
    }
    expect(toOverlayView(stored, now + 599_999)).toMatchObject({
      consequences: [{ consequenceId: "timed-1" }],
    })
    expect(toOverlayView(stored, now + 600_000)).not.toHaveProperty(
      "consequences"
    )
  })

  it("publishes only photo availability after reveal", () => {
    const arrived: MissionRecord = {
      ...mission,
      status: "arrived",
      arrivedAt: now,
      timerEndsAt: now + 600_000,
      destinationRevealedAt: now,
    }
    const projection = missionOverlay(arrived)
    expect(projection).toMatchObject({
      placeName: "Sample Cafe",
      hasPlacePhoto: true,
      photoVersion: now,
    })
    expect(JSON.stringify(projection)).not.toContain("secret-place-id")
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
