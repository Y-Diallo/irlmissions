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
  riskFlags: [],
  failConsequence: "Eat a lemon",
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
      "set anywhere=true unless the viewer explicitly names a place"
    )
    expect(request.instructions).toContain(
      "If the viewer did not provide a consequence, return an empty string"
    )
    expect(request.instructions).toContain(
      "Ordinary public social interaction must not produce a risk flag"
    )
    expect(request.instructions).toContain(
      "filming or touching without consent"
    )
    expect(
      request.text.format.schema.properties.riskFlags.description
    ).toContain("inviting a stranger to a harmless game or challenge")
    expect(request.tools).toBeUndefined()
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
