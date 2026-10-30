import type { Environment } from "@/shared/config"
import { readServerConfig } from "@/shared/config"

export type ProcessorScheduleConfig = {
  audience: string
  serviceAccountEmail: string
}

export type GoogleIdTokenPayload = {
  email?: string
  email_verified?: boolean
  sub?: string
}

export class ProcessorScheduleError extends Error {
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

export function readProcessorScheduleConfig(
  env: Environment
): ProcessorScheduleConfig {
  if (readServerConfig(env).mode !== "live") {
    throw new ProcessorScheduleError("not_found", 404)
  }
  const audience = required(env, "PROCESSOR_AUDIENCE")
  const url = new URL(audience)
  if (
    url.protocol !== "https:" ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    url.pathname !== "/api/internal/process"
  ) {
    throw new Error(
      "PROCESSOR_AUDIENCE must be the HTTPS /api/internal/process URL"
    )
  }
  const serviceAccountEmail = required(
    env,
    "PROCESSOR_SERVICE_ACCOUNT_EMAIL"
  ).toLowerCase()
  if (
    !/^[^\s@]+@[^\s@]+\.iam\.gserviceaccount\.com$/.test(serviceAccountEmail)
  ) {
    throw new Error("Invalid PROCESSOR_SERVICE_ACCOUNT_EMAIL")
  }
  return { audience: url.toString(), serviceAccountEmail }
}

export async function authenticateScheduledProcessor(
  authorization: string | null,
  config: ProcessorScheduleConfig,
  verify: (
    token: string,
    audience: string
  ) => Promise<GoogleIdTokenPayload | null>
) {
  const match = /^Bearer ([A-Za-z0-9._~-]+)$/.exec(authorization ?? "")
  if (!match) throw new ProcessorScheduleError("unauthorized", 401)
  let payload: GoogleIdTokenPayload | null
  try {
    payload = await verify(match[1], config.audience)
  } catch {
    throw new ProcessorScheduleError("unauthorized", 401)
  }
  if (
    !payload ||
    payload.email_verified !== true ||
    payload.email?.toLowerCase() !== config.serviceAccountEmail
  ) {
    throw new ProcessorScheduleError("unauthorized", 401)
  }
  return { serviceAccountEmail: config.serviceAccountEmail }
}
