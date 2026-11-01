import "server-only"

import type { Firestore } from "firebase-admin/firestore"
import { eventSubStorageId } from "@/shared/eventsub"
import { createMapProjection, type MapPitchOption } from "@/shared/map"
import type { MissionRecord } from "@/shared/missions"
import type { ReviewRecord } from "@/shared/pitches/review"
import type { PollRecord } from "@/shared/polls"
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
  const sessionData = session.data()
  const mission = sessionData?.mission
  const poll = sessionData?.poll as PollRecord | undefined
  const optionSnapshots =
    poll && (poll.status === "active" || poll.status === "tie")
      ? await Promise.all(
          poll.choices.map((choice) =>
            db
              .doc(
                tenantDoc(
                  tenantId,
                  `pitches/${eventSubStorageId(choice.redemptionId)}`
                )
              )
              .get()
          )
        )
      : []
  const pollOptions: MapPitchOption[] = optionSnapshots.map(
    (snapshot, index) => {
      const pitch = snapshot.data() as ReviewRecord | undefined
      const choice = poll!.choices[index]!
      return {
        title: choice.title,
        votes: choice.votes ?? 0,
        destination: pitch?.destination ?? null,
      }
    }
  )
  return createMapProjection({
    mission:
      mission && typeof mission === "object"
        ? (mission as MissionRecord)
        : null,
    poll: poll ?? null,
    pollOptions,
    location: location.exists ? location.data()! : null,
    now,
    locationMaxAgeMs:
      typeof settings.data()?.arrivalLocationMaxAgeMs === "number"
        ? settings.data()!.arrivalLocationMaxAgeMs
        : undefined,
    manuallyHidden: settings.data()?.mapCoarseMode === true,
  })
}
