import type { MissionRecord } from "@/shared/missions"
import type { ConsequenceClearRule } from "@/shared/pitches/processor"
import { withoutDashes } from "@/shared/polls"

export const DEFAULT_CONSEQUENCE_ROTATE_SECONDS = 6
export const MAX_PUBLIC_CONSEQUENCES = 20

export type ConsequenceClearReason =
  "timer" | "arrived" | "mission_ended" | "capped" | "paid" | "removed"

/** One owed (or cleared) consequence: sessions/current/consequences/{id}. */
export type ConsequenceRecord = {
  consequenceId: string
  /** Opaque, random id the overlay keys its boxes by. */
  publicKey: string
  text: string
  setBy: string
  clearRule: ConsequenceClearRule
  /** Whole minutes for a timed rule; 0 otherwise. */
  durationMinutes: number
  activatedAt: number
  /** Server timestamp a timed consequence clears at. */
  endsAt?: number
  status: "owed" | "cleared"
  sourceMissionId: string
  clearedAt?: number
  clearedReason?: ConsequenceClearReason
  updatedAt: number
}

/** The only consequence fields the overlay ever receives. */
export type PublicConsequence = {
  key: string
  text: string
  setBy: string
  clearRule: ConsequenceClearRule
  endsAt?: number
}

export type ConsequenceCommand =
  | { action: "pay" }
  | { action: "remove" }
  | {
      action: "change"
      clearRule: ConsequenceClearRule
      durationMinutes: number
    }

export class ConsequenceError extends Error {
  constructor(
    public readonly code: string,
    public readonly status = 409
  ) {
    super(code)
  }
}

const CLEAR_RULES: readonly ConsequenceClearRule[] = [
  "timed",
  "at_next_stop",
  "through_next_mission",
  "manual",
]

function clearRule(value: unknown): ConsequenceClearRule | null {
  return CLEAR_RULES.includes(value as ConsequenceClearRule)
    ? (value as ConsequenceClearRule)
    : null
}

/** Firestore document id for a consequence id ("mission:poll:123"). */
export function consequenceDocId(consequenceId: string) {
  return encodeURIComponent(consequenceId)
}

export function isOwed(record: ConsequenceRecord, now: number) {
  return (
    record.status === "owed" &&
    (record.endsAt === undefined || record.endsAt > now)
  )
}

/** Oldest first, so the overlay and console list them in the same order. */
export function sortConsequences<T extends { activatedAt: number }>(
  records: T[]
) {
  return [...records].sort((a, b) => a.activatedAt - b.activatedAt)
}

// The consequence a failed mission's viewer asked for. Denied missions
// never activate one.
export function consequenceFromFailure(
  mission: MissionRecord,
  publicKey: string,
  now: number
): ConsequenceRecord | null {
  if (
    mission.status !== "failed" ||
    mission.outcome === "denied" ||
    !mission.failConsequence?.trim()
  ) {
    return null
  }
  const rule = mission.failConsequenceClearRule ?? "through_next_mission"
  const minutes =
    rule === "timed" ? (mission.failConsequenceDurationMinutes ?? 0) : 0
  const timed = rule === "timed" && minutes > 0
  return {
    consequenceId: `mission:${mission.missionId}`,
    publicKey,
    text: mission.failConsequence.trim().slice(0, 80),
    setBy: mission.viewerName ?? "Chat",
    clearRule: rule === "timed" && !timed ? "through_next_mission" : rule,
    durationMinutes: timed ? minutes : 0,
    activatedAt: now,
    ...(timed ? { endsAt: now + minutes * 60_000 } : {}),
    status: "owed",
    sourceMissionId: mission.missionId,
    updatedAt: now,
  }
}

export type ConsequenceEvent =
  | { type: "arrived" }
  | { type: "outcome"; missionId: string; cap: boolean }
  | { type: "sweep" }

// Every rule runs per consequence. Returns the ones this event clears and
// why; anything not listed stays owed. Expired timers clear on any event.
export function consequencesClearedBy(
  event: ConsequenceEvent,
  owed: ConsequenceRecord[],
  now: number
): Array<{ consequenceId: string; reason: ConsequenceClearReason }> {
  return owed.flatMap((record) => {
    const reason = clearReason(event, record, now)
    return reason ? [{ consequenceId: record.consequenceId, reason }] : []
  })
}

function clearReason(
  event: ConsequenceEvent,
  record: ConsequenceRecord,
  now: number
): ConsequenceClearReason | null {
  if (record.status !== "owed") return null
  if (record.endsAt !== undefined && record.endsAt <= now) return "timer"
  if (event.type === "arrived" && record.clearRule === "at_next_stop") {
    return "arrived"
  }
  // A mission's outcome never clears the consequence it just created.
  if (event.type === "outcome" && record.sourceMissionId !== event.missionId) {
    if (event.cap) return "capped"
    if (record.clearRule === "through_next_mission") return "mission_ended"
  }
  return null
}

