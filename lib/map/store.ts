import "server-only"

import type { Firestore } from "firebase-admin/firestore"
import { isDemoTenant } from "@/shared/auth/demo-owner"
import { readServerConfig } from "@/shared/config"
import { eventSubStorageId } from "@/shared/eventsub"
import { createMapProjection, type MapPitchOption } from "@/shared/map"
import type { MissionRecord } from "@/shared/missions"
import type { TravelMode } from "@/shared/pitches/processor"
import { createFakePitchProviders } from "@/shared/providers/fake-pitch"
import {
  createGoogleRoutesProvider,
  readGoogleMapsConfig,
} from "@/shared/providers/google-maps"
import { ensurePollRoutes, type RouteWalker } from "@/lib/map/poll-routes"
import type { ReviewRecord } from "@/shared/pitches/review"
import type { PollRecord } from "@/shared/polls"
import { tenantDoc } from "@/shared/tenant"

const googleWalk: RouteWalker = (origin, destination, mode) =>
  createGoogleRoutesProvider(readGoogleMapsConfig(process.env)).walk(
    origin,
    destination,
    mode
  )

// The demo account and emulator never call Google; they get scripted routes.
function defaultWalk(tenantId: string): RouteWalker {
  if (
    readServerConfig(process.env).mode !== "emulator" &&
    !isDemoTenant(tenantId)
  ) {
    return googleWalk
  }
  const { routes } = createFakePitchProviders()
  return (origin, destination, mode) => routes.walk(origin, destination, mode)
}

export async function readMapProjection(
  db: Firestore,
  tenantId: string,
  now = Date.now(),
  walk: RouteWalker = defaultWalk(tenantId)
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
  const project = (options: MapPitchOption[]) =>
    createMapProjection({
      mission:
        mission && typeof mission === "object"
          ? (mission as MissionRecord)
          : null,
      poll: poll ?? null,
      pollOptions: options,
      location: location.exists ? location.data()! : null,
      now,
      locationMaxAgeMs:
        typeof settings.data()?.arrivalLocationMaxAgeMs === "number"
          ? settings.data()!.arrivalLocationMaxAgeMs
          : undefined,
      manuallyHidden: settings.data()?.mapCoarseMode === true,
    })
  const projection = project(pollOptions)
  // Routes start at the streamer, so fetch them only when the position is
  // already public on this map.
  if (projection.state !== "voting" || !projection.position || !poll) {
    return projection
  }
  const destinations = optionSnapshots.flatMap((snapshot, index) => {
    const destination = (snapshot.data() as ReviewRecord | undefined)
      ?.destination
    return destination
      ? [{ redemptionId: poll.choices[index]!.redemptionId, destination }]
      : []
  })
  const travelMode = settings.data()?.travelMode
  const routes = await ensurePollRoutes(
    db,
    tenantId,
    {
      attemptId: poll.attemptId,
      origin: projection.position,
      mode: (["walk", "transit", "drive"] as const).includes(travelMode)
        ? (travelMode as TravelMode)
        : "walk",
      destinations,
    },
    walk,
    now
  ).catch(() => ({}) as Record<string, string>)
  return project(
    pollOptions.map((option, index) => {
      const route = routes[poll.choices[index]!.redemptionId]
      return route ? { ...option, route } : option
    })
  )
}
