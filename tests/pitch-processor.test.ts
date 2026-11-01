import { beforeEach, describe, expect, it, vi } from "vitest"
import {
  processPitch,
  type PitchProcessorDependencies,
  type PitchStore,
  type ProcessingContext,
  type ProcessingPitch,
  type ReviewPitch,
} from "@/shared/pitches/processor"
import { createFakePitchProviders } from "@/shared/providers/fake-pitch"

const now = Date.parse("2026-10-30T19:00:00Z")

function fixture(rawText = "Eat a sandwich at the cafe") {
  let claimed = false
  let completed: ReviewPitch | null = null
  let rejected: string | null = null
  let failure: { code: string; automaticRetryAt: number | null } | null = null
  const pitch: ProcessingPitch = {
    redemptionId: "redemption-1",
    rawText,
    attempt: 1,
    leaseId: "lease-1",
  }
  const store: PitchStore = {
    claim: vi.fn(async (_id, leaseId) => {
      if (claimed) return null
      claimed = true
      return { ...pitch, leaseId }
    }),
    complete: vi.fn(async (_pitch, review) => {
      completed = review
      return true
    }),
    reject: vi.fn(async (_pitch, reason) => {
      rejected = reason
      return true
    }),
    fail: vi.fn(async (_pitch, value) => {
      failure = value
      return true
    }),
  }
  const context: ProcessingContext = {
    origin: { latitude: 37.7749, longitude: -122.4194, observedAt: now },
    searchRadiusMeters: 5000,
    baseZone: { latitude: 37.7, longitude: -122.5, radiusMeters: 100 },
    llmEnabled: true,
    defaultDurationMinutes: 10,
    travelMode: "walk",
  }
  const providers = createFakePitchProviders()
  const deps: PitchProcessorDependencies = {
    store,
    context: { read: vi.fn(async () => context) },
    automod: { check: vi.fn(providers.automod.check) },
    extractor: { extract: vi.fn(providers.extractor.extract) },
    places: { search: vi.fn(providers.places.search) },
    routes: { walk: vi.fn(providers.routes.walk) },
    duplicates: { suggest: vi.fn(providers.duplicates.suggest) },
    now: () => now,
    leaseId: () => "lease-1",
  }
  return {
    deps,
    store,
    context,
    get completed() {
      return completed
    },
    get rejected() {
      return rejected
    },
    get failure() {
      return failure
    },
  }
}

beforeEach(() => vi.restoreAllMocks())

