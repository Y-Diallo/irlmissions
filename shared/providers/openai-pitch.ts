import {
  validateExtraction,
  type PitchExtraction,
} from "@/shared/pitches/processor"

const DEFAULT_MODEL = "gpt-6-luna"

type Fetch = typeof fetch

export type OpenAIPitchConfig = {
  apiKey: string
  model: string
}

export function readOpenAIPitchConfig(
  env: Readonly<Record<string, string | undefined>>
): OpenAIPitchConfig {
  const apiKey = env.OPENAI_API_KEY?.trim()
  if (!apiKey) throw new Error("Missing configuration: OPENAI_API_KEY")
  const model = env.OPENAI_MODEL?.trim() || DEFAULT_MODEL
  if (!/^[a-zA-Z0-9._-]{1,100}$/.test(model)) {
    throw new Error("Invalid OPENAI_MODEL")
  }
  return { apiKey, model }
}

const schema = {
  type: "object",
  additionalProperties: false,
  required: [
    "placeQuery",
    "challenge",
    "publicLabelSuggestion",
    "durationMinutes",
    "funScore",
    "riskFlags",
    "failConsequence",
    "consequenceClearRule",
    "consequenceDurationMinutes",
    "anywhere",
  ],
  properties: {
    anywhere: {
      type: "boolean",
      description:
        'True only when the objective can be completed at the streamer\'s current position. A named destination, requested place category, or action that requires acquiring food or an item makes this false. Get, buy, purchase, order, pick up, and shop for imply travel even without a named venue. An activity that needs a facility the streamer cannot carry, such as a court, field, pool, rink, lane, or course, also makes this false. For example, "go get some french fries" and "go play basketball" are anywhere=false, while "bounce a basketball ten times" is anywhere=true.',
    },
    placeQuery: {
      type: "string",
      description:
        'The concise Places search query, with no challenge or consequence text. Use an explicitly requested destination such as "Pike Place Market" or "coffee shop". When acquiring something implies travel but no venue is named, use the requested food or item, such as "french fries", "pizza", or "souvenir shop". When an activity needs a facility, use that facility, such as "basketball court" for playing basketball, "tennis court", "public swimming pool", "skate park", or "bowling alley". Never invent a named business or neighborhood. Empty string only when anywhere is true.',
    },
    challenge: {
      type: "string",
      description: "A concise cleanup of what the streamer should do.",
    },
    publicLabelSuggestion: {
      type: "string",
      description:
        'A complete, success-oriented Twitch objective of at most 25 characters. Remove filler such as go to, challenge a stranger, and conjunctions; keep the destination category or safe chain name plus the core activity. Use an action that describes success: when losing triggers the consequence, use Win rather than Play. Example: "Win Tic-Tac-Toe at a Gym". Never end with a dangling word such as and, at, to, or with. Omit exact addresses and local destination names.',
    },
    durationMinutes: { type: "integer", minimum: 1, maximum: 120 },
    funScore: {
      type: "integer",
      minimum: 0,
      maximum: 100,
      description:
        "Relative entertainment value for an IRL livestream, from 0 to 100. Favor visual, achievable, interactive objectives; do not reward danger or harassment.",
    },
    failConsequence: {
      type: "string",
      description:
        "The viewer-provided penalty for failing or losing, restated in at most 80 characters. Phrases such as if you lose, if you fail, or if time runs out introduce the consequence. Preserve it even when it needs a risk flag so the owner can decide. Return an empty string when the viewer did not explicitly provide one. Never invent a consequence.",
    },
    consequenceClearRule: {
      type: "string",
      enum: ["timed", "at_next_stop", "through_next_mission", "manual"],
      description:
        "How an explicitly provided failure consequence clears. timed for a stated duration; at_next_stop when it lasts until reaching the next destination; through_next_mission when it lasts through the following mission; manual only when no automatic rule fits. Use through_next_mission when ambiguous and also when failConsequence is empty.",
    },
    consequenceDurationMinutes: {
      type: "integer",
      minimum: 0,
      maximum: 1440,
      description:
        "Duration in whole minutes for a timed consequence, extracted from the viewer's wording. Return 0 for every non-timed rule and when failConsequence is empty.",
    },
    riskFlags: {
      type: "array",
      maxItems: 8,
      description:
        "Concrete, material concerns in the viewer's requested conduct that require owner review. Flag a credible risk of bodily harm; harassment, coercion, or non-consensual conduct; or serious unlawful conduct with a victim or meaningful invasion of person, home, or property, such as stealing, assault, property damage, or residential trespass. Do not flag merely hypothetical risk, venue availability, activities requiring normal staff permission or supervision, or minor laws, ordinances, posted policies, and venue rules by themselves. Lawful venue-managed activities such as feeding an animal at a zoo are not dangerous by themselves; if unavailable, the mission can simply fail. Flag an animal activity only when the requested conduct creates a credible risk of bodily harm, such as entering an enclosure. Ordinary public social interaction is not a concern by itself: do not flag talking to someone, asking a question, requesting help, or inviting a stranger to a harmless game or challenge. Flag interaction only when the request includes harassment, intimidation, coercion, following, unwanted persistence, sexual conduct, targeting a vulnerable person, or filming or touching without consent.",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["category", "reason"],
        properties: {
          category: {
            type: "string",
            enum: ["dangerous", "illegal", "harassing", "other"],
          },
          reason: { type: "string" },
        },
      },
    },
  },
} as const

