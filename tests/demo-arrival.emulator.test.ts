// "Arrive by GPS" must survive the demo's 10s location heartbeat landing
// mid-arrival. Opted into by test:emulators, like the other emulator tests.
import { describe, expect, it } from "vitest"
import { initializeApp, deleteApp } from "firebase-admin/app"
import { getFirestore } from "firebase-admin/firestore"
import { runDevAction } from "@/lib/dev/simulator"
import { createMissionFromPick } from "@/shared/missions"
import { DEV_PITCH_PRESETS } from "@/shared/dev"
import { tenantDoc } from "@/shared/tenant"
import { eventSubStorageId } from "@/shared/eventsub"
import { createMissionStore } from "@/lib/missions/store"

describe.runIf(process.env.RUN_EMULATOR_TESTS === "true")(
  "demo arrival by GPS",
  () => {
    it.each([1, 2, 3, 4, 5])(
      "arrives with heartbeats mid-flight (%i)",
      async (run) => {
        const app = initializeApp(
          { projectId: "demo-irlmissions" },
          `demo-arrival-${run}`
        )
        const db = getFirestore(app)
        const tenantId = `demo-arrival-test-${run}`
        const now = Date.now()
        await db.recursiveDelete(db.doc(`owners/${tenantId}`))
        // Seed settings and location the way the demo does.
        await runDevAction(db, tenantId, { action: "keep_alive" }, now - 20_000)
        await db.doc(tenantDoc(tenantId, "settings/current")).set(
          {
            searchRadiusMeters: 5000,
            locationMaxAgeMs: 120_000,
            arrivalLocationMaxAgeMs: 30_000,
            arrivalRadiusMeters: 50,
            arrivalSampleSpanMs: 10_000,
            baseZone: {
              latitude: 37.7535,
              longitude: -122.4955,
              radiusMeters: 150,
            },
          },
          { merge: true }
        )
        const place = DEV_PITCH_PRESETS.safe.place
        const mission = createMissionFromPick(
          {
            redemptionId: "r1",
            reviewStatus: "approved",
            publicLabel: "Win Tic-Tac-Toe at Market",
            durationMinutes: 10,
            destination: {
              placeId: "demo-place-safe",
              name: place.name,
              address: place.address,
              latitude: place.latitude,
              longitude: place.longitude,
              publicAccess: true,
              businessStatus: "operational",
              hoursText: [place.hours],
              googleMapsUri: "https://maps.google.com",
              attributions: [],
            },
            walkingRoute: { distanceMeters: 1000, durationSeconds: 700 },
          },
          now - 15_000
        )
        await db.doc(tenantDoc(tenantId, "sessions/current")).set({ mission })
        // A keep-alive beat lands just before the click, as it does every 10s.
        await runDevAction(db, tenantId, { action: "keep_alive" }, now - 1000)

        // Heartbeats land mid-arrival, with a slightly later server clock.
        const beats = [5, 40, 120, 250].map(
          (delay) =>
            new Promise((resolve) =>
              setTimeout(
                () =>
                  resolve(
                    runDevAction(
                      db,
                      tenantId,
                      { action: "keep_alive" },
                      now + delay
                    )
                  ),
                delay
              )
            )
        )
        await runDevAction(db, tenantId, { action: "arrive" }, now)
        await Promise.all(beats)
        const after = (
          await db.doc(tenantDoc(tenantId, "sessions/current")).get()
        ).data()?.mission
        await db.recursiveDelete(db.doc(`owners/${tenantId}`))
        await deleteApp(app)
        expect(after?.status).toBe("arrived")
      },
      30_000
    )

    // A new mission must not inherit the last one's reveal and arrival.
    it("arrives on back-to-back missions", async () => {
      const app = initializeApp(
        { projectId: "demo-irlmissions" },
        "demo-arrival-sequence"
      )
      const db = getFirestore(app)
      const tenantId = "demo-arrival-sequence"
      const sessionRef = db.doc(tenantDoc(tenantId, "sessions/current"))
      const statuses: string[] = []
      try {
        await runDevAction(db, tenantId, { action: "reset" })
        for (const preset of ["safe", "coit"] as const) {
          const { redemptionId } = (await runDevAction(db, tenantId, {
            action: "inject_pitch",
            preset,
          })) as { redemptionId: string }
          await db
            .doc(
              tenantDoc(tenantId, `pitches/${eventSubStorageId(redemptionId)}`)
            )
            .update({ reviewStatus: "approved" })
          await createMissionStore(db, tenantId).pick(redemptionId, Date.now())
          await runDevAction(db, tenantId, { action: "arrive" })
          statuses.push((await sessionRef.get()).data()?.mission?.status)
          await createMissionStore(db, tenantId).act("complete", Date.now())
        }
      } finally {
        await db.recursiveDelete(db.doc(`owners/${tenantId}`))
        await deleteApp(app)
      }
      expect(statuses).toEqual(["arrived", "arrived"])
    }, 30_000)
  }
)
