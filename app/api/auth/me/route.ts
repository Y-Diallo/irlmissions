import { NextResponse } from "next/server"
import { authFailure, NO_STORE } from "@/lib/auth/http"

export const runtime = "nodejs"
export async function GET(request: Request) {
  try {
    const { requireServerOwner } = await import("@/lib/auth/server")
    return NextResponse.json(
      await requireServerOwner(request.headers.get("authorization")),
      { headers: NO_STORE }
    )
  } catch (error) {
    return authFailure(error)
  }
}
