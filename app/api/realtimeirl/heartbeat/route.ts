import { NextResponse } from "next/server"
import { OverlayAccessError } from "@/shared/overlay-access"
import {
  parseRealtimeIrlSessionId,
  RealtimeIrlError,
} from "@/shared/realtimeirl"

export const runtime = "nodejs"

const MAX_BODY_BYTES = 256

// Only the RealtimeIRL session id is read; coordinates never come this way.
async function sessionIdFrom(request: Request) {
  const text = await request.text()
  if (!text) return undefined
  if (new TextEncoder().encode(text).byteLength > MAX_BODY_BYTES) {
    throw new RealtimeIrlError("invalid_location_sample")
  }
  let body: unknown
  try {
    body = JSON.parse(text)
  } catch {
    throw new RealtimeIrlError("invalid_location_sample")
  }
  return body && typeof body === "object" && !Array.isArray(body)
    ? parseRealtimeIrlSessionId((body as Record<string, unknown>).sessionId)
    : undefined
}

const HEADERS = {
  "Cache-Control": "no-store",
  "Referrer-Policy": "no-referrer",
}

export async function POST(request: Request) {
  try {
    const [
      { requireOverlayTenant },
      { getServerFirebase },
      { createRealtimeIrlStore },
    ] = await Promise.all([
      import("@/lib/overlay/access-server"),
      import("@/lib/firebase/admin"),
      import("@/lib/realtimeirl/store"),
    ])
    const tenantId = await requireOverlayTenant(request)
    const sessionId = await sessionIdFrom(request)
    const store = createRealtimeIrlStore(getServerFirebase().db, tenantId)
    const result = sessionId
      ? await store.heartbeat(Date.now(), sessionId)
      : await store.heartbeat(Date.now())
    return NextResponse.json(
      {
        status: result.status,
        privacyBlocked: result.privacyBlocked,
      },
      { headers: HEADERS }
    )
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
