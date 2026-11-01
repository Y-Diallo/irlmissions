import { readServerConfig, type Environment } from "../config"
import { DEMO_OWNER_UID } from "./demo-owner"
import { AuthError, ownerUid } from "./twitch"
import { validateTenantId, type TenantContext } from "../tenant"

export type VerifiedIdentity = {
  uid: string
  owner?: unknown
  demo?: unknown
  twitchUserId?: unknown
}
export type OwnerPolicy = {
  mode: "emulator" | "live"
  demoEnabled?: boolean
}

export function readOwnerPolicy(env: Environment): OwnerPolicy {
  const config = readServerConfig(env)
  if (config.mode === "emulator") return { mode: "emulator" }
  return { mode: "live", demoEnabled: env.DEMO_MODE_ENABLED === "true" }
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
  if (
    policy.demoEnabled &&
    identity.uid === DEMO_OWNER_UID &&
    identity.owner === true &&
    identity.demo === true
  ) {
    return {
      uid: identity.uid,
      mode: "demo",
      tenantId: DEMO_OWNER_UID,
    } satisfies TenantContext
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
      : identity.uid === ownerUid(tenantId) &&
        identity.twitchUserId === tenantId
  if (!valid || identity.owner !== true) throw new AuthError("owner", 403)
  // Never spread a decoded JWT into a response (it may contain unrelated claims).
  return {
    uid: identity.uid,
    mode: policy.mode,
    tenantId,
    ...(policy.mode === "live" ? { twitchUserId: tenantId } : {}),
  } satisfies TenantContext & { twitchUserId?: string }
}
