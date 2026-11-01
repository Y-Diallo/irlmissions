import { DemoLogin } from "@/components/demo-login"
import { TwitchLogin } from "@/components/twitch-login"

/** The producer account control used in the top-right of private screens. */
export function AuthControl() {
  return process.env.NEXT_PUBLIC_APP_MODE === "emulator" ? (
    <DemoLogin compact />
  ) : (
    <TwitchLogin compact />
  )
}
