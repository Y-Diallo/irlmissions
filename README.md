# IRL Missions

Next.js producer console for chat-picked IRL objectives. Product behavior and build progress live in [the plan](docs/PLAN.md) and [the product reference](docs/SPEC.md).

## Judge demo versus live streaming

The judge demo needs **no Twitch account, Affiliate status, RealtimeIRL
account, OpenAI key, or server-side Places/Routes key**. On the deployed app,
choose **Try demo account**, then use the blue **Demo controls** panel. The optional map
still uses the deployment's referrer-restricted Maps JavaScript browser key.
The same flow works locally with the Firebase emulators and needs no external
credentials unless you want to render that Google map.

The live application requires a Twitch channel with **Affiliate or Partner
status** because Twitch restricts Channel Points rewards and polls to eligible
broadcasters. Real streaming also requires the Firebase, Twitch application,
RealtimeIRL, Google Maps Platform, and optional OpenAI configuration described
below. Judges who are not Affiliates should use **Try demo account**.

## Local setup

Use Node.js 22 LTS, pnpm 10, and Java 21+. Run all commands below from the project root. First emulator launch downloads Firebase's emulator binaries; later runs need no Twitch or provider credentials.

```bash
pnpm install
cp .env.example .env.local
pnpm emulators
```

If switching between Windows and WSL, run `pnpm install --force` once to rebuild platform-specific dependencies. Verification for this slice ran under WSL; do not share a `node_modules` installation between both environments.

In another terminal:

```bash
pnpm dev
```

Open http://localhost:3000 and choose **Try as demo owner**. This signs in as `demo-owner` through Firebase's Auth emulator. Emulator UI: http://127.0.0.1:4000. Auth listens on 9099; Firestore on 8080. Stop emulators with Ctrl+C; local data is ephemeral for now.

The emulator-only **Demo controls** panel can inject several pitch presets, add
votes to individual choices, end the simulated poll, move toward or arrive at
the destination, simulate GPS loss, and reset the demo tenant. Use the ordinary
producer UI to approve pitches, select choices, start the poll, and choose the
mission outcome. There is no scripted walkthrough.

The emulator scripts always use `demo-irlmissions`, even though `.firebaserc` identifies the live Firebase project. Leave `.env.local` in emulator mode for local development. Partial/mixed configurations are rejected rather than connecting to live services. Loopback hosts are intentional for this slice; phone access to local emulators is not configured yet.

## Testing and verification

All automated fixtures use synthetic tokens, users, locations, and provider responses. Unit and emulator tests do **not** call Twitch, OpenAI, Google Maps, RealtimeIRL, or the live Firebase project. Keep `.env.local` in emulator mode for automated local work.

### Quick choices

Run commands from the project root:

| Goal                      | Command                                                                         | What it proves                                                                                     |
| ------------------------- | ------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------- |
| Fast regression suite     | `pnpm test`                                                                     | Every unit and HTTP-boundary test with in-memory or mocked providers. No Java needed.              |
| One test file             | `pnpm exec vitest run tests/google-maps.test.ts`                                | Only the named file while iterating on one feature.                                                |
| Several focused files     | `pnpm exec vitest run tests/pitch-processor.test.ts tests/openai-pitch.test.ts` | A selected subsystem without unrelated tests.                                                      |
| Watch unit tests          | `pnpm test:watch`                                                               | Re-runs affected non-emulator tests as files change. Press `q` to exit.                            |
| Type safety               | `pnpm typecheck`                                                                | Checks every TypeScript source and test without emitting files.                                    |
| Real Firebase semantics   | `pnpm test:emulators`                                                           | Starts fresh Auth and Firestore emulators, runs transaction/Auth/rules tests, and shuts them down. |
| Production compilation    | `pnpm build`                                                                    | Next production compilation, route classification, static generation, and TypeScript.              |
| Restricted build fallback | `pnpm exec next build --webpack`                                                | The production check using Webpack when Turbopack cannot bind an internal worker port.             |
| Interactive local app     | `pnpm emulators`, then `pnpm dev` in another terminal                           | Manual browser testing with the fake owner and local Firebase services.                            |

Do not use `pnpm test -- tests/file.test.ts` for focused work: the package script's existing arguments can still select the full suite. Use `pnpm exec vitest run ...` as shown above.

