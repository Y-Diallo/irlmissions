"use client"

import { useCallback, useEffect, useRef, useState } from "react"
import type { MapPoint, MapProjection } from "@/shared/map"

type LatLng = { lat: number; lng: number }
type MapInstance = {
  panTo(point: LatLng): void
  setCenter(point: LatLng): void
  setZoom(zoom: number): void
}
type PolylineInstance = {
  setPath(path: LatLng[]): void
  setMap(map: null): void
}
type CircleInstance = {
  setCenter(point: LatLng): void
  setRadius(radius: number): void
  setMap(map: MapInstance | null): void
}
type MarkerInstance = {
  setPosition(point: LatLng): void
  setMap(map: MapInstance | null): void
}
type MapsApi = {
  Map: new (
    element: HTMLElement,
    options: Record<string, unknown>
  ) => MapInstance
  Polyline: new (options: Record<string, unknown>) => PolylineInstance
  Circle: new (options: Record<string, unknown>) => CircleInstance
  Marker: new (options: Record<string, unknown>) => MarkerInstance
}

declare global {
  interface Window {
    __irlMapsPromise?: Promise<MapsApi>
    google?: { maps?: MapsApi }
  }
}

const MIN_TRAIL_DISTANCE_METERS = 8

function fragmentKey() {
  return decodeURIComponent(window.location.hash.slice(1)).trim()
}

function point(value: MapPoint): LatLng {
  return { lat: value.latitude, lng: value.longitude }
}

function distanceMeters(a: LatLng, b: LatLng) {
  const radians = (value: number) => (value * Math.PI) / 180
  const latitude = radians(b.lat - a.lat)
  const longitude = radians(b.lng - a.lng)
  const first = radians(a.lat)
  const second = radians(b.lat)
  const haversine =
    Math.sin(latitude / 2) ** 2 +
    Math.cos(first) * Math.cos(second) * Math.sin(longitude / 2) ** 2
  return (
    6_371_000 * 2 * Math.atan2(Math.sqrt(haversine), Math.sqrt(1 - haversine))
  )
}

function loadMaps() {
  if (window.google?.maps) return Promise.resolve(window.google.maps)
  if (window.__irlMapsPromise) return window.__irlMapsPromise
  const key = process.env.NEXT_PUBLIC_GOOGLE_MAPS_BROWSER_KEY?.trim()
  if (!key) return Promise.reject(new Error("Map key is not configured"))
  window.__irlMapsPromise = new Promise<MapsApi>((resolve, reject) => {
    const script = document.createElement("script")
    script.src = `https://maps.googleapis.com/maps/api/js?key=${encodeURIComponent(key)}&v=weekly`
    script.async = true
    script.onload = () => {
      if (window.google?.maps) resolve(window.google.maps)
      else reject(new Error("Google Maps did not load"))
    }
    script.onerror = () => reject(new Error("Google Maps did not load"))
    document.head.appendChild(script)
  })
  return window.__irlMapsPromise
}

