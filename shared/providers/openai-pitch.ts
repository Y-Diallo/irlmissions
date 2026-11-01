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
    "riskFlags",
    "failConsequence",
    "anywhere",
  ],
  properties: {
    anywhere: {
      type: "boolean",
      description:
        "True unless the viewer explicitly names a destination or asks for a kind of destination. Movement words such as go, walk, run, explore, or trick-or-treat do not imply a destination by themselves. For example, \"go and trick or treat while walking backwards\" is anywhere=true, while \"go to Pike Place Market and trick or treat\" is anywhere=false.",
    },
    placeQuery: {
      type: "string",
      description:
        "Only the concise destination phrase explicitly requested by the viewer, with no challenge or consequence text. Examples: \"park\", \"Pike Place Market\", \"coffee shop\". Never infer a neighborhood, business, or destination that was not requested. Empty string when anywhere is true.",
    },
    challenge: {
      type: "string",
      description: "A concise cleanup of what the streamer should do.",
    },
    publicLabelSuggestion: {
      type: "string",
      description:
        "A complete, success-oriented Twitch objective of at most 25 characters. Remove filler such as go to, challenge a stranger, and conjunctions; keep the destination category or safe chain name plus the core activity. Use an action that describes success: when losing triggers the consequence, use Win rather than Play. Example: \"Win Tic-Tac-Toe at a Gym\". Never end with a dangling word such as and, at, to, or with. Omit exact addresses and local destination names.",
    },
    durationMinutes: { type: "integer", minimum: 1, maximum: 120 },
    failConsequence: {
      type: "string",
      description:
        "The viewer-provided penalty for failing or losing, restated in at most 80 characters. Phrases such as if you lose, if you fail, or if time runs out introduce the consequence. Preserve it even when it needs a risk flag so the owner can decide. Return an empty string when the viewer did not explicitly provide one. Never invent a consequence.",
    },
    riskFlags: {
      type: "array",
      maxItems: 8,
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
                "Extract an IRL stream pitch into JSON. Never approve or reject it. Never invent a destination. A verb like go, walk, run, explore, or trick-or-treat is not a destination: set anywhere=true unless the viewer explicitly names a place or requests a kind of place. Named public businesses, attractions, markets, parks, neighborhoods, districts, and cities are valid destinations. Flag dangerous, illegal, harassing, coercive, or otherwise concerning activity for human review, including any requested failure consequence. Preserve an explicitly viewer-provided consequence and flag it when concerning so the owner can decide. If the viewer did not provide a consequence, return an empty string; never invent one. The public label is a poll choice of at most 25 characters that plainly restates the viewer's request. Do not make it vague or mysterious. Big chain names are fine because they don't reveal which location; leave out exact addresses and local destination names before arrival.",
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
        return validateExtraction({
          ...parsed,
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