function outputText(payload: unknown) {
  if (!payload || typeof payload !== "object") {
    throw new Error("OpenAI returned an invalid response")
  }
  const response = payload as Record<string, unknown>
  if (response.status !== "completed" || !Array.isArray(response.output)) {
    const incomplete = response.incomplete_details
    const reason =
      incomplete && typeof incomplete === "object"
        ? (incomplete as Record<string, unknown>).reason
        : undefined
    throw new Error(
      `OpenAI response was not completed${typeof reason === "string" ? `: ${reason}` : ""}`
    )
  }
  const texts: string[] = []
  for (const item of response.output) {
    if (!item || typeof item !== "object") continue
    const content = (item as Record<string, unknown>).content
    if (!Array.isArray(content)) continue
    for (const part of content) {
      if (!part || typeof part !== "object") continue
      const value = part as Record<string, unknown>
      if (value.type === "refusal") throw new Error("OpenAI refused extraction")
      if (value.type === "output_text" && typeof value.text === "string") {
        texts.push(value.text)
      }
    }
  }
  if (texts.length !== 1) throw new Error("OpenAI returned no extraction")
  return texts[0]
}

function statedFailConsequence(input: string) {
  const match =
    /\bif\s+(?:you|i|the streamer)\s+(?:fail|fails|failed|lose|loses|lost)\b\s*[:,]?\s*(.+)$/i.exec(
      input
    )
  const consequence = match?.[1]?.trim() ?? ""
  if (!consequence) return ""
  const sentence = `${consequence[0]!.toUpperCase()}${consequence.slice(1)}`
  return /[.!?]$/.test(sentence) ? sentence : `${sentence}.`
}

function successOrientedLabel(label: string, input: string) {
  if (/\bif\s+(?:you|i|the streamer)\s+(?:lose|loses|lost)\b/i.test(input)) {
    return label.replace(/^play\b/i, (word) =>
      word[0] === word[0]?.toUpperCase() ? "Win" : "win"
    )
  }
  return label
}

// Keep acquisition pitches travel-based even if the model mistakes the lack
// of a named venue for an anywhere mission. The requested item is a search
// query, not an invented destination; Google still resolves the actual place.
function impliedAcquisitionQuery(input: string) {
  const objective = input.split(
    /\bif\s+(?:you|i|the streamer)\s+(?:fail|fails|failed|lose|loses|lost)\b/i
  )[0]!
  const match =
    /\b(?:get|buy|purchase|order|pick\s*up|shop\s+for)\s+([^,.!?;]+)/i.exec(
      objective
    )
  const target = match?.[1]
    ?.split(/\s+(?:and then|then|while|but)\s+/i)[0]
    ?.replace(/^(?:some|a|an|the)\s+/i, "")
    .trim()
  if (
    !target ||
    /^(?:to\b|someone\b|somebody\b|people\b|a person\b)/i.test(target) ||
    /^(?:ready|dressed|married|lost)$/i.test(target)
  ) {
    return null
  }
  return target.slice(0, 300)
}

