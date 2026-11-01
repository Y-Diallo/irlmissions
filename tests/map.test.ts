import { describe, expect, it } from "vitest"
import { createMapProjection, MAX_MAP_ACCURACY_METERS } from "@/shared/map"
import type { MissionRecord } from "@/shared/missions"

const now = Date.parse("2026-11-01T18:00:00Z")

function mission(overrides: Partial<MissionRecord> = {}): MissionRecord {
  return {
    missionId: "mission-random-seed",
    lockId: "mission:1",
    pollId: "poll-1",
    redemptionId: "redemption-1",
    status: "heading",
    publicLabel: "Win at the arcade",
    durationMinutes: 10,
    destination: {
      placeId: "secret-place",
      name: "Secret Arcade",
      address: "Secret address",
      latitude: 47.61,
      longitude: -122.33,
      publicAccess: true,
      businessStatus: "operational",
      hoursText: ["Open"],
      googleMapsUri: "https://maps.google.com/?cid=secret-place",
      attributions: [],
    },
    walkingRoute: { distanceMeters: 500, durationSeconds: 400 },
    activatedAt: now - 1000,
    updatedAt: now - 1000,
    ...overrides,
  }
}

const goodLocation = {
  latitude: 47.6,
  longitude: -122.32,
  observedAt: now - 1000,
  receivedAt: now - 900,
  feedHeartbeatAt: now - 500,
  accuracyMeters: 12,
  privacyBlocked: false,
}

describe("public map projection", () => {
  it("publishes only an active position and fuzzy destination", () => {
    const projection = createMapProjection({
      mission: mission(),
      location: goodLocation,
      now,
    })
    expect(projection).toMatchObject({
      state: "heading",
      position: { latitude: 47.6, longitude: -122.32 },
      destination: { radiusMeters: expect.any(Number) },
    })
    expect(projection.destination?.latitude).not.toBe(47.61)
    expect(projection.destination?.longitude).not.toBe(-122.33)
    expect(projection.destination).not.toHaveProperty("name")
    expect(JSON.stringify(projection)).not.toContain("Secret address")
    expect(JSON.stringify(projection)).not.toContain("secret-place")
  })

  it("uses one indistinguishable coarse state for every suppression reason", () => {
    const cases = [
      { ...goodLocation, privacyBlocked: true },
      { ...goodLocation, feedHeartbeatAt: now - 999_999 },
      { ...goodLocation, accuracyMeters: MAX_MAP_ACCURACY_METERS + 1 },
    ]
    for (const location of cases) {
      expect(
        createMapProjection({ mission: mission(), location, now })
      ).toMatchObject({ positionStatus: "coarse" })
    }
    expect(
      createMapProjection({
        mission: mission(),
        location: goodLocation,
        manuallyCoarse: true,
        now,
      })
    ).toMatchObject({ positionStatus: "coarse" })
  })

  it("reveals the name only after arrival and hides every other state", () => {
    expect(
      createMapProjection({
        mission: mission({
          status: "arrived",
          destinationRevealedAt: now,
          arrivedAt: now,
          timerEndsAt: now + 600_000,
        }),
        location: goodLocation,
        now,
      }).destination?.name
    ).toBe("Secret Arcade")
    for (const status of ["completed", "failed", "canceled"] as const) {
      expect(
        createMapProjection({
          mission: mission({ status }),
          location: goodLocation,
          now,
        })
      ).toEqual({ state: "idle", updatedAt: now })
    }
  })

  it("keeps fuzz stable within a mission but varies it across missions", () => {
    const first = createMapProjection({
      mission: mission(),
      location: goodLocation,
      now,
    }).destination
    const repeat = createMapProjection({
      mission: mission(),
      location: goodLocation,
      now: now + 1000,
    }).destination
    const next = createMapProjection({
      mission: mission({ missionId: "another-stream-session" }),
      location: goodLocation,
      now,
    }).destination
    expect(repeat).toEqual(first)
    expect(next).not.toEqual(first)
  })
})
