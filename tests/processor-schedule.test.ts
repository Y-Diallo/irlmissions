import { afterEach, describe, expect, it, vi } from "vitest"
import {
  authenticateScheduledProcessor,
  readProcessorScheduleConfig,
} from "@/shared/processor-schedule"
import { liveEnv } from "./auth-fixtures"

const config = {
  audience: "https://producer.example/api/internal/process",
  serviceAccountEmail: "irl-processor@test.iam.gserviceaccount.com",
}

afterEach(() => vi.restoreAllMocks())

describe("scheduled processor authentication", () => {
  it("requires a verified token for the exact audience and service account", async () => {
    const verify = vi.fn(async (_token: string, audience: string) => ({
      email: config.serviceAccountEmail,
      email_verified: true,
      sub: "123",
      audience,
    }))
    await expect(
      authenticateScheduledProcessor(
        "Bearer signed.token.value",
        config,
        verify
      )
    ).resolves.toEqual({ serviceAccountEmail: config.serviceAccountEmail })
    expect(verify).toHaveBeenCalledWith(
      "signed.token.value",
      "https://producer.example/api/internal/process"
    )
  })

  it.each([
    [null, { email: config.serviceAccountEmail, email_verified: true }],
    [
      "Basic token",
      { email: config.serviceAccountEmail, email_verified: true },
    ],
    [
      "Bearer token",
      { email: "other@test.iam.gserviceaccount.com", email_verified: true },
    ],
    [
      "Bearer token",
      { email: config.serviceAccountEmail, email_verified: false },
    ],
  ])(
    "rejects missing or wrong scheduler identity",
    async (authorization, payload) => {
      const verify = vi.fn(async () => payload)
      await expect(
        authenticateScheduledProcessor(authorization, config, verify)
      ).rejects.toMatchObject({ code: "unauthorized", status: 401 })
    }
  )

  it("validates the exact HTTPS processor audience", () => {
    expect(
      readProcessorScheduleConfig({
        ...liveEnv,
        PROCESSOR_AUDIENCE: config.audience,
        PROCESSOR_SERVICE_ACCOUNT_EMAIL: config.serviceAccountEmail,
      })
    ).toEqual(config)
    expect(() =>
      readProcessorScheduleConfig({
        ...liveEnv,
        PROCESSOR_AUDIENCE:
          "https://producer.example/api/internal/process?key=x",
        PROCESSOR_SERVICE_ACCOUNT_EMAIL: config.serviceAccountEmail,
      })
    ).toThrow("PROCESSOR_AUDIENCE")
  })
})
