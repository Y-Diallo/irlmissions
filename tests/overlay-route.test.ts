import { afterEach, describe, expect, it, vi } from "vitest"
const mocks = vi.hoisted(() => ({
  getServerFirebase: vi.fn(() => ({ db: { synthetic: true } })),
  requireOverlayTenant: vi.fn(),
  read: vi.fn(),
  readConsequences: vi.fn(),
}))

vi.mock("@/lib/firebase/admin", () => ({
  getServerFirebase: mocks.getServerFirebase,
}))
vi.mock("@/lib/overlay/store", () => ({
  createOverlayStore: () => ({
    read: mocks.read,
    readConsequences: mocks.readConsequences,
  }),
}))
vi.mock("@/lib/overlay/access-server", () => ({
  requireOverlayTenant: mocks.requireOverlayTenant,
}))

import { GET } from "@/app/api/overlay/route"

const key = "overlay_test_key_1234567890_abcdef"
const url = "http://localhost:3000/api/overlay"

afterEach(() => {
  vi.unstubAllEnvs()
  vi.clearAllMocks()
})

describe("overlay read route", () => {
  it("returns only the projection for the scoped OBS key", async () => {
    mocks.requireOverlayTenant.mockResolvedValue("42")
    mocks.read.mockResolvedValue({
      state: "heading",
      updatedAt: 1,
      objective: "Go",
      chosenBy: "Chat",
    })
    mocks.readConsequences.mockResolvedValue({
      items: [
        {
          key: "key-0001-abcd",
          text: "Eat a lemon",
          setBy: "V",
          clearRule: "manual",
        },
      ],
      rotateSeconds: 6,
    })
    const response = await GET(
      new Request(url, { headers: { authorization: `Bearer ${key}` } })
    )
    expect(response.status).toBe(200)
    await expect(response.json()).resolves.toEqual({
      overlay: {
        state: "heading",
        updatedAt: 1,
        objective: "Go",
        chosenBy: "Chat",
      },
      consequences: {
        items: [
          {
            key: "key-0001-abcd",
            text: "Eat a lemon",
            setBy: "V",
            clearRule: "manual",
          },
        ],
        rotateSeconds: 6,
      },
      serverNow: expect.any(Number),
    })
    expect(response.headers.get("cache-control")).toBe("no-store")
  })

  it("rejects a missing or wrong key before Firebase initialization", async () => {
    mocks.requireOverlayTenant.mockRejectedValue(
      new (await import("@/shared/overlay-access")).OverlayAccessError(
        "unauthorized",
        401
      )
    )
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
})
