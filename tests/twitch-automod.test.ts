import { describe, expect, it, vi } from "vitest"
import { createTwitchAutoModProvider } from "@/shared/providers/twitch-automod"

describe("Twitch AutoMod provider", () => {
  it("checks the pitch using the broadcaster settings", async () => {
    const fetchMock = vi.fn<typeof fetch>(async () =>
      Response.json({ data: [{ msg_id: "pitch-1", is_permitted: false }] })
    )
    const getAccessToken = vi.fn(async () => "access-token")
    const provider = createTwitchAutoModProvider(
      { clientId: "client", broadcasterId: "42", getAccessToken },
      fetchMock
    )
    await expect(
      provider.check({ messageId: "pitch-1", text: "unsafe text" })
    ).resolves.toBe(false)
    const [url, init] = fetchMock.mock.calls[0]
    expect(url).toContain("broadcaster_id=42")
    expect(init?.headers).toMatchObject({
      Authorization: "Bearer access-token",
      "Client-Id": "client",
    })
    expect(JSON.parse(String(init?.body))).toEqual({
      data: [{ msg_id: "pitch-1", msg_text: "unsafe text" }],
    })
  })

  it("refreshes once after a 401 and rejects malformed or failed responses", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(new Response(null, { status: 401 }))
      .mockResolvedValueOnce(
        Response.json({ data: [{ msg_id: "pitch-1", is_permitted: true }] })
      )
    const getAccessToken = vi.fn(async (force = false) =>
      force ? "refreshed" : "initial"
    )
    await expect(
      createTwitchAutoModProvider(
        { clientId: "client", broadcasterId: "42", getAccessToken },
        fetchMock
      ).check({ messageId: "pitch-1", text: "hello" })
    ).resolves.toBe(true)
    expect(getAccessToken).toHaveBeenNthCalledWith(2, true)

    const malformed = vi.fn(async () => Response.json({ data: [] }))
    await expect(
      createTwitchAutoModProvider(
        { clientId: "client", broadcasterId: "42", getAccessToken },
        malformed
      ).check({ messageId: "pitch-1", text: "hello" })
    ).rejects.toThrow("invalid response")
  })
})
