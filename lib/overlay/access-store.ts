import "server-only"

import { randomBytes } from "node:crypto"
import type { Firestore } from "firebase-admin/firestore"
import {
  OverlayAccessError,
  overlaySecretHash,
  requireOverlayAccess,
} from "@/shared/overlay-access"
import { tenantDoc, validateTenantId } from "@/shared/tenant"

export function createOverlayAccessStore(db: Firestore) {
  return {
    async resolve(overlayId: string, secret: string) {
      if (!/^[A-Za-z0-9_-]{16,64}$/.test(overlayId)) {
        throw new OverlayAccessError("unauthorized", 401)
      }
      const snapshot = await db.doc(`overlayAccess/${overlayId}`).get()
      const data = snapshot.data()
      if (
        !snapshot.exists ||
        typeof data?.tenantId !== "string" ||
        typeof data?.secretHash !== "string"
      ) {
        throw new OverlayAccessError("unauthorized", 401)
      }
      requireOverlayAccess(secret, data.secretHash)
      return validateTenantId(data.tenantId)
    },
    async rotate(tenantId: string, now: number) {
      validateTenantId(tenantId)
      const integrationRef = db.doc(
        tenantDoc(tenantId, "private/integrations")
      )
      const current = (await integrationRef.get()).data()?.overlayId
      const overlayId = randomBytes(18).toString("base64url")
      const secret = randomBytes(32).toString("base64url")
      const batch = db.batch()
      if (typeof current === "string" && current !== overlayId) {
        batch.delete(db.doc(`overlayAccess/${current}`))
      }
      batch.set(db.doc(`overlayAccess/${overlayId}`), {
        tenantId,
        secretHash: overlaySecretHash(secret),
        createdAt: now,
      })
      batch.set(
        integrationRef,
        { overlayId, overlayRotatedAt: now, updatedAt: now },
        { merge: true }
      )
      await batch.commit()
      return { overlayId, secret }
    },
  }
}
