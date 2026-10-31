import { NextResponse } from "next/server"
import {
  OverlayAccessError,
  readOverlayAccessKey,
  requireOverlayAccess,
} from "@/shared/overlay-access"
import { readRealtimeIrlPullKey, RealtimeIrlError } from "@/shared/realtimeirl"

export const runtime = "nodejs"

const HEADERS = {
  "Cache-Control": "no-store",
  "Referrer-Policy": "no-referrer",
}

export async function GET(request: Request) {
  try {
    const overlayKey = readOverlayAccessKey(process.env)
    requireOverlayAccess(request.headers.get("authorization"), overlayKey)
    const pullKey = readRealtimeIrlPullKey(process.env)
    return NextResponse.json({ pullKey }, { headers: HEADERS })
  } catch (error) {
    if (
      error instanceof OverlayAccessError ||
      error instanceof RealtimeIrlError
    ) {
      return NextResponse.json(
        { error: error.code },
        { status: error.status, headers: HEADERS }
      )
    }
    return NextResponse.json(
      { error: "temporarily_unavailable" },
      { status: 503, headers: HEADERS }
    )
  }
}
