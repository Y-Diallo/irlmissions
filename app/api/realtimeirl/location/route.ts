import { NextResponse } from "next/server"
import {
  OverlayAccessError,
  readOverlayAccessKey,
  requireOverlayAccess,
} from "@/shared/overlay-access"
import { parseRealtimeIrlSample, RealtimeIrlError } from "@/shared/realtimeirl"

export const runtime = "nodejs"

const HEADERS = {
  "Cache-Control": "no-store",
  "Referrer-Policy": "no-referrer",
}
const MAX_BODY_BYTES = 1_024

export async function POST(request: Request) {
  try {
    const overlayKey = readOverlayAccessKey(process.env)
    requireOverlayAccess(request.headers.get("authorization"), overlayKey)
    if (!request.headers.get("content-type")?.startsWith("application/json")) {
      return NextResponse.json(
        { error: "invalid_content_type" },
        { status: 415, headers: HEADERS }
      )
    }
    const contentLength = Number(request.headers.get("content-length") ?? 0)
    if (contentLength > MAX_BODY_BYTES) {
      return NextResponse.json(
        { error: "location_sample_too_large" },
        { status: 413, headers: HEADERS }
      )
    }
    const text = await request.text()
    if (new TextEncoder().encode(text).byteLength > MAX_BODY_BYTES) {
      return NextResponse.json(
        { error: "location_sample_too_large" },
        { status: 413, headers: HEADERS }
      )
    }
    const sample = parseRealtimeIrlSample(JSON.parse(text))
    const [{ getServerFirebase }, { createRealtimeIrlStore }] =
      await Promise.all([
        import("@/lib/firebase/admin"),
        import("@/lib/realtimeirl/store"),
      ])
    const result = await createRealtimeIrlStore(getServerFirebase().db).record(
      sample,
      Date.now()
    )
    return NextResponse.json(
      {
        status: result.status,
        fresh: result.fresh,
        privacyBlocked: result.privacyBlocked,
      },
      { headers: HEADERS }
    )
  } catch (error) {
    if (error instanceof SyntaxError) {
      return NextResponse.json(
        { error: "invalid_location_sample" },
        { status: 400, headers: HEADERS }
      )
    }
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
