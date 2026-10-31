import { afterEach, describe, expect, it, vi } from "vitest"
import { AuthError } from "@/shared/auth/twitch"

const mocks = vi.hoisted(() => ({
  requireOwner: vi.fn(),
  read: vi.fn(),
  act: vi.fn(),
}))

vi.mock("@/lib/auth/server", () => ({
  requireServerOwner: mocks.requireOwner,
}))
vi.mock("@/lib/firebase/admin", () => ({
  getServerFirebase: () => ({ db: {} }),
}))
vi.mock("@/lib/missions/store", () => ({
  createMissionStore: () => ({ read: mocks.read, act: mocks.act }),
}))

import { GET, PATCH } from "@/app/api/missions/route"

const url = "http://localhost:3000/api/missions"

afterEach(() => vi.clearAllMocks())

describe("owner mission routes", () => {
  it("returns the private mission only after owner verification", async () => {
    mocks.requireOwner.mockResolvedValue({ uid: "twitch:42" })
    mocks.read.mockResolvedValue({ status: "heading", destination: {} })
    const response = await GET(
      new Request(url, { headers: { authorization: "Bearer owner" } })
    )
    expect(response.status).toBe(200)
    await expect(response.json()).resolves.toMatchObject({
      mission: { status: "heading" },
    })
    expect(mocks.requireOwner).toHaveBeenCalledBefore(mocks.read)
  })

  it.each(["arrive", "complete", "fail"])(
    "applies the %s command with a server timestamp",
    async (action) => {
      mocks.requireOwner.mockResolvedValue({ uid: "twitch:42" })
      mocks.act.mockResolvedValue({ status: action })
      const response = await PATCH(
        new Request(url, {
          method: "PATCH",
          headers: {
            authorization: "Bearer owner",
            "content-type": "application/json",
          },
          body: JSON.stringify({ action }),
        })
      )
      expect(response.status).toBe(200)
      expect(mocks.act).toHaveBeenCalledWith(action, expect.any(Number))
    }
  )

  it("rejects malformed actions before storage", async () => {
    mocks.requireOwner.mockResolvedValue({ uid: "twitch:42" })
    const response = await PATCH(
      new Request(url, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ action: "skip" }),
      })
    )
    expect(response.status).toBe(400)
    expect(mocks.act).not.toHaveBeenCalled()
  })

  it("never reads or mutates missions for another user", async () => {
    mocks.requireOwner.mockRejectedValue(new AuthError("unauthorized", 401))
    const response = await GET(new Request(url))
    expect(response.status).toBe(401)
    expect(mocks.read).not.toHaveBeenCalled()
    expect(mocks.act).not.toHaveBeenCalled()
  })
})
