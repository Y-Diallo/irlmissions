"use client"

import { useEffect, useRef, useState } from "react"
import Link from "next/link"
import { useRouter } from "next/navigation"

async function finishSignIn() {
  const response = await fetch("/api/auth/session", { method: "POST" })
  if (!response.ok)
    throw new Error(
      "Sign-in expired or could not finish. Return and try again."
    )
  const { token } = await response.json()
  const [{ getBrowserFirebase }, { signInWithCustomToken }] = await Promise.all(
    [import("@/lib/firebase/client"), import("firebase/auth")]
  )
  await signInWithCustomToken(getBrowserFirebase().auth, token)
}

export default function CompleteSignInPage() {
  const router = useRouter()
  const pending = useRef<Promise<void> | null>(null)
  const [error, setError] = useState("")
  useEffect(() => {
    let active = true
    // Strict Mode replays effects; exchange the single-use cookie only once.
    pending.current ??= finishSignIn()
    pending.current
      .then(() => {
        if (active) router.replace("/console")
      })
      .catch(() => {
        if (active)
          setError("Sign-in expired or could not finish. Return and try again.")
      })
    return () => {
      active = false
    }
  }, [router])
  return (
    <main className="mx-auto flex min-h-svh max-w-2xl flex-col justify-center gap-6 p-6">
      <h1 className="text-2xl font-semibold">
        Connecting your producer console
      </h1>
      <p role="status">{error || "Finishing secure sign-in…"}</p>
      {error && (
        <Link className="py-3 underline" href="/">
          Return to sign in
        </Link>
      )}
    </main>
  )
}
