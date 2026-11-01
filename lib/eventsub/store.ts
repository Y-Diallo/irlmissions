import "server-only"
import type { Firestore, Transaction } from "firebase-admin/firestore"
import type { EventSubStore, PollTally } from "@/shared/eventsub"
import { eventSubStorageId } from "@/shared/eventsub"
import { tallyOverlay } from "@/shared/overlay"
import type { PollRecord } from "@/shared/polls"
import { tenantDoc } from "@/shared/tenant"

export function createEventSubStore(
  db: Firestore,
  tenantId: string
): EventSubStore {
  const sessionRef = db.doc(tenantDoc(tenantId, "sessions/current"))
  const publicStateRef = db.doc(tenantDoc(tenantId, "publicState/current"))

  // Reads only; the caller writes the returned projection after its own reads.
  async function readTally(tx: Transaction, tally: PollTally, ended: boolean) {
    const [session, publicState] = await Promise.all([
      tx.get(sessionRef),
      tx.get(publicStateRef),
    ])
    const poll = session.data()?.poll as PollRecord | undefined
    if (poll?.status !== "active" || poll.twitchPollId !== tally.pollId) {
      return null
    }
    return tallyOverlay(
      publicState.data(),
      { choices: tally.choices, ended },
      Date.now()
    )
  }

  return {
    save(write) {
      return db.runTransaction(async (tx) => {
        // Progress events are frequent and idempotent, so they skip receipts.
        if (write.kind === "poll_progress") {
          const projection = await readTally(tx, write.tally, false)
          if (!projection) return "ignored"
          tx.set(publicStateRef, projection)
          return "tallied"
        }

        const receiptRef = db.doc(
          tenantDoc(
            tenantId,
            `eventsubMessages/${eventSubStorageId(write.receipt.messageId)}`
          )
        )
        if ((await tx.get(receiptRef)).exists) return "duplicate-message"

        if (write.kind === "revocation") {
          tx.create(receiptRef, write.receipt)
          return "created"
        }

        if (write.kind === "poll_end") {
          const pollRef = db.doc(
            tenantDoc(
              tenantId,
              `pollEvents/${eventSubStorageId(write.poll.pollId)}`
            )
          )
          const pollExists = (await tx.get(pollRef)).exists
          // Show final counts now; the processor applies the winner later.
          const projection = pollExists
            ? null
            : await readTally(tx, write.poll, true)
          tx.create(receiptRef, {
            ...write.receipt,
            pollId: write.poll.pollId,
            duplicatePoll: pollExists,
          })
          if (pollExists) return "duplicate-poll"
          tx.create(pollRef, write.poll)
          if (projection) tx.set(publicStateRef, projection)
          return "created"
        }

        const pitchRef = db.doc(
          tenantDoc(
            tenantId,
            `pitches/${eventSubStorageId(write.pitch.redemptionId)}`
          )
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
