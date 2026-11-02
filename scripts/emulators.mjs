import { spawn } from "node:child_process"
import { fileURLToPath } from "node:url"

const test = process.argv[2] === "test"
const configPath = fileURLToPath(
  new URL("../firebase.json", import.meta.url)
)
const cli = fileURLToPath(
  new URL("../node_modules/firebase-tools/lib/bin/firebase.js", import.meta.url)
)
const args = [
  cli,
  test ? "emulators:exec" : "emulators:start",
  "--project",
  "demo-irlmissions",
  "--config",
  configPath,
  "--only",
  "auth,firestore",
]
if (test) args.push("pnpm exec vitest run tests/firebase.emulator.test.ts")

const child = spawn(process.execPath, args, {
  cwd: fileURLToPath(new URL("..", import.meta.url)),
  stdio: "inherit",
  env: { ...process.env, ...(test ? { RUN_EMULATOR_TESTS: "true" } : {}) },
})
child.on("error", (error) => {
  console.error(error.message)
  process.exitCode = 1
})
child.on("exit", (code) => {
  process.exitCode = code ?? 1
})
for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => child.kill(signal))
}
