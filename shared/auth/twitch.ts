import {
  createHash,
  createHmac,
  randomBytes,
  timingSafeEqual,
} from "node:crypto"
import { readServerConfig, type Environment } from "../config"

export const TWITCH_SCOPES = [
  "channel:manage:redemptions",
  "channel:manage:polls",
  "moderation:read",
] as const
export const STATE_SECONDS = 600
export const HANDOFF_SECONDS = 120

export class AuthError extends Error {
  constructor(
    public code: string,
    public status = 401
  ) {
    super(code)
  }
}
export class InvalidTwitchTokenError extends Error {}

export type TwitchConfig = {
  clientId: string
  clientSecret: string
  ownerId: string
  redirectUri: string
}
export type TokenPair = {
  accessToken: string
  refreshToken: string
  expiresIn: number
}
export type TwitchIdentity = {
  userId: string
  clientId: string
  login: string
  scopes: string[]
  expiresIn: number
}
export type TwitchCredentials = TokenPair &
  TwitchIdentity & {
    connectionId: string
    expiresAt: number
  }
export type Handoff = { uid: string; connectionId: string; expiresAt: number }

export interface TwitchAuthProvider {
  exchange(code: string): Promise<TokenPair>
  refresh(token: string): Promise<TokenPair>
  validate(token: string): Promise<TwitchIdentity>
  revoke(token: string): Promise<void>
}
export interface AuthStore {
  readTokens(): Promise<TwitchCredentials | null>
  saveTokens(tokens: TwitchCredentials): Promise<void>
  deleteTokens(accessToken: string): Promise<boolean>
  claimRefresh(
    accessToken: string,
    leaseId: string,
    now: number
  ): Promise<boolean>
  finishRefresh(tokens: TwitchCredentials, leaseId: string): Promise<boolean>
  releaseRefresh(leaseId: string): Promise<void>
  saveHandoff(hash: string, handoff: Handoff): Promise<void>
  consumeHandoff(hash: string, now: number): Promise<Handoff | null>
}
export type AuthDependencies = {
  provider: TwitchAuthProvider
  store: AuthStore
  mintToken(
    uid: string,
    claims: { owner: boolean; twitchUserId: string }
  ): Promise<string>
  revokeSessions(uid: string): Promise<void>
  now(): number
}

export const ownerUid = (ownerId: string) => `twitch:${ownerId}`
export const opaqueId = () => randomBytes(32).toString("base64url")
export const hashHandoff = (value: string) =>
  createHash("sha256").update(value).digest("hex")

export function readTwitchConfig(env: Environment): TwitchConfig {
  // Live OAuth must never reach Twitch while a judge is using emulators.
  if (env.NEXT_PUBLIC_APP_MODE !== "live") throw new AuthError("disabled", 404)
  readServerConfig(env)
  const required = (key: string) => {
    const value = env[key]?.trim()
    if (!value) throw new AuthError("configuration", 503)
    return value
  }
  const config = {
    clientId: required("TWITCH_CLIENT_ID"),
    clientSecret: required("TWITCH_CLIENT_SECRET"),
    ownerId: required("TWITCH_OWNER_ID"),
    redirectUri: required("TWITCH_REDIRECT_URI"),
  }
  let uri: URL
  try {
    uri = new URL(config.redirectUri)
  } catch {
    throw new AuthError("configuration", 503)
  }
  if (
    !/^\d{1,32}$/.test(config.ownerId) ||
    uri.pathname !== "/api/auth/twitch/callback" ||
    uri.search ||
    uri.hash ||
    uri.username ||
    uri.password ||
    (uri.protocol !== "https:" &&
      !(
        uri.protocol === "http:" &&
        ["localhost", "127.0.0.1", "[::1]"].includes(uri.hostname)
      ))
  )
    throw new AuthError("configuration", 503)
  return config
}

function signState(payload: string, secret: string) {
  return createHmac("sha256", secret)
    .update(`irl-oauth-state:${payload}`)
    .digest("hex")
}
function equalSecret(a: string, b: string) {
  const first = Buffer.from(a)
  const second = Buffer.from(b)
  return first.length === second.length && timingSafeEqual(first, second)
}
export function createOAuthState(secret: string, now = Date.now()) {
  const payload = `${opaqueId()}.${now}`
  return `${payload}.${signState(payload, secret)}`
}
export function verifyOAuthState(
  state: string | null,
  cookie: string | undefined,
  secret: string,
  now = Date.now()
) {
  if (!state || !cookie || state.length > 256 || !equalSecret(state, cookie))
    throw new AuthError("state", 400)
  const parts = state.split(".")
  if (parts.length !== 3) throw new AuthError("state", 400)
  const timestamp = Number(parts[1])
  const age = now - timestamp
  if (
    !Number.isFinite(timestamp) ||
    age < 0 ||
    age > STATE_SECONDS * 1000 ||
    !equalSecret(parts[2], signState(`${parts[0]}.${parts[1]}`, secret))
  ) {
    throw new AuthError("state", 400)
  }
}
export function authorizationUrl(config: TwitchConfig, state: string) {
  const url = new URL("https://id.twitch.tv/oauth2/authorize")
  url.search = new URLSearchParams({
    client_id: config.clientId,
    redirect_uri: config.redirectUri,
    response_type: "code",
    scope: TWITCH_SCOPES.join(" "),
    state,
  }).toString()
  return url.toString()
}
export function verifyTwitchIdentity(
  config: TwitchConfig,
  identity: TwitchIdentity
) {
  if (
    identity.userId !== config.ownerId ||
    identity.clientId !== config.clientId
  )
    throw new AuthError("owner", 403)
  if (!TWITCH_SCOPES.every((scope) => identity.scopes.includes(scope)))
    throw new AuthError("scopes", 403)
}