export function MapSource({ overlayId }: { overlayId: string }) {
  const elementRef = useRef<HTMLDivElement>(null)
  const mapRef = useRef<MapInstance | null>(null)
  const apiRef = useRef<MapsApi | null>(null)
  const trailRef = useRef<LatLng[]>([])
  const polylineRef = useRef<PolylineInstance | null>(null)
  const circleRef = useRef<CircleInstance | null>(null)
  const markerRef = useRef<MarkerInstance | null>(null)
  const missionKeyRef = useRef<string | undefined>(undefined)
  const [projection, setProjection] = useState<MapProjection | null>(null)
  const [error, setError] = useState("")

  const refresh = useCallback(async () => {
    const key = fragmentKey()
    if (!key) {
      setError("Map URL is missing its access key")
      return
    }
    try {
      const response = await fetch("/api/map", {
        headers: {
          Authorization: `Bearer ${key}`,
          "X-Overlay-Id": overlayId,
        },
        cache: "no-store",
      })
      const body = await response.json()
      if (!response.ok) throw new Error(body.error ?? "Map unavailable")
      setProjection(body as MapProjection)
      setError("")
    } catch {
      setError("Map reconnecting")
    }
  }, [overlayId])

  useEffect(() => {
    let stopped = false
    async function start() {
      try {
        const api = await loadMaps()
        if (stopped || !elementRef.current) return
        apiRef.current = api
        mapRef.current = new api.Map(elementRef.current, {
          center: { lat: 0, lng: 0 },
          zoom: 15,
          disableDefaultUI: true,
          clickableIcons: false,
          gestureHandling: "none",
          keyboardShortcuts: false,
          mapTypeControl: false,
          streetViewControl: false,
          fullscreenControl: false,
        })
        polylineRef.current = new api.Polyline({
          map: mapRef.current,
          path: [],
          geodesic: true,
          strokeColor: "#111827",
          strokeOpacity: 1,
          strokeWeight: 7,
        })
        circleRef.current = new api.Circle({
          map: null,
          fillColor: "#facc15",
          fillOpacity: 0.25,
          strokeColor: "#111827",
          strokeOpacity: 0.9,
          strokeWeight: 3,
        })
        markerRef.current = new api.Marker({ map: null })
      } catch {
        if (!stopped) setError("Google Maps is not configured")
      }
    }
    void start()
    return () => {
      stopped = true
      polylineRef.current?.setMap(null)
      circleRef.current?.setMap(null)
      markerRef.current?.setMap(null)
    }
  }, [])

  useEffect(() => {
    const initial = setTimeout(() => void refresh(), 0)
    const interval = setInterval(() => void refresh(), 2000)
    return () => {
      clearTimeout(initial)
      clearInterval(interval)
    }
  }, [refresh])

  useEffect(() => {
    const map = mapRef.current
    const api = apiRef.current
    const polyline = polylineRef.current
    const circle = circleRef.current
    const marker = markerRef.current
    if (!projection || !map || !api || !polyline || !circle || !marker) return

    if (projection.missionKey !== missionKeyRef.current) {
      trailRef.current = []
      polyline.setPath([])
      missionKeyRef.current = projection.missionKey
    }
    if (projection.state === "idle" || !projection.destination) {
      circle.setMap(null)
      marker.setMap(null)
      trailRef.current = []
      polyline.setPath([])
      return
    }

    const destination = {
      lat: projection.destination.latitude,
      lng: projection.destination.longitude,
    }
    circle.setCenter(destination)
    circle.setRadius(projection.destination.radiusMeters)
    circle.setMap(map)

    if (projection.positionStatus === "coarse") {
      // Clear rather than merely hide the track: when location returns, the
      // new path cannot draw a revealing line through the suppressed area.
      trailRef.current = []
      polyline.setPath([])
      marker.setMap(null)
      map.setCenter(destination)
      map.setZoom(10)
      return
    }

    if (
      projection.position &&
      (projection.state === "heading" || projection.state === "arrived")
    ) {
      const next = point(projection.position)
      const last = trailRef.current.at(-1)
      if (!last || distanceMeters(last, next) >= MIN_TRAIL_DISTANCE_METERS) {
        trailRef.current.push(next)
        polyline.setPath(trailRef.current)
      }
      marker.setPosition(next)
      marker.setMap(map)
      if (trailRef.current.length === 1) {
        map.setCenter(next)
        map.setZoom(15)
      } else {
        map.panTo(next)
      }
    }
  }, [projection])

  const hidden = !projection || projection.state === "idle"
  return (
    <main className={`map-source${hidden ? "map-source--hidden" : ""}`}>
      <div ref={elementRef} className="map-source__canvas" />
      {!hidden && (
        <div className="map-source__label">
          <strong>{projection.destination?.name ?? "DESTINATION ZONE"}</strong>
          <span>
            {projection.positionStatus === "coarse"
              ? "LOCATION UNAVAILABLE"
              : projection.state === "arrived"
                ? "ARRIVED"
                : "HEADING THERE"}
          </span>
        </div>
      )}
      {error && <div className="map-source__warning">{error}</div>}
    </main>
  )
}
