import {
  PollProviderError,
  type PollProvider,
  type TwitchPoll,
} from "@/shared/polls"

type TwitchPollProviderConfig = {
  broadcasterId: string
  clientId: string
  getAccessToken(forceRefresh?: boolean): Promise<string>
}

function object(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null
}

function parsePoll(value: unknown, broadcasterId: string): TwitchPoll | null {
  const poll = object(value)
  if (!poll || poll.broadcaster_id !== broadcasterId) return null
  const startedAt =
    typeof poll.started_at === "string" ? Date.parse(poll.started_at) : NaN
  const endedAt =
    typeof poll.ended_at === "string" ? Date.parse(poll.ended_at) : NaN
  if (
    typeof poll.id !== "string" ||
    !poll.id ||
    typeof poll.title !== "string" ||
    typeof poll.status !== "string" ||
    !Number.isInteger(poll.duration) ||
    !Number.isFinite(startedAt) ||
    !Array.isArray(poll.choices)
  ) {
    return null
  }
  const choices = poll.choices.flatMap((value) => {
    const choice = object(value)
    return choice &&
      typeof choice.id === "string" &&
      choice.id &&
      typeof choice.title === "string" &&
      Number.isSafeInteger(choice.votes) &&
      (choice.votes as number) >= 0
      ? [
          {
            id: choice.id,
            title: choice.title,
            votes: choice.votes as number,
          },
        ]
      : []
  })
  if (choices.length !== poll.choices.length) return null
  return {
    id: poll.id,
    broadcasterId,
    title: poll.title,
    status: poll.status,
    durationSeconds: poll.duration as number,
    startedAt,
    ...(Number.isFinite(endedAt) ? { endedAt } : {}),
    choices,
  }
}

export function createTwitchPollProvider(
  config: TwitchPollProviderConfig,
  request: typeof fetch = fetch
): PollProvider {
  async function call(method: "GET" | "POST", body?: Record<string, unknown>) {
    for (let attempt = 0; attempt < 2; attempt += 1) {
      let accessToken: string
      try {
        accessToken = await config.getAccessToken(attempt === 1)
      } catch {
        // No Helix request was made, so creation is known not to have happened.
        throw new PollProviderError("twitch_poll_auth", false)
      }
      let response: Response
      try {
        const url = new URL("https://api.twitch.tv/helix/polls")
        if (method === "GET") {
          url.search = new URLSearchParams({
            broadcaster_id: config.broadcasterId,
            first: "20",
          }).toString()
        }
        response = await request(url, {
          method,
          headers: {
            Authorization: `Bearer ${accessToken}`,
            "Client-Id": config.clientId,
            ...(body ? { "Content-Type": "application/json" } : {}),
          },
          ...(body ? { body: JSON.stringify(body) } : {}),
          cache: "no-store",
          signal: AbortSignal.timeout(10000),
        })
      } catch {
        throw new PollProviderError(
          "twitch_poll_request_unknown",
          method === "POST"
        )
      }
      if (response.status === 401 && attempt === 0) continue
      if (response.status === 400 || response.status === 401) {
        throw new PollProviderError("twitch_poll_rejected", false, 409)
      }
      if (!response.ok) {
        throw new PollProviderError("twitch_poll_provider", method === "POST")
      }
      try {
        const payload = object(await response.json())
        if (!payload || !Array.isArray(payload.data)) throw new Error()
        return payload.data
      } catch {
        throw new PollProviderError(
          "twitch_poll_response_unknown",
          method === "POST"
        )
      }
    }
    throw new PollProviderError("twitch_poll_rejected", false, 409)
  }

  return {
    async create(input) {
      const data = await call("POST", {
        broadcaster_id: config.broadcasterId,
        title: input.title,
        choices: input.choices.map((title) => ({ title })),
        duration: input.durationSeconds,
        channel_points_voting_enabled: false,
      })
      const poll =
        data.length === 1 ? parsePoll(data[0], config.broadcasterId) : null
      if (!poll || poll.status !== "ACTIVE") {
        throw new PollProviderError("twitch_poll_response_unknown", true)
      }
      return poll
    },
    async listRecent() {
      const data = await call("GET")
      const polls = data.map((value) => parsePoll(value, config.broadcasterId))
      if (polls.some((poll) => poll === null)) {
        throw new PollProviderError("twitch_poll_provider", false)
      }
      return polls as TwitchPoll[]
    },
  }
}
