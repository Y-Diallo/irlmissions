import "server-only"

import { applicationDefault, getApps, initializeApp } from "firebase-admin/app"
import { getAuth } from "firebase-admin/auth"
import { getFirestore } from "firebase-admin/firestore"
import { readServerConfig } from "@/shared/config"

export function getServerFirebase() {
  // Validate before initializing Admin: partial emulator config must fail closed.
  const config = readServerConfig(process.env)
  const name = `${config.mode}-${config.projectId}`
  const app =
    getApps().find((app) => app.name === name) ??
    initializeApp(
      {
        projectId: config.projectId,
        ...(config.mode === "live"
          ? {
              credential: applicationDefault(),
              ...(process.env.FIREBASE_SERVICE_ACCOUNT_ID
                ? { serviceAccountId: process.env.FIREBASE_SERVICE_ACCOUNT_ID }
                : {}),
            }
          : {}),
      },
      name
    )
  return { auth: getAuth(app), db: getFirestore(app) }
}
