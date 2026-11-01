export class SetupError extends Error {
  constructor(
    public readonly code: string,
    public readonly status = 400
  ) {
    super(code)
  }
}

function number(
  value: unknown,
  code: string,
  minimum: number,
  maximum: number
) {
  if (
    typeof value !== "number" ||
    !Number.isFinite(value) ||
    value < minimum ||
    value > maximum
  ) {
    throw new SetupError(code)
  }
  return value
}

export function parseSetupUpdate(value: unknown) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new SetupError("invalid_setup")
  }
  const input = value as Record<string, unknown>
  const pullKey = input.realtimeIrlPullKey
  if (
    pullKey !== undefined &&
    pullKey !== null &&
    (typeof pullKey !== "string" || pullKey.length < 8 || pullKey.length > 512)
  ) {
    throw new SetupError("invalid_realtimeirl_key")
  }
  const baseZone = input.baseZone
  if (!baseZone || typeof baseZone !== "object" || Array.isArray(baseZone)) {
    throw new SetupError("invalid_base_zone")
  }
  const base = baseZone as Record<string, unknown>
  const travelMode = input.travelMode ?? "walk"
  if (!["walk", "transit", "drive"].includes(String(travelMode))) {
    throw new SetupError("invalid_travel_mode")
  }
  return {
    realtimeIrlPullKey:
      typeof pullKey === "string" ? pullKey.trim() : (pullKey as null),
    settings: {
      searchRadiusMeters: number(
        input.searchRadiusMeters,
        "invalid_search_radius",
        100,
        50_000
      ),
      defaultDurationMinutes: number(
        input.defaultDurationMinutes,
        "invalid_duration",
        1,
        120
      ),
      travelMode: travelMode as "walk" | "transit" | "drive",
      llmEnabled: input.llmEnabled === true,
      locationMaxAgeMs: 120_000,
      baseZone: {
        latitude: number(base.latitude, "invalid_base_zone", -90, 90),
        longitude: number(base.longitude, "invalid_base_zone", -180, 180),
        radiusMeters: number(
          base.radiusMeters,
          "invalid_base_zone",
          25,
          10_000
        ),
      },
      arrivalRadiusMeters: number(
        input.arrivalRadiusMeters,
        "invalid_arrival_radius",
        10,
        1_000
      ),
      arrivalSampleSpanMs: 10_000,
      arrivalLocationMaxAgeMs: 30_000,
    },
  }
}

export function parseSetupAction(value: unknown) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new SetupError("invalid_setup_action")
  }
  const action = (value as Record<string, unknown>).action
  if (
    action !== "rotate_overlay" &&
    action !== "retry_twitch" &&
    action !== "enable_reward" &&
    action !== "disable_reward" &&
    action !== "no_travel_on" &&
    action !== "no_travel_off"
  ) {
    throw new SetupError("invalid_setup_action")
  }
  return action
}
