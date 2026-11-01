import type {
  Coordinates,
  PlaceCandidate,
  WalkingRoute,
  TravelMode,
} from "@/shared/pitches/processor"

type Fetch = typeof fetch

export type GoogleMapsConfig = { apiKey: string }

const PLACE_FIELDS = [
  "places.id",
  "places.displayName",
  "places.formattedAddress",
  "places.location",
  "places.businessStatus",
  "places.currentOpeningHours.weekdayDescriptions",
  "places.currentOpeningHours.openNow",
  "places.userRatingCount",
  "places.primaryType",
  "places.pureServiceAreaBusiness",
  "places.googleMapsUri",
  "places.attributions",
].join(",")

// Named cities and neighborhoods are useful arrival anchors for exploration
// streams. Reject only results that are too broad or resolve to an explicit
// address/road rather than a public destination.
const NON_DESTINATION_TYPES = new Set([
  "administrative_area_level_1",
  "administrative_area_level_2",
  "country",
  "postal_code",
  "route",
  "street_address",
])

export function readGoogleMapsConfig(
  env: Readonly<Record<string, string | undefined>>
): GoogleMapsConfig {
  const apiKey = env.GOOGLE_MAPS_API_KEY?.trim()
  if (!apiKey) throw new Error("Missing configuration: GOOGLE_MAPS_API_KEY")
  return { apiKey }
}

function object(value: unknown) {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null
}

function latLng(value: Coordinates) {
  return { latitude: value.latitude, longitude: value.longitude }
}

function string(value: unknown) {
  return typeof value === "string" && value.length > 0 ? value : null
}

function httpsUrl(value: unknown) {
  const candidate = string(value)
  if (candidate?.startsWith("//")) return `https:${candidate}`
  return candidate?.startsWith("https://") ? candidate : null
}

function businessStatus(value: unknown): PlaceCandidate["businessStatus"] {
  switch (value) {
    case "OPERATIONAL":
      return "operational"
    case "CLOSED_TEMPORARILY":
    case "FUTURE_OPENING":
      return "closed_temporarily"
    case "CLOSED_PERMANENTLY":
      return "closed_permanently"
    default:
      return "unknown"
  }
}

function parseAttributions(value: unknown) {
  if (!Array.isArray(value)) return []
  return value.flatMap((entry) => {
    const item = object(entry)
    const provider = string(item?.provider)
    const providerUri = string(item?.providerUri)
    return provider && providerUri ? [{ provider, providerUri }] : []
  })
}

function parsePhotoAttributions(value: unknown) {
  if (!Array.isArray(value)) return []
  return value.slice(0, 5).flatMap((entry) => {
    const item = object(entry)
    const displayName = string(item?.displayName)
    if (!displayName) return []
    const uri = httpsUrl(item?.uri) ?? undefined
    const photoUri = httpsUrl(item?.photoUri) ?? undefined
    return [
      {
        displayName,
        ...(uri ? { uri } : {}),
        ...(photoUri ? { photoUri } : {}),
      },
    ]
  })
}

function parsePhoto(value: unknown) {
  if (!Array.isArray(value)) return undefined
  const photo = object(value[0])
  const name = string(photo?.name)
  const googleMapsUri = httpsUrl(photo?.googleMapsUri)
  const widthPx = photo?.widthPx
  const heightPx = photo?.heightPx
  if (
    !name ||
    !/^places\/[^/]+\/photos\/[^/]+$/.test(name) ||
    !Number.isSafeInteger(widthPx) ||
    !Number.isSafeInteger(heightPx) ||
    (widthPx as number) <= 0 ||
    (heightPx as number) <= 0
  ) {
    return undefined
  }
  return {
    name,
    widthPx: widthPx as number,
    heightPx: heightPx as number,
    ...(googleMapsUri ? { googleMapsUri } : {}),
    authorAttributions: parsePhotoAttributions(photo?.authorAttributions),
  }
}

