import { randomBytes } from "node:crypto"

import { MAX_POLL_CHOICE_LENGTH, withoutDashes } from "@/shared/polls"

const CLAIM_MS = 2 * 60 * 1000
const DEFAULT_LOCATION_MAX_AGE_MS = 2 * 60 * 1000
const FEED_HEARTBEAT_MAX_AGE_MS = 2 * 60 * 1000
const MAX_AUTOMATIC_ATTEMPTS = 5

export type Coordinates = { latitude: number; longitude: number }
export type ProcessingWarning = "stale_location"
export type TravelMode = "walk" | "transit" | "drive"

export type ProcessingPitch = {
  redemptionId: string
  rawText: string
  attempt: number
  leaseId: string
}

export type ProcessingContext = {
  origin: Coordinates & { observedAt: number }
  locationConfirmedAt?: number
  searchRadiusMeters: number
  baseZone: Coordinates & { radiusMeters: number }
  llmEnabled: boolean
  defaultDurationMinutes: number
  travelMode: TravelMode
  locationMaxAgeMs?: number
}

export type RiskFlag = {
  category: "dangerous" | "illegal" | "harassing" | "other"
  reason: string
}

export type PitchExtraction = {
  placeQuery: string
  challenge: string
  publicLabelSuggestion: string
  durationMinutes: number
  riskFlags: RiskFlag[]
}

export type PlaceCandidate = Coordinates & {
  placeId: string
  name: string
  address: string
  publicAccess: boolean
  businessStatus:
    "operational" | "closed_temporarily" | "closed_permanently" | "unknown"
  hoursText: string[] | null
  googleMapsUri: string
  attributions: { provider: string; providerUri: string }[]
}

export type WalkingRoute = {
  distanceMeters: number
  durationSeconds: number
  mode?: TravelMode
}

export type DuplicateSuggestion = {
  redemptionId: string
  summary: string
}

export type ReviewPitch = {
  extraction: PitchExtraction
  destination: PlaceCandidate
  walkingRoute: WalkingRoute
  duplicateSuggestions: DuplicateSuggestion[]
  straightLineMeters: number
  warnings: ProcessingWarning[]
}

export type PitchStore = {
  claim(
    redemptionId: string,
    leaseId: string,
    now: number,
    claimedUntil: number
  ): Promise<ProcessingPitch | null>
  complete(
    pitch: ProcessingPitch,
    review: ReviewPitch,
    now: number
  ): Promise<boolean>
  reject(
    pitch: ProcessingPitch,
    reason: "automod" | "no_public_place",
    now: number
  ): Promise<boolean>
  fail(
    pitch: ProcessingPitch,
    failure: {
      code: string
      automaticRetryAt: number | null
      failedAt: number
    }
  ): Promise<boolean>
}

export type PitchProcessorDependencies = {
  store: PitchStore
  context: { read(): Promise<ProcessingContext> }
  automod: {
    check(input: { messageId: string; text: string }): Promise<boolean>
  }
  extractor: { extract(text: string): Promise<PitchExtraction> }
  places: {
    search(input: {
      query: string
      origin: Coordinates
      radiusMeters: number
    }): Promise<PlaceCandidate[]>
  }
  routes: {
    walk(
      origin: Coordinates,
      destination: Coordinates,
      mode: TravelMode
    ): Promise<WalkingRoute>
  }
  duplicates: {
    suggest(input: {
      redemptionId: string
      extraction: PitchExtraction
      destination: PlaceCandidate
    }): Promise<DuplicateSuggestion[]>
  }
  now: () => number
  leaseId?: () => string
}

export type ProcessPitchResult =
  | { kind: "not_claimed" }
  | { kind: "rejected"; reason: "automod" | "no_public_place" }
  | { kind: "ready_for_review"; flagged: boolean }
  | { kind: "retry"; code: string; automaticRetryAt: number | null }

class ProcessingError extends Error {
  constructor(public readonly code: string) {
    super(code)
  }
}

function finite(value: number, code: string) {
  if (!Number.isFinite(value)) throw new ProcessingError(code)
  return value
}

function validCoordinates(value: Coordinates, code: string) {
  finite(value.latitude, code)
  finite(value.longitude, code)
  if (
    value.latitude < -90 ||
    value.latitude > 90 ||
    value.longitude < -180 ||
    value.longitude > 180
  ) {
    throw new ProcessingError(code)
  }
  return value
}

function radians(value: number) {
  return (value * Math.PI) / 180
}

