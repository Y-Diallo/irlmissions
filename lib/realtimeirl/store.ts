import "server-only"

import type { Firestore } from "firebase-admin/firestore"
import { missionOverlay } from "@/shared/overlay"
import {
  evaluateRealtimeIrlArrival,
  parseArrivalSettings,
  type ArrivalConfirmation,
  type RealtimeIrlSample,
} from "@/shared/realtimeirl"
import type { MissionRecord } from "@/shared/missions"

function missionFrom(data: FirebaseFirestore.DocumentData | undefined) {
  const mission = data?.mission
  return mission && typeof mission === "object"
    ? (mission as MissionRecord)
    : null
}

function confirmationFrom(data: FirebaseFirestore.DocumentData | undefined) {
  if (
    !data ||
    typeof data.missionId !== "string" ||
    typeof data.firstObservedAt !== "number" ||
    typeof data.lastObservedAt !== "number"
  ) {
    return null
  }
  return data as ArrivalConfirmation
}

function observedAtFrom(data: FirebaseFirestore.DocumentData | undefined) {
  return typeof data?.observedAt === "number" ? data.observedAt : undefined
}

export function createRealtimeIrlStore(db: Firestore) {
  const settingsRef = db.doc("settings/current")
  const sessionRef = db.doc("sessions/current")
  const locationRef = db.doc("privateState/location")
  const confirmationRef = db.doc("privateState/arrivalConfirmation")
  const publicStateRef = db.doc("publicState/current")

  return {
    record(sample: RealtimeIrlSample, now: number) {
      return db.runTransaction(async (tx) => {
        const [
          settingsSnapshot,
          sessionSnapshot,
          confirmationSnapshot,
          locationSnapshot,
        ] = await tx.getAll(
          settingsRef,
          sessionRef,
          confirmationRef,
          locationRef
        )
        if (!settingsSnapshot.exists) {
          throw new Error("Arrival settings are missing")
        }
        const decision = evaluateRealtimeIrlArrival({
          sample,
          now,
          settings: parseArrivalSettings(settingsSnapshot.data()),
          mission: missionFrom(sessionSnapshot.data()),
          confirmation: confirmationFrom(confirmationSnapshot.data()),
          latestObservedAt: observedAtFrom(locationSnapshot.data()),
        })

        if (!decision.fresh) return decision

        tx.set(locationRef, {
          latitude: sample.latitude,
          longitude: sample.longitude,
          observedAt: sample.observedAt,
          receivedAt: now,
          source: "realtimeirl",
          privacyBlocked: decision.privacyBlocked,
        })

        if (decision.nextConfirmation) {
          tx.set(confirmationRef, decision.nextConfirmation)
        } else {
          tx.delete(confirmationRef)
        }

        if (decision.mission) {
          tx.set(sessionRef, { mission: decision.mission }, { merge: true })
          tx.set(publicStateRef, missionOverlay(decision.mission))
        }
        return decision
      })
    },
  }
}
