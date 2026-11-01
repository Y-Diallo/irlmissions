import { NextResponse } from "next/server"
import { OverlayAccessError } from "@/shared/overlay-access"
import { RealtimeIrlError } from "@/shared/realtimeirl"

export const runtime = "nodejs"

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
    const result = await createRealtimeIrlStore(
      getServerFirebase().db,
      tenantId
    ).heartbeat(Date.now())
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
