"use client"

import { useEffect, useState } from "react"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import {
  automationPreset,
  DEFAULT_AUTOMATION_SETTINGS,
  parseAutomationSettings,
  type AutomationSettings,
  type ShortlistOrdering,
} from "@/shared/automation"

type SetupView = {
  twitchLogin: string | null
  twitchSetup: { status?: string; errorCode?: string }
  reward: { id: string; title?: string } | null
  rewardEnabled: boolean
  realtimeIrlConfigured: boolean
  overlayConfigured: boolean
  settings: Record<string, unknown> | null
}

type TravelMode = "walk" | "transit" | "drive"

async function ownerRequest(path: string, init?: RequestInit) {
  const { getBrowserFirebase } = await import("@/lib/firebase/client")
  const user = getBrowserFirebase().auth.currentUser
  if (!user) throw new Error("Sign in with Twitch first.")
  return fetch(path, {
    ...init,
    headers: {
      ...init?.headers,
      Authorization: `Bearer ${await user.getIdToken()}`,
    },
    cache: "no-store",
  })
}

export function SetupConsole() {
  const [view, setView] = useState<SetupView | null>(null)
  const [message, setMessage] = useState("Sign in, then load setup.")
  const [overlayUrl, setOverlayUrl] = useState("")
  const [mapUrl, setMapUrl] = useState("")
  const [busy, setBusy] = useState(false)
  const [endStreamBusy, setEndStreamBusy] = useState(false)
  const [confirmEndStream, setConfirmEndStream] = useState(false)
  const [endStreamMessage, setEndStreamMessage] = useState("")
  const [travelMode, setTravelMode] = useState<TravelMode>("walk")
  const [llmEnabled, setLlmEnabled] = useState(true)
  const [automation, setAutomation] = useState<AutomationSettings>(
    DEFAULT_AUTOMATION_SETTINGS
  )

  async function load() {
    setBusy(true)
    try {
      const response = await ownerRequest("/api/setup")
      const body = await response.json()
      if (!response.ok) throw new Error(body.error ?? "Setup unavailable")
      setView(body)
      const loadedSettings =
        body.settings && typeof body.settings === "object" ? body.settings : {}
      const savedMode = loadedSettings.travelMode
      setTravelMode(
        savedMode === "transit" || savedMode === "drive" || savedMode === "walk"
          ? savedMode
          : "walk"
      )
      setLlmEnabled(loadedSettings.llmEnabled === true)
      setAutomation(parseAutomationSettings(loadedSettings.automation))
      setMessage("")
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Setup unavailable")
    } finally {
      setBusy(false)
    }
  }

  useEffect(() => {
    const initialLoad = setTimeout(() => void load(), 0)
    return () => clearTimeout(initialLoad)
  }, [])

  async function save(form: FormData) {
    setBusy(true)
    try {
      const response = await ownerRequest("/api/setup", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          realtimeIrlPullKey: String(form.get("pullKey") ?? "") || undefined,
          searchRadiusMeters: Number(form.get("searchRadiusMeters")),
          defaultDurationMinutes: Number(form.get("defaultDurationMinutes")),
          travelMode: String(form.get("travelMode") ?? "walk"),
          arrivalRadiusMeters: Number(form.get("arrivalRadiusMeters")),
          llmEnabled: form.get("llmEnabled") === "on",
          automation,
          baseZone: {
            latitude: Number(form.get("latitude")),
            longitude: Number(form.get("longitude")),
            radiusMeters: Number(form.get("baseRadiusMeters")),
          },
        }),
      })
      const body = await response.json()
      if (!response.ok) throw new Error(body.error ?? "Could not save setup")
      setMessage("Settings saved.")
      await load()
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Could not save")
    } finally {
      setBusy(false)
    }
  }

  async function action(
    value:
      "retry_twitch" | "rotate_overlay" | "enable_reward" | "disable_reward"
  ) {
    setBusy(true)
    try {
      const response = await ownerRequest("/api/setup", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: value }),
      })
      const body = await response.json()
      if (!response.ok) throw new Error(body.error ?? "Setup action failed")
      if (typeof body.overlayUrl === "string") setOverlayUrl(body.overlayUrl)
      if (typeof body.mapUrl === "string") setMapUrl(body.mapUrl)
      setMessage(
        value === "rotate_overlay"
          ? "New OBS URL generated. Save it now; the secret is shown once."
          : value === "retry_twitch"
            ? "Twitch setup retried."
            : value === "enable_reward"
              ? "Pitch reward enabled."
              : "Pitch reward disabled."
      )
      await load()
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Setup action failed")
    } finally {
      setBusy(false)
    }
  }

  async function endStream() {
    if (!confirmEndStream) {
      setConfirmEndStream(true)
      setEndStreamMessage("")
      return
    }
    setEndStreamBusy(true)
    setEndStreamMessage("")
    try {
      const response = await ownerRequest("/api/stream/end", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "end_stream" }),
      })
      const result = await response.json()
      if (!response.ok) throw new Error(result.error ?? "unavailable")
      const queued = Number(result.refunds?.queued ?? 0)
      setConfirmEndStream(false)
      setEndStreamMessage(
        `Stream closed. ${queued} unused ${queued === 1 ? "pitch" : "pitches"} queued for refund.`
      )
      await load()
    } catch {
      setEndStreamMessage(
        "Could not finish every end-stream step. Intake may already be disabled; check the Twitch status and try again."
      )
    } finally {
      setEndStreamBusy(false)
    }
  }

  async function copyOverlayUrl(label: string, url: string) {
    try {
      await navigator.clipboard.writeText(url)
      setMessage(`${label} URL copied.`)
    } catch {
      setMessage(`Could not copy the ${label.toLowerCase()} URL.`)
    }
  }

  const settings = view?.settings ?? {}
  const base =
    settings.baseZone && typeof settings.baseZone === "object"
      ? (settings.baseZone as Record<string, unknown>)
      : {}

  return (
    <div className="space-y-6">
      <section className="rounded-lg border p-4">
        <p className="font-medium">
          Twitch: {view?.twitchSetup.status ?? "not connected"}
        </p>
        <p className="text-sm text-muted-foreground">
          {view?.reward
            ? `Reward ready: ${view.reward.title ?? view.reward.id}`
            : "The app creates a disabled 10-point pitch reward after login."}
        </p>
        <Button
          className="mt-3 min-h-12"
          variant="outline"
          disabled={busy}
          onClick={() => void action("retry_twitch")}
        >
          Retry Twitch setup
        </Button>
        {view?.reward && (
          <Button
            className="mt-3 min-h-12 sm:ml-3"
            disabled={
              busy ||
              (!view.rewardEnabled &&
                ((!view.realtimeIrlConfigured &&
                  view.settings?.noTravelMode !== true) ||
                  !view.overlayConfigured ||
                  !view.settings))
            }
            onClick={() =>
              void action(
                view.rewardEnabled ? "disable_reward" : "enable_reward"
              )
            }
          >
            {view.rewardEnabled
              ? "Disable pitch reward"
              : "Enable pitch reward"}
          </Button>
        )}
      </section>

      <form action={(form) => void save(form)} className="space-y-4">
        <div className="space-y-2">
          <Label htmlFor="pullKey">RealtimeIRL pull key</Label>
          <Input
            id="pullKey"
            name="pullKey"
            type="password"
            placeholder={
              view?.realtimeIrlConfigured
                ? "Saved — leave blank to keep it"
                : "Enter pull key"
            }
          />
        </div>
        <div className="grid gap-4 sm:grid-cols-2">
          <SetupNumber
            name="searchRadiusMeters"
            label="Search radius (m)"
            value={settings.searchRadiusMeters ?? 5000}
          />
          <SetupNumber
            name="defaultDurationMinutes"
            label="Mission minutes"
            value={settings.defaultDurationMinutes ?? 10}
          />
          <SetupNumber
            name="arrivalRadiusMeters"
            label="Arrival radius (m)"
            value={settings.arrivalRadiusMeters ?? 50}
          />
          <SetupNumber
            name="baseRadiusMeters"
            label="Privacy zone radius (m)"
            value={base.radiusMeters ?? 150}
          />
          <SetupNumber
            name="latitude"
            label="Privacy zone latitude"
            value={base.latitude ?? ""}
            step="any"
          />
          <SetupNumber
            name="longitude"
            label="Privacy zone longitude"
            value={base.longitude ?? ""}
            step="any"
          />
        </div>
        <fieldset className="space-y-2">
          <legend className="text-sm font-medium">Travel mode</legend>
          <input type="hidden" name="travelMode" value={travelMode} />
          <div className="grid grid-cols-3 gap-2" role="group">
            {(["walk", "transit", "drive"] as const).map((mode) => (
              <Button
                key={mode}
                type="button"
                className="min-h-12 capitalize"
                variant={travelMode === mode ? "default" : "outline"}
                aria-pressed={travelMode === mode}
                onClick={() => setTravelMode(mode)}
              >
                {mode}
              </Button>
            ))}
          </div>
          <p className="text-sm text-muted-foreground">
            Used for estimates and Google or Apple navigation links.
          </p>
        </fieldset>
        <label className="flex min-h-12 items-center gap-3">
          <input
            name="llmEnabled"
            type="checkbox"
            checked={llmEnabled}
            onChange={(event) => setLlmEnabled(event.target.checked)}
          />
          Use OpenAI pitch cleanup and flags
        </label>
        <section className="space-y-5 rounded-lg border p-4">
          <div>
            <h2 className="text-lg font-semibold">Automation</h2>
            <p className="text-sm text-muted-foreground">
              Presets fill these controls. You can change any option afterward.
            </p>
          </div>
          <div className="grid grid-cols-3 gap-2">
            {(["manual", "assisted", "full_auto"] as const).map((preset) => (
              <Button
                key={preset}
                type="button"
                className="min-h-12"
                variant={automation.preset === preset ? "default" : "outline"}
                onClick={() => setAutomation(automationPreset(preset))}
              >
                {preset === "full_auto"
                  ? "Full auto"
                  : `${preset[0]!.toUpperCase()}${preset.slice(1)}`}
              </Button>
            ))}
          </div>

          <AutomationToggle
            label="Auto approve clean pitches"
            checked={automation.autoApproval}
            onChange={(autoApproval) =>
              setAutomation((current) => ({ ...current, autoApproval }))
            }
          />
          <AutomationToggle
            label="Only auto approve subscribers, VIPs, or moderators"
            description="Flagged pitches always wait for you. To recognize VIPs and subs, sign out and sign in with Twitch again once."
            checked={automation.trustedViewersOnly}
            onChange={(trustedViewersOnly) =>
              setAutomation((current) => ({
                ...current,
                trustedViewersOnly,
              }))
            }
          />
          <div className="grid gap-4 sm:grid-cols-2">
            <AutomationNumber
              label="Veto window (seconds)"
              value={automation.vetoSeconds}
              min={0}
              max={600}
              onChange={(vetoSeconds) =>
                setAutomation((current) => ({ ...current, vetoSeconds }))
              }
            />
            <AutomationNumber
              label="Poll options"
              value={automation.shortlistSize}
              min={2}
              max={5}
              onChange={(shortlistSize) =>
                setAutomation((current) => ({ ...current, shortlistSize }))
              }
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor="shortlistOrdering">Shortlist ordering</Label>
            <select
              id="shortlistOrdering"
              className="min-h-12 w-full rounded-md border border-input bg-background px-3"
              value={automation.shortlistOrdering}
              onChange={(event) =>
                setAutomation((current) => ({
                  ...current,
                  shortlistOrdering: event.target.value as ShortlistOrdering,
                }))
              }
            >
              <option value="mixed">Mix: oldest, newest, then fun</option>
              <option value="oldest">Oldest first</option>
              <option value="newest">Newest first</option>
              <option value="fun">AI fun score</option>
              <option value="closest">Closest first</option>
            </select>
          </div>
          <AutomationNumber
            label="Refund after poll losses"
            value={automation.pollLossLimit}
            min={1}
            max={20}
            onChange={(pollLossLimit) =>
              setAutomation((current) => ({ ...current, pollLossLimit }))
            }
          />
          <AutomationToggle
            label="Automatically start the next poll"
            checked={automation.autoStartPoll}
            onChange={(autoStartPoll) =>
              setAutomation((current) => ({ ...current, autoStartPoll }))
            }
          />
          <div className="grid gap-4 sm:grid-cols-3">
            <AutomationNumber
              label="Auto poll length (seconds)"
              value={automation.pollDurationSeconds}
              min={15}
              max={1800}
              onChange={(pollDurationSeconds) =>
                setAutomation((current) => ({
                  ...current,
                  pollDurationSeconds,
                }))
              }
            />
            <AutomationNumber
              label="Wait after mission (seconds)"
              value={automation.postMissionDelaySeconds}
              min={0}
              max={300}
              onChange={(postMissionDelaySeconds) =>
                setAutomation((current) => ({
                  ...current,
                  postMissionDelaySeconds,
                }))
              }
            />
            <AutomationNumber
              label="Minimum eligible pitches"
              value={automation.minimumEligiblePitches}
              min={2}
              max={5}
              onChange={(minimumEligiblePitches) =>
                setAutomation((current) => ({
                  ...current,
                  minimumEligiblePitches,
                }))
              }
            />
          </div>
          <AutomationToggle
            label="Cap every consequence at the end of the next mission"
            description="Timers and other rules still apply; anything still owed clears when the next mission is marked complete or failed."
            checked={automation.capConsequencesAtNextMissionEnd}
            onChange={(capConsequencesAtNextMissionEnd) =>
              setAutomation((current) => ({
                ...current,
                capConsequencesAtNextMissionEnd,
              }))
            }
          />
        </section>
        <Button className="min-h-12" disabled={busy} type="submit">
          Save setup
        </Button>
      </form>

      <section className="rounded-lg border p-4">
        <Button
          className="min-h-12"
          variant="outline"
          disabled={busy}
          onClick={() => void action("rotate_overlay")}
        >
          {view?.overlayConfigured ? "Regenerate OBS URL" : "Generate OBS URL"}
        </Button>
        {overlayUrl && (
          <div className="mt-3 space-y-3">
            <div>
              <p className="mb-1 text-sm font-medium">Objectives overlay</p>
              <div className="grid gap-2 sm:grid-cols-[minmax(0,1fr)_auto]">
                <p className="rounded bg-muted p-3 font-mono text-sm break-all">
                  {overlayUrl}
                </p>
                <Button
                  type="button"
                  variant="outline"
                  className="min-h-12 w-full sm:w-auto"
                  onClick={() =>
                    void copyOverlayUrl("Objectives overlay", overlayUrl)
                  }
                >
                  Copy URL
                </Button>
              </div>
            </div>
            <div>
              <p className="mb-1 text-sm font-medium">Optional live map</p>
              <p className="mb-2 text-sm text-muted-foreground">
                The map publicly shows exactly where you&apos;re going.
              </p>
              <div className="grid gap-2 sm:grid-cols-[minmax(0,1fr)_auto]">
                <p className="rounded bg-muted p-3 font-mono text-sm break-all">
                  {mapUrl}
                </p>
                <Button
                  type="button"
                  variant="outline"
                  className="min-h-12 w-full sm:w-auto"
                  onClick={() => void copyOverlayUrl("Live map", mapUrl)}
                >
                  Copy URL
                </Button>
              </div>
            </div>
          </div>
        )}
      </section>
      <section className="rounded-lg border border-destructive/40 p-4">
        <h2 className="text-lg font-semibold">End stream</h2>
        <p className="mt-1 text-sm text-muted-foreground">
          Disables new pitches, cancels voting and any unstarted mission, then
          queues unused redemptions for refund.
        </p>
        {endStreamMessage && (
          <p role="status" className="mt-3 text-sm">
            {endStreamMessage}
          </p>
        )}
        <div className="mt-3 flex flex-col gap-2 sm:flex-row">
          <Button
            variant="destructive"
            className="min-h-12 w-full sm:w-auto"
            disabled={endStreamBusy}
            onClick={() => void endStream()}
          >
            {endStreamBusy
              ? "Ending stream…"
              : confirmEndStream
                ? "Tap again to end stream"
                : "End stream"}
          </Button>
          {confirmEndStream && (
            <Button
              variant="outline"
              className="min-h-12 w-full sm:w-auto"
              disabled={endStreamBusy}
              onClick={() => setConfirmEndStream(false)}
            >
              Keep streaming
            </Button>
          )}
        </div>
      </section>
      {message && <p role="status">{message}</p>}
    </div>
  )
}

