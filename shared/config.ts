// Framework-independent validation. Pass explicit values from each runtime.
export type Environment = Readonly<Record<string, string | undefined>>

export type FirebaseConfig = {
  mode: "emulator" | "live"
  projectId: string
  apiKey: string
  authDomain: string
  appId: string
  authEmulator?: { host: string; port: number }
  firestoreEmulator?: { host: string; port: number }
}

function required(env: Environment, key: string): string {
  const value = env[key]?.trim()
  if (!value) throw new Error(`Missing configuration: ${key}`)
  return value
}

function localEndpoint(value: string) {
  const match = /^(localhost|127\.0\.0\.1):(\d+)$/.exec(value)
  const port = Number(match?.[2])
  if (!match || port < 1 || port > 65535) {
    throw new Error(
      "Emulators must use localhost or 127.0.0.1 with a valid port"
    )
  }
  return { host: match[1], port }
}

export function readFirebaseConfig(env: Environment): FirebaseConfig {
  const mode = required(env, "NEXT_PUBLIC_APP_MODE")
  if (mode !== "emulator" && mode !== "live") {
    throw new Error("NEXT_PUBLIC_APP_MODE must be emulator or live")
  }
  const projectId = required(env, "NEXT_PUBLIC_FIREBASE_PROJECT_ID")
  const config: FirebaseConfig = {
    mode,
    projectId,
    apiKey: required(env, "NEXT_PUBLIC_FIREBASE_API_KEY"),
    authDomain: required(env, "NEXT_PUBLIC_FIREBASE_AUTH_DOMAIN"),
    appId: required(env, "NEXT_PUBLIC_FIREBASE_APP_ID"),
  }
  const authHost = env.NEXT_PUBLIC_FIREBASE_AUTH_EMULATOR_HOST
  const firestoreHost = env.NEXT_PUBLIC_FIRESTORE_EMULATOR_HOST

  if (mode === "emulator") {
    if (env.NODE_ENV === "production") {
      throw new Error("Emulator mode is disabled in production")
    }
    if (!projectId.startsWith("demo-")) {
      throw new Error("Emulator mode requires a demo- Firebase project")
    }
    config.authEmulator = localEndpoint(
      required(env, "NEXT_PUBLIC_FIREBASE_AUTH_EMULATOR_HOST")
    )
    config.firestoreEmulator = localEndpoint(
      required(env, "NEXT_PUBLIC_FIRESTORE_EMULATOR_HOST")
    )
  } else if (projectId.startsWith("demo-") || authHost || firestoreHost) {
    throw new Error("Live mode cannot use demo projects or emulator hosts")
  }
  return config
}

export function readServerConfig(env: Environment) {
  const firebase = readFirebaseConfig(env)
  if (required(env, "FIREBASE_PROJECT_ID") !== firebase.projectId) {
    throw new Error("Browser and server Firebase project IDs must match")
  }
  if (firebase.mode === "emulator") {
    const authHost = required(env, "FIREBASE_AUTH_EMULATOR_HOST")
    const firestoreHost = required(env, "FIRESTORE_EMULATOR_HOST")
    localEndpoint(authHost)
    localEndpoint(firestoreHost)
    if (
      authHost !== env.NEXT_PUBLIC_FIREBASE_AUTH_EMULATOR_HOST ||
      firestoreHost !== env.NEXT_PUBLIC_FIRESTORE_EMULATOR_HOST
    ) {
      throw new Error("Browser and server emulator hosts must match")
    }
  } else if (env.FIREBASE_AUTH_EMULATOR_HOST || env.FIRESTORE_EMULATOR_HOST) {
    throw new Error("Live server cannot use emulator hosts")
  }
  return firebase
}
