import { afterEach, describe, expect, it, vi } from "vitest"

vi.mock("@/lib/firebase/admin", () => ({
  getServerFirebase: vi.fn(() => {
    throw new Error("SDK should not initialize for rejected requests")
  }),
}))

import { POST } from "@/app/api/auth/demo/route"
import { getServerFirebase } from "@/lib/firebase/admin"

afterEach(() => {
  vi.unstubAllEnvs()
  vi.clearAllMocks()
})

describe("demo route boundary", () => {
  it("rejects cross-origin requests before accessing Firebase", async () => {
    const response = await POST(
      new Request("http://localhost:3000/api/auth/demo", {
        method: "POST",
        headers: { origin: "https://elsewhere.example" },
      })
    )
    expect(response.status).toBe(403)
    expect(getServerFirebase).not.toHaveBeenCalled()
  })

  it("hides the demo route in production before accessing Firebase", async () => {
    vi.stubEnv("NODE_ENV", "production")
    vi.stubEnv("NEXT_PUBLIC_APP_MODE", "emulator")
    const response = await POST(
      new Request("http://localhost:3000/api/auth/demo", {
        method: "POST",
        headers: { origin: "http://localhost:3000" },
      })
    )
    expect(response.status).toBe(404)
    expect(getServerFirebase).not.toHaveBeenCalled()
  })

  it("uses the incoming host when Next supplies an internal request URL", async () => {
    vi.stubEnv("NODE_ENV", "production")
    vi.stubEnv("NEXT_PUBLIC_APP_MODE", "emulator")
    const response = await POST(
      new Request("http://0.0.0.0:8080/api/auth/demo", {
        method: "POST",
        headers: {
          origin: "https://producer.example",
          "x-forwarded-host": "producer.example",
          "x-forwarded-proto": "https",
        },
      })
    )
    expect(response.status).toBe(404)
    expect(getServerFirebase).not.toHaveBeenCalled()
  })
})
