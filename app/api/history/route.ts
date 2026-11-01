import { NextResponse } from "next/server"
import { authFailure, NO_STORE } from "@/lib/auth/http"

export const runtime = "nodejs"

export async function GET(request: Request) {
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
    const owner = await requireServerOwner(request.headers.get("authorization"))
    const history = await createPitchReviewStore(
      getServerFirebase().db,
      owner.tenantId
    ).history()
    return NextResponse.json({ history }, { headers: NO_STORE })
  } catch (error) {
    return authFailure(error)
  }
}
