# Build plan

One plan, build and test in this thread. No extra spec documents or implementation handoffs. [SPEC.md](./SPEC.md) is the short product reference.

**Live-ready deadline: Friday, October 30, 2026, night (Pacific).** Saturday and Sunday are streaming days: observe and fix bugs, not finish core integrations. Submission: Monday, November 2 at 2 p.m. PST. Firebase Blaze is enabled.

## Choices locked in

- Next.js App Router + TypeScript; shadcn **Vega** for setup/console. Light background, dark text, 16px body text, clearly labeled actions, visible focus, and at least 48px primary touch targets. Custom game-show overlay.
- Multi-streamer Twitch login through Next route handlers. Server validates the OAuth grant and learns the stable Twitch user ID from Twitch. Each streamer owns an isolated tenant keyed by that ID; tokens and integration settings live in that tenant. No configured owner ID/login allowlist. Mint a Firebase custom token for the verified identity.
- Firebase Auth, Firestore, and emulators; all server endpoints live in Next.js for now. EventSub route stays thin: verify, deduplicate, durably save, return. Business logic lives in `web/shared/`, independent of Next.js, so a future Firebase Function can call it unchanged.
- Google Places for search and opening hours; Google Routes for walking distance. Google Maps JavaScript API only for optional map sources. Navigation buttons: Google Maps, Apple Maps, Waze.
- Small OpenAI model for structured extraction and flags. RealtimeIRL frontend library in the overlay for private location input and arrival.
- Editing un-approves. Duplicate matches are suggestions only; no groups or merging. Retry status lives on the affected record; no operation ledger/framework.
- Simulator uses an emulator-only fake owner and fake providers. Judges need no Twitch account or API credentials.

## Setup

Use the official generator, preserving `docs/`, and choose `web` as the app directory:

```bash
pnpm dlx shadcn@latest init --preset vega --template next --name web
```

Vega is a named preset, so no custom preset code is needed. Check installed CLI help before execution. Let it generate Next.js and shadcn together; do not run a second scaffold over it. Install UI components through `shadcn add`, not handwritten lookalikes.

Keep the repo small: `web/` (including `app/api/` and `shared/`), `docs/`, Firebase config/rules, and a local runbook. No separate Functions package or shared-package build. Route handlers adapt HTTP requests to shared services; shared services accept plain inputs and injected storage/provider dependencies, never `NextRequest` or `NextResponse`. Keep server credentials/provider adapters out of client imports.

Current status: foundation, Twitch owner authentication, thin EventSub intake, durable pitch processing, phone-first review, live Twitch polls, Twitch redemption refunds/fulfillment, private active missions, scoped OBS objectives overlay, and privacy-checked RealtimeIRL arrival are implemented in `web/`. Poll and mission transactions write a separate allowlisted `publicState/current` projection. The custom overlay renders voting, heading, arrived/timer, completed, and failed states without receiving private records or owner credentials. RealtimeIRL samples remain private and require two fresh near-destination observations outside the base zone before arrival/reveal. Manual arrival starts the timer but does not reveal the place until that same check passes. Setup/settings, end-stream cleanup, and simulator seeding remain. Do not scaffold again.

