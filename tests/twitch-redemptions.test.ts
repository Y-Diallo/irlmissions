import { describe, expect, it, vi } from "vitest"
import { createTwitchRedemptionProvider } from "@/shared/providers/twitch-redemptions"

const redemption = {
  id: "redemption-1",
  broadcaster_id: "42",
  status: "UNFULFILLED",
  reward: { id: "reward-1" },
}

function provider(
  request: typeof fetch,
  getAccessToken = vi.fn(async () => "token")
) {
  return {
    value: createTwitchRedemptionProvider(
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

describe("Twitch redemption HTTP adapter", () => {
  it("reads the exact reward redemption using the owner token", async () => {
    const request = vi
      .fn<typeof fetch>()
      .mockResolvedValue(Response.json({ data: [redemption] }))
    await expect(
      provider(request).value.get({
        redemptionId: "redemption-1",
        rewardId: "reward-1",
      })
    ).resolves.toBe("UNFULFILLED")
    const [url, init] = request.mock.calls[0]
    expect(String(url)).toBe(
      "https://api.twitch.tv/helix/channel_points/custom_rewards/redemptions?broadcaster_id=42&reward_id=reward-1&id=redemption-1"
    )
    expect(init).toMatchObject({
      method: "GET",
      headers: {
        Authorization: "Bearer token",
        "Client-Id": "client-id",
      },
      cache: "no-store",
    })
  })

  it.each([
    ["refund", "CANCELED"],
    ["fulfill", "FULFILLED"],
  ] as const)("sends the exact PATCH body for %s", async (_action, status) => {
    const request = vi.fn<typeof fetch>().mockResolvedValue(
      Response.json({
        data: [{ ...redemption, status }],
      })
    )
    await expect(
      provider(request).value.update({
        redemptionId: "redemption-1",
        rewardId: "reward-1",
        status,
      })
    ).resolves.toBe(status)
    expect(request.mock.calls[0][1]).toMatchObject({
      method: "PATCH",
      headers: {
        Authorization: "Bearer token",
        "Client-Id": "client-id",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ status }),
    })
  })

  it("refreshes once after a 401", async () => {
    const request = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(new Response(null, { status: 401 }))
      .mockResolvedValueOnce(Response.json({ data: [redemption] }))
    const getAccessToken = vi.fn(async (force = false) =>
      force ? "fresh" : "stale"
    )
    await provider(request, getAccessToken).value.get({
      redemptionId: "redemption-1",
      rewardId: "reward-1",
    })
    expect(getAccessToken.mock.calls).toEqual([[false], [true]])
    expect(request.mock.calls[1][1]?.headers).toMatchObject({
      Authorization: "Bearer fresh",
    })
  })

  it("treats a missing GET as absent and a failed PATCH as reconcilable", async () => {
    const missing = vi
      .fn<typeof fetch>()
      .mockResolvedValue(new Response(null, { status: 404 }))
    await expect(
      provider(missing).value.get({
        redemptionId: "redemption-1",
        rewardId: "reward-1",
      })
    ).resolves.toBeNull()
    await expect(
      provider(missing).value.update({
        redemptionId: "redemption-1",
        rewardId: "reward-1",
        status: "CANCELED",
      })
    ).rejects.toMatchObject({
      code: "twitch_redemption_not_found",
      ambiguous: true,
    })
  })

  it("does not accept another reward, broadcaster, or malformed status", async () => {
    for (const invalid of [
      { ...redemption, broadcaster_id: "other" },
      { ...redemption, reward: { id: "other" } },
      { ...redemption, status: "UNKNOWN" },
    ]) {
      const request = vi
        .fn<typeof fetch>()
        .mockResolvedValue(Response.json({ data: [invalid] }))
      await expect(
        provider(request).value.get({
          redemptionId: "redemption-1",
          rewardId: "reward-1",
        })
      ).rejects.toMatchObject({ code: "twitch_redemption_response" })
    }
  })

  it("marks a PATCH transport failure as ambiguous and retryable", async () => {
    const request = vi
      .fn<typeof fetch>()
      .mockRejectedValue(new Error("timeout"))
    await expect(
      provider(request).value.update({
        redemptionId: "redemption-1",
        rewardId: "reward-1",
        status: "FULFILLED",
      })
    ).rejects.toMatchObject({
      code: "twitch_redemption_request",
      retryable: true,
      ambiguous: true,
    })
  })

  it("reconciles malformed PATCH success bodies instead of assuming failure", async () => {
    const request = vi
      .fn<typeof fetch>()
      .mockResolvedValue(
        Response.json({ data: [{ ...redemption, id: "other" }] })
      )
    await expect(
      provider(request).value.update({
        redemptionId: "redemption-1",
        rewardId: "reward-1",
        status: "CANCELED",
      })
    ).rejects.toMatchObject({
      code: "twitch_redemption_response",
      retryable: true,
      ambiguous: true,
    })
  })
})
