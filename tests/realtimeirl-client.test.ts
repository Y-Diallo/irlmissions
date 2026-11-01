import { describe, expect, it, vi } from "vitest"

const listeners = vi.hoisted(() => ({
  location: (_value: unknown) => {},
  session: (_value: unknown) => {},
}))
const unsubscribeLocation = vi.hoisted(() => vi.fn())
const unsubscribeSession = vi.hoisted(() => vi.fn())

vi.mock("@rtirl/api", () => ({
  forPullKey: vi.fn(() => ({
    addListener: (callback: (value: unknown) => void) => {
      listeners.location = callback
      return unsubscribeLocation
    },
    addSessionIdListener: (callback: (value: unknown) => void) => {
      listeners.session = callback
      return unsubscribeSession
    },
  })),
}))

import { subscribeRealtimeIrl } from "@/lib/realtimeirl/client"

describe("RealtimeIRL browser adapter", () => {
  it("forwards only new locations with provider observation timestamps", async () => {
    const onLocation = vi.fn()
    const stop = await subscribeRealtimeIrl("pull-key", onLocation)
    listeners.location({
      location: { latitude: 37.78, longitude: -122.41 },
      reportedAt: 100,
    })
    listeners.location({
      location: { latitude: 37.78, longitude: -122.41 },
      reportedAt: 100,
      heartRate: 80,
    })
    listeners.location({
      location: { latitude: 37.7801, longitude: -122.41 },
      reportedAt: 101,
    })
    expect(onLocation).toHaveBeenCalledTimes(2)
    expect(onLocation).toHaveBeenLastCalledWith({
      latitude: 37.7801,
      longitude: -122.41,
      observedAt: 101,
    })
    stop()
    expect(unsubscribeLocation).toHaveBeenCalledOnce()
    expect(unsubscribeSession).toHaveBeenCalledOnce()
  })

  it("heartbeats only while the RealtimeIRL session is online", async () => {
    vi.useFakeTimers()
    const onHeartbeat = vi.fn()
    const stop = await subscribeRealtimeIrl("pull-key", vi.fn(), onHeartbeat)

    listeners.session("session-1")
    expect(onHeartbeat).toHaveBeenCalledOnce()
    await vi.advanceTimersByTimeAsync(30_000)
    expect(onHeartbeat).toHaveBeenCalledTimes(3)

    listeners.session(null)
    await vi.advanceTimersByTimeAsync(30_000)
    expect(onHeartbeat).toHaveBeenCalledTimes(3)

    stop()
    vi.useRealTimers()
  })
})
