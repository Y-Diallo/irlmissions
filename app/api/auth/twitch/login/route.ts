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
export async function GET(request: Request) {
  try {
    const config = readTwitchConfig(process.env)
    const host = request.headers.get("host") ?? new URL(request.url).host
    if (host !== new URL(config.redirectUri).host) {
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
