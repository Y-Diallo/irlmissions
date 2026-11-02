"use client"

import { useEffect } from "react"
import { AnimatePresence, motion } from "motion/react"
import {
  stripPage,
  stripPageCount,
  type StripAction,
  type StripState,
} from "@/shared/consequence-strip"
import type { PublicConsequence } from "@/shared/consequences"
import { cn } from "@/lib/utils"

function timer(milliseconds: number) {
  const total = Math.max(0, Math.ceil(milliseconds / 1000))
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, "0")}`
}

function howItClears(item: PublicConsequence, now: number) {
  if (item.clearRule === "timed" && item.endsAt) {
    return `${timer(item.endsAt - now)} left`
  }
  if (item.clearRule === "at_next_stop") return "Pay at next stop"
  if (item.clearRule === "through_next_mission") {
    return "Until next mission ends"
  }
  return "Until streamer marks paid"
}

// At most two boxes at once; more rotate in pages of two. Box size is fixed
// so a single-box page never shifts the layout.
export function ConsequenceStrip({
  state,
  dispatch,
  rotateSeconds,
  now,
}: {
  state: StripState
  dispatch: (action: StripAction) => void
  rotateSeconds: number
  now: number
}) {
  const pages = stripPageCount(state)

  useEffect(() => {
    if (pages <= 1) return
    const interval = setInterval(
      () => dispatch({ type: "rotate" }),
      rotateSeconds * 1000
    )
    return () => clearInterval(interval)
  }, [dispatch, pages, rotateSeconds])

  const entries = stripPage(state)
  const pageKey = `${state.page}:${entries.map((entry) => entry.item.key).join(",")}`

  return (
    <div className="show-strip" aria-live="polite">
      <AnimatePresence mode="wait" initial={false}>
        {entries.length > 0 && (
          <motion.div
            key={pageKey}
            className="show-strip-page"
            initial={{ opacity: 0, y: 12 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -8 }}
            transition={{ duration: 0.35, ease: "easeOut" }}
          >
            {entries.map((entry) => (
              <div
                key={entry.item.key}
                className={cn(
                  "show-consequence",
                  entry.clearedAt !== undefined && "show-consequence--cleared"
                )}
              >
                <span>OWED BY {entry.item.setBy}</span>
                <strong>{entry.item.text}</strong>
                <small>{howItClears(entry.item, now)}</small>
                <AnimatePresence>
                  {entry.clearedAt !== undefined && (
                    <motion.em
                      className="show-consequence-stamp"
                      initial={{ opacity: 0, scale: 1.8, rotate: -14 }}
                      animate={{ opacity: 1, scale: 1, rotate: -8 }}
                      transition={{
                        type: "spring",
                        stiffness: 420,
                        damping: 18,
                      }}
                    >
                      CLEARED
                    </motion.em>
                  )}
                </AnimatePresence>
              </div>
            ))}
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  )
}
