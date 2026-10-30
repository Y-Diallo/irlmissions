import { describe, expect, it, vi } from "vitest"
import { PollProviderError } from "@/shared/polls"
import { createTwitchPollProvider } from "@/shared/providers/twitch-polls"

const startedAt = "2026-10-30T22:00:00Z"
const poll = {
  id: "poll-1",
  broadcaster_id: "42",
  title: "What should we do next?",
  status: "ACTIVE",
  duration: 60,
  started_at: startedAt,
  choices: [
    { id: "choice-1", title: "Mystery challenge", votes: 0 },
    { id: "choice-2", title: "Find something blue", votes: 0 },
  ],
}

function provider(
  request: typeof fetch,
  getAccessToken = vi.fn(async () => "token")
) {
  return {
    value: createTwitchPollProvider(
      {
        broadcasterId: "42",
        clientId: "client-id",
        getAccessToken,
      },
      request
    ),
    getAccessToken,
  }
}

describe("Twitch poll HTTP adapter", () => {
  it("creates a poll with the exact broadcaster, choices, and free voting", async () => {
    const request = vi
      .fn<typeof fetch>()
      .mockResolvedValue(Response.json({ data: [poll] }))
    const result = await provider(request).value.create({
      title: poll.title,
      choices: poll.choices.map((choice) => choice.title),
      durationSeconds: 60,
    })
    const [url, init] = request.mock.calls[0]
    expect(String(url)).toBe("https://api.twitch.tv/helix/polls")
    expect(init).toMatchObject({
      method: "POST",
      headers: {
        Authorization: "Bearer token",
        "Client-Id": "client-id",
        "Content-Type": "application/json",
      },
    })
    expect(JSON.parse(String(init?.body))).toEqual({
      broadcaster_id: "42",
      title: poll.title,
      choices: poll.choices.map((choice) => ({ title: choice.title })),
      duration: 60,
      channel_points_voting_enabled: false,
    })
    expect(result).toMatchObject({ id: "poll-1", broadcasterId: "42" })
  })

  it("refreshes once after a 401", async () => {
    const request = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(new Response(null, { status: 401 }))
      .mockResolvedValueOnce(Response.json({ data: [poll] }))
    const getAccessToken = vi.fn(async (force = false) =>
      force ? "fresh" : "stale"
    )
    await provider(request, getAccessToken).value.create({
      title: poll.title,
      choices: poll.choices.map((choice) => choice.title),
      durationSeconds: 60,
    })
    expect(getAccessToken.mock.calls).toEqual([[false], [true]])
    expect(request.mock.calls[1][1]?.headers).toMatchObject({
      Authorization: "Bearer fresh",
    })
  })

  it("marks a failed POST transport or malformed success as ambiguous", async () => {
    const network = vi
      .fn<typeof fetch>()
      .mockRejectedValue(new Error("timeout"))
    await expect(
      provider(network).value.create({
        title: poll.title,
        choices: poll.choices.map((choice) => choice.title),
        durationSeconds: 60,
      })
    ).rejects.toMatchObject({ ambiguous: true })

    const malformed = vi
      .fn<typeof fetch>()
      .mockResolvedValue(Response.json({ data: [] }))
    await expect(
      provider(malformed).value.create({
        title: poll.title,
        choices: poll.choices.map((choice) => choice.title),
        durationSeconds: 60,
      })
    ).rejects.toMatchObject({ ambiguous: true })
  })

  it("treats Twitch validation rejection as known and lists recent polls", async () => {
    const rejected = vi
      .fn<typeof fetch>()
      .mockResolvedValue(new Response(null, { status: 400 }))
    await expect(
      provider(rejected).value.create({
        title: poll.title,
        choices: poll.choices.map((choice) => choice.title),
        durationSeconds: 60,
      })
    ).rejects.toEqual(
      expect.objectContaining<Partial<PollProviderError>>({ ambiguous: false })
    )

    const request = vi
      .fn<typeof fetch>()
      .mockResolvedValue(Response.json({ data: [poll] }))
    await expect(provider(request).value.listRecent()).resolves.toHaveLength(1)
    expect(String(request.mock.calls[0][0])).toContain(
      "broadcaster_id=42&first=20"
    )
  })

  it("treats token failure before the request as a known failure", async () => {
    const request = vi.fn<typeof fetch>()
    const getAccessToken = vi.fn(async () => {
      throw new Error("refresh unavailable")
    })
    await expect(
      provider(request, getAccessToken).value.create({
        title: poll.title,
        choices: poll.choices.map((choice) => choice.title),
        durationSeconds: 60,
      })
    ).rejects.toMatchObject({
      code: "twitch_poll_auth",
      ambiguous: false,
    })
    expect(request).not.toHaveBeenCalled()
  })
})
