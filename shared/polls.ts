export const DEFAULT_POLL_TITLE = "What should we do next?"
export const DEFAULT_POLL_DURATION_SECONDS = 120
export const MIN_POLL_CHOICES = 2
export const MAX_POLL_CHOICES = 5
export const MAX_POLL_CHOICE_LENGTH = 25

// Viewer-facing text (Twitch polls, OBS overlay) never shows em or en dashes.
export function withoutDashes(text: string) {
  return text
    .replace(/\s*—\s*/g, ", ")
    .replace(/–/g, "-")
    .trim()
}

export type StartPollCommand = {
  redemptionIds: string[]
  durationSeconds: number
}

export type PollPitch = {
  redemptionId: string
  reviewStatus: string
  publicLabel?: string
  lockedBy?: string
}

export type PollChoice = {
  redemptionId: string
  title: string
  twitchChoiceId?: string
  votes?: number
}

export type PollStatus =
  | "creating"
  | "create_unknown"
  | "active"
  | "tie"
  | "completed"
  | "canceled"
  | "error"

export type PollRecord = {
  attemptId: string
  lockId: string
  status: PollStatus
  title: string
  durationSeconds: number
  choices: PollChoice[]
  requestedAt: number
  updatedAt: number
  twitchPollId?: string
  startedAt?: number
  endedAt?: number
  errorCode?: string
  winnerRedemptionId?: string
  tiedRedemptionIds?: string[]
}

export type TwitchPoll = {
  id: string
  broadcasterId: string
  title: string
  status: string
  durationSeconds: number
  startedAt: number
  endedAt?: number
  choices: Array<{ id: string; title: string; votes: number }>
}

export type PollProvider = {
  create(input: {
    title: string
    choices: string[]
    durationSeconds: number
  }): Promise<TwitchPoll>
  listRecent(): Promise<TwitchPoll[]>
  /** Ends a live poll early with results shown (TERMINATED). */
  end(pollId: string): Promise<TwitchPoll>
}

export type PollEnd = {
  pollId: string
  status: "completed" | "terminated" | "archived" | "moderated" | "invalid"
  endedAt: number
  choices: Array<{ id: string; title: string; votes: number }>
}

export type PollResolution = {
  poll: PollRecord
  winnerRedemptionId: string | null
  tiedRedemptionIds: string[]
  loserRedemptionIds: string[]
}

// Indexes of every choice sharing the highest vote count; none until a vote.
export function leadingIndexes(votes: number[]) {
  const highest = Math.max(0, ...votes)
  if (highest === 0) return []
  return votes.flatMap((count, index) => (count === highest ? [index] : []))
}

export class PollError extends Error {
  constructor(
    public readonly code: string,
    public readonly status = 409
  ) {
    super(code)
  }
}

export class PollProviderError extends Error {
  constructor(
    public readonly code: string,
    public readonly ambiguous: boolean,
    public readonly status = 503
  ) {
    super(code)
  }
}

function cleanId(value: unknown) {
  if (typeof value !== "string") throw new PollError("invalid_pitch_ids", 400)
  const result = value.trim()
  if (!result || result.length > 512 || result.includes("/")) {
    throw new PollError("invalid_pitch_ids", 400)
  }
  return result
}

export function parseStartPollCommand(value: unknown): StartPollCommand {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new PollError("invalid_poll", 400)
  }
  const input = value as Record<string, unknown>
  if (!Array.isArray(input.redemptionIds)) {
    throw new PollError("invalid_pitch_ids", 400)
  }
  const redemptionIds = input.redemptionIds.map(cleanId)
  if (
    redemptionIds.length < MIN_POLL_CHOICES ||
    redemptionIds.length > MAX_POLL_CHOICES ||
    new Set(redemptionIds).size !== redemptionIds.length
  ) {
    throw new PollError("invalid_pitch_ids", 400)
  }
  const durationSeconds =
    input.durationSeconds === undefined
      ? DEFAULT_POLL_DURATION_SECONDS
      : input.durationSeconds
  if (
    !Number.isInteger(durationSeconds) ||
    (durationSeconds as number) < 15 ||
    (durationSeconds as number) > 1800
  ) {
    throw new PollError("invalid_poll_duration", 400)
  }
  return { redemptionIds, durationSeconds: durationSeconds as number }
}

