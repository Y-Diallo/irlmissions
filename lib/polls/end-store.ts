import "server-only"
import { FieldValue, type Firestore } from "firebase-admin/firestore"
import { eventSubStorageId, type PendingPollEnd } from "@/shared/eventsub"
import {
  attachTwitchPoll,
  matchesPollAttempt,
  PollError,
  resolvePollEnd,
  type PollEnd,
  type PollRecord,
  type TwitchPoll,
} from "@/shared/polls"

function currentPoll(data: FirebaseFirestore.DocumentData | undefined) {
  const poll = data?.poll
  return poll && typeof poll === "object" ? (poll as PollRecord) : null
}

function eventFrom(data: PendingPollEnd): PollEnd {
  return {
    pollId: data.pollId,
    status: data.status,
    endedAt: Date.parse(data.endedAt),
    choices: data.choices,
  }
}

function twitchPollFromEvent(
  record: PollRecord,
  event: PendingPollEnd
): TwitchPoll {
  return {
    id: event.pollId,
    broadcasterId: event.broadcasterId,
    title: event.title,
    status: event.status.toUpperCase(),
    durationSeconds: record.durationSeconds,
    startedAt: Date.parse(event.startedAt),
    endedAt: Date.parse(event.endedAt),
    choices: event.choices,
  }
}

export function createPollEndStore(db: Firestore) {
  const sessionRef = db.doc("sessions/current")
  return {
    async findPending(limit = 5) {
      const snapshot = await db
        .collection("pollEvents")
        .where("processing.status", "==", "pending")
        .limit(Math.max(0, Math.min(limit, 5)))
        .get()
      return snapshot.docs.flatMap((document) => {
        const pollId = document.data().pollId
        return typeof pollId === "string" ? [pollId] : []
      })
    },

    apply(pollId: string, now: number) {
      return db.runTransaction(async (tx) => {
        const eventRef = db.doc(`pollEvents/${eventSubStorageId(pollId)}`)
        const [eventSnapshot, sessionSnapshot] = await Promise.all([
          tx.get(eventRef),
          tx.get(sessionRef),
        ])
        if (!eventSnapshot.exists) return "ignored" as const
        const event = eventSnapshot.data() as PendingPollEnd
        if (event.processing?.status !== "pending") return "ignored" as const
        let poll = currentPoll(sessionSnapshot.data())
        if (poll && ["creating", "create_unknown"].includes(poll.status)) {
          const candidate = twitchPollFromEvent(poll, event)
          if (matchesPollAttempt(poll, candidate)) {
            poll = attachTwitchPoll(poll, candidate, now)
          }
        }
        if (
          !poll ||
          poll.status !== "active" ||
          poll.twitchPollId !== event.pollId
        ) {
          tx.update(eventRef, {
            processing: {
              status: "complete",
              result: "ignored",
              completedAt: now,
            },
            updatedAt: now,
          })
          return "ignored" as const
        }

        const pitchSnapshots = []
        for (const choice of poll.choices) {
          pitchSnapshots.push(
            await tx.get(
              db.doc(`pitches/${eventSubStorageId(choice.redemptionId)}`)
            )
          )
        }

        let resolution
        try {
          resolution = resolvePollEnd(poll, eventFrom(event), now)
        } catch (error) {
          if (!(error instanceof PollError)) throw error
          tx.update(eventRef, {
            processing: {
              status: "error",
              errorCode: error.code,
              failedAt: now,
            },
            updatedAt: now,
          })
          return "error" as const
        }

        tx.set(sessionRef, { poll: resolution.poll }, { merge: true })
        for (const snapshot of pitchSnapshots) {
          const redemptionId = snapshot.data()?.redemptionId
          if (!snapshot.exists || snapshot.data()?.lockedBy !== poll.lockId) {
            continue
          }
          if (redemptionId === resolution.winnerRedemptionId) {
            tx.update(snapshot.ref, {
              lockedBy: `mission:pending:${poll.twitchPollId}`,
              pollWonAt: now,
              updatedAt: now,
            })
          } else {
            tx.update(snapshot.ref, {
              lockedBy: FieldValue.delete(),
              updatedAt: now,
            })
          }
        }
        tx.update(eventRef, {
          processing: {
            status: "complete",
            result: resolution.winnerRedemptionId ? "winner" : "no_winner",
            completedAt: now,
          },
          updatedAt: now,
        })
        return resolution.winnerRedemptionId ? "winner" : "no_winner"
      })
    },
  }
}

export async function processPendingPollEnds(
  db: Firestore,
  limit = 5,
  now = Date.now()
) {
  const store = createPollEndStore(db)
  const ids = await store.findPending(limit)
  const results = []
  for (const id of ids) results.push(await store.apply(id, now))
  return {
    scanned: ids.length,
    winners: results.filter((result) => result === "winner").length,
    noWinner: results.filter((result) => result === "no_winner").length,
    ignored: results.filter((result) => result === "ignored").length,
    errors: results.filter((result) => result === "error").length,
  }
}
