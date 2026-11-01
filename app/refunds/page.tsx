import Link from "next/link"
import { DemoLogin } from "@/components/demo-login"
import { RefundConsole } from "@/components/refund-console"
import { PitchHistory } from "@/components/pitch-history"
import { TwitchLogin } from "@/components/twitch-login"
import { buttonVariants } from "@/components/ui/button"

export default function RefundsPage() {
  return (
    <main className="mx-auto flex min-h-svh max-w-3xl flex-col gap-8 p-4 py-8 sm:p-8">
      <header className="space-y-4">
        <Link
          href="/"
          className={buttonVariants({
            variant: "outline",
            className: "min-h-12 w-fit px-4 text-base",
          })}
        >
          Back to producer console
        </Link>
        <div>
          <p className="text-sm font-medium text-muted-foreground">
            IRL Missions
          </p>
          <h1 className="text-3xl font-semibold tracking-tight">
            Pitches &amp; refunds
          </h1>
        </div>
        {process.env.NEXT_PUBLIC_APP_MODE === "emulator" ? (
          <DemoLogin />
        ) : (
          <TwitchLogin />
        )}
      </header>
      <RefundConsole />
      <PitchHistory />
    </main>
  )
}
