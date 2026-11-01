"use client"

import { useCallback, useEffect, useState } from "react"
import { Badge } from "@/components/ui/badge"
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card"
import type { PitchHistoryItem } from "@/shared/pitches/review"

function resolutionLabel(item: PitchHistoryItem) {
  const resolution = item.redemptionResolution
  if (!resolution) return "No Twitch update"
  if (resolution.action === "refund") {
    if (resolution.status === "complete") return "Refunded"
    if (resolution.status === "error") return "Refund needs retry"
    return "Refund queued"
  }
  if (resolution.status === "complete") return "Fulfilled"
  if (resolution.status === "error") return "Fulfillment needs retry"
  return "Fulfillment queued"
}

export function PitchHistory() {
  const [items, setItems] = useState<PitchHistoryItem[]>([])
  const [message, setMessage] = useState("Sign in to view history.")
  const [loading, setLoading] = useState(true)

  const refresh = useCallback(async () => {
    try {
      const { getBrowserFirebase } = await import("@/lib/firebase/client")
      const user = getBrowserFirebase().auth.currentUser
      if (!user) throw new Error("unauthorized")
      const response = await fetch("/api/history", {
        headers: { Authorization: `Bearer ${await user.getIdToken()}` },
        cache: "no-store",
      })
      const body = await response.json()
      if (!response.ok) throw new Error(body.error ?? "unavailable")
      setItems(body.history)
      setMessage(body.history.length ? "" : "No removed pitches yet.")
    } catch {
      setItems([])
      setMessage("Could not load pitch history.")
    } finally {
      setLoading(false)
    }
  }, [setItems, setMessage])

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
        if (user) void refresh()
        else {
          setItems([])
          setLoading(false)
          setMessage("Sign in to view history.")
        }
      })
    }
    void connect()
    return () => {
      active = false
      unsubscribe()
    }
  }, [refresh])

  return (
    <section className="space-y-4" aria-labelledby="history-heading">
      <div>
        <p className="text-sm font-medium text-muted-foreground">
          Producer archive
        </p>
        <h2 id="history-heading" className="text-2xl font-semibold">
          Removed viewer pitches
        </h2>
      </div>
      {message && (
        <p role="status" className="text-base text-muted-foreground">
          {message}
        </p>
      )}
      {!loading && (
        <div className="grid gap-4">
          {items.map((item) => (
            <Card key={item.redemptionId}>
              <CardHeader>
                <CardTitle className="text-xl">{item.objective}</CardTitle>
                <CardDescription className="text-base">
                  {item.viewerName} · Removed{" "}
                  {new Date(item.removedAt).toLocaleString()}
                </CardDescription>
                <Badge variant="outline" className="mt-2 w-fit">
                  {resolutionLabel(item)}
                </Badge>
              </CardHeader>
              <CardContent>
                <p className="text-base leading-relaxed">{item.rawText}</p>
                <p className="text-sm text-muted-foreground">
                  Previous state: {item.previousStatus.replaceAll("_", " ")}
                </p>
              </CardContent>
            </Card>
          ))}
        </div>
      )}
    </section>
  )
}
