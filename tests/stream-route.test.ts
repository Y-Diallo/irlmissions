import { afterEach, describe, expect, it, vi } from "vitest"
import { AuthError } from "@/shared/auth/twitch"

const mocks = vi.hoisted(() => ({
  requireOwner: vi.fn(),
  endLiveStream: vi.fn(),
}))

vi.mock("@/lib/auth/server", () => ({
  requireServerOwner: mocks.requireOwner,
}))
vi.mock("@/lib/stream/end", () => ({
  endLiveStream: mocks.endLiveStream,
}))

import { POST } from "@/app/api/stream/end/route"

const url = "http://localhost:3000/api/stream/end"

afterEach(() => vi.clearAllMocks())

describe("end stream route", () => {
  it("ends only the authenticated tenant's stream", async () => {
    mocks.requireOwner.mockResolvedValue({ tenantId: "42" })
    mocks.endLiveStream.mockResolvedValue({
      rewardEnabled: false,
      pollCanceled: true,
      missionCanceled: false,
      refunds: { queued: 2, skipped: 1 },
    })
    const response = await POST(
      new Request(url, {
        method: "POST",
        headers: {
          authorization: "Bearer owner",
          "content-type": "application/json",
        },
        body: JSON.stringify({ action: "end_stream" }),
      })
    )
    expect(response.status).toBe(200)
    expect(mocks.endLiveStream).toHaveBeenCalledWith("42")
  })

  it("rejects malformed and unauthorized requests", async () => {
    mocks.requireOwner.mockResolvedValue({ tenantId: "42" })
    const malformed = await POST(
      new Request(url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ action: "reset" }),
      })
    )
    expect(malformed.status).toBe(400)
    expect(mocks.endLiveStream).not.toHaveBeenCalled()

    mocks.requireOwner.mockRejectedValue(new AuthError("unauthorized", 401))
    const unauthorized = await POST(
      new Request(url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ action: "end_stream" }),
      })
    )
    expect(unauthorized.status).toBe(401)
  })
})
