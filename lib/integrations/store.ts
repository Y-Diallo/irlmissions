import "server-only"

import { FieldValue, type Firestore } from "firebase-admin/firestore"
import { tenantDoc } from "@/shared/tenant"

const LEASE_MS = 2 * 60 * 1000

export function createIntegrationStore(db: Firestore, tenantId: string) {
  const ownerRef = db.doc(`owners/${tenantId}`)
  const integrationRef = db.doc(
    tenantDoc(tenantId, "private/integrations")
  )
  return {
    async read() {
      return (await integrationRef.get()).data() ?? null
    },
    claimSetup(leaseId: string, now: number) {
      return db.runTransaction(async (tx) => {
        const [owner, integration] = await Promise.all([
          tx.get(ownerRef),
          tx.get(integrationRef),
        ])
        const setup = owner.data()?.twitchSetup
        if (
          !owner.exists ||
          (setup?.status !== "pending" &&
            setup?.status !== "error" &&
            !(setup?.status === "processing" && setup.claimedUntil <= now)) ||
          (setup?.status === "error" && setup.nextAttemptAt > now)
        ) {
          return null
        }
        const attempts = Number(setup?.attempts ?? 0) + 1
        tx.set(
          ownerRef,
          {
            twitchSetup: {
              status: "processing",
              attempts,
              leaseId,
              claimedUntil: now + LEASE_MS,
            },
            updatedAt: now,
          },
          { merge: true }
        )
        return {
          attempts,
          storedRewardId:
            typeof integration.data()?.rewardId === "string"
              ? integration.data()!.rewardId
              : undefined,
        }
      })
    },
    completeSetup(
      leaseId: string,
      reward: { id: string; title: string },
      now: number
    ) {
      return db.runTransaction(async (tx) => {
        const owner = await tx.get(ownerRef)
        if (owner.data()?.twitchSetup?.leaseId !== leaseId) return false
        tx.set(
          integrationRef,
          { rewardId: reward.id, rewardTitle: reward.title, updatedAt: now },
          { merge: true }
        )
        tx.set(
          ownerRef,
          {
            twitchSetup: {
              status: "ready",
              attempts: owner.data()?.twitchSetup?.attempts ?? 1,
              completedAt: now,
            },
            updatedAt: now,
          },
          { merge: true }
        )
        return true
      })
    },
    saveProvisionedReward(
      leaseId: string,
      reward: { id: string; title: string },
      now: number
    ) {
      return db.runTransaction(async (tx) => {
        const owner = await tx.get(ownerRef)
        if (owner.data()?.twitchSetup?.leaseId !== leaseId) return false
        tx.set(
          integrationRef,
          { rewardId: reward.id, rewardTitle: reward.title, updatedAt: now },
          { merge: true }
        )
        return true
      })
    },
    failSetup(leaseId: string, code: string, now: number) {
      return db.runTransaction(async (tx) => {
        const owner = await tx.get(ownerRef)
        const setup = owner.data()?.twitchSetup
        if (setup?.leaseId !== leaseId) return false
        const attempts = Number(setup.attempts ?? 1)
        tx.set(
          ownerRef,
          {
            twitchSetup: {
              status: "error",
              attempts,
              errorCode: code,
              nextAttemptAt: now + Math.min(60_000 * 2 ** attempts, 900_000),
            },
            updatedAt: now,
          },
          { merge: true }
        )
        return true
      })
    },
    async saveRealtimeIrlPullKey(pullKey: string | null, now: number) {
      await integrationRef.set(
        {
          realtimeIrlPullKey: pullKey ?? FieldValue.delete(),
          updatedAt: now,
        },
        { merge: true }
      )
    },
    async retrySetup(now: number) {
      await ownerRef.set(
        {
          twitchSetup: { status: "pending", attempts: 0, nextAttemptAt: now },
          updatedAt: now,
        },
        { merge: true }
      )
    },
  }
}
