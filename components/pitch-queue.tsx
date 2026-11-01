"use client"

import { useCallback, useEffect, useRef, useState } from "react"
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { MissionCard } from "@/components/mission-card"
import { DevPanel } from "@/components/dev-panel"
import {
  Card,
  CardAction,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
} from "@/components/ui/card"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Textarea } from "@/components/ui/textarea"
import type { PitchReviewItem, ReviewCommand } from "@/shared/pitches/review"
import type { TravelMode } from "@/shared/pitches/processor"
import { DEFAULT_POLL_DURATION_SECONDS, type PollRecord } from "@/shared/polls"
import type { MissionAction, MissionOwnerView } from "@/shared/missions"

const errors: Record<string, string> = {
  pitch_locked: "This pitch is locked by the current poll or mission.",
  pitch_not_ready: "This pitch has not finished processing.",
  pitch_not_editable: "This pitch cannot be edited in its current state.",
  no_destination_found:
    "This pitch has no place yet. Edit it to name one and reprocess.",
  pitch_not_approvable: "Only reviewed pitches can be approved.",
  pitch_not_rejectable: "Only reviewed pitches can be rejected.",
  pitch_not_retryable: "This pitch does not currently need a retry.",
  redemption_not_retryable: "This Twitch redemption does not need a retry.",
  public_label_reveals_destination:
    "The public label includes the street address. Remove it before approving.",
  invalid_public_label: "Public poll labels must be 1–25 characters.",
  invalid_poll_label: "Each Twitch poll choice must be 25 characters or less.",
  duplicate_poll_labels: "Poll choices must have different public labels.",
  poll_in_progress: "A poll is already being created or is live.",
  poll_creation_unknown:
    "Twitch may have created the poll. Reconcile it before trying again.",
  twitch_poll_rejected:
    "Twitch rejected the poll. Check for another live poll.",
  mission_in_progress: "Finish the current mission before starting a poll.",
  poll_not_tied: "That poll is no longer tied. Refresh to see the result.",
  not_a_tied_choice: "Pick one of the tied choices.",
  poll_not_active: "That poll already ended. Refresh to see the result.",
  poll_still_active: "Twitch still shows the poll as live. Try again.",
  poll_end_failed:
    "Twitch's result couldn't be applied. Use Pick on a pitch instead.",
  pitch_not_pickable:
    "Only approved pitches that aren't in a poll can be picked.",
  mission_not_arrived:
    "Mark the destination as arrived before choosing an outcome.",
  mission_finished: "This mission already has an outcome.",
  mission_not_cancelable:
    "This mission has already started. Mark it complete or failed instead.",
  stream_mission_needs_outcome:
    "This mission has started. Mark it complete or failed, then end the stream.",
  stream_poll_needs_reconciliation:
    "Reconcile the uncertain Twitch poll before ending the stream.",
  unauthorized: "Your owner session ended. Sign in again.",
}

const processingErrors: Record<string, string> = {
  automod_unavailable: "Twitch AutoMod could not check this pitch.",
  openai_unavailable: "OpenAI could not clean up this pitch.",
  places_unavailable: "Google Places could not find destinations.",
  routes_unavailable: "Google Routes could not calculate the walk.",
  stale_location:
    "RealtimeIRL is offline or has not supplied a current location.",
  provider_unavailable: "An external provider was unavailable.",
}

function StatusBadge({ pitch }: { pitch: PitchReviewItem }) {
  if (pitch.redemptionResolution?.status === "error")
    return <Badge variant="destructive">Twitch retry needed</Badge>
  if (pitch.reviewStatus === "active_mission")
    return <Badge>Active mission</Badge>
  if (pitch.reviewStatus === "completed") return <Badge>Completed</Badge>
  if (pitch.reviewStatus === "failed")
    return <Badge variant="destructive">Failed</Badge>
  if (pitch.reviewStatus === "approved") return <Badge>Approved</Badge>
  if (pitch.reviewStatus === "rejected")
    return <Badge variant="outline">Rejected</Badge>
  if (pitch.processing?.status === "error")
    return <Badge variant="destructive">Needs retry</Badge>
  if (pitch.reviewStatus === "processing")
    return <Badge variant="secondary">Processing</Badge>
  return pitch.riskFlags.length ? (
    <Badge variant="destructive">Safety review</Badge>
  ) : (
    <Badge variant="secondary">Ready to review</Badge>
  )
}

function routeDistance(meters: number) {
  return meters < 1000
    ? `${Math.round(meters)} m`
    : `${(meters / 1000).toFixed(1)} km`
}

function travelLabel(mode: TravelMode | undefined) {
  if (mode === "drive") return "driving"
  if (mode === "transit") return "transit"
  return "walking"
}

