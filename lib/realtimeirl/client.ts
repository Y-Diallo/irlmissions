import "client-only"

export type RealtimeIrlLocation = {
  latitude: number
  longitude: number
  observedAt: number
  accuracyMeters?: number
  /** The RealtimeIRL session that reported it, when the feed says. */
  sessionId?: string
}

function sessionIdFrom(value: unknown) {
  return typeof value === "string" && value.length > 0 && value.length <= 128
    ? value
    : undefined
}

export async function subscribeRealtimeIrl(
  pullKey: string,
  onLocation: (location: RealtimeIrlLocation) => void,
  onHeartbeat?: (sessionId: string) => void
) {
  const RealtimeIRL = await import("@rtirl/api")
  const source = RealtimeIRL.forPullKey(pullKey, { forceWebSockets: true })
  let lastReportedAt = -1
  let sessionId: string | undefined
  const stopLocations = source.addListener((data: unknown) => {
    if (!data || typeof data !== "object" || Array.isArray(data)) return
    const root = data as Record<string, unknown>
    const location = root.location
    if (
      !location ||
      typeof location !== "object" ||
      Array.isArray(location) ||
      typeof root.reportedAt !== "number" ||
      !Number.isInteger(root.reportedAt) ||
      root.reportedAt <= lastReportedAt
    ) {
      return
    }
    const coordinates = location as Record<string, unknown>
    if (
      typeof coordinates.latitude !== "number" ||
      !Number.isFinite(coordinates.latitude) ||
      typeof coordinates.longitude !== "number" ||
      !Number.isFinite(coordinates.longitude)
    ) {
      return
    }
    lastReportedAt = root.reportedAt
    const reportedIn = sessionIdFrom(root.sessionId) ?? sessionId
    const accuracy =
      typeof coordinates.accuracy === "number"
        ? coordinates.accuracy
        : typeof coordinates.accuracyMeters === "number"
          ? coordinates.accuracyMeters
          : undefined
    onLocation({
      latitude: coordinates.latitude,
      longitude: coordinates.longitude,
      observedAt: root.reportedAt,
      ...(accuracy !== undefined && Number.isFinite(accuracy) && accuracy >= 0
        ? { accuracyMeters: accuracy }
        : {}),
      ...(reportedIn ? { sessionId: reportedIn } : {}),
    })
  })
  const stopSession = source.addSessionIdListener((value: unknown) => {
    sessionId = sessionIdFrom(value)
    if (sessionId) onHeartbeat?.(sessionId)
  })
  const heartbeatTimer = setInterval(() => {
    if (sessionId) onHeartbeat?.(sessionId)
  }, 15_000)

  return () => {
    clearInterval(heartbeatTimer)
    stopLocations()
    stopSession()
  }
}
