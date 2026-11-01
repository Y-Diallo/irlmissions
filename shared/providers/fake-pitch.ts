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
        return {
          placeQuery: text,
          challenge: text.replaceAll(/\[[^\]]+\]/g, "").trim(),
          publicLabelSuggestion: fitPollLabel(
            text.replaceAll(/\[[^\]]+\]/g, "").trim() || "Chat-picked objective"
          ),
          durationMinutes: 10,
          riskFlags,
          failConsequence: "Do a silly victory dance",
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
      async walk(_origin, _destination, mode) {
        return { distanceMeters: 420, durationSeconds: 360, mode }
      },
    },
    duplicates: {
      async suggest() {
        return []
      },
    },
  }
}
