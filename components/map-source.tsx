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
  getZoom(): number | undefined
  fitBounds(
    bounds: BoundsInstance,
    padding?:
      number | { top: number; right: number; bottom: number; left: number }
  ): void
  getBounds():
    | {
        contains(point: LatLng): boolean
        getNorthEast(): { lat(): number; lng(): number }
        getSouthWest(): { lat(): number; lng(): number }
      }
    | undefined
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
const RECAP_HOLD_MS = 6_000
/** One color per poll position, readable on the default map tiles. */
/** Pin and path opacity while the location feed is quiet. */
const STALE_OPACITY = 0.4
const DESTINATION_PIN_ICON = {
  url: `data:image/svg+xml;charset=UTF-8,${encodeURIComponent(
    '<svg xmlns="http://www.w3.org/2000/svg" width="36" height="48" viewBox="0 0 36 48"><path d="M18 2C9.2 2 2 9.1 2 17.9 2 30 18 46 18 46s16-16 16-28.1C34 9.1 26.8 2 18 2Z" fill="#ff2f92" stroke="#111329" stroke-width="3"/><circle cx="18" cy="18" r="6" fill="#ffe04b" stroke="#111329" stroke-width="3"/></svg>'
  )}`,
}
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

/** On-screen geometry of an option label, in pixels (13px bold Arial). */
const LABEL_CHAR_WIDTH = 7.4
const LABEL_CHROME_WIDTH = 30
const LABEL_HEIGHT = 30
/** Where Google draws a default pin's label: on the pin head, above the tip. */
const PIN_HEAD_OFFSET = 29
const LABEL_GAP = 16

export type LabelSide = "above" | "right" | "left" | "below"
const SIDES: LabelSide[] = ["above", "right", "left", "below"]

type Rect = { left: number; top: number; right: number; bottom: number }

// Web Mercator pixel position at a zoom level, as Google Maps draws it.
function worldPixel(value: LatLng, zoom: number) {
  const scale = 256 * 2 ** zoom
  const sin = Math.sin((value.lat * Math.PI) / 180)
  return {
    x: ((value.lng + 180) / 360) * scale,
    y: (0.5 - Math.log((1 + sin) / (1 - sin)) / (4 * Math.PI)) * scale,
  }
}

export function labelWidth(text: string) {
  return text.length * LABEL_CHAR_WIDTH + LABEL_CHROME_WIDTH
}

// Mirrors the .map-option-label--{side} transforms in globals.css.
function labelRect(
  pin: { x: number; y: number },
  width: number,
  side: LabelSide
): Rect {
  const head = pin.y - PIN_HEAD_OFFSET
  const center =
    side === "above"
      ? { x: pin.x, y: head - 38 }
      : side === "below"
        ? { x: pin.x, y: head + 42 }
        : {
            x: pin.x + (side === "right" ? 1 : -1) * (width / 2 + LABEL_GAP),
            y: head,
          }
  return {
    left: center.x - width / 2,
    right: center.x + width / 2,
    top: center.y - LABEL_HEIGHT / 2,
    bottom: center.y + LABEL_HEIGHT / 2,
  }
}

function overlap(a: Rect, b: Rect) {
  const width = Math.min(a.right, b.right) - Math.max(a.left, b.left)
  const height = Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top)
  return width > 0 && height > 0 ? width * height : 0
}

function outside(rect: Rect, view: Rect) {
  const area = (rect.right - rect.left) * (rect.bottom - rect.top)
  return area - overlap(rect, view)
}

