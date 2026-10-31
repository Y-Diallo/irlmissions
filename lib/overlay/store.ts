import "server-only"
import type { Firestore } from "firebase-admin/firestore"
import { idleOverlay, OverlayError, toOverlayView } from "@/shared/overlay"
import { tenantDoc } from "@/shared/tenant"

export function createOverlayStore(db: Firestore, tenantId: string) {
  const sessionRef = db.doc(tenantDoc(tenantId, "sessions/current"))
  return {
    async read(now = Date.now()) {
      const snapshot = await db
        .doc(tenantDoc(tenantId, "publicState/current"))
        .get()
      return snapshot.exists ? toOverlayView(snapshot.data()) : idleOverlay(now)
    },
    async readRevealedPlaceId() {
      const mission = (await sessionRef.get()).data()?.mission
      if (
        !mission?.destinationRevealedAt ||
        typeof mission?.destination?.placeId !== "string" ||
        !/^[A-Za-z0-9_-]{5,256}$/.test(mission.destination.placeId)
      ) {
        throw new OverlayError("place_photo_not_available", 404)
      }
      return mission.destination.placeId
    },
  }
}
