type Fetch = typeof fetch

export type TwitchAutoModConfig = {
  clientId: string
  broadcasterId: string
  getAccessToken(forceRefresh?: boolean): Promise<string>
}

export function createTwitchAutoModProvider(
  config: TwitchAutoModConfig,
  fetchImpl: Fetch = fetch
) {
  async function request(
    input: { messageId: string; text: string },
    forceRefresh = false
  ) {
    const accessToken = await config.getAccessToken(forceRefresh)
    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(), 10_000)
    try {
      return await fetchImpl(
        `https://api.twitch.tv/helix/moderation/enforcements/status?broadcaster_id=${encodeURIComponent(config.broadcasterId)}`,
        {
          method: "POST",
          headers: {
            Authorization: `Bearer ${accessToken}`,
            "Client-Id": config.clientId,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            data: [{ msg_id: input.messageId, msg_text: input.text }],
          }),
          signal: controller.signal,
        }
      )
    } finally {
      clearTimeout(timeout)
    }
  }

  return {
    async check(input: { messageId: string; text: string }) {
      let response = await request(input)
      if (response.status === 401) response = await request(input, true)
      if (!response.ok) throw new Error("Twitch AutoMod check failed")
      const payload = (await response.json()) as { data?: unknown }
      if (!Array.isArray(payload.data)) {
        throw new Error("Twitch AutoMod returned an invalid response")
      }
      const result = payload.data.find(
        (value): value is { msg_id: string; is_permitted: boolean } =>
          !!value &&
          typeof value === "object" &&
          (value as { msg_id?: unknown }).msg_id === input.messageId &&
          typeof (value as { is_permitted?: unknown }).is_permitted ===
            "boolean"
      )
      if (!result)
        throw new Error("Twitch AutoMod returned an invalid response")
      return result.is_permitted
    },
  }
}
