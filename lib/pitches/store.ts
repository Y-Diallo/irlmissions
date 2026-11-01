import "server-only"
import type { Firestore } from "firebase-admin/firestore"
import { eventSubStorageId } from "@/shared/eventsub"
import type {
  DuplicateSuggestion,
  PitchStore,
  ProcessingContext,
} from "@/shared/pitches/processor"
import { tenantDoc } from "@/shared/tenant"

function pitchRef(db: Firestore, tenantId: string, redemptionId: string) {
  return db.doc(
    tenantDoc(tenantId, `pitches/${eventSubStorageId(redemptionId)}`)
  )
}

export function createPitchStore(db: Firestore, tenantId: string): PitchStore {
  return {
    claim(redemptionId, leaseId, now, claimedUntil) {
      return db.runTransaction(async (tx) => {
        const ref = pitchRef(db, tenantId, redemptionId)
        const snapshot = await tx.get(ref)
        if (!snapshot.exists) return null
        const data = snapshot.data()!
        const processing = data.processing
        const claimablePending =
          processing?.status === "pending" && processing.nextAttemptAt <= now
        const claimableError =
          processing?.status === "error" &&
          processing.automaticRetryAt !== null &&
          processing.automaticRetryAt <= now
        const expiredClaim =
          processing?.status === "processing" && processing.claimedUntil <= now
        if (
          data.reviewStatus !== "processing" ||
          (!claimablePending && !claimableError && !expiredClaim)
        ) {
          return null
        }
        const attempt = Number(processing.attempts ?? 0) + 1
        tx.update(ref, {
          updatedAt: now,
          processing: {
            status: "processing",
            attempts: attempt,
            leaseId,
            claimedAt: now,
            claimedUntil,
          },
        })
        return {
          redemptionId,
          rawText: data.rawText,
          attempt,
          leaseId,
        }
      })
    },
    complete(pitch, review, now) {
      return db.runTransaction(async (tx) => {
        const ref = pitchRef(db, tenantId, pitch.redemptionId)
        const data = (await tx.get(ref)).data()
        if (data?.processing?.leaseId !== pitch.leaseId) return false
        tx.update(ref, {
          reviewStatus: "pending_review",
          extraction: review.extraction,
          destination: review.destination,
          walkingRoute: review.walkingRoute,
          duplicateSuggestions: review.duplicateSuggestions,
          straightLineMeters: review.straightLineMeters,
          processingWarnings: review.warnings,
          publicLabel: review.extraction.publicLabelSuggestion,
          durationMinutes: review.extraction.durationMinutes,
          processing: {
            status: "complete",
            attempts: pitch.attempt,
            completedAt: now,
          },
          updatedAt: now,
        })
        return true
      })
    },
    reject(pitch, reason, now) {
      return db.runTransaction(async (tx) => {
        const ref = pitchRef(db, tenantId, pitch.redemptionId)
        const data = (await tx.get(ref)).data()
        if (data?.processing?.leaseId !== pitch.leaseId) return false
        tx.update(ref, {
          reviewStatus: "rejected",
          rejectionReason: reason,
          redemptionResolution: {
            action: "refund",
            status: "pending",
            attempts: 0,
            nextAttemptAt: now,
          },
          processing: {
            status: "complete",
            attempts: pitch.attempt,
            completedAt: now,
          },
          updatedAt: now,
        })
        return true
      })
    },
    fail(pitch, failure) {
      return db.runTransaction(async (tx) => {
        const ref = pitchRef(db, tenantId, pitch.redemptionId)
        const data = (await tx.get(ref)).data()
        if (data?.processing?.leaseId !== pitch.leaseId) return false
        tx.update(ref, {
          processing: {
            status: "error",
            attempts: pitch.attempt,
            errorCode: failure.code,
            automaticRetryAt: failure.automaticRetryAt,
            failedAt: failure.failedAt,
          },
          updatedAt: failure.failedAt,
        })
        return true
      })
    },
  }
}

function number(value: unknown, field: string) {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new Error(`Invalid processing context: ${field}`)
  }
  return value
}

