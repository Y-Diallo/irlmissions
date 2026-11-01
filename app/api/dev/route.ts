import { NextResponse } from "next/server"
import { authFailure, NO_STORE } from "@/lib/auth/http"
import { DevError, parseDevAction } from "@/shared/dev"

export const runtime = "nodejs"

export async function POST(request: Request) {
  try {
    const [{ requireServerOwner }, { getServerFirebase }, { runDevAction }] =
      await Promise.all([
        import("@/lib/auth/server"),
        import("@/lib/firebase/admin"),
        import("@/lib/dev/simulator"),
      ])
    const owner = await requireServerOwner(request.headers.get("authorization"))
    if (owner.mode !== "emulator" && owner.mode !== "demo") {
      return NextResponse.json({ error: "not_found" }, { status: 404 })
    }
    const action = parseDevAction(await request.json())
    return NextResponse.json(
      await runDevAction(getServerFirebase().db, owner.tenantId, action),
      { headers: NO_STORE }
    )
  } catch (error) {
    if (error instanceof SyntaxError || error instanceof DevError) {
      const code = error instanceof DevError ? error.code : "invalid_dev_action"
      const status = error instanceof DevError ? error.status : 400
      return NextResponse.json({ error: code }, { status, headers: NO_STORE })
    }
    return authFailure(error)
  }
}