export function distanceMeters(a: Coordinates, b: Coordinates) {
  validCoordinates(a, "invalid_coordinates")
  validCoordinates(b, "invalid_coordinates")
  const earthRadius = 6_371_000
  const latitude = radians(b.latitude - a.latitude)
  const longitude = radians(b.longitude - a.longitude)
  const left = radians(a.latitude)
  const right = radians(b.latitude)
  const haversine =
    Math.sin(latitude / 2) ** 2 +
    Math.cos(left) * Math.cos(right) * Math.sin(longitude / 2) ** 2
  return 2 * earthRadius * Math.asin(Math.sqrt(haversine))
}

function validateContext(context: ProcessingContext, now: number) {
  validCoordinates(context.origin, "invalid_origin")
  validCoordinates(context.baseZone, "invalid_base_zone")
  const maxAge =
    context.locationConfirmedAt === undefined
      ? (context.locationMaxAgeMs ?? DEFAULT_LOCATION_MAX_AGE_MS)
      : FEED_HEARTBEAT_MAX_AGE_MS
  const confirmedAt = context.locationConfirmedAt ?? context.origin.observedAt
  const stale =
    !Number.isFinite(confirmedAt) ||
    confirmedAt > now + 30_000 ||
    now - confirmedAt > maxAge
  if (
    !Number.isFinite(context.searchRadiusMeters) ||
    context.searchRadiusMeters <= 0 ||
    context.searchRadiusMeters > 50_000 ||
    !Number.isFinite(context.baseZone.radiusMeters) ||
    context.baseZone.radiusMeters < 0 ||
    !Number.isInteger(context.defaultDurationMinutes) ||
    context.defaultDurationMinutes < 1 ||
    context.defaultDurationMinutes > 120 ||
    !["walk", "transit", "drive"].includes(context.travelMode)
  ) {
    throw new ProcessingError("invalid_settings")
  }
  return stale ? (["stale_location"] satisfies ProcessingWarning[]) : []
}

function cleanText(value: unknown, max: number, code: string) {
  if (typeof value !== "string") throw new ProcessingError(code)
  const text = value.trim()
  if (!text || text.length > max) throw new ProcessingError(code)
  return text
}

// Twitch rejects longer poll choices, so cut at a word boundary when possible.
export function fitPollLabel(text: string) {
  const label = withoutDashes(text).replace(/\s+/g, " ")
  if (label.length <= MAX_POLL_CHOICE_LENGTH) return label
  const cut = label.slice(0, MAX_POLL_CHOICE_LENGTH + 1)
  const space = cut.lastIndexOf(" ")
  return (space >= 10 ? cut.slice(0, space) : cut.slice(0, -1)).replace(
    /[\s,.;:!?-]+$/,
    ""
  )
}

export function validateExtraction(value: PitchExtraction): PitchExtraction {
  const durationMinutes = value.durationMinutes
  if (
    !Number.isInteger(durationMinutes) ||
    durationMinutes < 1 ||
    durationMinutes > 120 ||
    !Array.isArray(value.riskFlags) ||
    value.riskFlags.length > 8
  ) {
    throw new ProcessingError("invalid_extraction")
  }
  const categories = new Set(["dangerous", "illegal", "harassing", "other"])
  const riskFlags = value.riskFlags.map((flag) => {
    if (!flag || !categories.has(flag.category)) {
      throw new ProcessingError("invalid_extraction")
    }
    return {
      category: flag.category,
      reason: cleanText(flag.reason, 300, "invalid_extraction"),
    }
  })
  return {
    placeQuery: cleanText(value.placeQuery, 300, "invalid_extraction"),
    challenge: cleanText(value.challenge, 500, "invalid_extraction"),
    publicLabelSuggestion: cleanText(
      fitPollLabel(
        cleanText(value.publicLabelSuggestion, 300, "invalid_extraction")
      ),
      MAX_POLL_CHOICE_LENGTH,
      "invalid_extraction"
    ),
    durationMinutes,
    riskFlags,
  }
}

function fallbackExtraction(
  rawText: string,
  defaultDurationMinutes: number
): PitchExtraction {
  const text = cleanText(rawText, 5000, "invalid_pitch")
  return {
    placeQuery: text,
    challenge: text,
    publicLabelSuggestion: fitPollLabel(text),
    durationMinutes: defaultDurationMinutes,
    riskFlags: [],
  }
}

function eligiblePlaces(
  candidates: PlaceCandidate[],
  context: ProcessingContext
) {
  return candidates
    .map((candidate) => {
      validCoordinates(candidate, "invalid_places_response")
      const fromOrigin = distanceMeters(context.origin, candidate)
      const fromBase = distanceMeters(context.baseZone, candidate)
      return { candidate, fromOrigin, fromBase }
    })
    .filter(
      ({ candidate, fromOrigin, fromBase }) =>
        candidate.publicAccess &&
        candidate.businessStatus !== "closed_permanently" &&
        fromOrigin <= context.searchRadiusMeters &&
        fromBase > context.baseZone.radiusMeters
    )
    .sort((a, b) => a.fromOrigin - b.fromOrigin)
}

