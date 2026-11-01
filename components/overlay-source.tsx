"use client"

import { useCallback, useEffect, useState } from "react"
import type { OverlayProjection } from "@/shared/overlay"
import type { RealtimeIrlLocation } from "@/lib/realtimeirl/client"

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

type PhotoAttribution = {
  displayName: string
  uri?: string
  photoUri?: string
}

function Card({
  overlay,
  now,
  photo,
}: {
  overlay: OverlayProjection
  now: number
  photo: { uri: string; attributions: PhotoAttribution[] }
}) {
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
  const photoVisible = Boolean(photo.uri && "hasPlacePhoto" in overlay)
  return (
    <div
      className={`show-card show-card--${overlay.state} ${photoVisible ? "show-card--photo" : ""}`}
    >
      {photoVisible && (
        <div
          aria-label={
            "placeName" in overlay && overlay.placeName
              ? `Photo of ${overlay.placeName}`
              : "Destination photo"
          }
          className="show-photo"
          role="img"
          style={{
            backgroundImage: `url(${JSON.stringify(photo.uri).slice(1, -1)})`,
          }}
        />
      )}
      <div className="show-card-content">
        <div className="show-stage-row">
          <p className="show-kicker">
            {heading
              ? "NEXT MISSION"
              : overlay.state === "arrived"
                ? "MISSION ACTIVE"
                : overlay.state === "completed"
                  ? "MISSION COMPLETE"
                  : "MISSION FAILED"}
          </p>
          <span className={`show-state-pill show-state-pill--${overlay.state}`}>
            {heading
              ? "EN ROUTE"
              : overlay.state === "arrived"
                ? "LIVE"
                : overlay.state.toUpperCase()}
          </span>
        </div>
        <p className="show-label">CURRENT OBJECTIVE</p>
        <h1 className="show-objective">{overlay.objective}</h1>
        {"placeName" in overlay && overlay.placeName && (
          <p className="show-place">
            <span>DESTINATION</span>
            {overlay.placeName}
          </p>
        )}
        {heading && (
          <p className="show-status">
            Destination locked. Make your way there.
          </p>
        )}
        {overlay.state === "arrived" && (
          <div className="show-timer-block">
            <span>TIME REMAINING</span>
            <div className="show-timer" role="timer">
              {timer(overlay.timerEndsAt - now)}
            </div>
          </div>
        )}
        {terminal && (
          <p className="show-status show-status--terminal">
            {overlay.state === "completed"
              ? "Challenge cleared!"
              : "Mission logged — on to the next one"}
          </p>
        )}
        {photoVisible && photo.attributions.length > 0 && (
          <p className="show-photo-credit">
            Photo:{" "}
            {photo.attributions.map((attribution, index) => (
              <span key={`${attribution.displayName}-${index}`}>
                {index > 0 ? ", " : ""}
                {attribution.photoUri && (
                  <i
                    aria-hidden="true"
                    className="show-photo-author"
                    style={{
                      backgroundImage: `url(${JSON.stringify(attribution.photoUri).slice(1, -1)})`,
                    }}
                  />
                )}
                {attribution.uri ? (
                  <a href={attribution.uri} rel="noreferrer">
                    {attribution.displayName}
                  </a>
                ) : (
                  attribution.displayName
                )}
              </span>
            ))}
          </p>
        )}
      </div>
    </div>
  )
}

