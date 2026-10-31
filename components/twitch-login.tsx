"use client"

import { useEffect, useState } from "react"
import { Button } from "@/components/ui/button"

const LOGIN_ERRORS: Record<string, string> = {
  owner: "That Twitch identity could not be verified.",
  scopes:
    "The requested Twitch permissions are needed to run the stream. Please reconnect.",
  denied: "Twitch sign-in was canceled. You can try again.",
  state:
    "That sign-in attempt expired or could not be verified. Please try again.",
  expired: "Your connection expired. Please sign in again.",
}

export function TwitchLogin() {
  const [uid, setUid] = useState<string | null>(null)
  const [status, setStatus] = useState("Checking sign-in…")
  const [busy, setBusy] = useState(false)

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
              setStatus("Twitch connected. Your producer console is next.")
            }
          }
        } catch {
          if (active)
            setStatus("Could not check your connection. Refresh to retry.")
        } finally {
          checking = false
        }
      }
      unsubscribe = onAuthStateChanged(auth, (user) => {
        if (!active) return
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
      if (active) setStatus("Configure Firebase and Twitch to enable sign-in.")
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

  return (
    <div className="space-y-4">
      {uid ? (
        <Button
          className="min-h-12 px-5 text-base"
          variant="outline"
          disabled={busy}
          onClick={() => {
            void logout()
          }}
        >
          {busy ? "Signing out…" : "Sign out"}
        </Button>
      ) : (
        <Button
          className="min-h-12 px-5 text-base"
          onClick={() => window.location.assign("/api/auth/twitch/login")}
        >
          Sign in with Twitch
        </Button>
      )}
      <p role="status" className="text-sm leading-relaxed">
        {status}
      </p>
    </div>
  )
}
