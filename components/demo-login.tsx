"use client"

import { useState } from "react"
import { signInWithCustomToken, signOut } from "firebase/auth"
import { Button } from "@/components/ui/button"
import { getBrowserFirebase } from "@/lib/firebase/client"

export function DemoLogin({ compact = false }: { compact?: boolean }) {
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
    <div className={compact ? "flex flex-col items-end gap-2" : "space-y-4"}>
      <div className="flex flex-wrap justify-end gap-2">
        <Button
          className={compact ? "min-h-11 px-3" : "min-h-12 px-5 text-base"}
          disabled={busy}
          onClick={login}
        >
          {busy ? "Connecting…" : "Try as demo owner"}
        </Button>
        <Button
          className={compact ? "min-h-11 px-3" : "min-h-12 px-5 text-base"}
          variant="outline"
          disabled={busy}
          onClick={logout}
        >
          Sign out
        </Button>
      </div>
      <p
        role="status"
        className={
          compact
            ? "h-8 max-w-64 overflow-hidden text-right text-xs leading-relaxed text-muted-foreground"
            : "text-sm leading-relaxed"
        }
      >
        {status}
      </p>
    </div>
  )
}