function validateRoute(route: WalkingRoute) {
  if (
    !Number.isFinite(route.distanceMeters) ||
    route.distanceMeters < 0 ||
    !Number.isFinite(route.durationSeconds) ||
    route.durationSeconds < 0
  ) {
    throw new ProcessingError("invalid_route_response")
  }
  return route
}

function retryAt(attempt: number, now: number) {
  if (attempt >= MAX_AUTOMATIC_ATTEMPTS) return null
  return now + Math.min(15_000 * 2 ** Math.max(0, attempt - 1), 5 * 60_000)
}

function safeFailureCode(error: unknown) {
  return error instanceof ProcessingError ? error.code : "provider_unavailable"
}

async function providerStep<T>(code: string, operation: () => Promise<T>) {
  try {
    return await operation()
  } catch (error) {
    // Keep provider response bodies and credentials out of Firestore/UI while
    // preserving enough information to diagnose the integration that failed.
    const exception =
      error instanceof Error
        ? {
            errorName: error.name,
            errorMessage: error.message.slice(0, 1_000),
            ...(error.stack ? { stack: error.stack.slice(0, 4_000) } : {}),
          }
        : { errorName: "UnknownError", errorMessage: "Unknown provider error" }
    console.error(
      JSON.stringify({
        severity: "ERROR",
        event: "pitch_processing_step_failed",
        message: `Pitch processing step failed: ${code}`,
        step: code,
        ...exception,
      })
    )
    throw new ProcessingError(code)
  }
}

export async function processPitch(
  redemptionId: string,
  deps: PitchProcessorDependencies
): Promise<ProcessPitchResult> {
  const now = deps.now()
  const leaseId = deps.leaseId?.() ?? randomBytes(24).toString("base64url")
  const pitch = await deps.store.claim(
    redemptionId,
    leaseId,
    now,
    now + CLAIM_MS
  )
  if (!pitch) return { kind: "not_claimed" }

  try {
    const context = await deps.context.read()
    const warnings = validateContext(context, now)
    const permitted = await providerStep("automod_unavailable", () =>
      deps.automod.check({
        messageId: pitch.redemptionId,
        text: pitch.rawText,
      })
    )
    if (!permitted) {
      if (!(await deps.store.reject(pitch, "automod", now))) {
        throw new ProcessingError("claim_lost")
      }
      return { kind: "rejected", reason: "automod" }
    }

    const extraction = context.llmEnabled
      ? validateExtraction(
          await providerStep("openai_unavailable", () =>
            deps.extractor.extract(pitch.rawText)
          )
        )
      : fallbackExtraction(pitch.rawText, context.defaultDurationMinutes)
    const candidates = await providerStep("places_unavailable", () =>
      deps.places.search({
        query: extraction.placeQuery,
        origin: context.origin,
        radiusMeters: context.searchRadiusMeters,
      })
    )
    const [selected] = eligiblePlaces(candidates, context)
    if (!selected) {
      if (!(await deps.store.reject(pitch, "no_public_place", now))) {
        throw new ProcessingError("claim_lost")
      }
      return { kind: "rejected", reason: "no_public_place" }
    }

    const walkingRoute = {
      ...validateRoute(
        await providerStep("routes_unavailable", () =>
          deps.routes.walk(
            context.origin,
            selected.candidate,
            context.travelMode
          )
        )
      ),
      mode: context.travelMode,
    }
    const duplicateSuggestions = await deps.duplicates.suggest({
      redemptionId: pitch.redemptionId,
      extraction,
      destination: selected.candidate,
    })
    if (
      !Array.isArray(duplicateSuggestions) ||
      duplicateSuggestions.length > 10
    ) {
      throw new ProcessingError("invalid_duplicate_response")
    }
    if (
      !(await deps.store.complete(
        pitch,
        {
          extraction,
          destination: selected.candidate,
          walkingRoute,
          duplicateSuggestions,
          straightLineMeters: Math.round(selected.fromOrigin),
          warnings,
        },
        now
      ))
    ) {
      throw new ProcessingError("claim_lost")
    }
    return {
      kind: "ready_for_review",
      flagged: extraction.riskFlags.length > 0,
    }
  } catch (error) {
    const code = safeFailureCode(error)
    const automaticRetryAt = retryAt(pitch.attempt, now)
    await deps.store.fail(pitch, { code, automaticRetryAt, failedAt: now })
    return { kind: "retry", code, automaticRetryAt }
  }
}
