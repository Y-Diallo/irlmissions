export class TwitchSetupError extends Error {
  constructor(public readonly code: string) {
    super(code)
  }
}

type Config = {
  broadcasterId: string
  clientId: string
  clientSecret: string
  callbackUrl: string
  eventSubSecret: string
  getUserAccessToken(forceRefresh?: boolean): Promise<string>
}

type Reward = { id: string; title: string }

const REWARD_TITLE = "Pitch the next mission"

function object(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null
}

async function data(response: Response) {
  const payload = object(await response.json().catch(() => null))
  if (!payload || !Array.isArray(payload.data)) {
    throw new TwitchSetupError("twitch_setup_response")
  }
  return payload.data
}

export function createTwitchSetupProvider(
  config: Config,
  request: typeof fetch = fetch
) {
  async function userCall(method: "GET" | "POST", url: URL, body?: object) {
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const token = await config.getUserAccessToken(attempt === 1)
      const response = await request(url, {
        method,
        headers: {
          Authorization: `Bearer ${token}`,
          "Client-Id": config.clientId,
          ...(body ? { "Content-Type": "application/json" } : {}),
        },
        ...(body ? { body: JSON.stringify(body) } : {}),
        cache: "no-store",
        signal: AbortSignal.timeout(10_000),
      }).catch(() => {
        throw new TwitchSetupError("twitch_setup_unavailable")
      })
      if (response.status === 401 && attempt === 0) continue
      if (!response.ok) throw new TwitchSetupError("twitch_reward_rejected")
      return data(response)
    }
    throw new TwitchSetupError("twitch_reward_auth")
  }

  async function ensureReward(storedRewardId?: string): Promise<Reward> {
    const url = new URL(
      "https://api.twitch.tv/helix/channel_points/custom_rewards"
    )
    url.searchParams.set("broadcaster_id", config.broadcasterId)
    url.searchParams.set("only_manageable_rewards", "true")
    const rewards = (await userCall("GET", url)).flatMap((value) => {
      const reward = object(value)
      return reward &&
        typeof reward.id === "string" &&
        typeof reward.title === "string"
        ? [{ id: reward.id, title: reward.title }]
        : []
    })
    const stored = rewards.find((reward) => reward.id === storedRewardId)
    if (stored) return stored
    const matching = rewards.filter((reward) => reward.title === REWARD_TITLE)
    if (matching.length === 1) return matching[0]!
    if (matching.length > 1)
      throw new TwitchSetupError("duplicate_twitch_rewards")
    const createUrl = new URL(
      "https://api.twitch.tv/helix/channel_points/custom_rewards"
    )
    createUrl.searchParams.set("broadcaster_id", config.broadcasterId)
    const created = await userCall("POST", createUrl, {
      title: REWARD_TITLE,
      prompt: "Pitch a safe objective at a nearby public place",
      cost: 10,
      is_enabled: false,
      is_user_input_required: true,
      should_redemptions_skip_request_queue: false,
    })
    const reward = object(created[0])
    if (
      created.length !== 1 ||
      !reward ||
      typeof reward.id !== "string" ||
      reward.title !== REWARD_TITLE
    ) {
      throw new TwitchSetupError("twitch_reward_response")
    }
    return { id: reward.id, title: reward.title }
  }

  async function appAccessToken() {
    const url = new URL("https://id.twitch.tv/oauth2/token")
    url.search = new URLSearchParams({
      client_id: config.clientId,
      client_secret: config.clientSecret,
      grant_type: "client_credentials",
    }).toString()
    const response = await request(url, {
      method: "POST",
      cache: "no-store",
      signal: AbortSignal.timeout(10_000),
    }).catch(() => {
      throw new TwitchSetupError("twitch_app_auth_unavailable")
    })
    const payload = object(await response.json().catch(() => null))
    if (!response.ok || typeof payload?.access_token !== "string") {
      throw new TwitchSetupError("twitch_app_auth")
    }
    return payload.access_token
  }

  async function ensureSubscriptions(rewardId: string) {
    const token = await appAccessToken()
    const headers = {
      Authorization: `Bearer ${token}`,
      "Client-Id": config.clientId,
      "Content-Type": "application/json",
    }
    const listResponse = await request(
      "https://api.twitch.tv/helix/eventsub/subscriptions?first=100",
      { headers, cache: "no-store", signal: AbortSignal.timeout(10_000) }
    ).catch(() => {
      throw new TwitchSetupError("twitch_eventsub_unavailable")
    })
    if (!listResponse.ok)
      throw new TwitchSetupError("twitch_eventsub_rejected")
    const existing = await data(listResponse)
    const desired = [
      {
        type: "channel.channel_points_custom_reward_redemption.add",
        version: "1",
        condition: {
          broadcaster_user_id: config.broadcasterId,
          reward_id: rewardId,
        },
      },
      {
        type: "channel.poll.end",
        version: "1",
        condition: { broadcaster_user_id: config.broadcasterId },
      },
      {
        type: "channel.poll.progress",
        version: "1",
        condition: { broadcaster_user_id: config.broadcasterId },
      },
    ]
    for (const subscription of desired) {
      const found = existing.some((value) => {
        const item = object(value)
        const condition = object(item?.condition)
        return (
          item?.type === subscription.type &&
          item.version === subscription.version &&
          item.status === "enabled" &&
          condition?.broadcaster_user_id === config.broadcasterId &&
          (subscription.type !==
            "channel.channel_points_custom_reward_redemption.add" ||
            condition.reward_id === rewardId)
        )
      })
      if (found) continue
      const response = await request(
        "https://api.twitch.tv/helix/eventsub/subscriptions",
        {
          method: "POST",
          headers,
          body: JSON.stringify({
            ...subscription,
            transport: {
              method: "webhook",
              callback: config.callbackUrl,
              secret: config.eventSubSecret,
            },
          }),
          cache: "no-store",
          signal: AbortSignal.timeout(10_000),
        }
      ).catch(() => {
        throw new TwitchSetupError("twitch_eventsub_unavailable")
      })
      if (response.status !== 202 && response.status !== 409) {
        throw new TwitchSetupError("twitch_eventsub_rejected")
      }
    }
  }

  return {
    async provision(
      storedRewardId?: string,
      persistReward?: (reward: Reward) => Promise<void>
    ) {
      const reward = await ensureReward(storedRewardId)
      // Twitch may challenge the callback as soon as subscription creation
      // starts. Persist the tenant/reward routing key before that can happen.
      await persistReward?.(reward)
      await ensureSubscriptions(reward.id)
      return reward
    },
    async setRewardEnabled(rewardId: string, enabled: boolean) {
      const url = new URL(
        "https://api.twitch.tv/helix/channel_points/custom_rewards"
      )
      url.searchParams.set("broadcaster_id", config.broadcasterId)
      url.searchParams.set("id", rewardId)
      for (let attempt = 0; attempt < 2; attempt += 1) {
        const token = await config.getUserAccessToken(attempt === 1)
        const response = await request(url, {
          method: "PATCH",
          headers: {
            Authorization: `Bearer ${token}`,
            "Client-Id": config.clientId,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({ is_enabled: enabled }),
          cache: "no-store",
          signal: AbortSignal.timeout(10_000),
        }).catch(() => {
          throw new TwitchSetupError("twitch_reward_unavailable")
        })
        if (response.status === 401 && attempt === 0) continue
        if (!response.ok) throw new TwitchSetupError("twitch_reward_rejected")
        return
      }
      throw new TwitchSetupError("twitch_reward_auth")
    },
  }
}
