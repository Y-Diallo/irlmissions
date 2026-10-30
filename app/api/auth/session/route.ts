import { NextRequest, NextResponse } from "next/server"
import {
  AuthError,
  exchangeHandoff,
  readTwitchConfig,
} from "@/shared/auth/twitch"
import {
  authFailure,
  cookieOptions,
  HANDOFF_COOKIE,
  NO_STORE,
  sameOrigin,
} from "@/lib/auth/http"

export const runtime = "nodejs"
export async function POST(request: NextRequest) {
  try {
    const config = readTwitchConfig(process.env)
    if (!sameOrigin(request, new URL(config.redirectUri).origin))
      return NextResponse.json(
        { error: "origin" },
        { status: 403, headers: NO_STORE }
      )
    const handoff = request.cookies.get(HANDOFF_COOKIE)?.value
    if (!handoff || !/^[A-Za-z0-9_-]{43}$/.test(handoff))
      throw new AuthError("expired")
    const { loadAuthDependencies } = await import("@/lib/auth/server")
    const token = await exchangeHandoff(
      config,
      handoff,
      await loadAuthDependencies(config)
    )
    const response = NextResponse.json({ token }, { headers: NO_STORE })
    response.cookies.set(HANDOFF_COOKIE, "", {
      ...cookieOptions(config.redirectUri, true),
      maxAge: 0,
    })
    return response
  } catch (error) {
    const response = authFailure(error)
    response.cookies.set(HANDOFF_COOKIE, "", {
      ...cookieOptions(request.url, true),
      maxAge: 0,
    })
    return response
  }
}