### Unit and route-boundary tests

```bash
pnpm test
```

This is the default test while coding. It covers configuration fail-closed behavior, demo and Twitch authentication, OAuth cookies/handoffs/refresh races, EventSub signatures and replay handling, processor safety and retry decisions, owner review transitions/routes, and Twitch/OpenAI/Google provider request contracts. Network calls are injected and mocked; tests inspect URLs, headers, field masks, bodies, and sanitized failures without using real keys.

Useful focused commands:

```bash
pnpm exec vitest run tests/eventsub.test.ts tests/eventsub-route.test.ts
pnpm exec vitest run tests/pitch-processor.test.ts
pnpm exec vitest run tests/twitch-automod.test.ts
pnpm exec vitest run tests/openai-pitch.test.ts
pnpm exec vitest run tests/google-maps.test.ts
pnpm exec vitest run tests/processor-schedule.test.ts tests/processor-route.test.ts
pnpm exec vitest run tests/pitch-review.test.ts tests/pitches-route.test.ts
pnpm exec vitest run tests/polls.test.ts tests/twitch-polls.test.ts tests/poll-service.test.ts tests/polls-route.test.ts
pnpm exec vitest run tests/missions.test.ts tests/missions-route.test.ts
pnpm exec vitest run tests/oauth-routes.test.ts tests/twitch-auth.test.ts
```

For watch mode:

```bash
pnpm test:watch
pnpm exec vitest tests/pitch-processor.test.ts
```

The second command watches only that file. Vitest may show an interactive prompt; press `q` when finished.

### Firebase emulator integration tests

```bash
pnpm test:emulators
```

This starts isolated Auth and Firestore emulators under `demo-irlmissions`, runs `tests/firebase.emulator.test.ts`, and stops the services even when a test fails. It proves behavior mocks cannot: custom-token exchange, single-use handoffs, Firestore transaction contention, EventSub message/redemption deduplication, processor lease races, stale-lease rejection, transactional approval/edit invalidation, and deny-by-default browser rules.

Requirements:

- Java 21 or newer is on `PATH`.
- Ports 9099 and 8080 are free. Port 4000 is used by the UI during a long-running `pnpm emulators` session.
- Stop any existing `pnpm emulators` process before running the one-shot test command.

The first run can be slow while Firebase downloads binaries. A harmless Admin SDK metadata lookup warning can appear offline; the test result and clean emulator shutdown are authoritative. Data is fresh for every test command and is never written to the live project.

Prefer the provided script. Direct invocation of `tests/firebase.emulator.test.ts` requires the exact emulator host variables from `.env.example` plus `RUN_EMULATOR_TESTS=true`; otherwise that file intentionally skips.

### Interactive emulator testing

Terminal one:

```bash
pnpm emulators
```

Terminal two:

```bash
pnpm dev
```

Open http://localhost:3000 and choose **Try as demo owner**. Inspect Auth and Firestore at http://127.0.0.1:4000. The owner queue is connected through authenticated Next routes: it refreshes every ten seconds while visible and supports raw-text edits, public-label/duration edits, approve, reject, Retry, and **Process now**. Raw edits re-run all enrichment; public-detail edits return an approved pitch to pending review. Safety flags are warnings that always require an explicit owner decision. The browser never receives Twitch/provider credentials and cannot read Firestore directly.

The emulator starts empty. Until simulator seeding is added, use `pnpm test:emulators` for the complete synthetic review transaction or create pitches through the live-style EventSub boundary with synthetic signed fixtures. **Process now** uses deterministic fake providers in emulator mode, but it still needs the private settings/location documents that the upcoming setup screen will create. A processing error remains on its pitch and can be retried; it does not erase the original submission.

Changing `.env.local` requires restarting `pnpm dev`. Do not run the development server and a production build in the same app directory simultaneously.

### Production build

```bash
pnpm build
```

Use this before deployment checkpoints. In restricted environments where Turbopack cannot bind its worker port, run:

```bash
pnpm exec next build --webpack
```

The normal build script keeps Next's default. Builds can fetch remote font assets, so a sandboxed or offline machine may need network access or a populated cache. A passing build does not prove live credentials or external provider configuration.

### Live integration rehearsal

