import { createHash, createHmac, timingSafeEqual } from "node:crypto"
import type { Environment } from "@/shared/config"
import { readServerConfig } from "@/shared/config"

export const REDEMPTION_ADD =
  "channel.channel_points_custom_reward_redemption.add"
export const REDEMPTION_VERSION = "1"
export const EVENTSUB_MAX_AGE_MS = 10 * 60 * 1000
const EVENTSUB_MAX_FUTURE_MS = 60 * 1000
const EVENTSUB_MAX_BODY_BYTES = 1024 * 1024

export type EventSubConfig = {
  secret: string
  broadcasterId: string
  rewardId: string
}

export type EventSubHeaders = {
  messageId: string | null
  messageTimestamp: string | null
  messageSignature: string | null
  messageType: string | null
  subscriptionType: string | null
  subscriptionVersion: string | null
}

export type EventSubReceipt = {
  messageId: string
  messageType: "notification" | "revocation"
  subscriptionId: string
  subscriptionType: string
  subscriptionVersion: string
  subscriptionStatus: string
  receivedAt: number
}

export type PendingPitch = {
  redemptionId: string
  sourceMessageId: string
  broadcasterId: string
  viewer: { id: string; login: string; name: string }
  reward: { id: string; title: string; prompt: string; cost: number }
  rawText: string
  redeemedAt: string
  redemptionStatus: "unfulfilled"
  reviewStatus: "processing"
  processing: { status: "pending"; attempts: 0; nextAttemptAt: number }
  createdAt: number
  updatedAt: number
}

export type EventSubWrite =
  | { kind: "redemption"; receipt: EventSubReceipt; pitch: PendingPitch }
  | { kind: "revocation"; receipt: EventSubReceipt }

export type EventSubSaveResult =
  "created" | "duplicate-message" | "duplicate-redemption"

export type EventSubStore = {
  save(write: EventSubWrite): Promise<EventSubSaveResult>
}

export type EventSubResult =
  | { kind: "challenge"; challenge: string }
  | { kind: "accepted"; result: EventSubSaveResult }

export class EventSubError extends Error {
  constructor(
    public readonly code: string,
    public readonly status: number
  ) {
    super(code)
  }
}

function required(env: Environment, key: string) {
  const value = env[key]?.trim()
  if (!value) throw new Error(`Missing configuration: ${key}`)
  return value
}

export function readEventSubConfig(env: Environment): EventSubConfig {
  if (readServerConfig(env).mode !== "live") {
    throw new EventSubError("not_found", 404)
  }
  const secret = required(env, "TWITCH_EVENTSUB_SECRET")
  if (secret.length < 10 || secret.length > 100) {
    throw new Error("TWITCH_EVENTSUB_SECRET must be 10 to 100 characters")
  }
  const broadcasterId = required(env, "TWITCH_OWNER_ID")
  if (!/^\d{1,32}$/.test(broadcasterId)) {
    throw new Error("TWITCH_OWNER_ID must be a numeric Twitch user ID")
  }
  return {
    secret,
    broadcasterId,
    rewardId: required(env, "TWITCH_REWARD_ID"),
  }
}

function text(
  value: unknown,
  field: string,
  options: { min?: number; max?: number } = {}
) {
  const { min = 1, max = 512 } = options
  if (typeof value !== "string" || value.length < min || value.length > max) {
    throw new EventSubError(`invalid_${field}`, 400)
  }
  return value
}

function record(value: unknown, field: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new EventSubError(`invalid_${field}`, 400)
  }
  return value as Record<string, unknown>
}

function safeEqual(left: string, right: string) {
  const a = Buffer.from(left)
  const b = Buffer.from(right)
  return a.length === b.length && timingSafeEqual(a, b)
}

function verifyEnvelope(
  config: EventSubConfig,
  headers: EventSubHeaders,
  rawBody: string,
  now: number
) {
  if (Buffer.byteLength(rawBody, "utf8") > EVENTSUB_MAX_BODY_BYTES) {
    throw new EventSubError("body_too_large", 413)
  }
  const messageId = text(headers.messageId, "message_id")
  const timestamp = text(headers.messageTimestamp, "message_timestamp")
  const signature = text(headers.messageSignature, "message_signature")
  const sentAt = Date.parse(timestamp)
  if (
    !Number.isFinite(sentAt) ||
    sentAt < now - EVENTSUB_MAX_AGE_MS ||
    sentAt > now + EVENTSUB_MAX_FUTURE_MS
  ) {
    throw new EventSubError("stale_message", 403)
  }
  const expected = `sha256=${createHmac("sha256", config.secret)
    .update(messageId + timestamp + rawBody)
    .digest("hex")}`
  if (!safeEqual(expected, signature)) {
    throw new EventSubError("invalid_signature", 403)
  }
  return { messageId }
}

