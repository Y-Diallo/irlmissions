import { describe, expect, it } from "vitest"
import {
  activeConsequences,
  carryActiveConsequences,
  createMissionFromWinner,
  missionNavigation,
  payManualConsequence,
  parseMissionAction,
  toMissionOwnerView,
  transitionMission,
  type MissionRecord,
} from "@/shared/missions"
import { missionOverlay } from "@/shared/overlay"
import type { PollRecord } from "@/shared/polls"

const now = Date.parse("2026-10-30T23:00:00Z")
const poll: PollRecord = {
  attemptId: "attempt-1",
  lockId: "poll:attempt-1",
  status: "completed",
  title: "What should we do next?",
  durationSeconds: 60,
  requestedAt: now - 65_000,
  updatedAt: now,
  twitchPollId: "poll-1",
  winnerRedemptionId: "redemption-1",
  choices: [
    {
      redemptionId: "redemption-1",
      title: "Mystery food challenge",
      twitchChoiceId: "choice-1",
      votes: 5,
    },
    {
      redemptionId: "redemption-2",
      title: "Find something blue",
      twitchChoiceId: "choice-2",
      votes: 2,
    },
  ],
}
const pitch = {
  redemptionId: "redemption-1",
  reviewStatus: "approved",
  publicLabel: "Mystery food challenge",
  durationMinutes: 10,
  lockedBy: "poll:attempt-1",
  destination: {
    placeId: "place-1",
    name: "Sample Cafe",
    address: "123 Test Street",
    latitude: 37.78,
    longitude: -122.41,
    publicAccess: true,
    businessStatus: "operational" as const,
    hoursText: ["Open until 9 PM"],
    googleMapsUri: "https://maps.google.com/?cid=place-1",
    attributions: [],
  },
  walkingRoute: { distanceMeters: 800, durationSeconds: 600 },
}

function mission(): MissionRecord {
  return createMissionFromWinner(poll, pitch, now)
}

