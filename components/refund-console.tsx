"use client"

import { useCallback, useEffect, useState } from "react"
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import {
  Card,
  CardAction,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card"
import type { RefundItem, RefundState } from "@/shared/refunds"

const labels: Record<RefundState, string> = {
  eligible: "Ready to refund",
  queued: "Refund queued",
  retry: "Needs retry",
  refunded: "Refunded",
  blocked: "Locked by poll",
  attempted: "Attempted mission",
  unavailable: "Unavailable",
}

function StateBadge({ state }: { state: RefundState }) {
  if (state === "retry")
    return <Badge variant="destructive">{labels[state]}</Badge>
  if (state === "refunded") return <Badge>{labels[state]}</Badge>
  return <Badge variant="outline">{labels[state]}</Badge>
}

export function RefundConsole() {
  const [items, setItems] = useState<RefundItem[]>([])
  const [signedIn, setSignedIn] = useState(false)
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState(false)
  const [confirming, setConfirming] = useState(false)
  const [message, setMessage] = useState("Sign in to manage refunds.")

  const token = useCallback(async () => {
    const { getBrowserFirebase } = await import("@/lib/firebase/client")
    const user = getBrowserFirebase().auth.currentUser
    if (!user) throw new Error("unauthorized")
    return user.getIdToken()
  }, [])

  const refresh = useCallback(async () => {
    try {
      const response = await fetch("/api/refunds", {
        headers: { Authorization: "Bearer " + (await token()) },
        cache: "no-store",
      })
      const body = await response.json()
      if (!response.ok) throw new Error(body.error ?? "unavailable")
      setItems(body.refunds)
      setMessage(body.refunds.length ? "" : "No redemptions yet.")
    } catch {
      setMessage("Could not load refunds. Try again.")
    } finally {
      setLoading(false)
    }
  }, [token])

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
        setSignedIn(!!user)
        setLoading(!!user)
        setConfirming(false)
        if (user) void refresh()
        else {
          setItems([])
          setMessage("Sign in to manage refunds.")
        }
      })
    }
    void connect()
    return () => {
      active = false
      unsubscribe()
    }
  }, [refresh])

  async function queueUnused() {
    if (!confirming) {
      setConfirming(true)
      return
    }
    setBusy(true)
    setMessage("")
    try {
      const response = await fetch("/api/refunds", {
        method: "POST",
        headers: {
          Authorization: "Bearer " + (await token()),
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ action: "queue_unused" }),
      })
      const body = await response.json()
      if (!response.ok) throw new Error(body.error ?? "unavailable")
      setMessage(
        body.queued
          ? body.queued +
              " refund" +
              (body.queued === 1 ? "" : "s") +
              " queued for Twitch."
          : "Nothing new needed a refund."
      )
      setConfirming(false)
      await refresh()
    } catch {
      setMessage("Could not queue refunds. Nothing was reported as refunded.")
    } finally {
      setBusy(false)
    }
  }

  const actionable = items.filter(
    (item) => item.state === "eligible" || item.state === "retry"
  ).length
  const unresolved = items.filter((item) =>
    ["eligible", "queued", "retry", "blocked"].includes(item.state)
  )

  return (
    <section className="space-y-4" aria-labelledby="refund-heading">
      <Card className="border-destructive/30">
        <CardHeader>
          <CardTitle id="refund-heading" className="text-xl">
            Automatic refund status
          </CardTitle>
          <CardDescription>
            Removed, rejected, and unused pitches are automatically queued for a
            Twitch Channel Points refund. Use the recovery button only if a
            refund was missed or exhausted its retries.
          </CardDescription>
        </CardHeader>
        <CardContent className="gap-3">
          <Button
            className="min-h-14 w-full text-base"
            variant="destructive"
            disabled={!signedIn || loading || busy || actionable === 0}
            onClick={() => void queueUnused()}
          >
            {busy
              ? "Queueing refunds…"
              : confirming
                ? "Tap again to queue " + actionable
                : "Retry/queue " +
                  actionable +
                  " refund" +
                  (actionable === 1 ? "" : "es")}
          </Button>
          {confirming && (
            <Button
              variant="outline"
              className="min-h-12 w-full"
              disabled={busy}
              onClick={() => setConfirming(false)}
            >
              Cancel
            </Button>
          )}
          {message && (
            <p role="status" className="text-sm text-muted-foreground">
              {message}
            </p>
          )}
        </CardContent>
      </Card>

      {unresolved.some((item) => item.state === "blocked") && (
        <Alert>
          <AlertTitle>Some pitches are locked</AlertTitle>
          <AlertDescription>
            Finish the active poll or mission before refunding those pitches.
          </AlertDescription>
        </Alert>
      )}

      <div className="grid gap-3">
        {unresolved.map((item) => (
          <Card key={item.redemptionId}>
            <CardHeader>
              <CardTitle className="pr-24 text-base">
                {item.viewerName}
              </CardTitle>
              <CardDescription>{item.objective}</CardDescription>
              <CardAction>
                <StateBadge state={item.state} />
              </CardAction>
            </CardHeader>
            {item.errorCode && (
              <CardContent>
                <p className="text-sm text-destructive">{item.errorCode}</p>
              </CardContent>
            )}
          </Card>
        ))}
      </div>

      {signedIn && !loading && unresolved.length === 0 && (
        <p className="text-sm text-muted-foreground">
          No unresolved refunds. Attempted missions are fulfilled separately.
        </p>
      )}
    </section>
  )
}
