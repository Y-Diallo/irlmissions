import { describe, expect, it, vi } from "vitest"
import {
  PollProviderError,
  preparePollRecord,
  type PollProvider,
  type PollRecord,
} from "@/shared/polls"
import {
  reconcilePoll,
  startPoll,
  type PollServiceDependencies,
} from "@/lib/polls/service"

const now = Date.parse("2026-10-30T22:00:00Z")
const command = {
  redemptionIds: ["redemption-1", "redemption-2"],
  durationSeconds: 60,
}
const record = preparePollRecord(
  [
    {
      redemptionId: "redemption-1",
      reviewStatus: "approved",
      publicLabel: "Mystery challenge",
    },
    {
      redemptionId: "redemption-2",
      reviewStatus: "approved",
      publicLabel: "Find something blue",
    },
  ],
  command,
  "attempt-1",
  now
)
const twitchPoll = {
  id: "poll-1",
  broadcasterId: "42",
  title: record.title,
  status: "ACTIVE",
  durationSeconds: 60,
  startedAt: now + 1000,
  choices: [
    { id: "choice-1", title: "Mystery challenge", votes: 0 },
    { id: "choice-2", title: "Find something blue", votes: 0 },
  ],
}

function fixture(overrides: Partial<PollProvider> = {}) {
  let current: PollRecord | null = record
  const store = {
    read: vi.fn(async () => current),
    reserve: vi.fn(async () => record),
    attach: vi.fn(
      async (_attempt: string, _poll: unknown, attachedAt: number) => {
        current = { ...record, status: "active", updatedAt: attachedAt }
        return current
      }
    ),
    markUnknown: vi.fn(
      async (_attempt: string, errorCode: string, at: number) => {
        current = {
          ...record,
          status: "create_unknown",
          errorCode,
          updatedAt: at,
        }
        return current
      }
    ),
    failAndUnlock: vi.fn(async () => null),
  }
  const provider = {
    create: vi.fn(
      (overrides.create ?? (async () => twitchPoll)) as PollProvider["create"]
    ),
    listRecent: vi.fn(
      (overrides.listRecent ?? (async () => [])) as PollProvider["listRecent"]
    ),
  }
  const deps = {
    store,
    provider,
    now: () => now + 2000,
    newAttemptId: () => "attempt-1",
  } as unknown as PollServiceDependencies
  return { deps, store, provider }
}

describe("poll creation service", () => {
  it("reserves before Twitch and attaches the created poll", async () => {
    const { deps, store, provider } = fixture()
    await expect(startPoll(command, deps)).resolves.toMatchObject({
      status: "active",
    })
    expect(store.reserve).toHaveBeenCalledBefore(provider.create)
    expect(store.attach).toHaveBeenCalledWith(
      "attempt-1",
      twitchPoll,
      now + 2000
    )
  })

  it("unlocks choices after a known Twitch rejection", async () => {
    const failure = new PollProviderError("twitch_poll_rejected", false, 409)
    const { deps, store } = fixture({
      create: vi.fn(async () => {
        throw failure
      }),
    })
    await expect(startPoll(command, deps)).rejects.toMatchObject({
      code: "twitch_poll_rejected",
    })
    expect(store.failAndUnlock).toHaveBeenCalledWith(
      "attempt-1",
      "twitch_poll_rejected",
      now + 2000
    )
  })

  it("queries Twitch after an ambiguous create and recovers an exact match", async () => {
    const { deps, store, provider } = fixture({
      create: vi.fn(async () => {
        throw new PollProviderError("timeout", true)
      }),
      listRecent: vi.fn(async () => [twitchPoll]),
    })
    await expect(startPoll(command, deps)).resolves.toMatchObject({
      status: "active",
    })
    expect(provider.create).toHaveBeenCalledOnce()
    expect(provider.listRecent).toHaveBeenCalledOnce()
    expect(store.markUnknown).not.toHaveBeenCalled()
  })

  it("records unknown creation and never issues a second create", async () => {
    const { deps, store, provider } = fixture({
      create: vi.fn(async () => {
        throw new PollProviderError("timeout", true)
      }),
    })
    await expect(startPoll(command, deps)).rejects.toMatchObject({
      code: "poll_creation_unknown",
    })
    expect(provider.create).toHaveBeenCalledOnce()
    expect(store.markUnknown).toHaveBeenCalledOnce()
  })

  it("reconciliation only reads Twitch and attaches a matching poll", async () => {
    const { deps, store, provider } = fixture({
      listRecent: vi.fn(async () => [twitchPoll]),
    })
    await expect(reconcilePoll(deps)).resolves.toMatchObject({
      reconciled: true,
    })
    expect(provider.create).not.toHaveBeenCalled()
    expect(provider.listRecent).toHaveBeenCalledOnce()
    expect(store.attach).toHaveBeenCalledOnce()
  })
})
