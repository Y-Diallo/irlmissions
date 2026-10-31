import { afterEach, describe, expect, it, vi } from "vitest"
import { demoEnv } from "./fixtures"

const mocks = vi.hoisted(() => ({
  getServerFirebase: vi.fn(() => ({ db: { synthetic: true } })),
  record: vi.fn(),
}))

vi.mock("@/lib/firebase/admin", () => ({
  getServerFirebase: mocks.getServerFirebase,
}))
vi.mock("@/lib/realtimeirl/store", () => ({
  createRealtimeIrlStore: () => ({ record: mocks.record }),
}))

import { GET as getConfig } from "@/app/api/realtimeirl/config/route"
import { POST as postLocation } from "@/app/api/realtimeirl/location/route"

const key = "overlay_test_key_1234567890_abcdef"
const authorization = { authorization: `Bearer ${key}` }

function setEnv() {
  for (const [name, value] of Object.entries({
    ...demoEnv,
    OVERLAY_ACCESS_KEY: key,
    REALTIMEIRL_PULL_KEY: "rtirl-pull-key",
  })) {
    vi.stubEnv(name, value)
  }
}

afterEach(() => {
  vi.unstubAllEnvs()
  vi.clearAllMocks()
})

describe("RealtimeIRL scoped routes", () => {
  it("returns the pull key only to the keyed OBS source", async () => {
    setEnv()
    const response = await getConfig(
      new Request("http://localhost/api/realtimeirl/config", {
        headers: authorization,
      })
    )
    expect(response.status).toBe(200)
    await expect(response.json()).resolves.toEqual({
      pullKey: "rtirl-pull-key",
    })
    expect(response.headers.get("cache-control")).toBe("no-store")
  })

  it("rejects either scoped route before Firebase or secret access", async () => {
    setEnv()
    expect(
      (await getConfig(new Request("http://localhost/api/realtimeirl/config")))
        .status
    ).toBe(401)
    const response = await postLocation(
      new Request("http://localhost/api/realtimeirl/location", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "{}",
      })
    )
    expect(response.status).toBe(401)
    expect(mocks.getServerFirebase).not.toHaveBeenCalled()
    expect(mocks.record).not.toHaveBeenCalled()
  })

  it("validates location bodies before initializing Firebase", async () => {
    setEnv()
    const response = await postLocation(
      new Request("http://localhost/api/realtimeirl/location", {
        method: "POST",
        headers: { ...authorization, "content-type": "application/json" },
        body: JSON.stringify({ latitude: 999, longitude: 1, observedAt: 2 }),
      })
    )
    expect(response.status).toBe(400)
    expect(mocks.getServerFirebase).not.toHaveBeenCalled()
  })

  it("records a valid sample and returns only its policy status", async () => {
    setEnv()
    mocks.record.mockResolvedValue({
      status: "confirming",
      fresh: true,
      privacyBlocked: false,
      distanceToDestinationMeters: 12,
      nextConfirmation: {},
    })
    const sample = { latitude: 37.78, longitude: -122.41, observedAt: 123 }
    const response = await postLocation(
      new Request("http://localhost/api/realtimeirl/location", {
        method: "POST",
        headers: { ...authorization, "content-type": "application/json" },
        body: JSON.stringify(sample),
      })
    )
    expect(response.status).toBe(200)
    expect(mocks.record).toHaveBeenCalledWith(sample, expect.any(Number))
    await expect(response.json()).resolves.toEqual({
      status: "confirming",
      fresh: true,
      privacyBlocked: false,
    })
  })
})
