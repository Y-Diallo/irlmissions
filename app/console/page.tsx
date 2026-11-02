import Link from "next/link"
import { BookOpen, Settings } from "lucide-react"
import { AuthControl } from "@/components/auth-control"
import { PitchQueue } from "@/components/pitch-queue"
import { buttonVariants } from "@/components/ui/button"

export default function ConsolePage() {
  return (
    <main className="mx-auto flex min-h-svh max-w-3xl flex-col gap-8 p-4 py-8 sm:p-8">
      <header className="space-y-4">
        <div className="flex items-start justify-between gap-4">
          <p className="pt-3 text-sm font-medium text-muted-foreground">
            IRL Missions
          </p>
          <div className="flex items-start gap-2">
            <Link
              href="/setup"
              aria-label="Open settings"
              title="Settings"
              className={buttonVariants({
                variant: "outline",
                size: "icon",
              })}
            >
              <Settings aria-hidden="true" />
              <span className="sr-only">Open settings</span>
            </Link>
            <AuthControl />
          </div>
        </div>
        <h1 className="text-3xl font-semibold tracking-tight">
          Producer console
        </h1>
        <p className="max-w-2xl text-base leading-relaxed text-muted-foreground">
          Review pitches, run the next poll, and control the live mission.
        </p>
        <nav className="grid grid-cols-1 gap-2 sm:flex">
          <Link
            href="/instructions"
            className={buttonVariants({
              variant: "outline",
              className: "min-h-12 w-full px-4 text-base sm:w-auto",
            })}
          >
            <BookOpen aria-hidden="true" />
            Instructions
          </Link>
          <Link
            href="/refunds"
            className={buttonVariants({
              variant: "outline",
              className: "min-h-12 w-full px-4 text-base sm:w-auto",
            })}
          >
            Pitches &amp; refunds
          </Link>
        </nav>
      </header>
      <PitchQueue />
    </main>
  )
}
