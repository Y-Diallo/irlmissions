import { NextResponse } from "next/server"
import { authFailure, NO_STORE } from "@/lib/auth/http"
import { parseEndStreamCommand, StreamError } from "@/shared/stream"

export const runtime = "nodejs"

function failure(error: unknown) {
  if (error instanceof SyntaxError || error instanceof StreamError) {
    const streamError =
      error instanceof StreamError
        ? error
        : new StreamError("invalid_stream_action", 400)
    return NextResponse.json(
      { error: streamError.code },
      { status: streamError.status, headers: NO_STORE }
    )
  }
  return authFailure(error)
}

export async function POST(request: Request) {
  try {
    const [{ requireServerOwner }, { endLiveStream }] = await Promise.all([
      import("@/lib/auth/server"),
      import("@/lib/stream/end"),
    ])
    const owner = await requireServerOwner(request.headers.get("authorization"))
    parseEndStreamCommand(await request.json())
    return NextResponse.json(await endLiveStream(owner.tenantId), {
      headers: NO_STORE,
    })
  } catch (error) {
    return failure(error)
  }
}
