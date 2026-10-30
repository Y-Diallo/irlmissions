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
        authenticateOwner(bearer, { mode: "live", ownerId: "42" }, verify)
      ).resolves.toMatchObject({ uid: "twitch:42" })
      await expect(
        authenticateOwner(bearer, { mode: "live", ownerId: "99" }, verify)
      ).rejects.toThrow("owner")
      await signOut(getAuth(client))
    })

    it("claims one refresh at a time and prevents stale overwrites after a new login", async () => {
      const store = createAuthStore(getAdminFirestore(admin))
      await store.saveTokens(credentials)
      const claims = await Promise.all([
        store.claimRefresh(credentials.accessToken, "lease-a", Date.now()),
        store.claimRefresh(credentials.accessToken, "lease-b", Date.now()),
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
          { ...credentials, accessToken: "stale-refresh" },
          winner
        )
      ).toBe(false)
      expect((await store.readTokens())?.accessToken).toBe("new-login")
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
      const store = createEventSubStore(getAdminFirestore(admin))
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
      }
    )
  }
)
