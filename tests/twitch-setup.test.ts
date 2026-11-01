import { describe, expect, it, vi } from "vitest"
import { createTwitchSetupProvider } from "@/shared/providers/twitch-setup"

function response(status: number, payload: unknown) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { "content-type": "application/json" },
  })
}

const config = {
  broadcasterId: "42",
  clientId: "client",
  clientSecret: "secret",
  callbackUrl: "https://producer.example/api/eventsub",
  eventSubSecret: "eventsub-secret",
  getUserAccessToken: vi.fn(async () => "user-token"),
}

describe("automatic Twitch tenant setup", () => {
  it("creates a disabled deferred reward and both tenant subscriptions", async () => {
    let rewardPersisted = false
    const request = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(response(200, { data: [] }))
      .mockResolvedValueOnce(
        response(200, {
          data: [{ id: "reward-42", title: "Pitch the next mission" }],
        })
      )
      .mockResolvedValueOnce(
        response(200, { access_token: "app-token", expires_in: 3600 })
      )
      .mockResolvedValueOnce(response(200, { data: [] }))
      .mockResolvedValueOnce(response(202, { data: [{}] }))
      .mockResolvedValueOnce(response(202, { data: [{}] }))
      .mockResolvedValueOnce(response(202, { data: [{}] }))

    await expect(
      createTwitchSetupProvider(config, request).provision(undefined, async () => {
        rewardPersisted = true
        expect(request).toHaveBeenCalledTimes(2)
      })
    ).resolves.toEqual({ id: "reward-42", title: "Pitch the next mission" })
    expect(rewardPersisted).toBe(true)

    const createReward = JSON.parse(
      String((request.mock.calls[1]?.[1] as RequestInit).body)
    )
    expect(createReward).toMatchObject({
      cost: 10,
      is_enabled: false,
      is_user_input_required: true,
      should_redemptions_skip_request_queue: false,
    })
    const subscriptionBodies = request.mock.calls.slice(4).map((call) =>
      JSON.parse(String((call[1] as RequestInit).body))
    )
    expect(subscriptionBodies).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: "channel.channel_points_custom_reward_redemption.add",
          condition: {
            broadcaster_user_id: "42",
            reward_id: "reward-42",
          },
        }),
        expect.objectContaining({
          type: "channel.poll.end",
          condition: { broadcaster_user_id: "42" },
        }),
        expect.objectContaining({
          type: "channel.poll.progress",
          condition: { broadcaster_user_id: "42" },
        }),
      ])
    )
  })

  it("reuses the stored app-manageable reward and existing subscriptions", async () => {
    const existing = [
      {
        type: "channel.channel_points_custom_reward_redemption.add",
        version: "1",
        status: "enabled",
        condition: { broadcaster_user_id: "42", reward_id: "reward-42" },
      },
      {
        type: "channel.poll.end",
        version: "1",
        status: "enabled",
        condition: { broadcaster_user_id: "42" },
      },
      {
        type: "channel.poll.progress",
        version: "1",
        status: "enabled",
        condition: { broadcaster_user_id: "42" },
      },
    ]
    const request = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        response(200, {
          data: [{ id: "reward-42", title: "Pitch the next mission" }],
        })
      )
      .mockResolvedValueOnce(
        response(200, { access_token: "app-token", expires_in: 3600 })
      )
      .mockResolvedValueOnce(response(200, { data: existing }))

    await createTwitchSetupProvider(config, request).provision("reward-42")
    expect(request).toHaveBeenCalledTimes(3)
  })
})
