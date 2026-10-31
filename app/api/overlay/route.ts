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
    const [{ requireOverlayTenant }, { getServerFirebase }, { createOverlayStore }] = await Promise.all([
      import("@/lib/overlay/access-server"),
      import("@/lib/firebase/admin"),
      import("@/lib/overlay/store"),
    ])
    const tenantId = await requireOverlayTenant(request)
    const overlay = await createOverlayStore(
      getServerFirebase().db,
      tenantId
    ).read()
    return NextResponse.json({ overlay }, { headers: HEADERS })
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
