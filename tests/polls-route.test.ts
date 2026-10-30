import { afterEach, describe, expect, it, vi } from "vitest"
import { AuthError } from "@/shared/auth/twitch"

const mocks = vi.hoisted(() => ({
  requireOwner: vi.fn(),
  read: vi.fn(),
  start: vi.fn(),
  reconcile: vi.fn(),
}))

vi.mock("@/lib/auth/server", () => ({
  requireServerOwner: mocks.requireOwner,
}))
vi.mock("@/lib/firebase/admin", () => ({
  getServerFirebase: () => ({ db: {} }),
}))
vi.mock("@/lib/polls/store", () => ({
  createPollStore: () => ({ read: mocks.read }),
}))
vi.mock("@/lib/polls/service", () => ({
  startLivePoll: mocks.start,
  reconcileLivePoll: mocks.reconcile,
}))

import { GET, POST } from "@/app/api/polls/route"
import { POST as RECONCILE } from "@/app/api/polls/reconcile/route"

const url = "http://localhost:3000/api/polls"

afterEach(() => vi.clearAllMocks())

describe("owner poll routes", () => {
  it("returns current poll state only after owner verification", async () => {
    mocks.requireOwner.mockResolvedValue({ uid: "demo-owner" })
    mocks.read.mockResolvedValue({ status: "active", twitchPollId: "poll-1" })
    const response = await GET(
      new Request(url, { headers: { authorization: "Bearer owner" } })
    )
    expect(response.status).toBe(200)
    await expect(response.json()).resolves.toMatchObject({
      poll: { status: "active", twitchPollId: "poll-1" },
    })
    expect(mocks.requireOwner).toHaveBeenCalledBefore(mocks.read)
  })

  it("validates shortlist input before starting a live poll", async () => {
    mocks.requireOwner.mockResolvedValue({ uid: "twitch:42" })
    const response = await POST(
      new Request(url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ redemptionIds: ["only-one"] }),
      })
    )
    expect(response.status).toBe(400)
    expect(mocks.start).not.toHaveBeenCalled()
  })

  it("starts a validated 2–5 choice poll", async () => {
    mocks.requireOwner.mockResolvedValue({ uid: "twitch:42" })
    mocks.start.mockResolvedValue({ status: "active", twitchPollId: "poll-1" })
    const response = await POST(
      new Request(url, {
        method: "POST",
        headers: {
          authorization: "Bearer owner",
          "content-type": "application/json",
        },
        body: JSON.stringify({
          redemptionIds: ["redemption-1", "redemption-2"],
          durationSeconds: 60,
        }),
      })
    )
    expect(response.status).toBe(200)
    expect(mocks.start).toHaveBeenCalledWith({
      redemptionIds: ["redemption-1", "redemption-2"],
      durationSeconds: 60,
    })
  })

  it("reconciles uncertain creation without accepting a request body", async () => {
    mocks.requireOwner.mockResolvedValue({ uid: "twitch:42" })
    mocks.reconcile.mockResolvedValue({ reconciled: false, poll: null })
    const response = await RECONCILE(
      new Request(`${url}/reconcile`, {
        method: "POST",
        headers: { authorization: "Bearer owner" },
      })
    )
    expect(response.status).toBe(200)
    expect(mocks.reconcile).toHaveBeenCalledOnce()
  })

  it("never reads or creates polls for an unauthorized caller", async () => {
    mocks.requireOwner.mockRejectedValue(new AuthError("unauthorized", 401))
    const response = await GET(new Request(url))
    expect(response.status).toBe(401)
    expect(mocks.read).not.toHaveBeenCalled()
    expect(mocks.start).not.toHaveBeenCalled()
  })
})
