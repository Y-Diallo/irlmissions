import { describe, expect, it } from "vitest"
import {
  decodePolyline,
  labelWidth,
  placeOptionLabels,
} from "@/components/map-source"

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

describe("poll option labels", () => {
  // Pier 39 and Musée Mécanique sit about 500 m apart; the Ferry Building
  // is further south-east.
  const pier39 = { lat: 37.8087, lng: -122.4098 }
  const musee = { lat: 37.8094, lng: -122.4159 }
  const ferry = { lat: 37.7955, lng: -122.3937 }
  const labels = [
    { point: pier39, text: "2 · 0% Pier 39" },
    { point: musee, text: "3 · 0% Musée Mécanique" },
    { point: ferry, text: "1 · 0% Ferry Building Marketplace" },
  ]

  it("keeps the full destination and flips a nearby label to another side", () => {
    const sides = placeOptionLabels(labels, 14)
    expect(sides[0]).toBe("above")
    expect(sides[1]).not.toBe("above")
    expect(labelWidth(labels[2]!.text)).toBeGreaterThan(200)
  })

  it("keeps every label above when nothing is close", () => {
    expect(placeOptionLabels(labels, 18)).toEqual(["above", "above", "above"])
  })

  it("flips a label away from the map edge", () => {
    // The Ferry Building pin near the right edge of the view.
    const side = placeOptionLabels([labels[2]!], 14, {
      north: 37.81,
      south: 37.78,
      west: -122.43,
      east: -122.392,
    })[0]
    expect(side).toBe("left")
  })
})
