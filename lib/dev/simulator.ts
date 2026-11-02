import "server-only"

import { randomUUID } from "node:crypto"
import { FieldValue, type Firestore } from "firebase-admin/firestore"
import { eventSubStorageId, type PendingPitch } from "@/shared/eventsub"
import {
  DEMO_START,
  DEV_PITCH_PRESETS,
  DevError,
  type DemoPresetKey,
  type DevAction,
} from "@/shared/dev"
import { automationPreset } from "@/shared/automation"
import type { MissionRecord } from "@/shared/missions"
import { tallyOverlay } from "@/shared/overlay"
import type { PollRecord } from "@/shared/polls"
import { tenantDoc } from "@/shared/tenant"
import { runPitchNow } from "@/lib/pitches/runner"
import { createPollEndStore } from "@/lib/polls/end-store"
import { createOverlayAccessStore } from "@/lib/overlay/access-store"
import { createRealtimeIrlStore } from "@/lib/realtimeirl/store"

const DEMO_LOCATION = DEMO_START
const DEMO_SETTINGS = {
  searchRadiusMeters: 5000,
  defaultDurationMinutes: 10,
  travelMode: "walk",
  llmEnabled: true,
  locationMaxAgeMs: 120_000,
  arrivalLocationMaxAgeMs: 30_000,
  arrivalRadiusMeters: 50,
  arrivalSampleSpanMs: 10_000,
  // The demo "home" privacy zone, in the Outer Sunset, away from every
  // scripted destination so none of them are hidden.
  baseZone: { latitude: 37.7535, longitude: -122.4955, radiusMeters: 150 },
}

// Full auto with shorter waits so a demo moves along. Only seeded when the
// demo has no automation yet, so tweaks on /setup survive injected pitches.
const DEMO_AUTOMATION = {
  ...automationPreset("full_auto"),
  vetoSeconds: 15,
  pollDurationSeconds: 60,
  postMissionDelaySeconds: 10,
}

// The simulated GPS feed: the streamer stays wherever they last were (Union
// Square at first), with fresh timestamps like a live RealtimeIRL feed. A
// "GPS lost" feed stays lost until the streamer moves again or the demo resets.
async function refreshLocation(
  db: Firestore,
  tenantId: string,
  now: number,
  { seed = false } = {}
) {
  const locationRef = db.doc(tenantDoc(tenantId, "privateState/location"))
  const stored = (await locationRef.get()).data()
  if (stored?.simulatedGpsLost === true) return { gpsLost: true }
  const known =
    Number.isFinite(Number(stored?.latitude)) &&
    Number.isFinite(Number(stored?.longitude)) &&
    typeof stored?.observedAt === "number"
  if (known) {
    // Like a real RealtimeIRL heartbeat: the feed is alive, but no new GPS
    // observation. Leaving observedAt alone means a beat can never make an
    // arrival sample look older than the stored one. update() fails rather
    // than resurrecting a location "Arrive by GPS" has just cleared.
    await locationRef.update({ feedHeartbeatAt: now }).catch(() => undefined)
    return { gpsLost: false }
  }
  // Only seeding (a new or reset demo) places the streamer at the start.
  if (!seed) return { gpsLost: false }
  await locationRef.set({
    ...DEMO_LOCATION,
    observedAt: now,
    receivedAt: now,
    feedHeartbeatAt: now,
    accuracyMeters: 8,
    source: "simulator",
    privacyBlocked: false,
  })
  return { gpsLost: false }
}

async function seedContext(db: Firestore, tenantId: string, now: number) {
  const settingsRef = db.doc(tenantDoc(tenantId, "settings/current"))
  const hasAutomation = (await settingsRef.get()).data()?.automation
  await Promise.all([
    settingsRef.set(
      hasAutomation
        ? DEMO_SETTINGS
        : { ...DEMO_SETTINGS, automation: DEMO_AUTOMATION },
      { merge: true }
    ),
    refreshLocation(db, tenantId, now, { seed: true }),
  ])
}

async function injectPitch(
  db: Firestore,
  tenantId: string,
  preset: DemoPresetKey,
  now: number
) {
  await seedContext(db, tenantId, now)
  const redemptionId = `demo-${randomUUID()}`
  const scripted = DEV_PITCH_PRESETS[preset]
  const login = scripted.viewer.toLowerCase()
  const pitch: PendingPitch = {
    redemptionId,
    sourceMessageId: `demo-message-${redemptionId}`,
    broadcasterId: tenantId,
    viewer: { id: `demo-${login}`, login, name: scripted.viewer },
    reward: {
      id: "demo-reward",
      title: "Pitch a mission",
      prompt: "",
      cost: 10,
    },
    rawText: scripted.text,
    redeemedAt: new Date(now).toISOString(),
    redemptionStatus: "unfulfilled",
    reviewStatus: "processing",
    processing: { status: "pending", attempts: 0, nextAttemptAt: now },
    createdAt: now,
    updatedAt: now,
  }
  await db
    .doc(tenantDoc(tenantId, `pitches/${eventSubStorageId(redemptionId)}`))
    .create(pitch)
  await runPitchNow(tenantId, redemptionId)
  return { redemptionId }
}