function parseBody(rawBody: string) {
  try {
    return record(JSON.parse(rawBody), "body")
  } catch (error) {
    if (error instanceof EventSubError) throw error
    throw new EventSubError("invalid_json", 400)
  }
}

function expectedSubscription(
  config: EventSubConfig,
  headers: EventSubHeaders,
  body: Record<string, unknown>
) {
  if (
    headers.subscriptionType !== REDEMPTION_ADD ||
    headers.subscriptionVersion !== REDEMPTION_VERSION
  ) {
    throw new EventSubError("unexpected_subscription", 400)
  }
  const subscription = record(body.subscription, "subscription")
  const type = text(subscription.type, "subscription_type")
  const version = text(subscription.version, "subscription_version")
  const condition = record(subscription.condition, "condition")
  if (
    type !== headers.subscriptionType ||
    version !== headers.subscriptionVersion ||
    condition.broadcaster_user_id !== config.broadcasterId ||
    condition.reward_id !== config.rewardId
  ) {
    throw new EventSubError("unexpected_subscription", 400)
  }
  return {
    id: text(subscription.id, "subscription_id"),
    type,
    version,
    status: text(subscription.status, "subscription_status"),
  }
}

function redemptionPitch(
  config: EventSubConfig,
  body: Record<string, unknown>,
  messageId: string,
  now: number
): PendingPitch {
  const event = record(body.event, "event")
  const reward = record(event.reward, "reward")
  const cost = reward.cost
  if (!Number.isSafeInteger(cost) || (cost as number) < 0) {
    throw new EventSubError("invalid_reward_cost", 400)
  }
  if (
    event.broadcaster_user_id !== config.broadcasterId ||
    reward.id !== config.rewardId ||
    event.status !== "unfulfilled"
  ) {
    throw new EventSubError("unexpected_redemption", 400)
  }
  const redeemedAt = text(event.redeemed_at, "redeemed_at")
  if (!Number.isFinite(Date.parse(redeemedAt))) {
    throw new EventSubError("invalid_redeemed_at", 400)
  }
  return {
    redemptionId: text(event.id, "redemption_id"),
    sourceMessageId: messageId,
    broadcasterId: config.broadcasterId,
    viewer: {
      id: text(event.user_id, "viewer_id"),
      login: text(event.user_login, "viewer_login"),
      name: text(event.user_name, "viewer_name"),
    },
    reward: {
      id: config.rewardId,
      title: text(reward.title, "reward_title"),
      prompt: text(reward.prompt, "reward_prompt", { min: 0, max: 2000 }),
      cost: cost as number,
    },
    rawText: text(event.user_input, "user_input", { min: 1, max: 5000 }),
    redeemedAt,
    redemptionStatus: "unfulfilled",
    reviewStatus: "processing",
    processing: { status: "pending", attempts: 0, nextAttemptAt: now },
    createdAt: now,
    updatedAt: now,
  }
}

export async function acceptEventSub(
  config: EventSubConfig,
  input: { headers: EventSubHeaders; rawBody: string },
  deps: { store: EventSubStore; now: () => number }
): Promise<EventSubResult> {
  const now = deps.now()
  const { messageId } = verifyEnvelope(
    config,
    input.headers,
    input.rawBody,
    now
  )
  const body = parseBody(input.rawBody)
  const subscription = expectedSubscription(config, input.headers, body)
  const messageType = input.headers.messageType

  if (messageType === "webhook_callback_verification") {
    return {
      kind: "challenge",
      challenge: text(body.challenge, "challenge", { max: 4096 }),
    }
  }
  if (messageType !== "notification" && messageType !== "revocation") {
    throw new EventSubError("unexpected_message_type", 400)
  }

  const receipt: EventSubReceipt = {
    messageId,
    messageType,
    subscriptionId: subscription.id,
    subscriptionType: subscription.type,
    subscriptionVersion: subscription.version,
    subscriptionStatus: subscription.status,
    receivedAt: now,
  }
  const write: EventSubWrite =
    messageType === "notification"
      ? {
          kind: "redemption",
          receipt,
          pitch: redemptionPitch(config, body, messageId, now),
        }
      : { kind: "revocation", receipt }
  return { kind: "accepted", result: await deps.store.save(write) }
}

export function eventSubStorageId(value: string) {
  return createHash("sha256").update(value).digest("hex")
}
