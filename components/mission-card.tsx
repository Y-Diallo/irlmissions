"use client"

import { useEffect, useState } from "react"
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert"
import { Badge } from "@/components/ui/badge"
import { Button, buttonVariants } from "@/components/ui/button"
import {
  Card,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
} from "@/components/ui/card"
import type { MissionAction, MissionOwnerView } from "@/shared/missions"
import type { TravelMode } from "@/shared/pitches/processor"

function distance(meters: number) {
  return meters < 1000
    ? `${Math.round(meters)} m`
    : `${(meters / 1000).toFixed(1)} km`
}

function travelLabel(mode: TravelMode | undefined) {
  if (mode === "drive") return "driving"
  if (mode === "transit") return "transit"
  return "walking"
}

function countdown(milliseconds: number) {
  const totalSeconds = Math.max(0, Math.ceil(milliseconds / 1000))
  const minutes = Math.floor(totalSeconds / 60)
  const seconds = String(totalSeconds % 60).padStart(2, "0")
  return `${minutes}:${seconds}`
}

function statusLabel(mission: MissionOwnerView) {
  if (mission.status === "heading") return "Heading there"
  if (mission.status === "arrived") return "Mission active"
  if (mission.status === "completed") return "Completed"
  if (mission.status === "canceled") return "Canceled"
  if (mission.outcome === "denied") return "Denied"
  return "Failed"
}

