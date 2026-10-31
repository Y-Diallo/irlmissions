import { NextResponse } from "next/server"
import { authFailure, NO_STORE } from "@/lib/auth/http"
import { PitchReviewError } from "@/shared/pitches/review"

export const runtime = "nodejs"
export const maxDuration = 60

export async function POST(
  request: Request,
  { params }: { params: Promise<{ redemptionId: string }> }
) {
  try {
    const { requireServerOwner } = await import("@/lib/auth/server")
    const owner = await requireServerOwner(
      request.headers.get("authorization")
    )
    const { redemptionId } = await params
    if (
      !redemptionId ||
      redemptionId.length > 512 ||
      redemptionId.includes("/")
    ) {
      throw new PitchReviewError("invalid_redemption_id", 400)
    }
    const { runPitchNow } = await import("@/lib/pitches/runner")
    return NextResponse.json(await runPitchNow(owner.tenantId, redemptionId), {
      headers: NO_STORE,
    })
  } catch (error) {
    if (error instanceof PitchReviewError) {
      return NextResponse.json(
        { error: error.code },
        { status: error.status, headers: NO_STORE }
      )
    }
    return authFailure(error)
  }
}
