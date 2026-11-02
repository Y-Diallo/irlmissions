import { NextResponse } from "next/server"
import { authFailure, NO_STORE } from "@/lib/auth/http"
import {
  ConsequenceError,
  parseConsequenceCommand,
} from "@/shared/consequences"

export const runtime = "nodejs"

// Owner edits one owed consequence: mark paid, change how it clears, or remove.
export async function PATCH(request: Request) {
  try {
    const [
      { requireServerOwner },
      { getServerFirebase },
      { createConsequenceStore },
    ] = await Promise.all([
      import("@/lib/auth/server"),
      import("@/lib/firebase/admin"),
      import("@/lib/consequences/store"),
    ])
    const owner = await requireServerOwner(request.headers.get("authorization"))
    const { consequenceId, command } = parseConsequenceCommand(
      await request.json()
    )
    const consequences = await createConsequenceStore(
      getServerFirebase().db,
      owner.tenantId
    ).command(consequenceId, command, Date.now())
    return NextResponse.json({ consequences }, { headers: NO_STORE })
  } catch (error) {
    if (error instanceof SyntaxError) {
      return NextResponse.json(
        { error: "invalid_consequence_command" },
        { status: 400, headers: NO_STORE }
      )
    }
    if (error instanceof ConsequenceError) {
      return NextResponse.json(
        { error: error.code },
        { status: error.status, headers: NO_STORE }
      )
    }
    return authFailure(error)
  }
}
