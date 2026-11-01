"use client"

import { useCallback, useEffect, useRef, useState } from "react"
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { MissionCard } from "@/components/mission-card"
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
import type { PollRecord } from "@/shared/polls"
import type { MissionAction, MissionOwnerView } from "@/shared/missions"

const errors: Record<string, string> = {
  pitch_locked: "This pitch is locked by the current poll or mission.",
  pitch_not_ready: "This pitch has not finished processing.",
  pitch_not_editable: "This pitch cannot be edited in its current state.",
  pitch_not_approvable: "Only reviewed pitches can be approved.",
  pitch_not_rejectable: "Only reviewed pitches can be rejected.",
  pitch_not_retryable: "This pitch does not currently need a retry.",
  redemption_not_retryable: "This Twitch redemption does not need a retry.",
  public_label_reveals_destination:
    "The public label reveals the destination. Use a mystery objective instead.",
  invalid_public_label: "Public poll labels must be 1–25 characters.",
  invalid_poll_label: "Each Twitch poll choice must be 25 characters or less.",
  duplicate_poll_labels: "Poll choices must have different public labels.",
  poll_in_progress: "A poll is already being created or is live.",
  poll_creation_unknown:
    "Twitch may have created the poll. Reconcile it before trying again.",
  twitch_poll_rejected:
    "Twitch rejected the poll. Check for another live poll.",
  mission_in_progress: "Finish the current mission before starting a poll.",
  mission_not_arrived:
    "Mark the destination as arrived before choosing an outcome.",
  mission_finished: "This mission already has an outcome.",
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
}: {
  pitch: PitchReviewItem
  mutate: (pitch: PitchReviewItem, command: ReviewCommand) => Promise<void>
  processNow: (pitch: PitchReviewItem) => Promise<void>
  selected: boolean
  toggleSelected: (pitch: PitchReviewItem) => void
}) {
  const [rawText, setRawText] = useState(pitch.rawText)
  const [publicLabel, setPublicLabel] = useState(pitch.publicLabel)
  const [duration, setDuration] = useState(String(pitch.durationMinutes))
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState("")

  useEffect(() => {
    setRawText(pitch.rawText)
    setPublicLabel(pitch.publicLabel)
    setDuration(String(pitch.durationMinutes))
  }, [pitch])

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
  })
  const reviewed =
    pitch.reviewStatus === "pending_review" || pitch.reviewStatus === "approved"
  const rawEditable = reviewed
  const processing = pitch.reviewStatus === "processing"

  return (
    <Card className="border-border/80">
      <CardHeader>
        <CardTitle className="pr-2 text-lg">
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
                "Provider unavailable"} Attempts:{" "}
              {pitch.processing.attempts}.
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
            className="min-h-24 text-base"
            onChange={(event) => setRawText(event.target.value)}
          />
          {rawEditable && rawText.trim() !== pitch.rawText && (
            <Button
              className="min-h-12 w-full text-base sm:w-fit"
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

        {reviewed && pitch.destination && pitch.walkingRoute && (
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

            <div className="grid gap-4 sm:grid-cols-[1fr_8rem]">
              <div className="grid gap-2">
                <Label htmlFor={`label-${pitch.redemptionId}`}>
                  Public poll label — hide the destination
                </Label>
                <Textarea
                  id={`label-${pitch.redemptionId}`}
                  value={publicLabel}
                  maxLength={25}
                  disabled={busy || pitch.locked}
                  className="min-h-20 text-base"
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
                  className="min-h-12 text-base"
                  onChange={(event) => setDuration(event.target.value)}
                />
              </div>
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

      <CardFooter className="flex flex-col gap-3 sm:flex-row sm:flex-wrap">
        {processing && (
          <Button
            className="min-h-12 w-full text-base sm:w-auto"
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
            {pitch.processing?.status === "error" ? "Retry now" : "Process now"}
          </Button>
        )}
        {reviewed && (
          <>
            {pitch.reviewStatus === "approved" && (
              <Button
                className="min-h-12 w-full text-base sm:w-auto"
                variant={selected ? "secondary" : "outline"}
                disabled={busy || pitch.locked}
                onClick={() => toggleSelected(pitch)}
              >
                {selected ? "Remove from poll" : "Add to poll"}
              </Button>
            )}
            <Button
              className="min-h-12 w-full text-base sm:w-auto"
              variant="outline"
              disabled={busy || pitch.locked || !publicLabel.trim()}
              onClick={() => void act(() => mutate(pitch, detailsCommand()))}
            >
              Save details
            </Button>
            {pitch.reviewStatus !== "approved" && (
              <Button
                className="min-h-12 w-full text-base sm:w-auto"
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
            <Button
              className="min-h-12 w-full text-base sm:w-auto"
              variant="destructive"
              disabled={busy || pitch.locked}
              onClick={() =>
                void act(() => mutate(pitch, { action: "reject" }))
              }
            >
              Reject and refund
            </Button>
          </>
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
  }, [token])

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
    poll && ["creating", "create_unknown", "active"].includes(poll.status)
  const missionInProgress =
    mission && ["heading", "arrived"].includes(mission.status)
  const selectedPitches = [...selected].flatMap((redemptionId) => {
    const pitch = pitches.find(
      (candidate) => candidate.redemptionId === redemptionId
    )
    return pitch ? [pitch] : []
  })

  return (
    <section aria-labelledby="queue-heading" className="space-y-4">
      {warningToast && (
        <div
          role="status"
          className="fixed right-4 bottom-4 left-4 z-50 max-w-sm border-2 border-amber-700 bg-amber-100 p-4 font-medium text-amber-950 shadow-lg sm:left-auto"
        >
          {warningToast}
        </div>
      )}
      <div className="flex items-center justify-between gap-4">
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
          className="min-h-12"
          disabled={!signedIn || loading}
          onClick={() => void refresh()}
        >
          Refresh
        </Button>
      </div>
      {signedIn && mission && (
        <MissionCard mission={mission} onAction={missionAction} />
      )}
      {signedIn && (
        <Card>
          <CardHeader>
            <CardTitle className="text-lg">
              {poll?.status === "active" ? "Voting live" : "Next poll"}
            </CardTitle>
            <CardDescription>
              {poll?.status === "active"
                ? "Twitch chat is choosing the next objective."
                : missionInProgress
                  ? "Finish the current mission before starting another poll."
                  : "Choose 2–5 approved pitches. Poll labels never include the destination."}
            </CardDescription>
          </CardHeader>
          <CardContent className="gap-3">
            {pollInProgress ? (
              <ol className="list-decimal space-y-1 pl-5 text-sm">
                {poll.choices.map((choice) => (
                  <li key={choice.redemptionId}>{choice.title}</li>
                ))}
              </ol>
            ) : selectedPitches.length ? (
              <ol className="list-decimal space-y-1 pl-5 text-sm">
                {selectedPitches.map((pitch) => (
                  <li key={pitch.redemptionId}>{pitch.publicLabel}</li>
                ))}
              </ol>
            ) : (
              <p className="text-sm text-muted-foreground">
                No pitches selected yet.
              </p>
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
                className="min-h-12 w-full text-base sm:w-auto"
                disabled={pollBusy}
                onClick={() => void pollAction("/api/polls/reconcile")}
              >
                Reconcile with Twitch
              </Button>
            ) : poll?.status === "active" ? (
              <p className="text-sm text-muted-foreground">
                Waiting for Twitch poll completion.
              </p>
            ) : (
              <Button
                className="min-h-12 w-full text-base sm:w-auto"
                disabled={
                  pollBusy ||
                  !!missionInProgress ||
                  selected.size < 2 ||
                  selected.size > 5
                }
                onClick={() =>
                  void pollAction("/api/polls", {
                    redemptionIds: [...selected],
                    durationSeconds: 60,
                  })
                }
              >
                Start 60-second Twitch poll
              </Button>
            )}
          </CardFooter>
        </Card>
      )}
      {message && (
        <p role="status" className="text-sm text-muted-foreground">
          {message}
        </p>
      )}
      <div className="grid gap-4">
        {pitches.map((pitch) => (
          <PitchCard
            key={pitch.redemptionId}
            pitch={pitch}
            mutate={mutate}
            processNow={processNow}
            selected={selected.has(pitch.redemptionId)}
            toggleSelected={toggleSelected}
          />
        ))}
      </div>
    </section>
  )
}
