import { readServerConfig, type Environment } from "../config"
import { DEMO_OWNER_UID } from "./demo-owner"
import { AuthError, ownerUid } from "./twitch"

export type VerifiedIdentity = {
  uid: string
  owner?: unknown
  twitchUserId?: unknown
}
export type OwnerPolicy = { mode: "emulator" | "live"; ownerId?: string }

export function readOwnerPolicy(env: Environment): OwnerPolicy {
  const config = readServerConfig(env)
  if (config.mode === "emulator") return { mode: "emulator" }
  const ownerId = env.TWITCH_OWNER_ID?.trim()
  if (!ownerId || !/^\d{1,32}$/.test(ownerId))
    throw new AuthError("configuration", 503)
  return { mode: "live", ownerId }
}

export async function authenticateOwner(
  header: string | null,
  policy: OwnerPolicy,
  verify: (token: string) => Promise<VerifiedIdentity>
) {
  const match = /^Bearer ([^\s]+)$/.exec(header ?? "")
  if (!match) throw new AuthError("unauthorized")
  let identity: VerifiedIdentity
  try {
    identity = await verify(match[1])
  } catch (error) {
    if (error instanceof AuthError) throw error
    throw new AuthError("unauthorized")
  }
  const valid =
    policy.mode === "emulator"
      ? identity.uid === DEMO_OWNER_UID
      : !!policy.ownerId &&
        identity.uid === ownerUid(policy.ownerId) &&
        identity.twitchUserId === policy.ownerId
  if (!valid || identity.owner !== true) throw new AuthError("owner", 403)
  // Never spread a decoded JWT into a response (it may contain unrelated claims).
  return {
    uid: identity.uid,
    mode: policy.mode,
    ...(policy.mode === "live" ? { twitchUserId: policy.ownerId } : {}),
  }
}
