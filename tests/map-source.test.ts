import { describe, expect, it } from "vitest"
import { decodePolyline } from "@/components/map-source"

describe("map source route geometry", () => {
  it("decodes a Google encoded polyline", () => {
    expect(decodePolyline("_p~iF~ps|U_ulLnnqC_mqNvxq`@")).toEqual([
      { lat: 38.5, lng: -120.2 },
      { lat: 40.7, lng: -120.95 },
      { lat: 43.252, lng: -126.453 },
    ])
  })

  it("fails closed for truncated route geometry", () => {
    expect(decodePolyline("_p~iF~ps|U_")).toEqual([])
  })
})
