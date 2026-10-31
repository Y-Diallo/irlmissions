import "server-only"
import { FieldValue, type Firestore } from "firebase-admin/firestore"
import { eventSubStorageId } from "@/shared/eventsub"
import {
  MissionError,
  toMissionOwnerView,
  transitionMission,
  type MissionAction,
  type MissionRecord,
} from "@/shared/missions"

function missionFrom(data: FirebaseFirestore.DocumentData | undefined) {
  const mission = data?.mission
  return mission && typeof mission === "object"
    ? (mission as MissionRecord)
    : null
}

export function createMissionStore(db: Firestore) {
  const sessionRef = db.doc("sessions/current")
  return {
    async read() {
      const mission = missionFrom((await sessionRef.get()).data())
      return mission ? toMissionOwnerView(mission) : null
    },

    act(action: MissionAction, now: number) {
      return db.runTransaction(async (tx) => {
        const session = await tx.get(sessionRef)
        const current = missionFrom(session.data())
        if (!current) throw new MissionError("mission_not_found", 404)
        const next = transitionMission(current, action, now)
        if (next === current) return toMissionOwnerView(current)

        const terminal = next.status === "completed" || next.status === "failed"
        const pitchRef = db.doc(
          `pitches/${eventSubStorageId(current.redemptionId)}`
        )
        const pitch = terminal ? await tx.get(pitchRef) : null
        if (terminal) {
          if (!pitch?.exists || pitch.data()?.lockedBy !== current.lockId) {
            throw new MissionError("mission_pitch_mismatch")
          }
        }

        tx.set(sessionRef, { mission: next }, { merge: true })
        if (terminal) {
          tx.update(pitchRef, {
            reviewStatus: next.status,
            lockedBy: FieldValue.delete(),
            missionOutcomeAt: now,
            redemptionResolution: {
              action: "fulfill",
              status: "pending",
              attempts: 0,
              nextAttemptAt: now,
            },
            updatedAt: now,
          })
        }
        return toMissionOwnerView(next)
      })
    },
  }
}
