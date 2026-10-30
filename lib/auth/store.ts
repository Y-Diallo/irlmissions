import "server-only"
import { FieldValue, Timestamp, type Firestore } from "firebase-admin/firestore"
import type {
  AuthStore,
  Handoff,
  TwitchCredentials,
} from "@/shared/auth/twitch"

export function createAuthStore(db: Firestore): AuthStore {
  const ref = db.doc("server/twitch")
  return {
    async readTokens() {
      const snapshot = await ref.get()
      if (!snapshot.exists) return null
      const data = snapshot.data()!
      // Refresh coordination never becomes part of the credential payload.
      const { refreshLease: _lease, ...tokens } = data
      return tokens as TwitchCredentials
    },
    async saveTokens(tokens) {
      await ref.set(tokens)
    },
    async deleteTokens(expected) {
      return db.runTransaction(async (tx) => {
        const data = (await tx.get(ref)).data()
        if (!data || data.accessToken !== expected) return false
        tx.delete(ref)
        return true
      })
    },
    async claimRefresh(expected, leaseId, now) {
      return db.runTransaction(async (tx) => {
        const data = (await tx.get(ref)).data()
        if (
          !data ||
          data.accessToken !== expected ||
          data.refreshLease?.until > now
        )
          return false
        tx.update(ref, { refreshLease: { id: leaseId, until: now + 45000 } })
        return true
      })
    },
    async finishRefresh(tokens, leaseId) {
      return db.runTransaction(async (tx) => {
        const data = (await tx.get(ref)).data()
        if (data?.refreshLease?.id !== leaseId) return false
        tx.set(ref, tokens)
        return true
      })
    },
    async releaseRefresh(leaseId) {
      await db.runTransaction(async (tx) => {
        const data = (await tx.get(ref)).data()
        if (data?.refreshLease?.id === leaseId)
          tx.update(ref, { refreshLease: FieldValue.delete() })
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
