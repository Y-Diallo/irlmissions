"use client"

import { useEffect, useState } from "react"
import { useRouter } from "next/navigation"

export function LandingActions({ repositoryUrl }: { repositoryUrl: string }) {
  const router = useRouter()
  const [checking, setChecking] = useState(true)
  const [demoBusy, setDemoBusy] = useState(false)
  const [message, setMessage] = useState("")

  useEffect(() => {
    let active = true
    let unsubscribe = () => {}
    async function connect() {
      const [{ getBrowserFirebase }, { onAuthStateChanged }] =
        await Promise.all([
          import("@/lib/firebase/client"),
          import("firebase/auth"),
        ])
      if (!active) return
      unsubscribe = onAuthStateChanged(getBrowserFirebase().auth, (user) => {
        if (!active) return
        if (user) {
          router.replace("/console")
          return
        }
        setChecking(false)
      })
    }
    void connect().catch(() => {
      if (active) {
        setChecking(false)
        setMessage("Sign-in is temporarily unavailable.")
      }
    })
    return () => {
      active = false
      unsubscribe()
    }
  }, [router])

  async function tryDemo() {
    setDemoBusy(true)
    setMessage("")
    try {
      const response = await fetch("/api/auth/demo", { method: "POST" })
      const result = await response.json()
      if (!response.ok) throw new Error(result.error ?? "Demo unavailable")
      const [{ getBrowserFirebase }, { signInWithCustomToken }] =
        await Promise.all([
          import("@/lib/firebase/client"),
          import("firebase/auth"),
        ])
      await signInWithCustomToken(getBrowserFirebase().auth, result.token)
      router.replace("/console")
    } catch (error) {
      setMessage(
        error instanceof Error ? error.message : "Demo sign-in is unavailable."
      )
      setDemoBusy(false)
    }
  }

  return (
    <div className="landing-actions" aria-busy={checking || demoBusy}>
      <a
        className="landing-button landing-button--primary"
        href="/api/auth/twitch/login"
        aria-disabled={checking}
        tabIndex={checking ? -1 : undefined}
        onClick={(event) => {
          if (checking) event.preventDefault()
        }}
      >
        Log in with Twitch
      </a>
      <button
        className="landing-button landing-button--secondary"
        type="button"
        disabled={checking || demoBusy}
        onClick={() => void tryDemo()}
      >
        {demoBusy ? "Starting demo…" : "Try the demo"}
      </button>
      <a
        className="landing-repo"
        href={repositoryUrl}
        target="_blank"
        rel="noreferrer"
      >
        View the repository ↗
      </a>
      <p className="landing-message" role="status">
        {checking ? "Checking your session…" : message}
      </p>
    </div>
  )
}
