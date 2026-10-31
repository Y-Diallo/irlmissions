import "server-only"
import { FieldValue, Timestamp, type Firestore } from "firebase-admin/firestore"
import type {
  AuthStore,
  Handoff,
  TwitchCredentials,
} from "@/shared/auth/twitch"
import { tenantDoc } from "@/shared/tenant"

export function createAuthStore(db: Firestore): AuthStore {
  const ref = (ownerId: string) => db.doc(tenantDoc(ownerId, "private/twitch"))
  return {
    async readTokens(ownerId) {
      const snapshot = await ref(ownerId).get()
      if (!snapshot.exists) return null
      const data = snapshot.data()!
      // Refresh coordination never becomes part of the credential payload.
      const { refreshLease: _lease, ...tokens } = data
      return tokens as TwitchCredentials
    },
    async saveTokens(tokens) {
      const batch = db.batch()
      batch.set(ref(tokens.userId), tokens)
      batch.set(
        db.doc(`owners/${tokens.userId}`),
        {
          twitchUserId: tokens.userId,
          twitchLogin: tokens.login,
          connectionStatus: "connected",
          twitchSetup: { status: "pending", attempts: 0, nextAttemptAt: 0 },
          updatedAt: Date.now(),
        },
        { merge: true }
      )
      await batch.commit()
    },
    async deleteTokens(ownerId, expected) {
      return db.runTransaction(async (tx) => {
        const tokenRef = ref(ownerId)
        const data = (await tx.get(tokenRef)).data()
        if (!data || data.accessToken !== expected) return false
        tx.delete(tokenRef)
        tx.set(
          db.doc(`owners/${ownerId}`),
          { connectionStatus: "disconnected", updatedAt: Date.now() },
          { merge: true }
        )
        return true
      })
    },
    async claimRefresh(ownerId, expected, leaseId, now) {
      return db.runTransaction(async (tx) => {
        const tokenRef = ref(ownerId)
        const data = (await tx.get(tokenRef)).data()
        if (
          !data ||
          data.accessToken !== expected ||
          data.refreshLease?.until > now
        )
          return false
        tx.update(tokenRef, {
          refreshLease: { id: leaseId, until: now + 45000 },
        })
        return true
      })
    },
    async finishRefresh(ownerId, tokens, leaseId) {
      return db.runTransaction(async (tx) => {
        const tokenRef = ref(ownerId)
        const data = (await tx.get(tokenRef)).data()
        if (data?.refreshLease?.id !== leaseId) return false
        tx.set(tokenRef, tokens)
        return true
      })
    },
    async releaseRefresh(ownerId, leaseId) {
      await db.runTransaction(async (tx) => {
        const tokenRef = ref(ownerId)
        const data = (await tx.get(tokenRef)).data()
        if (data?.refreshLease?.id === leaseId)
          tx.update(tokenRef, { refreshLease: FieldValue.delete() })
      })
    },
    async saveHandoff(hash, record) {
      await db.doc(`serverAuthHandoffs/${hash}`).create({
        ...record,
        expiresAt: Timestamp.fromMillis(record.expiresAt),
      })
    },
    async consumeHandoff(hash, now) {
      return db.runTransaction(async (tx) => {
        const handoffRef = db.doc(`serverAuthHandoffs/${hash}`)
        const snapshot = await tx.get(handoffRef)
        if (!snapshot.exists) return null
        tx.delete(handoffRef)
        const data = snapshot.data()!
        const expiresAt = data.expiresAt.toMillis()
        if (expiresAt <= now) return null
        return {
          uid: data.uid,
          connectionId: data.connectionId,
          expiresAt,
        } as Handoff
      })
    },
  }
}
