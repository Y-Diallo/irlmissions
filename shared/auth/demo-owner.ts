import { readServerConfig, type Environment } from "../config"

export const DEMO_OWNER_UID = "demo-owner"

export class DemoDisabledError extends Error {}

export function demoLoginEnabled(env: Environment) {
  // Fail closed before validating/initializing either Firebase environment.
  if (
    env.NEXT_PUBLIC_APP_MODE === "emulator" &&
    env.NODE_ENV === "production"
  ) {
    return false
  }
  if (env.NEXT_PUBLIC_APP_MODE === "live" && env.DEMO_MODE_ENABLED !== "true") {
    return false
  }
  const config = readServerConfig(env)
  return config.mode === "emulator" || env.DEMO_MODE_ENABLED === "true"
}

export function isDemoTenant(tenantId: string) {
  return tenantId === DEMO_OWNER_UID
}

export async function createDemoOwnerToken(
  env: Environment,
  mintToken: (
    uid: string,
    claims: { owner: boolean; demo: boolean }
  ) => Promise<string>
) {
  // Guard before invoking any SDK or reading credentials.
  if (!demoLoginEnabled(env)) {
    throw new DemoDisabledError("Demo login is disabled")
  }
  return mintToken(DEMO_OWNER_UID, { owner: true, demo: true })
}
