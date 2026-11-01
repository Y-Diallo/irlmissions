import { describe, expect, it } from "vitest"
import {
  attachTwitchPoll,
  matchesPollAttempt,
  parseStartPollCommand,
  PollError,
  preparePollRecord,
  leadingIndexes,
  resolvePollEnd,
  resolveTie,
  type PollPitch,
  type TwitchPoll,
} from "@/shared/polls"

const now = Date.parse("2026-10-30T22:00:00Z")
const command = {
  redemptionIds: ["redemption-1", "redemption-2"],
  durationSeconds: 60,
}
const pitches: PollPitch[] = [
  {
    redemptionId: "redemption-1",
    reviewStatus: "approved",
    publicLabel: "Mystery food challenge",
  },
  {
    redemptionId: "redemption-2",
    reviewStatus: "approved",
    publicLabel: "Find something blue",
  },
]

function twitchPoll(overrides: Partial<TwitchPoll> = {}): TwitchPoll {
  return {
    id: "poll-1",
    broadcasterId: "42",
    title: "What should we do next?",
    status: "ACTIVE",
    durationSeconds: 60,
    startedAt: now + 1000,
    choices: [
      { id: "choice-1", title: "Mystery food challenge", votes: 0 },
      { id: "choice-2", title: "Find something blue", votes: 0 },
    ],
    ...overrides,
  }
}

