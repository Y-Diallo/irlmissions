import { afterEach, describe, expect, it, vi } from "vitest"
import { demoEnv } from "./fixtures"

const mocks = vi.hoisted(() => ({
  getServerFirebase: vi.fn(() => ({ db: { synthetic: true } })),
  read: vi.fn(),
}))

vi.mock("@/lib/firebase/admin", () => ({
  getServerFirebase: mocks.getServerFirebase,
}))
vi.mock("@/lib/overlay/store", () => ({
  createOverlayStore: () => ({ read: mocks.read }),
}))

import { GET } from "@/app/api/overlay/route"

const key = "overlay_test_key_1234567890_abcdef"
const url = "http://localhost:3000/api/overlay"

function setEnv() {
  for (const [name, value] of Object.entries({
    ...demoEnv,
    OVERLAY_ACCESS_KEY: key,
  })) {
    vi.stubEnv(name, value)
  }
}

afterEach(() => {
  vi.unstubAllEnvs()
  vi.clearAllMocks()
})

describe("overlay read route", () => {
  it("returns only the projection for the scoped OBS key", async () => {
    setEnv()
    mocks.read.mockResolvedValue({
      state: "heading",
      updatedAt: 1,
      objective: "Go",
    })
    const response = await GET(
      new Request(url, { headers: { authorization: `Bearer ${key}` } })
    )
    expect(response.status).toBe(200)
    await expect(response.json()).resolves.toEqual({
      overlay: { state: "heading", updatedAt: 1, objective: "Go" },
    })
    expect(response.headers.get("cache-control")).toBe("no-store")
  })

  it("rejects a missing or wrong key before Firebase initialization", async () => {
    setEnv()
    for (const authorization of [
      null,
      "Bearer wrong_key_1234567890123456789012",
    ]) {
      const response = await GET(
        new Request(url, {
          headers: authorization ? { authorization } : {},
        })
      )
      expect(response.status).toBe(401)
    }
    expect(mocks.getServerFirebase).not.toHaveBeenCalled()
    expect(mocks.read).not.toHaveBeenCalled()
  })

  it("fails before Firebase when the overlay key is not configured", async () => {
    for (const [name, value] of Object.entries(demoEnv)) vi.stubEnv(name, value)
    const response = await GET(new Request(url))
    expect(response.status).toBe(503)
    expect(mocks.getServerFirebase).not.toHaveBeenCalled()
  })
})
