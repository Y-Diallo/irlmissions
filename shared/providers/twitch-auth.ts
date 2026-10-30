import {
  AuthError,
  InvalidTwitchTokenError,
  type TwitchAuthProvider,
  type TwitchConfig,
} from "../auth/twitch"

export function createTwitchAuthProvider(
  config: TwitchConfig,
  request: typeof fetch = fetch
): TwitchAuthProvider {
  async function call(path: string, init?: RequestInit) {
    try {
      return await request(`https://id.twitch.tv/oauth2/${path}`, {
        ...init,
        cache: "no-store",
        signal: AbortSignal.timeout(10000),
      })
    } catch {
      throw new AuthError("provider", 503)
    }
  }
  async function json(response: Response): Promise<Record<string, unknown>> {
    try {
      const data = await response.json()
      if (!data || typeof data !== "object" || Array.isArray(data))
        throw new Error()
      return data
    } catch {
      throw new AuthError("provider", 503)
    }
  }
  async function token(params: Record<string, string>, refreshing: boolean) {
    const response = await call("token", {
      method: "POST",
      body: new URLSearchParams({
        client_id: config.clientId,
        client_secret: config.clientSecret,
        ...params,
      }),
    })
    if (refreshing && (response.status === 400 || response.status === 401))
      throw new AuthError("expired")
    if (!response.ok) throw new AuthError("provider", 503)
    const data = await json(response)
    if (
      typeof data.access_token !== "string" ||
      !data.access_token ||
      typeof data.refresh_token !== "string" ||
      !data.refresh_token ||
      data.token_type !== "bearer" ||
      typeof data.expires_in !== "number" ||
      !Number.isFinite(data.expires_in) ||
      data.expires_in <= 0
    )
      throw new AuthError("provider", 503)
    return {
      accessToken: data.access_token,
      refreshToken: data.refresh_token,
      expiresIn: data.expires_in,
    }
  }
  return {
    exchange: (code) =>
      token(
        {
          code,
          grant_type: "authorization_code",
          redirect_uri: config.redirectUri,
        },
        false
      ),
    refresh: (refreshToken) =>
      token({ refresh_token: refreshToken, grant_type: "refresh_token" }, true),
    async validate(accessToken) {
      const response = await call("validate", {
        headers: { Authorization: `OAuth ${accessToken}` },
      })
      if (response.status === 401) throw new InvalidTwitchTokenError()
      if (!response.ok) throw new AuthError("provider", 503)
      const data = await json(response)
      if (
        typeof data.user_id !== "string" ||
        typeof data.client_id !== "string" ||
        typeof data.login !== "string" ||
        !Array.isArray(data.scopes) ||
        !data.scopes.every((value) => typeof value === "string") ||
        typeof data.expires_in !== "number" ||
        !Number.isFinite(data.expires_in) ||
        data.expires_in < 0
      )
        throw new AuthError("provider", 503)
      return {
        userId: data.user_id,
        clientId: data.client_id,
        login: data.login,
        scopes: data.scopes as string[],
        expiresIn: data.expires_in,
      }
    },
    async revoke(accessToken) {
      const response = await call("revoke", {
        method: "POST",
        body: new URLSearchParams({
          client_id: config.clientId,
          token: accessToken,
        }),
      })
      if (!response.ok) throw new AuthError("provider", 503)
    },
  }
}
