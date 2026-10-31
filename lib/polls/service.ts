import "server-only"
import {
  getTwitchAccessToken,
  opaqueId,
  readTwitchConfig,
} from "@/shared/auth/twitch"
import {
  PollError,
  PollProviderError,
  matchesPollAttempt,
  type PollProvider,
  type PollRecord,
  type StartPollCommand,
} from "@/shared/polls"
import { createTwitchPollProvider } from "@/shared/providers/twitch-polls"
import { loadAuthDependencies } from "@/lib/auth/server"
import { getServerFirebase } from "@/lib/firebase/admin"
import { createPollStore } from "@/lib/polls/store"

type PollStore = ReturnType<typeof createPollStore>

async function liveDependencies(tenantId: string): Promise<{
  store: PollStore
  provider: PollProvider
  now: () => number
  newAttemptId: () => string
}> {
  const config = readTwitchConfig(process.env)
  const auth = await loadAuthDependencies(config)
  return {
    store: createPollStore(getServerFirebase().db, tenantId),
    provider: createTwitchPollProvider({
      broadcasterId: tenantId,
      clientId: config.clientId,
      getAccessToken: (forceRefresh = false) =>
        getTwitchAccessToken(config, auth, tenantId, forceRefresh),
    }),
    now: Date.now,
    newAttemptId: opaqueId,
  }
}

export type PollServiceDependencies = Awaited<
  ReturnType<typeof liveDependencies>
>

async function findAttempt(provider: PollProvider, record: PollRecord) {
  const recent = await provider.listRecent()
  return recent.find((poll) => matchesPollAttempt(record, poll)) ?? null
}

export async function startPoll(
  command: StartPollCommand,
  deps: PollServiceDependencies
) {
  const record = await deps.store.reserve(
    command,
    deps.newAttemptId(),
    deps.now()
  )
  try {
    const created = await deps.provider.create({
      title: record.title,
      choices: record.choices.map((choice) => choice.title),
      durationSeconds: record.durationSeconds,
    })
    return await deps.store.attach(record.attemptId, created, deps.now())
  } catch (error) {
    if (!(error instanceof PollProviderError)) throw error
    if (!error.ambiguous) {
      await deps.store.failAndUnlock(record.attemptId, error.code, deps.now())
      throw new PollError(error.code, error.status)
    }
    try {
      const recovered = await findAttempt(deps.provider, record)
      if (recovered) {
        return await deps.store.attach(record.attemptId, recovered, deps.now())
      }
    } catch {
      // The durable unknown state is safer than either a duplicate poll or
      // releasing choices while a Twitch poll may be active.
    }
    await deps.store.markUnknown(record.attemptId, error.code, deps.now())
    throw new PollError("poll_creation_unknown", 503)
  }
}

export async function reconcilePoll(deps: PollServiceDependencies) {
  const record = await deps.store.read()
  if (!record || !["creating", "create_unknown"].includes(record.status)) {
    throw new PollError("poll_not_recoverable")
  }
  const recovered = await findAttempt(deps.provider, record)
  if (!recovered) {
    await deps.store.markUnknown(
      record.attemptId,
      "twitch_poll_not_found",
      deps.now()
    )
    return { reconciled: false, poll: await deps.store.read() }
  }
  return {
    reconciled: true,
    poll: await deps.store.attach(record.attemptId, recovered, deps.now()),
  }
}

export async function startLivePoll(
  tenantId: string,
  command: StartPollCommand
) {
  return startPoll(command, await liveDependencies(tenantId))
}

export async function reconcileLivePoll(tenantId: string) {
  return reconcilePoll(await liveDependencies(tenantId))
}
