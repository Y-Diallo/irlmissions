import { describe, expect, it, vi } from "vitest"
import {
  createGooglePlacesProvider,
  createGoogleRoutesProvider,
  getGooglePlacePhoto,
  readGoogleMapsConfig,
} from "@/shared/providers/google-maps"

describe("Google Maps providers", () => {
  it("uses a restricted Places search and maps only requested fields", async () => {
    const fetchMock = vi.fn<typeof fetch>(async () =>
      Response.json({
        places: [
          {
            id: "place-1",
            displayName: { text: "Demo Cafe", languageCode: "en" },
            formattedAddress: "123 Demo Street",
            location: { latitude: 37.775, longitude: -122.418 },
            businessStatus: "OPERATIONAL",
            primaryType: "cafe",
            pureServiceAreaBusiness: false,
            currentOpeningHours: {
              weekdayDescriptions: ["Monday: 8:00 AM–8:00 PM"],
            },
            googleMapsUri: "https://maps.google.com/?cid=1",
            attributions: [
              { provider: "Demo Data", providerUri: "https://data.example" },
            ],
          },
        ],
      })
    )
    const provider = createGooglePlacesProvider(
      { apiKey: "google-secret" },
      fetchMock
    )
    await expect(
      provider.search({
        query: "cafe",
        origin: { latitude: 37.77, longitude: -122.42 },
        radiusMeters: 2500,
      })
    ).resolves.toEqual([
      expect.objectContaining({
        placeId: "place-1",
        name: "Demo Cafe",
        publicAccess: true,
        businessStatus: "operational",
        hoursText: ["Monday: 8:00 AM–8:00 PM"],
        attributions: [
          { provider: "Demo Data", providerUri: "https://data.example" },
        ],
      }),
    ])
    const [url, init] = fetchMock.mock.calls[0]
    expect(url).toBe("https://places.googleapis.com/v1/places:searchText")
    expect(init?.headers).toMatchObject({
      "X-Goog-Api-Key": "google-secret",
    })
    const fields = String(
      (init?.headers as Record<string, string>)["X-Goog-FieldMask"]
    )
    expect(fields).toContain("places.currentOpeningHours.weekdayDescriptions")
    expect(fields).not.toContain("places.photos")
    expect(fields).not.toBe("*")
    const request = JSON.parse(String(init?.body))
    expect(request).toMatchObject({
      textQuery: "cafe",
      pageSize: 10,
      includePureServiceAreaBusinesses: false,
      locationRestriction: {
        circle: {
          center: { latitude: 37.77, longitude: -122.42 },
          radius: 2500,
        },
      },
    })
  })

  it("gets fresh photo metadata at reveal time without exposing the API key", async () => {
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        Response.json({
          photos: [
            {
              name: "places/place-1/photos/photo-1",
              widthPx: 1600,
              heightPx: 900,
              authorAttributions: [
                {
                  displayName: "Demo Photographer",
                  uri: "//maps.google.com/profile/demo",
                  photoUri: "//lh3.googleusercontent.com/avatar",
                },
              ],
            },
          ],
        })
      )
      .mockResolvedValueOnce(
        Response.json({
          photoUri: "https://lh3.googleusercontent.com/place-photo",
        })
      )
    await expect(
      getGooglePlacePhoto({ apiKey: "google-secret" }, "place-1", fetchMock)
    ).resolves.toEqual({
      photoUri: "https://lh3.googleusercontent.com/place-photo",
      authorAttributions: [
        {
          displayName: "Demo Photographer",
          uri: "https://maps.google.com/profile/demo",
          photoUri: "https://lh3.googleusercontent.com/avatar",
        },
      ],
    })
    const [detailsUrl, detailsInit] = fetchMock.mock.calls[0]
    expect(String(detailsUrl)).toBe(
      "https://places.googleapis.com/v1/places/place-1"
    )
    expect(detailsInit?.headers).toMatchObject({
      "X-Goog-FieldMask": "photos",
    })
    const [photoUrl, photoInit] = fetchMock.mock.calls[1]
    expect(String(photoUrl)).toContain(
      "places/place-1/photos/photo-1/media?maxWidthPx=1200"
    )
    expect(String(photoUrl)).not.toContain("google-secret")
    expect(photoInit?.headers).toEqual({
      "X-Goog-Api-Key": "google-secret",
    })
  })

  it("marks geographic results and service-area businesses ineligible", async () => {
    const place = {
      id: "place-1",
      displayName: { text: "Result" },
      formattedAddress: "Somewhere",
      location: { latitude: 1, longitude: 2 },
      businessStatus: "OPERATIONAL",
      googleMapsUri: "https://maps.google.com/?cid=1",
    }
    const fetchMock = vi.fn<typeof fetch>(async () =>
      Response.json({
        places: [
          { ...place, primaryType: "locality" },
          {
            ...place,
            id: "place-2",
            primaryType: "plumber",
            pureServiceAreaBusiness: true,
          },
        ],
      })
    )
    const results = await createGooglePlacesProvider(
      { apiKey: "key" },
      fetchMock
    ).search({
      query: "result",
      origin: { latitude: 1, longitude: 2 },
      radiusMeters: 1000,
    })
    expect(results.map((result) => result.publicAccess)).toEqual([false, false])
  })

  it("requests a walking route without an invalid routing preference", async () => {
    const fetchMock = vi.fn<typeof fetch>(async () =>
      Response.json({ routes: [{ distanceMeters: 1234, duration: "612.4s" }] })
    )
    const provider = createGoogleRoutesProvider(
      { apiKey: "google-secret" },
      fetchMock
    )
    await expect(
      provider.walk(
        { latitude: 37.77, longitude: -122.42 },
        { latitude: 37.78, longitude: -122.41 }
      )
    ).resolves.toEqual({ distanceMeters: 1234, durationSeconds: 613 })
    const [url, init] = fetchMock.mock.calls[0]
    expect(url).toBe(
      "https://routes.googleapis.com/directions/v2:computeRoutes"
    )
    const request = JSON.parse(String(init?.body))
    expect(request.travelMode).toBe("WALK")
    expect(request.routingPreference).toBeUndefined()
    expect(init?.headers).toMatchObject({
      "X-Goog-FieldMask": "routes.distanceMeters,routes.duration",
    })
  })

  it("treats provider errors, malformed Places data, and no route as failures", async () => {
    const failed = vi.fn<typeof fetch>(async () =>
      Response.json(
        { error: { message: "sensitive details" } },
        { status: 500 }
      )
    )
    await expect(
      createGooglePlacesProvider({ apiKey: "key" }, failed).search({
        query: "cafe",
        origin: { latitude: 1, longitude: 2 },
        radiusMeters: 1000,
      })
    ).rejects.toThrow("Google Maps request failed")

    const malformed = vi.fn<typeof fetch>(async () => Response.json({}))
    await expect(
      createGooglePlacesProvider({ apiKey: "key" }, malformed).search({
        query: "cafe",
        origin: { latitude: 1, longitude: 2 },
        radiusMeters: 1000,
      })
    ).rejects.toThrow("invalid response")

    const noRoute = vi.fn<typeof fetch>(async () =>
      Response.json({ routes: [] })
    )
    await expect(
      createGoogleRoutesProvider({ apiKey: "key" }, noRoute).walk(
        { latitude: 1, longitude: 2 },
        { latitude: 3, longitude: 4 }
      )
    ).rejects.toThrow("no walking route")
  })

  it("reads a server-only API key", () => {
    expect(readGoogleMapsConfig({ GOOGLE_MAPS_API_KEY: " key " })).toEqual({
      apiKey: "key",
    })
    expect(() => readGoogleMapsConfig({})).toThrow("GOOGLE_MAPS_API_KEY")
  })
})
