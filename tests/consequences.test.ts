import { describe, expect, it } from "vitest"
import {
  applyConsequenceCommand,
  clearConsequence,
  consequenceFromFailure,
  consequencesClearedBy,
  ConsequenceError,
  ownerConsequences,
  parseConsequenceCommand,
  parsePublicConsequences,
  publicConsequences,
  type ConsequenceRecord,
} from "@/shared/consequences"
import {
  EMPTY_STRIP,
  STRIP_STAMP_MS,
  stripPage,
  stripReducer,
  type StripState,
} from "@/shared/consequence-strip"
import type { MissionRecord } from "@/shared/missions"
import type { ConsequenceClearRule } from "@/shared/pitches/processor"

const now = Date.parse("2026-11-01T20:00:00Z")

function owed(
  id: string,
  clearRule: ConsequenceClearRule,
  overrides: Partial<ConsequenceRecord> = {}
): ConsequenceRecord {
  return {
    consequenceId: id,
    publicKey: `key-${id}-0000`,
    text: `Penalty ${id}`,
    setBy: "Viewer",
    clearRule,
    durationMinutes: 0,
    activatedAt: now,
    status: "owed",
    sourceMissionId: `source-${id}`,
    updatedAt: now,
    ...overrides,
  }
}

// Applies what an event clears, like settleConsequences does in Firestore.
function settle(
  records: ConsequenceRecord[],
  event: Parameters<typeof consequencesClearedBy>[0],
  at: number
) {
  const cleared = new Map(
    consequencesClearedBy(event, records, at).map((item) => [
      item.consequenceId,
      item.reason,
    ])
  )
  return records.map((record) =>
    cleared.has(record.consequenceId)
      ? clearConsequence(record, cleared.get(record.consequenceId)!, at)
      : record
  )
}

describe("owed consequences", () => {
  it("lets several be owed and clears each by its own rule at its own time", () => {
    let records = [
      owed("short", "timed", { durationMinutes: 5, endsAt: now + 300_000 }),
      owed("long", "timed", { durationMinutes: 30, endsAt: now + 1_800_000 }),
      owed("stop", "at_next_stop"),
      owed("next", "through_next_mission"),
      owed("manual", "manual"),
    ]
    expect(ownerConsequences(records, now)).toHaveLength(5)

    // The short timer ends first; nothing else moves.
    records = settle(records, { type: "sweep" }, now + 300_000)
    expect(
      ownerConsequences(records, now + 300_000).map((r) => r.consequenceId)
    ).toEqual(["long", "stop", "next", "manual"])
    expect(records[0]).toMatchObject({
      status: "cleared",
      clearedReason: "timer",
    })

    // Arriving clears only the next-stop debt.
    records = settle(records, { type: "arrived" }, now + 400_000)
    expect(
      ownerConsequences(records, now + 400_000).map((r) => r.consequenceId)
    ).toEqual(["long", "next", "manual"])

    // The next mission's outcome clears the through-next-mission debt.
    records = settle(
      records,
      { type: "outcome", missionId: "mission-2", cap: false },
      now + 500_000
    )
    expect(
      ownerConsequences(records, now + 500_000).map((r) => r.consequenceId)
    ).toEqual(["long", "manual"])

    // The long timer runs out later, and the manual one waits for the owner.
    records = settle(records, { type: "sweep" }, now + 1_800_000)
    expect(
      ownerConsequences(records, now + 1_800_000).map((r) => r.consequenceId)
    ).toEqual(["manual"])
  })

  it("never clears a consequence at the outcome that created it", () => {
    const fresh = owed("fresh", "through_next_mission", {
      sourceMissionId: "mission-1",
    })
    expect(
      consequencesClearedBy(
        { type: "outcome", missionId: "mission-1", cap: true },
        [fresh],
        now
      )
    ).toEqual([])
  })

  it("caps several of every type at once at the next mission's outcome", () => {
    const records = [
      owed("timed", "timed", { durationMinutes: 120, endsAt: now + 7_200_000 }),
      owed("manual", "manual"),
      owed("stop", "at_next_stop"),
      owed("next", "through_next_mission"),
    ]
    // The cap isn't an override: until the outcome each rule still applies.
    const arrived = settle(records, { type: "arrived" }, now + 1000)
    expect(ownerConsequences(arrived, now + 1000)).toHaveLength(3)

    const capped = settle(
      arrived,
      { type: "outcome", missionId: "mission-2", cap: true },
      now + 2000
    )
    expect(ownerConsequences(capped, now + 2000)).toEqual([])
    expect(
      capped.filter((record) => record.clearedReason === "capped")
    ).toHaveLength(3)
  })

  it("activates a failed mission's consequence, but never a denied one", () => {
    const mission = {
      missionId: "poll:1",
      status: "failed",
      viewerName: "CoolViewer",
      failConsequence: "Use a pirate voice",
      failConsequenceClearRule: "timed",
      failConsequenceDurationMinutes: 10,
    } as MissionRecord
    expect(consequenceFromFailure(mission, "key-abcdefgh", now)).toMatchObject({
      consequenceId: "mission:poll:1",
      setBy: "CoolViewer",
      clearRule: "timed",
      endsAt: now + 600_000,
      status: "owed",
      sourceMissionId: "poll:1",
    })
    expect(
      consequenceFromFailure(
        { ...mission, outcome: "denied" },
        "key-abcdefgh",
        now
      )
    ).toBeNull()
  })
})

