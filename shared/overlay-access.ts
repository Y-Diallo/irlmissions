import { timingSafeEqual } from "node:crypto"
import { readServerConfig, type Environment } from "@/shared/config"

export class OverlayAccessError extends Error {
  constructor(
    public readonly code: string,
    public readonly status: number
  ) {
    super(code)
  }
}

export function readOverlayAccessKey(env: Environment) {
  readServerConfig(env)
  const key = env.OVERLAY_ACCESS_KEY?.trim()
  if (!key || !/^[A-Za-z0-9_-]{32,128}$/.test(key)) {
    throw new OverlayAccessError("overlay_configuration", 503)
  }
  return key
}

export function requireOverlayAccess(
  authorization: string | null,
  expectedKey: string
) {
  const match = /^Bearer ([A-Za-z0-9_-]{32,128})$/.exec(authorization ?? "")
  if (!match) throw new OverlayAccessError("unauthorized", 401)
  const supplied = Buffer.from(match[1])
  const expected = Buffer.from(expectedKey)
  if (
    supplied.length !== expected.length ||
    !timingSafeEqual(supplied, expected)
  ) {
    throw new OverlayAccessError("unauthorized", 401)
  }
}