Live checks are deliberately manual and separate from automated tests. Use a dedicated low-cost reward and non-sensitive test text:

1. Sign in with the configured owner Twitch account and verify another account is denied.
2. Create and enable the app-owned text-input reward with deferred fulfillment.
3. Confirm Twitch accepts the EventSub challenge, then send one redemption and verify exactly one pending pitch.
4. Verify AutoMod-permitted and AutoMod-denied text using the channel's real settings.
5. Process a safe pitch and inspect OpenAI extraction, Google place identity, hours, attribution, and walking distance.
6. Repeat with a safety-flagged pitch, a no-place pitch, and one deliberately disabled provider to verify Retry behavior.
7. After the upcoming UI and poll work, complete the phone and OBS loop through refund or fulfillment.

Never paste keys into tests, committed files, URLs, or `NEXT_PUBLIC_` variables. Provider keys belong in ignored `.env.local` for local live checks and managed secrets when deployed.

Next's production command must use live-mode configuration: a demo `.env.local` is intentionally rejected if Firebase initialization is attempted in production. Slice 0 initializes SDKs lazily, so a build can complete without live secrets. To validate live behavior, configure `NEXT_PUBLIC_APP_MODE=live`, actual Firebase web config and matching `FIREBASE_PROJECT_ID`, and remove every emulator-host variable. App Hosting uses Application Default Credentials; do not place a service-account key in the app or browser bundle. Public config is baked into the frontend at build time.

## Code boundaries

- `app/api/`: thin Next HTTP adapters.
- `shared/`: framework-independent validation and services, with provider/storage dependencies passed in. A future Function can call these services directly.
- `lib/firebase/client.ts`: lazy browser SDK setup, including explicit emulator connections.
- `lib/firebase/admin.ts`: server-only Admin SDK setup, with fail-closed config validation.
- `firestore.rules`: deny all browser access for the foundation. Admin SDK bypasses rules. Scoped owner/overlay reads will be introduced and tested with those features; token documents will remain inaccessible to browsers.

Firebase config preserves the existing live project and App Hosting backend. No deployment is needed for local development, and local rule changes do not change deployed rules.

## Twitch owner login and tenant setup

For a real account, set `NEXT_PUBLIC_APP_MODE=live`, replace the Firebase web config with your project's values, set the matching `FIREBASE_PROJECT_ID`, and remove all four emulator-host variables. Enable Firebase Authentication in your project. Set these server-only variables in `.env.local` or App Hosting's managed environment/secrets:

```dotenv
TWITCH_CLIENT_ID=your_app_client_id
TWITCH_CLIENT_SECRET=your_app_client_secret
TWITCH_REDIRECT_URI=http://localhost:3000/api/auth/twitch/callback
```

Register that **exact** callback in the Twitch developer console. Open the app using the same hostname (localhost and 127.0.0.1 are different cookie hosts). On a hosted app use HTTPS and its real domain. Restart local Next after changing configuration; rebuild after changing `NEXT_PUBLIC_` values. Choose **Sign in with Twitch**. The app requests `channel:manage:redemptions`, `channel:manage:polls`, and `moderation:read`. The verified Twitch user ID becomes that account's tenant ID; there is no configured owner allowlist.

