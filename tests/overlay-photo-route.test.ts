import { afterEach, describe, expect, it, vi } from "vitest"

const mocks = vi.hoisted(() => ({
  requireOverlayTenant: vi.fn(),
  getServerFirebase: vi.fn(() => ({ db: { synthetic: true } })),
  readRevealedPlaceId: vi.fn(),
  getGooglePlacePhoto: vi.fn(),
}))

vi.mock("@/lib/overlay/access-server", () => ({
  requireOverlayTenant: mocks.requireOverlayTenant,
}))
vi.mock("@/lib/firebase/admin", () => ({
  getServerFirebase: mocks.getServerFirebase,
}))
vi.mock("@/lib/overlay/store", () => ({
  createOverlayStore: () => ({
    readRevealedPlaceId: mocks.readRevealedPlaceId,
  }),
}))
vi.mock("@/shared/providers/google-maps", () => ({
  readGoogleMapsConfig: () => ({ apiKey: "server-only" }),
  getGooglePlacePhoto: mocks.getGooglePlacePhoto,
}))

import { GET } from "@/app/api/overlay/photo/route"

afterEach(() => {
  vi.clearAllMocks()
})

describe("overlay place photo route", () => {
  it("resolves the current revealed destination photo for its tenant", async () => {
    mocks.requireOverlayTenant.mockResolvedValue("42")
    mocks.readRevealedPlaceId.mockResolvedValue("place-1")
    mocks.getGooglePlacePhoto.mockResolvedValue({
      photoUri: "https://lh3.googleusercontent.com/photo",
      googleMapsUri: "https://maps.google.com/?cid=photo",
      authorAttributions: [
        {
          displayName: "Demo Photographer",
          uri: "https://maps.google.com/profile/demo",
        },
      ],
    })
    const response = await GET(
      new Request("http://localhost/api/overlay/photo", {
        headers: {
          authorization: "Bearer overlay-secret",
          "x-overlay-id": "overlay-id",
        },
      })
    )
    expect(response.status).toBe(200)
    await expect(response.json()).resolves.toEqual({
      photoUri: "https://lh3.googleusercontent.com/photo",
      googleMapsUri: "https://maps.google.com/?cid=photo",
      authorAttributions: [
        {
          displayName: "Demo Photographer",
          uri: "https://maps.google.com/profile/demo",
        },
      ],
    })
    expect(mocks.getGooglePlacePhoto).toHaveBeenCalledWith(
      { apiKey: "server-only" },
      "place-1"
    )
  })
})