// Activities that need a facility rather than an item the streamer carries.
// "bounce a basketball" stays anywhere; "play basketball" needs a court.
const VENUE_ACTIVITIES: [RegExp, string][] = [
  [
    /\b(?:play(?:ing)?|shoot(?:ing)?)\s+(?:some\s+|a\s+game\s+of\s+)?(?:basketball|hoops|a\s+game\s+of\s+horse)\b/i,
    "basketball court",
  ],
  [/\bplay(?:ing)?\s+(?:some\s+|a\s+game\s+of\s+)?tennis\b/i, "tennis court"],
  [
    /\bplay(?:ing)?\s+(?:some\s+|a\s+game\s+of\s+)?pickleball\b/i,
    "pickleball court",
  ],
  [
    /\bplay(?:ing)?\s+(?:some\s+|a\s+game\s+of\s+)?volleyball\b/i,
    "volleyball court",
  ],
  [/\bplay(?:ing)?\s+(?:some\s+|a\s+game\s+of\s+)?soccer\b/i, "soccer field"],
  [
    /\bplay(?:ing)?\s+(?:some\s+|a\s+(?:round|game)\s+of\s+)?(?:mini[\s-]?golf|putt[\s-]?putt)\b/i,
    "mini golf",
  ],
  [
    /\b(?:go(?:ing)?\s+bowling|bowl\s+a\s+(?:strike|spare|game))\b/i,
    "bowling alley",
  ],
  [
    /\b(?:go(?:ing)?\s+swimming|swim\s+(?:a\s+)?laps?)\b/i,
    "public swimming pool",
  ],
  [/\bgo(?:ing)?\s+ice[\s-]?skating\b/i, "ice skating rink"],
  [/\bskate\s*park\b/i, "skate park"],
  [/\bgo(?:ing)?\s+(?:rock[\s-]?climbing|bouldering)\b/i, "climbing gym"],
]

function impliedVenueQuery(input: string, modelQuery: string) {
  const objective = input.split(
    /\bif\s+(?:you|i|the streamer)\s+(?:fail|fails|failed|lose|loses|lost)\b/i
  )[0]!
  const venue = VENUE_ACTIVITIES.find(([pattern]) =>
    pattern.test(objective)
  )?.[1]
  if (!venue) return null
  // Keep a specific destination the model already found ("the YMCA").
  const query = modelQuery.trim().toLowerCase()
  const bareSport =
    !query ||
    venue.toLowerCase().startsWith(query) ||
    /^(?:basketball|hoops|tennis|pickleball|volleyball|soccer|swimming|bowling|ice skating|climbing)$/.test(
      query
    )
  return bareSport ? venue : null
}

