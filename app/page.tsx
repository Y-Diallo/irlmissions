import { DemoLogin } from "@/components/demo-login"
import { TwitchLogin } from "@/components/twitch-login"

export default function Page() {
  return (
    <main className="mx-auto flex min-h-svh max-w-2xl flex-col justify-center gap-6 p-6">
      <p className="text-sm font-medium text-muted-foreground">IRL Missions</p>
      <h1 className="text-3xl font-semibold tracking-tight">
        Your next adventure starts with chat.
      </h1>
      <p className="text-base leading-relaxed text-muted-foreground">
        The producer console is being built. Local demo access is ready to test
        without a Twitch account.
      </p>
      {process.env.NEXT_PUBLIC_APP_MODE === "emulator" ? (
        <DemoLogin />
      ) : (
        <TwitchLogin />
      )}
    </main>
  )
}
