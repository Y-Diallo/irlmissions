import { NextResponse } from "next/server"
import { OverlayAccessError } from "@/shared/overlay-access"
import { RealtimeIrlError } from "@/shared/realtimeirl"

export const runtime = "nodejs"

const HEADERS = {
  "Cache-Control": "no-store",
  "Referrer-Policy": "no-referrer",
}

export async function GET(request: Request) {
  try {
    const [{ requireOverlayTenant }, { getServerFirebase }] = await Promise.all(
      [import("@/lib/overlay/access-server"), import("@/lib/firebase/admin")]
    )
    const tenantId = await requireOverlayTenant(request)
    const integration = (
      await getServerFirebase()
        .db.doc(`owners/${tenantId}/private/integrations`)
        .get()
    ).data()
    const pullKey = integration?.realtimeIrlPullKey
    // Not set up (no-travel streams, the demo) is normal, not an outage.
    if (typeof pullKey !== "string" || !pullKey) {
      throw new RealtimeIrlError("realtimeirl_not_configured", 404)
    }
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
