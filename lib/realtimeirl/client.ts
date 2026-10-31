import "client-only"

export type RealtimeIrlLocation = {
  latitude: number
  longitude: number
  observedAt: number
}

export async function subscribeRealtimeIrl(
  pullKey: string,
  onLocation: (location: RealtimeIrlLocation) => void
) {
  const RealtimeIRL = await import("@rtirl/api")
  let lastReportedAt = -1
  return RealtimeIRL.forPullKey(pullKey, { forceWebSockets: true }).addListener(
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
}
