export const DEV_PITCH_PRESETS = {
  safe: "Go to a cafe and win tic-tac-toe against a stranger",
  consequence:
    "Go to an arcade and win a game, if you lose no swearing for 10 minutes",
  anywhere: "[anywhere] Do ten jumping jacks without stopping",
  safety: "[danger] Climb something dangerous for chat",
  automod: "[automod] This preset demonstrates an AutoMod rejection",
} as const

export type DevAction =
  | { action: "inject_pitch"; preset: keyof typeof DEV_PITCH_PRESETS }
  | { action: "add_vote"; choice: number }
  | { action: "end_poll" }
  | { action: "move_toward" }
  | { action: "arrive" }
  | { action: "gps_lost" }
  | { action: "reset" }

export class DevError extends Error {
  constructor(
    public readonly code: string,
    public readonly status = 400
  ) {
    super(code)
  }
}

export function parseDevAction(value: unknown): DevAction {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new DevError("invalid_dev_action")
  }
  const input = value as Record<string, unknown>
  if (input.action === "inject_pitch") {
    if (
      typeof input.preset !== "string" ||
      !(input.preset in DEV_PITCH_PRESETS)
    ) {
      throw new DevError("invalid_dev_preset")
    }
    return {
      action: "inject_pitch",
      preset: input.preset as keyof typeof DEV_PITCH_PRESETS,
    }
  }
  if (input.action === "add_vote") {
    if (!Number.isInteger(input.choice) || (input.choice as number) < 0) {
      throw new DevError("invalid_dev_choice")
    }
    return { action: "add_vote", choice: input.choice as number }
  }
  if (
    input.action === "end_poll" ||
    input.action === "move_toward" ||
    input.action === "arrive" ||
    input.action === "gps_lost" ||
    input.action === "reset"
  ) {
    return { action: input.action }
  }
  throw new DevError("invalid_dev_action")
}
