import { describe, expect, it } from "vitest"
import { DEMO_START, DEV_PITCH_PRESETS, parseDevAction } from "@/shared/dev"
import { distanceMeters, validateExtraction } from "@/shared/pitches/processor"
import { createFakePitchProviders } from "@/shared/providers/fake-pitch"

describe("emulator dev actions", () => {
  it("accepts the manual judge controls", () => {
    expect(parseDevAction({ action: "inject_pitch", preset: "safe" })).toEqual({
      action: "inject_pitch",
      preset: "safe",
    })
    expect(parseDevAction({ action: "add_vote", choice: 1 })).toEqual({
      action: "add_vote",
      choice: 1,
    })
    for (const action of [
      "end_poll",
      "move_toward",
      "arrive",
      "gps_lost",
      "keep_alive",
      "overlay_links",
      "reset",
    ] as const) {
      expect(parseDevAction({ action })).toEqual({ action })
    }
  })

  it("rejects unknown presets and malformed vote indexes", () => {
    expect(() =>
      parseDevAction({ action: "inject_pitch", preset: "custom" })
    ).toThrow("invalid_dev_preset")
    expect(() => parseDevAction({ action: "add_vote", choice: -1 })).toThrow(
      "invalid_dev_choice"
    )
    expect(() => parseDevAction({ action: "delete_everything" })).toThrow(
      "invalid_dev_action"
    )
  })

  it("rejects inherited object keys as presets", () => {
    expect(() =>
      parseDevAction({ action: "inject_pitch", preset: "toString" })
    ).toThrow("invalid_dev_preset")
  })
})

describe("scripted San Francisco demo", () => {
  const providers = createFakePitchProviders()
  const origin = { ...DEMO_START, radiusMeters: 5000 }

  it("gives every preset a clean poll title and a nearby SF place", async () => {
    for (const [key, preset] of Object.entries(DEV_PITCH_PRESETS)) {
      const extraction = validateExtraction(
        await providers.extractor.extract(preset.text)
      )
      expect(extraction.publicLabelSuggestion, key).toBe(preset.publicLabel)
      expect(preset.publicLabel.length, key).toBeLessThanOrEqual(25)
      expect(preset.text, key).not.toMatch(/\[[a-z-]+\]/)
      if (!("place" in preset)) {
        expect(extraction.anywhere, key).toBe(true)
        continue
      }
      const [place] = await providers.places.search({
        query: extraction.placeQuery,
        origin,
        radiusMeters: origin.radiusMeters,
      })
      expect(place?.name, key).toBe(preset.place.name)
      expect(place?.address, key).toContain("San Francisco, CA")
      expect(distanceMeters(DEMO_START, place!), key).toBeLessThan(5000)
      const route = await providers.routes.walk(DEMO_START, place!, "walk")
      expect(route.distanceMeters, key).toBeGreaterThan(
        distanceMeters(DEMO_START, place!)
      )
    }
  })

  it("scripts consequences, flags, and AutoMod without visible markers", async () => {
    const arcade = await providers.extractor.extract(
      DEV_PITCH_PRESETS.consequence.text
    )
    expect(arcade).toMatchObject({
      failConsequence: "No swearing for 10 minutes.",
      consequenceClearRule: "timed",
      consequenceDurationMinutes: 10,
    })
    const risky = await providers.extractor.extract(
      DEV_PITCH_PRESETS.safety.text
    )
    expect(risky.riskFlags).toHaveLength(1)
    expect(
      await providers.automod.check({
        text: DEV_PITCH_PRESETS.automod.text,
      } as never)
    ).toBe(false)
    expect(
      await providers.automod.check({
        text: DEV_PITCH_PRESETS.safe.text,
      } as never)
    ).toBe(true)
  })
})
