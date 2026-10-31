import { NextResponse } from "next/server"
import { authFailure, NO_STORE } from "@/lib/auth/http"
import { PollError } from "@/shared/polls"

export const runtime = "nodejs"

export async function POST(request: Request) {
  try {
    const { requireServerOwner } = await import("@/lib/auth/server")
    const owner = await requireServerOwner(
      request.headers.get("authorization")
    )
    const { reconcileLivePoll } = await import("@/lib/polls/service")
    return NextResponse.json(await reconcileLivePoll(owner.tenantId), {
      headers: NO_STORE,
    })
  } catch (error) {
    if (error instanceof PollError) {
      return NextResponse.json(
        { error: error.code },
        { status: error.status, headers: NO_STORE }
      )
    }
    return authFailure(error)
  }
}
