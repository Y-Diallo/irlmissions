import type { ConsequenceClearRule } from "@/shared/pitches/processor"

/** The demo streamer starts in Union Square, San Francisco. */
export const DEMO_START = { latitude: 37.788, longitude: -122.4075 }

export type DemoPlace = {
  name: string
  address: string
  latitude: number
  longitude: number
  hours: string
}

// A scripted viewer pitch and what the fake AI "extracts" from it, so demo
// polls get clean titles and real San Francisco destinations.
export type DemoPitch = {
  /** Button text in the demo panel. */
  label: string
  group: "mission" | "edge"
  viewer: string
  text: string
  publicLabel: string
  durationMinutes: number
  funScore: number
  failConsequence?: string
  clearRule?: ConsequenceClearRule
  consequenceMinutes?: number
  riskFlag?: string
  automod?: true
  /** No place means the mission happens wherever the streamer is. */
  place?: DemoPlace
}

export const DEV_PITCH_PRESETS = {
  safe: {
    label: "Tic-tac-toe at the Ferry Building",
    group: "mission",
    viewer: "SourdoughSam",
    text: "Go to the Ferry Building and win tic-tac-toe against a stranger",
    publicLabel: "Win Tic-Tac-Toe at Market",
    durationMinutes: 10,
    funScore: 72,
    place: {
      name: "Ferry Building Marketplace",
      address: "1 Ferry Building, San Francisco, CA 94111",
      latitude: 37.7955,
      longitude: -122.3937,
      hours: "Open today 7 AM to 8 PM",
    },
  },
  consequence: {
    label: "Arcade with a timed consequence",
    group: "mission",
    viewer: "PierPete",
    text: "Go to Musée Mécanique and win an arcade game, if you lose no swearing for 10 minutes",
    publicLabel: "Win an Arcade Game",
    durationMinutes: 15,
    funScore: 81,
    failConsequence: "No swearing for 10 minutes.",
    clearRule: "timed",
    consequenceMinutes: 10,
    place: {
      name: "Musée Mécanique",
      address: "Pier 45 Shed A, San Francisco, CA 94133",
      latitude: 37.8094,
      longitude: -122.4159,
      hours: "Open today 10 AM to 8 PM",
    },
  },
  basketball: {
    label: "Play basketball (needs a court)",
    group: "mission",
    viewer: "HoopsHarper",
    text: "Go play basketball and hit 3 shots in a row",
    publicLabel: "Hit 3 Shots in a Row",
    durationMinutes: 15,
    funScore: 77,
    place: {
      name: "Margaret S. Hayward Playground",
      address: "1016 Laguna St, San Francisco, CA 94115",
      latitude: 37.781,
      longitude: -122.4265,
      hours: "Open today 6 AM to 10 PM",
    },
  },
  coit: {
    label: "Coit Tower, consequence at next stop",
    group: "mission",
    viewer: "HillClimber",
    text: "Walk up to Coit Tower without stopping, if you stop talk in a pirate voice until the next stop",
    publicLabel: "Reach the Tower Nonstop",
    durationMinutes: 25,
    funScore: 68,
    failConsequence: "Talk in a pirate voice.",
    clearRule: "at_next_stop",
    place: {
      name: "Coit Tower",
      address: "1 Telegraph Hill Blvd, San Francisco, CA 94133",
      latitude: 37.8024,
      longitude: -122.4058,
      hours: "Open today 10 AM to 6 PM",
    },
  },
  chinatown: {
    label: "Fortune cookie, manual consequence",
    group: "mission",
    viewer: "FogChaser",
    text: "Buy a fortune cookie in Chinatown and read it to chat, if you fail do 20 pushups",
    publicLabel: "Read a Fortune to Chat",
    durationMinutes: 10,
    funScore: 74,
    failConsequence: "Do 20 pushups.",
    clearRule: "manual",
    place: {
      name: "Golden Gate Fortune Cookie Factory",
      address: "56 Ross Alley, San Francisco, CA 94108",
      latitude: 37.7946,
      longitude: -122.4068,
      hours: "Open today 9 AM to 6 PM",
    },
  },
  sealions: {
    label: "Count the Pier 39 sea lions",
    group: "mission",
    viewer: "BayBridgeBea",
    text: "Find the sea lions at Pier 39 and count them live on stream",
    publicLabel: "Count the Sea Lions",
    durationMinutes: 10,
    funScore: 66,
    place: {
      name: "Pier 39",
      address: "Beach St & The Embarcadero, San Francisco, CA 94133",
      latitude: 37.8087,
      longitude: -122.4098,
      hours: "Open 24 hours",
    },
  },
  paintedLadies: {
    label: "Painted Ladies photo recreation",
    group: "mission",
    viewer: "CableCarCat",
    text: "Go to the Painted Ladies and recreate the Full House intro with strangers",
    publicLabel: "Recreate a TV Intro",
    durationMinutes: 15,
    funScore: 88,
    failConsequence: "Wear your hoodie backwards.",
    clearRule: "through_next_mission",
    place: {
      name: "Alamo Square",
      address: "Steiner St & Hayes St, San Francisco, CA 94117",
      latitude: 37.7764,
      longitude: -122.4346,
      hours: "Open today 5 AM to 12 AM",
    },
  },
  anywhere: {
    label: "No-travel pitch",
    group: "mission",
    viewer: "MissionMo",
    text: "Do ten jumping jacks without stopping",
    publicLabel: "Do 10 Jumping Jacks",
    durationMinutes: 5,
    funScore: 45,
  },
  safety: {
    label: "Safety-flagged pitch",
    group: "edge",
    viewer: "ChatGremlin",
    text: "Climb the construction scaffolding on Market Street for chat",
    publicLabel: "Climb the Scaffolding",
    durationMinutes: 10,
    funScore: 30,
    riskFlag: "Climbing scaffolding risks a serious fall.",
  },
  automod: {
    label: "AutoMod rejection",
    group: "edge",
    viewer: "ChatGremlin",
    text: "Go yell slurs at tourists on the cable car",
    publicLabel: "Rejected by AutoMod",
    durationMinutes: 10,
    funScore: 0,
    automod: true,
  },
} as const satisfies Record<string, DemoPitch>

