import { describe, expect, it } from "vitest"
import { parseSetupAction, parseSetupUpdate } from "@/shared/setup"

describe("tenant setup input", () => {
  it("accepts bounded private settings", () => {
    expect(
      parseSetupUpdate({
        realtimeIrlPullKey: "private-pull-key",
        searchRadiusMeters: 5000,
        defaultDurationMinutes: 10,
        travelMode: "transit",
        arrivalRadiusMeters: 50,
        llmEnabled: true,
        baseZone: {
          latitude: 37.7,
          longitude: -122.4,
          radiusMeters: 150,
        },
      })
    ).toMatchObject({
      realtimeIrlPullKey: "private-pull-key",
      settings: {
        searchRadiusMeters: 5000,
        llmEnabled: true,
        travelMode: "transit",
      },
    })
  })

  it("rejects unsafe radii and unknown actions", () => {
    expect(() =>
      parseSetupUpdate({
        searchRadiusMeters: 5000,
        defaultDurationMinutes: 10,
        arrivalRadiusMeters: 50,
        baseZone: { latitude: 0, longitude: 0, radiusMeters: 0 },
      })
    ).toThrow("invalid_base_zone")
    expect(() => parseSetupAction({ action: "become_other_tenant" })).toThrow(
      "invalid_setup_action"
    )
    expect(() =>
      parseSetupUpdate({
        searchRadiusMeters: 5000,
        defaultDurationMinutes: 10,
        arrivalRadiusMeters: 50,
        travelMode: "fly",
        baseZone: { latitude: 0, longitude: 0, radiusMeters: 100 },
      })
    ).toThrow("invalid_travel_mode")
  })
})
