import { MapSource } from "@/components/map-source"

export default async function MapPage({
  params,
}: {
  params: Promise<{ overlayId: string }>
}) {
  const { overlayId } = await params
  return <MapSource overlayId={overlayId} />
}
