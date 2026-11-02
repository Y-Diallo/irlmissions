import Link from "next/link"
import { AuthControl } from "@/components/auth-control"
import { SetupConsole } from "@/components/setup-console"

export default function SetupPage() {
  return (
    <main className="mx-auto min-h-svh max-w-3xl space-y-6 p-4 py-8 sm:p-8">
      <div className="flex items-start justify-between gap-4">
        <div>
          <Link className="text-sm underline" href="/console">
            Back to producer console
          </Link>
          <h1 className="mt-4 text-3xl font-semibold">Stream setup</h1>
          <p className="mt-2 text-muted-foreground">
            Connect your private location feed, privacy zone, and OBS source.
          </p>
        </div>
        <AuthControl />
      </div>
      <SetupConsole />
    </main>
  )
}
