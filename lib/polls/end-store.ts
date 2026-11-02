import "server-only"
import {
  FieldValue,
  type DocumentSnapshot,
  type Firestore,
  type Transaction,
} from "firebase-admin/firestore"
import {
  dropsAfterLoss,
  parseAutomationSettings,
  type AutomationSettings,
} from "@/shared/automation"
import { eventSubStorageId, type PendingPollEnd } from "@/shared/eventsub"
import {
  readOwedConsequences,
  settleConsequences,
} from "@/lib/consequences/store"
import type { ConsequenceRecord } from "@/shared/consequences"
import {
  createMissionFromWinner,
  MissionError,
  type MissionRecord,
} from "@/shared/missions"
import { idleOverlay, missionOverlay, votingOverlay } from "@/shared/overlay"
import { dropPitch, type ReviewRecord } from "@/shared/pitches/review"
import {
  attachTwitchPoll,
  matchesPollAttempt,
  PollError,
  resolvePollEnd,
  resolveTie,
  type PollEnd,
  type PollRecord,
  type PollResolution,
  type TwitchPoll,
} from "@/shared/polls"
import { tenantDoc } from "@/shared/tenant"

function currentPoll(data: FirebaseFirestore.DocumentData | undefined) {
  const poll = data?.poll
  return poll && typeof poll === "object" ? (poll as PollRecord) : null
}

function eventFrom(data: PendingPollEnd): PollEnd {
  return {
    pollId: data.pollId,
    status: data.status,
    endedAt: Date.parse(data.endedAt),
    choices: data.choices,
  }
}

function twitchPollFromEvent(
  record: PollRecord,
  event: PendingPollEnd
): TwitchPoll {
  return {
    id: event.pollId,
    broadcasterId: event.broadcasterId,
    title: event.title,
    status: event.status.toUpperCase(),
    durationSeconds: record.durationSeconds,
    startedAt: Date.parse(event.startedAt),
    endedAt: Date.parse(event.endedAt),
    choices: event.choices,
  }
}

