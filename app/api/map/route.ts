import { NextResponse } from "next/server"
import { OverlayAccessError } from "@/shared/overlay-access"

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
      { readMapProjection },
    ] = await Promise.all([
      import("@/lib/overlay/access-server"),
      import("@/lib/firebase/admin"),
      import("@/lib/map/store"),
    ])
    const tenantId = await requireOverlayTenant(request)
    return NextResponse.json(
      await readMapProjection(getServerFirebase().db, tenantId),
      { headers: HEADERS }
    )
  } catch (error) {
    if (error instanceof OverlayAccessError) {
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
