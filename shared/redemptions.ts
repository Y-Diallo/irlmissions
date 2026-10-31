import { randomBytes } from "node:crypto"

export type RedemptionAction = "refund" | "fulfill"
export type TwitchRedemptionStatus = "UNFULFILLED" | "FULFILLED" | "CANCELED"

export type RedemptionResolution = {
  action: RedemptionAction
  status: "pending" | "processing" | "error" | "complete"
  attempts: number
  nextAttemptAt?: number
  automaticRetryAt?: number | null
  leaseId?: string
  claimedAt?: number
  claimedUntil?: number
  errorCode?: string
  completedAt?: number
}

export type ClaimedRedemption = {
  redemptionId: string
  rewardId: string
  action: RedemptionAction
  attempt: number
  leaseId: string
}

export interface RedemptionStore {
  claim(
    redemptionId: string,
    leaseId: string,
    now: number,
    claimedUntil: number
  ): Promise<ClaimedRedemption | null>
  complete(claim: ClaimedRedemption, now: number): Promise<boolean>
  fail(
    claim: ClaimedRedemption,
    failure: {
      code: string
      automaticRetryAt: number | null
      failedAt: number
    }
  ): Promise<boolean>
}

export interface RedemptionProvider {
  get(input: {
    redemptionId: string
    rewardId: string
  }): Promise<TwitchRedemptionStatus | null>
  update(input: {
    redemptionId: string
    rewardId: string
    status: "FULFILLED" | "CANCELED"
  }): Promise<TwitchRedemptionStatus>
}

export class RedemptionProviderError extends Error {
  constructor(
    public readonly code: string,
    public readonly retryable: boolean,
    public readonly ambiguous = false
  ) {
    super(code)
  }
}

export type RedemptionDependencies = {
  store: RedemptionStore
  provider: RedemptionProvider
  now(): number
  leaseId(): string
}

const CLAIM_MS = 2 * 60 * 1000
const MAX_AUTOMATIC_ATTEMPTS = 5

export function desiredRedemptionStatus(action: RedemptionAction) {
  return action === "refund" ? "CANCELED" : "FULFILLED"
}

function retryAt(error: RedemptionProviderError, attempt: number, now: number) {
  if (!error.retryable || attempt >= MAX_AUTOMATIC_ATTEMPTS) return null
  return now + Math.min(15_000 * 2 ** (attempt - 1), 5 * 60_000)
}

async function currentStatus(
  provider: RedemptionProvider,
  claim: ClaimedRedemption
) {
  return provider.get({
    redemptionId: claim.redemptionId,
    rewardId: claim.rewardId,
  })
}

export async function processRedemption(
  redemptionId: string,
  deps: RedemptionDependencies
) {
  const now = deps.now()
  const claim = await deps.store.claim(
    redemptionId,
    deps.leaseId(),
    now,
    now + CLAIM_MS
  )
  if (!claim) return { kind: "not_claimed" as const }

  const desired = desiredRedemptionStatus(claim.action)
  try {
    const before = await currentStatus(deps.provider, claim)
    if (before === null) {
      throw new RedemptionProviderError("twitch_redemption_not_found", false)
    }
    if (before !== desired) {
      if (before !== "UNFULFILLED") {
        throw new RedemptionProviderError(
          "twitch_redemption_status_conflict",
          false
        )
      }
      try {
        const updated = await deps.provider.update({
          redemptionId: claim.redemptionId,
          rewardId: claim.rewardId,
          status: desired,
        })
        if (updated !== desired) {
          throw new RedemptionProviderError(
            "twitch_redemption_response",
            true,
            true
          )
        }
      } catch (error) {
        if (!(error instanceof RedemptionProviderError) || !error.ambiguous) {
          throw error
        }
        // A timed-out PATCH may have succeeded. Read Twitch before retrying so
        // a successful refund/fulfillment is never reported as failed locally.
        if ((await currentStatus(deps.provider, claim)) !== desired) throw error
      }
    }
    return (await deps.store.complete(claim, deps.now()))
      ? { kind: "completed" as const, action: claim.action }
      : { kind: "not_claimed" as const }
  } catch (error) {
    const failure =
      error instanceof RedemptionProviderError
        ? error
        : new RedemptionProviderError("twitch_redemption_provider", true)
    const failedAt = deps.now()
    const automaticRetryAt = retryAt(failure, claim.attempt, failedAt)
    await deps.store.fail(claim, {
      code: failure.code,
      automaticRetryAt,
      failedAt,
    })
    return automaticRetryAt === null
      ? { kind: "error" as const, code: failure.code }
      : {
          kind: "retry" as const,
          code: failure.code,
          automaticRetryAt,
        }
  }
}

export const newRedemptionLeaseId = () => randomBytes(24).toString("base64url")
