import "server-only"
import { FieldValue, type Firestore } from "firebase-admin/firestore"
import {
  automationEnabled,
  automationThresholdMet,
  canAutoApprove,
  eligibleAfterVeto,
  nextPollAt,
  parseAutomationSettings,
  placeOpen,
  selectShortlist,
  type AutomationSettings,
  type AutomationStatus,
  type ShortlistPitch,
} from "@/shared/automation"
import { eventSubStorageId } from "@/shared/eventsub"
import type { MissionRecord } from "@/shared/missions"
import { distanceMeters, type PlaceCandidate } from "@/shared/pitches/processor"
import {
  autoApprovePitch,
  dropPitch,
  PitchReviewError,
  toPitchReviewItem,
  type ReviewRecord,
  type ReviewUpdate,
} from "@/shared/pitches/review"
import {
  PollError,
  type PollRecord,
  type StartPollCommand,
} from "@/shared/polls"
import { tenantDoc } from "@/shared/tenant"

export type AutomationDependencies = {
  isTrusted(viewerId: string): Promise<boolean>
  placeStatus(
    placeId: string
  ): Promise<Pick<PlaceCandidate, "businessStatus" | "openNow">>
  startPoll(command: StartPollCommand): Promise<PollRecord>
}

const POLL_BUSY = ["creating", "create_unknown", "active", "tie"]
// A place recheck stays good for a minute, so waiting below the threshold
// doesn't call Google on every heartbeat.
const PLACE_CHECK_MS = 60_000

function applyUpdate(update: ReviewUpdate) {
  return {
    ...update.values,
    ...Object.fromEntries(
      update.deleteFields.map((field) => [field, FieldValue.delete()])
    ),
  }
}

/**
 * One automation step for a tenant, driven by the open producer console.
 * Every timing decision uses stored timestamps, so a refresh or a second
 * console never restarts a veto window or the post-mission delay.
 */
