import "server-only"

import { FieldPath, type Firestore } from "firebase-admin/firestore"
import { getServerFirebase } from "@/lib/firebase/admin"
import { runClaimablePitches } from "@/lib/pitches/runner"
import { processTenantTwitchSetup } from "@/lib/integrations/twitch-setup"

const TENANT_LIMIT = 3
const WORK_PER_TENANT = 2

async function nextTenantIds(db: Firestore) {
  const cursorRef = db.doc("processorState/current")
  const cursor = (await cursorRef.get()).data()?.afterTenantId
  let query = db
    .collection("owners")
    .where("connectionStatus", "==", "connected")
    .orderBy(FieldPath.documentId())
    .limit(TENANT_LIMIT)
  if (typeof cursor === "string" && cursor) query = query.startAfter(cursor)
  let snapshot = await query.get()
  if (snapshot.empty && cursor) {
    snapshot = await db
      .collection("owners")
      .where("connectionStatus", "==", "connected")
      .orderBy(FieldPath.documentId())
      .limit(TENANT_LIMIT)
      .get()
  }
  const ids = snapshot.docs.map((document) => document.id)
  if (ids.length) {
    await cursorRef.set(
      { afterTenantId: ids.at(-1), updatedAt: Date.now() },
      { merge: true }
    )
  }
  return ids
}

export async function runScheduledTenants() {
  const { db } = getServerFirebase()
  const tenantIds = await nextTenantIds(db)
  const results = []
  for (const tenantId of tenantIds) {
    try {
      await processTenantTwitchSetup(tenantId)
      results.push({
        tenantId,
        status: "processed" as const,
        summary: await runClaimablePitches(tenantId, WORK_PER_TENANT),
      })
    } catch {
      results.push({ tenantId, status: "error" as const })
    }
  }
  return {
    tenantsScanned: tenantIds.length,
    tenantsProcessed: results.filter((result) => result.status === "processed")
      .length,
    tenantErrors: results.filter((result) => result.status === "error").length,
  }
}
