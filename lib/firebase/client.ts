"use client"

import { initializeApp } from "firebase/app"
import { connectAuthEmulator, getAuth } from "firebase/auth"
import { connectFirestoreEmulator, getFirestore } from "firebase/firestore"
import { readFirebaseConfig } from "@/shared/config"

const globalFirebase = globalThis as typeof globalThis & {
  __irlFirebase?: ReturnType<typeof initialize>
}

function initialize() {
  // Next only inlines literal NEXT_PUBLIC_ references into browser bundles.
  const config = readFirebaseConfig({
    NODE_ENV: process.env.NODE_ENV,
    NEXT_PUBLIC_APP_MODE: process.env.NEXT_PUBLIC_APP_MODE,
    NEXT_PUBLIC_FIREBASE_PROJECT_ID:
      process.env.NEXT_PUBLIC_FIREBASE_PROJECT_ID,
    NEXT_PUBLIC_FIREBASE_API_KEY: process.env.NEXT_PUBLIC_FIREBASE_API_KEY,
    NEXT_PUBLIC_FIREBASE_AUTH_DOMAIN:
      process.env.NEXT_PUBLIC_FIREBASE_AUTH_DOMAIN,
    NEXT_PUBLIC_FIREBASE_APP_ID: process.env.NEXT_PUBLIC_FIREBASE_APP_ID,
    NEXT_PUBLIC_FIREBASE_AUTH_EMULATOR_HOST:
      process.env.NEXT_PUBLIC_FIREBASE_AUTH_EMULATOR_HOST,
    NEXT_PUBLIC_FIRESTORE_EMULATOR_HOST:
      process.env.NEXT_PUBLIC_FIRESTORE_EMULATOR_HOST,
  })
  const app = initializeApp(
    {
      projectId: config.projectId,
      apiKey: config.apiKey,
      authDomain: config.authDomain,
      appId: config.appId,
    },
    "irl-browser"
  )
  const auth = getAuth(app)
  const db = getFirestore(app)
  if (config.authEmulator && config.firestoreEmulator) {
    connectAuthEmulator(
      auth,
      `http://${config.authEmulator.host}:${config.authEmulator.port}`
    )
    connectFirestoreEmulator(
      db,
      config.firestoreEmulator.host,
      config.firestoreEmulator.port
    )
  }
  return { app, auth, db, mode: config.mode }
}

export function getBrowserFirebase() {
  // Persist across Fast Refresh so emulator connections are only made once.
  globalFirebase.__irlFirebase ??= initialize()
  return globalFirebase.__irlFirebase
}
