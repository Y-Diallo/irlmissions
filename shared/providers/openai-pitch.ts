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
  ],
  properties: {
    placeQuery: {
      type: "string",
      description:
        "A concise search query for a real public business, attraction, park, or activity explicitly requested by the viewer.",
    },
    challenge: {
      type: "string",
      description: "A concise cleanup of what the streamer should do.",
    },
    publicLabelSuggestion: {
      type: "string",
      description:
        "A Twitch poll choice of at most 25 characters that restates what the viewer asked, in their words. Keep the activity and kind of place. Well-known chains with many locations (e.g. Spirit Halloween, Walmart) may be named; omit the names of local one-off businesses, street addresses, and neighborhoods.",
    },
    durationMinutes: { type: "integer", minimum: 1, maximum: 120 },
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
    throw new Error("OpenAI response was not completed")
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
              max_output_tokens: 600,
              instructions:
                "Extract an IRL stream pitch into JSON. Never approve or reject it. Never invent a destination. Flag dangerous, illegal, harassing, coercive, or otherwise concerning activity for human review. The public label is a poll choice of at most 25 characters that plainly restates the viewer's request, such as \"Eat the spiciest wings\" or \"Sing karaoke at a bar\". Do not make it vague or mysterious. Big chain names like Spirit Halloween are fine because they don't reveal which location; leave out local one-off business names, addresses, and neighborhoods.",
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
        if (!response.ok) throw new Error("OpenAI extraction failed")
        const parsed = JSON.parse(
          outputText(await response.json())
        ) as PitchExtraction
        return validateExtraction(parsed)
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
