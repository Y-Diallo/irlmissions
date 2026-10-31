import { getServerFirebase } from "@/lib/firebase/admin"
import { createEventSubStore } from "@/lib/eventsub/store"
import {
  acceptEventSub,
  EventSubError,
  identifyEventSubTenant,
  readEventSubConfig,
  readEventSubSecret,
  type EventSubHeaders,
} from "@/shared/eventsub"

export const runtime = "nodejs"

function headers(request: Request): EventSubHeaders {
  return {
    messageId: request.headers.get("twitch-eventsub-message-id"),
    messageTimestamp: request.headers.get("twitch-eventsub-message-timestamp"),
    messageSignature: request.headers.get("twitch-eventsub-message-signature"),
    messageType: request.headers.get("twitch-eventsub-message-type"),
    subscriptionType: request.headers.get("twitch-eventsub-subscription-type"),
    subscriptionVersion: request.headers.get(
      "twitch-eventsub-subscription-version"
    ),
  }
}

function response(body: BodyInit | null, init: ResponseInit = {}) {
  const result = new Response(body, init)
  result.headers.set("Cache-Control", "no-store")
  return result
}

export async function POST(request: Request) {
  try {
    const rawBody = await request.text()
    const input = { headers: headers(request), rawBody }
    const broadcasterId = identifyEventSubTenant(
      readEventSubSecret(process.env),
      input
    )
    const integration = (
      await getServerFirebase().db.doc(
        `owners/${broadcasterId}/private/integrations`
      ).get()
    ).data()
    const rewardId = integration?.rewardId
    const config = readEventSubConfig(
      process.env,
      broadcasterId,
      typeof rewardId === "string" ? rewardId : ""
    )
    const result = await acceptEventSub(
      config,
      input,
      {
        store: {
          save(write) {
            return createEventSubStore(
              getServerFirebase().db,
              broadcasterId
            ).save(write)
          },
        },
        now: Date.now,
      }
    )
    if (result.kind === "challenge") {
      return response(result.challenge, {
        status: 200,
        headers: {
          "Content-Type": "text/plain; charset=utf-8",
          "Content-Length": String(Buffer.byteLength(result.challenge)),
        },
      })
    }
    return response(null, { status: 204 })
  } catch (error) {
    if (error instanceof EventSubError) {
      return response(error.code, { status: error.status })
    }
    return response("temporarily_unavailable", { status: 503 })
  }
}
