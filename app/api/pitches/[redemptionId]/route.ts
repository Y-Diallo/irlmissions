import { NextResponse } from "next/server"
import { authFailure, NO_STORE } from "@/lib/auth/http"
import { parseReviewCommand, PitchReviewError } from "@/shared/pitches/review"

export const runtime = "nodejs"

export async function PATCH(
  request: Request,
  { params }: { params: Promise<{ redemptionId: string }> }
) {
  try {
    const [
      { requireServerOwner },
      { getServerFirebase },
      { createPitchReviewStore },
    ] = await Promise.all([
      import("@/lib/auth/server"),
      import("@/lib/firebase/admin"),
      import("@/lib/pitches/review-store"),
    ])
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
    const command = parseReviewCommand(await request.json())
    const result = await createPitchReviewStore(
      getServerFirebase().db,
      owner.tenantId
    ).update(redemptionId, command, Date.now())
    return NextResponse.json(result, { headers: NO_STORE })
  } catch (error) {
    if (error instanceof SyntaxError) {
      return NextResponse.json(
        { error: "invalid_command" },
        { status: 400, headers: NO_STORE }
      )
    }
    if (error instanceof PitchReviewError) {
      return NextResponse.json(
        { error: error.code },
        { status: error.status, headers: NO_STORE }
      )
    }
    return authFailure(error)
  }
}