function object(value: unknown, field: string) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`Invalid processing context: ${field}`)
  }
  return value as Record<string, unknown>
}

export function createPitchContextProvider(db: Firestore, tenantId: string) {
  return {
    async read(): Promise<ProcessingContext> {
      const [settingsSnapshot, locationSnapshot] = await Promise.all([
        db.doc(tenantDoc(tenantId, "settings/current")).get(),
        db.doc(tenantDoc(tenantId, "privateState/location")).get(),
      ])
      if (!settingsSnapshot.exists || !locationSnapshot.exists) {
        throw new Error("Processing settings or private location are missing")
      }
      const settings = settingsSnapshot.data()!
      const location = locationSnapshot.data()!
      const baseZone = object(settings.baseZone, "baseZone")
      return {
        origin: {
          latitude: number(location.latitude, "location.latitude"),
          longitude: number(location.longitude, "location.longitude"),
          observedAt: number(location.observedAt, "location.observedAt"),
        },
        locationConfirmedAt: number(
          location.feedHeartbeatAt ??
            location.receivedAt ??
            location.observedAt,
          "location.confirmedAt"
        ),
        searchRadiusMeters: number(
          settings.searchRadiusMeters,
          "searchRadiusMeters"
        ),
        baseZone: {
          latitude: number(baseZone.latitude, "baseZone.latitude"),
          longitude: number(baseZone.longitude, "baseZone.longitude"),
          radiusMeters: number(baseZone.radiusMeters, "baseZone.radiusMeters"),
        },
        llmEnabled: settings.llmEnabled === true,
        defaultDurationMinutes: number(
          settings.defaultDurationMinutes,
          "defaultDurationMinutes"
        ),
        travelMode: ["walk", "transit", "drive"].includes(
          settings.travelMode
        )
          ? settings.travelMode
          : "walk",
        ...(settings.locationMaxAgeMs === undefined
          ? {}
          : {
              locationMaxAgeMs: number(
                settings.locationMaxAgeMs,
                "locationMaxAgeMs"
              ),
            }),
      }
    },
  }
}

export function createDuplicateSuggester(db: Firestore, tenantId: string) {
  return {
    async suggest(input: {
      redemptionId: string
      destination: { placeId: string; name: string }
    }): Promise<DuplicateSuggestion[]> {
      const snapshot = await db
        .collection(tenantDoc(tenantId, "pitches"))
        .where("destination.placeId", "==", input.destination.placeId)
        .limit(10)
        .get()
      return snapshot.docs
        .map((document) => document.data())
        .filter(
          (data) =>
            data.redemptionId !== input.redemptionId &&
            ["pending_review", "approved"].includes(data.reviewStatus)
        )
        .slice(0, 5)
        .map((data) => ({
          redemptionId: data.redemptionId,
          summary:
            typeof data.extraction?.challenge === "string"
              ? data.extraction.challenge
              : input.destination.name,
        }))
    },
  }
}

export async function findClaimablePitchIds(
  db: Firestore,
  tenantId: string,
  now: number,
  limit = 5
) {
  const snapshots = await Promise.all(
    ["pending", "error", "processing"].map((status) =>
      db
        .collection(tenantDoc(tenantId, "pitches"))
        .where("processing.status", "==", status)
        .limit(20)
        .get()
    )
  )
  return snapshots
    .flatMap((snapshot) => snapshot.docs.map((document) => document.data()))
    .filter((pitch) => {
      const processing = pitch.processing
      if (pitch.reviewStatus !== "processing" || !processing) return false
      if (processing.status === "pending")
        return processing.nextAttemptAt <= now
      if (processing.status === "error") {
        return (
          processing.automaticRetryAt !== null &&
          processing.automaticRetryAt <= now
        )
      }
      return (
        processing.status === "processing" && processing.claimedUntil <= now
      )
    })
    .sort((left, right) => left.createdAt - right.createdAt)
    .slice(0, Math.max(0, Math.min(limit, 5)))
    .flatMap((pitch) =>
      typeof pitch.redemptionId === "string" ? [pitch.redemptionId] : []
    )
}
