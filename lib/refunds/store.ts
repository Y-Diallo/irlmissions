import "server-only"

import { FieldValue, type Firestore } from "firebase-admin/firestore"
import { queueRefund, toRefundItem, type RefundItem } from "@/shared/refunds"
import type { ReviewRecord } from "@/shared/pitches/review"

const LIMIT = 100

export function createRefundStore(db: Firestore) {
  const query = db
    .collection("pitches")
    .orderBy("createdAt", "desc")
    .limit(LIMIT)

  return {
    async list(): Promise<RefundItem[]> {
      const snapshot = await query.get()
      return snapshot.docs.map((document) =>
        toRefundItem(document.data() as ReviewRecord)
      )
    },

    async queueUnused(now: number) {
      const candidates = await query.get()
      return db.runTransaction(async (tx) => {
        const snapshots = []
        for (const candidate of candidates.docs) {
          snapshots.push(await tx.get(candidate.ref))
        }
        let queued = 0
        let skipped = 0
        for (const snapshot of snapshots) {
          if (!snapshot.exists) {
            skipped += 1
            continue
          }
          const update = queueRefund(snapshot.data() as ReviewRecord, now)
          if (!update) {
            skipped += 1
            continue
          }
          tx.update(snapshot.ref, {
            ...update.values,
            ...Object.fromEntries(
              update.deleteFields.map((field) => [field, FieldValue.delete()])
            ),
          })
          queued += 1
        }
        return { queued, skipped }
      })
    },
  }
}
