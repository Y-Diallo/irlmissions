"use client"

import { useCallback, useEffect, useState } from "react"
import { DemoOverlays } from "@/components/demo-overlays"
import { Button } from "@/components/ui/button"
import {
  Card,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
} from "@/components/ui/card"
import {
  DEV_PITCH_PRESETS,
  type DemoPresetKey,
  type DevAction,
} from "@/shared/dev"
import type { MissionOwnerView } from "@/shared/missions"
import type { PollRecord } from "@/shared/polls"

const presetKeys = Object.keys(DEV_PITCH_PRESETS) as DemoPresetKey[]
const presetGroups = [
  { group: "mission", title: "Inject a San Francisco pitch" },
  { group: "edge", title: "Edge cases" },
] as const

const DEMO_FEED_MS = 10_000

export function DevPanel({
  poll,
  mission,
  token,
  refresh,
}: {
  poll: PollRecord | null
  mission: MissionOwnerView | null
  token: () => Promise<string>
  refresh: () => Promise<void>
}) {
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState("")
  const [confirmReset, setConfirmReset] = useState(false)
  const [links, setLinks] = useState<{
    overlayUrl: string
    mapUrl: string
  } | null>(null)
  const [linksError, setLinksError] = useState("")

  // A fresh overlay key for the inline previews; reset revokes it.
  const loadLinks = useCallback(async () => {
    try {
      const response = await fetch("/api/dev", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${await token()}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ action: "overlay_links" }),
      })
      const body = await response.json()
      if (
        !response.ok ||
        typeof body.overlayUrl !== "string" ||
        typeof body.mapUrl !== "string"
      ) {
        throw new Error()
      }
      setLinks({ overlayUrl: body.overlayUrl, mapUrl: body.mapUrl })
      setLinksError("")
    } catch {
      setLinksError("Could not load the overlay previews.")
    }
  }, [token])

  useEffect(() => {
    const initial = setTimeout(() => void loadLinks(), 0)
    return () => clearTimeout(initial)
  }, [loadLinks])

  // Stands in for the RealtimeIRL feed: keeps the simulated position fresh
  // (well inside the map's 30s cutoff) while this console is visible.
  useEffect(() => {
    const beat = async () => {
      if (document.visibilityState !== "visible") return
      try {
        await fetch("/api/dev", {
          method: "POST",
          headers: {
            Authorization: `Bearer ${await token()}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({ action: "keep_alive" }),
        })
      } catch {
        // The next beat retries; a missed one only ages the position.
      }
    }
    const initial = setTimeout(() => void beat(), 0)
    const interval = setInterval(() => void beat(), DEMO_FEED_MS)
    return () => {
      clearTimeout(initial)
      clearInterval(interval)
    }
  }, [token])

  async function run(action: DevAction) {
    if (action.action === "reset" && !confirmReset) {
      setConfirmReset(true)
      setMessage("Tap Reset demo again to clear this demo account.")
      return
    }
    setBusy(true)
    setMessage("")
    try {
      const response = await fetch("/api/dev", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${await token()}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(action),
      })
      const body = await response.json()
      if (!response.ok) throw new Error(body.error ?? "Simulator unavailable")
      setConfirmReset(false)
      setMessage(
        action.action === "inject_pitch"
          ? "Pitch injected and processed."
          : action.action === "add_vote"
            ? "Vote added."
            : action.action === "end_poll"
              ? "Poll ended and result applied."
              : action.action === "move_toward"
                ? "Location moved toward the destination."
                : action.action === "arrive"
                  ? "Arrival samples sent."
                  : action.action === "gps_lost"
                    ? "GPS heartbeat stopped."
                    : action.action === "reset"
                      ? "Demo reset."
                      : ""
      )
      await refresh()
      if (action.action === "reset") await loadLinks()
    } catch (error) {
      setMessage(
        error instanceof Error ? error.message : "Simulator unavailable"
      )
    } finally {
      setBusy(false)
    }
  }

  const activePoll = poll?.status === "active" ? poll : null
  const activeMission =
    mission?.status === "heading" || mission?.status === "arrived"
      ? mission
      : null

  return (
    <div className="grid gap-4">
      <DemoOverlays links={links} error={linksError} />
      <Card className="border-2 border-dashed border-blue-500 bg-blue-50/60">
        <CardHeader>
          <CardTitle className="text-lg">Demo controls</CardTitle>
          <CardDescription>
            The streamer starts in Union Square, San Francisco. These controls
            use scripted providers and never contact Twitch, Places, Routes,
            OpenAI, or RealtimeIRL.
          </CardDescription>
        </CardHeader>
        <CardContent className="gap-5">
          {presetGroups.map(({ group, title }) => (
            <div key={group} className="space-y-2">
              <p className="text-sm font-medium">{title}</p>
              <div className="grid gap-2 sm:grid-cols-2">
                {presetKeys
                  .filter((preset) => DEV_PITCH_PRESETS[preset].group === group)
                  .map((preset) => (
                    <Button
                      key={preset}
                      variant="outline"
                      className="h-auto min-h-12 justify-start bg-white py-2 text-left whitespace-normal"
                      disabled={busy}
                      onClick={() =>
                        void run({ action: "inject_pitch", preset })
                      }
                    >
                      {DEV_PITCH_PRESETS[preset].label}
                    </Button>
                  ))}
              </div>
            </div>
          ))}

          {activePoll && (
            <div className="space-y-2">
              <p className="text-sm font-medium">Simulate Twitch voting</p>
              <div className="grid gap-2">
                {activePoll.choices.map((choice, index) => (
                  <Button
                    key={choice.redemptionId}
                    variant="outline"
                    className="min-h-12 justify-between bg-white"
                    disabled={busy}
                    onClick={() =>
                      void run({ action: "add_vote", choice: index })
                    }
                  >
                    <span>+1 {choice.title}</span>
                    <span>{choice.votes ?? 0}</span>
                  </Button>
                ))}
              </div>
              <Button
                className="min-h-12 w-full"
                disabled={busy}
                onClick={() => void run({ action: "end_poll" })}
              >
                End simulated poll
              </Button>
            </div>
          )}

          {activeMission && (
            <div className="space-y-2">
              <p className="text-sm font-medium">Simulate RealtimeIRL</p>
              <div className="grid grid-cols-1 gap-2 sm:grid-cols-3">
                <Button
                  variant="outline"
                  className="min-h-12 bg-white"
                  disabled={busy || activeMission.status !== "heading"}
                  onClick={() => void run({ action: "move_toward" })}
                >
                  Move toward
                </Button>
                <Button
                  variant="outline"
                  className="min-h-12 bg-white"
                  disabled={busy || activeMission.status !== "heading"}
                  onClick={() => void run({ action: "arrive" })}
                >
                  Arrive by GPS
                </Button>
                <Button
                  variant="outline"
                  className="min-h-12 bg-white"
                  disabled={busy}
                  onClick={() => void run({ action: "gps_lost" })}
                >
                  GPS lost
                </Button>
              </div>
            </div>
          )}

          {message && (
            <p role="status" className="text-sm font-medium">
              {message}
            </p>
          )}
        </CardContent>
        <CardFooter className="flex-col gap-2 sm:flex-row">
          <Button
            variant="destructive"
            className="min-h-12 w-full sm:w-auto"
            disabled={busy}
            onClick={() => void run({ action: "reset" })}
          >
            {confirmReset ? "Tap again to reset demo" : "Reset demo"}
          </Button>
          {confirmReset && (
            <Button
              variant="outline"
              className="min-h-12 w-full bg-white sm:w-auto"
              disabled={busy}
              onClick={() => setConfirmReset(false)}
            >
              Keep demo data
            </Button>
          )}
        </CardFooter>
      </Card>
    </div>
  )
}
