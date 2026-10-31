import { NextResponse } from "next/server"
import { authFailure, NO_STORE } from "@/lib/auth/http"
import { parseSetupAction, parseSetupUpdate, SetupError } from "@/shared/setup"
import { publicRequestOrigin } from "@/shared/public-origin"
import { tenantDoc } from "@/shared/tenant"

export const runtime = "nodejs"

function failure(error: unknown) {
  if (error instanceof SyntaxError || error instanceof SetupError) {
    const setupError =
      error instanceof SetupError ? error : new SetupError("invalid_setup")
    return NextResponse.json(
      { error: setupError.code },
      { status: setupError.status, headers: NO_STORE }
    )
  }
  return authFailure(error)
}

async function context(request: Request) {
  const [{ requireServerOwner }, { getServerFirebase }] = await Promise.all([
    import("@/lib/auth/server"),
    import("@/lib/firebase/admin"),
  ])
  return {
    owner: await requireServerOwner(request.headers.get("authorization")),
    db: getServerFirebase().db,
  }
}

export async function GET(request: Request) {
  try {
    const { owner, db } = await context(request)
    const [profile, settings, integration] = await Promise.all([
      db.doc(`owners/${owner.tenantId}`).get(),
      db.doc(tenantDoc(owner.tenantId, "settings/current")).get(),
      db.doc(tenantDoc(owner.tenantId, "private/integrations")).get(),
    ])
    const privateData = integration.data()
    return NextResponse.json(
      {
        tenantId: owner.tenantId,
        twitchLogin: profile.data()?.twitchLogin ?? null,
        twitchSetup: profile.data()?.twitchSetup ?? { status: "pending" },
        rewardEnabled: profile.data()?.rewardEnabled === true,
        reward: privateData?.rewardId
          ? { id: privateData.rewardId, title: privateData.rewardTitle }
          : null,
        realtimeIrlConfigured:
          typeof privateData?.realtimeIrlPullKey === "string",
        overlayConfigured: typeof privateData?.overlayId === "string",
        settings: settings.data() ?? null,
      },
      { headers: NO_STORE }
    )
  } catch (error) {
    return failure(error)
  }
}

export async function PATCH(request: Request) {
  try {
    const { owner, db } = await context(request)
    const update = parseSetupUpdate(await request.json())
    const { createIntegrationStore } = await import(
      "@/lib/integrations/store"
    )
    await Promise.all([
      db
        .doc(tenantDoc(owner.tenantId, "settings/current"))
        .set(update.settings, { merge: true }),
      update.realtimeIrlPullKey === undefined
        ? Promise.resolve()
        : createIntegrationStore(db, owner.tenantId).saveRealtimeIrlPullKey(
            update.realtimeIrlPullKey,
            Date.now()
          ),
    ])
    return NextResponse.json({ updated: true }, { headers: NO_STORE })
  } catch (error) {
    return failure(error)
  }
}

export async function POST(request: Request) {
  try {
    const { owner, db } = await context(request)
    const action = parseSetupAction(await request.json())
    if (action === "retry_twitch") {
      const { createIntegrationStore } = await import(
        "@/lib/integrations/store"
      )
      await createIntegrationStore(db, owner.tenantId).retrySetup(Date.now())
      const { processTenantTwitchSetup } = await import(
        "@/lib/integrations/twitch-setup"
      )
      return NextResponse.json(
        await processTenantTwitchSetup(owner.tenantId),
        { headers: NO_STORE }
      )
    }
    if (action === "enable_reward" || action === "disable_reward") {
      if (action === "enable_reward") {
        const [settings, integration] = await Promise.all([
          db.doc(tenantDoc(owner.tenantId, "settings/current")).get(),
          db.doc(tenantDoc(owner.tenantId, "private/integrations")).get(),
        ])
        const privateData = integration.data()
        if (
          !settings.exists ||
          typeof privateData?.realtimeIrlPullKey !== "string" ||
          typeof privateData?.overlayId !== "string"
        ) {
          throw new SetupError("setup_incomplete", 409)
        }
      }
      const { setTenantRewardEnabled } = await import(
        "@/lib/integrations/twitch-setup"
      )
      return NextResponse.json(
        await setTenantRewardEnabled(
          owner.tenantId,
          action === "enable_reward"
        ),
        { headers: NO_STORE }
      )
    }
    const { createOverlayAccessStore } = await import(
      "@/lib/overlay/access-store"
    )
    const credential = await createOverlayAccessStore(db).rotate(
      owner.tenantId,
      Date.now()
    )
    return NextResponse.json(
      {
        overlayUrl: `${publicRequestOrigin(request)}/overlay/${credential.overlayId}#${credential.secret}`,
      },
      { headers: NO_STORE }
    )
  } catch (error) {
    return failure(error)
  }
}
