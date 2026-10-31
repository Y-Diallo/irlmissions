import { NextResponse } from "next/server"
import { authFailure, NO_STORE } from "@/lib/auth/http"
import { MissionError, parseMissionAction } from "@/shared/missions"

export const runtime = "nodejs"

function failure(error: unknown) {
  if (error instanceof SyntaxError) {
    return NextResponse.json(
      { error: "invalid_mission_action" },
      { status: 400, headers: NO_STORE }
    )
  }
  if (error instanceof MissionError) {
    return NextResponse.json(
      { error: error.code },
      { status: error.status, headers: NO_STORE }
    )
  }
  return authFailure(error)
}

export async function GET(request: Request) {
  try {
    const [
      { requireServerOwner },
      { getServerFirebase },
      { createMissionStore },
    ] = await Promise.all([
      import("@/lib/auth/server"),
      import("@/lib/firebase/admin"),
      import("@/lib/missions/store"),
    ])
    await requireServerOwner(request.headers.get("authorization"))
    const mission = await createMissionStore(getServerFirebase().db).read()
    return NextResponse.json({ mission }, { headers: NO_STORE })
  } catch (error) {
    return failure(error)
  }
}

export async function PATCH(request: Request) {
  try {
    const [
      { requireServerOwner },
      { getServerFirebase },
      { createMissionStore },
    ] = await Promise.all([
      import("@/lib/auth/server"),
      import("@/lib/firebase/admin"),
      import("@/lib/missions/store"),
    ])
    await requireServerOwner(request.headers.get("authorization"))
    const action = parseMissionAction(await request.json())
    const mission = await createMissionStore(getServerFirebase().db).act(
      action,
      Date.now()
    )
    return NextResponse.json({ mission }, { headers: NO_STORE })
  } catch (error) {
    return failure(error)
  }
}
