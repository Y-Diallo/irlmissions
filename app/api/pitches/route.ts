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
    await requireServerOwner(request.headers.get("authorization"))
    const pitches = await createPitchReviewStore(getServerFirebase().db).list()
    return NextResponse.json({ pitches }, { headers: NO_STORE })
  } catch (error) {
    return authFailure(error)
  }
}