function AutomationToggle({
  label,
  description,
  checked,
  onChange,
}: {
  label: string
  description?: string
  checked: boolean
  onChange: (checked: boolean) => void
}) {
  return (
    <label className="flex min-h-14 cursor-pointer items-center gap-3 text-base">
      <input
        type="checkbox"
        className="size-6 shrink-0 accent-primary"
        checked={checked}
        onChange={(event) => onChange(event.target.checked)}
      />
      <span>
        {label}
        {description && (
          <span className="block text-sm text-muted-foreground">
            {description}
          </span>
        )}
      </span>
    </label>
  )
}

function AutomationNumber({
  label,
  value,
  min,
  max,
  onChange,
}: {
  label: string
  value: number
  min: number
  max: number
  onChange: (value: number) => void
}) {
  const id = label.toLocaleLowerCase().replaceAll(/[^a-z0-9]+/g, "-")
  return (
    <div className="space-y-2">
      <Label htmlFor={id}>{label}</Label>
      <Input
        id={id}
        type="number"
        inputMode="numeric"
        min={min}
        max={max}
        value={value}
        className="min-h-12 text-base"
        onChange={(event) => onChange(Number(event.target.value))}
        // Clamp once editing ends; the server would otherwise silently fall
        // back to the default for an out-of-range value.
        onBlur={() =>
          onChange(Math.min(max, Math.max(min, Math.round(value) || min)))
        }
      />
    </div>
  )
}

function SetupNumber({
  name,
  label,
  value,
  step,
}: {
  name: string
  label: string
  value: unknown
  step?: string
}) {
  return (
    <div className="space-y-2">
      <Label htmlFor={name}>{label}</Label>
      <Input
        key={`${name}-${String(value)}`}
        id={name}
        name={name}
        type="number"
        step={step}
        defaultValue={String(value)}
        required
      />
    </div>
  )
}
