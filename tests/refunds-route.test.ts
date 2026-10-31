import { afterEach, describe, expect, it, vi } from "vitest"
import { AuthError } from "@/shared/auth/twitch"

const mocks = vi.hoisted(() => ({
  requireOwner: vi.fn(),
  getServerFirebase: vi.fn(() => ({ db: {} })),
  list: vi.fn(),
  queueUnused: vi.fn(),
}))

vi.mock("@/lib/auth/server", () => ({
  requireServerOwner: mocks.requireOwner,
}))
vi.mock("@/lib/firebase/admin", () => ({
  getServerFirebase: mocks.getServerFirebase,
}))
vi.mock("@/lib/refunds/store", () => ({
  createRefundStore: () => ({
    list: mocks.list,
    queueUnused: mocks.queueUnused,
  }),
}))

import { GET, POST } from "@/app/api/refunds/route"

const url = "http://localhost:3000/api/refunds"

afterEach(() => vi.clearAllMocks())

describe("owner refund routes", () => {
  it("lists the refund projection only after owner verification", async () => {
    mocks.requireOwner.mockResolvedValue({ uid: "twitch:42", tenantId: "42" })
    mocks.list.mockResolvedValue([
      { redemptionId: "redemption-1", state: "eligible" },
    ])
    const response = await GET(
      new Request(url, {
        headers: { authorization: "Bearer owner-token" },
      })
    )
    expect(response.status).toBe(200)
    await expect(response.json()).resolves.toEqual({
      refunds: [{ redemptionId: "redemption-1", state: "eligible" }],
    })
    expect(mocks.requireOwner).toHaveBeenCalledBefore(mocks.list)
  })

  it("queues unused pitches with a server timestamp", async () => {
    mocks.requireOwner.mockResolvedValue({ uid: "twitch:42", tenantId: "42" })
    mocks.queueUnused.mockResolvedValue({ queued: 3, skipped: 2 })
    const response = await POST(
      new Request(url, {
        method: "POST",
        headers: {
          authorization: "Bearer owner-token",
          "content-type": "application/json",
        },
        body: JSON.stringify({ action: "queue_unused" }),
      })
    )
    expect(response.status).toBe(200)
    expect(mocks.queueUnused).toHaveBeenCalledWith(expect.any(Number))
    await expect(response.json()).resolves.toEqual({ queued: 3, skipped: 2 })
  })

  it("rejects malformed commands without queueing refunds", async () => {
    mocks.requireOwner.mockResolvedValue({ uid: "twitch:42", tenantId: "42" })
    const response = await POST(
      new Request(url, {
        method: "POST",
        headers: {
          authorization: "Bearer owner-token",
          "content-type": "application/json",
        },
        body: JSON.stringify({ action: "refund_everything" }),
      })
    )
    expect(response.status).toBe(400)
    expect(mocks.queueUnused).not.toHaveBeenCalled()
  })

  it("never reads or queues for an unauthorized caller", async () => {
    mocks.requireOwner.mockRejectedValue(new AuthError("unauthorized", 401))
    expect((await GET(new Request(url))).status).toBe(401)
    expect(
      (
        await POST(
          new Request(url, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ action: "queue_unused" }),
          })
        )
      ).status
    ).toBe(401)
    expect(mocks.getServerFirebase).not.toHaveBeenCalled()
    expect(mocks.list).not.toHaveBeenCalled()
    expect(mocks.queueUnused).not.toHaveBeenCalled()
  })
})