export function MissionCard({
  mission,
  onAction,
  onPayConsequence,
}: {
  mission: MissionOwnerView
  onAction: (action: MissionAction) => Promise<void>
  onPayConsequence: (consequenceId: string) => Promise<void>
}) {
  const [now, setNow] = useState(mission.updatedAt)
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState("")

  useEffect(() => {
    if (
      mission.status !== "arrived" &&
      !mission.activeConsequences?.some(
        (consequence) => consequence.clearRule === "timed"
      )
    ) {
      return
    }
    const initial = setTimeout(() => setNow(Date.now()), 0)
    const interval = setInterval(() => setNow(Date.now()), 1000)
    return () => {
      clearTimeout(initial)
      clearInterval(interval)
    }
  }, [mission.activeConsequences, mission.status, mission.timerEndsAt])

  async function act(action: MissionAction) {
    setBusy(true)
    setMessage("")
    try {
      await onAction(action)
    } catch (error) {
      setMessage(
        error instanceof Error
          ? error.message
          : "Could not update the mission. Try again."
      )
    } finally {
      setBusy(false)
    }
  }

  async function pay(consequenceId: string) {
    setBusy(true)
    setMessage("")
    try {
      await onPayConsequence(consequenceId)
    } catch (error) {
      setMessage(
        error instanceof Error
          ? error.message
          : "Could not mark the consequence paid. Try again."
      )
    } finally {
      setBusy(false)
    }
  }

  const { destination, walkingRoute, navigation } = mission
  const remaining = (mission.timerEndsAt ?? now) - now
  const terminal =
    mission.status === "completed" ||
    mission.status === "failed" ||
    mission.status === "canceled"
  const activeConsequences = (mission.activeConsequences ?? []).filter(
    (consequence) => !consequence.endsAt || consequence.endsAt > now
  )

  return (
    <Card className="border-primary/30 shadow-sm">
      <CardHeader>
        <div className="flex items-start justify-between gap-3">
          <div className="space-y-1">
            <CardDescription>Current mission</CardDescription>
            <CardTitle className="text-2xl">{mission.publicLabel}</CardTitle>
          </div>
          <Badge
            variant={mission.status === "failed" ? "destructive" : "default"}
          >
            {statusLabel(mission)}
          </Badge>
        </div>
      </CardHeader>
      <CardContent className="gap-5">
        {mission.request && (
          <div className="rounded-lg border p-4">
            <p className="text-sm text-muted-foreground">
              {mission.viewerName
                ? `${mission.viewerName} asked`
                : "Viewer's request"}
            </p>
            <p className="mt-1 text-base leading-relaxed break-words whitespace-pre-wrap">
              {mission.request}
            </p>
          </div>
        )}
        {activeConsequences.map((consequence) => (
          <Alert key={consequence.consequenceId}>
            <AlertTitle>Consequence from {consequence.setBy}</AlertTitle>
            <AlertDescription className="grid gap-3">
              <span>{consequence.text}</span>
              <span className="font-medium">
                {consequence.clearRule === "timed" && consequence.endsAt
                  ? `${countdown(consequence.endsAt - now)} left`
                  : consequence.clearRule === "at_next_stop"
                    ? "Clears at the next mission arrival."
                    : consequence.clearRule === "through_next_mission"
                      ? "Clears when the next mission completes or fails."
                      : "Stays active until you mark it paid."}
              </span>
              {consequence.clearRule === "manual" && (
                <Button
                  type="button"
                  className="min-h-12 w-full text-base sm:w-auto"
                  disabled={busy}
                  onClick={() => void pay(consequence.consequenceId)}
                >
                  Paid
                </Button>
              )}
            </AlertDescription>
          </Alert>
        ))}
        {!destination || !walkingRoute || !navigation ? (
          <div className="rounded-lg bg-muted p-4">
            <p className="text-lg font-semibold">Anywhere</p>
            <p className="mt-1 text-sm text-muted-foreground">
              No destination. Do it right where you are.
            </p>
          </div>
        ) : (
          <>
            <div className="rounded-lg bg-muted p-4">
              <p className="text-lg font-semibold">{destination.name}</p>
              <p className="mt-1 text-sm text-muted-foreground">
                {destination.address}
              </p>
              <p className="mt-3 text-sm">
                {distance(walkingRoute.distanceMeters)} ·{" "}
                {Math.max(1, Math.round(walkingRoute.durationSeconds / 60))} min{" "}
                {travelLabel(walkingRoute.mode)}
              </p>
              <p className="mt-1 text-sm text-muted-foreground">
                {destination.hoursText?.[0] ?? "Hours unknown"}
              </p>
              {destination.attributions.length > 0 && (
                <p className="mt-3 text-xs text-muted-foreground">
                  {destination.attributions.map((attribution, index) => (
                    <span
                      key={`${attribution.provider}-${attribution.providerUri}`}
                    >
                      {index > 0 ? " · " : ""}
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
              )}
            </div>

            <div className="grid grid-cols-1 gap-2 sm:grid-cols-3">
              <a
                href={navigation.googleMaps}
                target="_blank"
                rel="noreferrer"
                className={buttonVariants({
                  variant: "outline",
                  className: "min-h-14 text-base",
                })}
              >
                Google Maps
              </a>
              <a
                href={navigation.appleMaps}
                target="_blank"
                rel="noreferrer"
                className={buttonVariants({
                  variant: "outline",
                  className: "min-h-14 text-base",
                })}
              >
                Apple Maps
              </a>
              <a
                href={navigation.waze}
                target="_blank"
                rel="noreferrer"
                className={buttonVariants({
                  variant: "outline",
                  className: "min-h-14 text-base",
                })}
              >
                Waze (driving)
              </a>
            </div>
          </>
        )}

        {mission.status === "arrived" && (
          <div className="rounded-lg border bg-background p-5 text-center">
            <p className="text-sm font-medium text-muted-foreground">
              Mission timer
            </p>
            <p
              role="timer"
              className="mt-1 text-5xl font-semibold tabular-nums"
            >
              {countdown(remaining)}
            </p>
            {remaining <= 0 && (
              <p className="mt-2 text-sm font-medium text-destructive">
                Time elapsed — choose the outcome when ready.
              </p>
            )}
          </div>
        )}

        {terminal && (
          <Alert>
            <AlertTitle>Mission closed</AlertTitle>
            <AlertDescription>
              {mission.status === "canceled"
                ? "The Channel Points refund is queued for Twitch."
                : "Redemption fulfillment is queued for Twitch."}
            </AlertDescription>
          </Alert>
        )}
        {message && (
          <p role="alert" className="text-sm text-destructive">
            {message}
          </p>
        )}
      </CardContent>
      {!terminal && (
        <CardFooter className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <Button
            variant="outline"
            className="col-span-full min-h-14 w-full text-lg"
            disabled={busy}
            onClick={() => void act("extend")}
          >
            +5 min
            {mission.status === "heading" &&
              ` (${mission.durationMinutes} min mission)`}
          </Button>
          {mission.status === "heading" ? (
            <>
              <Button
                className="min-h-14 w-full text-lg"
                disabled={busy}
                onClick={() => void act("arrive")}
              >
                I&apos;ve arrived — start timer
              </Button>
              <Button
                variant="destructive"
                className="min-h-14 w-full text-lg"
                disabled={busy}
                onClick={() => void act("cancel")}
              >
                Cancel and refund
              </Button>
            </>
          ) : (
            <>
              <Button
                className="min-h-14 w-full text-lg"
                disabled={busy}
                onClick={() => void act("complete")}
              >
                Complete mission
              </Button>
              <Button
                variant="destructive"
                className="min-h-14 w-full text-lg"
                disabled={busy}
                onClick={() => void act("fail")}
              >
                Mark failed
              </Button>
              <Button
                variant="outline"
                className="min-h-14 w-full text-lg sm:col-span-2"
                disabled={busy}
                onClick={() => void act("deny")}
              >
                Deny — no consequence
              </Button>
            </>
          )}
        </CardFooter>
      )}
    </Card>
  )
}
