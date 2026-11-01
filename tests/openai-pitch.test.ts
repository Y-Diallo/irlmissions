import { describe, expect, it, vi } from "vitest"
import {
  createOpenAIPitchExtractor,
  readOpenAIPitchConfig,
} from "@/shared/providers/openai-pitch"

function response(value: unknown) {
  return new Response(
    JSON.stringify({
      status: "completed",
      output: [
        {
          type: "message",
          content: [{ type: "output_text", text: JSON.stringify(value) }],
        },
      ],
    }),
    { status: 200 }
  )
}

const extraction = {
  placeQuery: "McDonald's",
  challenge: "Eat ten fish sandwiches in ten minutes",
  publicLabelSuggestion: "Ten-item speed challenge",
  durationMinutes: 10,
  funScore: 75,
  riskFlags: [],
  failConsequence: "Eat a lemon",
  consequenceClearRule: "through_next_mission",
  consequenceDurationMinutes: 0,
  anywhere: false,
}

describe("OpenAI pitch extractor", () => {
  it("uses strict non-stored Responses API structured output", async () => {
    const fetchMock = vi.fn<typeof fetch>(async () => response(extraction))
    const provider = createOpenAIPitchExtractor(
      { apiKey: "secret-key", model: "gpt-6-luna" },
      fetchMock
    )
    await expect(provider.extract("go to mcdonalds")).resolves.toEqual(
      extraction
    )
    const [url, init] = fetchMock.mock.calls[0]
    expect(url).toBe("https://api.openai.com/v1/responses")
    expect(init?.headers).toMatchObject({ Authorization: "Bearer secret-key" })
    const request = JSON.parse(String(init?.body))
    expect(request).toMatchObject({
      model: "gpt-6-luna",
      store: false,
      text: {
        format: {
          type: "json_schema",
          name: "irl_pitch_extraction",
          strict: true,
        },
      },
    })
    expect(request.instructions).toContain(
      "travel is implied: set anywhere=false"
    )
    expect(request.instructions).toContain(
      "If the viewer did not provide a consequence, return an empty string"
    )
    expect(request.instructions).toContain(
      "Ordinary public social interaction must not produce a risk flag"
    )
    expect(request.instructions).toContain(
      "feeding a giraffe at a zoo is not dangerous by itself"
    )
    expect(request.instructions).toContain(
      "funny mission failure rather than a safety concern"
    )
    expect(request.instructions).toContain("credible risk of bodily harm")
    expect(request.instructions).toContain(
      "stealing, assault, property damage, or residential trespass"
    )
    expect(request.instructions).toContain(
      "Do not flag merely hypothetical hazards, minor laws or ordinances"
    )
    expect(request.instructions).toContain(
      "filming or touching without consent"
    )
    expect(request.instructions).toContain(
      "When the wording is ambiguous, default to through_next_mission"
    )
    expect(
      request.text.format.schema.properties.riskFlags.description
    ).toContain("inviting a stranger to a harmless game or challenge")
    expect(
      request.text.format.schema.properties.riskFlags.description
    ).toContain("minor laws, ordinances, posted policies, and venue rules")
    expect(
      request.text.format.schema.properties.riskFlags.description
    ).toContain("feeding an animal at a zoo")
    expect(
      request.text.format.schema.properties.riskFlags.description
    ).toContain("stealing, assault, property damage, or residential trespass")
    expect(request.tools).toBeUndefined()
  })

  it("turns acquiring food into a destination search even if the model misses it", async () => {
    const fetchMock = vi.fn<typeof fetch>(async () =>
      response({
        ...extraction,
        placeQuery: "",
        challenge: "Get some french fries",
        publicLabelSuggestion: "Get French Fries",
        failConsequence: "",
        anywhere: true,
      })
    )
    await expect(
      createOpenAIPitchExtractor(
        { apiKey: "secret", model: "gpt-6-luna" },
        fetchMock
      ).extract("go get some french fries")
    ).resolves.toMatchObject({
      anywhere: false,
      placeQuery: "french fries",
      challenge: "Get some french fries",
    })
  })

  it("sends an activity that needs a facility to that facility", async () => {
    async function extract(input: string, model: Partial<typeof extraction>) {
      return createOpenAIPitchExtractor(
        { apiKey: "secret", model: "gpt-6-luna" },
        vi.fn<typeof fetch>(async () =>
          response({ ...extraction, failConsequence: "", ...model })
        )
      ).extract(input)
    }
    await expect(
      extract("go play basketball", { anywhere: true, placeQuery: "" })
    ).resolves.toMatchObject({
      anywhere: false,
      placeQuery: "basketball court",
    })
    await expect(
      extract("shoot some hoops, if you lose do 10 pushups", {
        anywhere: false,
        placeQuery: "basketball",
      })
    ).resolves.toMatchObject({ placeQuery: "basketball court" })
    await expect(
      extract("go swimming", { anywhere: true, placeQuery: "" })
    ).resolves.toMatchObject({ placeQuery: "public swimming pool" })
    // A specific place the model found is kept.
    await expect(
      extract("play basketball at the YMCA", {
        anywhere: false,
        placeQuery: "YMCA",
      })
    ).resolves.toMatchObject({ placeQuery: "YMCA" })
    // Holding the ball is not playing the sport.
    await expect(
      extract("bounce a basketball ten times", {
        anywhere: true,
        placeQuery: "",
      })
    ).resolves.toMatchObject({ anywhere: true })
  })

  it("rejects refusal, malformed schema output, and provider errors", async () => {
    const refusal = vi.fn(async () =>
      Response.json({
        status: "completed",
        output: [
          { type: "message", content: [{ type: "refusal", refusal: "no" }] },
        ],
      })
    )
    await expect(
      createOpenAIPitchExtractor(
        { apiKey: "secret", model: "gpt-6-luna" },
        refusal
      ).extract("pitch")
    ).rejects.toThrow("refused")

    const malformed = vi.fn(async () =>
      response({ ...extraction, durationMinutes: 0 })
    )
    await expect(
      createOpenAIPitchExtractor(
        { apiKey: "secret", model: "gpt-6-luna" },
        malformed
      ).extract("pitch")
    ).rejects.toThrow("extraction")

    const failed = vi.fn(async () =>
      Response.json({ sensitive: "provider details" }, { status: 500 })
    )
    await expect(
      createOpenAIPitchExtractor(
        { apiKey: "secret", model: "gpt-6-luna" },
        failed
      ).extract("pitch")
    ).rejects.toThrow("OpenAI extraction failed")
  })

  it("preserves an explicit if-you-lose consequence the model omitted", async () => {
    const fetchMock = vi.fn<typeof fetch>(async () =>
      response({
        ...extraction,
        publicLabelSuggestion: "Play Tic-Tac-Toe at a Gym",
        failConsequence: "",
      })
    )
    await expect(
      createOpenAIPitchExtractor(
        { apiKey: "secret", model: "gpt-6-luna" },
        fetchMock
      ).extract(
        "Go to a gym and challenge a stranger to tic-tac-toe; if you lose no swearing for 10 minutes"
      )
    ).resolves.toMatchObject({
      publicLabelSuggestion: "Win Tic-Tac-Toe at a Gym",
      failConsequence: "No swearing for 10 minutes.",
    })
  })

  it("uses the current efficient default and permits an explicit override", () => {
    expect(readOpenAIPitchConfig({ OPENAI_API_KEY: " key " })).toEqual({
      apiKey: "key",
      model: "gpt-6-luna",
    })
    expect(
      readOpenAIPitchConfig({
        OPENAI_API_KEY: "key",
        OPENAI_MODEL: "custom-model",
      }).model
    ).toBe("custom-model")
  })
})