export async function runAutomation(
  db: Firestore,
  tenantId: string,
  deps: AutomationDependencies,
  now: number
): Promise<AutomationStatus> {
  const pitchesRef = db.collection(tenantDoc(tenantId, "pitches"))
  const pitchRef = (redemptionId: string) =>
    db.doc(tenantDoc(tenantId, `pitches/${eventSubStorageId(redemptionId)}`))
  const [settingsSnapshot, sessionSnapshot] = await Promise.all([
    db.doc(tenantDoc(tenantId, "settings/current")).get(),
    db.doc(tenantDoc(tenantId, "sessions/current")).get(),
  ])
  const settingsData = settingsSnapshot.data()
  const settings = parseAutomationSettings(settingsData?.automation)
  if (!automationEnabled(settings)) return { state: "off" }
  if (settingsData?.automationPaused === true) return { state: "paused" }

  if (settings.autoApproval) {
    await autoApprove(settings)
  }
  if (!settings.autoStartPoll) return { state: "off" }

  const session = sessionSnapshot.data()
  const mission = session?.mission as MissionRecord | undefined
  const poll = session?.poll as PollRecord | undefined
  if (mission && ["heading", "arrived"].includes(mission.status)) {
    return { state: "busy" }
  }
  if (poll && POLL_BUSY.includes(poll.status)) return { state: "busy" }

  const lastOutcomeAt = Math.max(
    mission?.outcomeAt ?? 0,
    poll?.endedAt ?? (poll ? poll.updatedAt : 0)
  )
  const startsAt = nextPollAt(lastOutcomeAt || null, settings)
  if (now < startsAt) return { state: "cooldown", startsAt }

  const needed = Math.max(2, settings.minimumEligiblePitches)
  let eligible = await eligiblePitches()
  if (!automationThresholdMet(eligible.length, settings)) {
    return { state: "waiting", eligible: eligible.length, needed }
  }
  eligible = await recheckPlaces(eligible, settingsData)
  if (!automationThresholdMet(eligible.length, settings)) {
    return { state: "waiting", eligible: eligible.length, needed }
  }
  const shortlist = selectShortlist(eligible.map(shortlistPitch), settings, now)
  if (shortlist.length < 2) {
    return { state: "waiting", eligible: shortlist.length, needed }
  }
  try {
    const started = await deps.startPoll({
      redemptionIds: shortlist.map((pitch) => pitch.redemptionId),
      durationSeconds: settings.pollDurationSeconds,
    })
    return { state: "started", pollAttemptId: started.attemptId }
  } catch (error) {
    if (error instanceof PollError) {
      if (["poll_in_progress", "mission_in_progress"].includes(error.code)) {
        return { state: "busy" }
      }
      return { state: "error", code: error.code }
    }
    throw error
  }

  async function autoApprove(settings: AutomationSettings) {
    const snapshot = await pitchesRef
      .where("reviewStatus", "==", "pending_review")
      .limit(25)
      .get()
    for (const document of snapshot.docs) {
      const record = document.data() as ReviewRecord
      if (record.hiddenAt || record.lockedBy) continue
      const candidate = approvalCandidate(record)
      // Look the viewer up only when trust is the last thing missing.
      if (
        settings.trustedViewersOnly &&
        candidate.viewerTrusted === null &&
        record.viewer?.id &&
        canAutoApprove({ ...candidate, viewerTrusted: true }, settings, false)
      ) {
        try {
          candidate.viewerTrusted = await deps.isTrusted(record.viewer.id)
        } catch {
          continue
        }
        await document.ref.update({ viewerTrusted: candidate.viewerTrusted })
      }
      if (!canAutoApprove(candidate, settings, false)) continue
      await db
        .runTransaction(async (tx) => {
          const fresh = await tx.get(document.ref)
          const current = {
            ...(fresh.data() as ReviewRecord),
            viewerTrusted: candidate.viewerTrusted ?? undefined,
          }
          // Recheck on fresh data: a flag or edit since the query wins.
          if (
            !fresh.exists ||
            current.hiddenAt ||
            !canAutoApprove(approvalCandidate(current), settings, false)
          ) {
            return
          }
          tx.update(
            document.ref,
            applyUpdate(autoApprovePitch(current, now, settings.vetoSeconds))
          )
        })
        .catch((error) => {
          // e.g. a label that reveals the address: leave it for the owner.
          if (!(error instanceof PitchReviewError)) throw error
        })
    }
  }

  async function eligiblePitches() {
    const snapshot = await pitchesRef
      .where("reviewStatus", "==", "approved")
      .limit(50)
      .get()
    return snapshot.docs
      .map((document) => document.data() as ReviewRecord)
      .filter(
        (record) =>
          !record.hiddenAt && !record.lockedBy && eligibleAfterVeto(record, now)
      )
  }

  async function recheckPlaces(
    pitches: ReviewRecord[],
    settingsData: FirebaseFirestore.DocumentData | undefined
  ) {
    if (settingsData?.noTravelMode === true) return pitches
    const location = (
      await db.doc(tenantDoc(tenantId, "privateState/location")).get()
    ).data()
    const radius = settingsData?.searchRadiusMeters
    const kept: ReviewRecord[] = []
    for (const record of pitches) {
      const item = toPitchReviewItem(record)
      if (item.anywhere) {
        kept.push(record)
        continue
      }
      const destination = record.destination
      if (!destination || !location || typeof radius !== "number") continue
      if (distanceMeters(location as PlaceCandidate, destination) > radius) {
        await drop(record, "out_of_range")
        continue
      }
      const checkedAt = (record as { placeCheckedAt?: number }).placeCheckedAt
      if (checkedAt === undefined || now - checkedAt > PLACE_CHECK_MS) {
        let status
        try {
          status = await deps.placeStatus(destination.placeId)
        } catch {
          // Unknown right now: leave it out of this poll but keep it queued.
          continue
        }
        if (!placeOpen(status)) {
          await drop(record, "place_closed")
          continue
        }
        await pitchRef(record.redemptionId).update({
          placeCheckedAt: now,
          "destination.businessStatus": status.businessStatus,
          ...(status.openNow === undefined
            ? {}
            : { "destination.openNow": status.openNow }),
        })
      }
      kept.push(record)
    }
    return kept
  }

  function drop(record: ReviewRecord, reason: string) {
    return db.runTransaction(async (tx) => {
      const ref = pitchRef(record.redemptionId)
      const fresh = await tx.get(ref)
      const current = fresh.data() as ReviewRecord | undefined
      if (!current || current.reviewStatus !== "approved" || current.lockedBy) {
        return
      }
      tx.update(ref, applyUpdate(dropPitch(current, reason, now)))
    })
  }
}

function approvalCandidate(record: ReviewRecord) {
  const item = toPitchReviewItem(record)
  return {
    reviewStatus: item.reviewStatus,
    riskFlags: item.riskFlags,
    processingWarnings: item.processingWarnings,
    anywhere: item.anywhere,
    destination: item.destination,
    viewerTrusted:
      typeof record.viewerTrusted === "boolean" ? record.viewerTrusted : null,
  }
}

function shortlistPitch(record: ReviewRecord): ShortlistPitch {
  const item = toPitchReviewItem(record)
  return {
    redemptionId: record.redemptionId,
    publicLabel: item.publicLabel,
    createdAt: record.createdAt,
    funScore: record.extraction?.funScore ?? 50,
    distanceMeters: item.anywhere
      ? 0
      : (record.walkingRoute?.distanceMeters ??
        record.straightLineMeters ??
        Number.MAX_SAFE_INTEGER),
    ...(record.vetoUntil === undefined ? {} : { vetoUntil: record.vetoUntil }),
  }
}
