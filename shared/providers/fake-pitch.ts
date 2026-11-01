import {
  fitPollLabel,
  type PitchProcessorDependencies,
  type PlaceCandidate,
} from "@/shared/pitches/processor"

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

export function createFakePitchProviders(
  place: PlaceCandidate = fallbackPlace
): Pick<
  PitchProcessorDependencies,
  "automod" | "extractor" | "places" | "routes" | "duplicates"
> {
  return {
    automod: {
      async check({ text }) {
        return !text.includes("[automod]")
      },
    },
    extractor: {
      async extract(text) {
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
        if (query.includes("[places-error]")) {
          throw new Error("Scripted places outage")
        }
        return query.includes("[no-place]") ? [] : [place]
      },
    },
    routes: {
      async walk(origin, destination, mode) {
        return {
          distanceMeters: 420,
          durationSeconds: 360,
          mode,
          encodedPolyline: encodePolyline([origin, destination]),
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
