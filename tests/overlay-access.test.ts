import { describe, expect, it } from "vitest"
import {
  readOverlayAccessKey,
  requireOverlayAccess,
} from "@/shared/overlay-access"
import { demoEnv } from "./fixtures"

const key = "overlay_test_key_1234567890_abcdef"

describe("overlay access", () => {
  it("accepts only the exact server-configured bearer key", () => {
    expect(readOverlayAccessKey({ ...demoEnv, OVERLAY_ACCESS_KEY: key })).toBe(
      key
    )
    expect(() => requireOverlayAccess(`Bearer ${key}`, key)).not.toThrow()
    expect(() =>
      requireOverlayAccess("Bearer wrong_key_1234567890123456789012", key)
    ).toThrow("unauthorized")
    expect(() => requireOverlayAccess(null, key)).toThrow("unauthorized")
  })

  it("fails closed on weak keys or invalid runtime isolation", () => {
    expect(() =>
      readOverlayAccessKey({ ...demoEnv, OVERLAY_ACCESS_KEY: "too-short" })
    ).toThrow("overlay_configuration")
    expect(() =>
      readOverlayAccessKey({
        ...demoEnv,
        NEXT_PUBLIC_APP_MODE: "live",
        OVERLAY_ACCESS_KEY: key,
      })
    ).toThrow()
  })
})
