import { createHmac } from "node:crypto"
import { afterEach, describe, expect, it, vi } from "vitest"
import { liveEnv } from "./auth-fixtures"
import { demoEnv } from "./fixtures"

const mocks = vi.hoisted(() => ({
  getServerFirebase: vi.fn(() => ({
    db: {
      doc: vi.fn(() => ({
        get: vi.fn(async () => ({ data: () => ({ rewardId: "reward-1" }) })),
      })),
    },
  })),
  save: vi.fn(async () => "created" as const),
  createEventSubStore: vi.fn(),
  applyPollEnd: vi.fn(async () => "winner" as const),
}))
mocks.createEventSubStore.mockImplementation(() => ({ save: mocks.save }))

vi.mock("@/lib/firebase/admin", () => ({
  getServerFirebase: mocks.getServerFirebase,
}))
vi.mock("@/lib/eventsub/store", () => ({
  createEventSubStore: mocks.createEventSubStore,
}))
vi.mock("@/lib/polls/end-store", () => ({
  createPollEndStore: () => ({ apply: mocks.applyPollEnd }),
}))

import { POST } from "@/app/api/eventsub/route"
import { POLL_END, REDEMPTION_ADD } from "@/shared/eventsub"

const secret = "eventsub-test-secret"
const clock = Date.parse("2026-10-30T18:00:00.000Z")

function setLiveEnv() {
  for (const [key, value] of Object.entries({
    ...liveEnv,
    TWITCH_EVENTSUB_SECRET: secret,
  })) {
    if (value === undefined) vi.stubEnv(key, undefined)
    else vi.stubEnv(key, value)
  }
}

function payload(challenge?: string) {
  return {
    ...(challenge ? { challenge } : {}),
    subscription: {
      id: "subscription-1",
      status: challenge ? "webhook_callback_verification_pending" : "enabled",
      type: REDEMPTION_ADD,
      version: "1",
      condition: { broadcaster_user_id: "42", reward_id: "reward-1" },
    },
    event: {
      id: "redemption-1",
      broadcaster_user_id: "42",
      user_id: "viewer-1",
      user_login: "viewer",
      user_name: "Viewer",
      user_input: "Go to the aquarium",
      status: "unfulfilled",
      redeemed_at: "2026-10-30T17:59:00Z",
      reward: {
        id: "reward-1",
        title: "Pitch",
        prompt: "What should I do?",
        cost: 100,
      },
    },
  }
}

function request(
  value: object,
  options: { type?: string; secret?: string; subscriptionType?: string } = {}
) {
  const raw = JSON.stringify(value)
  const id = "message-1"
  const timestamp = new Date(clock).toISOString()
  const signature = `sha256=${createHmac("sha256", options.secret ?? secret)
    .update(id + timestamp + raw)
    .digest("hex")}`
  return new Request("https://producer.example/api/eventsub", {
    method: "POST",
    body: raw,
    headers: {
      "content-type": "application/json",
      "twitch-eventsub-message-id": id,
      "twitch-eventsub-message-timestamp": timestamp,
      "twitch-eventsub-message-signature": signature,
      "twitch-eventsub-message-type": options.type ?? "notification",
      "twitch-eventsub-subscription-type":
        options.subscriptionType ?? REDEMPTION_ADD,
      "twitch-eventsub-subscription-version": "1",
    },
  })
}

afterEach(() => {
  vi.unstubAllEnvs()
  vi.restoreAllMocks()
  mocks.getServerFirebase.mockClear()
  mocks.createEventSubStore.mockClear()
  mocks.save.mockReset().mockResolvedValue("created")
  vi.useRealTimers()
})

