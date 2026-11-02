import Link from "next/link"
import { Settings } from "lucide-react"
import { AuthControl } from "@/components/auth-control"
import { RefundConsole } from "@/components/refund-console"
import { PitchHistory } from "@/components/pitch-history"
import { buttonVariants } from "@/components/ui/button"

export default function RefundsPage() {
  return (
    <main className="mx-auto flex min-h-svh max-w-3xl flex-col gap-8 p-4 py-8 sm:p-8">
      <header className="space-y-4">
        <div className="flex items-start justify-between gap-4">
          <Link
            href="/console"
            className={buttonVariants({
              variant: "outline",
              className: "min-h-12 w-fit px-4 text-base",
            })}
          >
            Back to producer console
          </Link>
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
        <div>
          <p className="text-sm font-medium text-muted-foreground">
            IRL Missions
          </p>
          <h1 className="text-3xl font-semibold tracking-tight">
            Pitches &amp; refunds
          </h1>
        </div>
      </header>
      <RefundConsole />
      <PitchHistory />
    </main>
  )
}
