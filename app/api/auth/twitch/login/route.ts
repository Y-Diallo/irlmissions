import { NextResponse } from "next/server"
import {
  authorizationUrl,
  createOAuthState,
  readTwitchConfig,
} from "@/shared/auth/twitch"
import {
  authFailure,
  cookieOptions,
  NO_STORE,
  STATE_COOKIE,
} from "@/lib/auth/http"

export const runtime = "nodejs"

function normalizedHost(value: string) {
  try {
    return new URL(`https://${value.trim()}`).host.toLowerCase()
  } catch {
    return ""
  }
}

function requestHosts(request: Request) {
  const forwarded = (request.headers.get("x-forwarded-host") ?? "")
    .split(",")
    .map(normalizedHost)
  return new Set(
    [
      ...forwarded,
      normalizedHost(request.headers.get("host") ?? ""),
      new URL(request.url).host.toLowerCase(),
    ].filter(Boolean)
  )
}

export async function GET(request: Request) {
  try {
    const config = readTwitchConfig(process.env)
    const redirectHost = new URL(config.redirectUri).host.toLowerCase()
    if (!requestHosts(request).has(redirectHost)) {
      return NextResponse.json(
        {
          error: "Open sign-in using the configured Twitch redirect hostname.",
        },
        { status: 400, headers: NO_STORE }
      )
    }
    const state = createOAuthState(config.clientSecret)
    const response = NextResponse.redirect(authorizationUrl(config, state), {
      status: 303,
      headers: NO_STORE,
    })
    response.cookies.set(STATE_COOKIE, state, cookieOptions(config.redirectUri))
    return response
  } catch (error) {
    return authFailure(error)
  }
}
