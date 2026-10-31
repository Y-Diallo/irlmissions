import { NextResponse } from "next/server"
import {
  OverlayAccessError,
  readOverlayAccessKey,
  requireOverlayAccess,
} from "@/shared/overlay-access"
import { OverlayError } from "@/shared/overlay"

export const runtime = "nodejs"

const HEADERS = {
  "Cache-Control": "no-store",
  "Referrer-Policy": "no-referrer",
}

export async function GET(request: Request) {
  try {
    const key = readOverlayAccessKey(process.env)
    requireOverlayAccess(request.headers.get("authorization"), key)
    const [{ getServerFirebase }, { createOverlayStore }] = await Promise.all([
      import("@/lib/firebase/admin"),
      import("@/lib/overlay/store"),
    ])
    const overlay = await createOverlayStore(getServerFirebase().db).read()
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
