import { NextResponse } from "next/server"
import { clearAuthCookies, NO_STORE, sameOrigin } from "@/lib/auth/http"

export async function POST(request: Request) {
  if (!sameOrigin(request))
    return NextResponse.json(
      { error: "origin" },
      { status: 403, headers: NO_STORE }
    )
  // Firebase browser signOut ends this browser's session. Keep the stream's
  // Twitch integration connected so signing out does not interrupt EventSub.
  return clearAuthCookies(
    new NextResponse(null, { status: 204, headers: NO_STORE }),
    request.url
  )
}
