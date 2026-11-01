import { describe, expect, it } from "vitest"
import { parseDevAction } from "@/shared/dev"

describe("emulator dev actions", () => {
  it("accepts the manual judge controls", () => {
    expect(parseDevAction({ action: "inject_pitch", preset: "safe" })).toEqual({
      action: "inject_pitch",
      preset: "safe",
    })
    expect(parseDevAction({ action: "add_vote", choice: 1 })).toEqual({
      action: "add_vote",
      choice: 1,
    })
    for (const action of [
      "end_poll",
      "move_toward",
      "arrive",
      "gps_lost",
      "reset",
    ] as const) {
      expect(parseDevAction({ action })).toEqual({ action })
    }
  })

  it("rejects unknown presets and malformed vote indexes", () => {
    expect(() =>
      parseDevAction({ action: "inject_pitch", preset: "custom" })
    ).toThrow("invalid_dev_preset")
    expect(() => parseDevAction({ action: "add_vote", choice: -1 })).toThrow(
      "invalid_dev_choice"
    )
    expect(() => parseDevAction({ action: "delete_everything" })).toThrow(
      "invalid_dev_action"
    )
  })
})