describe("poll state", () => {
  it("accepts only 2–5 unique pitches and Twitch's duration range", () => {
    expect(parseStartPollCommand({ redemptionIds: ["a", "b"] })).toEqual({
      redemptionIds: ["a", "b"],
      durationSeconds: 60,
    })
    expect(() =>
      parseStartPollCommand({ redemptionIds: ["a"], durationSeconds: 60 })
    ).toThrow("invalid_pitch_ids")
    expect(() =>
      parseStartPollCommand({
        redemptionIds: ["a", "a"],
        durationSeconds: 60,
      })
    ).toThrow("invalid_pitch_ids")
    expect(() =>
      parseStartPollCommand({ redemptionIds: ["a", "b"], durationSeconds: 14 })
    ).toThrow("invalid_poll_duration")
  })

  it("builds choices in shortlist order and assigns one lock", () => {
    const record = preparePollRecord(
      [pitches[1]!, pitches[0]!],
      command,
      "attempt-1",
      now
    )
    expect(record).toMatchObject({
      attemptId: "attempt-1",
      lockId: "poll:attempt-1",
      status: "creating",
      choices: [
        { redemptionId: "redemption-1", title: "Mystery food challenge" },
        { redemptionId: "redemption-2", title: "Find something blue" },
      ],
    })
  })

  it("rejects unapproved, locked, long, and duplicate public choices", () => {
    const invalid = [
      [{ ...pitches[0]!, reviewStatus: "pending_review" }, pitches[1]!],
      [{ ...pitches[0]!, lockedBy: "poll:old" }, pitches[1]!],
      [{ ...pitches[0]!, publicLabel: "x".repeat(26) }, pitches[1]!],
      [pitches[0]!, { ...pitches[1]!, publicLabel: "MYSTERY FOOD CHALLENGE" }],
    ]
    const expected = [
      "pitch_not_approved",
      "pitch_locked",
      "invalid_poll_label",
      "duplicate_poll_labels",
    ]
    invalid.forEach((records, index) => {
      expect(() =>
        preparePollRecord(records, command, "attempt-1", now)
      ).toThrow(expected[index])
    })
  })

  it("attaches only the exact Twitch poll and preserves choice identity", () => {
    const record = preparePollRecord(pitches, command, "attempt-1", now)
    expect(matchesPollAttempt(record, twitchPoll())).toBe(true)
    expect(
      matchesPollAttempt(
        record,
        twitchPoll({
          choices: [...twitchPoll().choices].reverse(),
        })
      )
    ).toBe(false)
    expect(attachTwitchPoll(record, twitchPoll(), now + 2000)).toMatchObject({
      status: "active",
      twitchPollId: "poll-1",
      choices: [
        { redemptionId: "redemption-1", twitchChoiceId: "choice-1" },
        { redemptionId: "redemption-2", twitchChoiceId: "choice-2" },
      ],
    })
  })

  it("uses stable error status codes", () => {
    expect(new PollError("pitch_locked").status).toBe(409)
  })

  it("selects the single highest vote winner", () => {
    const active = attachTwitchPoll(
      preparePollRecord(pitches, command, "attempt-1", now),
      twitchPoll(),
      now + 1000
    )
    const resolution = resolvePollEnd(
      active,
      {
        pollId: "poll-1",
        status: "completed",
        endedAt: now + 61_000,
        choices: [
          { id: "choice-1", title: "Mystery food challenge", votes: 3 },
          { id: "choice-2", title: "Find something blue", votes: 4 },
        ],
      },
      now + 62_000
    )
    expect(resolution.winnerRedemptionId).toBe("redemption-2")
    expect(resolution.loserRedemptionIds).toEqual(["redemption-1"])
    expect(resolution.poll).toMatchObject({
      status: "completed",
      winnerRedemptionId: "redemption-2",
    })
  })

  it("holds a tie for the owner to pick, then resolves the pick", () => {
    const active = attachTwitchPoll(
      preparePollRecord(pitches, command, "attempt-1", now),
      twitchPoll(),
      now + 1000
    )
    const resolution = resolvePollEnd(
      active,
      {
        pollId: "poll-1",
        status: "completed",
        endedAt: now + 61_000,
        choices: [
          { id: "choice-1", title: "Mystery food challenge", votes: 4 },
          { id: "choice-2", title: "Find something blue", votes: 4 },
        ],
      },
      now + 62_000
    )
    expect(resolution.winnerRedemptionId).toBeNull()
    expect(resolution.tiedRedemptionIds).toEqual([
      "redemption-1",
      "redemption-2",
    ])
    expect(resolution.loserRedemptionIds).toEqual([])
    expect(resolution.poll.status).toBe("tie")

    expect(() =>
      resolveTie(resolution.poll, "not-tied", now + 63_000)
    ).toThrow("not_a_tied_choice")
    const picked = resolveTie(resolution.poll, "redemption-2", now + 63_000)
    expect(picked.winnerRedemptionId).toBe("redemption-2")
    expect(picked.loserRedemptionIds).toEqual(["redemption-1"])
    expect(picked.poll).toMatchObject({
      status: "completed",
      winnerRedemptionId: "redemption-2",
    })
    expect(picked.poll.tiedRedemptionIds).toBeUndefined()
    expect(() =>
      resolveTie(picked.poll, "redemption-1", now + 64_000)
    ).toThrow("poll_not_tied")
  })

  it("counts a poll the owner ended early", () => {
    const active = attachTwitchPoll(
      preparePollRecord(pitches, command, "attempt-1", now),
      twitchPoll(),
      now + 1000
    )
    const resolution = resolvePollEnd(
      active,
      {
        pollId: "poll-1",
        status: "terminated",
        endedAt: now + 20_000,
        choices: [
          { id: "choice-1", title: "Mystery food challenge", votes: 1 },
          { id: "choice-2", title: "Find something blue", votes: 2 },
        ],
      },
      now + 21_000
    )
    expect(resolution.winnerRedemptionId).toBe("redemption-2")
  })

  it("finds every leader, or none before the first vote", () => {
    expect(leadingIndexes([0, 0, 0])).toEqual([])
    expect(leadingIndexes([1, 3, 2])).toEqual([1])
    expect(leadingIndexes([2, 0, 2])).toEqual([0, 2])
  })

  it("returns every choice to the queue for zero votes or cancellation", () => {
    const active = attachTwitchPoll(
      preparePollRecord(pitches, command, "attempt-1", now),
      twitchPoll(),
      now + 1000
    )
    for (const status of ["completed", "archived"] as const) {
      const resolution = resolvePollEnd(
        active,
        {
          pollId: "poll-1",
          status,
          endedAt: now + 61_000,
          choices:
            status === "completed"
              ? twitchPoll().choices
              : twitchPoll().choices.map((choice, index) => ({
                  ...choice,
                  votes: index + 1,
                })),
        },
        now + 62_000
      )
      expect(resolution.winnerRedemptionId).toBeNull()
      expect(resolution.loserRedemptionIds).toEqual(command.redemptionIds)
      expect(resolution.poll.status).toBe("canceled")
    }
  })

  it("ignores old poll IDs and rejects changed Twitch choices", () => {
    const active = attachTwitchPoll(
      preparePollRecord(pitches, command, "attempt-1", now),
      twitchPoll(),
      now + 1000
    )
    const event = {
      pollId: "old-poll",
      status: "completed" as const,
      endedAt: now + 61_000,
      choices: twitchPoll().choices,
    }
    expect(() => resolvePollEnd(active, event, now + 62_000)).toThrow(
      "poll_event_stale"
    )
    expect(() =>
      resolvePollEnd(
        active,
        {
          ...event,
          pollId: "poll-1",
          choices: [...event.choices].reverse(),
        },
        now + 62_000
      )
    ).toThrow("poll_event_mismatch")
  })
})
