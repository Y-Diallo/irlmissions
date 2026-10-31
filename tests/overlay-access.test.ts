import { describe, expect, it } from "vitest"
import {
  overlaySecretHash,
  parseOverlaySecret,
  requireOverlayAccess,
} from "@/shared/overlay-access"

const key = "overlay_test_key_1234567890_abcdef"

describe("overlay access", () => {
  it("accepts only the exact hashed tenant bearer key", () => {
    const hash = overlaySecretHash(key)
    expect(parseOverlaySecret(`Bearer ${key}`)).toBe(key)
    expect(() => requireOverlayAccess(key, hash)).not.toThrow()
    expect(() =>
      requireOverlayAccess("wrong_key_1234567890123456789012", hash)
    ).toThrow("unauthorized")
    expect(() => parseOverlaySecret(null)).toThrow("unauthorized")
  })

  it("rejects weak bearer credentials", () => {
    expect(() => parseOverlaySecret("Bearer too-short")).toThrow(
      "unauthorized"
    )
  })
})
