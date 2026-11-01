import { afterEach, describe, expect, it, vi } from "vitest"
import { AuthError } from "@/shared/auth/twitch"

const mocks = vi.hoisted(() => ({
  requireOwner: vi.fn(),
  getServerFirebase: vi.fn(() => ({ db: { synthetic: true } })),
  history: vi.fn(),
}))

vi.mock("@/lib/auth/server", () => ({
  requireServerOwner: mocks.requireOwner,
}))
vi.mock("@/lib/firebase/admin", () => ({
  getServerFirebase: mocks.getServerFirebase,
}))
vi.mock("@/lib/pitches/review-store", () => ({
  createPitchReviewStore: () => ({ history: mocks.history }),
}))

import { GET } from "@/app/api/history/route"

afterEach(() => vi.clearAllMocks())

describe("pitch history route", () => {
  it("returns removed pitches only for the authenticated tenant", async () => {
    mocks.requireOwner.mockResolvedValue({ tenantId: "42" })
    mocks.history.mockResolvedValue([
      { redemptionId: "removed-1", previousStatus: "approved" },
    ])
    const response = await GET(
      new Request("http://localhost/api/history", {
        headers: { authorization: "Bearer owner" },
      })
    )
    expect(response.status).toBe(200)
    await expect(response.json()).resolves.toEqual({
      history: [{ redemptionId: "removed-1", previousStatus: "approved" }],
    })
    expect(mocks.requireOwner).toHaveBeenCalledBefore(mocks.history)
  })

  it("does not initialize storage for an unauthorized caller", async () => {
    mocks.requireOwner.mockRejectedValue(new AuthError("unauthorized", 401))
    const response = await GET(new Request("http://localhost/api/history"))
    expect(response.status).toBe(401)
    expect(mocks.getServerFirebase).not.toHaveBeenCalled()
    expect(mocks.history).not.toHaveBeenCalled()
  })
})
