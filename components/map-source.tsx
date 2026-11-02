"use client"

import { useCallback, useEffect, useRef, useState } from "react"
import { motion } from "motion/react"
import type {
  MapPoint,
  MapProjection,
  PublicMapDestination,
} from "@/shared/map"
import { leadingIndexes } from "@/shared/polls"
import { cn } from "@/lib/utils"

type LatLng = { lat: number; lng: number }
type BoundsInstance = { extend(point: LatLng): void }
type MapInstance = {
  panTo(point: LatLng): void
  setCenter(point: LatLng): void
  setZoom(zoom: number): void
  fitBounds(bounds: BoundsInstance, padding?: number): void
  getBounds(): { contains(point: LatLng): boolean } | undefined
}
type PolylineInstance = {
  setPath(path: LatLng[]): void
  setMap(map: MapInstance | null): void
  setOptions(options: Record<string, unknown>): void
}
type MarkerInstance = {
  setPosition(point: LatLng): void
  setMap(map: MapInstance | null): void
  setLabel(label: string | Record<string, unknown>): void
  setOpacity(opacity: number): void
  setZIndex(zIndex: number): void
}
type MapsApi = {
  Map: new (
    element: HTMLElement,
    options: Record<string, unknown>
  ) => MapInstance
  Polyline: new (options: Record<string, unknown>) => PolylineInstance
  Marker: new (options: Record<string, unknown>) => MarkerInstance
  LatLngBounds: new () => BoundsInstance
}

declare global {
  interface Window {
    __irlMapsPromise?: Promise<MapsApi>
    google?: { maps?: MapsApi }
  }
}

const MIN_TRAIL_DISTANCE_METERS = 8
const RECAP_DRAW_MS = 2_000
const RECAP_HOLD_MS = 6_000
/** One color per poll position, readable on the default map tiles. */
const OPTION_ROUTE_COLORS = [
  "#7c3aed",
  "#db2777",
  "#ea580c",
  "#0891b2",
  "#16a34a",
]

function fragmentKey() {
  return decodeURIComponent(window.location.hash.slice(1)).trim()
}

