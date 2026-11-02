import { NextResponse } from "next/server"
import { OverlayAccessError } from "@/shared/overlay-access"
import { OverlayError } from "@/shared/overlay"

export const runtime = "nodejs"

const HEADERS = {
  "Cache-Control": "no-store",
  "Referrer-Policy": "no-referrer",
}

export async function GET(request: Request) {
  try {
    const [
      { requireOverlayTenant },
      { getServerFirebase },
      { createOverlayStore },
    ] = await Promise.all([
      import("@/lib/overlay/access-server"),
      import("@/lib/firebase/admin"),
      import("@/lib/overlay/store"),
    ])
    const tenantId = await requireOverlayTenant(request)
    const store = createOverlayStore(getServerFirebase().db, tenantId)
    const now = Date.now()
    const [overlay, consequences] = await Promise.all([
      store.read(now),
      store.readConsequences(now),
    ])
    // serverNow lets the overlay count timers on the server's clock.
    return NextResponse.json(
      { overlay, consequences, serverNow: now },
      { headers: HEADERS }
    )
  } catch (error) {
    if (error instanceof OverlayAccessError || error instanceof OverlayError) {
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
