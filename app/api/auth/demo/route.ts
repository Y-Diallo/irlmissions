import {
  createDemoOwnerToken,
  DemoDisabledError,
} from "@/shared/auth/demo-owner"

export const runtime = "nodejs"

export async function POST(request: Request) {
  const requestUrl = new URL(request.url)
  // Next may construct request.url with its internal hostname. The browser's
  // Host header identifies the actual same-origin endpoint it requested.
  requestUrl.host = request.headers.get("host") ?? requestUrl.host
  if (request.headers.get("origin") !== requestUrl.origin) {
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
