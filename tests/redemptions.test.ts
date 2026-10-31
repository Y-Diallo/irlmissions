import { describe, expect, it, vi } from "vitest"
import {
  processRedemption,
  RedemptionProviderError,
  type ClaimedRedemption,
  type RedemptionDependencies,
  type TwitchRedemptionStatus,
} from "@/shared/redemptions"

const now = Date.parse("2026-10-31T02:00:00Z")

function fixture(
  overrides: {
    claim?: Partial<ClaimedRedemption> | null
    statuses?: Array<TwitchRedemptionStatus | null>
    update?: () => Promise<TwitchRedemptionStatus>
  } = {}
) {
  const claim =
    overrides.claim === null
      ? null
      : {
          redemptionId: "redemption-1",
          rewardId: "reward-1",
          action: "refund" as const,
          attempt: 1,
          leaseId: "lease-1",
          ...overrides.claim,
        }
  const statuses = [...(overrides.statuses ?? ["UNFULFILLED"])]
  const store = {
    claim: vi.fn(async () => claim),
    complete: vi.fn(async () => true),
    fail: vi.fn(async () => true),
  }
  const provider = {
    get: vi.fn(async () => statuses.shift() ?? null),
    update: vi.fn(overrides.update ?? (async (input) => input.status)),
  }
  const deps: RedemptionDependencies = {
    store,
    provider,
    now: () => now,
    leaseId: () => "lease-1",
  }
  return { deps, store, provider }
}

describe("redemption resolution", () => {
  it("refunds an unfulfilled redemption and commits only after Twitch confirms", async () => {
    const { deps, store, provider } = fixture()
    await expect(processRedemption("redemption-1", deps)).resolves.toEqual({
      kind: "completed",
      action: "refund",
    })
    expect(provider.update).toHaveBeenCalledWith({
      redemptionId: "redemption-1",
      rewardId: "reward-1",
      status: "CANCELED",
    })
    expect(provider.update).toHaveBeenCalledBefore(store.complete)
  })

  it("fulfills attempted missions", async () => {
    const { deps, provider } = fixture({
      claim: { action: "fulfill" },
    })
    await processRedemption("redemption-1", deps)
    expect(provider.update).toHaveBeenCalledWith(
      expect.objectContaining({ status: "FULFILLED" })
    )
  })

  it("accepts an already-correct terminal status without another PATCH", async () => {
    const { deps, store, provider } = fixture({ statuses: ["CANCELED"] })
    await expect(
      processRedemption("redemption-1", deps)
    ).resolves.toMatchObject({ kind: "completed" })
    expect(provider.update).not.toHaveBeenCalled()
    expect(store.complete).toHaveBeenCalledOnce()
  })

  it("reconciles an ambiguous PATCH before recording a failure", async () => {
    const { deps, store, provider } = fixture({
      statuses: ["UNFULFILLED", "CANCELED"],
      update: async () => {
        throw new RedemptionProviderError("timeout", true, true)
      },
    })
    await expect(
      processRedemption("redemption-1", deps)
    ).resolves.toMatchObject({ kind: "completed" })
    expect(provider.get).toHaveBeenCalledTimes(2)
    expect(store.fail).not.toHaveBeenCalled()
  })

  it("backs off retryable failures and stops automatic retries after five attempts", async () => {
    const first = fixture({
      update: async () => {
        throw new RedemptionProviderError("provider", true)
      },
    })
    await expect(
      processRedemption("redemption-1", first.deps)
    ).resolves.toEqual({
      kind: "retry",
      code: "provider",
      automaticRetryAt: now + 15_000,
    })
    expect(first.store.fail).toHaveBeenCalledWith(
      expect.objectContaining({ attempt: 1 }),
      expect.objectContaining({ automaticRetryAt: now + 15_000 })
    )

    const fifth = fixture({
      claim: { attempt: 5 },
      update: async () => {
        throw new RedemptionProviderError("provider", true)
      },
    })
    await expect(
      processRedemption("redemption-1", fifth.deps)
    ).resolves.toEqual({ kind: "error", code: "provider" })
    expect(fifth.store.fail).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ automaticRetryAt: null })
    )
  })

  it("never overwrites the opposite terminal status", async () => {
    const { deps, store, provider } = fixture({ statuses: ["FULFILLED"] })
    await expect(processRedemption("redemption-1", deps)).resolves.toEqual({
      kind: "error",
      code: "twitch_redemption_status_conflict",
    })
    expect(provider.update).not.toHaveBeenCalled()
    expect(store.fail).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ automaticRetryAt: null })
    )
  })

  it("does nothing when another worker owns the resolution", async () => {
    const { deps, provider } = fixture({ claim: null })
    await expect(processRedemption("redemption-1", deps)).resolves.toEqual({
      kind: "not_claimed",
    })
    expect(provider.get).not.toHaveBeenCalled()
  })
})
