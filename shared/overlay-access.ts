import { createHash, timingSafeEqual } from "node:crypto"

export class OverlayAccessError extends Error {
  constructor(
    public readonly code: string,
    public readonly status: number
  ) {
    super(code)
  }
}

export function overlaySecretHash(secret: string) {
  return createHash("sha256").update(secret).digest("hex")
}

export function parseOverlaySecret(authorization: string | null) {
  const match = /^Bearer ([A-Za-z0-9_-]{32,128})$/.exec(authorization ?? "")
  if (!match) throw new OverlayAccessError("unauthorized", 401)
  return match[1]
}

export function requireOverlayAccess(secret: string, expectedHash: string) {
  const supplied = Buffer.from(overlaySecretHash(secret))
  const expected = Buffer.from(expectedHash)
  if (
    supplied.length !== expected.length ||
    !timingSafeEqual(supplied, expected)
  ) {
    throw new OverlayAccessError("unauthorized", 401)
  }
}
