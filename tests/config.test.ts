import { describe, expect, it, vi } from "vitest"
import { readServerConfig } from "@/shared/config"
import { createDemoOwnerToken } from "@/shared/auth/demo-owner"
import { demoEnv } from "./fixtures"

describe("Firebase configuration isolation", () => {
  it("accepts a fully local demo configuration", () => {
    expect(readServerConfig(demoEnv).mode).toBe("emulator")
  })

  it.each([
    { NODE_ENV: "production" },
    {
      NEXT_PUBLIC_FIREBASE_PROJECT_ID: "real-project",
      FIREBASE_PROJECT_ID: "real-project",
    },
    { FIREBASE_PROJECT_ID: "different-project" },
    { FIRESTORE_EMULATOR_HOST: "" },
    { FIREBASE_AUTH_EMULATOR_HOST: "127.0.0.1:9199" },
    { NEXT_PUBLIC_FIRESTORE_EMULATOR_HOST: "remote.example:8080" },
    { NEXT_PUBLIC_FIRESTORE_EMULATOR_HOST: "http://localhost:8080" },
  ])("fails closed with invalid or mixed configuration %j", (changes) => {
    expect(() => readServerConfig({ ...demoEnv, ...changes })).toThrow()
  })

  it("rejects emulator environment leakage into live mode", () => {
    expect(() =>
      readServerConfig({
        ...demoEnv,
        NEXT_PUBLIC_APP_MODE: "live",
        NEXT_PUBLIC_FIREBASE_PROJECT_ID: "real-project",
        FIREBASE_PROJECT_ID: "real-project",
      })
    ).toThrow()
  })

  it("allows live configuration only without emulator hosts", () => {
    expect(
      readServerConfig({
        ...demoEnv,
        NODE_ENV: "production",
        NEXT_PUBLIC_APP_MODE: "live",
        NEXT_PUBLIC_FIREBASE_PROJECT_ID: "real-project",
        FIREBASE_PROJECT_ID: "real-project",
        NEXT_PUBLIC_FIREBASE_AUTH_EMULATOR_HOST: undefined,
        NEXT_PUBLIC_FIRESTORE_EMULATOR_HOST: undefined,
        FIREBASE_AUTH_EMULATOR_HOST: undefined,
        FIRESTORE_EMULATOR_HOST: undefined,
      }).mode
    ).toBe("live")
  })
})

describe("demo owner login", () => {
  it("mints only the fixed demo identity", async () => {
    const mint = vi.fn().mockResolvedValue("custom-token")
    await expect(createDemoOwnerToken(demoEnv, mint)).resolves.toBe(
      "custom-token"
    )
    expect(mint).toHaveBeenCalledWith("demo-owner", {
      owner: true,
      demo: true,
    })
  })

  it("mints the isolated demo identity in live mode only when opted in", async () => {
    const mint = vi.fn().mockResolvedValue("deployed-demo-token")
    await expect(
      createDemoOwnerToken(
        {
          ...demoEnv,
          NODE_ENV: "production",
          NEXT_PUBLIC_APP_MODE: "live",
          NEXT_PUBLIC_FIREBASE_PROJECT_ID: "real-project",
          FIREBASE_PROJECT_ID: "real-project",
          NEXT_PUBLIC_FIREBASE_AUTH_EMULATOR_HOST: undefined,
          NEXT_PUBLIC_FIRESTORE_EMULATOR_HOST: undefined,
          FIREBASE_AUTH_EMULATOR_HOST: undefined,
          FIRESTORE_EMULATOR_HOST: undefined,
          DEMO_MODE_ENABLED: "true",
        },
        mint
      )
    ).resolves.toBe("deployed-demo-token")
    expect(mint).toHaveBeenCalledWith("demo-owner", {
      owner: true,
      demo: true,
    })
  })

  it.each([
    { NODE_ENV: "production" },
    { NEXT_PUBLIC_APP_MODE: "live" },
    { FIREBASE_AUTH_EMULATOR_HOST: "" },
  ])("never mints when demo isolation is invalid %j", async (changes) => {
    const mint = vi.fn()
    await expect(
      createDemoOwnerToken({ ...demoEnv, ...changes }, mint)
    ).rejects.toThrow()
    expect(mint).not.toHaveBeenCalled()
  })
})