// Each label takes the first side of its pin (above, right, left, below)
// that clears the labels already placed and the map's edges; when none is
// clear, the side that covers the least.
export function placeOptionLabels(
  labels: Array<{ point: LatLng; text: string }>,
  zoom: number,
  viewport?: { north: number; south: number; east: number; west: number }
): LabelSide[] {
  const corner = viewport
    ? {
        topLeft: worldPixel({ lat: viewport.north, lng: viewport.west }, zoom),
        bottomRight: worldPixel(
          { lat: viewport.south, lng: viewport.east },
          zoom
        ),
      }
    : null
  const view: Rect | null = corner
    ? {
        left: corner.topLeft.x,
        top: corner.topLeft.y,
        right: corner.bottomRight.x,
        bottom: corner.bottomRight.y,
      }
    : null
  const placed: Rect[] = []
  return labels.map(({ point: value, text }) => {
    const pin = worldPixel(value, zoom)
    const width = labelWidth(text)
    let best = { side: SIDES[0]!, cost: Infinity, rect: null as Rect | null }
    for (const side of SIDES) {
      const rect = labelRect(pin, width, side)
      const cost =
        placed.reduce((sum, other) => sum + overlap(rect, other), 0) +
        (view ? outside(rect, view) : 0)
      if (cost < best.cost) best = { side, cost, rect }
      if (cost === 0) break
    }
    placed.push(best.rect!)
    return best.side
  })
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
    map.setZoom(14)
    return
  }
  const bounds = new api.LatLngBounds()
  points.forEach((value) => bounds.extend(value))
  // Generous margins so markers and labels never touch the edge; the top
  // also clears the state pill.
  map.fitBounds(bounds, { top: 120, right: 100, bottom: 100, left: 100 })
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
  const historyMarkersRef = useRef<MarkerInstance[]>([])
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
          // Under the option and winner tags (20+), but still above every
          // route line, since Google Maps draws lines beneath all markers.
          zIndex: 10,
        })
        setMapReady(true)
      } catch {
        if (!stopped) setError("Google Maps is not configured")
      }
    }
    void start()
    return () => {
      stopped = true
      historyMarkersRef.current.forEach((marker) => marker.setMap(null))
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

    // A quiet feed greys the pin and the walked trail instead of hiding them.
    const showPosition = (current: LatLng, stale: boolean) => {
      positionMarker.setPosition(current)
      positionMarker.setLabel({
        text: "YOU",
        className: cn(
          "map-position-label",
          stale && "map-position-label--stale"
        ),
      })
      positionMarker.setOpacity(stale ? STALE_OPACITY : 1)
      positionMarker.setMap(map)
      trailLine.setOptions({ strokeOpacity: stale ? STALE_OPACITY : 1 })
    }

    const clearHistory = () => {
      historyMarkersRef.current.forEach((marker) => marker.setMap(null))
      historyMarkersRef.current = []
    }

    const hidePositionAndClearTrail = () => {
      positionMarker.setMap(null)
      trailRef.current = []
      trailLine.setPath([])
    }

    if (projection.state === "idle") {
      clearOptionMarkers()
      clearHistory()
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
        clearHistory()
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
              icon: DESTINATION_PIN_ICON,
              title: `${option.position}. ${option.title} — ${option.destination.name}`,
              zIndex: 20 + option.position,
            })
        )
      }
      // A label flips to another side of its pin when it would cover a
      // nearby label or run off the map.
      const labelText = options.map((option) => {
        const percentage = totalVotes
          ? Math.round((option.votes / totalVotes) * 100)
          : 0
        return `${option.position} · ${percentage}% ${option.destination.name}`
      })
      const view = map.getBounds()
      const sides = placeOptionLabels(
        options.map((option, index) => ({
          point: point(option.destination),
          text: labelText[index]!,
        })),
        map.getZoom() ?? 14,
        view
          ? {
              north: view.getNorthEast().lat(),
              east: view.getNorthEast().lng(),
              south: view.getSouthWest().lat(),
              west: view.getSouthWest().lng(),
            }
          : undefined
      )
      options.forEach((option, index) => {
        const marker = optionMarkersRef.current[index]!
        marker.setPosition(point(option.destination))
        marker.setLabel({
          text: labelText[index]!,
          // The left edge matches this option's route color.
          className: cn(
            "map-option-label",
            `map-option-label--${((option.position - 1) % OPTION_ROUTE_COLORS.length) + 1}`,
            `map-option-label--${sides[index]}`
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
          strokeOpacity:
            (leading || !leaders.length ? 0.9 : 0.45) *
            (projection.positionStale ? STALE_OPACITY : 1),
          strokeWeight: leading ? 7 : 4,
          zIndex: leading ? 15 : 10,
        })
        line.setMap(map)
      })
      if (projection.position) {
        showPosition(point(projection.position), !!projection.positionStale)
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

    if (projection.state === "recap") {
      clearOptionMarkers()
      positionMarker.setMap(null)
      trailRef.current = []
      trailLine.setPath([])
      plannedLine.setPath([])
      destinationMarkerRef.current?.setMap(null)
      const history = projection.history?.length
        ? projection.history
        : projection.destination
          ? [
              {
                ...projection.destination,
                label: projection.destination.name,
                outcome: projection.outcome ?? "completed",
              },
            ]
          : []
      clearHistory()
      historyMarkersRef.current = history.map((item, index) => {
        const latest = index === history.length - 1
        return new api.Marker({
          map,
          position: point(item),
          icon: DESTINATION_PIN_ICON,
          title: `${item.label} at ${item.name}`,
          label: {
            text: `${item.outcome === "completed" ? "✓" : "✗"} ${item.name}`,
            className: cn(
              "map-history-label",
              `map-history-label--${item.outcome}`,
              latest && "map-history-label--latest"
            ),
          },
          // The mission that just ended sits on top.
          zIndex: latest ? 90 : 30 + index,
        })
      })
      const key = projection.missionKey ?? "recap"
      if (!recapPlayedRef.current.has(key)) {
        recapPlayedRef.current.add(key)
        setHiddenRecapKey("")
        fitPoints(
          map,
          api,
          history.map((item) => point(item))
        )
        clearTimeout(recapTimerRef.current)
        recapTimerRef.current = setTimeout(
          () => setHiddenRecapKey(key),
          RECAP_HOLD_MS
        )
      }
      return
    }
    clearHistory()

    const destination = projection.destination
    if (!destination) return
    const destinationPoint = point(destination)
    if (!destinationMarkerRef.current) {
      destinationMarkerRef.current = new api.Marker({
        map: null,
        icon: DESTINATION_PIN_ICON,
      })
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
    if (projection.state === "arrived") {
      // Paths are only for travelling.
      trailRef.current = []
      trailLine.setPath([])
    } else {
      const last = trailRef.current.at(-1)
      if (!last || distanceMeters(last, current) >= MIN_TRAIL_DISTANCE_METERS) {
        trailRef.current.push(current)
        trailLine.setPath(trailRef.current)
      }
    }
    showPosition(current, !!projection.positionStale)
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
      ? "VOTING"
      : projection?.state === "heading"
        ? "EN ROUTE"
        : projection?.state === "arrived"
          ? "ARRIVED"
          : projection?.outcome === "completed"
            ? "COMPLETE"
            : "FAILED"

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
        {visible && <div className="map-source__label">{stateLabel}</div>}
        {error && <div className="map-source__warning">{error}</div>}
      </motion.div>
    </main>
  )
}