function parsePlace(value: unknown): PlaceCandidate | null {
  const place = object(value)
  const displayName = object(place?.displayName)
  const location = object(place?.location)
  const openingHours = object(place?.currentOpeningHours)
  const placeId = string(place?.id)
  const name = string(displayName?.text)
  const address = string(place?.formattedAddress)
  const googleMapsUri = string(place?.googleMapsUri)
  const latitude = location?.latitude
  const longitude = location?.longitude
  if (
    !placeId ||
    !name ||
    !address ||
    !googleMapsUri ||
    typeof latitude !== "number" ||
    typeof longitude !== "number" ||
    !Number.isFinite(latitude) ||
    !Number.isFinite(longitude)
  ) {
    return null
  }
  const descriptions = openingHours?.weekdayDescriptions
  const openNow = openingHours?.openNow
  const hoursText = Array.isArray(descriptions)
    ? descriptions.filter((item): item is string => typeof item === "string")
    : null
  const primaryType = string(place?.primaryType)
  const userRatingCount = place?.userRatingCount
  return {
    placeId,
    name,
    address,
    latitude,
    longitude,
    publicAccess:
      place?.pureServiceAreaBusiness !== true &&
      (!primaryType || !NON_DESTINATION_TYPES.has(primaryType)),
    businessStatus: businessStatus(place?.businessStatus),
    hoursText: hoursText?.length ? hoursText : null,
    ...(typeof openNow === "boolean" ? { openNow } : {}),
    ...(Number.isSafeInteger(userRatingCount) &&
    (userRatingCount as number) >= 0
      ? { userRatingCount: userRatingCount as number }
      : {}),
    googleMapsUri,
    attributions: parseAttributions(place?.attributions),
  }
}

async function getGooglePlacePhotoUri(
  config: GoogleMapsConfig,
  photoName: string,
  fetchImpl: Fetch = fetch
) {
  if (!/^places\/[^/]+\/photos\/[^/]+$/.test(photoName)) {
    throw new Error("Invalid Google Place photo reference")
  }
  const url = new URL(`https://places.googleapis.com/v1/${photoName}/media`)
  url.searchParams.set("maxWidthPx", "1200")
  url.searchParams.set("maxHeightPx", "720")
  url.searchParams.set("skipHttpRedirect", "true")
  const response = await fetchImpl(url, {
    headers: { "X-Goog-Api-Key": config.apiKey },
    cache: "no-store",
    signal: AbortSignal.timeout(10_000),
  }).catch(() => null)
  if (!response?.ok) throw new Error("Google Place photo unavailable")
  const payload = object(await response.json().catch(() => null))
  const photoUri = string(payload?.photoUri)
  if (!photoUri || !photoUri.startsWith("https://")) {
    throw new Error("Google Place photo unavailable")
  }
  return photoUri
}

export async function getGooglePlacePhoto(
  config: GoogleMapsConfig,
  placeId: string,
  fetchImpl: Fetch = fetch
) {
  if (!/^[A-Za-z0-9_-]{5,256}$/.test(placeId)) {
    throw new Error("Invalid Google Place ID")
  }
  const response = await fetchImpl(
    `https://places.googleapis.com/v1/places/${encodeURIComponent(placeId)}`,
    {
      headers: {
        "X-Goog-Api-Key": config.apiKey,
        "X-Goog-FieldMask": "photos",
      },
      cache: "no-store",
      signal: AbortSignal.timeout(10_000),
    }
  ).catch(() => null)
  if (!response?.ok) throw new Error("Google Place photo unavailable")
  const payload = object(await response.json().catch(() => null))
  const photo = parsePhoto(payload?.photos)
  if (!photo) throw new Error("Google Place photo unavailable")
  return {
    photoUri: await getGooglePlacePhotoUri(config, photo.name, fetchImpl),
    ...(photo.googleMapsUri ? { googleMapsUri: photo.googleMapsUri } : {}),
    authorAttributions: photo.authorAttributions,
  }
}

/** Live open/closed state, rechecked before an automatic poll. */
export async function getGooglePlaceStatus(
  config: GoogleMapsConfig,
  placeId: string,
  fetchImpl: Fetch = fetch
): Promise<Pick<PlaceCandidate, "businessStatus" | "openNow">> {
  if (!/^[A-Za-z0-9_-]{5,256}$/.test(placeId)) {
    throw new Error("Invalid Google Place ID")
  }
  const response = await fetchImpl(
    `https://places.googleapis.com/v1/places/${encodeURIComponent(placeId)}`,
    {
      headers: {
        "X-Goog-Api-Key": config.apiKey,
        "X-Goog-FieldMask": "businessStatus,currentOpeningHours.openNow",
      },
      cache: "no-store",
      signal: AbortSignal.timeout(10_000),
    }
  ).catch(() => null)
  if (!response?.ok) throw new Error("Google Place status unavailable")
  const payload = object(await response.json().catch(() => null))
  const openNow = object(payload?.currentOpeningHours)?.openNow
  return {
    businessStatus: businessStatus(payload?.businessStatus),
    ...(typeof openNow === "boolean" ? { openNow } : {}),
  }
}

