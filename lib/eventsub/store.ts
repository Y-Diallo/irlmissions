import "server-only"
import type { Firestore } from "firebase-admin/firestore"
import type { EventSubStore } from "@/shared/eventsub"
import { eventSubStorageId } from "@/shared/eventsub"

export function createEventSubStore(db: Firestore): EventSubStore {
  return {
    save(write) {
      return db.runTransaction(async (tx) => {
        const receiptRef = db.doc(
          `eventsubMessages/${eventSubStorageId(write.receipt.messageId)}`
        )
        if ((await tx.get(receiptRef)).exists) return "duplicate-message"

        if (write.kind === "revocation") {
          tx.create(receiptRef, write.receipt)
          return "created"
        }

        if (write.kind === "poll_end") {
          const pollRef = db.doc(
            `pollEvents/${eventSubStorageId(write.poll.pollId)}`
          )
          const pollExists = (await tx.get(pollRef)).exists
          tx.create(receiptRef, {
            ...write.receipt,
            pollId: write.poll.pollId,
            duplicatePoll: pollExists,
          })
          if (pollExists) return "duplicate-poll"
          tx.create(pollRef, write.poll)
          return "created"
        }

        const pitchRef = db.doc(
          `pitches/${eventSubStorageId(write.pitch.redemptionId)}`
        )
        const pitchExists = (await tx.get(pitchRef)).exists
        tx.create(receiptRef, {
          ...write.receipt,
          redemptionId: write.pitch.redemptionId,
          duplicateRedemption: pitchExists,
        })
        if (pitchExists) return "duplicate-redemption"
        tx.create(pitchRef, write.pitch)
        return "created"
      })
    },
  }
}
