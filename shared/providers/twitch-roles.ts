type TwitchRolesConfig = {
  broadcasterId: string
  clientId: string
  getAccessToken(forceRefresh?: boolean): Promise<string>
}

// Each role needs its own scope. A missing scope (401/403) means that role
// can't be confirmed, so the viewer is simply not trusted through it.
const ROLE_ENDPOINTS = [
  "https://api.twitch.tv/helix/moderation/moderators",
  "https://api.twitch.tv/helix/channels/vips",
  "https://api.twitch.tv/helix/subscriptions",
]

export function createTwitchRolesProvider(
  config: TwitchRolesConfig,
  request: typeof fetch = fetch
) {
  async function hasRole(endpoint: string, userId: string) {
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const url = new URL(endpoint)
      url.search = new URLSearchParams({
        broadcaster_id: config.broadcasterId,
        user_id: userId,
      }).toString()
      const response = await request(url, {
        headers: {
          Authorization: `Bearer ${await config.getAccessToken(attempt === 1)}`,
          "Client-Id": config.clientId,
        },
        cache: "no-store",
        signal: AbortSignal.timeout(10000),
      })
      if (response.status === 401 && attempt === 0) continue
      if (response.status === 401 || response.status === 403) return false
      if (!response.ok) throw new Error("Twitch role lookup failed")
      const payload = (await response.json()) as { data?: unknown }
      return Array.isArray(payload.data) && payload.data.length > 0
    }
    return false
  }

  return {
    /** Sub, VIP, mod, or the broadcaster. */
    async isTrusted(userId: string) {
      if (userId === config.broadcasterId) return true
      for (const endpoint of ROLE_ENDPOINTS) {
        if (await hasRole(endpoint, userId)) return true
      }
      return false
    },
  }
}
