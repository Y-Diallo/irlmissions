export type TenantContext = {
  tenantId: string
  uid: string
  mode: "emulator" | "demo" | "live"
}

const LIVE_TENANT = /^\d{1,32}$/
const DEMO_TENANT = /^demo-[A-Za-z0-9_-]{1,64}$/

export function validateTenantId(value: unknown, mode?: "emulator" | "live") {
  if (typeof value !== "string") throw new Error("invalid_tenant")
  const valid =
    mode === "live"
      ? LIVE_TENANT.test(value)
      : mode === "emulator"
        ? DEMO_TENANT.test(value)
        : LIVE_TENANT.test(value) || DEMO_TENANT.test(value)
  if (!valid) throw new Error("invalid_tenant")
  return value
}

export function tenantRoot(tenantId: string) {
  return `owners/${validateTenantId(tenantId)}`
}

export function tenantDoc(tenantId: string, relativePath: string) {
  if (
    !relativePath ||
    relativePath.startsWith("/") ||
    relativePath.endsWith("/") ||
    relativePath.includes("//")
  ) {
    throw new Error("invalid_tenant_path")
  }
  return `${tenantRoot(tenantId)}/${relativePath}`
}