function point(value: MapPoint | PublicMapDestination): LatLng {
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

export function decodePolyline(encoded: string): LatLng[] {
  const path: LatLng[] = []
  let index = 0
  let latitude = 0
  let longitude = 0
  while (index < encoded.length) {
    const read = () => {
      let result = 0
      let shift = 0
      let byte = 0
      do {
        if (index >= encoded.length) return null
        byte = encoded.charCodeAt(index++) - 63
        result |= (byte & 0x1f) << shift
        shift += 5
      } while (byte >= 0x20)
      return result & 1 ? ~(result >> 1) : result >> 1
    }
    const latitudeDelta = read()
    const longitudeDelta = read()
    if (latitudeDelta === null || longitudeDelta === null) return []
    latitude += latitudeDelta
    longitude += longitudeDelta
    path.push({ lat: latitude / 1e5, lng: longitude / 1e5 })
  }
  return path
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

function fitPoints(map: MapInstance, api: MapsApi, points: LatLng[]) {
  if (!points.length) return
  if (points.length === 1) {
    map.setCenter(points[0]!)
    map.setZoom(15)
    return
  }
  const bounds = new api.LatLngBounds()
  points.forEach((value) => bounds.extend(value))
  map.fitBounds(bounds, 64)
}

// Refit when this is a new framing or anything that matters has left view;
// otherwise hold still so the camera doesn't jitter every refresh.
function keepInView(
  map: MapInstance,
  api: MapsApi,
  points: LatLng[],
  changed: boolean
) {
  const bounds = map.getBounds()
  if (changed || !bounds || points.some((value) => !bounds.contains(value))) {
    fitPoints(map, api, points)
  }
}

export function MapSource({ overlayId }: { overlayId: string }) {
  const elementRef = useRef<HTMLDivElement>(null)
  const mapRef = useRef<MapInstance | null>(null)
  const apiRef = useRef<MapsApi | null>(null)
  const trailRef = useRef<LatLng[]>([])
  const trailLineRef = useRef<PolylineInstance | null>(null)
  const plannedLineRef = useRef<PolylineInstance | null>(null)
  const optionMarkersRef = useRef<MarkerInstance[]>([])
  const optionLinesRef = useRef<PolylineInstance[]>([])
  const destinationMarkerRef = useRef<MarkerInstance | null>(null)
  const positionMarkerRef = useRef<MarkerInstance | null>(null)
  const pollKeyRef = useRef<string | undefined>(undefined)
  const missionKeyRef = useRef<string | undefined>(undefined)
  const cameraKeyRef = useRef<string | undefined>(undefined)
  const recapPlayedRef = useRef(new Set<string>())
  const animationFrameRef = useRef<number | undefined>(undefined)
  const recapTimerRef = useRef<ReturnType<typeof setTimeout> | undefined>(
    undefined
  )
  const fadeTimerRef = useRef<ReturnType<typeof setTimeout> | undefined>(
    undefined
  )
  const [projection, setProjection] = useState<MapProjection | null>(null)
  const [mapReady, setMapReady] = useState(false)
  const [hiddenRecapKey, setHiddenRecapKey] = useState("")
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
        plannedLineRef.current = new api.Polyline({
          map: mapRef.current,
          path: [],
          geodesic: true,
          strokeOpacity: 0,
          icons: [
            {
              icon: {
                path: "M 0,-1 0,1",
                strokeColor: "#374151",
                strokeOpacity: 0.9,
                strokeWeight: 3,
                scale: 4,
              },
              offset: "0",
              repeat: "18px",
            },
          ],
        })
        trailLineRef.current = new api.Polyline({
          map: mapRef.current,
          path: [],
          geodesic: true,
          strokeColor: "#2563eb",
          strokeOpacity: 1,
          strokeWeight: 7,
        })
        positionMarkerRef.current = new api.Marker({
          map: null,
          label: { text: "YOU", className: "map-position-label" },
          zIndex: 100,
        })
        setMapReady(true)
      } catch {
        if (!stopped) setError("Google Maps is not configured")
      }
    }
    void start()
    return () => {
      stopped = true
      cancelAnimationFrame(animationFrameRef.current ?? 0)
      clearTimeout(recapTimerRef.current)
      clearTimeout(fadeTimerRef.current)
      plannedLineRef.current?.setMap(null)
      trailLineRef.current?.setMap(null)
      positionMarkerRef.current?.setMap(null)
      destinationMarkerRef.current?.setMap(null)
      optionMarkersRef.current.forEach((marker) => marker.setMap(null))
      optionLinesRef.current.forEach((line) => line.setMap(null))
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
    const trailLine = trailLineRef.current
    const plannedLine = plannedLineRef.current
    const positionMarker = positionMarkerRef.current
    if (
      !projection ||
      !mapReady ||
      !map ||
      !api ||
      !trailLine ||
      !plannedLine ||
      !positionMarker
    ) {
      return
    }

    const clearOptionMarkers = (fade = false) => {
      clearTimeout(fadeTimerRef.current)
      // Option routes go at once; only the markers fade.
      optionLinesRef.current.forEach((line) => line.setMap(null))
      optionLinesRef.current = []
      const markers = optionMarkersRef.current
      if (!fade) {
        markers.forEach((marker) => marker.setMap(null))
        optionMarkersRef.current = []
        return
      }
      markers.forEach((marker) => marker.setOpacity(0))
      fadeTimerRef.current = setTimeout(() => {
        markers.forEach((marker) => marker.setMap(null))
        optionMarkersRef.current = []
      }, 500)
    }

    const hidePositionAndClearTrail = () => {
      positionMarker.setMap(null)
      trailRef.current = []
      trailLine.setPath([])
    }

    if (projection.state === "idle") {
      clearOptionMarkers()
      destinationMarkerRef.current?.setMap(null)
      plannedLine.setPath([])
      hidePositionAndClearTrail()
      cameraKeyRef.current = undefined
      return
    }

    if (projection.state === "voting") {
      const pollKey = projection.pollKey ?? "voting"
      if (pollKeyRef.current !== pollKey) {
        clearOptionMarkers()
        destinationMarkerRef.current?.setMap(null)
        plannedLine.setPath([])
        hidePositionAndClearTrail()
        pollKeyRef.current = pollKey
        missionKeyRef.current = undefined
        cameraKeyRef.current = undefined
        setHiddenRecapKey("")
      }
      const options = projection.options ?? []
      const totalVotes = options.reduce((sum, option) => sum + option.votes, 0)
      if (optionMarkersRef.current.length !== options.length) {
        clearOptionMarkers()
        optionMarkersRef.current = options.map(
          (option) =>
            new api.Marker({
              map,
              position: point(option.destination),
              title: `${option.position}. ${option.title} — ${option.destination.name}`,
              zIndex: 20 + option.position,
            })
        )
      }
      options.forEach((option, index) => {
        const percentage = totalVotes
          ? Math.round((option.votes / totalVotes) * 100)
          : 0
        const marker = optionMarkersRef.current[index]!
        marker.setPosition(point(option.destination))
        marker.setLabel({
          text: `${option.position} · ${percentage}% ${option.destination.name}`,
          // The left edge matches this option's route color.
          className: cn(
            "map-option-label",
            `map-option-label--${((option.position - 1) % OPTION_ROUTE_COLORS.length) + 1}`
          ),
        })
        marker.setOpacity(1)
        marker.setZIndex(20 + option.position)
        marker.setMap(map)
      })
      // Each option's route from the streamer; the leader's is drawn on top.
      const leaders = totalVotes
        ? leadingIndexes(options.map((option) => option.votes))
        : []
      if (optionLinesRef.current.length !== options.length) {
        optionLinesRef.current.forEach((line) => line.setMap(null))
        optionLinesRef.current = options.map(
          () => new api.Polyline({ map, path: [], geodesic: true })
        )
      }
      options.forEach((option, index) => {
        const line = optionLinesRef.current[index]!
        const leading = leaders.includes(index)
        line.setPath(
          option.encodedRoute ? decodePolyline(option.encodedRoute) : []
        )
        line.setOptions({
          strokeColor:
            OPTION_ROUTE_COLORS[
              (option.position - 1) % OPTION_ROUTE_COLORS.length
            ],
          strokeOpacity: leading || !leaders.length ? 0.9 : 0.45,
          strokeWeight: leading ? 7 : 4,
          zIndex: leading ? 15 : 10,
        })
        line.setMap(map)
      })
      if (projection.position) {
        const current = point(projection.position)
        positionMarker.setPosition(current)
        positionMarker.setMap(map)
      } else {
        positionMarker.setMap(null)
      }
      // Reframe once the live position shows up, not just on the first fit.
      const cameraKey = `voting:${pollKey}:${projection.position ? "you" : "places"}`
      keepInView(
        map,
        api,
        [
          ...(projection.position ? [point(projection.position)] : []),
          ...options.map((option) => point(option.destination)),
        ],
        cameraKeyRef.current !== cameraKey
      )
      cameraKeyRef.current = cameraKey
      return
    }

    const destination = projection.destination
    if (!destination) return
    const destinationPoint = point(destination)
    if (!destinationMarkerRef.current) {
      destinationMarkerRef.current = new api.Marker({ map: null })
    }
    const destinationMarker = destinationMarkerRef.current
    destinationMarker.setPosition(destinationPoint)
    destinationMarker.setLabel({
      text:
        projection.state === "arrived"
          ? `✓ ${destination.name}`
          : destination.name,
      className:
        projection.state === "arrived"
          ? "map-winner-label map-winner-label--arrived"
          : "map-winner-label",
    })
    destinationMarker.setOpacity(1)
    destinationMarker.setZIndex(80)
    destinationMarker.setMap(map)
    plannedLine.setPath(
      projection.encodedRoute ? decodePolyline(projection.encodedRoute) : []
    )

    if (projection.state === "recap") {
      clearOptionMarkers()
      positionMarker.setMap(null)
      const key = projection.missionKey ?? "recap"
      if (!recapPlayedRef.current.has(key)) {
        recapPlayedRef.current.add(key)
        setHiddenRecapKey("")
        const recordedTrail = [...trailRef.current]
        const route = projection.encodedRoute
          ? decodePolyline(projection.encodedRoute)
          : []
        fitPoints(map, api, [
          ...(recordedTrail.length ? recordedTrail : route),
          destinationPoint,
        ])
        cancelAnimationFrame(animationFrameRef.current ?? 0)
        clearTimeout(recapTimerRef.current)
        const finish = () => {
          recapTimerRef.current = setTimeout(
            () => setHiddenRecapKey(key),
            RECAP_HOLD_MS
          )
        }
        if (!recordedTrail.length) {
          trailLine.setPath([])
          finish()
        } else {
          trailLine.setPath([])
          const startedAt = performance.now()
          const draw = (timestamp: number) => {
            const progress = Math.min(
              1,
              (timestamp - startedAt) / RECAP_DRAW_MS
            )
            const count = Math.max(
              1,
              Math.ceil(recordedTrail.length * progress)
            )
            trailLine.setPath(recordedTrail.slice(0, count))
            if (progress < 1)
              animationFrameRef.current = requestAnimationFrame(draw)
            else finish()
          }
          animationFrameRef.current = requestAnimationFrame(draw)
        }
      }
      return
    }

    const missionKey = projection.missionKey ?? "mission"
    if (missionKeyRef.current !== missionKey) {
      const cameFromVoting = !!pollKeyRef.current
      clearOptionMarkers(cameFromVoting)
      missionKeyRef.current = missionKey
      trailRef.current = []
      trailLine.setPath([])
      cameraKeyRef.current = undefined
    }

    if (!projection.position) {
      hidePositionAndClearTrail()
      // A distinct key so the camera reframes on you once GPS catches up.
      const cameraKey = `mission:${missionKey}:place`
      if (cameraKeyRef.current !== cameraKey) {
        fitPoints(map, api, [destinationPoint])
        cameraKeyRef.current = cameraKey
      }
      return
    }

    const current = point(projection.position)
    const last = trailRef.current.at(-1)
    if (!last || distanceMeters(last, current) >= MIN_TRAIL_DISTANCE_METERS) {
      trailRef.current.push(current)
      trailLine.setPath(trailRef.current)
    }
    positionMarker.setPosition(current)
    positionMarker.setMap(map)
    // You and the chosen place always share the frame.
    const cameraKey = `mission:${missionKey}:you`
    keepInView(
      map,
      api,
      [current, destinationPoint],
      cameraKeyRef.current !== cameraKey
    )
    cameraKeyRef.current = cameraKey
  }, [mapReady, projection])

  const recapHidden =
    projection?.state === "recap" && projection.missionKey === hiddenRecapKey
  const visible = !!projection && projection.state !== "idle" && !recapHidden
  const stateLabel =
    projection?.state === "voting"
      ? "CHAT IS VOTING"
      : projection?.state === "heading"
        ? "HEADING THERE"
        : projection?.state === "arrived"
          ? "ARRIVED"
          : projection?.outcome === "completed"
            ? "MISSION COMPLETE"
            : "MISSION FAILED"

  return (
    <main className="map-source">
      {/* Stays mounted: the Google Map lives inside, so only scale it. */}
      <motion.div
        className="map-source__card"
        initial={false}
        animate={visible ? { scale: 1, opacity: 1 } : { scale: 0, opacity: 0 }}
        transition={{
          scale: visible
            ? { type: "spring", stiffness: 260, damping: 18 }
            : { duration: 0.32, ease: [0.6, 0, 0.8, 0.2] },
          opacity: {
            duration: visible ? 0.12 : 0.2,
            delay: visible ? 0 : 0.14,
          },
        }}
      >
        <div ref={elementRef} className="map-source__canvas" />
        {visible && (
          <div className="map-source__label">
            <strong>MISSION MAP</strong>
            <span>{stateLabel}</span>
          </div>
        )}
        {error && <div className="map-source__warning">{error}</div>}
      </motion.div>
    </main>
  )
}
