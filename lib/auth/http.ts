import { NextResponse } from "next/server"
import { AuthError, HANDOFF_SECONDS, STATE_SECONDS } from "@/shared/auth/twitch"

export const STATE_COOKIE = "irl_oauth_state"
export const HANDOFF_COOKIE = "irl_auth_handoff"
export const NO_STORE = {
  "Cache-Control": "no-store",
  "Referrer-Policy": "no-referrer",
}

export function cookieOptions(origin: string, handoff = false) {
  return {
    httpOnly: true,
    secure: new URL(origin).protocol === "https:",
    sameSite: "lax" as const,
    path: handoff ? "/api/auth/session" : "/api/auth/twitch",
    maxAge: handoff ? HANDOFF_SECONDS : STATE_SECONDS,
  }
}
export function clearAuthCookies(response: NextResponse, origin: string) {
  response.cookies.set(STATE_COOKIE, "", {
    ...cookieOptions(origin),
    maxAge: 0,
  })
  response.cookies.set(HANDOFF_COOKIE, "", {
    ...cookieOptions(origin, true),
    maxAge: 0,
  })
  return response
}
export function sameOrigin(request: Request, expected?: string) {
  const url = new URL(request.url)
  url.host = request.headers.get("host") ?? url.host
  return request.headers.get("origin") === (expected ?? url.origin)
}
export function authFailure(error: unknown) {
  const status = error instanceof AuthError ? error.status : 503
  return NextResponse.json(
    { error: error instanceof AuthError ? error.code : "unavailable" },
    { status, headers: NO_STORE }
  )
}
