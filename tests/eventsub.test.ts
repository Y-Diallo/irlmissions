import { createHmac } from "node:crypto"
import { describe, expect, it, vi } from "vitest"
import {
  acceptEventSub,
  EVENTSUB_MAX_AGE_MS,
  REDEMPTION_ADD,
  type EventSubConfig,
  type EventSubHeaders,
  type EventSubStore,
  type EventSubWrite,
} from "@/shared/eventsub"

const now = Date.parse("2026-10-30T18:00:00.000Z")
const config: EventSubConfig = {
  secret: "test-secret-that-is-long-enough",
  broadcasterId: "42",
  rewardId: "reward-1",
}

function body(
  overrides: {
    challenge?: string
    broadcasterId?: string
    rewardId?: string
    redemptionId?: string
  } = {}
) {
  return {
    ...(overrides.challenge ? { challenge: overrides.challenge } : {}),
    subscription: {
      id: "subscription-1",
      status: overrides.challenge
        ? "webhook_callback_verification_pending"
        : "enabled",
      type: REDEMPTION_ADD,
      version: "1",
      condition: {
        broadcaster_user_id: overrides.broadcasterId ?? "42",
        reward_id: overrides.rewardId ?? "reward-1",
      },
    },
    event: {
      id: overrides.redemptionId ?? "redemption-1",
      broadcaster_user_id: overrides.broadcasterId ?? "42",
      broadcaster_user_login: "owner",
      broadcaster_user_name: "Owner",
      user_id: "viewer-1",
      user_login: "viewer",
      user_name: "Viewer",
      user_input: "Go eat a fish sandwich",
      status: "unfulfilled",
      redeemed_at: "2026-10-30T17:59:00.000Z",
      reward: {
        id: overrides.rewardId ?? "reward-1",
        title: "Pitch an objective",
        prompt: "What should I do?",
        cost: 1000,
      },
    },
  }
}

function envelope(
  rawBody: string,
  options: {
    id?: string
    timestamp?: string
    messageType?: string
    secret?: string
  } = {}
) {
  const messageId = options.id ?? "message-1"
  const timestamp = options.timestamp ?? new Date(now).toISOString()
  const signature = `sha256=${createHmac(
    "sha256",
    options.secret ?? config.secret
  )
    .update(messageId + timestamp + rawBody)
    .digest("hex")}`
  const headers: EventSubHeaders = {
    messageId,
    messageTimestamp: timestamp,
    messageSignature: signature,
    messageType: options.messageType ?? "notification",
    subscriptionType: REDEMPTION_ADD,
    subscriptionVersion: "1",
  }
  return { headers, rawBody }
}

function memoryStore() {
  const messages = new Set<string>()
  const redemptions = new Set<string>()
  const writes: EventSubWrite[] = []
  const store: EventSubStore = {
    async save(write) {
      if (messages.has(write.receipt.messageId)) return "duplicate-message"
      messages.add(write.receipt.messageId)
      writes.push(write)
      if (write.kind === "redemption") {
        if (redemptions.has(write.pitch.redemptionId))
          return "duplicate-redemption"
        redemptions.add(write.pitch.redemptionId)
      }
      return "created"
    },
  }
  return { store, writes }
}

