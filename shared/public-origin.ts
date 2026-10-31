function httpOrigin(value: string | undefined) {
  if (!value) return null
  try {
    const url = new URL(value)
    return url.protocol === "http:" || url.protocol === "https:"
      ? url.origin
      : null
  } catch {
    return null
  }
}

export function publicRequestOrigin(
  request: Request,
  configuredUrl = process.env.TWITCH_REDIRECT_URI
) {
  const configured = httpOrigin(configuredUrl)
  if (configured) return configured

  const forwardedHost = request.headers
    .get("x-forwarded-host")
    ?.split(",")[0]
    ?.trim()
  const forwardedProtocol = request.headers
    .get("x-forwarded-proto")
    ?.split(",")[0]
    ?.trim()
  if (forwardedHost && /^https?$/.test(forwardedProtocol ?? "")) {
    const forwarded = httpOrigin(`${forwardedProtocol}://${forwardedHost}`)
    if (forwarded) return forwarded
  }

  return new URL(request.url).origin
}
