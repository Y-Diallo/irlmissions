import { describe, expect, it, vi } from "vitest"
import { createTwitchAuthProvider } from "@/shared/providers/twitch-auth"
import { InvalidTwitchTokenError } from "@/shared/auth/twitch"
import { twitchConfig } from "./auth-fixtures"

describe("Twitch OAuth HTTP adapter", () => {
  it("puts the secret and encoded refresh token in the POST body", async () => {
    const request = vi
      .fn<typeof fetch>()
      .mockResolvedValue(
        Response.json({
          access_token: "next",
          refresh_token: "rotated",
          expires_in: 3600,
          token_type: "bearer",
        })
      )
    const provider = createTwitchAuthProvider(twitchConfig, request)
    await provider.refresh("token%with+special&characters")
    const [url, init] = request.mock.calls[0]
    expect(url).toBe("https://id.twitch.tv/oauth2/token")
    expect(init?.method).toBe("POST")
    const body = init?.body as URLSearchParams
    expect(body.get("refresh_token")).toBe("token%with+special&characters")
    expect(body.get("client_secret")).toBe("test-secret")
    expect(body.get("grant_type")).toBe("refresh_token")
  })
  it("uses the exact registered callback for code exchange", async () => {
    const request = vi
      .fn<typeof fetch>()
      .mockResolvedValue(
        Response.json({
          access_token: "access",
          refresh_token: "refresh",
          expires_in: 3600,
          token_type: "bearer",
        })
      )
    await createTwitchAuthProvider(twitchConfig, request).exchange("code")
    expect(
      (request.mock.calls[0][1]?.body as URLSearchParams).get("redirect_uri")
    ).toBe(twitchConfig.redirectUri)
  })
  it("distinguishes invalid credentials from provider outages", async () => {
    const request = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(new Response(null, { status: 401 }))
      .mockResolvedValueOnce(new Response(null, { status: 503 }))
    const provider = createTwitchAuthProvider(twitchConfig, request)
    await expect(provider.validate("invalid")).rejects.toBeInstanceOf(
      InvalidTwitchTokenError
    )
    await expect(
      provider.validate("temporarily-unavailable")
    ).rejects.toMatchObject({ code: "provider", status: 503 })
  })
  it("rejects malformed success payloads without exposing provider content", async () => {
    const request = vi
      .fn<typeof fetch>()
      .mockResolvedValue(
        Response.json({ message: "sensitive-provider-content" })
      )
    await expect(
      createTwitchAuthProvider(twitchConfig, request).validate("access")
    ).rejects.toThrow("provider")
  })
})
