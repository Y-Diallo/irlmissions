import { describe, expect, it, vi } from "vitest"
import {
  AuthError,
  authorizationUrl,
  completeTwitchLogin,
  createOAuthState,
  exchangeHandoff,
  getTwitchAccessToken,
  hashHandoff,
  InvalidTwitchTokenError,
  readTwitchConfig,
  verifyOAuthState,
} from "@/shared/auth/twitch"
import { authenticateOwner } from "@/shared/auth/owner"
import { demoEnv } from "./fixtures"
import { authFixture, clock, liveEnv, twitchConfig } from "./auth-fixtures"

describe("OAuth configuration and state", () => {
  it("rejects live OAuth in emulator mode", () => {
    expect(() => readTwitchConfig(demoEnv)).toThrow("disabled")
  })
  it.each([
    { TWITCH_CLIENT_SECRET: "" },
    { TWITCH_REDIRECT_URI: "http://public.example/api/auth/twitch/callback" },
    { TWITCH_REDIRECT_URI: "https://producer.example/wrong-path" },
    {
      TWITCH_REDIRECT_URI:
        "https://producer.example/api/auth/twitch/callback?next=elsewhere",
    },
  ])("rejects invalid configuration %j", (changes) => {
    expect(() => readTwitchConfig({ ...liveEnv, ...changes })).toThrow()
  })
  it("builds a code-grant URL with signed state and the configured callback", () => {
    const config = readTwitchConfig(liveEnv)
    const state = createOAuthState(config.clientSecret, clock)
    expect(() =>
      verifyOAuthState(state, state, config.clientSecret, clock)
    ).not.toThrow()
    const url = new URL(authorizationUrl(config, state))
    expect(url.origin).toBe("https://id.twitch.tv")
    expect(url.searchParams.get("response_type")).toBe("code")
    expect(url.searchParams.get("redirect_uri")).toBe(config.redirectUri)
    expect(url.searchParams.has("client_secret")).toBe(false)
  })
  it.each(["missing", "mismatch", "expired", "tampered", "future"])(
    "rejects %s state before provider/storage access",
    async (reason) => {
      const fixture = authFixture()
      const state = createOAuthState(
        twitchConfig.clientSecret,
        reason === "future" ? clock + 1000 : clock
      )
      const cookie =
        reason === "missing"
          ? undefined
          : reason === "mismatch"
            ? "different"
            : reason === "tampered"
              ? state.replace(/.$/, state.endsWith("0") ? "1" : "0")
              : state
      const queryState = reason === "tampered" ? cookie! : state
      const load = vi.fn(async () => fixture.deps)
      await expect(
        completeTwitchLogin(
          twitchConfig,
          { code: "code", state: queryState, error: null },
          cookie,
          load,
          reason === "expired" ? clock + 601000 : clock
        )
      ).rejects.toThrow("state")
      expect(load).not.toHaveBeenCalled()
    }
  )
})

