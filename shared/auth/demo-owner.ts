import { readServerConfig, type Environment } from "../config"

export const DEMO_OWNER_UID = "demo-owner"

export class DemoDisabledError extends Error {}

export async function createDemoOwnerToken(
  env: Environment,
  mintToken: (uid: string, claims: { owner: boolean }) => Promise<string>
) {
  // Guard before invoking any SDK or reading credentials.
  if (
    env.NODE_ENV === "production" ||
    env.NEXT_PUBLIC_APP_MODE !== "emulator"
  ) {
    throw new DemoDisabledError("Demo login is only available on emulators")
  }
  readServerConfig(env)
  return mintToken(DEMO_OWNER_UID, { owner: true })
}
