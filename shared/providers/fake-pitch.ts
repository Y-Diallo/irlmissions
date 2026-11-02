import {
  DEV_PITCH_PRESETS,
  demoPitchForText,
  type DemoPitch,
} from "@/shared/dev"
import {
  distanceMeters,
  fitPollLabel,
  type PitchExtraction,
  type PitchProcessorDependencies,
  type PlaceCandidate,
  type TravelMode,
} from "@/shared/pitches/processor"

const DEMO_QUERY_PREFIX = "demo:"
/** Rough city speeds in m/s, for believable demo route times. */
const SPEED: Record<TravelMode, number> = { walk: 1.35, transit: 5, drive: 8 }

const fallbackPlace: PlaceCandidate = {
  placeId: "fake-place",
  name: "Demo Cafe",
  address: "123 Demo Street",
  latitude: 37.775,
  longitude: -122.418,
  publicAccess: true,
  businessStatus: "operational",
  hoursText: ["Open 24 hours"],
  openNow: true,
  googleMapsUri: "https://maps.google.com/?cid=fake-place",
  attributions: [],
}

function demoPlace(key: string): PlaceCandidate | null {
  const preset = (DEV_PITCH_PRESETS as Record<string, DemoPitch>)[key]
  const place = preset?.place
  if (!place) return null
  return {
    placeId: `demo-place-${key}`,
    name: place.name,
    address: place.address,
    latitude: place.latitude,
    longitude: place.longitude,
    publicAccess: true,
    businessStatus: "operational",
    hoursText: [place.hours],
    openNow: true,
    googleMapsUri: `https://www.google.com/maps/search/?${new URLSearchParams({
      api: "1",
      query: `${place.name}, ${place.address}`,
    })}`,
    attributions: [],
  }
}

// The scripted extraction a demo preset stands for, with a clean poll title.
function scriptedExtraction(text: string): PitchExtraction | null {
  const preset = demoPitchForText(text)
  if (!preset) return null
  const key = Object.entries(DEV_PITCH_PRESETS).find(
    ([, value]) => value === preset
  )![0]
  return {
    placeQuery: preset.place ? `${DEMO_QUERY_PREFIX}${key}` : "",
    challenge: preset.text,
    publicLabelSuggestion: preset.publicLabel,
    durationMinutes: preset.durationMinutes,
    funScore: preset.funScore,
    riskFlags: preset.riskFlag
      ? [{ category: "dangerous", reason: preset.riskFlag }]
      : [],
    failConsequence: preset.failConsequence ?? "",
    consequenceClearRule: preset.clearRule ?? "through_next_mission",
    consequenceDurationMinutes: preset.consequenceMinutes ?? 0,
    anywhere: !preset.place,
  }
}

export function createFakePitchProviders(
  place: PlaceCandidate = fallbackPlace
): Pick<
  PitchProcessorDependencies,
  "automod" | "extractor" | "places" | "routes" | "duplicates"
> {
  return {
    automod: {
      async check({ text }) {
        return !text.includes("[automod]") && !demoPitchForText(text)?.automod
      },
    },
    extractor: {
      async extract(text) {
        const scripted = scriptedExtraction(text)
        if (scripted) return scripted
        const riskFlags = text.includes("[danger]")
          ? [
              {
                category: "dangerous" as const,
                reason: "Scripted simulator safety flag",
              },
            ]
          : []
        const consequence =
          /\bif\s+(?:you|i|the streamer)\s+(?:fail|fails|lose|loses)\b\s*[:,]?\s*(.+)$/i
            .exec(text)?.[1]
            ?.trim() ?? ""
        const consequenceMinutes = consequence
          ? Number(
              /\b(\d+)\s*(?:m|min|mins|minute|minutes)\b/i.exec(
                consequence
              )?.[1] ?? 0
            )
          : 0
        return {
          placeQuery: text,
          challenge: text.replaceAll(/\[[^\]]+\]/g, "").trim(),
          publicLabelSuggestion: fitPollLabel(
            text.replaceAll(/\[[^\]]+\]/g, "").trim() || "Chat-picked objective"
          ),
          durationMinutes: 10,
          funScore: 70,
          riskFlags,
          failConsequence: consequence,
          consequenceClearRule: consequenceMinutes
            ? ("timed" as const)
            : ("through_next_mission" as const),
          consequenceDurationMinutes: consequenceMinutes,
          anywhere: text.includes("[anywhere]"),
        }
      },
    },
    places: {
      async search({ query }) {
        if (query.startsWith(DEMO_QUERY_PREFIX)) {
          const scripted = demoPlace(query.slice(DEMO_QUERY_PREFIX.length))
          return scripted ? [scripted] : []
        }
        if (query.includes("[places-error]")) {
          throw new Error("Scripted places outage")
        }
        return query.includes("[no-place]") ? [] : [place]
      },
    },
    routes: {
      async walk(origin, destination, mode) {
        const encodedPolyline = encodePolyline([origin, destination])
        if (
          destination.latitude === place.latitude &&
          destination.longitude === place.longitude
        ) {
          return {
            distanceMeters: 420,
            durationSeconds: 360,
            mode,
            encodedPolyline,
          }
        }
        // Straight line plus a city-block detour, at a believable pace.
        const meters = Math.round(distanceMeters(origin, destination) * 1.3)
        return {
          distanceMeters: meters,
          durationSeconds: Math.round(meters / SPEED[mode]),
          mode,
          encodedPolyline,
        }
      },
    },
    duplicates: {
      async suggest() {
        return []
      },
    },
  }
}

function encodePolyline(
  points: Array<{ latitude: number; longitude: number }>
) {
  let previousLatitude = 0
  let previousLongitude = 0
  let result = ""
  for (const point of points) {
    const latitude = Math.round(point.latitude * 1e5)
    const longitude = Math.round(point.longitude * 1e5)
    result += encodeValue(latitude - previousLatitude)
    result += encodeValue(longitude - previousLongitude)
    previousLatitude = latitude
    previousLongitude = longitude
  }
  return result
}

function encodeValue(value: number) {
  let encoded = ""
  let next = value < 0 ? ~(value << 1) : value << 1
  while (next >= 0x20) {
    encoded += String.fromCharCode((0x20 | (next & 0x1f)) + 63)
    next >>= 5
  }
  return encoded + String.fromCharCode(next + 63)
}