describe("tenant Twitch grant and Firebase bridge", () => {
  it("stores credentials privately and exchanges a single-use handoff for Firebase", async () => {
    const { deps, store, mintToken } = authFixture()
    const state = createOAuthState(twitchConfig.clientSecret, clock)
    const handoff = await completeTwitchLogin(
      twitchConfig,
      { code: "authorization-code", state, error: null },
      state,
      async () => deps,
      clock
    )
    expect(handoff).not.toContain("test-access")
    expect(store.saveTokens).toHaveBeenCalledOnce()
    expect(store.saveHandoff).toHaveBeenCalledWith(
      hashHandoff(handoff),
      expect.objectContaining({ uid: "twitch:42" })
    )
    expect(mintToken).not.toHaveBeenCalled()
    await expect(exchangeHandoff(twitchConfig, handoff, deps)).resolves.toBe(
      "firebase-custom-token"
    )
    expect(mintToken).toHaveBeenCalledWith("twitch:42", {
      owner: true,
      twitchUserId: "42",
    })
    await expect(exchangeHandoff(twitchConfig, handoff, deps)).rejects.toThrow(
      "expired"
    )
    expect(mintToken).toHaveBeenCalledOnce()
  })
  it.each(["clientId", "scopes"])(
    "rejects wrong %s without creating an owner session",
    async (field) => {
      const { deps, provider, store, mintToken } = authFixture()
      const identity = await provider.validate("test")
      provider.validate.mockResolvedValue({
        ...identity,
        ...(field === "scopes" ? { scopes: [] } : { [field]: "someone-else" }),
      })
      const state = createOAuthState(twitchConfig.clientSecret, clock)
      await expect(
        completeTwitchLogin(
          twitchConfig,
          { code: "code", state, error: null },
          state,
          async () => deps,
          clock
        )
      ).rejects.toBeInstanceOf(AuthError)
      expect(store.saveTokens).not.toHaveBeenCalled()
      expect(store.saveHandoff).not.toHaveBeenCalled()
      expect(mintToken).not.toHaveBeenCalled()
      expect(provider.revoke).toHaveBeenCalledWith("test-access")
    }
  )
  it("uses each validated Twitch user ID as an independent owner", async () => {
    const { deps, provider, store } = authFixture()
    provider.validate.mockResolvedValue({
      userId: "99",
      clientId: "test-client",
      login: "second-streamer",
      scopes: [
        "channel:manage:redemptions",
        "channel:manage:polls",
        "moderation:read",
      ],
      expiresIn: 3600,
    })
    const state = createOAuthState(twitchConfig.clientSecret, clock)
    const handoff = await completeTwitchLogin(
      twitchConfig,
      { code: "code", state, error: null },
      state,
      async () => deps,
      clock
    )
    expect(store.saveTokens).toHaveBeenCalledWith(
      expect.objectContaining({ userId: "99", login: "second-streamer" })
    )
    expect(store.saveHandoff).toHaveBeenCalledWith(
      hashHandoff(handoff),
      expect.objectContaining({ uid: "twitch:99" })
    )
  })
  it("handles user cancellation without contacting Twitch", async () => {
    const { deps, provider } = authFixture()
    const state = createOAuthState(twitchConfig.clientSecret, clock)
    await expect(
      completeTwitchLogin(
        twitchConfig,
        { code: null, state, error: "access_denied" },
        state,
        async () => deps,
        clock
      )
    ).rejects.toThrow("denied")
    expect(provider.exchange).not.toHaveBeenCalled()
  })
  it("rejects expired and replaced-connection handoffs", async () => {
    const { deps, handoffs, mintToken } = authFixture()
    const handoff = "A".repeat(43)
    handoffs.set(hashHandoff(handoff), {
      uid: "twitch:42",
      connectionId: "test-connection",
      expiresAt: clock - 1,
    })
    await expect(exchangeHandoff(twitchConfig, handoff, deps)).rejects.toThrow(
      "expired"
    )
    handoffs.set(hashHandoff(handoff), {
      uid: "twitch:42",
      connectionId: "old-connection",
      expiresAt: clock + 10000,
    })
    await expect(exchangeHandoff(twitchConfig, handoff, deps)).rejects.toThrow(
      "expired"
    )
    expect(mintToken).not.toHaveBeenCalled()
  })
})

