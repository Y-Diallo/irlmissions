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
      { getGooglePlacePhoto, readGoogleMapsConfig },
    ] = await Promise.all([
      import("@/lib/overlay/access-server"),
      import("@/lib/firebase/admin"),
      import("@/lib/overlay/store"),
      import("@/shared/providers/google-maps"),
    ])
    const tenantId = await requireOverlayTenant(request)
    const placeId = await createOverlayStore(
      getServerFirebase().db,
      tenantId
    ).readRevealedPlaceId()
    const photo = await getGooglePlacePhoto(
      readGoogleMapsConfig(process.env),
      placeId
    )
    return NextResponse.json(photo, { headers: HEADERS })
  } catch (error) {
    if (error instanceof OverlayAccessError || error instanceof OverlayError) {
      return NextResponse.json(
        { error: error.code },
        { status: error.status, headers: HEADERS }
      )
    }
    return NextResponse.json(
      { error: "place_photo_unavailable" },
      { status: 503, headers: HEADERS }
    )
  }
}
