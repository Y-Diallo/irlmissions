"use client"

import { useCallback, useEffect, useState } from "react"
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
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

const errors: Record<string, string> = {
  pitch_locked: "This pitch is locked by the current poll or mission.",
  pitch_not_ready: "This pitch has not finished processing.",
  pitch_not_editable: "This pitch cannot be edited in its current state.",
  pitch_not_approvable: "Only reviewed pitches can be approved.",
  pitch_not_rejectable: "Only reviewed pitches can be rejected.",
  pitch_not_retryable: "This pitch does not currently need a retry.",
  public_label_reveals_destination:
    "The public label reveals the destination. Use a mystery objective instead.",
  unauthorized: "Your owner session ended. Sign in again.",
}

function StatusBadge({ pitch }: { pitch: PitchReviewItem }) {
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

function walkingDistance(meters: number) {
  return meters < 1000
    ? `${Math.round(meters)} m walk`
    : `${(meters / 1000).toFixed(1)} km walk`
}

function PitchCard({
  pitch,
  mutate,
  processNow,
}: {
  pitch: PitchReviewItem
  mutate: (pitch: PitchReviewItem, command: ReviewCommand) => Promise<void>
  processNow: (pitch: PitchReviewItem) => Promise<void>
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
  const rawEditable = reviewed || pitch.reviewStatus === "rejected"
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
        {pitch.processing?.status === "error" && (
          <Alert variant="destructive">
            <AlertTitle>Processing stopped</AlertTitle>
            <AlertDescription>
              {pitch.processing.errorCode ?? "Provider unavailable"}. Attempts:{" "}
              {pitch.processing.attempts}.
            </AlertDescription>
          </Alert>
        )}

        <div className="grid gap-2">
          <Label htmlFor={`raw-${pitch.redemptionId}`}>Viewer pitch</Label>
          <Textarea
            id={`raw-${pitch.redemptionId}`}
            value={rawText}
            disabled={busy || pitch.locked || processing}
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
                {walkingDistance(pitch.walkingRoute.distanceMeters)} ·{" "}
                {Math.max(
                  1,
                  Math.round(pitch.walkingRoute.durationSeconds / 60)
                )}{" "}
                min
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
                  maxLength={80}
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
            Rejected: {pitch.rejectionReason ?? "owner decision"}
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
              Reject and refund later
            </Button>
          </>
        )}
      </CardFooter>
    </Card>
  )
}

export function PitchQueue() {
  const [pitches, setPitches] = useState<PitchReviewItem[]>([])
  const [signedIn, setSignedIn] = useState(false)
  const [loading, setLoading] = useState(true)
  const [message, setMessage] = useState("Sign in to review pitches.")

  const token = useCallback(async () => {
    const { getBrowserFirebase } = await import("@/lib/firebase/client")
    const user = getBrowserFirebase().auth.currentUser
    if (!user) throw new Error("unauthorized")
    return user.getIdToken()
  }, [])

  const refresh = useCallback(async () => {
    try {
      const response = await fetch("/api/pitches", {
        headers: { Authorization: `Bearer ${await token()}` },
        cache: "no-store",
      })
      const body = await response.json()
      if (!response.ok) throw new Error(body.error ?? "unavailable")
      setPitches(body.pitches)
      setMessage(body.pitches.length ? "" : "No pitches yet.")
    } catch (error) {
      const code = error instanceof Error ? error.message : "unavailable"
      setMessage(errors[code] ?? "Could not load the queue.")
    } finally {
      setLoading(false)
    }
  }, [token])

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

  return (
    <section aria-labelledby="queue-heading" className="space-y-4">
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
          />
        ))}
      </div>
    </section>
  )
}
