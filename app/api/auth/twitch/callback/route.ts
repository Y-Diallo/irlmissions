import { NextRequest, NextResponse } from "next/server"
import {
  AuthError,
  completeTwitchLogin,
  readTwitchConfig,
} from "@/shared/auth/twitch"
import {
  clearAuthCookies,
  cookieOptions,
  HANDOFF_COOKIE,
  NO_STORE,
  STATE_COOKIE,
  authFailure,
} from "@/lib/auth/http"

export const runtime = "nodejs"
export async function GET(request: NextRequest) {
  let config
  try {
    config = readTwitchConfig(process.env)
  } catch (error) {
    return authFailure(error)
  }
  const origin = new URL(config.redirectUri).origin
  try {
    const query = request.nextUrl.searchParams
    const handoff = await completeTwitchLogin(
      config,
      {
        code: query.get("code"),
        state: query.get("state"),
        error: query.get("error"),
      },
      request.cookies.get(STATE_COOKIE)?.value,
      async () => {
        const { loadAuthDependencies } = await import("@/lib/auth/server")
        return loadAuthDependencies(config)
      }
    )
    const response = clearAuthCookies(
      NextResponse.redirect(new URL("/auth/complete", origin), {
        status: 303,
        headers: NO_STORE,
      }),
      origin
    )
    response.cookies.set(HANDOFF_COOKIE, handoff, cookieOptions(origin, true))
    return response
  } catch (error) {
    const url = new URL("/", origin)
    url.searchParams.set(
      "auth_error",
      error instanceof AuthError ? error.code : "unavailable"
    )
    return clearAuthCookies(
      NextResponse.redirect(url, { status: 303, headers: NO_STORE }),
      origin
    )
  }
}
