import { afterEach, describe, expect, it, vi } from "vitest"
import { AuthError } from "@/shared/auth/twitch"

const mocks = vi.hoisted(() => ({
  requireOwner: vi.fn(),
  read: vi.fn(),
  act: vi.fn(),
  list: vi.fn(),
  command: vi.fn(),
}))

vi.mock("@/lib/auth/server", () => ({
  requireServerOwner: mocks.requireOwner,
}))
vi.mock("@/lib/firebase/admin", () => ({
  getServerFirebase: () => ({ db: {} }),
}))
vi.mock("@/lib/missions/store", () => ({
  createMissionStore: () => ({
    read: mocks.read,
    act: mocks.act,
  }),
}))
vi.mock("@/lib/consequences/store", () => ({
  createConsequenceStore: () => ({
    list: mocks.list,
    command: mocks.command,
  }),
}))

import { GET, PATCH } from "@/app/api/missions/route"
import { PATCH as PATCH_CONSEQUENCE } from "@/app/api/consequences/route"

const url = "http://localhost:3000/api/missions"

afterEach(() => vi.clearAllMocks())

describe("owner mission routes", () => {
  it("returns the private mission only after owner verification", async () => {
    mocks.requireOwner.mockResolvedValue({ uid: "twitch:42", tenantId: "42" })
    mocks.read.mockResolvedValue({ status: "heading", destination: {} })
    mocks.list.mockResolvedValue([{ consequenceId: "mission:a" }])
    const response = await GET(
      new Request(url, { headers: { authorization: "Bearer owner" } })
    )
    expect(response.status).toBe(200)
    await expect(response.json()).resolves.toMatchObject({
      mission: { status: "heading" },
      consequences: [{ consequenceId: "mission:a" }],
    })
    expect(mocks.requireOwner).toHaveBeenCalledBefore(mocks.read)
  })

  it.each(["arrive", "complete", "fail", "deny", "extend", "cancel"])(
    "applies the %s command with a server timestamp",
    async (action) => {
      mocks.requireOwner.mockResolvedValue({ uid: "twitch:42", tenantId: "42" })
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
    mocks.requireOwner.mockResolvedValue({ uid: "twitch:42", tenantId: "42" })
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

  it("applies a validated consequence command with a server timestamp", async () => {
    mocks.requireOwner.mockResolvedValue({ uid: "twitch:42", tenantId: "42" })
    mocks.command.mockResolvedValue([])
    const request = (body: unknown) =>
      new Request("http://localhost:3000/api/consequences", {
        method: "PATCH",
        headers: {
          authorization: "Bearer owner",
          "content-type": "application/json",
        },
        body: JSON.stringify(body),
      })
    const response = await PATCH_CONSEQUENCE(
      request({
        consequenceId: "mission:a",
        action: "change",
        clearRule: "timed",
        durationMinutes: 5,
      })
    )
    expect(response.status).toBe(200)
    expect(mocks.command).toHaveBeenCalledWith(
      "mission:a",
      { action: "change", clearRule: "timed", durationMinutes: 5 },
      expect.any(Number)
    )
    const invalid = await PATCH_CONSEQUENCE(
      request({
        consequenceId: "mission:a",
        action: "change",
        clearRule: "timed",
      })
    )
    expect(invalid.status).toBe(400)
    expect(mocks.command).toHaveBeenCalledOnce()
  })

  it("never reads or mutates missions for another user", async () => {
    mocks.requireOwner.mockRejectedValue(new AuthError("unauthorized", 401))
    const response = await GET(new Request(url))
    expect(response.status).toBe(401)
    expect(mocks.read).not.toHaveBeenCalled()
    expect(mocks.act).not.toHaveBeenCalled()
    expect(mocks.list).not.toHaveBeenCalled()
  })
})
