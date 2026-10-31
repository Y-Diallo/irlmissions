import { NextResponse } from "next/server"
import {
  authenticateScheduledProcessor,
  ProcessorScheduleError,
  readProcessorScheduleConfig,
} from "@/shared/processor-schedule"

export const runtime = "nodejs"
export const maxDuration = 60

const headers = {
  "Cache-Control": "no-store",
  "Referrer-Policy": "no-referrer",
}

export async function POST(request: Request) {
  try {
    const config = readProcessorScheduleConfig(process.env)
    const { verifyGoogleIdToken } = await import("@/lib/internal/google-oidc")
    await authenticateScheduledProcessor(
      request.headers.get("authorization"),
      config,
      verifyGoogleIdToken
    )
    const { runScheduledTenants } = await import("@/lib/tenants/processor")
    return NextResponse.json(await runScheduledTenants(), { headers })
  } catch (error) {
    if (error instanceof ProcessorScheduleError) {
      return NextResponse.json(
        { error: error.code },
        { status: error.status, headers }
      )
    }
    return NextResponse.json(
      { error: "temporarily_unavailable" },
      { status: 503, headers }
    )
  }
}
