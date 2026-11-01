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

  // Builds both private session totals and the public projection from one read.
  async function readTally(tx: Transaction, tally: PollTally, ended: boolean) {
    const [session, publicState] = await Promise.all([
      tx.get(sessionRef),
      tx.get(publicStateRef),
    ])
    const poll = session.data()?.poll as PollRecord | undefined
    if (poll?.status !== "active" || poll.twitchPollId !== tally.pollId) {
      return null
    }
    const votesByChoiceId = new Map(
      tally.choices.map((choice) => [choice.id, choice.votes])
    )
    const nextPoll: PollRecord = {
      ...poll,
      choices: poll.choices.map((choice, index) => ({
        ...choice,
        votes:
          (choice.twitchChoiceId
            ? votesByChoiceId.get(choice.twitchChoiceId)
            : undefined) ??
          tally.choices[index]?.votes ??
          choice.votes ??
          0,
      })),
      updatedAt: Date.now(),
    }
    const projection = tallyOverlay(
      publicState.data(),
      { choices: tally.choices, ended },
      Date.now()
    )
    return { projection, poll: nextPoll }
  }

  return {
    save(write) {
      return db.runTransaction(async (tx) => {
        // Progress events are frequent and idempotent, so they skip receipts.
        if (write.kind === "poll_progress") {
          const tally = await readTally(tx, write.tally, false)
          if (!tally) return "ignored"
          tx.set(sessionRef, { poll: tally.poll }, { merge: true })
          if (tally.projection) tx.set(publicStateRef, tally.projection)
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
          const tally = pollExists
            ? null
            : await readTally(tx, write.poll, true)
          tx.create(receiptRef, {
            ...write.receipt,
            pollId: write.poll.pollId,
            duplicatePoll: pollExists,
          })
          if (pollExists) return "duplicate-poll"
          tx.create(pollRef, write.poll)
          if (tally) {
            tx.set(sessionRef, { poll: tally.poll }, { merge: true })
            if (tally.projection) tx.set(publicStateRef, tally.projection)
          }
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
