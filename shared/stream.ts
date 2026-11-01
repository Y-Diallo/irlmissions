import type { MissionStatus } from "@/shared/missions"
import type { PollStatus } from "@/shared/polls"

export class StreamError extends Error {
  constructor(
    public readonly code: string,
    public readonly status = 409
  ) {
    super(code)
  }
}

export function parseEndStreamCommand(value: unknown) {
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    (value as Record<string, unknown>).action !== "end_stream"
  ) {
    throw new StreamError("invalid_stream_action", 400)
  }
  return { action: "end_stream" as const }
}

export function assertStreamCanEnd(input: {
  missionStatus?: MissionStatus
  pollStatus?: PollStatus
}) {
  if (input.missionStatus === "arrived") {
    throw new StreamError("stream_mission_needs_outcome")
  }
  if (
    input.pollStatus === "creating" ||
    input.pollStatus === "create_unknown"
  ) {
    throw new StreamError("stream_poll_needs_reconciliation")
  }
}
