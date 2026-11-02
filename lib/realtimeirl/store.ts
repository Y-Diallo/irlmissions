import "server-only"

import { FieldValue, type Firestore } from "firebase-admin/firestore"
import {
  readOwedConsequences,
  settleConsequences,
} from "@/lib/consequences/store"
import { missionOverlay } from "@/shared/overlay"
import {
  evaluateRealtimeIrlArrival,
  evaluateRealtimeIrlHeartbeat,
  parseArrivalSettings,
  RealtimeIrlError,
  type ArrivalConfirmation,
  type RealtimeIrlSample,
} from "@/shared/realtimeirl"
import type { MissionRecord } from "@/shared/missions"
import { tenantDoc } from "@/shared/tenant"

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

function coordinatesFrom(data: FirebaseFirestore.DocumentData | undefined) {
  if (
    typeof data?.latitude !== "number" ||
    typeof data?.longitude !== "number"
  ) {
    throw new RealtimeIrlError("location_unavailable", 409)
  }
  return { latitude: data.latitude, longitude: data.longitude }
}

export function createRealtimeIrlStore(db: Firestore, tenantId: string) {
  const settingsRef = db.doc(tenantDoc(tenantId, "settings/current"))
  const sessionRef = db.doc(tenantDoc(tenantId, "sessions/current"))
  const locationRef = db.doc(tenantDoc(tenantId, "privateState/location"))
  const confirmationRef = db.doc(
    tenantDoc(tenantId, "privateState/arrivalConfirmation")
  )
  const publicStateRef = db.doc(tenantDoc(tenantId, "publicState/current"))

  // Only a heading-to-arrived change touches consequences, so ordinary GPS
  // samples skip the extra read. Reads must precede the transaction's writes.
  async function owedOnArrival(
    tx: FirebaseFirestore.Transaction,
    before: MissionRecord | null,
    after: MissionRecord | null | undefined
  ) {
    return before?.status === "heading" && after?.status === "arrived"
      ? readOwedConsequences(tx, db, tenantId)
      : null
  }

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
        const owed = await owedOnArrival(
          tx,
          missionFrom(sessionSnapshot.data()),
          decision.mission
        )

        tx.set(locationRef, {
          latitude: sample.latitude,
          longitude: sample.longitude,
          observedAt: sample.observedAt,
          accuracyMeters: sample.accuracyMeters ?? FieldValue.delete(),
          receivedAt: now,
          feedHeartbeatAt: now,
          source: "realtimeirl",
          privacyBlocked: decision.privacyBlocked,
        })

        if (decision.nextConfirmation) {
          tx.set(confirmationRef, decision.nextConfirmation)
        } else {
          tx.delete(confirmationRef)
        }

        if (decision.mission) {
          tx.set(
            sessionRef,
            { mission: decision.mission },
            { mergeFields: ["mission"] }
          )
          tx.set(publicStateRef, missionOverlay(decision.mission))
        }
        if (owed) {
          settleConsequences(
            tx,
            db,
            tenantId,
            owed,
            { event: { type: "arrived" } },
            now
          )
        }
        return decision
      })
    },
    heartbeat(now: number) {
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
        const decision = evaluateRealtimeIrlHeartbeat({
          location: coordinatesFrom(locationSnapshot.data()),
          now,
          settings: parseArrivalSettings(settingsSnapshot.data()),
          mission: missionFrom(sessionSnapshot.data()),
          confirmation: confirmationFrom(confirmationSnapshot.data()),
        })
        const owed = await owedOnArrival(
          tx,
          missionFrom(sessionSnapshot.data()),
          decision.mission
        )

        tx.set(
          locationRef,
          {
            feedHeartbeatAt: now,
            privacyBlocked: decision.privacyBlocked,
          },
          { merge: true }
        )
        if (decision.nextConfirmation) {
          tx.set(confirmationRef, decision.nextConfirmation)
        } else {
          tx.delete(confirmationRef)
        }
        if (decision.mission) {
          tx.set(
            sessionRef,
            { mission: decision.mission },
            { mergeFields: ["mission"] }
          )
          tx.set(publicStateRef, missionOverlay(decision.mission))
        }
        if (owed) {
          settleConsequences(
            tx,
            db,
            tenantId,
            owed,
            { event: { type: "arrived" } },
            now
          )
        }
        return decision
      })
    },
  }
}
