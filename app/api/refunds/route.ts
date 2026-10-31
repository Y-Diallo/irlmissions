import { NextResponse } from "next/server"
import { authFailure, NO_STORE } from "@/lib/auth/http"
import { parseRefundCommand, RefundError } from "@/shared/refunds"

export const runtime = "nodejs"

function failure(error: unknown) {
  if (error instanceof SyntaxError) {
    return NextResponse.json(
      { error: "invalid_refund_command" },
      { status: 400, headers: NO_STORE }
    )
  }
  if (error instanceof RefundError) {
    return NextResponse.json(
      { error: error.code },
      { status: error.status, headers: NO_STORE }
    )
  }
  return authFailure(error)
}

async function dependencies(authorization: string | null) {
  const [{ requireServerOwner }, { getServerFirebase }, { createRefundStore }] =
    await Promise.all([
      import("@/lib/auth/server"),
      import("@/lib/firebase/admin"),
      import("@/lib/refunds/store"),
    ])
  await requireServerOwner(authorization)
  return createRefundStore(getServerFirebase().db)
}

export async function GET(request: Request) {
  try {
    const store = await dependencies(request.headers.get("authorization"))
    return NextResponse.json(
      { refunds: await store.list() },
      { headers: NO_STORE }
    )
  } catch (error) {
    return failure(error)
  }
}

export async function POST(request: Request) {
  try {
    const store = await dependencies(request.headers.get("authorization"))
    parseRefundCommand(await request.json())
    const result = await store.queueUnused(Date.now())
    return NextResponse.json(result, { headers: NO_STORE })
  } catch (error) {
    return failure(error)
  }
}
