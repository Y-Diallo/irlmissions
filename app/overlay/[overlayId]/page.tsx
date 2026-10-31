import type { Metadata } from "next"
import { OverlaySource } from "@/components/overlay-source"

export const metadata: Metadata = {
  title: "IRL Missions Overlay",
  robots: { index: false, follow: false },
  referrer: "no-referrer",
}

export default async function TenantOverlayPage({
  params,
}: {
  params: Promise<{ overlayId: string }>
}) {
  const { overlayId } = await params
  return <OverlaySource overlayId={overlayId} />
}
