import {
  RedemptionProviderError,
  type RedemptionProvider,
  type TwitchRedemptionStatus,
} from "@/shared/redemptions"

type TwitchRedemptionProviderConfig = {
  broadcasterId: string
  clientId: string
  getAccessToken(forceRefresh?: boolean): Promise<string>
}

function object(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null
}

function status(value: unknown): TwitchRedemptionStatus | null {
  return value === "UNFULFILLED" ||
    value === "FULFILLED" ||
    value === "CANCELED"
    ? value
    : null
}

export function createTwitchRedemptionProvider(
  config: TwitchRedemptionProviderConfig,
  request: typeof fetch = fetch
): RedemptionProvider {
  async function call(
    method: "GET" | "PATCH",
    input: { redemptionId: string; rewardId: string; status?: string }
  ) {
    for (let attempt = 0; attempt < 2; attempt += 1) {
      let accessToken: string
      try {
        accessToken = await config.getAccessToken(attempt === 1)
      } catch {
        throw new RedemptionProviderError("twitch_redemption_auth", true)
      }
      let response: Response
      try {
        const url = new URL(
          "https://api.twitch.tv/helix/channel_points/custom_rewards/redemptions"
        )
        url.search = new URLSearchParams({
          broadcaster_id: config.broadcasterId,
          reward_id: input.rewardId,
          id: input.redemptionId,
        }).toString()
        response = await request(url, {
          method,
          headers: {
            Authorization: `Bearer ${accessToken}`,
            "Client-Id": config.clientId,
            ...(method === "PATCH"
              ? { "Content-Type": "application/json" }
              : {}),
          },
          ...(method === "PATCH"
            ? { body: JSON.stringify({ status: input.status }) }
            : {}),
          cache: "no-store",
          signal: AbortSignal.timeout(10_000),
        })
      } catch {
        throw new RedemptionProviderError(
          "twitch_redemption_request",
          true,
          method === "PATCH"
        )
      }
      if (response.status === 401 && attempt === 0) continue
      if (response.status === 401) {
        throw new RedemptionProviderError("twitch_redemption_auth", false)
      }
      if ([400, 403].includes(response.status)) {
        throw new RedemptionProviderError("twitch_redemption_rejected", false)
      }
      if (response.status === 404) {
        if (method === "GET") return []
        throw new RedemptionProviderError(
          "twitch_redemption_not_found",
          false,
          true
        )
      }
      if (!response.ok) {
        throw new RedemptionProviderError(
          "twitch_redemption_provider",
          true,
          method === "PATCH"
        )
      }
      try {
        const payload = object(await response.json())
        if (!payload || !Array.isArray(payload.data)) throw new Error()
        return payload.data
      } catch {
        throw new RedemptionProviderError(
          "twitch_redemption_response",
          true,
          method === "PATCH"
        )
      }
    }
    throw new RedemptionProviderError("twitch_redemption_auth", false)
  }

  function exact(
    data: unknown[],
    input: { redemptionId: string; rewardId: string }
  ) {
    if (data.length !== 1) return null
    const redemption = object(data[0])
    const reward = object(redemption?.reward)
    if (
      !redemption ||
      redemption.id !== input.redemptionId ||
      redemption.broadcaster_id !== config.broadcasterId ||
      !reward ||
      reward.id !== input.rewardId
    ) {
      throw new RedemptionProviderError("twitch_redemption_response", true)
    }
    const parsed = status(redemption.status)
    if (!parsed) {
      throw new RedemptionProviderError("twitch_redemption_response", true)
    }
    return parsed
  }

  return {
    async get(input) {
      return exact(await call("GET", input), input)
    },
    async update(input) {
      let result: TwitchRedemptionStatus | null
      try {
        result = exact(await call("PATCH", input), input)
      } catch (error) {
        if (
          error instanceof RedemptionProviderError &&
          error.code === "twitch_redemption_response"
        ) {
          throw new RedemptionProviderError(error.code, true, true)
        }
        throw error
      }
      if (!result) {
        throw new RedemptionProviderError(
          "twitch_redemption_response",
          true,
          true
        )
      }
      return result
    },
  }
}