For local live access, provide an ignored service-account key outside the repo using `GOOGLE_APPLICATION_CREDENTIALS`, or use ADC with `FIREBASE_SERVICE_ACCOUNT_ID` selecting the signing service account. App Hosting uses its compute service account through ADC. The server needs Firestore read/write access, Firebase Auth user lookup/revocation access, and `iam.serviceAccounts.signBlob` on the signer for custom tokens. Configure the necessary IAM access before the real-account test; no IAM changes or deployment were performed by this implementation. See [Firebase custom-token signing](https://firebase.google.com/docs/auth/admin/create-custom-tokens).

Twitch access/refresh tokens stay in `owners/{twitchUserId}/private/twitch`, inaccessible to browser clients. The callback validates the signed, ten-minute state cookie and Twitch's user/client/scopes, then redirects to `/auth/complete` with a two-minute opaque HttpOnly handoff cookie. `POST /api/auth/session` consumes its hashed Firestore record once and returns a Firebase custom token whose owner claims match that Twitch user. Tokens never appear in redirect URLs. Expired handoffs cannot sign in; optional Firestore TTL on `serverAuthHandoffs.expiresAt` can clean up abandoned records.

`GET /api/auth/me` verifies the Firebase ID token with revocation checking, requires self-consistent Twitch UID and owner claims, and validates that tenant's server-held Twitch connection. Privileged routes call `requireServerOwner` and scope every path and provider call to the returned tenant ID. Active browser sessions recheck every fifteen minutes and on returning to the tab. Token use always validates with Twitch; a 401 triggers a coordinated server-side refresh and retains rotated refresh credentials. Invalid refresh credentials disconnect the integration and revoke Firebase sessions; temporary provider errors remain retryable.

**Sign out** clears this browser's Firebase session and auth cookies. It keeps the Twitch connection available for the stream and other devices. Emulator mode still uses **Try as demo owner**, with live Twitch OAuth disabled.

Implementation checks use mocked Twitch responses plus real Firebase emulators. A real Twitch account login is still required before live release. Mission services, stream integrations, and the complete judge simulation are next. Server tokens and secrets never belong in `NEXT_PUBLIC_` variables.

Sources: [Twitch code grant](https://dev.twitch.tv/docs/authentication/getting-tokens-oauth/), [token validation](https://dev.twitch.tv/docs/authentication/validate-tokens/), [token refresh](https://dev.twitch.tv/docs/authentication/refresh-tokens/).

After login, open `/setup`. Save the search radius, duration, private base privacy zone, and RealtimeIRL pull key, then generate the one-time OBS overlay URL. Twitch setup automatically creates or reuses the app-owned pitch reward and provisions the tenant's redemption and poll EventSub subscriptions. Keep the reward disabled until the setup page reports ready and the complete loop has passed rehearsal.

Generating the OBS credential now returns two browser sources: the objectives
card and an optional Google map. The map needs a separate browser key restricted
to **Maps JavaScript API** and the hosted app's HTTP referrer. Store it as the
App Hosting secret `GOOGLE_MAPS_BROWSER_KEY`; it is public browser
configuration, unlike the server-only Places/Routes key.

The optional map is an explicitly public destination surface: adding it to OBS
shows exact approved destination pins while the objectives card continues to
hide its destination until arrival. It grows in for voting, shows numbered
options and live vote percentages, then follows the winner with the planned
route and in-memory real trail. When the location heartbeat stops, the public
map keeps the last position and paths visible but greyed for up to 15 minutes
for viewer continuity; this does not relax the objectives card's 30-second
arrival threshold. After 15 minutes the map hides the position and clears the
trail. Privacy-zone entry, low-accuracy or missing coordinates, and the manual
**Hide live map position** switch hide the streamer marker and trail
immediately; destination pins remain. The streamer can use that switch at any
time. The trail is never stored. Complete/fail replays any trail still in that
browser's memory, holds the recap, then hides the card.

## EventSub intake

The live webhook is `POST /api/eventsub`. Add these server-only values after the app-owned, text-input reward is provisioned:

```dotenv
TWITCH_EVENTSUB_SECRET=a_random_10_to_100_character_secret
```

The per-tenant setup worker creates three version `1` webhook subscriptions using the same deployed `/api/eventsub` callback and global signing secret: `channel.channel_points_custom_reward_redemption.add` for that tenant's discovered reward, plus `channel.poll.progress` and `channel.poll.end` for that tenant's broadcaster ID. Progress events drive live overlay and map vote totals; end events resolve the winner.

The callback must be public HTTPS on port 443. The poll subscription requires the existing `channel:manage:polls` user scope. Do not enable `should_redemptions_skip_request_queue`: the app needs deferred fulfillment so rejected and unused pitches can be refunded.

The webhook verifies Twitch's HMAC against the exact raw request body before using the signed broadcaster ID to resolve its tenant. It rejects timestamps outside the replay window and requires matching header/body subscription metadata, broadcaster, and tenant reward. Notifications are acknowledged only after one tenant-scoped Firestore transaction creates the message receipt and pending pitch; duplicate message IDs and redemption IDs are harmless. A write failure returns 503 so Twitch can retry. Revocations are saved for the processor to surface later.

`eventsubMessages`, `pitches`, and `pollEvents` remain inaccessible to browser SDKs under the current rules. Authenticated Next routes expose allowlisted owner views rather than granting clients direct access to raw intake documents.

Sources: [Twitch webhook handling](https://dev.twitch.tv/docs/eventsub/handling-webhook-events/), [redemption subscription](https://dev.twitch.tv/docs/eventsub/eventsub-subscription-types/#channelchannel_points_custom_reward_redemptionadd).

## Live Twitch polls

Approved public labels are limited to Twitch's 25-character choice limit. The owner selects 2–5 unlocked pitches and starts a 60-second poll from the console. `POST /api/polls` reserves the shortlist in one Firestore transaction before making the external request, so double taps cannot create two local attempts. Twitch receives only the approved public labels—never raw pitch text, safety flags, place details, or coordinates.

If Twitch clearly rejects creation, the attempt records the error and unlocks its pitches. A timeout, provider error, or malformed success is treated as ambiguous because Twitch may already have created the poll. The service immediately queries recent polls for the exact title, duration, ordered choices, and start window. If it cannot prove a match, it keeps the pitches locked as `create_unknown`; **Reconcile with Twitch** performs read-only recovery and never sends another create request.

The thin EventSub route saves `channel.poll.end` as pending work. The existing Scheduler endpoint applies it idempotently: it verifies the current Twitch poll and exact choice IDs/titles, uses shortlist order for ties, returns all choices for zero votes or cancellation, unlocks losers, and holds the winner for mission activation. Poll completion may therefore appear in the console on the next one-minute Scheduler run.

Focused unit tests:

```bash
pnpm exec vitest run tests/polls.test.ts tests/twitch-polls.test.ts tests/poll-service.test.ts tests/polls-route.test.ts
pnpm exec vitest run tests/eventsub.test.ts tests/eventsub-route.test.ts
```

These tests mock Twitch and Firestore boundaries; they make no external calls. The intentionally deferred testing pass still needs real Firestore-emulator tests for competing shortlist transactions, lock release, poll-end application, and the full judge walkthrough.

Sources: [Twitch Create Poll API](https://dev.twitch.tv/docs/api/reference/#create-poll), [Twitch Poll End EventSub](https://dev.twitch.tv/docs/eventsub/eventsub-subscription-types/#channelpollend).

## Shortlist and active mission

The shortlist preserves selection order, which is also the tie-break order. It previews the exact approved labels sent to Twitch. Starting another poll is blocked while the current mission is heading to its destination or running.

When the scheduled processor applies a valid poll winner, the same Firestore transaction creates a private mission from the locked winning pitch, returns losing pitches to the approved queue, and marks the winner as `active_mission`. The owner mission endpoint is the only browser path to its destination, route, and navigation links; browser Firestore access remains denied.

The phone mission card includes:

- Private destination, address, hours, attribution, walking distance, and expected walking time.
- Google Maps and Apple Maps walking directions.
- Waze navigation explicitly labeled as driving.
- A large manual **I've arrived** control.
- A server-timestamp countdown that survives refresh and does not auto-fail at zero.
- Large **Complete mission** and **Mark failed** actions.

Arrival starts the timer once. Duplicate arrival or duplicate same-outcome taps are idempotent; Complete and Fail require arrival, and the first conflicting outcome wins. A terminal outcome marks the pitch completed/failed and creates a pending Twitch `fulfill` resolution record. The scheduled processor sends it through the live redemption adapter and does not claim success in the UI until Twitch confirms it.

Focused tests:

```bash
pnpm exec vitest run tests/missions.test.ts tests/missions-route.test.ts
```

These are unit and HTTP-boundary tests only. The later testing pass still needs emulator transaction coverage for atomic winner activation and outcome writes plus one full walkthrough.

## Twitch poll and redemption adapters

The live poll path uses Twitch Helix through `shared/providers/twitch-polls.ts`. It sends only approved public labels, refreshes the owner token once after a 401, and treats an uncertain create response as ambiguous. It then lists recent polls and attaches only an exact attempt match; it never blindly creates a second poll.

Redemption resolution uses `shared/providers/twitch-redemptions.ts`. Owner, AutoMod, and no-public-place rejections queue a refund; completed and failed attempted missions queue fulfillment. The scheduled processor claims each resolution with a two-minute lease, reads the current Twitch status, then sends the corresponding update:

- Refund becomes `CANCELED`, which Twitch defines as returning the viewer's Channel Points.
- Fulfillment becomes `FULFILLED`.

The worker marks a pitch resolved only after Twitch returns the exact broadcaster, reward, redemption, and expected status. A timed-out PATCH is read back before retrying, since Twitch may have applied it. Retryable failures back off from 15 seconds for up to five automatic attempts. Permanent or exhausted errors remain on the pitch with a large **Retry Twitch update** action; manual retry resets the small retry state rather than creating an accounting ledger.

The setup worker creates or reuses the app-owned reward, requires text input, and keeps Twitch's request queue enabled. Twitch only lets the app that created the reward change an unfulfilled redemption, so reward provisioning always uses the same Twitch application as OAuth.

The producer console links to a dedicated `/refunds` screen. Its large two-tap **Refund unused pitches** button queues every currently unlocked, unattempted redemption, including failed refunds that need another try. It never includes an active, completed, or failed mission, and it leaves poll-locked choices alone until that poll is resolved. Queueing a refund also invalidates unfinished enrichment work so a late provider response cannot return that pitch to review.

The same screen now combines automatic refund status with removed-pitch history.
Every unlocked viewer pitch has a two-tap removal control. Removing an
unattempted pitch archives it and automatically queues its Channel Points
refund; removing a completed or failed pitch only archives it while fulfillment
continues. Records are retained for history and retry state rather than deleted.
The recovery button is a fallback for missed or exhausted retries, not the
normal refund workflow.

Focused tests:

    pnpm exec vitest run tests/twitch-polls.test.ts tests/poll-service.test.ts tests/twitch-redemptions.test.ts tests/redemptions.test.ts

These tests use synthetic tokens and mocked HTTP responses. They verify exact Helix URLs, headers and bodies, 401 refresh, poll-create ambiguity, redemption read-back reconciliation, bounded retries, terminal conflicts, refund queuing, and fulfillment without calling Twitch.

Sources: [Twitch Create Poll](https://dev.twitch.tv/docs/api/reference/#create-poll), [Twitch Update Redemption Status](https://dev.twitch.tv/docs/api/reference/#update-redemption-status).

## OBS objectives overlay

Each tenant gets a browser source at `/overlay/{overlayId}` that reads only that tenant's `publicState/current` through `GET /api/overlay`. Firestore rules still deny browser reads. On `/setup`, choose **Generate new overlay URL**, copy the URL shown once, and paste it into OBS.

The generated secret is after `#`, so the initial page request and referrer do not contain it. The overlay JavaScript sends the overlay ID and fragment secret only in scoped API authorization headers. Firestore stores only its hash. Do not share the OBS URL publicly; rotating it on `/setup` invalidates the previous source immediately.

Recommended OBS browser-source size is 1280×720. The source background is transparent and the custom game-show card anchors to the lower left. It polls every two seconds and displays:

- Standby when there is no current public activity.
- Ordered approved choices while voting.
- Approved objective wording while heading to the private destination.
- Objective, revealed destination, Places photo, and server-timestamp timer after arrival.
- Completed or failed outcome over the revealed destination photo when available.

Place photos use the existing server-only `GOOGLE_MAPS_API_KEY` and Places API
(New). The app requests fresh photo metadata only after the privacy-checked
destination reveal, returns a short-lived Google-hosted image URL to the scoped
overlay, and renders any required author attribution. It does not store Google
photo resource names or expose the API key.

The projection never contains redemption IDs, Twitch choice/poll IDs, raw viewer text, safety flags, address, coordinates, route, navigation links, or tokens. Place name is the only destination field the schema permits, and it is omitted unless `destinationRevealedAt` was set by a privacy-checked GPS arrival or the owner's manual **I've arrived** tap, which both starts the timer and reveals the place.

Focused tests:

```bash
pnpm exec vitest run tests/overlay.test.ts tests/overlay-access.test.ts tests/overlay-route.test.ts
```

These are unit and HTTP-boundary tests only. Later emulator coverage must prove that poll/mission transitions atomically update the projection and that browser SDK reads remain denied for `publicState`.

## RealtimeIRL arrival

The same keyed OBS objective source subscribes to the official `@rtirl/api` push client. It reads the provider's `reportedAt` timestamp from the root feed and sends only latitude, longitude, and that observation time to `POST /api/realtimeirl/location`. The endpoint verifies the scoped overlay key before parsing the small JSON body or initializing Firebase. Exact location is written only to `privateState/location`; it is never added to the overlay projection.

Save each streamer's pull key on their authenticated `/setup` page. It is stored in that tenant's private integration document. The authenticated overlay source retrieves it from `GET /api/realtimeirl/config`; it is not embedded in the application bundle or returned by the public projection endpoint. Anyone with the OBS URL can access that tenant's scoped telemetry integration, so rotate the overlay URL if it is exposed.

Arrival reads `settings/current`. `baseZone` is mandatory; the other values use the shown defaults when omitted:

```json
{
  "baseZone": {
    "latitude": 37.7,
    "longitude": -122.5,
    "radiusMeters": 100
  },
  "arrivalRadiusMeters": 50,
  "arrivalSampleSpanMs": 10000,
  "arrivalLocationMaxAgeMs": 30000
}
```

Use your actual private base coordinates in Firestore, never in committed files. Automatic arrival requires two distinct, fresh observations inside the destination radius spanning at least ten seconds. A stale, future-dated, duplicate, reordered, outside-radius, or base-zone sample cannot start the timer or reveal the destination. Leaving the arrival radius or entering the base zone clears a pending confirmation. If the owner tapped **I've arrived**, the place is already revealed and later samples change nothing.

Focused tests:

```bash
pnpm exec vitest run tests/realtimeirl.test.ts tests/realtimeirl-route.test.ts tests/realtimeirl-client.test.ts
```

These cover sample parsing, freshness, duplicate ordering, two-sample confirmation, base-zone suppression, manual-arrival reveal, scoped routes, and provider payload mapping without connecting to RealtimeIRL. Firestore-emulator transaction coverage and a live GPS rehearsal remain release checks.

Sources: [RealtimeIRL client API and push-listener usage](https://github.com/muxable/rtirl-obs/tree/main/api), [official RealtimeIRL OBS overlays](https://github.com/muxable/rtirl-obs).

## Pitch processor foundation

`shared/pitches/processor.ts` owns the provider-independent workflow. Each pitch gets a two-minute Firestore claim; only that lease may complete, reject, or save an error. Expired claims can be recovered. Automatic failures back off from 15 seconds and stop after five attempts, leaving the record available for a manual Retry action.

Processing checks Twitch AutoMod before calling the LLM, Places, or Routes. AutoMod denial is a terminal rejection. OpenAI output is extraction and risk metadata only: it cannot approve a pitch, choose coordinates, publish a poll label, or call tools. Risk flags remain pending for the owner. The Responses API request uses strict Structured Outputs, `store: false`, and no tools. The current efficient default is configurable:

```dotenv
OPENAI_API_KEY=your_server_only_key
OPENAI_MODEL=gpt-6-luna
```

Google Places (New) and Routes use the same restricted server key:

```dotenv
GOOGLE_MAPS_API_KEY=your_server_only_google_maps_key
NEXT_PUBLIC_GOOGLE_MAPS_BROWSER_KEY=your_referrer_restricted_browser_key
```

Enable Places API (New) and Routes API for the project. Restrict this key to those APIs and to the deployed server environment where your Google Cloud setup supports that restriction; do not expose this server key to browser code. The Places request uses a circular location restriction and an explicit minimal field mask for place ID, display name, address, coordinates, status, hours, Maps URI, and attributions. The Routes request asks only for walking distance and duration and deliberately omits driving-only routing preferences.

Settings and current location will live in private `settings/current` and `privateState/location` documents. The processor expects search radius, base privacy zone, default duration, LLM toggle, and a fresh private location. Simulator fake providers support deterministic AutoMod rejection, risk flags, no-place results, and provider failures through the same shared workflow.

Google Maps content is kept with the active pitch so the owner can review and run the mission. The review UI must show Google Maps attribution plus returned third-party attributions. Session cleanup/retention must remove cached place content in accordance with the applicable Google Maps terms; place IDs can be retained. No route polyline is requested or stored.

The webhook remains save-and-return only. A separate scheduled endpoint performs enrichment as described below.

Sources: [Twitch Check AutoMod Status](https://dev.twitch.tv/docs/api/reference/#check-automod-status), [OpenAI Structured Outputs](https://developers.openai.com/api/docs/guides/structured-outputs?api-mode=responses), [OpenAI model selection](https://developers.openai.com/api/docs/guides/model-selection), [Google Text Search](https://developers.google.com/maps/documentation/places/web-service/text-search), [Google Routes](https://developers.google.com/maps/documentation/routes/reference/rest/v2/TopLevel/computeRoutes), [Google Places policies](https://developers.google.com/maps/documentation/places/web-service/policies).

## Scheduled pitch processing

`POST /api/internal/process` is the reliable recovery path. A Cloud Scheduler job calls it once per minute. Each invocation scans pending pitches, due retry errors, and expired worker claims, then processes at most five sequentially. The five-item cap respects Twitch's lowest documented AutoMod rate of five checks per minute. Overlapping or retried Scheduler requests are safe because the Firestore claim transaction admits only one worker.

The endpoint is hidden in emulator mode. Live requests require a Google-signed OIDC token with both:

- Audience exactly equal to the deployed `https://HOST/api/internal/process` URL.
- Verified email exactly equal to `PROCESSOR_SERVICE_ACCOUNT_EMAIL`.

Configure these non-secret runtime variables in App Hosting:

```dotenv
PROCESSOR_AUDIENCE=https://YOUR_HOST/api/internal/process
PROCESSOR_SERVICE_ACCOUNT_EMAIL=irl-processor@YOUR_PROJECT.iam.gserviceaccount.com
```

After deployment, create the caller identity and Scheduler job. Fill in the values explicitly before running these commands; the Scheduler region can match the nearest supported region to the App Hosting backend:

```bash
export PROJECT_ID=your-firebase-project-id
export SCHEDULER_REGION=us-central1
export PROCESSOR_URL=https://your-host.example/api/internal/process
export PROCESSOR_SERVICE_ACCOUNT=irl-processor@your-firebase-project-id.iam.gserviceaccount.com

gcloud services enable cloudscheduler.googleapis.com --project="$PROJECT_ID"

gcloud iam service-accounts create irl-processor \
  --project="$PROJECT_ID" \
  --display-name="IRL pitch processor scheduler"

gcloud scheduler jobs create http irl-pitch-processor \
  --project="$PROJECT_ID" \
  --location="$SCHEDULER_REGION" \
  --schedule="* * * * *" \
  --time-zone="Etc/UTC" \
  --uri="$PROCESSOR_URL" \
  --http-method=POST \
  --oidc-service-account-email="$PROCESSOR_SERVICE_ACCOUNT" \
  --oidc-token-audience="$PROCESSOR_URL" \
  --attempt-deadline=90s \
  --max-retry-attempts=2 \
  --min-backoff=10s \
  --max-backoff=60s
```

The person creating the job needs permission to act as the caller service account. Cloud Scheduler's service agent must retain `roles/cloudscheduler.serviceAgent`; do not use that Google-managed service agent as the caller identity.

Test the deployed job without waiting for the next minute:

```bash
gcloud scheduler jobs run irl-pitch-processor \
  --project="$PROJECT_ID" \
  --location="$SCHEDULER_REGION"
```

Then check the Scheduler execution result and App Hosting logs. A `200` response contains only aggregate counts. Authentication failures return `401`; configuration/provider infrastructure failures return `503` so Scheduler retries. Individual pitch provider failures are saved on the pitch with bounded backoff and do not fail the entire scheduled invocation.

Local automated coverage:

```bash
pnpm exec vitest run tests/processor-schedule.test.ts tests/processor-route.test.ts
pnpm test:emulators
```

The unit tests use a mocked Google token verifier. The emulator suite proves due-record scanning and lease recovery. No test needs a real service account or calls Cloud Scheduler.

Sources: [Cloud Scheduler HTTP authentication](https://docs.cloud.google.com/scheduler/docs/http-target-auth), [Cloud Scheduler retries](https://docs.cloud.google.com/scheduler/docs/configuring/retry-jobs), [Firebase App Hosting runtime](https://firebase.google.com/docs/app-hosting/frameworks-tooling).