describe("EventSub route", () => {
  it("returns an exact challenge for the registered tenant", async () => {
    setLiveEnv()
    vi.setSystemTime(clock)
    const challenge = "exact opaque challenge"
    const response = await POST(
      request(payload(challenge), {
        type: "webhook_callback_verification",
      })
    )
    expect(response.status).toBe(200)
    expect(await response.text()).toBe(challenge)
    expect(response.headers.get("content-type")).toContain("text/plain")
    expect(response.headers.get("content-length")).toBe(
      String(Buffer.byteLength(challenge))
    )
    expect(mocks.getServerFirebase).toHaveBeenCalled()
  })

  it("durably saves a valid notification before acknowledging it", async () => {
    setLiveEnv()
    vi.setSystemTime(clock)
    const response = await POST(request(payload()))
    expect(response.status).toBe(204)
    expect(mocks.save).toHaveBeenCalledOnce()
    expect(mocks.createEventSubStore).toHaveBeenCalledWith(
      expect.anything(),
      "42"
    )
    expect(mocks.save).toHaveBeenCalledWith(
      expect.objectContaining({ kind: "redemption" })
    )
  })

  it("durably saves poll completion through the same thin webhook", async () => {
    setLiveEnv()
    vi.setSystemTime(clock)
    const value = {
      subscription: {
        id: "poll-subscription-1",
        status: "enabled",
        type: POLL_END,
        version: "1",
        condition: { broadcaster_user_id: "42" },
      },
      event: {
        id: "poll-1",
        broadcaster_user_id: "42",
        broadcaster_user_login: "owner",
        broadcaster_user_name: "Owner",
        title: "What should we do next?",
        choices: [
          { id: "choice-1", title: "Mystery challenge", votes: 2 },
          { id: "choice-2", title: "Find something blue", votes: 5 },
        ],
        status: "completed",
        started_at: "2026-10-30T17:58:00Z",
        ended_at: "2026-10-30T17:59:00Z",
      },
    }
    const response = await POST(request(value, { subscriptionType: POLL_END }))
    expect(response.status).toBe(204)
    expect(mocks.save).toHaveBeenCalledWith(
      expect.objectContaining({ kind: "poll_end" })
    )
    expect(mocks.applyPollEnd).toHaveBeenCalledWith("poll-1", clock)
  })

  it("still acknowledges a saved poll end when applying it fails", async () => {
    setLiveEnv()
    vi.setSystemTime(clock)
    mocks.applyPollEnd.mockRejectedValueOnce(new Error("synthetic contention"))
    const value = {
      subscription: {
        id: "poll-subscription-1",
        status: "enabled",
        type: POLL_END,
        version: "1",
        condition: { broadcaster_user_id: "42" },
      },
      event: {
        id: "poll-2",
        broadcaster_user_id: "42",
        broadcaster_user_login: "owner",
        broadcaster_user_name: "Owner",
        title: "What should we do next?",
        choices: [
          { id: "choice-1", title: "Mystery challenge", votes: 2 },
          { id: "choice-2", title: "Find something blue", votes: 5 },
        ],
        status: "completed",
        started_at: "2026-10-30T17:58:00Z",
        ended_at: "2026-10-30T17:59:00Z",
      },
    }
    const response = await POST(request(value, { subscriptionType: POLL_END }))
    expect(response.status).toBe(204)
  })

  it("rejects an invalid signature without initializing Firebase", async () => {
    setLiveEnv()
    vi.setSystemTime(clock)
    const response = await POST(request(payload(), { secret: "wrong" }))
    expect(response.status).toBe(403)
    expect(await response.text()).toBe("invalid_signature")
    expect(mocks.getServerFirebase).not.toHaveBeenCalled()
  })

  it("returns a retryable response when the durable write fails", async () => {
    setLiveEnv()
    vi.setSystemTime(clock)
    mocks.save.mockRejectedValueOnce(new Error("synthetic outage"))
    const response = await POST(request(payload()))
    expect(response.status).toBe(503)
    expect(await response.text()).toBe("temporarily_unavailable")
  })

  it("is unavailable in emulator mode before initializing Firebase", async () => {
    for (const [key, value] of Object.entries(demoEnv)) vi.stubEnv(key, value)
    const response = await POST(request(payload()))
    expect(response.status).toBe(404)
    expect(mocks.getServerFirebase).not.toHaveBeenCalled()
  })
})
