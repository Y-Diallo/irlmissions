import { readFile } from "node:fs/promises"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import {
  assertFails,
  initializeTestEnvironment,
  type RulesTestEnvironment,
} from "@firebase/rules-unit-testing"
import { initializeApp, deleteApp, type FirebaseApp } from "firebase/app"
import {
  connectAuthEmulator,
  getAuth,
  signInWithCustomToken,
  signOut,
} from "firebase/auth"
import { doc, getDoc, setDoc } from "firebase/firestore"
import {
  initializeApp as initializeAdmin,
  deleteApp as deleteAdmin,
  type App,
} from "firebase-admin/app"
import { getAuth as getAdminAuth } from "firebase-admin/auth"
import { getFirestore as getAdminFirestore } from "firebase-admin/firestore"
import { createAuthStore } from "@/lib/auth/store"
import { createEventSubStore } from "@/lib/eventsub/store"
import { createPitchStore, findClaimablePitchIds } from "@/lib/pitches/store"
import { createPitchReviewStore } from "@/lib/pitches/review-store"
import { createOverlayAccessStore } from "@/lib/overlay/access-store"
import {
  completeTwitchLogin,
  createOAuthState,
  exchangeHandoff,
  hashHandoff,
} from "@/shared/auth/twitch"
import { authenticateOwner } from "@/shared/auth/owner"
import { createDemoOwnerToken } from "@/shared/auth/demo-owner"
import { demoEnv } from "./fixtures"
import { authFixture, credentials, twitchConfig } from "./auth-fixtures"
import type { EventSubWrite } from "@/shared/eventsub"

