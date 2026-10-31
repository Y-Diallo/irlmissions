import "server-only"

import type { Firestore } from "firebase-admin/firestore"
import { eventSubStorageId } from "@/shared/eventsub"
import type {
  ClaimedRedemption,
  RedemptionAction,
  RedemptionResolution,
  RedemptionStore,
} from "@/shared/redemptions"
import { tenantDoc } from "@/shared/tenant"

function pitchRef(db: Firestore, tenantId: string, redemptionId: string) {
  return db.doc(
    tenantDoc(tenantId, `pitches/${eventSubStorageId(redemptionId)}`)
  )
}

function resolution(data: FirebaseFirestore.DocumentData | undefined) {
  const value = data?.redemptionResolution
  return value && typeof value === "object"
    ? (value as RedemptionResolution)
    : null
}

export function createRedemptionStore(
  db: Firestore,
  tenantId: string
): RedemptionStore {
  return {
    claim(redemptionId, leaseId, now, claimedUntil) {
      return db.runTransaction(async (tx) => {
        const ref = pitchRef(db, tenantId, redemptionId)
        const snapshot = await tx.get(ref)
        if (!snapshot.exists) return null
        const data = snapshot.data()!
        const current = resolution(data)
        if (!current) return null
        const pending =
          current.status === "pending" && (current.nextAttemptAt ?? 0) <= now
        const retry =
          current.status === "error" &&
          current.automaticRetryAt !== null &&
          (current.automaticRetryAt ?? 0) <= now
        const expired =
          current.status === "processing" && (current.claimedUntil ?? 0) <= now
        if (!pending && !retry && !expired) return null
        const rewardId = data.reward?.id
        if (typeof rewardId !== "string" || !rewardId) return null
        const attempt = Number(current.attempts ?? 0) + 1
        const action = current.action as RedemptionAction
        if (action !== "refund" && action !== "fulfill") return null
        const next: RedemptionResolution = {
          action,
          status: "processing",
          attempts: attempt,
          leaseId,
          claimedAt: now,
          claimedUntil,
        }
        tx.update(ref, { redemptionResolution: next, updatedAt: now })
        return { redemptionId, rewardId, action, attempt, leaseId }
      })
    },
    complete(claim, now) {
      return db.runTransaction(async (tx) => {
        const ref = pitchRef(db, tenantId, claim.redemptionId)
        const snapshot = await tx.get(ref)
        const current = resolution(snapshot.data())
        if (
          !snapshot.exists ||
          current?.status !== "processing" ||
          current.leaseId !== claim.leaseId
        ) {
          return false
        }
        tx.update(ref, {
          redemptionStatus:
            claim.action === "refund" ? "canceled" : "fulfilled",
          redemptionResolution: {
            action: claim.action,
            status: "complete",
            attempts: claim.attempt,
            completedAt: now,
          },
          updatedAt: now,
        })
        return true
      })
    },
    fail(claim, failure) {
      return db.runTransaction(async (tx) => {
        const ref = pitchRef(db, tenantId, claim.redemptionId)
        const snapshot = await tx.get(ref)
        const current = resolution(snapshot.data())
        if (
          !snapshot.exists ||
          current?.status !== "processing" ||
          current.leaseId !== claim.leaseId
        ) {
          return false
        }
        tx.update(ref, {
          redemptionResolution: {
            action: claim.action,
            status: "error",
            attempts: claim.attempt,
            errorCode: failure.code,
            automaticRetryAt: failure.automaticRetryAt,
          },
          updatedAt: failure.failedAt,
        })
        return true
      })
    },
  }
}

export async function findClaimableRedemptionIds(
  db: Firestore,
  tenantId: string,
  now: number,
  limit = 5
) {
  const snapshots = await Promise.all(
    ["pending", "error", "processing"].map((status) =>
      db
        .collection(tenantDoc(tenantId, "pitches"))
        .where("redemptionResolution.status", "==", status)
        .limit(20)
        .get()
    )
  )
  return snapshots
    .flatMap((snapshot) => snapshot.docs.map((document) => document.data()))
    .filter((pitch) => {
      const current = resolution(pitch)
      if (!current) return false
      if (current.status === "pending")
        return (current.nextAttemptAt ?? 0) <= now
      if (current.status === "error") {
        return (
          current.automaticRetryAt !== null &&
          (current.automaticRetryAt ?? 0) <= now
        )
      }
      return (current.claimedUntil ?? 0) <= now
    })
    .map((pitch) => pitch.redemptionId)
    .filter((id): id is string => typeof id === "string")
    .slice(0, Math.max(0, Math.min(limit, 5)))
}
