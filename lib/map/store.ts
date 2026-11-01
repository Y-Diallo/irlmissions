import "server-only"

import type { Firestore } from "firebase-admin/firestore"
import { createMapProjection } from "@/shared/map"
import type { MissionRecord } from "@/shared/missions"
import { tenantDoc } from "@/shared/tenant"

export async function readMapProjection(
  db: Firestore,
  tenantId: string,
  now = Date.now()
) {
  const [session, location, settings] = await Promise.all([
    db.doc(tenantDoc(tenantId, "sessions/current")).get(),
    db.doc(tenantDoc(tenantId, "privateState/location")).get(),
    db.doc(tenantDoc(tenantId, "settings/current")).get(),
  ])
  const mission = session.data()?.mission
  return createMapProjection({
    mission:
      mission && typeof mission === "object"
        ? (mission as MissionRecord)
        : null,
    location: location.exists ? location.data()! : null,
    now,
    locationMaxAgeMs:
      typeof settings.data()?.locationMaxAgeMs === "number"
        ? settings.data()!.locationMaxAgeMs
        : undefined,
    manuallyCoarse: settings.data()?.mapCoarseMode === true,
  })
}
