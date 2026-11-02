// Shows the shape of your RealtimeIRL feed without printing coordinates.
// Reads the same data the overlay listens to, three times 10s apart.
// Usage (PowerShell): $env:RTIRL_PULL_KEY="..."; node scripts/rtirl-probe.mjs
const pullKey = process.env.RTIRL_PULL_KEY?.trim()
if (!pullKey) {
  console.error("Set RTIRL_PULL_KEY first.")
  process.exit(1)
}
const url = `https://rtirl-a1d7f-default-rtdb.firebaseio.com/pullables/${encodeURIComponent(pullKey)}.json`

const age = (ms) => `${Math.round((Date.now() - ms) / 1000)}s ago`

function describe(value, depth = 0) {
  if (!value || typeof value !== "object" || depth > 1) return typeof value
  return Object.fromEntries(
    Object.entries(value).map(([key, inner]) => [
      key,
      ["latitude", "longitude"].includes(key)
        ? typeof inner
        : typeof inner === "number" && inner > 1e12
          ? `number (${age(inner)})`
          : typeof inner === "number" && inner > 1e9
            ? `number (seconds? ${age(inner * 1000)})`
            : describe(inner, depth + 1),
    ])
  )
}

for (let read = 1; read <= 3; read += 1) {
  const response = await fetch(url)
  const data = await response.json()
  console.log(`\nread ${read} at ${new Date().toISOString()}`)
  console.log(
    data ? JSON.stringify(describe(data), null, 2) : "No data for this key."
  )
  if (read < 3) await new Promise((resolve) => setTimeout(resolve, 10_000))
}