async function googleRequest(
  url: string,
  config: GoogleMapsConfig,
  body: unknown,
  fieldMask: string,
  fetchImpl: Fetch
) {
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), 12_000)
  try {
    const response = await fetchImpl(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Goog-Api-Key": config.apiKey,
        "X-Goog-FieldMask": fieldMask,
      },
      body: JSON.stringify(body),
      signal: controller.signal,
    })
    if (!response.ok) {
      const text = await response.text().catch(() => "")
      let providerStatus = "UNKNOWN"
      let providerMessage = "No provider error details"
      try {
        const payload = object(JSON.parse(text))
        const details = object(payload?.error)
        if (typeof details?.status === "string") {
          providerStatus = details.status
        }
        if (typeof details?.message === "string") {
          providerMessage = details.message
        }
      } catch {
        if (text) providerMessage = text
      }
      const safeMessage = providerMessage
        .replaceAll(config.apiKey, "[redacted]")
        .slice(0, 500)
      throw new Error(
        `Google Maps request failed: HTTP ${response.status} ${providerStatus}: ${safeMessage}`
      )
    }
    return (await response.json()) as unknown
  } catch (error) {
    if (
      error instanceof Error &&
      error.message.startsWith("Google Maps request failed:")
    ) {
      throw error
    }
    throw new Error("Google Maps request failed")
  } finally {
    clearTimeout(timeout)
  }
}

export function createGooglePlacesProvider(
  config: GoogleMapsConfig,
  fetchImpl: Fetch = fetch
) {
  return {
    async search(input: {
      query: string
      origin: Coordinates
      radiusMeters: number
    }): Promise<PlaceCandidate[]> {
      const genericPark = /^(?:a |an |public |nearby )?parks?$/i.test(
        input.query.trim()
      )
      const payload = object(
        await googleRequest(
          genericPark
            ? "https://places.googleapis.com/v1/places:searchNearby"
            : "https://places.googleapis.com/v1/places:searchText",
          config,
          genericPark
            ? {
                includedTypes: ["park"],
                maxResultCount: 10,
                rankPreference: "DISTANCE",
                locationRestriction: {
                  circle: {
                    center: latLng(input.origin),
                    radius: input.radiusMeters,
                  },
                },
              }
            : {
                textQuery: input.query,
                pageSize: 10,
                includePureServiceAreaBusinesses: false,
                // Text Search supports circles only for locationBias. The
                // processor applies the exact radius and base-zone restrictions
                // to every returned coordinate before selecting a destination.
                locationBias: {
                  circle: {
                    center: latLng(input.origin),
                    radius: input.radiusMeters,
                  },
                },
              },
          PLACE_FIELDS,
          fetchImpl
        )
      )
      if (!payload || !Array.isArray(payload.places)) {
        throw new Error("Google Places returned an invalid response")
      }
      return payload.places.flatMap((place) => {
        const parsed = parsePlace(place)
        return parsed ? [parsed] : []
      })
    },
  }
}

function durationSeconds(value: unknown) {
  if (typeof value !== "string") return null
  const match = /^(\d+(?:\.\d+)?)s$/.exec(value)
  const seconds = Number(match?.[1])
  return Number.isFinite(seconds) ? Math.ceil(seconds) : null
}

export function createGoogleRoutesProvider(
  config: GoogleMapsConfig,
  fetchImpl: Fetch = fetch
) {
  return {
    async walk(
      origin: Coordinates,
      destination: Coordinates,
      mode: TravelMode = "walk"
    ): Promise<WalkingRoute> {
      const payload = object(
        await googleRequest(
          "https://routes.googleapis.com/directions/v2:computeRoutes",
          config,
          {
            origin: { location: { latLng: latLng(origin) } },
            destination: { location: { latLng: latLng(destination) } },
            travelMode: mode.toUpperCase(),
            computeAlternativeRoutes: false,
          },
          "routes.distanceMeters,routes.duration",
          fetchImpl
        )
      )
      const route = object(
        Array.isArray(payload?.routes) ? payload.routes[0] : null
      )
      const distance = route?.distanceMeters
      const duration = durationSeconds(route?.duration)
      if (
        !Number.isSafeInteger(distance) ||
        (distance as number) < 0 ||
        duration === null
      ) {
        throw new Error("Google Routes returned no walking route")
      }
      return {
        distanceMeters: distance as number,
        durationSeconds: duration,
        mode,
      }
    },
  }
}