describe("owner commands", () => {
  it("marks any type paid, changes the type, or removes it", () => {
    for (const rule of [
      "timed",
      "at_next_stop",
      "through_next_mission",
      "manual",
    ] as const) {
      const record = owed(
        "a",
        rule,
        rule === "timed" ? { endsAt: now + 60_000 } : {}
      )
      expect(
        applyConsequenceCommand(record, { action: "pay" }, now)
      ).toMatchObject({
        status: "cleared",
        clearedReason: "paid",
        clearedAt: now,
      })
    }
    const changed = applyConsequenceCommand(
      owed("a", "manual"),
      { action: "change", clearRule: "timed", durationMinutes: 3 },
      now
    )
    expect(changed).toMatchObject({
      clearRule: "timed",
      durationMinutes: 3,
      endsAt: now + 180_000,
      status: "owed",
    })
    expect(
      applyConsequenceCommand(
        changed,
        { action: "change", clearRule: "at_next_stop", durationMinutes: 0 },
        now
      )
    ).not.toHaveProperty("endsAt")
    expect(
      applyConsequenceCommand(owed("a", "manual"), { action: "remove" }, now)
    ).toMatchObject({ status: "cleared", clearedReason: "removed" })
    expect(() =>
      applyConsequenceCommand(
        owed("a", "timed", { endsAt: now }),
        { action: "pay" },
        now
      )
    ).toThrow(ConsequenceError)
  })

  it("validates commands", () => {
    expect(
      parseConsequenceCommand({ consequenceId: "a", action: "pay" })
    ).toEqual({ consequenceId: "a", command: { action: "pay" } })
    expect(() =>
      parseConsequenceCommand({
        consequenceId: "a",
        action: "change",
        clearRule: "timed",
        durationMinutes: 0,
      })
    ).toThrow("invalid_consequence_duration")
    expect(() =>
      parseConsequenceCommand({
        consequenceId: "a",
        action: "change",
        clearRule: "x",
      })
    ).toThrow("invalid_clear_rule")
    expect(() => parseConsequenceCommand({ action: "pay" })).toThrow(
      "invalid_consequence_id"
    )
  })
})