export function clearConsequence(
  record: ConsequenceRecord,
  reason: ConsequenceClearReason,
  now: number
): ConsequenceRecord {
  return {
    ...record,
    status: "cleared",
    clearedAt: now,
    clearedReason: reason,
    updatedAt: now,
  }
}

export function parseConsequenceCommand(value: unknown): {
  consequenceId: string
  command: ConsequenceCommand
} {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new ConsequenceError("invalid_consequence_command", 400)
  }
  const input = value as Record<string, unknown>
  const consequenceId = input.consequenceId
  if (
    typeof consequenceId !== "string" ||
    !consequenceId ||
    consequenceId.length > 512
  ) {
    throw new ConsequenceError("invalid_consequence_id", 400)
  }
  if (input.action === "pay" || input.action === "remove") {
    return { consequenceId, command: { action: input.action } }
  }
  if (input.action !== "change") {
    throw new ConsequenceError("invalid_consequence_command", 400)
  }
  const rule = clearRule(input.clearRule)
  if (!rule) throw new ConsequenceError("invalid_clear_rule", 400)
  const minutes = rule === "timed" ? input.durationMinutes : 0
  if (
    !Number.isInteger(minutes) ||
    (rule === "timed" &&
      ((minutes as number) < 1 || (minutes as number) > 1440))
  ) {
    throw new ConsequenceError("invalid_consequence_duration", 400)
  }
  return {
    consequenceId,
    command: {
      action: "change",
      clearRule: rule,
      durationMinutes: minutes as number,
    },
  }
}

// Mark paid and remove both clear it, for any rule. Changing the rule
// restarts a timed one from now.
export function applyConsequenceCommand(
  record: ConsequenceRecord,
  command: ConsequenceCommand,
  now: number
): ConsequenceRecord {
  if (!isOwed(record, now)) throw new ConsequenceError("consequence_cleared")
  if (command.action === "pay") return clearConsequence(record, "paid", now)
  if (command.action === "remove") {
    return clearConsequence(record, "removed", now)
  }
  const next: ConsequenceRecord = {
    ...record,
    clearRule: command.clearRule,
    durationMinutes:
      command.clearRule === "timed" ? command.durationMinutes : 0,
    updatedAt: now,
  }
  if (command.clearRule === "timed") {
    next.endsAt = now + command.durationMinutes * 60_000
  } else {
    delete next.endsAt
  }
  return next
}

/** Owner console view: owed only, oldest first. */
export function ownerConsequences(records: ConsequenceRecord[], now: number) {
  return sortConsequences(records.filter((record) => isOwed(record, now)))
}

// Rebuild an allowlisted list rather than exposing stored documents.
export function publicConsequences(
  records: ConsequenceRecord[],
  now: number
): PublicConsequence[] {
  return ownerConsequences(records, now)
    .slice(0, MAX_PUBLIC_CONSEQUENCES)
    .map((record) => ({
      key: record.publicKey,
      text: record.text,
      setBy: record.setBy,
      clearRule: record.clearRule,
      ...(record.clearRule === "timed" && record.endsAt !== undefined
        ? { endsAt: record.endsAt }
        : {}),
    }))
}

function publicText(value: unknown, maximum: number) {
  if (typeof value !== "string") return null
  const result = withoutDashes(value)
  return result && result.length <= maximum ? result : null
}

/** Re-validate the stored public list before serving it to the overlay. */
export function parsePublicConsequences(
  value: unknown,
  now: number
): PublicConsequence[] {
  const items =
    value && typeof value === "object" && !Array.isArray(value)
      ? (value as Record<string, unknown>).items
      : null
  if (!Array.isArray(items)) return []
  return items.slice(0, MAX_PUBLIC_CONSEQUENCES).flatMap((value) => {
    if (!value || typeof value !== "object" || Array.isArray(value)) return []
    const item = value as Record<string, unknown>
    const key = typeof item.key === "string" ? item.key : ""
    const text = publicText(item.text, 80)
    const setBy = publicText(item.setBy, 25)
    const rule = clearRule(item.clearRule)
    const endsAt = item.endsAt
    const validEnd =
      typeof endsAt === "number" && Number.isFinite(endsAt) && endsAt > 0
    if (!/^[A-Za-z0-9-]{8,64}$/.test(key) || !text || !setBy || !rule) {
      return []
    }
    if (rule === "timed" && (!validEnd || (endsAt as number) <= now)) return []
    return [
      {
        key,
        text,
        setBy,
        clearRule: rule,
        ...(rule === "timed" ? { endsAt: endsAt as number } : {}),
      },
    ]
  })
}

export function parseRotateSeconds(value: unknown) {
  return Number.isInteger(value) &&
    (value as number) >= 3 &&
    (value as number) <= 30
    ? (value as number)
    : DEFAULT_CONSEQUENCE_ROTATE_SECONDS
}