export type DemoPresetKey = keyof typeof DEV_PITCH_PRESETS

/** Matches the exact scripted text, so other text keeps the generic fakes. */
export function demoPitchForText(text: string): DemoPitch | undefined {
  return Object.values(DEV_PITCH_PRESETS).find(
    (preset: DemoPitch) => preset.text === text
  )
}

export type DevAction =
  | { action: "inject_pitch"; preset: DemoPresetKey }
  | { action: "add_vote"; choice: number }
  | { action: "end_poll" }
  | { action: "move_toward" }
  | { action: "arrive" }
  | { action: "gps_lost" }
  | { action: "reset" }

export class DevError extends Error {
  constructor(
    public readonly code: string,
    public readonly status = 400
  ) {
    super(code)
  }
}

export function parseDevAction(value: unknown): DevAction {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new DevError("invalid_dev_action")
  }
  const input = value as Record<string, unknown>
  if (input.action === "inject_pitch") {
    if (
      typeof input.preset !== "string" ||
      !Object.hasOwn(DEV_PITCH_PRESETS, input.preset)
    ) {
      throw new DevError("invalid_dev_preset")
    }
    return {
      action: "inject_pitch",
      preset: input.preset as DemoPresetKey,
    }
  }
  if (input.action === "add_vote") {
    if (!Number.isInteger(input.choice) || (input.choice as number) < 0) {
      throw new DevError("invalid_dev_choice")
    }
    return { action: "add_vote", choice: input.choice as number }
  }
  if (
    input.action === "end_poll" ||
    input.action === "move_toward" ||
    input.action === "arrive" ||
    input.action === "gps_lost" ||
    input.action === "reset"
  ) {
    return { action: input.action }
  }
  throw new DevError("invalid_dev_action")
}
