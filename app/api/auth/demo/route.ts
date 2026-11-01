import {
  createDemoOwnerToken,
  DemoDisabledError,
} from "@/shared/auth/demo-owner"
import { publicRequestOrigin } from "@/shared/public-origin"

export const runtime = "nodejs"

export async function POST(request: Request) {
  // App Hosting terminates HTTPS before forwarding to the Next container, so
  // request.url may contain an internal HTTP origin. Compare against the
  // proxy's public origin while still requiring an exact same-origin POST.
  if (request.headers.get("origin") !== publicRequestOrigin(request, "")) {
    return Response.json({ error: "Invalid origin" }, { status: 403 })
  }
  try {
    const token = await createDemoOwnerToken(process.env, async (uid, claims) => {
      const { getServerFirebase } = await import("@/lib/firebase/admin")
      return getServerFirebase().auth.createCustomToken(uid, claims)
    })
    return Response.json(
      { token },
      { headers: { "Cache-Control": "no-store" } }
    )
  } catch (error) {
    if (error instanceof DemoDisabledError) {
      return Response.json({ error: "Not found" }, { status: 404 })
    }
    return Response.json(
      {
        error:
          "Demo login unavailable. Check emulator configuration and startup.",
      },
      { status: 503, headers: { "Cache-Control": "no-store" } }
    )
  }
}
