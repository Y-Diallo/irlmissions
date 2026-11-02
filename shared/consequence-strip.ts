import type { PublicConsequence } from "@/shared/consequences"

export const STRIP_PAGE_SIZE = 2
/** How long a cleared box keeps its stamp before the pages reflow. */
export const STRIP_STAMP_MS = 2_000

export type StripEntry = {
  item: PublicConsequence
  /** Just arrived: shown on the first page until chat has seen it. */
  landing: boolean
  clearedAt?: number
}

export type StripState = {
  entries: StripEntry[]
  page: number
  /** Server order (oldest first) from the last sync. */
  order: string[]
  initialized: boolean
}

export type StripAction =
  | { type: "sync"; items: PublicConsequence[]; now: number }
  | { type: "tick"; now: number }
  | { type: "rotate" }

export const EMPTY_STRIP: StripState = {
  entries: [],
  page: 0,
  order: [],
  initialized: false,
}

export function stripPageCount(state: StripState) {
  return Math.ceil(state.entries.length / STRIP_PAGE_SIZE)
}

export function stripPage(state: StripState) {
  const start = state.page * STRIP_PAGE_SIZE
  return state.entries.slice(start, start + STRIP_PAGE_SIZE)
}

function live(items: PublicConsequence[], now: number) {
  return items.filter((item) => item.endsAt === undefined || item.endsAt > now)
}

function clampPage(entries: StripEntry[], page: number) {
  return page < Math.ceil(entries.length / STRIP_PAGE_SIZE) ? page : 0
}

// Drop stamps that have been shown long enough; the pages reflow.
function withoutOldStamps(state: StripState, now: number): StripState {
  const entries = state.entries.filter(
    (entry) =>
      entry.clearedAt === undefined || now - entry.clearedAt < STRIP_STAMP_MS
  )
  return entries.length === state.entries.length
    ? state
    : { ...state, entries, page: clampPage(entries, state.page) }
}

// A box that leaves while on screen keeps its place with a stamp; one on
// another page just goes. Timers count down on the server's clock.
function sync(
  state: StripState,
  items: PublicConsequence[],
  now: number
): StripState {
  const current = live(items, now)
  const byKey = new Map(current.map((item) => [item.key, item]))
  const onScreen = new Set(stripPage(state).map((entry) => entry.item.key))
  const known = new Set(state.entries.map((entry) => entry.item.key))

  let entries = state.entries.flatMap((entry): StripEntry[] => {
    if (entry.clearedAt !== undefined) return [entry]
    const next = byKey.get(entry.item.key)
    if (next) return [{ ...entry, item: next }]
    return onScreen.has(entry.item.key) ? [{ ...entry, clearedAt: now }] : []
  })
  const fresh = current.filter((item) => !known.has(item.key))
  let page = state.page
  if (!state.initialized) {
    entries = [...entries, ...fresh.map((item) => ({ item, landing: false }))]
  } else if (fresh.length) {
    // A new consequence jumps to the first page so chat sees it land.
    entries = [...fresh.map((item) => ({ item, landing: true })), ...entries]
    page = 0
  }
  return withoutOldStamps(
    {
      entries,
      page: clampPage(entries, page),
      order: current.map((item) => item.key),
      initialized: true,
    },
    now
  )
}

function rotate(state: StripState): StripState {
  let entries = state.entries
  // Once the first page has had its turn, landed boxes settle oldest first.
  if (state.page === 0 && entries.some((entry) => entry.landing)) {
    const index = new Map(state.order.map((key, position) => [key, position]))
    entries = entries
      .map((entry) => ({ ...entry, landing: false }))
      .sort(
        (a, b) =>
          (index.get(a.item.key) ?? Infinity) -
          (index.get(b.item.key) ?? Infinity)
      )
  }
  const pages = Math.ceil(entries.length / STRIP_PAGE_SIZE)
  return { ...state, entries, page: pages > 1 ? (state.page + 1) % pages : 0 }
}

export function stripReducer(
  state: StripState,
  action: StripAction
): StripState {
  if (action.type === "sync") return sync(state, action.items, action.now)
  if (action.type === "rotate") return rotate(state)
  // A timer reaching zero clears its box just like a server clear.
  const expired = state.entries.some(
    (entry) =>
      entry.clearedAt === undefined &&
      entry.item.endsAt !== undefined &&
      entry.item.endsAt <= action.now
  )
  if (!expired) return withoutOldStamps(state, action.now)
  const synced = sync(
    state,
    state.entries
      .filter((entry) => entry.clearedAt === undefined)
      .map((entry) => entry.item),
    action.now
  )
  // Keep the server's oldest-first order, not the on-screen one.
  return { ...synced, order: state.order }
}
