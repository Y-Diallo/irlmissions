import { describe, expect, it } from "vitest"
import {
  createMapProjection,
  DEFAULT_MAP_LOCATION_MAX_AGE_MS,
  MAX_MAP_ACCURACY_METERS,
} from "@/shared/map"
import type { MissionRecord } from "@/shared/missions"
import type { PollRecord } from "@/shared/polls"

const now = Date.parse("2026-11-01T18:00:00Z")

const destination = {
  placeId: "secret-place",
  name: "Secret Arcade",
  address: "Secret address",
  latitude: 47.61,
  longitude: -122.33,
  publicAccess: true,
  businessStatus: "operational" as const,
  hoursText: ["Open"],
  googleMapsUri: "https://maps.google.com/?cid=secret-place",
  attributions: [],
}

function mission(overrides: Partial<MissionRecord> = {}): MissionRecord {
  return {
    missionId: "mission-1",
    lockId: "mission:1",
    pollId: "poll-1",
    redemptionId: "redemption-1",
    status: "heading",
    publicLabel: "Win at the arcade",
    durationMinutes: 10,
    destination,
    walkingRoute: {
      distanceMeters: 500,
      durationSeconds: 400,
      encodedPolyline: "encoded-route",
    },
    activatedAt: now - 1000,
    updatedAt: now - 1000,
    ...overrides,
  }
}

const poll: PollRecord = {
  attemptId: "private-attempt",
  lockId: "private-lock",
  status: "active",
  title: "What next?",
  durationSeconds: 120,
  choices: [
    { redemptionId: "private-redemption-1", title: "Arcade", votes: 3 },
    { redemptionId: "private-redemption-2", title: "Cafe", votes: 1 },
  ],
  requestedAt: now - 1000,
  updatedAt: now,
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
  it("publishes exact public destinations and live voting data", () => {
    const projection = createMapProjection({
      mission: null,
      poll,
      pollOptions: [
        { title: "Arcade", votes: 3, destination },
        {
          title: "Cafe",
          votes: 1,
          destination: {
            ...destination,
            name: "Demo Cafe",
            latitude: 47.62,
            longitude: -122.31,
          },
        },
      ],
      location: goodLocation,
      now,
    })
    expect(projection).toMatchObject({
      state: "voting",
      position: { latitude: 47.6, longitude: -122.32 },
      options: [
        {
          position: 1,
          title: "Arcade",
          votes: 3,
          destination: {
            name: "Secret Arcade",
            latitude: 47.61,
            longitude: -122.33,
          },
        },
        { position: 2, title: "Cafe", votes: 1 },
      ],
    })
    expect(JSON.stringify(projection)).not.toContain("Secret address")
    expect(JSON.stringify(projection)).not.toContain("secret-place")
    expect(JSON.stringify(projection)).not.toContain("private-redemption")
  })

  it("hides only the position and trail inputs for every privacy reason", () => {
    const cases = [
      { ...goodLocation, privacyBlocked: true },
      {
        ...goodLocation,
        feedHeartbeatAt: now - DEFAULT_MAP_LOCATION_MAX_AGE_MS - 1,
      },
      { ...goodLocation, accuracyMeters: MAX_MAP_ACCURACY_METERS + 1 },
    ]
    for (const location of cases) {
      const projection = createMapProjection({
        mission: mission(),
        location,
        now,
      })
      expect(projection.state).toBe("heading")
      expect(projection.destination).toEqual({
        name: "Secret Arcade",
        latitude: 47.61,
        longitude: -122.33,
      })
      expect(projection).not.toHaveProperty("position")
    }
    expect(
      createMapProjection({
        mission: mission(),
        location: goodLocation,
        manuallyHidden: true,
        now,
      })
    ).not.toHaveProperty("position")
  })

  it("shows heading, arrival, and terminal recap but hides other states", () => {
    expect(
      createMapProjection({ mission: mission(), location: goodLocation, now })
    ).toMatchObject({
      state: "heading",
      destination: { name: "Secret Arcade" },
      encodedRoute: "encoded-route",
    })
    expect(
      createMapProjection({
        mission: mission({ status: "arrived" }),
        location: goodLocation,
        now,
      })
    ).toMatchObject({ state: "arrived" })
    for (const status of ["completed", "failed"] as const) {
      expect(
        createMapProjection({
          mission: mission({ status }),
          location: goodLocation,
          now,
        })
      ).toMatchObject({ state: "recap", outcome: status })
    }
    expect(
      createMapProjection({
        mission: mission({ status: "canceled" }),
        location: goodLocation,
        now,
      })
    ).toEqual({ state: "idle", updatedAt: now })
    expect(
      createMapProjection({ mission: null, location: goodLocation, now })
    ).toEqual({ state: "idle", updatedAt: now })
  })

  it("stays hidden when every poll option and mission is no-travel", () => {
    expect(
      createMapProjection({
        mission: mission({ destination: null, walkingRoute: null }),
        poll,
        pollOptions: poll.choices.map((choice) => ({
          title: choice.title,
          votes: choice.votes,
          destination: null,
        })),
        location: goodLocation,
        now,
      })
    ).toEqual({ state: "idle", updatedAt: now })
  })
})
