import { describe, expect, it, vi } from "vitest"

const listener = vi.hoisted(() => ({ callback: (_value: unknown) => {} }))
const unsubscribe = vi.hoisted(() => vi.fn())

vi.mock("@rtirl/api", () => ({
  forPullKey: vi.fn(() => ({
    addListener: (callback: (value: unknown) => void) => {
      listener.callback = callback
      return unsubscribe
    },
  })),
}))

import { subscribeRealtimeIrl } from "@/lib/realtimeirl/client"

describe("RealtimeIRL browser adapter", () => {
  it("forwards only new locations with provider observation timestamps", async () => {
    const onLocation = vi.fn()
    const stop = await subscribeRealtimeIrl("pull-key", onLocation)
    listener.callback({
      location: { latitude: 37.78, longitude: -122.41 },
      reportedAt: 100,
    })
    listener.callback({
      location: { latitude: 37.78, longitude: -122.41 },
      reportedAt: 100,
      heartRate: 80,
    })
    listener.callback({
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
    expect(unsubscribe).toHaveBeenCalledOnce()
  })
})