function PitchCard({
  pitch,
  mutate,
  processNow,
  selected,
  toggleSelected,
  canPick,
  pick,
}: {
  pitch: PitchReviewItem
  mutate: (pitch: PitchReviewItem, command: ReviewCommand) => Promise<void>
  processNow: (pitch: PitchReviewItem) => Promise<void>
  selected: boolean
  toggleSelected: (pitch: PitchReviewItem) => void
  canPick: boolean
  pick: (pitch: PitchReviewItem) => Promise<void>
}) {
  const [rawText, setRawText] = useState(pitch.rawText)
  const [publicLabel, setPublicLabel] = useState(pitch.publicLabel)
  const [duration, setDuration] = useState(String(pitch.durationMinutes))
  const [failConsequence, setFailConsequence] = useState(
    pitch.failConsequence ?? ""
  )
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState("")
  const [confirmRemove, setConfirmRemove] = useState(false)
  const [processingDelayed, setProcessingDelayed] = useState(false)
  const serverRawText = useRef(pitch.rawText)
  const serverPublicLabel = useRef(pitch.publicLabel)
  const serverDuration = useRef(String(pitch.durationMinutes))
  const serverFailConsequence = useRef(pitch.failConsequence ?? "")

  useEffect(() => {
    const previous = serverRawText.current
    serverRawText.current = pitch.rawText
    setRawText((current) => (current === previous ? pitch.rawText : current))
  }, [pitch.rawText])

  useEffect(() => {
    const previous = serverPublicLabel.current
    serverPublicLabel.current = pitch.publicLabel
    setPublicLabel((current) =>
      current === previous ? pitch.publicLabel : current
    )
  }, [pitch.publicLabel])

  useEffect(() => {
    const next = String(pitch.durationMinutes)
    const previous = serverDuration.current
    serverDuration.current = next
    setDuration((current) => (current === previous ? next : current))
  }, [pitch.durationMinutes])

  useEffect(() => {
    const next = pitch.failConsequence ?? ""
    const previous = serverFailConsequence.current
    serverFailConsequence.current = next
    setFailConsequence((current) => (current === previous ? next : current))
  }, [pitch.failConsequence])

  useEffect(() => {
    if (
      pitch.reviewStatus !== "processing" ||
      pitch.processing?.status === "error"
    ) {
      return
    }
    const timeout = setTimeout(
      () => setProcessingDelayed(true),
      Math.max(0, pitch.createdAt + 30_000 - Date.now())
    )
    return () => clearTimeout(timeout)
  }, [pitch.createdAt, pitch.processing?.status, pitch.reviewStatus])

  async function act(action: () => Promise<void>) {
    setBusy(true)
    setMessage("")
    try {
      await action()
    } catch (error) {
      const code = error instanceof Error ? error.message : "unavailable"
      setMessage(errors[code] ?? "Could not update this pitch. Try again.")
    } finally {
      setBusy(false)
    }
  }

  const detailsCommand = (): ReviewCommand => ({
    action: "edit_details",
    publicLabel,
    durationMinutes: Number(duration),
    failConsequence,
  })
  const reviewed =
    pitch.reviewStatus === "pending_review" || pitch.reviewStatus === "approved"
  const rawEditable = reviewed || pitch.revivable
  const processing = pitch.reviewStatus === "processing"
  const terminal =
    pitch.reviewStatus === "completed" || pitch.reviewStatus === "failed"
  const removeRefunds =
    !terminal && pitch.redemptionResolution?.action !== "refund"

  const removeButton =
    pitch.reviewStatus === "active_mission" ? (
      <Button className="min-h-14 w-full text-base" variant="outline" disabled>
        Use the active mission controls
      </Button>
    ) : (
      <Button
        className="min-h-14 w-full text-base md:w-auto"
        variant="destructive"
        disabled={busy || pitch.locked}
        onClick={() => {
          if (!confirmRemove) {
            setConfirmRemove(true)
            return
          }
          void act(() => mutate(pitch, { action: "remove" }))
        }}
      >
        {pitch.locked
          ? "Locked in live poll"
          : confirmRemove
            ? removeRefunds
              ? "Tap again to remove and refund"
              : "Tap again to remove"
            : removeRefunds
              ? "Remove and refund"
              : "Remove from queue"}
      </Button>
    )

  if (terminal) {
    const summary =
      pitch.publicLabel || pitch.challenge || pitch.rawText || "Mission"
    return (
      <Card size="sm" className="gap-3 border-border/70 py-3 shadow-none">
        <CardHeader className="[grid-template-columns:minmax(0,1fr)_auto] gap-0 px-4">
          <CardTitle className="truncate pr-2 text-base">{summary}</CardTitle>
          <CardDescription className="truncate text-xs">
            {pitch.viewerName}
            {pitch.reviewStatus === "failed" && pitch.failConsequence
              ? ` · Consequence: ${pitch.failConsequence}`
              : ""}
          </CardDescription>
          <CardAction>
            <StatusBadge pitch={pitch} />
          </CardAction>
        </CardHeader>
        <CardFooter className="px-4">{removeButton}</CardFooter>
      </Card>
    )
  }

  return (
    <Card className="border-border/80">
      <CardHeader>
        <CardTitle className="pr-2 text-xl">
          {pitch.viewerName}&apos;s pitch
        </CardTitle>
        <CardDescription>
          {new Date(pitch.createdAt).toLocaleTimeString([], {
            hour: "numeric",
            minute: "2-digit",
          })}
        </CardDescription>
        <CardAction>
          <StatusBadge pitch={pitch} />
        </CardAction>
      </CardHeader>
      <CardContent className="gap-5">
        {pitch.riskFlags.length > 0 && (
          <Alert variant="destructive">
            <AlertTitle>Human safety decision required</AlertTitle>
            <AlertDescription>
              <ul className="list-disc space-y-1 pl-5">
                {pitch.riskFlags.map((flag, index) => (
                  <li key={`${flag.category}-${index}`}>
                    {flag.category}: {flag.reason}
                  </li>
                ))}
              </ul>
            </AlertDescription>
          </Alert>
        )}
        {pitch.processingWarnings.includes("stale_location") && (
          <Alert>
            <AlertTitle>Using last known location</AlertTitle>
            <AlertDescription>
              RealtimeIRL has not checked in recently. The destination and walk
              were calculated from the last saved location; verify them before
              approving.
            </AlertDescription>
          </Alert>
        )}
        {pitch.processing?.status === "error" && (
          <Alert variant="destructive">
            <AlertTitle>Processing stopped</AlertTitle>
            <AlertDescription>
              {processingErrors[pitch.processing.errorCode ?? ""] ??
                pitch.processing.errorCode ??
                "Provider unavailable"}{" "}
              Attempts: {pitch.processing.attempts}.
            </AlertDescription>
          </Alert>
        )}
        {pitch.redemptionResolution?.status === "error" && (
          <Alert variant="destructive">
            <AlertTitle>Twitch update failed</AlertTitle>
            <AlertDescription>
              {pitch.redemptionResolution.action === "refund"
                ? "The viewer has not been confirmed as refunded."
                : "The redemption has not been confirmed as fulfilled."}{" "}
              {pitch.redemptionResolution.errorCode ?? "Provider unavailable"}
            </AlertDescription>
          </Alert>
        )}

        <div className="grid gap-2">
          <Label htmlFor={`raw-${pitch.redemptionId}`}>Viewer pitch</Label>
          <Textarea
            id={`raw-${pitch.redemptionId}`}
            value={rawText}
            disabled={busy || pitch.locked || processing || !rawEditable}
            className="min-h-28 text-base"
            onChange={(event) => setRawText(event.target.value)}
          />
          {rawEditable && rawText.trim() !== pitch.rawText && (
            <Button
              className="min-h-14 w-full text-base md:w-fit"
              variant="outline"
              disabled={busy || !rawText.trim()}
              onClick={() =>
                void act(() => mutate(pitch, { action: "edit_raw", rawText }))
              }
            >
              Save pitch and reprocess
            </Button>
          )}
        </div>

        {(reviewed || pitch.revivable) && (
          <label className="flex min-h-14 cursor-pointer items-center gap-3 rounded-lg border p-3 text-base">
            <input
              type="checkbox"
              className="size-6 shrink-0 accent-primary"
              checked={pitch.anywhere}
              disabled={
                busy || pitch.locked || (pitch.anywhere && !pitch.noTravel)
              }
              onChange={(event) =>
                void act(() =>
                  mutate(pitch, {
                    action: "set_no_travel",
                    noTravel: event.target.checked,
                  })
                )
              }
            />
            <span>
              No travel (do it where I am)
              {pitch.anywhere && !pitch.noTravel && (
                <span className="block text-sm text-muted-foreground">
                  The pitch names no place. Edit it to add one.
                </span>
              )}
            </span>
          </label>
        )}
        {reviewed && pitch.anywhere && (
          <div className="rounded-lg bg-muted p-4">
            <p className="font-medium">Anywhere</p>
            <p className="mt-1 text-sm text-muted-foreground">
              No destination. If chosen, the timer starts right away.
            </p>
          </div>
        )}
        {reviewed &&
          !pitch.anywhere &&
          pitch.destination &&
          pitch.walkingRoute && (
            <>
              <div className="rounded-lg bg-muted p-4">
                <p className="font-medium">{pitch.destination.name}</p>
                <p className="mt-1 text-sm text-muted-foreground">
                  {pitch.destination.address}
                </p>
                <p className="mt-2 text-sm">
                  {routeDistance(pitch.walkingRoute.distanceMeters)} ·{" "}
                  {Math.max(
                    1,
                    Math.round(pitch.walkingRoute.durationSeconds / 60)
                  )}{" "}
                  min {travelLabel(pitch.walkingRoute.mode)}
                </p>
                <p className="mt-2 text-sm text-muted-foreground">
                  {pitch.destination.hoursText?.[0] ?? "Hours unknown"}
                </p>
                <p className="mt-3 text-xs text-muted-foreground">
                  <a
                    href={pitch.destination.googleMapsUri}
                    target="_blank"
                    rel="noreferrer"
                    className="underline underline-offset-2"
                  >
                    Google Maps
                  </a>
                  {pitch.destination.attributions.map((attribution) => (
                    <span
                      key={`${attribution.provider}-${attribution.providerUri}`}
                    >
                      {" · "}
                      <a
                        href={attribution.providerUri}
                        target="_blank"
                        rel="noreferrer"
                        className="underline underline-offset-2"
                      >
                        {attribution.provider}
                      </a>
                    </span>
                  ))}
                </p>
              </div>

              {pitch.duplicateSuggestions.length > 0 && (
                <Alert>
                  <AlertTitle>Possible duplicate</AlertTitle>
                  <AlertDescription>
                    {pitch.duplicateSuggestions
                      .map((duplicate) => duplicate.summary)
                      .join("; ")}
                  </AlertDescription>
                </Alert>
              )}
            </>
          )}

        {reviewed && (
          <div className="grid gap-4">
            <div className="grid gap-4 sm:grid-cols-[1fr_8rem]">
              <div className="grid gap-2">
                <Label htmlFor={`label-${pitch.redemptionId}`}>
                  Public poll label (no exact destination or street address)
                </Label>
                <Textarea
                  id={`label-${pitch.redemptionId}`}
                  value={publicLabel}
                  maxLength={25}
                  disabled={busy || pitch.locked}
                  className="min-h-24 text-base"
                  onChange={(event) => setPublicLabel(event.target.value)}
                />
              </div>
              <div className="grid content-start gap-2">
                <Label htmlFor={`duration-${pitch.redemptionId}`}>
                  Minutes
                </Label>
                <Input
                  id={`duration-${pitch.redemptionId}`}
                  type="number"
                  min={1}
                  max={120}
                  value={duration}
                  disabled={busy || pitch.locked}
                  className="min-h-14 text-base"
                  onChange={(event) => setDuration(event.target.value)}
                />
              </div>
            </div>
            <div className="grid gap-2">
              <Label htmlFor={`consequence-${pitch.redemptionId}`}>
                If failed (shown on stream)
              </Label>
              <Textarea
                id={`consequence-${pitch.redemptionId}`}
                value={failConsequence}
                maxLength={80}
                disabled={busy || pitch.locked}
                placeholder="A safe, playful consequence"
                className="min-h-24 text-base"
                onChange={(event) => setFailConsequence(event.target.value)}
              />
              <p className="text-xs text-muted-foreground">
                You can replace the generated consequence or leave it blank.
              </p>
            </div>
          </div>
        )}

        {pitch.reviewStatus === "rejected" && (
          <p className="text-sm text-muted-foreground">
            Rejected: {pitch.rejectionReason ?? "owner decision"}.{" "}
            {pitch.redemptionResolution?.status === "complete"
              ? "Refund confirmed."
              : pitch.redemptionResolution?.status === "error"
                ? "Refund needs retry."
                : "Refund queued."}
          </p>
        )}
        {message && (
          <p role="alert" className="text-sm text-destructive">
            {message}
          </p>
        )}
      </CardContent>

      <CardFooter className="grid grid-cols-1 gap-3 md:flex md:flex-row md:flex-wrap">
        {processing &&
          (pitch.processing?.status === "error" || processingDelayed) && (
            <Button
              className="min-h-14 w-full text-base md:w-auto"
              disabled={busy || pitch.locked}
              onClick={() =>
                void act(async () => {
                  if (pitch.processing?.status === "error") {
                    await mutate(pitch, { action: "retry" })
                  }
                  await processNow(pitch)
                })
              }
            >
              {pitch.processing?.status === "error"
                ? "Retry processing"
                : "Processing delayed — run now"}
            </Button>
          )}
        {reviewed && (
          <>
            {pitch.reviewStatus === "approved" && (
              <Button
                className="min-h-14 w-full text-base md:w-auto"
                variant={selected ? "secondary" : "outline"}
                disabled={busy || pitch.locked}
                onClick={() => toggleSelected(pitch)}
              >
                {selected ? "Remove from poll" : "Add to poll"}
              </Button>
            )}
            {pitch.reviewStatus === "approved" && (
              <Button
                className="min-h-14 w-full text-base md:w-auto"
                disabled={busy || !canPick}
                onClick={() => void act(() => pick(pitch))}
              >
                Pick
              </Button>
            )}
            <Button
              className="min-h-14 w-full text-base md:w-auto"
              variant="outline"
              disabled={busy || pitch.locked || !publicLabel.trim()}
              onClick={() => void act(() => mutate(pitch, detailsCommand()))}
            >
              Save details
            </Button>
            {pitch.reviewStatus !== "approved" && (
              <Button
                className="min-h-14 w-full text-base md:w-auto"
                disabled={busy || pitch.locked || !publicLabel.trim()}
                onClick={() =>
                  void act(async () => {
                    await mutate(pitch, detailsCommand())
                    await mutate(pitch, { action: "approve" })
                  })
                }
              >
                Approve
              </Button>
            )}
          </>
        )}
        {removeButton}
        {confirmRemove && !pitch.locked && (
          <Button
            className="min-h-14 w-full text-base md:w-auto"
            variant="outline"
            disabled={busy}
            onClick={() => setConfirmRemove(false)}
          >
            Keep pitch
          </Button>
        )}
      </CardFooter>
    </Card>
  )
}