async function addVote(
  db: Firestore,
  tenantId: string,
  choiceIndex: number,
  now: number
) {
  const sessionRef = db.doc(tenantDoc(tenantId, "sessions/current"))
  const publicRef = db.doc(tenantDoc(tenantId, "publicState/current"))
  return db.runTransaction(async (tx) => {
    const [session, publicState] = await Promise.all([
      tx.get(sessionRef),
      tx.get(publicRef),
    ])
    const poll = session.data()?.poll as PollRecord | undefined
    if (poll?.status !== "active" || !poll.choices[choiceIndex]) {
      throw new DevError("dev_poll_not_active", 409)
    }
    const choices = poll.choices.map((choice, index) => ({
      ...choice,
      votes: (choice.votes ?? 0) + (index === choiceIndex ? 1 : 0),
    }))
    const next = { ...poll, choices, updatedAt: now }
    const projection = tallyOverlay(
      publicState.data(),
      {
        ended: false,
        choices: choices.map((choice) => ({
          title: choice.title,
          votes: choice.votes ?? 0,
        })),
      },
      now
    )
    tx.set(sessionRef, { poll: next }, { merge: true })
    if (projection) tx.set(publicRef, projection)
    return { poll: next }
  })
}

async function endPoll(db: Firestore, tenantId: string, now: number) {
  const session = await db.doc(tenantDoc(tenantId, "sessions/current")).get()
  const poll = session.data()?.poll as PollRecord | undefined
  if (poll?.status !== "active" || !poll.twitchPollId || !poll.startedAt) {
    throw new DevError("dev_poll_not_active", 409)
  }
  const store = createPollEndStore(db, tenantId)
  await store.recordEarlyEnd({
    pollId: poll.twitchPollId,
    sourceMessageId: `demo-end-${randomUUID()}`,
    broadcasterId: tenantId,
    title: poll.title,
    status: "completed",
    choices: poll.choices.map((choice, index) => ({
      id: choice.twitchChoiceId ?? `demo-choice-${index + 1}`,
      title: choice.title,
      votes: choice.votes ?? 0,
    })),
    startedAt: new Date(poll.startedAt).toISOString(),
    endedAt: new Date(now).toISOString(),
    processing: { status: "pending", attempts: 0, nextAttemptAt: now },
    createdAt: now,
    updatedAt: now,
  })
  return { result: await store.apply(poll.twitchPollId, now) }
}

async function mission(db: Firestore, tenantId: string) {
  const session = await db.doc(tenantDoc(tenantId, "sessions/current")).get()
  return session.data()?.mission as MissionRecord | undefined
}

async function move(
  db: Firestore,
  tenantId: string,
  arrive: boolean,
  now: number
) {
  const current = await mission(db, tenantId)
  if (current?.status !== "heading" || !current.destination) {
    throw new DevError("dev_mission_not_heading", 409)
  }
  const locationRef = db.doc(tenantDoc(tenantId, "privateState/location"))
  const confirmationRef = db.doc(
    tenantDoc(tenantId, "privateState/arrivalConfirmation")
  )
  const stored = (await locationRef.get()).data() ?? DEMO_LOCATION
  const factor = arrive ? 1 : 0.35
  const latitude =
    Number(stored.latitude) +
    (current.destination.latitude - Number(stored.latitude)) * factor
  const longitude =
    Number(stored.longitude) +
    (current.destination.longitude - Number(stored.longitude)) * factor
  const store = createRealtimeIrlStore(db, tenantId)
  if (!arrive) {
    return store.record(
      { latitude, longitude, observedAt: now, accuracyMeters: 8 },
      now
    )
  }
  await Promise.all([locationRef.delete(), confirmationRef.delete()])
  await store.record(
    { latitude, longitude, observedAt: now - 10_000, accuracyMeters: 8 },
    now
  )
  return store.record(
    {
      latitude: current.destination.latitude,
      longitude: current.destination.longitude,
      observedAt: now,
      accuracyMeters: 8,
    },
    now
  )
}

async function reset(db: Firestore, tenantId: string, now: number) {
  // The overlay key lives outside the tenant; revoke it before wiping.
  const overlayId = (
    await db.doc(tenantDoc(tenantId, "private/integrations")).get()
  ).data()?.overlayId
  if (typeof overlayId === "string" && overlayId) {
    await db.doc(`overlayAccess/${overlayId}`).delete()
  }
  await db.recursiveDelete(db.doc(`owners/${tenantId}`))
  await db.doc(`owners/${tenantId}`).set({
    twitchLogin: "demo_owner",
    connectionStatus: "connected",
    rewardEnabled: false,
    updatedAt: now,
  })
  await seedContext(db, tenantId, now)
  return { reset: true }
}

export async function runDevAction(
  db: Firestore,
  tenantId: string,
  action: DevAction,
  now = Date.now()
) {
  if (action.action === "inject_pitch") {
    return injectPitch(db, tenantId, action.preset, now)
  }
  if (action.action === "keep_alive") return refreshLocation(db, tenantId, now)
  if (action.action === "add_vote") {
    await refreshLocation(db, tenantId, now)
    return addVote(db, tenantId, action.choice, now)
  }
  if (action.action === "end_poll") {
    await refreshLocation(db, tenantId, now)
    return endPoll(db, tenantId, now)
  }
  if (action.action === "move_toward") return move(db, tenantId, false, now)
  if (action.action === "arrive") return move(db, tenantId, true, now)
  if (action.action === "overlay_links") {
    // A fresh key each time; the demo has no real OBS to keep working.
    const { overlayId, secret } = await createOverlayAccessStore(db).rotate(
      tenantId,
      now
    )
    return {
      overlayUrl: `/overlay/${overlayId}#${secret}`,
      mapUrl: `/map/${overlayId}#${secret}`,
    }
  }
  if (action.action === "gps_lost") {
    await db.doc(tenantDoc(tenantId, "privateState/location")).set(
      {
        // Just past the live cutoff: the map greys the last position.
        feedHeartbeatAt: now - 60_000,
        simulatedGpsLost: true,
        updatedAt: FieldValue.serverTimestamp(),
      },
      { merge: true }
    )
    return { gpsLost: true }
  }
  return reset(db, tenantId, now)
}
