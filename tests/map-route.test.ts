import { afterEach, describe, expect, it, vi } from "vitest"

const mocks = vi.hoisted(() => ({
  getServerFirebase: vi.fn(() => ({ db: { synthetic: true } })),
  requireOverlayTenant: vi.fn(),
  readMapProjection: vi.fn(),
}))

vi.mock("@/lib/firebase/admin", () => ({
  getServerFirebase: mocks.getServerFirebase,
}))
vi.mock("@/lib/overlay/access-server", () => ({
  requireOverlayTenant: mocks.requireOverlayTenant,
}))
vi.mock("@/lib/map/store", () => ({
  readMapProjection: mocks.readMapProjection,
}))

import { GET } from "@/app/api/map/route"

afterEach(() => vi.clearAllMocks())

describe("scoped map route", () => {
  it("returns only the tenant's allowlisted map projection", async () => {
    mocks.requireOverlayTenant.mockResolvedValue("42")
    mocks.readMapProjection.mockResolvedValue({
      state: "heading",
      updatedAt: 1,
      positionStatus: "coarse",
    })
    const response = await GET(
      new Request("http://localhost/api/map", {
        headers: {
          authorization: "Bearer overlay-secret",
          "x-overlay-id": "overlay-id",
        },
      })
    )
    expect(response.status).toBe(200)
    await expect(response.json()).resolves.toEqual({
      state: "heading",
      updatedAt: 1,
      positionStatus: "coarse",
    })
    expect(mocks.readMapProjection).toHaveBeenCalledWith(
      { synthetic: true },
      "42"
    )
    expect(response.headers.get("cache-control")).toBe("no-store")
  })

  it("authenticates before Firebase or map reads", async () => {
    const { OverlayAccessError } = await import("@/shared/overlay-access")
    mocks.requireOverlayTenant.mockRejectedValue(
      new OverlayAccessError("unauthorized", 401)
    )
    const response = await GET(new Request("http://localhost/api/map"))
    expect(response.status).toBe(401)
    expect(mocks.getServerFirebase).not.toHaveBeenCalled()
    expect(mocks.readMapProjection).not.toHaveBeenCalled()
  })
})
