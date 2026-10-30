import "server-only"
import { FieldValue, type Firestore } from "firebase-admin/firestore"
import { eventSubStorageId } from "@/shared/eventsub"
import {
  PitchReviewError,
  toPitchReviewItem,
  transitionPitchReview,
  type ReviewCommand,
  type ReviewRecord,
} from "@/shared/pitches/review"

export function createPitchReviewStore(db: Firestore) {
  return {
    async list() {
      const snapshot = await db
        .collection("pitches")
        .orderBy("createdAt", "desc")
        .limit(50)
        .get()
      return snapshot.docs.map((document) =>
        toPitchReviewItem(document.data() as ReviewRecord)
      )
    },
    update(redemptionId: string, command: ReviewCommand, now: number) {
      return db.runTransaction(async (tx) => {
        const ref = db.doc(`pitches/${eventSubStorageId(redemptionId)}`)
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