export function createOpenAIPitchExtractor(
  config: OpenAIPitchConfig,
  fetchImpl: Fetch = fetch
) {
  return {
    async extract(text: string): Promise<PitchExtraction> {
      const controller = new AbortController()
      const timeout = setTimeout(() => controller.abort(), 15_000)
      try {
        const response = await fetchImpl(
          "https://api.openai.com/v1/responses",
          {
            method: "POST",
            headers: {
              Authorization: `Bearer ${config.apiKey}`,
              "Content-Type": "application/json",
            },
            body: JSON.stringify({
              model: config.model,
              store: false,
              max_output_tokens: 1000,
              instructions:
                "Extract an IRL stream pitch into JSON. Never approve or reject it. Never invent a named destination. A verb like go, walk, run, explore, or trick-or-treat alone is not a destination. Set anywhere=true only when the objective can be done at the streamer's current position. If the viewer asks to get, buy, purchase, order, pick up, or shop for food or an item, travel is implied: set anywhere=false and use that requested food or item as placeQuery so Google Places can find a suitable nearby public business. For example, 'go get some french fries' uses placeQuery 'french fries'. An activity that needs a facility the streamer cannot carry also implies travel: set anywhere=false and use the facility as placeQuery, such as 'basketball court' for 'go play basketball' (a park with a hoop), 'tennis court', 'public swimming pool', 'skate park', or 'bowling alley'. An activity that only needs something the streamer can hold, such as bouncing a basketball or juggling, stays anywhere=true. Named public businesses, attractions, markets, parks, neighborhoods, districts, and cities are also valid destinations. A risk flag is for a credible risk of bodily harm; harassment, coercion, or non-consensual conduct; or serious unlawful conduct with a victim or meaningful invasion of person, home, or property, such as stealing, assault, property damage, or residential trespass. Do not flag merely hypothetical hazards, minor laws or ordinances, posted policies, venue rules, uncertainty about whether a venue offers an activity, or the fact that an ordinary activity may require permission or staff supervision. A lawful venue-managed activity such as feeding a giraffe at a zoo is not dangerous by itself; if it is unavailable, that is a funny mission failure rather than a safety concern. Flag an animal activity when the requested conduct creates a credible bodily-harm risk, such as entering an enclosure, but not merely because staff may need to supervise it. Ordinary public social interaction must not produce a risk flag by itself. Talking to someone, asking a question, requesting help, trick-or-treating, or inviting a stranger to a harmless game or challenge are normal IRL activities. Do not assume harassment or lack of consent merely because the participant is a stranger. Flag social interaction when the request itself calls for harassment, intimidation, coercion, following, unwanted persistence after refusal, sexual conduct, targeting minors or vulnerable people, or filming or touching without consent. Preserve an explicitly viewer-provided consequence and flag it when concerning so the owner can decide. If the viewer did not provide a consequence, return an empty string; never invent one. For a consequence, return its clearing rule: timed when the viewer states a duration and extract whole minutes; at_next_stop when it lasts until the next arrival or stop; through_next_mission when it lasts through the next mission; manual only when no automatic rule fits. When the wording is ambiguous, default to through_next_mission. Return duration 0 for non-timed rules. The public label is a poll choice of at most 25 characters that plainly restates the viewer's request. Do not make it vague or mysterious. Big chain names are fine because they don't reveal which location; leave out exact addresses and local destination names before arrival.",
              input: text,
              text: {
                format: {
                  type: "json_schema",
                  name: "irl_pitch_extraction",
                  strict: true,
                  schema,
                },
              },
            }),
            signal: controller.signal,
          }
        )
        if (!response.ok) {
          const failure = (await response.json().catch(() => null)) as Record<
            string,
            unknown
          > | null
          const details =
            failure?.error && typeof failure.error === "object"
              ? (failure.error as Record<string, unknown>)
              : null
          console.error(
            JSON.stringify({
              severity: "ERROR",
              event: "openai_pitch_extraction_failed",
              message: "OpenAI pitch extraction request failed",
              httpStatus: response.status,
              ...(typeof details?.type === "string"
                ? { providerType: details.type }
                : {}),
              ...(typeof details?.code === "string"
                ? { providerCode: details.code }
                : {}),
              ...(typeof details?.message === "string"
                ? { providerMessage: details.message.slice(0, 500) }
                : {}),
            })
          )
          throw new Error("OpenAI extraction failed")
        }
        const parsed = JSON.parse(
          outputText(await response.json())
        ) as PitchExtraction
        const acquisitionQuery = parsed.anywhere
          ? impliedAcquisitionQuery(text)
          : null
        const venueQuery = acquisitionQuery
          ? null
          : impliedVenueQuery(text, parsed.anywhere ? "" : parsed.placeQuery)
        return validateExtraction({
          ...parsed,
          ...(acquisitionQuery
            ? { anywhere: false, placeQuery: acquisitionQuery }
            : {}),
          ...(venueQuery ? { anywhere: false, placeQuery: venueQuery } : {}),
          publicLabelSuggestion: successOrientedLabel(
            parsed.publicLabelSuggestion,
            text
          ),
          failConsequence:
            parsed.failConsequence?.trim() || statedFailConsequence(text),
        })
      } catch (error) {
        if (error instanceof Error && error.message.startsWith("OpenAI")) {
          throw error
        }
        throw new Error("OpenAI extraction failed")
      } finally {
        clearTimeout(timeout)
      }
    },
  }
}
