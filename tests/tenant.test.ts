import { describe, expect, it } from "vitest"
import { tenantDoc, tenantRoot, validateTenantId } from "@/shared/tenant"

describe("tenant paths", () => {
  it("creates isolated paths for Twitch and emulator tenants", () => {
    expect(tenantRoot("42")).toBe("owners/42")
    expect(tenantDoc("42", "pitches/abc")).toBe("owners/42/pitches/abc")
    expect(tenantDoc("99", "pitches/abc")).toBe("owners/99/pitches/abc")
    expect(tenantDoc("demo-owner", "sessions/current")).toBe(
      "owners/demo-owner/sessions/current"
    )
  })

  it("rejects paths and IDs that could escape a tenant", () => {
    expect(() => validateTenantId("42/../99")).toThrow("invalid_tenant")
    expect(() => tenantDoc("42", "/pitches/abc")).toThrow(
      "invalid_tenant_path"
    )
    expect(() => validateTenantId("demo-owner", "live")).toThrow(
      "invalid_tenant"
    )
  })
})
