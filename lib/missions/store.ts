import "server-only"
import { FieldValue, type Firestore } from "firebase-admin/firestore"
import { parseAutomationSettings } from "@/shared/automation"
import { eventSubStorageId } from "@/shared/eventsub"
import { idleOverlay, missionOverlay } from "@/shared/overlay"
import type { PollRecord } from "@/shared/polls"
import {
  readOwedConsequences,
  settleConsequences,
} from "@/lib/consequences/store"
import {
  createMissionFromPick,
  MissionError,
  toMissionOwnerView,
  transitionMission,
  type MissionAction,
  type MissionRecord,
} from "@/shared/missions"
import { tenantDoc } from "@/shared/tenant"

function missionFrom(data: FirebaseFirestore.DocumentData | undefined) {
  const mission = data?.mission
  return mission && typeof mission === "object"
    ? (mission as MissionRecord)
    : null
}

export function createMissionStore(db: Firestore, tenantId: string) {
  const sessionRef = db.doc(tenantDoc(tenantId, "sessions/current"))
  const publicStateRef = db.doc(tenantDoc(tenantId, "publicState/current"))
  const settingsRef = db.doc(tenantDoc(tenantId, "settings/current"))
  return {
    async read() {
      const mission = missionFrom((await sessionRef.get()).data())
      return mission ? toMissionOwnerView(mission) : null
    },

    pick(redemptionId: string, now: number) {
      return db.runTransaction(async (tx) => {
        const pitchRef = db.doc(
          tenantDoc(tenantId, `pitches/${eventSubStorageId(redemptionId)}`)
        )
        const [session, pitch, settings] = await Promise.all([
          tx.get(sessionRef),
          tx.get(pitchRef),
          tx.get(settingsRef),
        ])
        if (["heading", "arrived"].includes(session.data()?.mission?.status)) {
          throw new MissionError("mission_in_progress")
        }
        const poll = session.data()?.poll as PollRecord | undefined
        if (
          poll &&
          ["creating", "create_unknown", "active"].includes(poll.status)
        ) {
          throw new MissionError("poll_in_progress")
        }
        if (!pitch.exists) throw new MissionError("pitch_not_found", 404)
        // Picking during a tie overrides it: the other tied pitches unlock.
        const tie = poll?.status === "tie" ? poll : null
        const tiedSnapshots = []
        for (const tiedId of tie?.tiedRedemptionIds ?? []) {
          if (tiedId === redemptionId) continue
          tiedSnapshots.push(
            await tx.get(
              db.doc(
                tenantDoc(tenantId, `pitches/${eventSubStorageId(tiedId)}`)
              )
            )
          )
        }
        const mission = createMissionFromPick(
          {
            ...pitch.data(),
            redemptionId,
            ...(settings.data()?.noTravelMode === true
              ? { noTravel: true }
              : {}),
          },
          now,
          tie?.lockId
        )
        const owed = await readOwedConsequences(tx, db, tenantId)
        // An anywhere mission starts arrived: that's the next stop.
        settleConsequences(
          tx,
          db,
          tenantId,
          owed,
          {
            event: { type: mission.status === "arrived" ? "arrived" : "sweep" },
          },
          now
        )

        if (tie) {
          const rest: Partial<typeof tie> = { ...tie }
          delete rest.tiedRedemptionIds
          tx.set(
            sessionRef,
            {
              mission,
              poll: {
                ...rest,
                status: "canceled",
                errorCode: "owner_picked",
                updatedAt: now,
              },
            },
            { mergeFields: ["mission", "poll"] }
          )
          for (const snapshot of tiedSnapshots) {
            if (snapshot.data()?.lockedBy === tie.lockId) {
              tx.update(snapshot.ref, {
                lockedBy: FieldValue.delete(),
                updatedAt: now,
              })
            }
          }
        } else {
          tx.set(sessionRef, { mission }, { mergeFields: ["mission"] })
        }
        tx.set(publicStateRef, missionOverlay(mission))
        tx.update(pitchRef, {
          lockedBy: mission.lockId,
          reviewStatus: "active_mission",
          missionId: mission.missionId,
          pickedAt: now,
          updatedAt: now,
        })
        return toMissionOwnerView(mission)
      })
    },

    act(action: MissionAction, now: number) {
      return db.runTransaction(async (tx) => {
        const [session, settings] = await Promise.all([
          tx.get(sessionRef),
          tx.get(settingsRef),
        ])
        const current = missionFrom(session.data())
        if (!current) throw new MissionError("mission_not_found", 404)
        const next = transitionMission(current, action, now)
        if (next === current) return toMissionOwnerView(current)

        const canceled = next.status === "canceled"
        const terminal =
          canceled || next.status === "completed" || next.status === "failed"
        const pitchRef = db.doc(
          tenantDoc(
            tenantId,
            `pitches/${eventSubStorageId(current.redemptionId)}`
          )
        )
        const pitch = terminal ? await tx.get(pitchRef) : null
        if (terminal) {
          if (!pitch?.exists || pitch.data()?.lockedBy !== current.lockId) {
            throw new MissionError("mission_pitch_mismatch")
          }
        }
        const owed = await readOwedConsequences(tx, db, tenantId)
        const outcome =
          action === "complete" || action === "fail" || action === "deny"
        settleConsequences(
          tx,
          db,
          tenantId,
          owed,
          {
            event:
              action === "arrive"
                ? { type: "arrived" }
                : outcome
                  ? {
                      type: "outcome",
                      missionId: next.missionId,
                      // A cap, not an override: each rule still applies until
                      // this outcome, then everything still owed clears.
                      cap: parseAutomationSettings(settings.data()?.automation)
                        .capConsequencesAtNextMissionEnd,
                    }
                  : { type: "sweep" },
            ...(action === "fail" ? { failedMission: next } : {}),
          },
          now
        )

        tx.set(sessionRef, { mission: next }, { mergeFields: ["mission"] })
        tx.set(
          publicStateRef,
          canceled ? idleOverlay(now) : missionOverlay(next)
        )
        if (terminal) {
          tx.update(pitchRef, {
            reviewStatus: canceled ? "rejected" : next.status,
            ...(action === "deny" ? { missionOutcome: "denied" } : {}),
            lockedBy: FieldValue.delete(),
            missionOutcomeAt: now,
            ...(canceled ? { rejectionReason: "mission_canceled" } : {}),
            redemptionResolution: {
              action: canceled ? "refund" : "fulfill",
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
