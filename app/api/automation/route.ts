import { NextResponse } from "next/server"
import { authFailure, NO_STORE } from "@/lib/auth/http"

export const runtime = "nodejs"

// The producer console calls this every few seconds while it is open; it
// is the automation heartbeat. Repeated or concurrent calls are safe.
export async function POST(request: Request) {
  try {
    const { requireServerOwner } = await import("@/lib/auth/server")
    const owner = await requireServerOwner(request.headers.get("authorization"))
    const { runLiveAutomation } = await import("@/lib/automation/service")
    return NextResponse.json(
      { status: await runLiveAutomation(owner.tenantId) },
      { headers: NO_STORE }
    )
  } catch (error) {
    return authFailure(error)
  }
}
