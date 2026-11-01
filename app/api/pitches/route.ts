import { NextResponse } from "next/server"
import { authFailure, NO_STORE } from "@/lib/auth/http"
import { parseAutomationSettings } from "@/shared/automation"
import { tenantDoc } from "@/shared/tenant"

export const runtime = "nodejs"

export async function GET(request: Request) {
  try {
    const [
      { requireServerOwner },
      { getServerFirebase },
      { createPitchReviewStore },
    ] = await Promise.all([
      import("@/lib/auth/server"),
      import("@/lib/firebase/admin"),
      import("@/lib/pitches/review-store"),
    ])
    const owner = await requireServerOwner(request.headers.get("authorization"))
    const db = getServerFirebase().db
    const [pitches, settings] = await Promise.all([
      createPitchReviewStore(db, owner.tenantId).list(),
      db.doc(tenantDoc(owner.tenantId, "settings/current")).get(),
    ])
    return NextResponse.json(
      {
        pitches,
        noTravelMode: settings.data()?.noTravelMode === true,
        mapCoarseMode: settings.data()?.mapCoarseMode === true,
        automation: parseAutomationSettings(settings.data()?.automation),
        automationPaused: settings.data()?.automationPaused === true,
      },
      { headers: NO_STORE }
    )
  } catch (error) {
    return authFailure(error)
  }
}