describe("EventSub intake", () => {
  it("verifies and maps a redemption into pending work", async () => {
    const fixture = memoryStore()
    const raw = JSON.stringify(body(), null, 2)
    await expect(
      acceptEventSub(config, envelope(raw), {
        store: fixture.store,
        now: () => now,
      })
    ).resolves.toEqual({ kind: "accepted", result: "created" })
    expect(fixture.writes).toHaveLength(1)
    expect(fixture.writes[0]).toMatchObject({
      kind: "redemption",
      receipt: { messageId: "message-1", receivedAt: now },
      pitch: {
        redemptionId: "redemption-1",
        rawText: "Go eat a fish sandwich",
        reviewStatus: "processing",
        processing: { status: "pending", attempts: 0, nextAttemptAt: now },
      },
    })
  })

  it("returns the exact signed challenge without touching storage", async () => {
    const store = { save: vi.fn() }
    const challenge = "opaque challenge ✓"
    const raw = JSON.stringify(body({ challenge }))
    await expect(
      acceptEventSub(
        config,
        envelope(raw, { messageType: "webhook_callback_verification" }),
        { store, now: () => now }
      )
    ).resolves.toEqual({ kind: "challenge", challenge })
    expect(store.save).not.toHaveBeenCalled()
  })

  it("saves revocations as durable work without creating a pitch", async () => {
    const fixture = memoryStore()
    const payload = body()
    delete (payload as { event?: unknown }).event
    payload.subscription.status = "authorization_revoked"
    const raw = JSON.stringify(payload)
    await acceptEventSub(config, envelope(raw, { messageType: "revocation" }), {
      store: fixture.store,
      now: () => now,
    })
    expect(fixture.writes[0]).toMatchObject({
      kind: "revocation",
      receipt: { subscriptionStatus: "authorization_revoked" },
    })
  })

  it("deduplicates both retried messages and a redemption with a new message ID", async () => {
    const fixture = memoryStore()
    const raw = JSON.stringify(body())
    const deps = { store: fixture.store, now: () => now }
    await expect(acceptEventSub(config, envelope(raw), deps)).resolves.toEqual({
      kind: "accepted",
      result: "created",
    })
    await expect(acceptEventSub(config, envelope(raw), deps)).resolves.toEqual({
      kind: "accepted",
      result: "duplicate-message",
    })
    await expect(
      acceptEventSub(config, envelope(raw, { id: "message-2" }), deps)
    ).resolves.toEqual({
      kind: "accepted",
      result: "duplicate-redemption",
    })
  })

  it.each([
    ["wrong signature", { secret: "wrong-secret" }, "invalid_signature"],
    [
      "expired timestamp",
      { timestamp: new Date(now - EVENTSUB_MAX_AGE_MS - 1).toISOString() },
      "stale_message",
    ],
    [
      "future timestamp",
      { timestamp: new Date(now + 60_001).toISOString() },
      "stale_message",
    ],
  ])("rejects a %s before storage", async (_name, options, code) => {
    const store = { save: vi.fn() }
    const raw = JSON.stringify(body())
    await expect(
      acceptEventSub(config, envelope(raw, options), {
        store,
        now: () => now,
      })
    ).rejects.toMatchObject({ code, status: 403 })
    expect(store.save).not.toHaveBeenCalled()
  })

  it("signs the exact raw bytes and rejects body tampering", async () => {
    const raw = JSON.stringify(body())
    const signed = envelope(raw)
    await expect(
      acceptEventSub(
        config,
        { ...signed, rawBody: raw + " " },
        { store: memoryStore().store, now: () => now }
      )
    ).rejects.toMatchObject({ code: "invalid_signature" })
  })

  it.each([
    [body({ broadcasterId: "99" }), "unexpected_subscription"],
    [body({ rewardId: "other-reward" }), "unexpected_subscription"],
  ])("rejects another broadcaster or reward", async (payload, code) => {
    const store = { save: vi.fn() }
    await expect(
      acceptEventSub(config, envelope(JSON.stringify(payload)), {
        store,
        now: () => now,
      })
    ).rejects.toMatchObject({ code, status: 400 })
    expect(store.save).not.toHaveBeenCalled()
  })

  it("propagates durable-save failure so the route can ask Twitch to retry", async () => {
    const failure = new Error("synthetic Firestore outage")
    const store = { save: vi.fn().mockRejectedValue(failure) }
    await expect(
      acceptEventSub(config, envelope(JSON.stringify(body())), {
        store,
        now: () => now,
      })
    ).rejects.toBe(failure)
  })
})
