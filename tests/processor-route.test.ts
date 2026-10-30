import { afterEach, describe, expect, it, vi } from "vitest"
import { liveEnv } from "./auth-fixtures"
import { demoEnv } from "./fixtures"

const mocks = vi.hoisted(() => ({
  verify: vi.fn(),
  run: vi.fn(),
}))

vi.mock("@/lib/internal/google-oidc", () => ({
  verifyGoogleIdToken: mocks.verify,
}))
vi.mock("@/lib/pitches/runner", () => ({
  runClaimablePitches: mocks.run,
}))

import { POST } from "@/app/api/internal/process/route"

const email = "irl-processor@test-live-project.iam.gserviceaccount.com"
const audience = "https://producer.example/api/internal/process"

function setEnv(values: Record<string, string | undefined>) {
  for (const [key, value] of Object.entries(values)) vi.stubEnv(key, value)
}

afterEach(() => {
  vi.unstubAllEnvs()
  vi.clearAllMocks()
})

describe("scheduled processor route", () => {
  it("authenticates before running a bounded processor batch", async () => {
    setEnv({
      ...liveEnv,
      PROCESSOR_AUDIENCE: audience,
      PROCESSOR_SERVICE_ACCOUNT_EMAIL: email,
    })
    mocks.verify.mockResolvedValue({ email, email_verified: true })
    mocks.run.mockResolvedValue({
      scanned: 2,
      readyForReview: 1,
      rejected: 1,
      retrying: 0,
      skipped: 0,
    })
    const response = await POST(
      new Request(audience, {
        method: "POST",
        headers: { authorization: "Bearer signed.token.value" },
      })
    )
    expect(response.status).toBe(200)
    await expect(response.json()).resolves.toMatchObject({ scanned: 2 })
    expect(mocks.run).toHaveBeenCalledWith(5)
  })

  it("rejects the wrong identity before loading processor work", async () => {
    setEnv({
      ...liveEnv,
      PROCESSOR_AUDIENCE: audience,
      PROCESSOR_SERVICE_ACCOUNT_EMAIL: email,
    })
    mocks.verify.mockResolvedValue({
      email: "other@test-live-project.iam.gserviceaccount.com",
      email_verified: true,
    })
    const response = await POST(
      new Request(audience, {
        method: "POST",
        headers: { authorization: "Bearer signed.token.value" },
      })
    )
    expect(response.status).toBe(401)
    expect(mocks.run).not.toHaveBeenCalled()
  })

  it("is unavailable in emulator mode and returns retryable infrastructure errors", async () => {
    setEnv(demoEnv)
    expect(
      await POST(
        new Request("http://localhost:3000/api/internal/process", {
          method: "POST",
        })
      )
    ).toMatchObject({ status: 404 })
    expect(mocks.verify).not.toHaveBeenCalled()

    vi.unstubAllEnvs()
    setEnv({
      ...liveEnv,
      PROCESSOR_AUDIENCE: audience,
      PROCESSOR_SERVICE_ACCOUNT_EMAIL: email,
    })
    mocks.verify.mockResolvedValue({ email, email_verified: true })
    mocks.run.mockRejectedValue(new Error("synthetic Firestore outage"))
    const response = await POST(
      new Request(audience, {
        method: "POST",
        headers: { authorization: "Bearer signed.token.value" },
      })
    )
    expect(response.status).toBe(503)
    await expect(response.json()).resolves.toEqual({
      error: "temporarily_unavailable",
    })
  })
})
