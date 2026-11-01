import { describe, expect, it } from "vitest"
import { transitionMission, type MissionRecord } from "@/shared/missions"
import {
  evaluateRealtimeIrlArrival,
  evaluateRealtimeIrlHeartbeat,
  parseArrivalSettings,
  parseRealtimeIrlSample,
  type ArrivalConfirmation,
} from "@/shared/realtimeirl"

const now = Date.parse("2026-10-30T23:00:00Z")
const destination = { latitude: 37.78, longitude: -122.41 }

function mission(): MissionRecord {
  return {
    missionId: "mission-1",
    lockId: "mission:mission-1",
    pollId: "poll-1",
    redemptionId: "redemption-1",
    status: "heading",
    publicLabel: "Mystery food challenge",
    durationMinutes: 10,
    destination: {
      ...destination,
      placeId: "place-1",
      name: "Sample Cafe",
      address: "123 Test Street",
      publicAccess: true,
      businessStatus: "operational",
      hoursText: null,
      googleMapsUri: "https://maps.google.com/?cid=place-1",
      attributions: [],
    },
    walkingRoute: { distanceMeters: 800, durationSeconds: 600 },
    activatedAt: now - 60_000,
    updatedAt: now - 60_000,
  }
}

const settings = parseArrivalSettings({
  baseZone: {
    latitude: 37.7,
    longitude: -122.5,
    radiusMeters: 100,
  },
})

function evaluate(input?: {
  observedAt?: number
  latitude?: number
  longitude?: number
  current?: MissionRecord | null
  confirmation?: ArrivalConfirmation | null
  latestObservedAt?: number
}) {
  return evaluateRealtimeIrlArrival({
    sample: {
      ...destination,
      observedAt: input?.observedAt ?? now,
      ...(input?.latitude === undefined ? {} : { latitude: input.latitude }),
      ...(input?.longitude === undefined ? {} : { longitude: input.longitude }),
    },
    now,
    settings,
    mission: input?.current === undefined ? mission() : input.current,
    confirmation: input?.confirmation ?? null,
    latestObservedAt: input?.latestObservedAt,
  })
}

describe("RealtimeIRL arrival policy", () => {
  it("uses conservative defaults and validates incoming coordinates", () => {
    expect(settings).toMatchObject({
      arrivalRadiusMeters: 50,
      arrivalSampleSpanMs: 10_000,
      locationMaxAgeMs: 30_000,
    })
    expect(
      parseRealtimeIrlSample({
        latitude: 1,
        longitude: 2,
        observedAt: now,
      })
    ).toEqual({ latitude: 1, longitude: 2, observedAt: now })
    expect(() =>
      parseRealtimeIrlSample({ latitude: 91, longitude: 2, observedAt: now })
    ).toThrow("invalid_location_sample")
  })

  it("does not save stale or future samples as current location", () => {
    expect(evaluate({ observedAt: now - 30_001 })).toMatchObject({
      status: "stale",
      fresh: false,
    })
    expect(evaluate({ observedAt: now + 5_001 })).toMatchObject({
      status: "stale",
      fresh: false,
    })
  })

  it("does not let duplicate or reordered callbacks regress location", () => {
    expect(evaluate({ latestObservedAt: now })).toMatchObject({
      status: "duplicate",
      fresh: false,
    })
    expect(
      evaluate({ observedAt: now - 1, latestObservedAt: now })
    ).toMatchObject({ status: "duplicate", fresh: false })
  })

  it("updates private location without arriving when there is no mission", () => {
    const decision = evaluate({ current: null })
    expect(decision).toMatchObject({
      status: "no_active_mission",
      fresh: true,
    })
    expect(decision).not.toHaveProperty("mission")
  })

  it("blocks destination reveal and clears confirmation inside the base zone", () => {
    expect(evaluate({ latitude: 37.7, longitude: -122.5 })).toMatchObject({
      status: "privacy_zone",
      privacyBlocked: true,
      nextConfirmation: null,
    })
  })

  it("clears confirmation when the streamer leaves the arrival radius", () => {
    expect(
      evaluate({
        latitude: 37.79,
        longitude: -122.41,
        confirmation: {
          missionId: "mission-1",
          firstObservedAt: now - 5_000,
          lastObservedAt: now - 5_000,
        },
      })
    ).toMatchObject({
      status: "outside_destination",
      nextConfirmation: null,
    })
  })

  it("needs two distinct fresh near samples spanning ten seconds", () => {
    const first = evaluate({ observedAt: now - 10_000 })
    expect(first).toMatchObject({ status: "confirming" })
    const duplicate = evaluate({
      observedAt: now - 10_000,
      confirmation: first.nextConfirmation,
    })
    expect(duplicate).toMatchObject({ status: "confirming" })
    expect(duplicate).not.toHaveProperty("mission")
    const confirmed = evaluate({ confirmation: first.nextConfirmation })
    expect(confirmed).toMatchObject({
      status: "arrived",
      mission: {
        status: "arrived",
        arrivedAt: now,
        timerEndsAt: now + 600_000,
        destinationRevealedAt: now,
      },
    })
  })

  it("cannot reuse a confirmation sample that is no longer fresh", () => {
    expect(
      evaluate({
        confirmation: {
          missionId: "mission-1",
          firstObservedAt: now - 30_001,
          lastObservedAt: now - 30_001,
        },
      })
    ).toMatchObject({
      status: "confirming",
      nextConfirmation: { firstObservedAt: now, lastObservedAt: now },
    })
  })

  it("privacy-checks reveal after manual arrival without restarting its timer", () => {
    const manual = transitionMission(mission(), "arrive", now - 20_000)
    const decision = evaluate({
      current: manual,
      confirmation: {
        missionId: "mission-1",
        firstObservedAt: now - 10_000,
        lastObservedAt: now - 10_000,
      },
    })
    expect(decision).toMatchObject({
      status: "revealed",
      mission: {
        arrivedAt: now - 20_000,
        timerEndsAt: now + 580_000,
        destinationRevealedAt: now,
      },
    })
  })

  it("uses an online-feed heartbeat to confirm a stationary arrival", () => {
    const first = evaluate({ observedAt: now - 10_000 })
    expect(
      evaluateRealtimeIrlHeartbeat({
        location: destination,
        now,
        settings,
        mission: mission(),
        confirmation: first.nextConfirmation,
      })
    ).toMatchObject({
      status: "arrived",
      mission: { status: "arrived", arrivedAt: now },
    })
  })
})