describe("server-side Twitch refresh", () => {
  it("validates even an unexpired token to detect revocation", async () => {
    const { deps, provider } = authFixture()
    await expect(getTwitchAccessToken(twitchConfig, deps, "42")).resolves.toBe(
      "test-access"
    )
    expect(provider.validate).toHaveBeenCalledWith("test-access")
    expect(provider.refresh).not.toHaveBeenCalled()
  })
  it("refreshes after a 401 and persists the rotated refresh token", async () => {
    const { deps, provider, store } = authFixture()
    provider.validate.mockRejectedValueOnce(new InvalidTwitchTokenError())
    await expect(getTwitchAccessToken(twitchConfig, deps, "42")).resolves.toBe(
      "rotated-access"
    )
    expect(provider.refresh).toHaveBeenCalledWith("test-refresh")
    expect((await store.readTokens("42"))?.refreshToken).toBe("rotated-refresh")
    expect(provider.validate).toHaveBeenLastCalledWith("rotated-access")
  })
  it("preserves rotated credentials when validation temporarily fails", async () => {
    const { deps, provider, store, revokeSessions } = authFixture()
    provider.validate
      .mockRejectedValueOnce(new InvalidTwitchTokenError())
      .mockRejectedValueOnce(new AuthError("provider", 503))
    await expect(
      getTwitchAccessToken(twitchConfig, deps, "42")
    ).rejects.toThrow("provider")
    expect((await store.readTokens("42"))?.refreshToken).toBe("rotated-refresh")
    expect(revokeSessions).not.toHaveBeenCalled()
  })
  it("removes invalid credentials and revokes Firebase sessions when refresh is rejected", async () => {
    const { deps, provider, store, revokeSessions } = authFixture()
    provider.validate.mockRejectedValue(new InvalidTwitchTokenError())
    provider.refresh.mockRejectedValue(new AuthError("expired"))
    await expect(
      getTwitchAccessToken(twitchConfig, deps, "42")
    ).rejects.toThrow("expired")
    expect(store.deleteTokens).toHaveBeenCalledWith("42", "test-access")
    expect(revokeSessions).toHaveBeenCalledWith("twitch:42")
  })
  it("keeps credentials on a transient validation failure", async () => {
    const { deps, provider, store } = authFixture()
    provider.validate.mockRejectedValue(new AuthError("provider", 503))
    await expect(
      getTwitchAccessToken(twitchConfig, deps, "42")
    ).rejects.toThrow("provider")
    expect(store.deleteTokens).not.toHaveBeenCalled()
    expect(provider.refresh).not.toHaveBeenCalled()
  })
  it("does not refresh concurrently or overwrite a new login", async () => {
    const { deps, provider, store } = authFixture()
    provider.validate.mockRejectedValueOnce(new InvalidTwitchTokenError())
    store.claimRefresh.mockResolvedValueOnce(false)
    await expect(
      getTwitchAccessToken(twitchConfig, deps, "42")
    ).rejects.toThrow("busy")
    expect(provider.refresh).not.toHaveBeenCalled()
    store.finishRefresh.mockResolvedValueOnce(false)
    await expect(
      getTwitchAccessToken(twitchConfig, deps, "42", true)
    ).rejects.toThrow("busy")
    expect(store.deleteTokens).not.toHaveBeenCalled()
  })
})

describe("Firebase owner authorization", () => {
  it("preserves temporary verifier failures as retryable instead of signing out", async () => {
    await expect(
      authenticateOwner("Bearer id-token", { mode: "live" }, async () => {
        throw new AuthError("unavailable", 503)
      })
    ).rejects.toMatchObject({ status: 503 })
  })
  it("accepts a self-consistent verified Twitch tenant token", async () => {
    const verify = vi.fn(async () => ({
      uid: "twitch:42",
      owner: true,
      twitchUserId: "42",
      privateClaim: "not-returned",
    }))
    await expect(
      authenticateOwner("Bearer id-token", { mode: "live" }, verify)
    ).resolves.toEqual({
      uid: "twitch:42",
      mode: "live",
      tenantId: "42",
      twitchUserId: "42",
    })
    expect(verify).toHaveBeenCalledWith("id-token")
  })
  it("accepts only an explicitly claimed demo owner when deployed demo is enabled", async () => {
    await expect(
      authenticateOwner(
        "Bearer demo-token",
        { mode: "live", demoEnabled: true },
        async () => ({ uid: "demo-owner", owner: true, demo: true })
      )
    ).resolves.toEqual({
      uid: "demo-owner",
      mode: "demo",
      tenantId: "demo-owner",
    })
    await expect(
      authenticateOwner(
        "Bearer demo-token",
        { mode: "live", demoEnabled: false },
        async () => ({ uid: "demo-owner", owner: true, demo: true })
      )
    ).rejects.toThrow("owner")
  })
  it.each([
    { uid: "twitch:other", owner: true, twitchUserId: "42" },
    { uid: "twitch:42", owner: true, twitchUserId: "other" },
    { uid: "twitch:42", owner: false, twitchUserId: "42" },
    { uid: "demo-owner", owner: true },
  ])("rejects an unapproved identity %j", async (identity) => {
    await expect(
      authenticateOwner(
        "Bearer id-token",
        { mode: "live" },
        async () => identity
      )
    ).rejects.toThrow("owner")
  })
  it("rejects expired/revoked tokens and missing bearer credentials", async () => {
    const verify = vi.fn(async () => {
      throw new Error("revoked")
    })
    await expect(
      authenticateOwner("Bearer expired", { mode: "live" }, verify)
    ).rejects.toThrow("unauthorized")
    verify.mockClear()
    await expect(
      authenticateOwner(null, { mode: "emulator" }, verify)
    ).rejects.toThrow("unauthorized")
    expect(verify).not.toHaveBeenCalled()
  })
})