export function OverlaySource({ overlayId }: { overlayId?: string }) {
  const [overlay, setOverlay] = useState<OverlayProjection | null>(null)
  const [error, setError] = useState("")
  const [locationError, setLocationError] = useState("")
  const [photo, setPhoto] = useState<{
    version: number
    uri: string
    attributions: PhotoAttribution[]
  }>({ version: 0, uri: "", attributions: [] })
  const [now, setNow] = useState(0)
  const photoVersion =
    overlay && "hasPlacePhoto" in overlay && overlay.hasPlacePhoto
      ? overlay.updatedAt
      : null

  const refresh = useCallback(async () => {
    const key = fragmentKey()
    if (!key) {
      setError("Add the overlay access key after # in the browser-source URL.")
      return
    }
    try {
      const response = await fetch("/api/overlay", {
        headers: {
          Authorization: `Bearer ${key}`,
          "X-Overlay-Id": overlayId ?? "",
        },
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
  }, [overlayId])

  useEffect(() => {
    if (photoVersion === null) return
    const key = fragmentKey()
    if (!key) return
    let stopped = false
    const load = async () => {
      try {
        const response = await fetch("/api/overlay/photo", {
          headers: {
            Authorization: `Bearer ${key}`,
            "X-Overlay-Id": overlayId ?? "",
          },
          cache: "no-store",
        })
        const body = await response.json()
        if (!response.ok || typeof body.photoUri !== "string") return
        const attributions: PhotoAttribution[] = Array.isArray(
          body.authorAttributions
        )
          ? body.authorAttributions.flatMap((value: unknown) => {
              if (!value || typeof value !== "object") return []
              const attribution = value as Record<string, unknown>
              if (typeof attribution.displayName !== "string") return []
              return [
                {
                  displayName: attribution.displayName,
                  ...(typeof attribution.uri === "string"
                    ? { uri: attribution.uri }
                    : {}),
                  ...(typeof attribution.photoUri === "string"
                    ? { photoUri: attribution.photoUri }
                    : {}),
                },
              ]
            })
          : []
        if (!stopped) {
          setPhoto({
            version: photoVersion,
            uri: body.photoUri,
            attributions,
          })
        }
      } catch {
        // The objective card remains fully usable without optional photography.
      }
    }
    void load()
    return () => {
      stopped = true
    }
  }, [photoVersion, overlayId])

  useEffect(() => {
    const key = fragmentKey()
    if (!key) return
    let stopped = false
    let unsubscribe: (() => void) | undefined

    const sendLocation = async (location: RealtimeIrlLocation) => {
      try {
        const response = await fetch("/api/realtimeirl/location", {
          method: "POST",
          headers: {
            Authorization: `Bearer ${key}`,
            "X-Overlay-Id": overlayId ?? "",
            "Content-Type": "application/json",
          },
          body: JSON.stringify(location),
        })
        if (!response.ok) throw new Error("Location update failed")
        if (!stopped) setLocationError("")
      } catch {
        if (!stopped) setLocationError("Location disconnected")
      }
    }

    const sendHeartbeat = async () => {
      try {
        const response = await fetch("/api/realtimeirl/heartbeat", {
          method: "POST",
          headers: {
            Authorization: `Bearer ${key}`,
            "X-Overlay-Id": overlayId ?? "",
          },
        })
        if (!response.ok && response.status !== 409) {
          throw new Error("Location heartbeat failed")
        }
        if (!stopped) setLocationError("")
      } catch {
        if (!stopped) setLocationError("Location disconnected")
      }
    }

    const start = async () => {
      try {
        const response = await fetch("/api/realtimeirl/config", {
          headers: {
            Authorization: `Bearer ${key}`,
            "X-Overlay-Id": overlayId ?? "",
          },
          cache: "no-store",
        })
        const body = await response.json()
        if (!response.ok || typeof body.pullKey !== "string") {
          throw new Error("RealtimeIRL is not configured")
        }
        const { subscribeRealtimeIrl } =
          await import("@/lib/realtimeirl/client")
        const stop = await subscribeRealtimeIrl(
          body.pullKey,
          (location) => {
            void sendLocation(location)
          },
          () => void sendHeartbeat()
        )
        if (stopped) stop()
        else {
          unsubscribe = stop
          setLocationError("")
        }
      } catch {
        if (!stopped) setLocationError("Location disconnected")
      }
    }

    void start()
    return () => {
      stopped = true
      unsubscribe?.()
    }
  }, [overlayId])

  useEffect(() => {
    document.documentElement.classList.add("overlay-source-page")
    const initialRefresh = setTimeout(() => void refresh(), 0)
    const dataInterval = setInterval(() => void refresh(), 2000)
    const timerInterval = setInterval(() => setNow(Date.now()), 1000)
    return () => {
      document.documentElement.classList.remove("overlay-source-page")
      clearTimeout(initialRefresh)
      clearInterval(dataInterval)
      clearInterval(timerInterval)
    }
  }, [refresh])

  return (
    <main className="overlay-canvas">
      {overlay ? (
        <Card
          overlay={overlay}
          now={now}
          photo={
            photo.version === photoVersion
              ? photo
              : { uri: "", attributions: [] }
          }
        />
      ) : error ? (
        <div className="show-card show-card--error">
          <p className="show-kicker">OVERLAY SETUP</p>
          <p className="show-standby">{error}</p>
        </div>
      ) : null}
      {overlay && error && (
        <span className="show-connection-warning">Reconnecting…</span>
      )}
      {overlay && !error && locationError && (
        <span className="show-connection-warning">{locationError}</span>
      )}
    </main>
  )
}
