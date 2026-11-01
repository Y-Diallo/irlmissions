import "server-only"
import { FieldValue, type Firestore } from "firebase-admin/firestore"
import { eventSubStorageId } from "@/shared/eventsub"
import {
  PitchReviewError,
  toPitchHistoryItem,
  toPitchReviewItem,
  transitionPitchReview,
  type ReviewCommand,
  type ReviewRecord,
} from "@/shared/pitches/review"
import { tenantDoc } from "@/shared/tenant"

export function createPitchReviewStore(db: Firestore, tenantId: string) {
  return {
    async list() {
      const snapshot = await db
        .collection(tenantDoc(tenantId, "pitches"))
        .orderBy("createdAt", "desc")
        .limit(100)
        .get()
      return snapshot.docs.flatMap((document) => {
        const record = document.data() as ReviewRecord
        return record.hiddenAt ? [] : [toPitchReviewItem(record)]
      })
    },
    async history() {
      const snapshot = await db
        .collection(tenantDoc(tenantId, "pitches"))
        .orderBy("createdAt", "desc")
        .limit(100)
        .get()
      return snapshot.docs.flatMap((document) => {
        const record = document.data() as ReviewRecord
        return typeof record.hiddenAt === "number"
          ? [toPitchHistoryItem(record)]
          : []
      })
    },
    update(redemptionId: string, command: ReviewCommand, now: number) {
      return db.runTransaction(async (tx) => {
        const ref = db.doc(
          tenantDoc(tenantId, `pitches/${eventSubStorageId(redemptionId)}`)
        )
        const snapshot = await tx.get(ref)
        if (!snapshot.exists) throw new PitchReviewError("pitch_not_found", 404)
        const update = transitionPitchReview(
          snapshot.data() as ReviewRecord,
          command,
          now
        )
        tx.update(ref, {
          ...update.values,
          ...Object.fromEntries(
            update.deleteFields.map((field) => [field, FieldValue.delete()])
          ),
        })
        return { updated: true }
      })
    },
  }
}
