import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { NextRequest } from "next/server"
import { GET as login } from "@/app/api/auth/twitch/login/route"
import { GET as callback } from "@/app/api/auth/twitch/callback/route"
import { POST as session } from "@/app/api/auth/session/route"
import { POST as logout } from "@/app/api/auth/logout/route"
import { createOAuthState } from "@/shared/auth/twitch"
import { authFixture, liveEnv, twitchConfig } from "./auth-fixtures"

const mockServer = vi.hoisted(() => ({ loadAuthDependencies: vi.fn() }))
vi.mock("@/lib/auth/server", () => mockServer)
beforeEach(() => {
  for (const [key, value] of Object.entries(liveEnv)) vi.stubEnv(key, value)
})
afterEach(() => {
  vi.unstubAllEnvs()
  vi.clearAllMocks()
})

describe("OAuth route transport", () => {
  it("redirects to Twitch with an expiring HttpOnly state cookie", async () => {
    const response = await login(
      new Request("https://producer.example/api/auth/twitch/login")
    )
    expect(response.status).toBe(303)
    const url = new URL(response.headers.get("location")!)
    const cookie = response.cookies.get("irl_oauth_state")!
    expect(url.origin).toBe("https://id.twitch.tv")
    expect(url.searchParams.get("state")).toBe(cookie.value)
    expect(cookie.httpOnly).toBe(true)
    expect(cookie.secure).toBe(true)
    expect(cookie.sameSite).toBe("lax")
    expect(cookie.maxAge).toBe(600)
    expect(response.headers.get("cache-control")).toBe("no-store")
    expect(mockServer.loadAuthDependencies).not.toHaveBeenCalled()
  })

  it("recognizes the public hostname forwarded by App Hosting", async () => {
    const response = await login(
      new Request("https://internal-cloud-run.example/api/auth/twitch/login", {
        headers: {
          host: "internal-cloud-run.example",
          "x-forwarded-host": "producer.example",
        },
      })
    )
    expect(response.status).toBe(303)
    expect(new URL(response.headers.get("location")!).origin).toBe(
      "https://id.twitch.tv"
    )
  })

  it("still rejects an unrelated public hostname", async () => {
    const response = await login(
      new Request("https://other.example/api/auth/twitch/login", {
        headers: { host: "other.example" },
      })
    )
    expect(response.status).toBe(400)
  })

  it("rejects an invalid state and clears old cookies before any SDK calls", async () => {
    const response = await callback(
      new NextRequest(
        "https://producer.example/api/auth/twitch/callback?code=code&state=bad"
      )
    )
    expect(response.status).toBe(303)
    expect(response.headers.get("location")).toBe(
      "https://producer.example/?auth_error=state"
    )
    expect(response.cookies.get("irl_oauth_state")?.maxAge).toBe(0)
    expect(mockServer.loadAuthDependencies).not.toHaveBeenCalled()
  })

  it("keeps Twitch and Firebase tokens out of callback URLs and cookies", async () => {
    const fixture = authFixture()
    mockServer.loadAuthDependencies.mockResolvedValue(fixture.deps)
    const state = createOAuthState(twitchConfig.clientSecret)
    const response = await callback(
      new NextRequest(
        `https://producer.example/api/auth/twitch/callback?code=test-code&state=${state}`,
        {
          headers: { cookie: `irl_oauth_state=${state}` },
        }
      )
    )
    expect(response.headers.get("location")).toBe(
      "https://producer.example/auth/complete"
    )
    const handoff = response.cookies.get("irl_auth_handoff")!
    expect(handoff.httpOnly).toBe(true)
    expect(handoff.path).toBe("/api/auth/session")
    expect(handoff.value).toMatch(/^[A-Za-z0-9_-]{43}$/)
    expect(response.headers.get("set-cookie")).not.toContain("test-access")
    expect(fixture.mintToken).not.toHaveBeenCalled()

    const exchanged = await session(
      new NextRequest("https://producer.example/api/auth/session", {
        method: "POST",
        headers: {
          origin: "https://producer.example",
          cookie: `irl_auth_handoff=${handoff.value}`,
        },
      })
    )
    expect(exchanged.status).toBe(200)
    expect(await exchanged.json()).toEqual({ token: "firebase-custom-token" })
    expect(exchanged.cookies.get("irl_auth_handoff")?.maxAge).toBe(0)
    expect(exchanged.headers.get("cache-control")).toBe("no-store")
  })

  it("rejects cross-origin handoff exchange", async () => {
    const response = await session(
      new NextRequest("https://producer.example/api/auth/session", {
        method: "POST",
        headers: { origin: "https://attacker.example" },
      })
    )
    expect(response.status).toBe(403)
    expect(mockServer.loadAuthDependencies).not.toHaveBeenCalled()
  })

  it("rejects missing handoff cookies before loading the Admin SDK", async () => {
    const response = await session(
      new NextRequest("https://producer.example/api/auth/session", {
        method: "POST",
        headers: { origin: "https://producer.example" },
      })
    )
    expect(response.status).toBe(401)
    expect(mockServer.loadAuthDependencies).not.toHaveBeenCalled()
  })

  it("clears local auth cookies on logout without disconnecting Twitch", async () => {
    const response = await logout(
      new Request("https://producer.example/api/auth/logout", {
        method: "POST",
        headers: { origin: "https://producer.example" },
      })
    )
    expect(response.status).toBe(204)
    expect(response.cookies.get("irl_oauth_state")?.maxAge).toBe(0)
    expect(response.cookies.get("irl_auth_handoff")?.maxAge).toBe(0)
    expect(mockServer.loadAuthDependencies).not.toHaveBeenCalled()
  })
})