export function PitchQueue() {
  const [pitches, setPitches] = useState<PitchReviewItem[]>([])
  const [poll, setPoll] = useState<PollRecord | null>(null)
  const [mission, setMission] = useState<MissionOwnerView | null>(null)
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [signedIn, setSignedIn] = useState(false)
  const [loading, setLoading] = useState(true)
  const [pollBusy, setPollBusy] = useState(false)
  const [pollMessage, setPollMessage] = useState("")
  const [noTravelMode, setNoTravelMode] = useState(false)
  const [mapCoarseMode, setMapCoarseMode] = useState(false)
  const [pollDuration, setPollDuration] = useState(
    String(DEFAULT_POLL_DURATION_SECONDS)
  )
  const [modeBusy, setModeBusy] = useState(false)
  const [endStreamBusy, setEndStreamBusy] = useState(false)
  const [confirmEndStream, setConfirmEndStream] = useState(false)
  const [endStreamMessage, setEndStreamMessage] = useState("")

  async function toggleNoTravelMode(enabled: boolean) {
    setModeBusy(true)
    setMessage("")
    try {
      const response = await fetch("/api/setup", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${await token()}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          action: enabled ? "no_travel_on" : "no_travel_off",
        }),
      })
      const result = await response.json()
      if (!response.ok) throw new Error(result.error ?? "unavailable")
      setNoTravelMode(result.noTravelMode === true)
    } catch {
      setMessage("Could not change no-travel mode. Try again.")
    } finally {
      setModeBusy(false)
    }
  }
  async function toggleMapCoarseMode(enabled: boolean) {
    setModeBusy(true)
    setMessage("")
    try {
      const response = await fetch("/api/setup", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${await token()}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          action: enabled ? "map_coarse_on" : "map_coarse_off",
        }),
      })
      const result = await response.json()
      if (!response.ok) throw new Error(result.error ?? "unavailable")
      setMapCoarseMode(result.mapCoarseMode === true)
    } catch {
      setMessage("Could not change map privacy mode. Try again.")
    } finally {
      setModeBusy(false)
    }
  }
  const [message, setMessage] = useState("Sign in to review pitches.")
  const [warningToast, setWarningToast] = useState("")
  const shownWarnings = useRef(new Set<string>())

  const token = useCallback(async () => {
    const { getBrowserFirebase } = await import("@/lib/firebase/client")
    const user = getBrowserFirebase().auth.currentUser
    if (!user) throw new Error("unauthorized")
    return user.getIdToken()
  }, [])

  const refresh = useCallback(async () => {
    try {
      const authorization = `Bearer ${await token()}`
      const [pitchResponse, pollResponse, missionResponse] = await Promise.all([
        fetch("/api/pitches", {
          headers: { Authorization: authorization },
          cache: "no-store",
        }),
        fetch("/api/polls", {
          headers: { Authorization: authorization },
          cache: "no-store",
        }),
        fetch("/api/missions", {
          headers: { Authorization: authorization },
          cache: "no-store",
        }),
      ])
      const [pitchBody, pollBody, missionBody] = await Promise.all([
        pitchResponse.json(),
        pollResponse.json(),
        missionResponse.json(),
      ])
      if (!pitchResponse.ok) {
        throw new Error(pitchBody.error ?? "unavailable")
      }
      if (!pollResponse.ok) throw new Error(pollBody.error ?? "unavailable")
      if (!missionResponse.ok) {
        throw new Error(missionBody.error ?? "unavailable")
      }
      const nextPitches = pitchBody.pitches as PitchReviewItem[]
      const newlyStale = nextPitches.find(
        (pitch) =>
          pitch.processingWarnings?.includes("stale_location") &&
          !shownWarnings.current.has(pitch.redemptionId)
      )
      if (newlyStale) {
        shownWarnings.current.add(newlyStale.redemptionId)
        setWarningToast(
          "Using the last known RealtimeIRL location. Verify the destination before approving."
        )
      }
      setPitches(nextPitches)
      setNoTravelMode(pitchBody.noTravelMode === true)
      setMapCoarseMode(pitchBody.mapCoarseMode === true)
      setPoll(pollBody.poll)
      setMission(missionBody.mission)
      setSelected((current) => {
        const selectable = new Set(
          nextPitches
            .filter(
              (pitch) => pitch.reviewStatus === "approved" && !pitch.locked
            )
            .map((pitch) => pitch.redemptionId)
        )
        return new Set([...current].filter((id) => selectable.has(id)))
      })
      setMessage(nextPitches.length ? "" : "No pitches yet.")
    } catch (error) {
      const code = error instanceof Error ? error.message : "unavailable"
      setMessage(errors[code] ?? "Could not load the queue.")
    } finally {
      setLoading(false)
    }
  }, [setMessage, setWarningToast, token])

  useEffect(() => {
    if (!warningToast) return
    const timeout = setTimeout(() => setWarningToast(""), 8_000)
    return () => clearTimeout(timeout)
  }, [warningToast])

  useEffect(() => {
    let active = true
    let interval: ReturnType<typeof setInterval> | undefined
    let unsubscribe = () => {}
    async function connect() {
      const [{ getBrowserFirebase }, { onAuthStateChanged }] =
        await Promise.all([
          import("@/lib/firebase/client"),
          import("firebase/auth"),
        ])
      if (!active) return
      unsubscribe = onAuthStateChanged(getBrowserFirebase().auth, (user) => {
        if (!active) return
        setSignedIn(!!user)
        setLoading(!!user)
        if (user) void refresh()
        else {
          setPitches([])
          setPoll(null)
          setMission(null)
          setSelected(new Set())
          shownWarnings.current.clear()
          setWarningToast("")
          setMessage("Sign in to review pitches.")
        }
      })
      interval = setInterval(() => {
        if (
          document.visibilityState === "visible" &&
          getBrowserFirebase().auth.currentUser
        ) {
          void refresh()
        }
      }, 10_000)
    }
    void connect()
    return () => {
      active = false
      unsubscribe()
      clearInterval(interval)
    }
  }, [refresh])

  async function mutate(pitch: PitchReviewItem, command: ReviewCommand) {
    const response = await fetch(
      `/api/pitches/${encodeURIComponent(pitch.redemptionId)}`,
      {
        method: "PATCH",
        headers: {
          Authorization: `Bearer ${await token()}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(command),
      }
    )
    const body = await response.json()
    if (!response.ok) throw new Error(body.error ?? "unavailable")
    await refresh()
  }

  async function processNow(pitch: PitchReviewItem) {
    const response = await fetch(
      `/api/pitches/${encodeURIComponent(pitch.redemptionId)}/process`,
      {
        method: "POST",
        headers: { Authorization: `Bearer ${await token()}` },
      }
    )
    const body = await response.json()
    if (!response.ok) throw new Error(body.error ?? "unavailable")
    await refresh()
  }

  function toggleSelected(pitch: PitchReviewItem) {
    setSelected((current) => {
      const next = new Set(current)
      if (next.has(pitch.redemptionId)) next.delete(pitch.redemptionId)
      else if (next.size < 5) next.add(pitch.redemptionId)
      return next
    })
  }

  async function pollAction(path: string, body?: unknown) {
    setPollBusy(true)
    setPollMessage("")
    try {
      const response = await fetch(path, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${await token()}`,
          ...(body ? { "Content-Type": "application/json" } : {}),
        },
        ...(body ? { body: JSON.stringify(body) } : {}),
      })
      const result = await response.json()
      if (!response.ok) throw new Error(result.error ?? "unavailable")
      setPoll(result.poll)
      if (result.reconciled === false) {
        setPollMessage(
          "Twitch still has no matching poll. Try reconcile again."
        )
      } else {
        setSelected(new Set())
      }
      await refresh()
    } catch (error) {
      const code = error instanceof Error ? error.message : "unavailable"
      setPollMessage(errors[code] ?? "Could not update the poll. Try again.")
      await refresh()
    } finally {
      setPollBusy(false)
    }
  }

  async function missionAction(action: MissionAction) {
    const response = await fetch("/api/missions", {
      method: "PATCH",
      headers: {
        Authorization: `Bearer ${await token()}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ action }),
    })
    const result = await response.json()
    if (!response.ok) {
      const code = result.error ?? "unavailable"
      throw new Error(
        errors[code] ?? "Could not update the mission. Try again."
      )
    }
    setMission(result.mission)
    await refresh()
  }

  const pollInProgress =
    poll &&
    ["creating", "create_unknown", "active", "tie"].includes(poll.status)
  const tied = poll?.status === "tie" ? (poll.tiedRedemptionIds ?? []) : []
  const pollLive =
    poll && ["creating", "create_unknown", "active"].includes(poll.status)

  async function pickPitch(pitch: PitchReviewItem) {
    const response = await fetch("/api/missions", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${await token()}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ redemptionId: pitch.redemptionId }),
    })
    const result = await response.json()
    if (!response.ok) throw new Error(result.error ?? "unavailable")
    setMission(result.mission)
    setSelected(new Set())
    await refresh()
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
      const response = await fetch("/api/stream/end", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${await token()}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ action: "end_stream" }),
      })
      const result = await response.json()
      if (!response.ok) throw new Error(result.error ?? "unavailable")
      setConfirmEndStream(false)
      setEndStreamMessage(
        `Stream closed. ${result.refunds?.queued ?? 0} unused ${
          result.refunds?.queued === 1 ? "pitch" : "pitches"
        } queued for refund.`
      )
      await refresh()
    } catch (error) {
      const code = error instanceof Error ? error.message : "unavailable"
      setEndStreamMessage(
        errors[code] ??
          "Could not finish every end-stream step. Intake may already be disabled; check setup and try again."
      )
    } finally {
      setEndStreamBusy(false)
    }
  }
  const missionInProgress =
    mission && ["heading", "arrived"].includes(mission.status)
  const selectedPitches = [...selected].flatMap((redemptionId) => {
    const pitch = pitches.find(
      (candidate) => candidate.redemptionId === redemptionId
    )
    return pitch ? [pitch] : []
  })
  const pollDurationSeconds = Number(pollDuration)
  const pollDurationValid =
    Number.isInteger(pollDurationSeconds) &&
    pollDurationSeconds >= 15 &&
    pollDurationSeconds <= 1800

  return (
    <section aria-labelledby="queue-heading" className="flex flex-col gap-4">
      {warningToast && (
        <div
          role="status"
          className="fixed right-4 bottom-4 left-4 z-50 max-w-sm border-2 border-amber-700 bg-amber-100 p-4 font-medium text-amber-950 shadow-lg sm:left-auto"
        >
          {warningToast}
        </div>
      )}
      <div className="order-0 grid grid-cols-[1fr_auto] items-center gap-4">
        <div>
          <p className="text-sm font-medium text-muted-foreground">
            Producer console
          </p>
          <h2
            id="queue-heading"
            className="text-2xl font-semibold tracking-tight"
          >
            Pitch queue
          </h2>
        </div>
        <Button
          variant="outline"
          className="min-h-14 min-w-24 text-base"
          disabled={!signedIn || loading}
          onClick={() => void refresh()}
        >
          Refresh
        </Button>
      </div>
      {signedIn && (
        <label className="order-4 flex min-h-14 cursor-pointer items-center gap-3 rounded-lg border p-4 text-base">
          <input
            type="checkbox"
            className="size-6 shrink-0 accent-primary"
            checked={noTravelMode}
            disabled={modeBusy}
            onChange={(event) => void toggleNoTravelMode(event.target.checked)}
          />
          <span>
            <span className="font-medium">No-travel mode</span>
            <span className="block text-sm text-muted-foreground">
              {noTravelMode
                ? "On: every mission happens where you are (e.g. in a game). No places are searched and the timer starts right away."
                : "Off: pitches are matched to real places nearby."}
            </span>
          </span>
        </label>
      )}
      {signedIn && (
        <label className="order-4 flex min-h-14 cursor-pointer items-center gap-3 rounded-lg border p-4 text-base">
          <input
            type="checkbox"
            className="size-6 shrink-0 accent-primary"
            checked={mapCoarseMode}
            disabled={modeBusy}
            onChange={(event) => void toggleMapCoarseMode(event.target.checked)}
          />
          <span>
            <span className="font-medium">Hide live map position</span>
            <span className="block text-sm text-muted-foreground">
              Shows the same coarse map used for unavailable GPS, with no marker
              or trail.
            </span>
          </span>
        </label>
      )}
      {signedIn && process.env.NEXT_PUBLIC_APP_MODE === "emulator" && (
        <div className="order-5">
          <DevPanel
            poll={poll}
            mission={mission}
            token={token}
            refresh={refresh}
          />
        </div>
      )}
      {signedIn && (
        <Card className="order-6 border-destructive/40">
          <CardHeader>
            <CardTitle className="text-lg">End stream</CardTitle>
            <CardDescription>
              Disables new pitches, cancels voting, cancels an unstarted
              mission, and queues every unused redemption for refund.
            </CardDescription>
          </CardHeader>
          <CardContent className="gap-3">
            {endStreamMessage && (
              <p role="status" className="text-sm text-muted-foreground">
                {endStreamMessage}
              </p>
            )}
          </CardContent>
          <CardFooter className="flex-col gap-2 sm:flex-row">
            <Button
              variant="destructive"
              className="min-h-14 w-full text-base sm:w-auto"
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
          </CardFooter>
        </Card>
      )}
      {signedIn && mission && (
        <div className="order-1">
          <MissionCard mission={mission} onAction={missionAction} />
        </div>
      )}
      {signedIn && (
        <Card className="order-2">
          <CardHeader>
            <CardTitle className="text-lg">
              {poll?.status === "active"
                ? "Voting live"
                : tied.length
                  ? "It's a tie, you pick"
                  : "Next poll"}
            </CardTitle>
            <CardDescription>
              {poll?.status === "active"
                ? "Twitch chat is choosing the next objective."
                : tied.length
                  ? "Chat tied. Pick the mission from the tied choices."
                  : missionInProgress
                    ? "Finish the current mission before starting another poll."
                    : "Choose 2–5 approved pitches. Poll labels never include the address."}
            </CardDescription>
          </CardHeader>
          <CardContent className="gap-3">
            {pollInProgress ? (
              <ol className="grid list-none gap-3 p-0 text-base">
                {poll.choices.map((choice) => (
                  <li
                    key={choice.redemptionId}
                    className="rounded-lg border bg-muted/40 p-3"
                  >
                    <div className="flex min-h-10 items-center justify-between gap-3">
                      <span className="font-medium">{choice.title}</span>
                      <Badge variant="outline">{choice.votes ?? 0} votes</Badge>
                    </div>
                    {tied.length > 0 && (
                      <span className="sr-only">Tied choice</span>
                    )}
                    {tied.includes(choice.redemptionId) && (
                      <Button
                        className="mt-2 min-h-14 w-full text-base"
                        disabled={pollBusy}
                        onClick={() =>
                          void pollAction("/api/polls/tiebreak", {
                            redemptionId: choice.redemptionId,
                          })
                        }
                      >
                        Pick this mission
                      </Button>
                    )}
                  </li>
                ))}
              </ol>
            ) : selectedPitches.length ? (
              <ol className="grid list-none gap-2 p-0 text-base">
                {selectedPitches.map((pitch, index) => (
                  <li
                    key={pitch.redemptionId}
                    className="flex min-h-12 items-center gap-3 rounded-lg border p-3"
                  >
                    <Badge variant="outline">{index + 1}</Badge>
                    <span className="font-medium">{pitch.publicLabel}</span>
                  </li>
                ))}
              </ol>
            ) : (
              <p className="text-sm text-muted-foreground">
                No pitches selected yet.
              </p>
            )}
            {!pollInProgress && (
              <div className="grid w-full gap-2 sm:max-w-64">
                <Label htmlFor="poll-duration">Poll length (seconds)</Label>
                <Input
                  id="poll-duration"
                  type="number"
                  min={15}
                  max={1800}
                  step={1}
                  value={pollDuration}
                  disabled={pollBusy || !!missionInProgress}
                  aria-invalid={!pollDurationValid}
                  className="min-h-14 text-lg"
                  onChange={(event) => setPollDuration(event.target.value)}
                />
                <p className="text-xs text-muted-foreground">
                  15–1800 seconds. Defaults to 120.
                </p>
              </div>
            )}
            {poll?.status === "create_unknown" && (
              <Alert variant="destructive">
                <AlertTitle>Poll creation needs reconciliation</AlertTitle>
                <AlertDescription>
                  The request had an uncertain result. The app will only look
                  for the matching Twitch poll; it will not create another one.
                </AlertDescription>
              </Alert>
            )}
            {pollMessage && (
              <p role="alert" className="text-sm text-destructive">
                {pollMessage}
              </p>
            )}
          </CardContent>
          <CardFooter>
            {poll?.status === "creating" ||
            poll?.status === "create_unknown" ? (
              <Button
                className="min-h-14 w-full text-base md:w-auto"
                disabled={pollBusy}
                onClick={() => void pollAction("/api/polls/reconcile")}
              >
                Reconcile with Twitch
              </Button>
            ) : poll?.status === "active" ? (
              <Button
                className="min-h-14 w-full text-base md:w-auto"
                variant="destructive"
                disabled={pollBusy}
                onClick={() => void pollAction("/api/polls/end")}
              >
                End poll now
              </Button>
            ) : tied.length ? null : (
              <Button
                className="min-h-14 w-full text-base md:w-auto"
                disabled={
                  pollBusy ||
                  !!missionInProgress ||
                  selected.size < 2 ||
                  selected.size > 5 ||
                  !pollDurationValid
                }
                onClick={() =>
                  void pollAction("/api/polls", {
                    redemptionIds: [...selected],
                    durationSeconds: pollDurationSeconds,
                  })
                }
              >
                {pollDurationValid
                  ? `Start ${pollDurationSeconds}-second Twitch poll`
                  : "Enter a valid poll length"}
              </Button>
            )}
          </CardFooter>
        </Card>
      )}
      {message && (
        <p role="status" className="order-3 text-base text-muted-foreground">
          {message}
        </p>
      )}
      <div className="order-3 grid gap-4">
        {pitches.map((pitch) => (
          <PitchCard
            key={pitch.redemptionId}
            pitch={pitch}
            mutate={mutate}
            processNow={processNow}
            selected={selected.has(pitch.redemptionId)}
            toggleSelected={toggleSelected}
            canPick={
              !missionInProgress &&
              !pollLive &&
              (!pitch.locked || tied.includes(pitch.redemptionId))
            }
            pick={pickPitch}
          />
        ))}
      </div>
    </section>
  )
}
