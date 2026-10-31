import "server-only"
import { FieldValue, type Firestore } from "firebase-admin/firestore"
import { eventSubStorageId } from "@/shared/eventsub"
import { votingOverlay } from "@/shared/overlay"
import {
  PollError,
  attachTwitchPoll,
  preparePollRecord,
  type PollPitch,
  type PollRecord,
  type StartPollCommand,
  type TwitchPoll,
} from "@/shared/polls"

const IN_PROGRESS = new Set(["creating", "create_unknown", "active"])

function pitchRef(db: Firestore, redemptionId: string) {
  return db.doc(`pitches/${eventSubStorageId(redemptionId)}`)
}

function pollFromSession(data: FirebaseFirestore.DocumentData | undefined) {
  const poll = data?.poll
  return poll && typeof poll === "object" ? (poll as PollRecord) : null
}

function hasActiveMission(data: FirebaseFirestore.DocumentData | undefined) {
  return ["heading", "arrived"].includes(data?.mission?.status)
}

export function createPollStore(db: Firestore) {
  const sessionRef = db.doc("sessions/current")
  const publicStateRef = db.doc("publicState/current")
  return {
    async read(): Promise<PollRecord | null> {
      return pollFromSession((await sessionRef.get()).data())
    },

    reserve(command: StartPollCommand, attemptId: string, now: number) {
      return db.runTransaction(async (tx) => {
        const session = await tx.get(sessionRef)
        const current = pollFromSession(session.data())
        if (hasActiveMission(session.data())) {
          throw new PollError("mission_in_progress")
        }
        if (current && IN_PROGRESS.has(current.status)) {
          throw new PollError("poll_in_progress")
        }

        const snapshots = []
        for (const redemptionId of command.redemptionIds) {
          snapshots.push(await tx.get(pitchRef(db, redemptionId)))
        }
        const pitches = snapshots.flatMap((snapshot, index) => {
          if (!snapshot.exists) return []
          const data = snapshot.data()!
          return [
            {
              redemptionId: command.redemptionIds[index]!,
              reviewStatus: data.reviewStatus,
              publicLabel: data.publicLabel,
              lockedBy: data.lockedBy,
            } satisfies PollPitch,
          ]
        })
        const poll = preparePollRecord(pitches, command, attemptId, now)
        tx.set(sessionRef, { poll }, { merge: true })
        for (const snapshot of snapshots) {
          tx.update(snapshot.ref, { lockedBy: poll.lockId, updatedAt: now })
        }
        return poll
      })
    },

    attach(attemptId: string, twitchPoll: TwitchPoll, now: number) {
      return db.runTransaction(async (tx) => {
        const session = await tx.get(sessionRef)
        const current = pollFromSession(session.data())
        if (!current || current.attemptId !== attemptId) {
          throw new PollError("poll_attempt_stale")
        }
        if (current.status === "active") return current
        if (!["creating", "create_unknown"].includes(current.status)) {
          throw new PollError("poll_not_recoverable")
        }
        const poll = attachTwitchPoll(current, twitchPoll, now)
        tx.set(sessionRef, { poll }, { merge: true })
        tx.set(publicStateRef, votingOverlay(poll))
        return poll
      })
    },

    markUnknown(attemptId: string, errorCode: string, now: number) {
      return db.runTransaction(async (tx) => {
        const session = await tx.get(sessionRef)
        const current = pollFromSession(session.data())
        if (!current || current.attemptId !== attemptId) return null
        if (current.status === "active") return current
        if (
          current.status !== "creating" &&
          current.status !== "create_unknown"
        ) {
          return current
        }
        const poll: PollRecord = {
          ...current,
          status: "create_unknown",
          errorCode,
          updatedAt: now,
        }
        tx.set(sessionRef, { poll }, { merge: true })
        return poll
      })
    },

    failAndUnlock(attemptId: string, errorCode: string, now: number) {
      return db.runTransaction(async (tx) => {
        const session = await tx.get(sessionRef)
        const current = pollFromSession(session.data())
        if (!current || current.attemptId !== attemptId) return null
        if (current.status === "active") return current
        const snapshots = []
        for (const choice of current.choices) {
          snapshots.push(await tx.get(pitchRef(db, choice.redemptionId)))
        }
        const poll: PollRecord = {
          ...current,
          status: "error",
          errorCode,
          updatedAt: now,
        }
        tx.set(sessionRef, { poll }, { merge: true })
        for (const snapshot of snapshots) {
          if (snapshot.data()?.lockedBy === current.lockId) {
            tx.update(snapshot.ref, {
              lockedBy: FieldValue.delete(),
              updatedAt: now,
            })
          }
        }
        return poll
      })
    },
  }
}
