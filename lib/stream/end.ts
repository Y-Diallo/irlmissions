import "server-only"

import type { Firestore } from "firebase-admin/firestore"
import { getServerFirebase } from "@/lib/firebase/admin"
import { createMissionStore } from "@/lib/missions/store"
import { cancelLivePoll } from "@/lib/polls/service"
import { createRefundStore } from "@/lib/refunds/store"
import { setTenantRewardEnabled } from "@/lib/integrations/twitch-setup"
import { assertStreamCanEnd } from "@/shared/stream"
import type { MissionRecord } from "@/shared/missions"
import type { PollRecord } from "@/shared/polls"
import { tenantDoc } from "@/shared/tenant"

function sessionState(data: FirebaseFirestore.DocumentData | undefined) {
  return {
    mission: data?.mission as MissionRecord | undefined,
    poll: data?.poll as PollRecord | undefined,
  }
}

export async function endLiveStream(
  tenantId: string,
  db: Firestore = getServerFirebase().db
) {
  const sessionRef = db.doc(tenantDoc(tenantId, "sessions/current"))
  const ownerRef = db.doc(`owners/${tenantId}`)
  const [sessionSnapshot, ownerSnapshot] = await Promise.all([
    sessionRef.get(),
    ownerRef.get(),
  ])
  let { mission, poll } = sessionState(sessionSnapshot.data())
  assertStreamCanEnd({
    missionStatus: mission?.status,
    pollStatus: poll?.status,
  })

  // Stop new paid submissions before changing any local session state.
  if (ownerSnapshot.data()?.rewardEnabled === true) {
    await setTenantRewardEnabled(tenantId, false)
  }

  let pollCanceled = false
  if (poll?.status === "active" || poll?.status === "tie") {
    await cancelLivePoll(tenantId)
    pollCanceled = true
  }

  // Re-read because poll cancellation and a concurrent arrival both mutate the
  // session. The mission store enforces that an arrived mission cannot refund.
  ;({ mission, poll } = sessionState((await sessionRef.get()).data()))
  let missionCanceled = false
  if (mission?.status === "heading") {
    await createMissionStore(db, tenantId).act("cancel", Date.now())
    missionCanceled = true
  } else if (mission?.status === "arrived") {
    // Intake is already safely closed. The owner can choose the outcome and
    // tap End Stream again without risking a refund of an attempted mission.
    assertStreamCanEnd({
      missionStatus: mission.status,
      pollStatus: poll?.status,
    })
  }

  const refunds = await createRefundStore(db, tenantId).queueUnused(Date.now())
  return {
    rewardEnabled: false,
    pollCanceled,
    missionCanceled,
    refunds,
  }
}
