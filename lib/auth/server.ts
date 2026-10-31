import "server-only"
import { createTwitchAuthProvider } from "@/shared/providers/twitch-auth"
import {
  getTwitchAccessToken,
  AuthError,
  readTwitchConfig,
  type AuthDependencies,
  type TwitchConfig,
} from "@/shared/auth/twitch"
import { authenticateOwner, readOwnerPolicy } from "@/shared/auth/owner"

export async function loadAuthDependencies(
  config: TwitchConfig
): Promise<AuthDependencies> {
  const [{ getServerFirebase }, { createAuthStore }] = await Promise.all([
    import("@/lib/firebase/admin"),
    import("./store"),
  ])
  const { auth, db } = getServerFirebase()
  return {
    provider: createTwitchAuthProvider(config),
    store: createAuthStore(db),
    mintToken: (uid, claims) => auth.createCustomToken(uid, claims),
    revokeSessions: (uid) => auth.revokeRefreshTokens(uid),
    now: Date.now,
  }
}

// Use this gate for every future privileged command. Never trust browser claims.
export async function requireServerOwner(authorization: string | null) {
  const policy = readOwnerPolicy(process.env)
  const identity = await authenticateOwner(
    authorization,
    policy,
    async (token) => {
      const { getServerFirebase } = await import("@/lib/firebase/admin")
      try {
        return await getServerFirebase().auth.verifyIdToken(token, true)
      } catch (error) {
        const code =
          error && typeof error === "object" && "code" in error
            ? error.code
            : ""
        if (
          [
            "auth/id-token-expired",
            "auth/id-token-revoked",
            "auth/invalid-id-token",
            "auth/argument-error",
            "auth/user-not-found",
            "auth/user-disabled",
          ].includes(String(code))
        ) {
          throw new AuthError("unauthorized")
        }
        throw new AuthError("unavailable", 503)
      }
    }
  )
  if (policy.mode === "live") {
    const config = readTwitchConfig(process.env)
    await getTwitchAccessToken(
      config,
      await loadAuthDependencies(config),
      identity.tenantId
    )
  }
  return identity
}