export async function completeTwitchLogin(
  config: TwitchConfig,
  callback: { code: string | null; state: string | null; error: string | null },
  stateCookie: string | undefined,
  load: () => Promise<AuthDependencies>,
  now = Date.now()
) {
  verifyOAuthState(callback.state, stateCookie, config.clientSecret, now)
  if (callback.error) throw new AuthError("denied", 400)
  if (!callback.code || callback.code.length > 2048)
    throw new AuthError("code", 400)
  const deps = await load()
  const pair = await deps.provider.exchange(callback.code)
  let identity: TwitchIdentity
  try {
    identity = await deps.provider.validate(pair.accessToken)
    verifyTwitchIdentity(config, identity)
  } catch (error) {
    // Discard a grant from the wrong account without persisting it.
    await deps.provider.revoke(pair.accessToken).catch(() => undefined)
    throw error
  }
  const tokens: TwitchCredentials = {
    ...pair,
    ...identity,
    connectionId: opaqueId(),
    expiresAt: deps.now() + identity.expiresIn * 1000,
  }
  await deps.store.saveTokens(tokens)
  const handoff = opaqueId()
  await deps.store.saveHandoff(hashHandoff(handoff), {
    uid: ownerUid(config.ownerId),
    connectionId: tokens.connectionId,
    expiresAt: deps.now() + HANDOFF_SECONDS * 1000,
  })
  return handoff
}

async function disconnect(
  config: TwitchConfig,
  deps: AuthDependencies,
  token: string
) {
  if (await deps.store.deleteTokens(token))
    await deps.revokeSessions(ownerUid(config.ownerId))
}

// Validate on every use: startup, foreground checks, and later privileged commands.
// This also discovers revocation even before the recorded expiry time.
export async function getTwitchAccessToken(
  config: TwitchConfig,
  deps: AuthDependencies,
  forceRefresh = false
) {
  const current = await deps.store.readTokens()
  if (!current) throw new AuthError("expired")
  if (
    current.userId !== config.ownerId ||
    current.clientId !== config.clientId
  ) {
    await disconnect(config, deps, current.accessToken)
    throw new AuthError("owner", 403)
  }
  if (!forceRefresh) {
    try {
      verifyTwitchIdentity(
        config,
        await deps.provider.validate(current.accessToken)
      )
      return current.accessToken
    } catch (error) {
      if (error instanceof AuthError && error.status === 403) {
        await disconnect(config, deps, current.accessToken)
        throw error
      }
      if (!(error instanceof InvalidTwitchTokenError)) throw error
    }
  }
  const leaseId = opaqueId()
  if (
    !(await deps.store.claimRefresh(current.accessToken, leaseId, deps.now()))
  )
    throw new AuthError("busy", 503)
  let activeToken = current.accessToken
  try {
    const pair = await deps.provider.refresh(current.refreshToken)
    // Preserve a rotated refresh token even if subsequent validation has a
    // transient outage. Nothing may use this pair without validating it first.
    const updated = {
      ...current,
      ...pair,
      expiresAt: deps.now() + pair.expiresIn * 1000,
    }
    if (!(await deps.store.finishRefresh(updated, leaseId)))
      throw new AuthError("busy", 503)
    activeToken = pair.accessToken
    const identity = await deps.provider.validate(pair.accessToken)
    verifyTwitchIdentity(config, identity)
    return updated.accessToken
  } catch (error) {
    if (
      error instanceof InvalidTwitchTokenError ||
      (error instanceof AuthError &&
        (error.code === "expired" || error.status === 403))
    ) {
      await disconnect(config, deps, activeToken)
      throw new AuthError("expired")
    }
    throw error
  } finally {
    await deps.store.releaseRefresh(leaseId)
  }
}

export async function exchangeHandoff(
  config: TwitchConfig,
  handoff: string | undefined,
  deps: AuthDependencies
) {
  if (!handoff || !/^[A-Za-z0-9_-]{43}$/.test(handoff))
    throw new AuthError("expired")
  const record = await deps.store.consumeHandoff(
    hashHandoff(handoff),
    deps.now()
  )
  const tokens = await deps.store.readTokens()
  if (
    !record ||
    record.uid !== ownerUid(config.ownerId) ||
    record.connectionId !== tokens?.connectionId
  )
    throw new AuthError("expired")
  await getTwitchAccessToken(config, deps)
  return deps.mintToken(record.uid, {
    owner: true,
    twitchUserId: config.ownerId,
  })
}
