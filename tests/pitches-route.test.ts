import { afterEach, describe, expect, it, vi } from "vitest"
import { AuthError } from "@/shared/auth/twitch"

const mocks = vi.hoisted(() => ({
  requireOwner: vi.fn(),
  list: vi.fn(),
  update: vi.fn(),
  runPitchNow: vi.fn(),
}))

vi.mock("@/lib/auth/server", () => ({
  requireServerOwner: mocks.requireOwner,
}))
vi.mock("@/lib/firebase/admin", () => ({
  getServerFirebase: () => ({ db: {} }),
}))
vi.mock("@/lib/pitches/review-store", () => ({
  createPitchReviewStore: () => ({
    list: mocks.list,
    update: mocks.update,
  }),
}))
vi.mock("@/lib/pitches/runner", () => ({
  runPitchNow: mocks.runPitchNow,
}))

import { GET } from "@/app/api/pitches/route"
import { PATCH } from "@/app/api/pitches/[redemptionId]/route"
import { POST } from "@/app/api/pitches/[redemptionId]/process/route"

afterEach(() => vi.clearAllMocks())

const base = "http://localhost:3000/api/pitches"
const context = { params: Promise.resolve({ redemptionId: "redemption-1" }) }

describe("owner pitch routes", () => {
  it("lists private review data only after owner verification", async () => {
    mocks.requireOwner.mockResolvedValue({ uid: "demo-owner", tenantId: "demo-owner" })
    mocks.list.mockResolvedValue([{ redemptionId: "redemption-1" }])

    const response = await GET(
      new Request(base, { headers: { authorization: "Bearer owner-token" } })
    )

    expect(response.status).toBe(200)
    await expect(response.json()).resolves.toEqual({
      pitches: [{ redemptionId: "redemption-1" }],
    })
    expect(mocks.requireOwner).toHaveBeenCalledWith("Bearer owner-token")
    expect(mocks.list).toHaveBeenCalledOnce()
  })

  it("does not read the queue when owner authentication fails", async () => {
    mocks.requireOwner.mockRejectedValue(new AuthError("unauthorized", 401))

    const response = await GET(new Request(base))

    expect(response.status).toBe(401)
    expect(mocks.list).not.toHaveBeenCalled()
  })

  it("validates and applies an explicit approval command", async () => {
    mocks.requireOwner.mockResolvedValue({ uid: "demo-owner", tenantId: "demo-owner" })
    mocks.update.mockResolvedValue({ updated: true })

    const response = await PATCH(
      new Request(`${base}/redemption-1`, {
        method: "PATCH",
        headers: {
          authorization: "Bearer owner-token",
          "content-type": "application/json",
        },
        body: JSON.stringify({ action: "approve" }),
      }),
      context
    )

    expect(response.status).toBe(200)
    expect(mocks.update).toHaveBeenCalledWith(
      "redemption-1",
      { action: "approve" },
      expect.any(Number)
    )
  })

  it("returns 400 for malformed commands before touching storage", async () => {
    mocks.requireOwner.mockResolvedValue({ uid: "demo-owner", tenantId: "demo-owner" })

    const response = await PATCH(
      new Request(`${base}/redemption-1`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          action: "edit_details",
          publicLabel: "Mystery challenge",
          durationMinutes: 0,
        }),
      }),
      context
    )

    expect(response.status).toBe(400)
    await expect(response.json()).resolves.toEqual({
      error: "invalid_duration",
    })
    expect(mocks.update).not.toHaveBeenCalled()
  })

  it("runs one requested pitch only after owner verification", async () => {
    mocks.requireOwner.mockResolvedValue({ uid: "demo-owner", tenantId: "demo-owner" })
    mocks.runPitchNow.mockResolvedValue({ outcome: "ready_for_review" })

    const response = await POST(
      new Request(`${base}/redemption-1/process`, {
        method: "POST",
        headers: { authorization: "Bearer owner-token" },
      }),
      context
    )

    expect(response.status).toBe(200)
    expect(mocks.runPitchNow).toHaveBeenCalledWith(
      "demo-owner",
      "redemption-1"
    )
  })
})