Sources: [official Next.js/shadcn setup](https://ui.shadcn.com/docs/installation/next), [shadcn CLI](https://ui.shadcn.com/docs/cli).

## Next: tenant-scoping pass

Requested October 31. This section supersedes the original single-owner architecture and is the next implementation priority. The completed checkboxes below describe the existing single-tenant implementation, not multi-tenant readiness. Plan only so far: no tenant migration or application changes have been made. Build in this thread with focused tests; no additional spec documents, roles/team framework, or operation ledger.

Outcome: each streamer signs in with Twitch, gets an app-managed reward automatically, enters their own RealtimeIRL pull key and privacy settings, and receives their own OBS URL. Two simultaneous streamers must have independent queues, polls, missions, refunds, tokens, locations, and overlays.

### Data and trust boundaries

Use one validated tenant ID: the numeric Twitch user ID returned by server-side token validation. Firebase UID remains `twitch:{id}`. Emulator identities use explicitly separate demo tenant IDs and cannot be accepted in production. Store factories require a tenant context; no default or singleton fallback.

```text
owners/{twitchUserId}                 # profile, connection/setup status
  private/twitch                     # tokens, refresh lease, client ID
  private/integrations               # reward ID/title, setup retry state, RTIRL pull key
  settings/current                   # radius, base zone, durations, arrival and LLM settings
  privateState/location
  privateState/arrivalConfirmation
  sessions/current                   # current poll and mission
  publicState/current                # allowlisted overlay projection
  pitches/{redemptionHash}
  pollEvents/{pollHash}
  eventsubMessages/{messageHash}

serverAuthHandoffs/{handoffHash}      # short-lived record bound to tenant + connection
overlayAccess/{randomOverlayId}      # tenant ID + secret hash; server-only lookup
processorState/current              # bounded scheduler traversal cursor/lease
```

Global operational documents above are deliberate exceptions, not user data singletons. Firestore browser rules remain deny-all: the Admin SDK bypasses rules, so every route/store must enforce isolation. Owner APIs derive the tenant from the verified Firebase session and its Twitch connection. Never accept an owner ID in a request body as authority. EventSub derives its tenant from a verified signed event. Overlay access derives its tenant from the validated overlay credential.

### 1. Tenant storage and OAuth foundation

- [ ] Introduce the validated tenant context and central Firestore path helpers. Inventory and replace singleton references in `lib/auth`, `eventsub`, `pitches`, `polls`, `missions`, `redemptions`, `refunds`, `overlay`, and `realtimeirl`.
- [ ] Remove `TWITCH_OWNER_ID` and any proposed owner-login allowlist. Validate OAuth state, token client ID, required scopes, and Twitch identity; upsert only that user's tenant and credentials. Preserve settings/reward/overlay state on repeat login.
- [ ] Bind handoffs, Firebase claims, token refresh leases, refresh validation, and session revocation to the same tenant. Refreshed tokens must still identify the original user and app. Authentication failure for A must never revoke B.
- [ ] Make `requireServerOwner` return the authenticated tenant context. Update all callers to pass it through shared services and storage/provider factories; providers use that tenant's broadcaster ID and tokens.
- [ ] Tests: two valid Twitch users can sign in; malformed identities, wrong app/scopes, replayed handoffs, mismatched claims, and cross-connection handoffs fail. Concurrent login/refresh cannot overwrite another tenant or reset their configuration.

### 2. Scope the entire producer loop

- [ ] Scope queue listing, duplicate suggestions, edits, approval/rejection, processing/Retry, shortlist locks, poll creation/reconciliation, mission actions, refund listing, and bulk refund actions to the authenticated tenant.
- [ ] Keep all transaction reads/writes, public projection updates, and redemption leases under that tenant. Remove implicit global provider configuration from poll, AutoMod, and redemption adapters.
- [ ] Clear client queue/selection/mission caches when the signed-in account changes; prevent a late response from the previous account repainting the new account's console.
- [ ] Tests: A cannot list/process/edit/approve/poll/refund B's pitches or change B's mission, including when supplying B's IDs. Identical synthetic pitch/poll IDs in two tenants stay independent; duplicate suggestions never cross tenants.

### 3. Automatic Twitch reward and EventSub setup

- [ ] After successful sign-in, automatically run an authenticated, retryable setup operation. Keep it outside the OAuth handoff's critical path; the user can still reach setup when Twitch provisioning fails. Persist setup status on the tenant's integration record with a short lease.
- [ ] Use the stored reward ID first. Otherwise list app-manageable rewards and reuse the matching dedicated reward or create it. Default title `Pitch the next mission`, test cost 10 points, text input required, deferred fulfillment, initially disabled. Store Twitch's returned ID in Firestore; remove `TWITCH_REWARD_ID` from configuration.
- [ ] Never silently adopt an unmanaged reward or switch away from a stored missing reward while unresolved redemptions remain. Surface a repair action. For an uncertain create response, reconcile by listing before retrying; concurrent setup must not create duplicate rewards or overwrite custom cost/title on every login.
- [ ] Provision/reconcile the tenant's redemption-add and poll-end webhook subscriptions using an app access token. Persist reward state before subscribing so callback verification can resolve it. Match type/version/condition/callback; do not delete subscriptions belonging to other tenants. Save failures for Retry on the same integration record.
- [ ] Keep `/api/eventsub` thin: validate raw-body signature/timestamp before database tenant lookup; validate subscription/event broadcaster agreement and the tenant's configured reward, deduplicate and durably save under that tenant, return. Challenge handling now requires the registered tenant/reward lookup; update the old no-Firebase challenge tests. No reward provisioning, enrichment, or mission transitions in the webhook.
- [ ] Show reward/subscription readiness and an explicit enable control after settings and location are ready. Login alone does not enable paid intake. Preserve per-pitch original reward IDs for later refunds.
- [ ] Tests: repeated/concurrent setup, uncertain create recovery, unmanaged title collision, missing reward, partial subscription setup/retry, unknown broadcaster, cross-tenant reward mismatch, challenge handling, signature failures without DB access, and scoped event deduplication.

### 4. Per-streamer setup, RealtimeIRL, and overlay access

- [ ] Add a small authenticated setup page/API for the RealtimeIRL pull key, radius, base zone, mission duration, arrival settings, and LLM toggle. Store private values under the current tenant. Mask saved secrets and support replacement/removal without echoing them in ordinary settings responses.
- [ ] Generate a random overlay ID and secret per tenant. Store only the secret hash in the server-only overlay lookup; deliver the full URL once after creation/rotation: `/overlay/{overlayId}#SECRET`. On later visits offer regeneration if the URL was lost. Rotation immediately invalidates the previous credential.
- [ ] Scope overlay projection reads, RealtimeIRL config reads, and GPS submission to the tenant resolved by that credential. Keep the frontend RTIRL library: its pull key necessarily reaches the authorized OBS browser, so the overlay URL grants access to that tenant's location feed. It grants no owner actions or Twitch token access. Use no-store responses and redact credentials from logs.
- [ ] Remove global `REALTIMEIRL_PULL_KEY` and `OVERLAY_ACCESS_KEY` usage. Keep the existing freshness, two-sample arrival, base-zone suppression, and manual-arrival privacy behavior using tenant-specific settings/location/mission state.
- [ ] Tests: A's overlay secret cannot access B's overlay or submit B's location; random ID alone is insufficient; rotation revokes the old URL; settings cannot change tenant; private tokens/coordinates never enter public projections. Verify account switching and masked secret responses.

### 5. Tenant-aware scheduled processing

- [ ] Retain one OIDC-protected scheduler endpoint. Traverse connected tenant records with bounded pagination, a durable cursor/short lease, a per-run work cap, and an execution deadline; rotate fairly rather than always starting at the first account. Do not scan every tenant without a bound.
- [ ] For each tenant, invoke the existing scoped pitch/poll/refund processors with that tenant's credentials and settings. Keep per-record claims/retries and at most five sequential AutoMod checks per tenant in a scheduled batch; handle upstream throttling as retryable. Owner-triggered processing remains scoped to the session.
- [ ] Isolate failures: a disconnected or misconfigured tenant must not prevent others progressing. Persist retry/error state, retain pending refunds, and resume work after reconnect. Keep scheduler responses aggregate-only.
- [ ] Tests: A and B both make progress; one failing tenant does not block the other; cursor advancement/wraparound respects the work bound; overlapping runs cannot duplicate poll activation/refunds or cross-wire credentials. Add indexes only for the actual chosen queries.

### 6. Cutover, docs, and release check

- [ ] Inspect existing singleton documents and outstanding Twitch polls/redemptions before deployment. If live data exists, prepare an explicit, idempotent copy migration to the verified broadcaster's tenant, preserve source data, and report counts. Do not infer ownership for unverified data, silently abandon pending refunds, or delete old documents. If empty, record that no data migration is needed.
- [ ] Pause old scheduler/intake during any live data cutover; copy and verify before switching to scoped readers, deploy the consistent application/configuration, then resume. Avoid operating old and new processors against the same live redemptions. Regenerate old global overlay URLs; retain source data for recovery without running duplicate workers.
- [ ] Update `.env.example`, App Hosting instructions, README, and the existing product reference: global configuration contains Firebase, Twitch app credentials/callback/EventSub secret, Google/OpenAI credentials/model, and scheduler identity/audience. Streamer IDs, rewards, RTIRL keys, overlay credentials, and privacy settings live in Firestore. Remove stale single-owner instructions and tests.
- [ ] Run unit/route tests, TypeScript, and production build. Add a small two-tenant emulator isolation test for OAuth credential storage, scoped transactions, overlay lookup, and denied direct browser access. Defer the full scripted simulator; keep existing demo login working with scoped fake tenants.
- [ ] Live rehearsal: streamer A signs in, provisions reward/subscriptions, configures location and OBS, and completes redemption → review → poll → arrival → outcome/refund. A second Twitch login gets an independent account; two eligible broadcaster accounts are needed to prove simultaneous real reward/poll flows. Record any account limitation instead of claiming mocks prove the live path.

Completion gate: no production user-data singleton/global per-streamer secret remains; owner, EventSub, scheduler, and overlay entry points all resolve a verified tenant; A/B isolation tests pass; setup automatically persists Twitch IDs and saves each streamer's RTIRL key; live integration rehearsal is recorded. Implement steps in this order and release the scoping pass together.

## Build order — each step includes tests

### 0. Foundation

- [x] Verify the scaffold; add Firebase SDKs, Auth/Firestore emulator config, environment examples, deny-by-default rules, and framework-independent `web/shared/` services.
- [x] Add emulator-only fake-owner custom-token login and a minimal sign-in screen.
- [x] Add scripts/runbook and tests: 17 unit tests and 4 real emulator tests pass; TypeScript checking passes.
- [x] Production build passes with `pnpm exec next build --webpack`. Default Turbopack is blocked by this execution environment's internal port restriction; keep the normal build script unchanged.
- [x] Frontend HTTP check passes: homepage returns 200 with expected content; production demo login returns 404. Fixed and regression-tested incoming Host handling for Next's internal request URL.

No live deployment performed. Local run commands and Windows/WSL dependency notes are in [README.md](../README.md). Requires Node 22 and Java 21+.

### 1. Twitch login

- [x] Next route handlers: Twitch login, callback, logout. Validate OAuth state in a short-lived HttpOnly cookie; exact callback URL; exchange credentials only server-side.
- [x] Verify owner by stable Twitch ID, store tokens in a server-only Firestore document, mint Firebase custom token, sign the browser into Firebase. Never put Twitch tokens or the Firebase custom token in URL query strings.
- [x] Reusable backend owner guard verifies Firebase ID tokens with revocation checking and the configured owner's identity. Twitch validation and coordinated refresh run server-side.
- [x] Fake-owner login works only with verified emulator configuration on both server and client. No live fallback.
- [x] Test wrong owner, invalid OAuth state, private-token access denial, production rejection of simulator login, one-use handoffs, and refresh races. 58 unit tests and 8 real emulator tests pass.
- [x] Production Webpack build and HTTP checks pass: sign-in redirect/HttpOnly state, invalid-state callback rejection, anonymous access denial, same-origin logout, and production demo blocking. No live Twitch calls were made by the HTTP check.
- [ ] Configure live credentials/IAM and complete a real owner login before release; see the root runbook. Mocked Twitch tests do not verify the real account or app configuration.

### 2. Real intake and review — Thursday / Friday morning

- [ ] Create/configure an app-owned text-input reward with deferred fulfillment; confirm this app can refund it.
- [x] Thin Next EventSub route: verify raw-body signature/timestamp and expected subscription, deduplicate event IDs, atomically save accepted event/pending work, then return. Handle verification challenges separately. Shared services own validation/storage behavior; no enrichment or mission transitions in the route. Deduplicate redemptions by redemption ID as well; acknowledge only after durable save, and return a retryable error if saving fails.
- [ ] Shared processor: AutoMod → optional structured LLM extraction → Google Places → Google Routes → review queue. Process saved poll/revocation events through shared services too. Store pending/processing/error status, attempts, and an expiring claim on the affected record; bounded retries and a Retry button.
- [x] Wire a separate reliable invocation for pending processing before live release. A Cloud Scheduler OIDC-authenticated Next route scans pending work, due errors, and expired claims once per minute, processing at most five sequential pitches. Saving to Firestore still does not execute Next.js code; the webhook remains save-and-return. The live Scheduler job and service account must still be created after deployment.
- [x] Google Places text query for businesses/activities; restrict/filter to public POIs within radius and outside the base zone; choose closest returned eligible match. Fetch hours and show unknown when unavailable. Google Routes supplies actual walking distance.
- [x] Queue allows edits, approve/reject, safety-flag review, and duplicate suggestions. Any edit clears approval. No merging. Private place details, hours, walking distance, Maps link, and attribution stay behind the owner API; poll wording is checked against revealing the destination.
- [x] Test duplicate webhook delivery, save failures, interrupted processing/retry, AutoMod rejection, flagged human review, no-place rejection, service failure/retry, and edit invalidation.

EventSub boundary verification: 74 unit tests and 9 real emulator tests pass, including exact raw-body signatures, stale/tampered messages, wrong broadcaster/reward rejection, challenge handling without Firebase, retryable save failure, concurrent message/redemption deduplication, and browser denial for intake documents. TypeScript checking passes.

Processor and owner-review verification: 113 unit/HTTP-boundary tests and 12 real emulator tests pass. Coverage includes AutoMod short-circuiting, human-only LLM safety flags, strict non-stored structured output, constrained Google Places fields/attributions, walking Routes requests, no-place rejection, base-zone filtering, stale-location/provider retries, one-worker Firestore claims, stale-lease write rejection, due-work recovery, OIDC audience/account enforcement, authenticated review routes, approval rules, and transactional edit invalidation. No live provider calls were made. The shared-processor checklist remains open only for saved non-pitch event handling.

Production Webpack build passes with the processor and owner pitch routes emitted as dynamic server routes. No deployment, IAM mutation, service-account creation, or Scheduler job creation was performed.

### 3. Poll and mission — Friday

- [x] Select 2–5 approved pitches, preview public labels, start real Twitch poll. Lock included pitches against edits while polling/active. Twitch's 25-character choice limit is enforced during approval and poll creation.
- [x] Store poll ID, choices, status, and error on the session. After ambiguous creation failure, query Twitch for an exact attempt match and require reconciliation; never blindly create another poll.
- [x] `channel.poll.end` is verified and durably saved by the thin webhook, then the scheduled processor selects the winner once. Old/mismatched/duplicate results cannot replace the current poll; ties use shortlist order, zero votes/cancellation have no winner, losers stay approved, and the winner becomes the private active mission atomically.
- [x] Private active mission: destination, Google Maps/Apple Maps/Waze links, large manual Arrived, timer, Complete, and Fail controls. Waze is labeled as driving rather than walking.
- [x] RealtimeIRL adapter sends private fresh location to a scoped Next route calling shared arrival logic. Backend arrival check starts timer once; manual arrival uses the same transition. Two fresh samples spanning ten seconds are required; stale/reordered samples and the private base zone fail closed.
- [x] Timer uses server timestamps and survives reload; expiry waits for streamer outcome. Arrival and terminal actions are idempotent, while competing Complete/Fail commands allow only the first outcome.
- [x] Fulfill attempted missions and refund rejected pitches through the Twitch redemption adapter, with per-redemption claims, current-status reconciliation, bounded retries, pending/error/complete status, and manual Retry.
- [x] Dedicated owner-only refund screen queues every unlocked, unused pitch with a two-tap bulk action; locked poll choices and attempted missions fail closed.
- [ ] End stream closes intake, cancels the active poll, refunds unused pitches, and retries remaining refunds.
- [ ] Test shortlist limits, double taps, poll replay, loser retention, arrival once, reload/expiry, and refund retries.

Poll unit verification: 138 unit/HTTP-boundary tests pass. Poll coverage includes shortlist limits, approval/lock checks, exact Twitch request/response parsing, token refresh, known rejection unlocks, ambiguous-create lookup without a second POST, owner-only routes, signed poll-end intake, exact choice matching, tie/zero-vote outcomes, and stale event rejection. Per the live-first decision, Firestore-emulator transaction coverage for shortlist contention, lock release, and poll-end application is recorded testing debt; add it with the complete emulator loop after the live mission path exists.

Mission verification includes winner-only activation, locked-pitch and public-label checks, navigation-link construction, one-time arrival, server-based timer deadlines, reload-compatible state, arrival-before-outcome enforcement, double taps, competing outcomes, and owner-only routes. Twitch adapter coverage includes exact poll/refund/fulfillment requests, token refresh, ambiguous response reconciliation, terminal conflicts, automatic backoff, and manual retry. RealtimeIRL unit/HTTP coverage adds stale/future/duplicate sample rejection, two-sample confirmation, base-zone suppression, manual-arrival reveal without timer restart, scoped access, and provider payload mapping. Deferred testing still includes Firestore transaction integration, end-stream unused refunds, live GPS tuning, and the complete emulator loop.

### 4. Overlay, simulator, live rehearsal — Friday before streaming

- [x] Custom transparent game-show card: voting → heading there → arrived/timer → complete/fail. Poll and mission transactions maintain a separate public Firestore projection, and the response is rebuilt from an explicit allowlist rather than hiding private fields with CSS.
- [x] Base zone enforced before publication. The objectives card keeps the destination hidden until eligible arrival; the separate opt-in OBS map intentionally exposes exact approved destination pins. Scoped OBS access grants only overlay reads, RealtimeIRL config, and location submission—not owner commands or Twitch tokens.
- [ ] Phone console and desktop setup have legible controls, clear errors, integration status, location freshness, and retry actions.
- [ ] Scripted demo and manual controls use the same processing/mission code with fake provider adapters and emulator fake owner. Include votes, movement, flags, failures, and reset.
- [ ] Test rules, unauthorized reads/writes, hidden destination payloads, stale GPS, privacy zone, and one complete emulator loop.

Full unit/HTTP-boundary verification: 199 tests pass. Overlay and RealtimeIRL coverage includes every display state, malformed stored data, injected private fields, destination hiding, scoped authorization, stale/future/reordered GPS, base-zone suppression, and two-sample arrival. Twitch coverage adds exact poll and redemption contracts, token refresh, uncertain-write reconciliation, retry backoff, bulk unused-pitch refunds, and manual retry. Firestore remains deny-all to browsers; the OBS source has no Firebase or owner session. Deferred coverage remains emulator transaction assertions, live provider rehearsal, and the complete walkthrough.
- [ ] Deploy and rehearse with real Twitch redemption, AutoMod, Google result/hours/walking route, poll winner, RealtimeIRL arrival, OBS overlay, completion, and actual refund. Confirm phone access. This is the Friday release gate.

## Small defaults to build with

60-second poll; 10-minute mission duration editable before approval. Ties use shortlist order; zero votes/canceled polls return options to the queue. Arrival starts with 50m radius, two fresh samples spanning 10 seconds, samples no older than 30 seconds; tune against real GPS. Timer expiry does not auto-fail. Rejected/unused pitches refund; completed or failed attempted missions fulfill. These defaults remain easy to change without introducing another planning phase.

## Credentials/configuration needed for live rehearsal

Global deployment configuration: Firebase project ID/web config and hosting URL; Twitch client ID/secret, registered callback URL and EventSub secret; Google Places/Routes API enablement and restricted server key; optional OpenAI key/model; scheduler identity/audience. After the tenant pass, Twitch OAuth supplies each streamer's ID, provisioning supplies their reward ID, and their setup page saves their RealtimeIRL pull key and privacy settings in Firestore. Set global secrets through ignored local files or managed secrets, never docs or chat. Blaze is ready; API enablement and actual access still need verification.

## Weekend and submission

Saturday/Sunday: use it on stream, capture footage, fix observed blockers. Monday: clean-checkout emulator check and submit with a buffer before 2 p.m. PST.

The separate Google Maps JS OBS source is an explicit public-destination surface: exact option pins and vote percentages during voting, exact winner plus planned route and in-memory trail while traveling, then an in-place complete/fail recap. It is used by adding the browser source to OBS and otherwise omitted. Commands and announcements remain optional. None displace the live loop or judge demo.