describe("mission state", () => {
  it("creates a private heading mission from only the locked winning pitch", () => {
    expect(mission()).toMatchObject({
      missionId: "poll:poll-1",
      lockId: "mission:poll:poll-1",
      pollId: "poll-1",
      redemptionId: "redemption-1",
      status: "heading",
      publicLabel: "Mystery food challenge",
      durationMinutes: 10,
      destination: { name: "Sample Cafe" },
    })
    expect(
      createMissionFromWinner(
        poll,
        { ...pitch, viewer: { id: "1", login: "cool", name: "CoolViewer" } },
        now
      ).viewerName
    ).toBe("CoolViewer")
    expect(() =>
      createMissionFromWinner(poll, { ...pitch, lockedBy: "other" }, now)
    ).toThrow("winner_not_available")
    expect(() =>
      createMissionFromWinner(
        poll,
        { ...pitch, publicLabel: "Changed after poll" },
        now
      )
    ).toThrow("mission_label_mismatch")
  })

  it("starts an anywhere mission with its timer already running", () => {
    const anywhere = createMissionFromWinner(
      poll,
      {
        ...pitch,
        destination: undefined,
        walkingRoute: undefined,
        extraction: { anywhere: true },
      },
      now
    )
    expect(anywhere).toMatchObject({
      status: "arrived",
      arrivedAt: now,
      timerEndsAt: now + 600_000,
      destination: null,
      walkingRoute: null,
    })
    expect(toMissionOwnerView(anywhere).navigation).toBeNull()
    expect(missionOverlay(anywhere)).toMatchObject({
      state: "arrived",
      timerEndsAt: now + 600_000,
    })
    expect(missionOverlay(anywhere)).not.toHaveProperty("placeName")
  })

  it("starts the timer exactly once using the server arrival timestamp", () => {
    const arrived = transitionMission(mission(), "arrive", now + 1000)
    expect(arrived).toMatchObject({
      status: "arrived",
      arrivedAt: now + 1000,
      timerEndsAt: now + 601_000,
    })
    expect(transitionMission(arrived, "arrive", now + 5000)).toBe(arrived)
  })

  it("requires arrival and permits only one terminal outcome", () => {
    expect(() => transitionMission(mission(), "complete", now + 1000)).toThrow(
      "mission_not_arrived"
    )
    const arrived = transitionMission(mission(), "arrive", now + 1000)
    const complete = transitionMission(arrived, "complete", now + 2000)
    expect(complete).toMatchObject({
      status: "completed",
      outcomeAt: now + 2000,
    })
    expect(transitionMission(complete, "complete", now + 3000)).toBe(complete)
    expect(() => transitionMission(complete, "fail", now + 3000)).toThrow(
      "mission_finished"
    )
  })

  it("denies an arrived mission without activating its consequence", () => {
    const withConsequence: MissionRecord = {
      ...mission(),
      viewerName: "Pitcher",
      failConsequence: "Use a pirate voice",
      failConsequenceClearRule: "manual",
    }
    const denied = transitionMission(
      transitionMission(withConsequence, "arrive", now + 1000),
      "deny",
      now + 2000
    )
    expect(denied).toMatchObject({
      status: "failed",
      outcome: "denied",
      outcomeAt: now + 2000,
    })
    expect(denied.activeConsequences).toBeUndefined()
    expect(missionOverlay(denied)).toMatchObject({
      state: "failed",
      denied: true,
    })
  })

  function failedWith(
    clearRule: "timed" | "at_next_stop" | "through_next_mission" | "manual",
    durationMinutes = 0
  ) {
    const first: MissionRecord = {
      ...mission(),
      viewerName: "Pitcher",
      failConsequence: "Use a pirate voice",
      failConsequenceClearRule: clearRule,
      failConsequenceDurationMinutes: durationMinutes,
    }
    const failed = transitionMission(
      transitionMission(first, "arrive", now + 1000),
      "fail",
      now + 2000
    )
    expect(failed.activeConsequences?.[0]).toMatchObject({
      text: "Use a pirate voice",
      clearRule,
      setBy: "Pitcher",
    })
    return failed
  }

  function nextMission(previous: MissionRecord) {
    return carryActiveConsequences(
      { ...mission(), missionId: "next-mission", lockId: "next-lock" },
      previous,
      now + 3000
    )
  }

  it("clears a timed consequence at its server-derived end timestamp", () => {
    const failed = failedWith("timed", 10)
    const endsAt = now + 2000 + 10 * 60_000
    expect(failed.activeConsequences?.[0]).toMatchObject({ endsAt })
    expect(activeConsequences(failed, endsAt - 1)).toHaveLength(1)
    expect(activeConsequences(failed, endsAt)).toHaveLength(0)
    expect(missionOverlay(failed, endsAt)).not.toHaveProperty("consequences")
  })

  it("clears an at-next-stop consequence on the following arrival", () => {
    const failed = failedWith("at_next_stop")
    const next = nextMission(failed)
    expect(next.activeConsequences).toHaveLength(1)
    const arrived = transitionMission(next, "arrive", now + 4000)
    expect(arrived.activeConsequences).toBeUndefined()
    const anywhere = carryActiveConsequences(
      {
        ...mission(),
        missionId: "anywhere-mission",
        lockId: "anywhere-lock",
        status: "arrived",
        destination: null,
        walkingRoute: null,
        arrivedAt: now + 3000,
        timerEndsAt: now + 603_000,
      },
      failed,
      now + 3000
    )
    expect(anywhere.activeConsequences).toBeUndefined()
  })

  it("clears a through-next-mission consequence on its outcome", () => {
    const next = nextMission(failedWith("through_next_mission"))
    expect(missionOverlay(next)).toMatchObject({
      consequences: [
        expect.objectContaining({ clearRule: "through_next_mission" }),
      ],
    })
    const arrived = transitionMission(next, "arrive", now + 4000)
    expect(arrived.activeConsequences).toHaveLength(1)
    const completed = transitionMission(arrived, "complete", now + 5000)
    expect(completed.activeConsequences).toBeUndefined()
  })

  it("caps every owed consequence at the next mission's outcome when enabled", () => {
    const timed = nextMission(failedWith("timed", 120))
    const arrived = transitionMission(timed, "arrive", now + 4000, {
      capConsequences: true,
    })
    // The cap is not an override: the timer still runs until the outcome.
    expect(arrived.activeConsequences).toHaveLength(1)
    expect(
      transitionMission(arrived, "complete", now + 5000, {
        capConsequences: true,
      }).activeConsequences
    ).toBeUndefined()

    const manual = transitionMission(
      nextMission(failedWith("manual")),
      "arrive",
      now + 4000
    )
    const failed = transitionMission(manual, "fail", now + 5000, {
      capConsequences: true,
    })
    // Only this mission's own new consequence remains.
    expect(failed.activeConsequences).toBeUndefined()
    expect(
      transitionMission(manual, "complete", now + 5000).activeConsequences
    ).toHaveLength(1)
  })

  it("keeps a manual consequence until the owner marks it paid", () => {
    const next = nextMission(failedWith("manual"))
    const completed = transitionMission(
      transitionMission(next, "arrive", now + 4000),
      "complete",
      now + 5000
    )
    expect(completed.activeConsequences).toHaveLength(1)
    const consequenceId = completed.activeConsequences![0]!.consequenceId
    const paid = payManualConsequence(completed, consequenceId, now + 6000)
    expect(paid.activeConsequences).toBeUndefined()
    expect(() =>
      payManualConsequence(
        nextMission(failedWith("at_next_stop")),
        `mission:${mission().missionId}`,
        now + 3500
      )
    ).toThrow("consequence_not_manual")
  })

  it("cancels only before arrival", () => {
    const canceled = transitionMission(mission(), "cancel", now + 1000)
    expect(canceled).toMatchObject({
      status: "canceled",
      outcomeAt: now + 1000,
    })
    expect(transitionMission(canceled, "cancel", now + 2000)).toBe(canceled)
    const arrived = transitionMission(mission(), "arrive", now + 1000)
    expect(() => transitionMission(arrived, "cancel", now + 2000)).toThrow(
      "mission_not_cancelable"
    )
  })

  it("builds explicit walking links without calling an external API", () => {
    const links = missionNavigation(pitch.destination)
    expect(links.googleMaps).toContain("travelmode=walking")
    expect(links.googleMaps).toContain("destination=37.78%2C-122.41")
    expect(links.appleMaps).toContain("dirflg=w")
    expect(links.waze).toContain("navigate=yes")
    const transit = missionNavigation(pitch.destination, "transit")
    expect(transit.googleMaps).toContain("travelmode=transit")
    expect(transit.appleMaps).toContain("dirflg=r")
    const drive = missionNavigation(pitch.destination, "drive")
    expect(drive.googleMaps).toContain("travelmode=driving")
    expect(drive.appleMaps).toContain("dirflg=d")
  })

  it("adds five minutes to the duration, running timer, or elapsed timer", () => {
    expect(
      transitionMission(mission(), "extend", now + 500).durationMinutes
    ).toBe(15)
    const arrived = transitionMission(mission(), "arrive", now + 1000)
    expect(transitionMission(arrived, "extend", now + 2000).timerEndsAt).toBe(
      now + 901_000
    )
    // Past the end, the extra five minutes count from now.
    expect(
      transitionMission(arrived, "extend", now + 700_000).timerEndsAt
    ).toBe(now + 1_000_000)
    const complete = transitionMission(arrived, "complete", now + 2000)
    expect(() => transitionMission(complete, "extend", now + 3000)).toThrow(
      "mission_finished"
    )
  })

  it("accepts only the five owner actions", () => {
    expect(parseMissionAction({ action: "arrive" })).toBe("arrive")
    expect(parseMissionAction({ action: "complete" })).toBe("complete")
    expect(parseMissionAction({ action: "fail" })).toBe("fail")
    expect(parseMissionAction({ action: "deny" })).toBe("deny")
    expect(parseMissionAction({ action: "extend" })).toBe("extend")
    expect(parseMissionAction({ action: "cancel" })).toBe("cancel")
    expect(() => parseMissionAction({ action: "skip" })).toThrow(
      "invalid_mission_action"
    )
  })
})
