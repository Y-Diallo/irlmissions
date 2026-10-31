import "server-only"
import type { Firestore } from "firebase-admin/firestore"
import { idleOverlay, toOverlayView } from "@/shared/overlay"

export function createOverlayStore(db: Firestore) {
  return {
    async read(now = Date.now()) {
      const snapshot = await db.doc("publicState/current").get()
      return snapshot.exists ? toOverlayView(snapshot.data()) : idleOverlay(now)
    },
  }
}
