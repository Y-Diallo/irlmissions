import { vi } from "vitest"
import { demoEnv } from "./fixtures"
import {
  TWITCH_SCOPES,
  type AuthDependencies,
  type Handoff,
  type TwitchConfig,
  type TwitchCredentials,
} from "@/shared/auth/twitch"

export const liveEnv = {
  ...demoEnv,
  NEXT_PUBLIC_APP_MODE: "live",
  NEXT_PUBLIC_FIREBASE_PROJECT_ID: "test-live-project",
  FIREBASE_PROJECT_ID: "test-live-project",
  NEXT_PUBLIC_FIREBASE_AUTH_EMULATOR_HOST: undefined,
  NEXT_PUBLIC_FIRESTORE_EMULATOR_HOST: undefined,
  FIREBASE_AUTH_EMULATOR_HOST: undefined,
  FIRESTORE_EMULATOR_HOST: undefined,
  TWITCH_CLIENT_ID: "test-client",
  TWITCH_CLIENT_SECRET: "test-secret",
  TWITCH_OWNER_ID: "42",
  TWITCH_REDIRECT_URI: "https://producer.example/api/auth/twitch/callback",
}
export const twitchConfig: TwitchConfig = {
  clientId: liveEnv.TWITCH_CLIENT_ID,
  clientSecret: liveEnv.TWITCH_CLIENT_SECRET,
  ownerId: liveEnv.TWITCH_OWNER_ID,
  redirectUri: liveEnv.TWITCH_REDIRECT_URI,
}
export const clock = 1700000000000
export const credentials: TwitchCredentials = {
  userId: "42",
  clientId: "test-client",
  login: "streamer",
  accessToken: "test-access",
  refreshToken: "test-refresh",
  scopes: [...TWITCH_SCOPES],
  expiresIn: 3600,
  expiresAt: clock + 3600000,
  connectionId: "test-connection",
}

export function authFixture() {
  let record: TwitchCredentials | null = { ...credentials }
  const handoffs = new Map<string, Handoff>()
  const store = {
    readTokens: vi.fn(async () => record),
    saveTokens: vi.fn(async (value: TwitchCredentials) => {
      record = value
    }),
    deleteTokens: vi.fn(async (_expected: string) => {
      record = null
      return true
    }),
    claimRefresh: vi.fn(
      async (_expected: string, _lease: string, _now: number) => true
    ),
    finishRefresh: vi.fn(async (value: TwitchCredentials, _lease: string) => {
      record = value
      return true
    }),
    releaseRefresh: vi.fn(async (_lease: string) => {}),
    saveHandoff: vi.fn(async (hash: string, value: Handoff) => {
      handoffs.set(hash, value)
    }),
    consumeHandoff: vi.fn(async (hash: string, now: number) => {
      const value = handoffs.get(hash)
      handoffs.delete(hash)
      return value && value.expiresAt > now ? value : null
    }),
  }
  const provider = {
    exchange: vi.fn(async (_code: string) => ({
      accessToken: "test-access",
      refreshToken: "test-refresh",
      expiresIn: 3600,
    })),
    refresh: vi.fn(async (_refresh: string) => ({
      accessToken: "rotated-access",
      refreshToken: "rotated-refresh",
      expiresIn: 3600,
    })),
    validate: vi.fn(async (_access: string) => ({
      userId: "42",
      clientId: "test-client",
      login: "streamer",
      scopes: [...TWITCH_SCOPES],
      expiresIn: 3600,
    })),
    revoke: vi.fn(async (_access: string) => {}),
  }
  const mintToken = vi.fn(
    async (_uid: string, _claims: { owner: boolean; twitchUserId: string }) =>
      "firebase-custom-token"
  )
  const revokeSessions = vi.fn(async (_uid: string) => {})
  const deps: AuthDependencies = {
    store,
    provider,
    mintToken,
    revokeSessions,
    now: () => clock,
  }
  return { deps, store, provider, mintToken, revokeSessions, handoffs }
}
