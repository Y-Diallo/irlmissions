import { NextResponse } from "next/server"
import { authFailure, NO_STORE } from "@/lib/auth/http"
import { parseStartPollCommand, PollError } from "@/shared/polls"

export const runtime = "nodejs"

function failure(error: unknown) {
  if (error instanceof SyntaxError) {
    return NextResponse.json(
      { error: "invalid_poll" },
      { status: 400, headers: NO_STORE }
    )
  }
  if (error instanceof PollError) {
    return NextResponse.json(
      { error: error.code },
      { status: error.status, headers: NO_STORE }
    )
  }
  return authFailure(error)
}

export async function GET(request: Request) {
  try {
    const [{ requireServerOwner }, { getServerFirebase }, { createPollStore }] =
      await Promise.all([
        import("@/lib/auth/server"),
        import("@/lib/firebase/admin"),
        import("@/lib/polls/store"),
      ])
    await requireServerOwner(request.headers.get("authorization"))
    const poll = await createPollStore(getServerFirebase().db).read()
    return NextResponse.json({ poll }, { headers: NO_STORE })
  } catch (error) {
    return failure(error)
  }
}

export async function POST(request: Request) {
  try {
    const { requireServerOwner } = await import("@/lib/auth/server")
    await requireServerOwner(request.headers.get("authorization"))
    const command = parseStartPollCommand(await request.json())
    const { startLivePoll } = await import("@/lib/polls/service")
    return NextResponse.json(
      { poll: await startLivePoll(command) },
      { headers: NO_STORE }
    )
  } catch (error) {
    return failure(error)
  }
}
