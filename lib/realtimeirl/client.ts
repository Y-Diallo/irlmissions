import "client-only"

export type RealtimeIrlLocation = {
  latitude: number
  longitude: number
  observedAt: number
}

export async function subscribeRealtimeIrl(
  pullKey: string,
  onLocation: (location: RealtimeIrlLocation) => void,
  onHeartbeat?: () => void
) {
  const RealtimeIRL = await import("@rtirl/api")
  const source = RealtimeIRL.forPullKey(pullKey, { forceWebSockets: true })
  let lastReportedAt = -1
  let online = false
  const stopLocations = source.addListener(
    (data: unknown) => {
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
      onLocation({
        latitude: coordinates.latitude,
        longitude: coordinates.longitude,
        observedAt: root.reportedAt,
      })
    }
  )
  const stopSession = source.addSessionIdListener((sessionId: unknown) => {
    online = typeof sessionId === "string" && sessionId.length > 0
    if (online) onHeartbeat?.()
  })
  const heartbeatTimer = setInterval(() => {
    if (online) onHeartbeat?.()
  }, 15_000)

  return () => {
    clearInterval(heartbeatTimer)
    stopLocations()
    stopSession()
  }
}
