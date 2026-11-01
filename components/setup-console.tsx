"use client"

import { useEffect, useState } from "react"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"

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
  const [busy, setBusy] = useState(false)
  const [travelMode, setTravelMode] = useState<TravelMode>("walk")

  async function load() {
    setBusy(true)
    try {
      const response = await ownerRequest("/api/setup")
      const body = await response.json()
      if (!response.ok) throw new Error(body.error ?? "Setup unavailable")
      setView(body)
      setMessage("")
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Setup unavailable")
    } finally {
      setBusy(false)
    }
  }

  useEffect(() => {
    void load()
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
      | "retry_twitch"
      | "rotate_overlay"
      | "enable_reward"
      | "disable_reward"
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

  const settings = view?.settings ?? {}
  const base =
    settings.baseZone && typeof settings.baseZone === "object"
      ? (settings.baseZone as Record<string, unknown>)
      : {}

  useEffect(() => {
    const saved = view?.settings?.travelMode
    setTravelMode(
      saved === "transit" || saved === "drive" || saved === "walk"
        ? saved
        : "walk"
    )
  }, [view])

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
                (!view.realtimeIrlConfigured ||
                  !view.overlayConfigured ||
                  !view.settings))
            }
            onClick={() =>
              void action(
                view.rewardEnabled ? "disable_reward" : "enable_reward"
              )
            }
          >
            {view.rewardEnabled ? "Disable pitch reward" : "Enable pitch reward"}
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
          <SetupNumber name="searchRadiusMeters" label="Search radius (m)" value={settings.searchRadiusMeters ?? 5000} />
          <SetupNumber name="defaultDurationMinutes" label="Mission minutes" value={settings.defaultDurationMinutes ?? 10} />
          <SetupNumber name="arrivalRadiusMeters" label="Arrival radius (m)" value={settings.arrivalRadiusMeters ?? 50} />
          <SetupNumber name="baseRadiusMeters" label="Home privacy radius (m)" value={base.radiusMeters ?? 150} />
          <SetupNumber name="latitude" label="Home latitude" value={base.latitude ?? ""} step="any" />
          <SetupNumber name="longitude" label="Home longitude" value={base.longitude ?? ""} step="any" />
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
          <input name="llmEnabled" type="checkbox" defaultChecked={settings.llmEnabled === true} />
          Use OpenAI pitch cleanup and flags
        </label>
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
          <p className="mt-3 break-all rounded bg-muted p-3 font-mono text-sm">
            {overlayUrl}
          </p>
        )}
      </section>
      {message && <p role="status">{message}</p>}
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
      <Input id={name} name={name} type="number" step={step} defaultValue={String(value)} required />
    </div>
  )
}
