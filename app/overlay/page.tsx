import type { Metadata } from "next"
import { OverlaySource } from "@/components/overlay-source"

export const metadata: Metadata = {
  title: "IRL Missions Overlay",
  robots: { index: false, follow: false },
  referrer: "no-referrer",
}

export default function OverlayPage() {
  return <OverlaySource />
}