export function createPollEndStore(db: Firestore, tenantId: string) {
  const sessionRef = db.doc(tenantDoc(tenantId, "sessions/current"))
  const publicStateRef = db.doc(tenantDoc(tenantId, "publicState/current"))
  const settingsRef = db.doc(tenantDoc(tenantId, "settings/current"))
  return {
    async findPending(limit = 5) {
      const snapshot = await db
        .collection(tenantDoc(tenantId, "pollEvents"))
        .where("processing.status", "==", "pending")
        .limit(Math.max(0, Math.min(limit, 5)))
        .get()
      return snapshot.docs.flatMap((document) => {
        const pollId = document.data().pollId
        return typeof pollId === "string" ? [pollId] : []
      })
    },

    apply(pollId: string, now: number) {
      return db.runTransaction(async (tx) => {
        const eventRef = db.doc(
          tenantDoc(tenantId, `pollEvents/${eventSubStorageId(pollId)}`)
        )
        const [eventSnapshot, sessionSnapshot, settingsSnapshot] =
          await Promise.all([
            tx.get(eventRef),
            tx.get(sessionRef),
            tx.get(settingsRef),
          ])
        const noTravelMode = settingsSnapshot.data()?.noTravelMode === true
        const automation = parseAutomationSettings(
          settingsSnapshot.data()?.automation
        )
        if (!eventSnapshot.exists) return "ignored" as const
        const event = eventSnapshot.data() as PendingPollEnd
        if (event.processing?.status !== "pending") return "ignored" as const
        let poll = currentPoll(sessionSnapshot.data())
        if (poll && ["creating", "create_unknown"].includes(poll.status)) {
          const candidate = twitchPollFromEvent(poll, event)
          if (matchesPollAttempt(poll, candidate)) {
            poll = attachTwitchPoll(poll, candidate, now)
          }
        }
        if (
          !poll ||
          poll.status !== "active" ||
          poll.twitchPollId !== event.pollId
        ) {
          tx.update(eventRef, {
            processing: {
              status: "complete",
              result: "ignored",
              completedAt: now,
            },
            updatedAt: now,
          })
          return "ignored" as const
        }

        const pitchSnapshots = await readPitches(tx, poll)
        const owed = await readOwedConsequences(tx, db, tenantId)

        let resolution
        try {
          resolution = resolvePollEnd(poll, eventFrom(event), now)
        } catch (error) {
          if (!(error instanceof PollError)) throw error
          tx.update(eventRef, {
            processing: {
              status: "error",
              errorCode: error.code,
              failedAt: now,
            },
            updatedAt: now,
          })
          return "error" as const
        }

        let mission: MissionRecord | null = null
        try {
          mission = winningMission(
            resolution,
            pitchSnapshots,
            noTravelMode,
            now
          )
        } catch (error) {
          if (!(error instanceof MissionError)) throw error
          tx.update(eventRef, {
            processing: {
              status: "error",
              errorCode: error.code,
              failedAt: now,
            },
            updatedAt: now,
          })
          return "error" as const
        }

        writeResolution(
          tx,
          poll.lockId,
          resolution,
          mission,
          pitchSnapshots,
          automation,
          owed,
          now
        )
        const outcome = resolution.winnerRedemptionId
          ? ("winner" as const)
          : resolution.tiedRedemptionIds.length
            ? ("tie" as const)
            : ("no_winner" as const)
        tx.update(eventRef, {
          processing: {
            status: "complete",
            result: outcome,
            completedAt: now,
          },
          updatedAt: now,
        })
        return outcome
      })
    },

    // Records the result Twitch returned when the owner ended (or resynced)
    // the poll. The matching EventSub poll.end later dedupes against this
    // document. The caller only gets here while the session poll is still
    // active, so an earlier event that errored or was skipped never took
    // effect and is safe to replace with Twitch's current result.
    recordEarlyEnd(event: PendingPollEnd) {
      return db.runTransaction(async (tx) => {
        const eventRef = db.doc(
          tenantDoc(tenantId, `pollEvents/${eventSubStorageId(event.pollId)}`)
        )
        const existing = await tx.get(eventRef)
        if (!existing.exists) tx.create(eventRef, event)
        else if (existing.data()?.processing?.status !== "pending") {
          tx.set(eventRef, event)
        }
      })
    },

    // The owner breaks a tie by picking one of the tied choices.
    chooseTieWinner(redemptionId: string, now: number) {
      return db.runTransaction(async (tx) => {
        const [session, settings] = await Promise.all([
          tx.get(sessionRef),
          tx.get(settingsRef),
        ])
        const poll = currentPoll(session.data())
        if (!poll) throw new PollError("poll_not_tied")
        const resolution = resolveTie(poll, redemptionId, now)
        const pitchSnapshots = await readPitches(tx, poll)
        const owed = await readOwedConsequences(tx, db, tenantId)
        const mission = winningMission(
          resolution,
          pitchSnapshots,
          settings.data()?.noTravelMode === true,
          now
        )
        writeResolution(
          tx,
          poll.lockId,
          resolution,
          mission,
          pitchSnapshots,
          parseAutomationSettings(settings.data()?.automation),
          owed,
          now
        )
        return { poll: resolution.poll, mission }
      })
    },
  }

  async function readPitches(tx: Transaction, poll: PollRecord) {
    const snapshots = []
    for (const choice of poll.choices) {
      snapshots.push(
        await tx.get(
          db.doc(
            tenantDoc(
              tenantId,
              `pitches/${eventSubStorageId(choice.redemptionId)}`
            )
          )
        )
      )
    }
    return snapshots
  }

  function winningMission(
    resolution: PollResolution,
    pitchSnapshots: DocumentSnapshot[],
    noTravelMode: boolean,
    now: number
  ) {
    if (!resolution.winnerRedemptionId) return null
    const winner = pitchSnapshots.find(
      (snapshot) =>
        snapshot.data()?.redemptionId === resolution.winnerRedemptionId
    )
    if (!winner?.exists) throw new MissionError("winner_not_found", 500)
    const pitch = winner.data()!
    return createMissionFromWinner(
      resolution.poll,
      noTravelMode ? { ...pitch, noTravel: true } : pitch,
      now
    )
  }

  function writeResolution(
    tx: Transaction,
    lockId: string,
    resolution: PollResolution,
    mission: MissionRecord | null,
    pitchSnapshots: DocumentSnapshot[],
    automation: AutomationSettings,
    owed: ConsequenceRecord[],
    now: number
  ) {
    // A poll nobody voted in isn't a loss for anyone.
    const contested =
      !!resolution.winnerRedemptionId || resolution.tiedRedemptionIds.length > 0
    tx.set(
      sessionRef,
      { poll: resolution.poll, ...(mission ? { mission } : {}) },
      // Whole fields: a deep merge would carry the last mission's leftovers
      // (arrival, reveal, timer) into this one.
      { mergeFields: mission ? ["poll", "mission"] : ["poll"] }
    )
    tx.set(
      publicStateRef,
      mission
        ? missionOverlay(mission)
        : resolution.poll.status === "tie"
          ? votingOverlay(resolution.poll)
          : idleOverlay(now)
    )
    if (mission) {
      // An anywhere mission starts arrived: that's the next stop.
      settleConsequences(
        tx,
        db,
        tenantId,
        owed,
        {
          event: { type: mission.status === "arrived" ? "arrived" : "sweep" },
        },
        now
      )
    }
    for (const snapshot of pitchSnapshots) {
      const redemptionId = snapshot.data()?.redemptionId
      if (!snapshot.exists || snapshot.data()?.lockedBy !== lockId) continue
      if (redemptionId === resolution.winnerRedemptionId) {
        tx.update(snapshot.ref, {
          lockedBy: mission!.lockId,
          reviewStatus: "active_mission",
          missionId: mission!.missionId,
          pollWonAt: now,
          updatedAt: now,
        })
      } else if (!resolution.tiedRedemptionIds.includes(redemptionId)) {
        const record = snapshot.data() as ReviewRecord
        const losses = record.pollLosses ?? 0
        // Pitches that keep losing drop out and are refunded so the
        // automatic queue doesn't go stale.
        const drop =
          contested &&
          record.reviewStatus === "approved" &&
          dropsAfterLoss(losses, automation)
        const dropped = drop
          ? dropPitch({ ...record, lockedBy: undefined }, "lost_polls", now)
          : null
        tx.update(snapshot.ref, {
          ...(dropped?.values ?? {}),
          ...Object.fromEntries(
            (dropped?.deleteFields ?? []).map((field) => [
              field,
              FieldValue.delete(),
            ])
          ),
          ...(contested ? { pollLosses: losses + 1 } : {}),
          lockedBy: FieldValue.delete(),
          updatedAt: now,
        })
      }
    }
  }
}

export async function processPendingPollEnds(
  db: Firestore,
  tenantId: string,
  limit = 5,
  now = Date.now()
) {
  const store = createPollEndStore(db, tenantId)
  const ids = await store.findPending(limit)
  const results = []
  for (const id of ids) results.push(await store.apply(id, now))
  return {
    scanned: ids.length,
    winners: results.filter((result) => result === "winner").length,
    noWinner: results.filter((result) => result === "no_winner").length,
    ties: results.filter((result) => result === "tie").length,
    ignored: results.filter((result) => result === "ignored").length,
    errors: results.filter((result) => result === "error").length,
  }
}
