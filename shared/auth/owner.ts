import { readServerConfig, type Environment } from "../config"
import { DEMO_OWNER_UID } from "./demo-owner"
import { AuthError, ownerUid } from "./twitch"
import { validateTenantId, type TenantContext } from "../tenant"

export type VerifiedIdentity = {
  uid: string
  owner?: unknown
  twitchUserId?: unknown
}
export type OwnerPolicy = { mode: "emulator" | "live" }

export function readOwnerPolicy(env: Environment): OwnerPolicy {
  const config = readServerConfig(env)
  if (config.mode === "emulator") return { mode: "emulator" }
  return { mode: "live" }
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
  let tenantId = "demo-owner"
  if (policy.mode === "live") {
    try {
      tenantId = validateTenantId(identity.twitchUserId, "live")
    } catch {
      throw new AuthError("owner", 403)
    }
  }
  const valid =
    policy.mode === "emulator"
      ? identity.uid === DEMO_OWNER_UID
      : identity.uid === ownerUid(tenantId) && identity.twitchUserId === tenantId
  if (!valid || identity.owner !== true) throw new AuthError("owner", 403)
  // Never spread a decoded JWT into a response (it may contain unrelated claims).
  return {
    uid: identity.uid,
    mode: policy.mode,
    tenantId,
    ...(policy.mode === "live" ? { twitchUserId: tenantId } : {}),
  } satisfies TenantContext & { twitchUserId?: string }
}
