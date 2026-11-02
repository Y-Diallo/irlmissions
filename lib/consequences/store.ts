import "server-only"
import { randomUUID } from "node:crypto"
import type { Firestore, Transaction } from "firebase-admin/firestore"
import {
  applyConsequenceCommand,
  clearConsequence,
  consequenceDocId,
  ConsequenceError,
  consequenceFromFailure,
  consequencesClearedBy,
  ownerConsequences,
  publicConsequences,
  type ConsequenceCommand,
  type ConsequenceEvent,
  type ConsequenceRecord,
} from "@/shared/consequences"
import type { MissionRecord } from "@/shared/missions"
import { tenantDoc } from "@/shared/tenant"

function refs(db: Firestore, tenantId: string) {
  return {
    collection: db.collection(
      tenantDoc(tenantId, "sessions/current/consequences")
    ),
    publicRef: db.doc(tenantDoc(tenantId, "publicState/consequences")),
  }
}

/** Read inside a transaction, before any of its writes. */
export async function readOwedConsequences(
  tx: Transaction,
  db: Firestore,
  tenantId: string
) {
  const snapshot = await tx.get(
    refs(db, tenantId).collection.where("status", "==", "owed")
  )
  return snapshot.docs.map((document) => document.data() as ConsequenceRecord)
}

// Applies an event's clearing rules, any owner edits and a newly activated
// consequence, writes each changed document, and republishes the public
// list. Call after every read in the transaction.
export function settleConsequences(
  tx: Transaction,
  db: Firestore,
  tenantId: string,
  owed: ConsequenceRecord[],
  changes: {
    event?: ConsequenceEvent
    edited?: ConsequenceRecord
    failedMission?: MissionRecord
  },
  now: number
) {
  const { collection, publicRef } = refs(db, tenantId)
  const records = new Map(owed.map((record) => [record.consequenceId, record]))
  if (changes.edited) {
    records.set(changes.edited.consequenceId, changes.edited)
  }
  for (const { consequenceId, reason } of consequencesClearedBy(
    changes.event ?? { type: "sweep" },
    [...records.values()],
    now
  )) {
    records.set(
      consequenceId,
      clearConsequence(records.get(consequenceId)!, reason, now)
    )
  }
  const created = changes.failedMission
    ? consequenceFromFailure(changes.failedMission, randomUUID(), now)
    : null
  if (created) records.set(created.consequenceId, created)

  const original = new Map(owed.map((record) => [record.consequenceId, record]))
  for (const record of records.values()) {
    if (original.get(record.consequenceId) === record) continue
    tx.set(collection.doc(consequenceDocId(record.consequenceId)), record)
  }
  tx.set(publicRef, {
    items: publicConsequences([...records.values()], now),
    updatedAt: now,
  })
  return ownerConsequences([...records.values()], now)
}

export function createConsequenceStore(db: Firestore, tenantId: string) {
  return {
    list(now: number) {
      return db.runTransaction(async (tx) => {
        const owed = await readOwedConsequences(tx, db, tenantId)
        // Expired timers get their cleared status here too.
        const expired = owed.some(
          (record) => record.endsAt !== undefined && record.endsAt <= now
        )
        return expired
          ? settleConsequences(tx, db, tenantId, owed, {}, now)
          : ownerConsequences(owed, now)
      })
    },

    command(consequenceId: string, command: ConsequenceCommand, now: number) {
      return db.runTransaction(async (tx) => {
        const owed = await readOwedConsequences(tx, db, tenantId)
        const target = owed.find(
          (record) => record.consequenceId === consequenceId
        )
        if (!target) throw new ConsequenceError("consequence_not_found", 404)
        return settleConsequences(
          tx,
          db,
          tenantId,
          owed,
          { edited: applyConsequenceCommand(target, command, now) },
          now
        )
      })
    },
  }
}
