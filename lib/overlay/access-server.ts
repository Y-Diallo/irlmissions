import "server-only"

import { parseOverlaySecret } from "@/shared/overlay-access"
import { getServerFirebase } from "@/lib/firebase/admin"
import { createOverlayAccessStore } from "@/lib/overlay/access-store"

export async function requireOverlayTenant(request: Request) {
  const overlayId = request.headers.get("x-overlay-id") ?? ""
  const secret = parseOverlaySecret(request.headers.get("authorization"))
  return createOverlayAccessStore(getServerFirebase().db).resolve(
    overlayId,
    secret
  )
}
