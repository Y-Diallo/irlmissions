import type {
  Coordinates,
  PlaceCandidate,
  WalkingRoute,
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
  "places.primaryType",
  "places.pureServiceAreaBusiness",
  "places.googleMapsUri",
  "places.attributions",
].join(",")

const NON_DESTINATION_TYPES = new Set([
  "administrative_area_level_1",
  "administrative_area_level_2",
  "country",
  "locality",
  "postal_code",
  "route",
  "street_address",
  "sublocality",
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
  const hoursText = Array.isArray(descriptions)
    ? descriptions.filter((item): item is string => typeof item === "string")
    : null
  const primaryType = string(place?.primaryType)
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
    authorAttributions: photo.authorAttributions,
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
    if (!response.ok) throw new Error("Google Maps request failed")
    return (await response.json()) as unknown
  } catch {
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
      const payload = object(
        await googleRequest(
          "https://places.googleapis.com/v1/places:searchText",
          config,
          {
            textQuery: input.query,
            pageSize: 10,
            includePureServiceAreaBusinesses: false,
            locationRestriction: {
              circle: {
                center: input.origin,
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
      destination: Coordinates
    ): Promise<WalkingRoute> {
      const payload = object(
        await googleRequest(
          "https://routes.googleapis.com/directions/v2:computeRoutes",
          config,
          {
            origin: { location: { latLng: origin } },
            destination: { location: { latLng: destination } },
            travelMode: "WALK",
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
      return { distanceMeters: distance as number, durationSeconds: duration }
    },
  }
}