export function preparePollRecord(
  pitches: PollPitch[],
  command: StartPollCommand,
  attemptId: string,
  now: number
): PollRecord {
  if (pitches.length !== command.redemptionIds.length) {
    throw new PollError("pitch_not_found", 404)
  }
  const byId = new Map(pitches.map((pitch) => [pitch.redemptionId, pitch]))
  const choices = command.redemptionIds.map((redemptionId) => {
    const pitch = byId.get(redemptionId)
    if (!pitch) throw new PollError("pitch_not_found", 404)
    if (pitch.reviewStatus !== "approved") {
      throw new PollError("pitch_not_approved")
    }
    if (pitch.lockedBy) throw new PollError("pitch_locked")
    const title = pitch.publicLabel && withoutDashes(pitch.publicLabel)
    if (!title || title.length > MAX_POLL_CHOICE_LENGTH) {
      throw new PollError("invalid_poll_label", 400)
    }
    return { redemptionId, title }
  })
  const normalized = choices.map((choice) => choice.title.toLocaleLowerCase())
  if (new Set(normalized).size !== normalized.length) {
    throw new PollError("duplicate_poll_labels", 400)
  }
  return {
    attemptId,
    lockId: `poll:${attemptId}`,
    status: "creating",
    title: DEFAULT_POLL_TITLE,
    durationSeconds: command.durationSeconds,
    choices,
    requestedAt: now,
    updatedAt: now,
  }
}

export function matchesPollAttempt(record: PollRecord, poll: TwitchPoll) {
  return (
    poll.title === record.title &&
    poll.durationSeconds === record.durationSeconds &&
    poll.startedAt >= record.requestedAt - 5000 &&
    poll.choices.length === record.choices.length &&
    poll.choices.every(
      (choice, index) => choice.title === record.choices[index]?.title
    )
  )
}

export function attachTwitchPoll(
  record: PollRecord,
  poll: TwitchPoll,
  now: number
): PollRecord {
  if (!matchesPollAttempt(record, poll)) {
    throw new PollError("poll_response_mismatch", 503)
  }
  const { errorCode: _errorCode, ...withoutError } = record
  return {
    ...withoutError,
    status: "active",
    twitchPollId: poll.id,
    startedAt: poll.startedAt,
    updatedAt: now,
    choices: record.choices.map((choice, index) => ({
      ...choice,
      twitchChoiceId: poll.choices[index]!.id,
      votes: poll.choices[index]!.votes,
    })),
  }
}

export function resolvePollEnd(
  record: PollRecord,
  event: PollEnd,
  now: number
): PollResolution {
  if (record.status !== "active" || record.twitchPollId !== event.pollId) {
    throw new PollError("poll_event_stale")
  }
  if (
    event.choices.length !== record.choices.length ||
    event.choices.some(
      (choice, index) =>
        choice.id !== record.choices[index]?.twitchChoiceId ||
        choice.title !== record.choices[index]?.title
    )
  ) {
    throw new PollError("poll_event_mismatch", 400)
  }
  // TERMINATED means the owner ended it early with results shown; it counts.
  const leaders =
    event.status === "completed" || event.status === "terminated"
      ? leadingIndexes(event.choices.map((choice) => choice.votes)).map(
          (index) => record.choices[index]!.redemptionId
        )
      : []
  // A tie waits for the owner to pick; the tied pitches stay locked.
  const winnerRedemptionId = leaders.length === 1 ? leaders[0]! : null
  const tiedRedemptionIds = leaders.length > 1 ? leaders : []
  const choices = record.choices.map((choice, index) => ({
    ...choice,
    votes: event.choices[index]!.votes,
  }))
  return {
    poll: {
      ...record,
      status: winnerRedemptionId
        ? "completed"
        : tiedRedemptionIds.length
          ? "tie"
          : "canceled",
      choices,
      endedAt: event.endedAt,
      updatedAt: now,
      ...(winnerRedemptionId
        ? { winnerRedemptionId }
        : tiedRedemptionIds.length
          ? { tiedRedemptionIds }
          : { errorCode: "poll_no_winner" }),
    },
    winnerRedemptionId,
    tiedRedemptionIds,
    loserRedemptionIds: record.choices
      .map((choice) => choice.redemptionId)
      .filter(
        (redemptionId) =>
          redemptionId !== winnerRedemptionId &&
          !tiedRedemptionIds.includes(redemptionId)
      ),
  }
}

export function resolveTie(
  record: PollRecord,
  redemptionId: string,
  now: number
): PollResolution {
  if (record.status !== "tie" || !record.tiedRedemptionIds) {
    throw new PollError("poll_not_tied")
  }
  if (!record.tiedRedemptionIds.includes(redemptionId)) {
    throw new PollError("not_a_tied_choice", 400)
  }
  const { tiedRedemptionIds: _tied, ...rest } = record
  return {
    poll: {
      ...rest,
      status: "completed",
      winnerRedemptionId: redemptionId,
      updatedAt: now,
    },
    winnerRedemptionId: redemptionId,
    tiedRedemptionIds: [],
    loserRedemptionIds: record.tiedRedemptionIds.filter(
      (candidate) => candidate !== redemptionId
    ),
  }
}
