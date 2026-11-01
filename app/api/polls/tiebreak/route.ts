import { NextResponse } from "next/server"
import { authFailure, NO_STORE } from "@/lib/auth/http"
import { MissionError } from "@/shared/missions"
import { PollError } from "@/shared/polls"

export const runtime = "nodejs"

export async function POST(request: Request) {
  try {
    const [{ requireServerOwner }, { getServerFirebase }, { createPollEndStore }] =
      await Promise.all([
        import("@/lib/auth/server"),
        import("@/lib/firebase/admin"),
        import("@/lib/polls/end-store"),
      ])
    const owner = await requireServerOwner(
      request.headers.get("authorization")
    )
    const body = (await request.json()) as Record<string, unknown> | null
    const redemptionId = body?.redemptionId
    if (typeof redemptionId !== "string" || !redemptionId) {
      throw new PollError("invalid_pitch_ids", 400)
    }
    const result = await createPollEndStore(
      getServerFirebase().db,
      owner.tenantId
    ).chooseTieWinner(redemptionId, Date.now())
    return NextResponse.json(result, { headers: NO_STORE })
  } catch (error) {
    if (error instanceof SyntaxError) {
      return NextResponse.json(
        { error: "invalid_pitch_ids" },
        { status: 400, headers: NO_STORE }
      )
    }
    if (error instanceof PollError || error instanceof MissionError) {
      return NextResponse.json(
        { error: error.code },
        { status: error.status, headers: NO_STORE }
      )
    }
    return authFailure(error)
  }
}