describe("pitch processor", () => {
  it("enriches a safe pitch and leaves it for explicit owner review", async () => {
    const state = fixture()
    await expect(processPitch("redemption-1", state.deps)).resolves.toEqual({
      kind: "ready_for_review",
      flagged: false,
    })
    expect(state.completed).toMatchObject({
      destination: { name: "Demo Cafe", placeId: "fake-place" },
      walkingRoute: { distanceMeters: 420, durationSeconds: 360 },
      extraction: { durationMinutes: 10, riskFlags: [] },
    })
    expect(state.rejected).toBeNull()
  })

  it("skips place search for an anywhere pitch", async () => {
    const state = fixture("Walk backwards while trick or treating [anywhere]")
    await expect(processPitch("redemption-1", state.deps)).resolves.toEqual({
      kind: "ready_for_review",
      flagged: false,
    })
    expect(state.completed).toMatchObject({
      destination: null,
      walkingRoute: null,
      straightLineMeters: null,
      extraction: { anywhere: true },
    })
    expect(state.deps.places.search).not.toHaveBeenCalled()
    expect(state.deps.routes.walk).not.toHaveBeenCalled()
  })

  it("treats every pitch as anywhere in channel no-travel mode", async () => {
    const state = fixture()
    state.context.noTravelMode = true
    // Even a very stale location doesn't matter with nothing to search.
    state.context.origin.observedAt = now - 60 * 60_000
    await processPitch("redemption-1", state.deps)
    expect(state.deps.places.search).not.toHaveBeenCalled()
    expect(state.completed).toMatchObject({
      destination: null,
      warnings: [],
      extraction: { anywhere: true },
    })
  })

  it("skips place search when the owner forced no travel", async () => {
    const state = fixture()
    vi.mocked(state.deps.store.claim).mockImplementationOnce(
      async (redemptionId, leaseId) => ({
        redemptionId,
        rawText: "Eat a sandwich at the cafe",
        attempt: 1,
        leaseId,
        noTravel: true,
      })
    )
    await processPitch("redemption-1", state.deps)
    expect(state.deps.places.search).not.toHaveBeenCalled()
    expect(state.completed).toMatchObject({ destination: null })
  })

  it("uses and stores the streamer's selected travel mode", async () => {
    const state = fixture()
    state.context.travelMode = "drive"
    await processPitch("redemption-1", state.deps)
    expect(state.deps.routes.walk).toHaveBeenCalledWith(
      state.context.origin,
      expect.objectContaining({ placeId: "fake-place" }),
      "drive"
    )
    expect(state.completed).toMatchObject({
      walkingRoute: { mode: "drive" },
    })
  })

  it("rejects an AutoMod failure before LLM or Places", async () => {
    const state = fixture("[automod] abusive pitch")
    await expect(processPitch("redemption-1", state.deps)).resolves.toEqual({
      kind: "rejected",
      reason: "automod",
    })
    expect(state.deps.extractor.extract).not.toHaveBeenCalled()
    expect(state.deps.places.search).not.toHaveBeenCalled()
    expect(state.rejected).toBe("automod")
  })

  it("preserves LLM risk flags for human review instead of auto-rejecting", async () => {
    const state = fixture("[danger] jump in a fountain at the cafe")
    await expect(processPitch("redemption-1", state.deps)).resolves.toEqual({
      kind: "ready_for_review",
      flagged: true,
    })
    expect(state.completed).toMatchObject({
      extraction: {
        riskFlags: [{ category: "dangerous", reason: expect.any(String) }],
      },
    })
    expect(state.rejected).toBeNull()
  })

  it("rejects when no eligible public place exists", async () => {
    const state = fixture("[no-place] imaginary venue")
    await expect(processPitch("redemption-1", state.deps)).resolves.toEqual({
      kind: "rejected",
      reason: "no_public_place",
    })
    expect(state.rejected).toBe("no_public_place")
  })

  it("excludes the base zone but does not gate Google results by publicAccess", async () => {
    const state = fixture()
    state.context.baseZone = {
      latitude: 37.775,
      longitude: -122.418,
      radiusMeters: 100,
    }
    state.deps.places.search = vi.fn(async () => [
      {
        placeId: "inside-base",
        name: "Private area",
        address: "Hidden",
        latitude: 37.775,
        longitude: -122.418,
        publicAccess: true,
        businessStatus: "operational" as const,
        hoursText: null,
        googleMapsUri: "https://maps.google.com/?cid=inside-base",
        attributions: [],
      },
      {
        placeId: "eligible",
        name: "Public park",
        address: "Park Street",
        latitude: 37.78,
        longitude: -122.41,
        publicAccess: false,
        businessStatus: "operational" as const,
        hoursText: null,
        googleMapsUri: "https://maps.google.com/?cid=eligible",
        attributions: [],
      },
    ])
    await processPitch("redemption-1", state.deps)
    expect(state.completed).toMatchObject({
      destination: { placeId: "eligible" },
    })
  })

  it("prefers an established place when it is still reasonably nearby", async () => {
    const state = fixture()
    const place = {
      address: "Nearby",
      longitude: -122.4194,
      publicAccess: true,
      businessStatus: "operational" as const,
      hoursText: null,
      googleMapsUri: "https://maps.google.com/",
      attributions: [],
    }
    state.deps.places.search = vi.fn(async () => [
      {
        ...place,
        placeId: "unknown-gym",
        name: "Unnamed Gym",
        latitude: 37.7776,
        userRatingCount: 2,
      },
      {
        ...place,
        placeId: "established-gym",
        name: "Established Fitness",
        latitude: 37.7821,
        userRatingCount: 1200,
      },
    ])
    await processPitch("redemption-1", state.deps)
    expect(state.completed).toMatchObject({
      destination: { placeId: "established-gym" },
    })
  })

  it("warns but continues when a legacy location observation is stale", async () => {
    const state = fixture()
    state.context.origin.observedAt = now - 2 * 60_000 - 1
    await expect(processPitch("redemption-1", state.deps)).resolves.toEqual({
      kind: "ready_for_review",
      flagged: false,
    })
    expect(state.completed).toMatchObject({ warnings: ["stale_location"] })
    expect(state.deps.automod.check).toHaveBeenCalledOnce()
  })

  it("turns provider outages into bounded retry state", async () => {
    const errorLog = vi.spyOn(console, "error").mockImplementation(() => {})
    const state = fixture("[places-error] cafe")
    await expect(processPitch("redemption-1", state.deps)).resolves.toEqual({
      kind: "retry",
      code: "places_unavailable",
      automaticRetryAt: now + 15_000,
    })
    expect(state.completed).toBeNull()
    expect(JSON.parse(String(errorLog.mock.calls[0]?.[0]))).toMatchObject({
      severity: "ERROR",
      event: "pitch_processing_step_failed",
      step: "places_unavailable",
      errorName: "Error",
    })
  })

  it("accepts an unchanged coordinate while its feed heartbeat is fresh", async () => {
    const state = fixture()
    state.context.origin.observedAt = now - 10 * 60_000
    state.context.locationConfirmedAt = now - 15_000
    await expect(processPitch("redemption-1", state.deps)).resolves.toEqual({
      kind: "ready_for_review",
      flagged: false,
    })
  })

  it("warns but continues using a coordinate after its heartbeat expires", async () => {
    const state = fixture()
    state.context.locationConfirmedAt = now - 120_001
    await expect(processPitch("redemption-1", state.deps)).resolves.toEqual({
      kind: "ready_for_review",
      flagged: false,
    })
    expect(state.completed).toMatchObject({ warnings: ["stale_location"] })
    expect(state.deps.automod.check).toHaveBeenCalledOnce()
  })

  it("does nothing when another worker already owns the pitch", async () => {
    const state = fixture()
    vi.mocked(state.store.claim).mockResolvedValueOnce(null)
    await expect(processPitch("redemption-1", state.deps)).resolves.toEqual({
      kind: "not_claimed",
    })
    expect(state.deps.context.read).not.toHaveBeenCalled()
  })
})
