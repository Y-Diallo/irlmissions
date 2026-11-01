import { describe, expect, it } from "vitest"
import { assertStreamCanEnd, parseEndStreamCommand } from "@/shared/stream"

describe("end stream policy", () => {
  it("accepts the explicit destructive command", () => {
    expect(parseEndStreamCommand({ action: "end_stream" })).toEqual({
      action: "end_stream",
    })
    expect(() => parseEndStreamCommand({ action: "reset" })).toThrow(
      "invalid_stream_action"
    )
  })

  it("requires an outcome for an arrived mission", () => {
    expect(() => assertStreamCanEnd({ missionStatus: "heading" })).not.toThrow()
    expect(() => assertStreamCanEnd({ missionStatus: "arrived" })).toThrow(
      "stream_mission_needs_outcome"
    )
  })

  it("requires uncertain poll creation to be reconciled", () => {
    expect(() => assertStreamCanEnd({ pollStatus: "active" })).not.toThrow()
    expect(() => assertStreamCanEnd({ pollStatus: "creating" })).toThrow(
      "stream_poll_needs_reconciliation"
    )
    expect(() => assertStreamCanEnd({ pollStatus: "create_unknown" })).toThrow(
      "stream_poll_needs_reconciliation"
    )
  })
})
