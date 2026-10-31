import Link from "next/link"
import { DemoLogin } from "@/components/demo-login"
import { PitchQueue } from "@/components/pitch-queue"
import { TwitchLogin } from "@/components/twitch-login"
import { buttonVariants } from "@/components/ui/button"

export default function Page() {
  return (
    <main className="mx-auto flex min-h-svh max-w-3xl flex-col gap-8 p-4 py-8 sm:p-8">
      <header className="space-y-4">
        <p className="text-sm font-medium text-muted-foreground">
          IRL Missions
        </p>
        <h1 className="text-3xl font-semibold tracking-tight">
          Chat pitches. You decide.
        </h1>
        <p className="max-w-2xl text-base leading-relaxed text-muted-foreground">
          Review every objective before it can reach a poll. Destination details
          stay private until arrival.
        </p>
        {process.env.NEXT_PUBLIC_APP_MODE === "emulator" ? (
          <DemoLogin />
        ) : (
          <TwitchLogin />
        )}
        <Link
          href="/setup"
          className={buttonVariants({
            variant: "outline",
            className: "min-h-12 w-fit px-4 text-base",
          })}
        >
          Open setup
        </Link>
        <Link
          href="/refunds"
          className={buttonVariants({
            variant: "outline",
            className: "min-h-12 w-fit px-4 text-base",
          })}
        >
          Open refunds
        </Link>
      </header>
      <PitchQueue />
    </main>
  )
}
