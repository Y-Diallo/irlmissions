import { describe, expect, it } from "vitest"
import { publicRequestOrigin } from "@/shared/public-origin"

describe("publicRequestOrigin", () => {
  it("uses the configured public callback origin instead of the container URL", () => {
    const request = new Request("http://0.0.0.0:8080/api/setup", {
      headers: {
        "x-forwarded-host": "producer.example",
        "x-forwarded-proto": "https",
      },
    })
    expect(
      publicRequestOrigin(
        request,
        "https://irlmissions.example/api/auth/twitch/callback"
      )
    ).toBe("https://irlmissions.example")
  })

  it("uses proxy headers when no configured URL is available", () => {
    const request = new Request("http://0.0.0.0:8080/api/setup", {
      headers: {
        "x-forwarded-host": "producer.example, internal.example",
        "x-forwarded-proto": "https",
      },
    })
    expect(publicRequestOrigin(request, undefined)).toBe(
      "https://producer.example"
    )
  })

  it("keeps the request origin for local development", () => {
    expect(
      publicRequestOrigin(
        new Request("http://localhost:3000/api/setup"),
        undefined
      )
    ).toBe("http://localhost:3000")
  })
})