describe("public projection", () => {
  const PUBLIC_KEYS = ["clearRule", "endsAt", "key", "setBy", "text"]

  it("exposes only allowlisted fields of owed consequences, oldest first", () => {
    const records = [
      owed("newer", "timed", {
        activatedAt: now + 5,
        endsAt: now + 60_000,
        durationMinutes: 1,
      }),
      owed("older", "manual", { activatedAt: now }),
      clearConsequence(owed("gone", "manual"), "paid", now),
    ]
    const projection = publicConsequences(records, now + 10)
    expect(projection.map((item) => item.text)).toEqual([
      "Penalty older",
      "Penalty newer",
    ])
    for (const item of projection) {
      for (const key of Object.keys(item)) expect(PUBLIC_KEYS).toContain(key)
    }
    const serialized = JSON.stringify(projection)
    for (const secret of [
      "consequenceId",
      "sourceMissionId",
      "source-",
      "activatedAt",
      "status",
      "durationMinutes",
      "updatedAt",
    ]) {
      expect(serialized).not.toContain(secret)
    }
  })

  it("re-validates stored data and drops anything extra or malformed", () => {
    const parsed = parsePublicConsequences(
      {
        items: [
          {
            key: "key-safe-0001",
            text: "Eat a lemon",
            setBy: "Viewer",
            clearRule: "manual",
            sourceMissionId: "poll:secret",
            consequenceId: "mission:poll:secret",
            rawText: "private request",
          },
          {
            key: "key-safe-0002",
            text: "Expired",
            setBy: "V",
            clearRule: "timed",
            endsAt: now,
          },
          { key: "bad key!", text: "x", setBy: "V", clearRule: "manual" },
          { key: "key-safe-0003", text: "x", setBy: "V", clearRule: "nope" },
        ],
      },
      now
    )
    expect(parsed).toEqual([
      {
        key: "key-safe-0001",
        text: "Eat a lemon",
        setBy: "Viewer",
        clearRule: "manual",
      },
    ])
    expect(parsePublicConsequences(undefined, now)).toEqual([])
  })
})

describe("overlay strip pages", () => {
  const item = (key: string) => ({
    key: `key-${key}-0000`,
    text: key,
    setBy: "V",
    clearRule: "manual" as const,
  })
  const shown = (state: StripState) =>
    stripPage(state).map((entry) => entry.item.text)

  it("shows two at a time, rotates, and gives an odd count a single page", () => {
    let state = stripReducer(EMPTY_STRIP, {
      type: "sync",
      items: ["a", "b", "c"].map(item),
      now,
    })
    expect(shown(state)).toEqual(["a", "b"])
    state = stripReducer(state, { type: "rotate" })
    expect(shown(state)).toEqual(["c"])
    state = stripReducer(state, { type: "rotate" })
    expect(shown(state)).toEqual(["a", "b"])
  })

  it("lands a new consequence on the first page, then settles oldest first", () => {
    let state = stripReducer(EMPTY_STRIP, {
      type: "sync",
      items: ["a", "b", "c"].map(item),
      now,
    })
    state = stripReducer(state, { type: "rotate" })
    state = stripReducer(state, {
      type: "sync",
      items: ["a", "b", "c", "d"].map(item),
      now,
    })
    expect(state.page).toBe(0)
    expect(shown(state)).toEqual(["d", "a"])
    state = stripReducer(state, { type: "rotate" })
    expect(shown(state)).toEqual(["c", "d"])
  })

  it("stamps a cleared box in place, then reflows", () => {
    let state = stripReducer(EMPTY_STRIP, {
      type: "sync",
      items: ["a", "b", "c"].map(item),
      now,
    })
    state = stripReducer(state, {
      type: "sync",
      items: ["b", "c"].map(item),
      now: now + 1000,
    })
    expect(shown(state)).toEqual(["a", "b"])
    expect(stripPage(state)[0]!.clearedAt).toBe(now + 1000)
    state = stripReducer(state, {
      type: "tick",
      now: now + 1000 + STRIP_STAMP_MS,
    })
    expect(shown(state)).toEqual(["b", "c"])
  })

  it("clears a timed box at its server end time with no server push", () => {
    let state = stripReducer(EMPTY_STRIP, {
      type: "sync",
      items: [{ ...item("t"), clearRule: "timed", endsAt: now + 5000 }],
      now,
    })
    state = stripReducer(state, { type: "tick", now: now + 5000 })
    expect(stripPage(state)[0]!.clearedAt).toBe(now + 5000)
  })
})