// Explicitly opted into by test:emulators, never an accidental production test.
describe.runIf(process.env.RUN_EMULATOR_TESTS === "true")(
  "Firebase emulator foundation",
  () => {
    let rules: RulesTestEnvironment
    let admin: App
    let client: FirebaseApp
    const projectId = "demo-irlmissions"

    beforeAll(async () => {
      expect(process.env.FIREBASE_AUTH_EMULATOR_HOST).toBe("127.0.0.1:9099")
      expect(process.env.FIRESTORE_EMULATOR_HOST).toBe("127.0.0.1:8080")
      rules = await initializeTestEnvironment({
        projectId,
        firestore: {
          host: "127.0.0.1",
          port: 8080,
          rules: await readFile(
            new URL("../../firestore.rules", import.meta.url),
            "utf8"
          ),
        },
      })
      admin = initializeAdmin({ projectId }, "foundation-tests")
      client = initializeApp(
        { projectId, apiKey: "demo-key" },
        "foundation-tests"
      )
      connectAuthEmulator(getAuth(client), "http://127.0.0.1:9099", {
        disableWarnings: true,
      })
      await rules.withSecurityRulesDisabled(async (context) => {
        await setDoc(doc(context.firestore(), "server/tokens"), {
          secret: "synthetic-test-token",
        })
      })
    })

    afterAll(async () => {
      await Promise.all([
        rules?.cleanup(),
        client && deleteApp(client),
        admin && deleteAdmin(admin),
      ])
    })

    it("exchanges a fake-owner custom token using the Auth emulator", async () => {
      const customToken = await createDemoOwnerToken(demoEnv, (uid, claims) =>
        getAdminAuth(admin).createCustomToken(uid, claims)
      )
      const auth = getAuth(client)
      const { user } = await signInWithCustomToken(auth, customToken)
      const decoded = await getAdminAuth(admin).verifyIdToken(
        await user.getIdToken()
      )
      expect(decoded.uid).toBe("demo-owner")
      expect(decoded.owner).toBe(true)
      await signOut(auth)
    })

    it("completes mocked Twitch OAuth through real Firestore and Firebase Auth", async () => {
      const fixture = authFixture()
      const deps = {
        ...fixture.deps,
        store: createAuthStore(getAdminFirestore(admin)),
        mintToken: (
          uid: string,
          claims: { owner: boolean; twitchUserId: string }
        ) => getAdminAuth(admin).createCustomToken(uid, claims),
        now: Date.now,
      }
      const state = createOAuthState(twitchConfig.clientSecret)
      const handoff = await completeTwitchLogin(
        twitchConfig,
        { code: "synthetic-code", state, error: null },
        state,
        async () => deps
      )
      const results = await Promise.allSettled([
        exchangeHandoff(twitchConfig, handoff, deps),
        exchangeHandoff(twitchConfig, handoff, deps),
      ])
      const successful = results.filter(
        (result) => result.status === "fulfilled"
      )
      expect(successful).toHaveLength(1)
      expect(
        results.filter((result) => result.status === "rejected")
      ).toHaveLength(1)
      if (successful[0].status !== "fulfilled")
        throw new Error("No handoff completed")
      const { user } = await signInWithCustomToken(
        getAuth(client),
        successful[0].value
      )
      const bearer = `Bearer ${await user.getIdToken()}`
      const verify = (token: string) =>
        getAdminAuth(admin).verifyIdToken(token, true)
      await expect(
        authenticateOwner(bearer, { mode: "live" }, verify)
      ).resolves.toMatchObject({ uid: "twitch:42", tenantId: "42" })
      await signOut(getAuth(client))
    })

    it("claims one refresh at a time and prevents stale overwrites after a new login", async () => {
      const store = createAuthStore(getAdminFirestore(admin))
      await store.saveTokens(credentials)
      const claims = await Promise.all([
        store.claimRefresh(
          "42",
          credentials.accessToken,
          "lease-a",
          Date.now()
        ),
        store.claimRefresh(
          "42",
          credentials.accessToken,
          "lease-b",
          Date.now()
        ),
      ])
      expect(claims.filter(Boolean)).toHaveLength(1)
      const winner = claims[0] ? "lease-a" : "lease-b"
      await store.saveTokens({
        ...credentials,
        accessToken: "new-login",
        connectionId: "new-connection",
      })
      expect(
        await store.finishRefresh(
          "42",
          { ...credentials, accessToken: "stale-refresh" },
          winner
        )
      ).toBe(false)
      expect((await store.readTokens("42"))?.accessToken).toBe("new-login")
    })

    it("consumes expired handoffs without granting a session", async () => {
      const store = createAuthStore(getAdminFirestore(admin))
      const hash = hashHandoff("expired-synthetic-handoff")
      await store.saveHandoff(hash, {
        uid: "twitch:42",
        connectionId: "old",
        expiresAt: Date.now() - 1000,
      })
      expect(await store.consumeHandoff(hash, Date.now())).toBeNull()
      expect(await store.consumeHandoff(hash, Date.now())).toBeNull()
    })

    it("atomically deduplicates EventSub messages and redemption IDs", async () => {
      const store = createEventSubStore(getAdminFirestore(admin), "42")
      const receipt = {
        messageId: "emulator-eventsub-message-a",
        messageType: "notification" as const,
        subscriptionId: "subscription-1",
        subscriptionType: "channel.channel_points_custom_reward_redemption.add",
        subscriptionVersion: "1",
        subscriptionStatus: "enabled",
        receivedAt: Date.now(),
      }
      const write: EventSubWrite = {
        kind: "redemption",
        receipt,
        pitch: {
          redemptionId: "emulator-redemption-a",
          sourceMessageId: receipt.messageId,
          broadcasterId: "42",
          viewer: { id: "viewer", login: "viewer", name: "Viewer" },
          reward: { id: "reward", title: "Pitch", prompt: "", cost: 100 },
          rawText: "Visit the aquarium",
          redeemedAt: new Date().toISOString(),
          redemptionStatus: "unfulfilled",
          reviewStatus: "processing",
          processing: {
            status: "pending",
            attempts: 0,
            nextAttemptAt: Date.now(),
          },
          createdAt: Date.now(),
          updatedAt: Date.now(),
        },
      }
      const sameMessage = await Promise.all([
        store.save(write),
        store.save(write),
      ])
      expect(sameMessage.sort()).toEqual(["created", "duplicate-message"])
      await expect(
        store.save({
          ...write,
          receipt: { ...receipt, messageId: "emulator-eventsub-message-b" },
        })
      ).resolves.toBe("duplicate-redemption")
    })

    it("isolates identical event IDs and overlay credentials between tenants", async () => {
      const db = getAdminFirestore(admin)
      const receipt = {
        messageId: "same-message",
        messageType: "notification" as const,
        subscriptionId: "subscription",
        subscriptionType: "channel.channel_points_custom_reward_redemption.add",
        subscriptionVersion: "1",
        subscriptionStatus: "enabled",
        receivedAt: Date.now(),
      }
      const pitch = (broadcasterId: string): EventSubWrite => ({
        kind: "redemption",
        receipt,
        pitch: {
          redemptionId: "same-redemption",
          sourceMessageId: receipt.messageId,
          broadcasterId,
          viewer: { id: "viewer", login: "viewer", name: "Viewer" },
          reward: {
            id: `reward-${broadcasterId}`,
            title: "Pitch",
            prompt: "",
            cost: 10,
          },
          rawText: "Visit the park",
          redeemedAt: new Date().toISOString(),
          redemptionStatus: "unfulfilled",
          reviewStatus: "processing",
          processing: { status: "pending", attempts: 0, nextAttemptAt: 0 },
          createdAt: Date.now(),
          updatedAt: Date.now(),
        },
      })
      await expect(
        createEventSubStore(db, "42").save(pitch("42"))
      ).resolves.toBe("created")
      await expect(
        createEventSubStore(db, "99").save(pitch("99"))
      ).resolves.toBe("created")

      const access = createOverlayAccessStore(db)
      const first = await access.rotate("42", Date.now())
      const second = await access.rotate("99", Date.now())
      await expect(access.resolve(first.overlayId, first.secret)).resolves.toBe(
        "42"
      )
      await expect(
        access.resolve(second.overlayId, second.secret)
      ).resolves.toBe("99")
      await expect(
        access.resolve(first.overlayId, second.secret)
      ).rejects.toThrow("unauthorized")
    })

    it("claims a pitch once and commits only for the active processing lease", async () => {
      const db = getAdminFirestore(admin)
      const redemptionId = "emulator-processor-redemption"
      const pitchId = (await import("@/shared/eventsub")).eventSubStorageId(
        redemptionId
      )
      await db.doc(`owners/42/pitches/${pitchId}`).set({
        redemptionId,
        rawText: "Visit the public park",
        reviewStatus: "processing",
        processing: { status: "pending", attempts: 0, nextAttemptAt: 1000 },
        createdAt: 1000,
        updatedAt: 1000,
      })
      const store = createPitchStore(db, "42")
      const claims = await Promise.all([
        store.claim(redemptionId, "lease-one", 2000, 122000),
        store.claim(redemptionId, "lease-two", 2000, 122000),
      ])
      const winners = claims.filter((claim) => claim !== null)
      expect(winners).toHaveLength(1)
      const winner = winners[0]!
      await expect(
        store.complete(
          { ...winner, leaseId: "stale-lease" },
          {
            extraction: {
              placeQuery: "public park",
              challenge: "Visit the public park",
              publicLabelSuggestion: "Mystery park challenge",
              durationMinutes: 10,
              riskFlags: [],
            },
            destination: {
              placeId: "park-1",
              name: "Public Park",
              address: "Park Street",
              latitude: 37.78,
              longitude: -122.41,
              publicAccess: true,
              businessStatus: "operational",
              hoursText: null,
              googleMapsUri: "https://maps.google.com/?cid=park-1",
              attributions: [],
            },
            walkingRoute: { distanceMeters: 500, durationSeconds: 400 },
            duplicateSuggestions: [],
            straightLineMeters: 450,
            warnings: [],
          },
          3000
        )
      ).resolves.toBe(false)
      await expect(store.reject(winner, "no_public_place", 3000)).resolves.toBe(
        true
      )
      const saved = (await db.doc(`owners/42/pitches/${pitchId}`).get()).data()
      expect(saved).toMatchObject({
        reviewStatus: "rejected",
        rejectionReason: "no_public_place",
        processing: { status: "complete", attempts: 1 },
      })
    })

    it("recovers due pending, retryable, and expired processing records", async () => {
      const db = getAdminFirestore(admin)
      const prefix = "emulator-recovery"
      const records = [
        {
          redemptionId: `${prefix}-pending`,
          processing: { status: "pending", attempts: 0, nextAttemptAt: 1000 },
        },
        {
          redemptionId: `${prefix}-error`,
          processing: {
            status: "error",
            attempts: 1,
            automaticRetryAt: 1000,
          },
        },
        {
          redemptionId: `${prefix}-expired`,
          processing: {
            status: "processing",
            attempts: 1,
            leaseId: "lost",
            claimedUntil: 1000,
          },
        },
        {
          redemptionId: `${prefix}-manual-only`,
          processing: {
            status: "error",
            attempts: 5,
            automaticRetryAt: null,
          },
        },
      ]
      await Promise.all(
        records.map((record, index) =>
          db.doc(`owners/42/pitches/recovery-${index}`).set({
            ...record,
            rawText: "Synthetic pitch",
            reviewStatus: "processing",
            createdAt: 1000 + index,
            updatedAt: 1000,
          })
        )
      )
      const found = await findClaimablePitchIds(db, "42", 2000, 5)
      expect(found).toEqual(
        expect.arrayContaining([
          `${prefix}-pending`,
          `${prefix}-error`,
          `${prefix}-expired`,
        ])
      )
      expect(found).not.toContain(`${prefix}-manual-only`)
    })

    it("persists owner approval and makes every edit unapprove", async () => {
      const db = getAdminFirestore(admin)
      const redemptionId = "emulator-review-redemption"
      const pitchId = (await import("@/shared/eventsub")).eventSubStorageId(
        redemptionId
      )
      await db.doc(`owners/42/pitches/${pitchId}`).set({
        redemptionId,
        rawText: "Visit a public cafe",
        reviewStatus: "pending_review",
        publicLabel: "Mystery cafe challenge",
        durationMinutes: 10,
        extraction: {
          placeQuery: "cafe",
          challenge: "Visit a public cafe",
          publicLabelSuggestion: "Mystery cafe challenge",
          durationMinutes: 10,
          riskFlags: [],
        },
        destination: {
          placeId: "cafe-1",
          name: "Sample Coffee",
          address: "123 Test Street",
          latitude: 37.78,
          longitude: -122.41,
          publicAccess: true,
          businessStatus: "operational",
          hoursText: null,
          googleMapsUri: "https://maps.google.com/?cid=cafe-1",
          attributions: [],
        },
        walkingRoute: { distanceMeters: 500, durationSeconds: 400 },
        processing: { status: "complete", attempts: 1 },
        createdAt: 1000,
        updatedAt: 1000,
      })
      const store = createPitchReviewStore(db, "42")

      await store.update(redemptionId, { action: "approve" }, 2000)
      let saved = (await db.doc(`owners/42/pitches/${pitchId}`).get()).data()
      expect(saved).toMatchObject({
        reviewStatus: "approved",
        approvedAt: 2000,
      })

      await store.update(
        redemptionId,
        {
          action: "edit_details",
          publicLabel: "Edited mystery objective",
          durationMinutes: 12,
          failConsequence: "Do a silly dance",
          consequenceClearRule: "through_next_mission",
          consequenceDurationMinutes: 0,
        },
        3000
      )
      saved = (await db.doc(`owners/42/pitches/${pitchId}`).get()).data()
      expect(saved).toMatchObject({
        reviewStatus: "pending_review",
        publicLabel: "Edited mystery objective",
      })
      expect(saved?.approvedAt).toBeUndefined()

      await store.update(
        redemptionId,
        { action: "edit_raw", rawText: "Visit a public park" },
        4000
      )
      saved = (await db.doc(`owners/42/pitches/${pitchId}`).get()).data()
      expect(saved).toMatchObject({
        reviewStatus: "processing",
        processing: { status: "pending", attempts: 0, nextAttemptAt: 4000 },
      })
      expect(saved?.approvedAt).toBeUndefined()
      expect(saved?.destination).toBeUndefined()
      expect(saved?.extraction).toBeUndefined()
    })

    it.each(["anonymous", "demo-owner", "twitch:42", "other-user"])(
      "denies private reads and writes for %s",
      async (uid) => {
        const context =
          uid === "anonymous"
            ? rules.unauthenticatedContext()
            : rules.authenticatedContext(uid, {
                owner: uid === "demo-owner" || uid === "twitch:42",
                twitchUserId: "42",
              })
        const db = context.firestore()
        await assertFails(getDoc(doc(db, "server/tokens")))
        await assertFails(
          setDoc(doc(db, "server/tokens"), { secret: "overwrite" })
        )
        await assertFails(setDoc(doc(db, "sessions/test"), { ownerId: uid }))
        await assertFails(getDoc(doc(db, "sessions/test")))
        await assertFails(getDoc(doc(db, "server/twitch")))
        await assertFails(
          setDoc(doc(db, "server/twitch"), { accessToken: "overwrite" })
        )
        await assertFails(getDoc(doc(db, "serverAuthHandoffs/private")))
        await assertFails(
          setDoc(doc(db, "serverAuthHandoffs/private"), { uid })
        )
        await assertFails(getDoc(doc(db, "eventsubMessages/private")))
        await assertFails(getDoc(doc(db, "pitches/private")))
        await assertFails(getDoc(doc(db, "owners/42/private/twitch")))
        await assertFails(getDoc(doc(db, "owners/42/private/integrations")))
        await assertFails(getDoc(doc(db, "overlayAccess/private")))
      }
    )
  }
)
