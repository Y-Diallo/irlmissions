import { describe, expect, it, vi } from "vitest"
import {
  createGooglePlacesProvider,
  createGoogleRoutesProvider,
  getGooglePlacePhoto,
  readGoogleMapsConfig,
} from "@/shared/providers/google-maps"

describe("Google Maps providers", () => {
  it("uses a nearby-biased Places search and maps only requested fields", async () => {
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
            userRatingCount: 842,
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
    const origin = {
      latitude: 37.77,
      longitude: -122.42,
      observedAt: 123456789,
    }
    await expect(
      provider.search({
        query: "cafe",
        origin,
        radiusMeters: 2500,
      })
    ).resolves.toEqual([
      expect.objectContaining({
        placeId: "place-1",
        name: "Demo Cafe",
        publicAccess: true,
        businessStatus: "operational",
        hoursText: ["Monday: 8:00 AM–8:00 PM"],
        userRatingCount: 842,
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
    expect(fields).toContain("places.currentOpeningHours.openNow")
    expect(fields).not.toContain("places.photos")
    expect(fields).not.toBe("*")
    const request = JSON.parse(String(init?.body))
    expect(request).toMatchObject({
      textQuery: "cafe",
      pageSize: 10,
      includePureServiceAreaBusinesses: false,
      locationBias: {
        circle: {
          center: { latitude: 37.77, longitude: -122.42 },
          radius: 2500,
        },
      },
    })
    expect(request.locationBias.circle.center).not.toHaveProperty("observedAt")
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
              googleMapsUri: "https://maps.google.com/?cid=photo-1",
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
      googleMapsUri: "https://maps.google.com/?cid=photo-1",
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

  it("uses distance-ranked Nearby Search for a generic park", async () => {
    const fetchMock = vi.fn<typeof fetch>(async () =>
      Response.json({ places: [] })
    )
    await createGooglePlacesProvider(
      { apiKey: "google-secret" },
      fetchMock
    ).search({
      query: "a park",
      origin: { latitude: 37.77, longitude: -122.42 },
      radiusMeters: 5000,
    })
    const [url, init] = fetchMock.mock.calls[0]
    expect(url).toBe("https://places.googleapis.com/v1/places:searchNearby")
    expect(JSON.parse(String(init?.body))).toEqual({
      includedTypes: ["park"],
      maxResultCount: 10,
      rankPreference: "DISTANCE",
      locationRestriction: {
        circle: {
          center: { latitude: 37.77, longitude: -122.42 },
          radius: 5000,
        },
      },
    })
  })

  it("allows localities but rejects service-area businesses", async () => {
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
          { ...place, id: "place-3", primaryType: "street_address" },
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
    expect(results.map((result) => result.publicAccess)).toEqual([
      true,
      false,
      false,
    ])
  })

  it("requests the selected route mode without an invalid routing preference", async () => {
    const fetchMock = vi.fn<typeof fetch>(async () =>
      Response.json({
        routes: [
          {
            distanceMeters: 1234,
            duration: "612.4s",
            polyline: { encodedPolyline: "encoded-route" },
          },
        ],
      })
    )
    const provider = createGoogleRoutesProvider(
      { apiKey: "google-secret" },
      fetchMock
    )
    const routeOrigin = {
      latitude: 37.77,
      longitude: -122.42,
      observedAt: 123456789,
    }
    const routeDestination = {
      latitude: 37.78,
      longitude: -122.41,
      privateField: "hidden",
    }
    await expect(
      provider.walk(routeOrigin, routeDestination, "transit")
    ).resolves.toEqual({
      distanceMeters: 1234,
      durationSeconds: 613,
      mode: "transit",
      encodedPolyline: "encoded-route",
    })
    const [url, init] = fetchMock.mock.calls[0]
    expect(url).toBe(
      "https://routes.googleapis.com/directions/v2:computeRoutes"
    )
    const request = JSON.parse(String(init?.body))
    expect(request.travelMode).toBe("TRANSIT")
    expect(request.routingPreference).toBeUndefined()
    expect(request.origin.location.latLng).toEqual({
      latitude: 37.77,
      longitude: -122.42,
    })
    expect(request.destination.location.latLng).toEqual({
      latitude: 37.78,
      longitude: -122.41,
    })
    expect(init?.headers).toMatchObject({
      "X-Goog-FieldMask":
        "routes.distanceMeters,routes.duration,routes.polyline.encodedPolyline",
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
    ).rejects.toThrow(
      "Google Maps request failed: HTTP 500 UNKNOWN: sensitive details"
    )

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
