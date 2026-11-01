"use client"

import { useEffect, useState } from "react"
import { Button, buttonVariants } from "@/components/ui/button"

const LOGIN_ERRORS: Record<string, string> = {
  owner: "That Twitch identity could not be verified.",
  scopes:
    "The requested Twitch permissions are needed to run the stream. Please reconnect.",
  denied: "Twitch sign-in was canceled. You can try again.",
  state:
    "That sign-in attempt expired or could not be verified. Please try again.",
  expired: "Your connection expired. Please sign in again.",
}

export function TwitchLogin({
  compact = false,
  demoEnabled = false,
}: {
  compact?: boolean
  demoEnabled?: boolean
}) {
  const [uid, setUid] = useState<string | null>(null)
  const [status, setStatus] = useState("Checking sign-in…")
  const [busy, setBusy] = useState(false)
  const [ready, setReady] = useState(false)

  useEffect(() => {
    let active = true
    let unsubscribe = () => {}
    let interval: ReturnType<typeof setInterval> | undefined
    let onVisible = () => {}
    async function connect() {
      const [{ getBrowserFirebase }, { onAuthStateChanged, signOut }] =
        await Promise.all([
          import("@/lib/firebase/client"),
          import("firebase/auth"),
        ])
      if (!active) return
      const { auth } = getBrowserFirebase()
      let checking = false
      const check = async () => {
        const user = auth.currentUser
        if (!active || !user || checking) return
        checking = true
        try {
          const response = await fetch("/api/auth/me", {
            headers: { Authorization: `Bearer ${await user.getIdToken()}` },
            cache: "no-store",
          })
          if (!active || auth.currentUser?.uid !== user.uid) return
          if (response.status === 401 || response.status === 403) {
            await signOut(auth)
            if (active)
              setStatus("Your connection ended. Please sign in again.")
          } else if (!response.ok) {
            setStatus("Connection check unavailable. Refresh to retry.")
          } else {
            const identity = await response.json()
            if (active) {
              setUid(identity.uid)
              setStatus("Twitch connected")
            }
          }
        } catch {
          if (active)
            setStatus("Could not check your connection. Refresh to retry.")
        } finally {
          checking = false
          if (active) setReady(true)
        }
      }
      unsubscribe = onAuthStateChanged(auth, (user) => {
        if (!active) return
        setReady(false)
        setUid(null)
        if (user) void check()
        else {
          const code = new URLSearchParams(window.location.search).get(
            "auth_error"
          )
          setStatus(
            code
              ? (LOGIN_ERRORS[code] ??
                  "Sign-in could not finish. Please try again.")
              : "Sign in with your streamer's Twitch account."
          )
          setReady(true)
        }
      })
      // Validate active OAuth sessions more frequently than Twitch's hourly minimum.
      interval = setInterval(
        () => {
          void check()
        },
        15 * 60 * 1000
      )
      onVisible = () => {
        if (document.visibilityState === "visible") void check()
      }
      document.addEventListener("visibilitychange", onVisible)
    }
    connect().catch(() => {
      if (active) {
        setStatus("Configure Firebase and Twitch to enable sign-in.")
        setReady(true)
      }
    })
    return () => {
      active = false
      unsubscribe()
      clearInterval(interval)
      document.removeEventListener("visibilitychange", onVisible)
    }
  }, [])

  async function logout() {
    setBusy(true)
    try {
      await fetch("/api/auth/logout", { method: "POST" }).catch(() => undefined)
      try {
        const [{ getBrowserFirebase }, { signOut }] = await Promise.all([
          import("@/lib/firebase/client"),
          import("firebase/auth"),
        ])
        await signOut(getBrowserFirebase().auth)
        setStatus("Signed out.")
      } catch {
        setStatus("Could not sign out. Please try again.")
      }
    } finally {
      setBusy(false)
    }
  }

  async function loginDemo() {
    setBusy(true)
    try {
      const response = await fetch("/api/auth/demo", { method: "POST" })
      const result = await response.json()
      if (!response.ok) {
        throw new Error(result.error ?? "Demo sign-in is unavailable.")
      }
      const [{ getBrowserFirebase }, { signInWithCustomToken }] =
        await Promise.all([
          import("@/lib/firebase/client"),
          import("firebase/auth"),
        ])
      await signInWithCustomToken(getBrowserFirebase().auth, result.token)
      setStatus("Demo connected.")
    } catch (error) {
      setStatus(
        error instanceof Error
          ? error.message
          : "Demo sign-in is unavailable. Try again."
      )
    } finally {
      setBusy(false)
    }
  }

  return (
    <div
      className={
        compact
          ? "grid w-44 shrink-0 grid-rows-[2.75rem_2rem] gap-2"
          : "space-y-4"
      }
    >
      {!ready ? (
        <div
          className={
            compact
              ? "h-11 w-full animate-pulse rounded-md border bg-muted"
              : "h-12 w-44 animate-pulse rounded-md border bg-muted"
          }
          aria-hidden="true"
        />
      ) : uid ? (
        <Button
          className={
            compact
              ? "min-h-11 w-full px-4"
              : "min-h-12 px-5 text-base"
          }
          variant="outline"
          disabled={busy}
          onClick={() => {
            void logout()
          }}
        >
          {busy ? "Signing out…" : "Sign out"}
        </Button>
      ) : (
        <div
          className={
            compact && demoEnabled
              ? "grid grid-cols-2 gap-2"
              : "flex justify-end"
          }
        >
          <a
            className={buttonVariants({
              className: compact
                ? "min-h-11 w-full px-3"
                : "min-h-12 px-5 text-base",
            })}
            href="/api/auth/twitch/login"
            aria-label="Sign in with Twitch"
          >
            {compact && demoEnabled ? "Twitch" : "Sign in with Twitch"}
          </a>
          {demoEnabled && (
            <Button
              className={
                compact
                  ? "min-h-11 w-full px-3"
                  : "min-h-12 px-5 text-base"
              }
              variant="outline"
              disabled={busy}
              onClick={() => void loginDemo()}
              aria-label="Try demo account"
            >
              {compact ? "Try demo" : "Try demo account"}
            </Button>
          )}
        </div>
      )}
      <p
        role="status"
        className={
          compact
            ? "h-8 w-full overflow-hidden text-right text-xs leading-relaxed text-muted-foreground"
            : "text-sm leading-relaxed"
        }
      >
        {ready ? status : "Checking sign-in…"}
      </p>
    </div>
  )
}
