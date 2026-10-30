"use client"

import { useState } from "react"
import { signInWithCustomToken, signOut } from "firebase/auth"
import { Button } from "@/components/ui/button"
import { getBrowserFirebase } from "@/lib/firebase/client"

export function DemoLogin() {
  const [status, setStatus] = useState("")
  const [busy, setBusy] = useState(false)

  async function login() {
    setBusy(true)
    try {
      const { auth } = getBrowserFirebase()
      const response = await fetch("/api/auth/demo", { method: "POST" })
      const result = await response.json()
      if (!response.ok) throw new Error(result.error)
      const { user } = await signInWithCustomToken(auth, result.token)
      setStatus(`Connected as ${user.uid}. Firebase Auth emulator is ready.`)
    } catch (error) {
      setStatus(error instanceof Error ? error.message : "Could not connect")
    } finally {
      setBusy(false)
    }
  }

  async function logout() {
    setBusy(true)
    try {
      await signOut(getBrowserFirebase().auth)
      setStatus("Signed out.")
    } catch (error) {
      setStatus(error instanceof Error ? error.message : "Could not sign out")
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap gap-3">
        <Button
          className="min-h-12 px-5 text-base"
          disabled={busy}
          onClick={login}
        >
          {busy ? "Connecting…" : "Try as demo owner"}
        </Button>
        <Button
          className="min-h-12 px-5 text-base"
          variant="outline"
          disabled={busy}
          onClick={logout}
        >
          Sign out
        </Button>
      </div>
      <p role="status" className="text-sm leading-relaxed">
        {status}
      </p>
    </div>
  )
}
