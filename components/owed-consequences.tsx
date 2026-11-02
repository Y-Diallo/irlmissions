"use client"

import { useEffect, useState } from "react"
import { Button } from "@/components/ui/button"
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card"
import { Input } from "@/components/ui/input"
import type {
  ConsequenceCommand,
  ConsequenceRecord,
} from "@/shared/consequences"
import type { ConsequenceClearRule } from "@/shared/pitches/processor"

const RULES: Array<{ rule: ConsequenceClearRule; label: string }> = [
  { rule: "timed", label: "Timer" },
  { rule: "at_next_stop", label: "Next stop" },
  { rule: "through_next_mission", label: "Next mission" },
  { rule: "manual", label: "Until paid" },
]

function countdown(milliseconds: number) {
  const total = Math.max(0, Math.ceil(milliseconds / 1000))
  const minutes = Math.floor(total / 60)
  return `${minutes}:${String(total % 60).padStart(2, "0")}`
}

function howItClears(consequence: ConsequenceRecord, now: number) {
  if (consequence.clearRule === "timed" && consequence.endsAt) {
    return `${countdown(consequence.endsAt - now)} left`
  }
  if (consequence.clearRule === "at_next_stop") {
    return "Clears at the next arrival"
  }
  if (consequence.clearRule === "through_next_mission") {
    return "Clears when the next mission ends"
  }
  return "Stays until you mark it paid"
}

export function OwedConsequences({
  consequences,
  onCommand,
}: {
  consequences: ConsequenceRecord[]
  onCommand: (
    consequenceId: string,
    command: ConsequenceCommand
  ) => Promise<void>
}) {
  const [now, setNow] = useState(() => Date.now())
  const timed = consequences.some((item) => item.clearRule === "timed")

  useEffect(() => {
    if (!timed) return
    const interval = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(interval)
  }, [timed])

  // A timer that ran out disappears here before the next refresh confirms it.
  const owed = consequences.filter(
    (item) => item.endsAt === undefined || item.endsAt > now
  )
  if (!owed.length) return null

  return (
    <Card className="border-amber-500/40">
      <CardHeader>
        <CardDescription>Owed consequences</CardDescription>
        <CardTitle className="text-xl">
          {owed.length} owed{owed.length > 1 ? ", oldest first" : ""}
        </CardTitle>
      </CardHeader>
      <CardContent className="grid gap-3">
        {owed.map((consequence) => (
          <OwedItem
            key={consequence.consequenceId}
            consequence={consequence}
            now={now}
            onCommand={(command) =>
              onCommand(consequence.consequenceId, command)
            }
          />
        ))}
      </CardContent>
    </Card>
  )
}

function OwedItem({
  consequence,
  now,
  onCommand,
}: {
  consequence: ConsequenceRecord
  now: number
  onCommand: (command: ConsequenceCommand) => Promise<void>
}) {
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState("")
  const [editing, setEditing] = useState(false)
  const [rule, setRule] = useState(consequence.clearRule)
  const [minutes, setMinutes] = useState(
    String(consequence.durationMinutes || 10)
  )
  const [confirmRemove, setConfirmRemove] = useState(false)

  useEffect(() => {
    if (!confirmRemove) return
    const timeout = setTimeout(() => setConfirmRemove(false), 3000)
    return () => clearTimeout(timeout)
  }, [confirmRemove])

  async function send(command: ConsequenceCommand) {
    setBusy(true)
    setMessage("")
    try {
      await onCommand(command)
      setEditing(false)
    } catch (error) {
      setMessage(
        error instanceof Error ? error.message : "Could not update. Try again."
      )
    } finally {
      setBusy(false)
    }
  }

  const minutesValue = Number(minutes)
  const minutesValid =
    Number.isInteger(minutesValue) && minutesValue >= 1 && minutesValue <= 1440

  return (
    <div className="rounded-lg border bg-amber-500/5 p-4">
      <p className="text-sm text-muted-foreground">From {consequence.setBy}</p>
      <p className="mt-1 text-lg leading-snug font-semibold break-words">
        {consequence.text}
      </p>
      <p
        className="mt-2 text-base font-medium tabular-nums"
        role={consequence.clearRule === "timed" ? "timer" : undefined}
      >
        {howItClears(consequence, now)}
      </p>

      {editing ? (
        <div className="mt-3 grid gap-3">
          <div className="grid grid-cols-2 gap-2">
            {RULES.map((option) => (
              <Button
                key={option.rule}
                type="button"
                variant={rule === option.rule ? "default" : "outline"}
                className="min-h-12 text-base"
                aria-pressed={rule === option.rule}
                onClick={() => setRule(option.rule)}
              >
                {option.label}
              </Button>
            ))}
          </div>
          {rule === "timed" && (
            <label className="grid gap-1 text-sm">
              Minutes from now
              <Input
                type="number"
                inputMode="numeric"
                min={1}
                max={1440}
                value={minutes}
                className="min-h-12 text-base"
                onChange={(event) => setMinutes(event.target.value)}
              />
            </label>
          )}
          <div className="grid grid-cols-2 gap-2">
            <Button
              type="button"
              variant="outline"
              className="min-h-12 text-base"
              disabled={busy}
              onClick={() => {
                setEditing(false)
                setRule(consequence.clearRule)
              }}
            >
              Back
            </Button>
            <Button
              type="button"
              className="min-h-12 text-base"
              disabled={busy || (rule === "timed" && !minutesValid)}
              onClick={() =>
                void send({
                  action: "change",
                  clearRule: rule,
                  durationMinutes: rule === "timed" ? minutesValue : 0,
                })
              }
            >
              Save
            </Button>
          </div>
        </div>
      ) : (
        <div className="mt-3 grid grid-cols-3 gap-2">
          <Button
            type="button"
            className="min-h-12 text-base"
            disabled={busy}
            onClick={() => void send({ action: "pay" })}
          >
            Paid
          </Button>
          <Button
            type="button"
            variant="outline"
            className="min-h-12 text-base"
            disabled={busy}
            onClick={() => setEditing(true)}
          >
            Change
          </Button>
          <Button
            type="button"
            variant={confirmRemove ? "destructive" : "outline"}
            className="min-h-12 text-base"
            disabled={busy}
            onClick={() =>
              confirmRemove
                ? void send({ action: "remove" })
                : setConfirmRemove(true)
            }
          >
            {confirmRemove ? "Sure?" : "Remove"}
          </Button>
        </div>
      )}
      {message && (
        <p role="alert" className="mt-2 text-sm text-destructive">
          {message}
        </p>
      )}
    </div>
  )
}
