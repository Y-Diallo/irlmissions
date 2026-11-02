"use client"

import { useEffect, useRef, useState } from "react"

/**
 * The size each overlay page lays itself out at, like a browser source's
 * width and height in OBS. Smaller than a full 1080p canvas so the cards
 * stay legible once scaled into the preview.
 */
const CANVAS_WIDTH = 960
const CANVAS_HEIGHT = 540

// Renders an overlay page at that size and scales it to fit, on a
// checkerboard so its transparent background reads as transparent.
function OverlayFrame({ title, src }: { title: string; src: string }) {
  const boxRef = useRef<HTMLDivElement>(null)
  const [scale, setScale] = useState(0)

  useEffect(() => {
    const box = boxRef.current
    if (!box) return
    const observer = new ResizeObserver(([entry]) => {
      setScale((entry?.contentRect.width ?? 0) / CANVAS_WIDTH)
    })
    observer.observe(box)
    return () => observer.disconnect()
  }, [])

  return (
    <figure className="grid gap-1.5">
      <figcaption className="text-sm font-medium">{title}</figcaption>
      <div
        ref={boxRef}
        className="demo-overlay-checker relative aspect-video overflow-hidden rounded-md border"
      >
        {scale > 0 && (
          <iframe
            title={title}
            src={src}
            referrerPolicy="no-referrer"
            className="absolute top-0 left-0 origin-top-left border-0"
            style={{
              width: CANVAS_WIDTH,
              height: CANVAS_HEIGHT,
              transform: `scale(${scale})`,
            }}
          />
        )}
      </div>
    </figure>
  )
}

export function DemoOverlays({
  links,
  error,
}: {
  links: { overlayUrl: string; mapUrl: string } | null
  error: string
}) {
  if (error) {
    return (
      <p role="alert" className="text-sm text-destructive">
        {error}
      </p>
    )
  }
  if (!links) {
    return (
      <p role="status" className="text-sm text-muted-foreground">
        Loading the OBS overlays…
      </p>
    )
  }
  return (
    <div className="grid gap-5">
      <OverlayFrame title="Objectives overlay" src={links.overlayUrl} />
      <OverlayFrame title="Live map" src={links.mapUrl} />
    </div>
  )
}
