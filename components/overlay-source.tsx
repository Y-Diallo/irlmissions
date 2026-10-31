"use client"

import { useCallback, useEffect, useState } from "react"
import type { OverlayProjection } from "@/shared/overlay"

function fragmentKey() {
  const fragment = window.location.hash.slice(1)
  if (!fragment) return ""
  if (fragment.startsWith("key=")) {
    return new URLSearchParams(fragment).get("key") ?? ""
  }
  try {
    return decodeURIComponent(fragment)
  } catch {
    return ""
  }
}

function timer(milliseconds: number) {
  const total = Math.max(0, Math.ceil(milliseconds / 1000))
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, "0")}`
}

function Card({ overlay, now }: { overlay: OverlayProjection; now: number }) {
  if (overlay.state === "idle") {
    return (
      <div className="show-card show-card--idle">
        <p className="show-kicker">IRL MISSIONS</p>
        <p className="show-standby">Waiting for chat&apos;s next challenge</p>
      </div>
    )
  }
  if (overlay.state === "voting") {
    return (
      <div className="show-card show-card--voting">
        <p className="show-kicker">CHAT DECIDES</p>
        <h1 className="show-title">{overlay.title}</h1>
        <ol className="show-options">
          {overlay.choices.map((choice) => (
            <li key={choice.position}>
              <span>{choice.position}</span>
              {choice.title}
            </li>
          ))}
        </ol>
        <div className="show-live">
          <i /> VOTING LIVE
        </div>
      </div>
    )
  }

  const terminal = overlay.state === "completed" || overlay.state === "failed"
  const heading = overlay.state === "heading"
  return (
    <div className={`show-card show-card--${overlay.state}`}>
      <p className="show-kicker">
        {heading
          ? "NEXT MISSION"
          : overlay.state === "arrived"
            ? "MISSION ACTIVE"
            : overlay.state === "completed"
              ? "MISSION COMPLETE"
              : "MISSION FAILED"}
      </p>
      <h1 className="show-objective">{overlay.objective}</h1>
      {"placeName" in overlay && overlay.placeName && (
        <p className="show-place">📍 {overlay.placeName}</p>
      )}
      {heading && <p className="show-status">Heading to the destination…</p>}
      {overlay.state === "arrived" && (
        <div className="show-timer" role="timer">
          {timer(overlay.timerEndsAt - now)}
        </div>
      )}
      {terminal && (
        <p className="show-status">
          {overlay.state === "completed"
            ? "Challenge cleared!"
            : "On to the next one"}
        </p>
      )}
    </div>
  )
}

export function OverlaySource() {
  const [overlay, setOverlay] = useState<OverlayProjection | null>(null)
  const [error, setError] = useState("")
  const [now, setNow] = useState(Date.now())

  const refresh = useCallback(async () => {
    const key = fragmentKey()
    if (!key) {
      setError("Add the overlay access key after # in the browser-source URL.")
      return
    }
    try {
      const response = await fetch("/api/overlay", {
        headers: { Authorization: `Bearer ${key}` },
        cache: "no-store",
      })
      const body = await response.json()
      if (!response.ok) {
        throw new Error(
          response.status === 401
            ? "Overlay access key is invalid."
            : "Overlay data is temporarily unavailable."
        )
      }
      setOverlay(body.overlay)
      setError("")
    } catch (failure) {
      setError(
        failure instanceof Error
          ? failure.message
          : "Overlay data is temporarily unavailable."
      )
    }
  }, [])

  useEffect(() => {
    document.documentElement.classList.add("overlay-source-page")
    void refresh()
    const dataInterval = setInterval(() => void refresh(), 2000)
    const timerInterval = setInterval(() => setNow(Date.now()), 1000)
    return () => {
      document.documentElement.classList.remove("overlay-source-page")
      clearInterval(dataInterval)
      clearInterval(timerInterval)
    }
  }, [refresh])

  return (
    <main className="overlay-canvas">
      {overlay ? (
        <Card overlay={overlay} now={now} />
      ) : error ? (
        <div className="show-card show-card--error">
          <p className="show-kicker">OVERLAY SETUP</p>
          <p className="show-standby">{error}</p>
        </div>
      ) : null}
      {overlay && error && (
        <span className="show-connection-warning">Reconnecting…</span>
      )}
    </main>
  )
}
