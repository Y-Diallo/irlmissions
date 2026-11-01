import Link from "next/link"
import { Settings } from "lucide-react"
import { AuthControl } from "@/components/auth-control"
import { buttonVariants } from "@/components/ui/button"
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card"

const steps = [
  {
    title: "1. Get ready",
    body: "Open Settings, connect Twitch and RealtimeIRL, check your privacy zone, then enable the Pitch reward.",
  },
  {
    title: "2. Review pitches",
    body: "Approve clean ideas, edit anything that needs work, or reject it. Select two to five approved pitches for chat.",
  },
  {
    title: "3. Run the poll",
    body: "Set the poll length and start voting. The winning pitch becomes the active mission automatically.",
  },
  {
    title: "4. Run the mission",
    body: "Use a navigation link, tap Arrived if GPS does not detect it, then Complete, Fail, or Deny the mission. Deny ends it without adding its consequence.",
  },
  {
    title: "5. Finish safely",
    body: "Pause automation whenever you need control. When you're done, End stream in Settings disables intake and queues unused Channel Point redemptions for refund.",
  },
]

export default function InstructionsPage() {
  return (
    <main className="mx-auto flex min-h-svh max-w-3xl flex-col gap-6 p-4 py-8 sm:p-8">
      <header className="space-y-4">
        <div className="flex items-start justify-between gap-4">
          <Link
            href="/"
            className={buttonVariants({
              variant: "outline",
              className: "min-h-12 px-4 text-base",
            })}
          >
            Back to console
          </Link>
          <div className="flex items-start gap-2">
            <Link
              href="/setup"
              aria-label="Open settings"
              title="Settings"
              className={buttonVariants({ variant: "outline", size: "icon" })}
            >
              <Settings aria-hidden="true" />
              <span className="sr-only">Open settings</span>
            </Link>
            <AuthControl />
          </div>
        </div>
        <div>
          <p className="text-sm font-medium text-muted-foreground">
            IRL Missions
          </p>
          <h1 className="mt-1 text-3xl font-semibold tracking-tight">
            Stream instructions
          </h1>
          <p className="mt-2 text-base text-muted-foreground">
            The live loop, from viewer pitch to automatic refund.
          </p>
        </div>
      </header>

      <section className="grid gap-3" aria-label="Stream workflow">
        {steps.map((step) => (
          <Card key={step.title} size="sm">
            <CardHeader>
              <CardTitle className="text-lg">{step.title}</CardTitle>
              <CardDescription className="text-base leading-relaxed">
                {step.body}
              </CardDescription>
            </CardHeader>
          </Card>
        ))}
      </section>

      <Card>
        <CardHeader>
          <CardTitle>Quick controls</CardTitle>
        </CardHeader>
        <CardContent className="gap-2 text-base leading-relaxed">
          <p>
            <strong>No-travel mode:</strong> skips place search and starts each
            mission immediately where you are.
          </p>
          <p>
            <strong>Hide live map position:</strong> removes your marker and
            trail while keeping public destination pins visible.
          </p>
          <p>
            <strong>Simulator:</strong> in a demo session, inject pitches and
            manually drive polls, movement, arrival, and GPS loss.
          </p>
        </CardContent>
      </Card>
    </main>
  )
}
