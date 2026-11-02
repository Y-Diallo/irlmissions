# IRL stream producer — product reference

Build plan and progress: [PLAN.md](./PLAN.md). No further spec documents. Build everything in this thread with focused tests.

**Ready for real streaming Friday night, October 30, 2026 (Pacific).** Streaming Saturday/Sunday. Hackathon submission Monday, November 2 at 2 p.m. PST.

## The loop

1. Viewer submits a channel point redemption with a pitch.
2. Twitch AutoMod checks it. AutoMod flags reject. Optional small OpenAI model extracts place/challenge/duration, cleans wording, flags dangerous/illegal/harassing content for the streamer, and suggests duplicates.
3. Google Places finds a real public destination inside the configured radius. Pick the closest returned eligible match; show hours and Google Routes walking distance. No eligible public place means rejection. A provider error or stale location means Retry, not rejection.
4. Streamer edits and approves/rejects each pitch. Editing clears approval. Safety flags require human review. Duplicates are suggestions only; each redemption stays independent.
5. Streamer selects 2–5 approved ideas and starts a Twitch poll. Freeze those options during the poll; no edits to an active mission.
6. Winner automatically becomes the current mission. Losing ideas remain queued. No second approval required.
7. RealtimeIRL arrival or manual Arrived starts the timer once. The streamer marks complete or failed; timer expiry alone does not decide failure.
8. Streamer picks the next shortlist and starts the next poll. End stream refunds unused redemptions.

Defaults: 60-second polls; editable 10-minute mission duration; shortlist order breaks ties; zero votes or canceled polls produce no winner. Rejected pitches refund promptly; completed/failed attempted missions fulfill. Cancel before arrival refunds. Failed refunds show Retry and remain unresolved until confirmed. No full accounting ledger, merging system, or unattended next-poll flow.

## Screens

- **Setup:** Twitch connection, reward, search radius, base privacy zone, durations, arrival settings, LLM toggle, objectives/map OBS URLs, integration status, and End stream. The map URL is optional to add to OBS and is on whenever that source is present. Settings states plainly that the map publicly shows exactly where the streamer is going.
- **Phone console:** review queue, shortlist, poll state, active mission, large Arrived/Complete/Fail controls, retry errors, End stream. Navigation buttons open Google Maps, Apple Maps, or Waze; do not label Waze as walking routing.
- **Objectives overlay:** independent transparent browser source; custom game-show card moving through voting, heading there, arrived/timer, completed/failed. No dashboard components in the card.
- **Public destinations map:** optional separate OBS browser source. Unlike the objectives card, it intentionally publishes exact destination pins before arrival. It is enabled by adding the source to OBS and disabled by omitting it; there is no application-level map enable switch.
- **Simulator:** scripted walkthrough plus manual pitch/vote/location/failure controls and reset. Fake owner; no Twitch or API credentials required.

Console/setup use shadcn Vega with a light theme, high-contrast text, readable sizing, labels instead of icon-only primary actions, and large touch targets. Further visual polish follows the working loop.

## Privacy and safety

Nothing reaches public surfaces until the streamer approves its text and selects it for a poll. Approval includes a separate public label that does not identify the destination before arrival; this applies to Twitch poll choices and the objectives overlay. The optional map is the deliberate exception: adding it to OBS opts into publicly showing exact approved destination pins from the start of voting. Raw redemption text, addresses, safety flags, provider IDs, and private integration data stay private.

Publish a small allowlisted overlay document, never private records with fields hidden by CSS. Before arrival it contains no destination name, address, coordinates, distance, or navigation link. Arrival can reveal the place label; exact coordinates are unnecessary for the core overlay.

Keep base coordinates private and exclude destinations inside the privacy zone. The objectives card still requires location fresh within 30 seconds before it can reveal arrival. For viewer continuity, the separate public map keeps the last position and paths visible but greyed for up to 15 minutes after the location heartbeat stops. After 15 minutes it hides the position and clears the in-browser trail. Privacy-zone entry, missing coordinates, accuracy worse than 50 meters, or the manual **Hide live map position** control hide the position and trail immediately while destination pins remain. Never draw a line across a hidden interval. The streamer can use the manual control at any time; manual arrival does not bypass privacy restrictions.

### Public map behavior

- Render as a square Google map card with a hard drop shadow, preserving Google's logo and attribution inside the square. Keep one Maps JavaScript instance mounted for the lifetime of the browser source; hiding scales the card to zero rather than unmounting or reloading the billed map.
- Grow from scale zero with spring-like motion when a poll starts. Stay visible through voting, heading, arrival, and the terminal recap. Hide while idle, between polls, for no-travel missions, and after the recap hold.
- During voting, fit the camera to the visible streamer position plus every destination option. Use exact numbered pins matching poll order and show live vote percentages on the pins.
- When a winner is chosen, fade losing pins, ease the camera to the streamer and exact winning pin, and show the planned route returned by Google Routes as a dashed line.
- While heading there, follow the streamer and draw the real in-memory trail over the planned route. Ignore trail samples within roughly eight meters of the previous point. On arrival, visibly highlight the winning pin.
- On complete or fail, fit the camera to the trail and destination, redraw the retained trail over about two seconds, hold for about six seconds, then shrink away. If refresh left no in-memory trail, skip the redraw. A new poll clears the previous pins, route, and trail before growing the card again.
- The route geometry and latest private fix may be stored with the current pitch/session, but trail history is never persisted. There is no artificial trail delay.

LLM output is validated data, not authority: it cannot approve, publish, pick invented coordinates, or operate Twitch. Technical failures stay retryable. Human review remains necessary for suitability of an activity at a public place.

## Architecture

- Next.js App Router and TypeScript. Multi-streamer Twitch OAuth in Next route handlers; server-side token exchange/refresh/storage. Each verified Twitch user ID identifies an isolated tenant, with no configured owner allowlist. Mint a Firebase custom token after verification; authenticated commands derive their tenant from that identity. The tenant-scoping pass in PLAN.md is required before multi-user release.
- Each tenant owns its tokens, automatically provisioned reward ID, RealtimeIRL pull key, generated overlay credentials, privacy settings, pitches, polls, missions, and refunds. Owner APIs, signed EventSub intake, scheduled workers, and scoped overlay endpoints must all resolve the same tenant boundary. Global deployment configuration contains application/provider credentials only.
- Firebase Blaze is enabled. Firestore stores settings, session, pitches, and public overlay state. Server-only documents store integration tokens; browser rules deny access to them.
- All endpoints stay in Next.js for now. EventSub route only verifies, deduplicates, durably saves, and returns; challenges have their own response path. Shared services own processing, poll transitions, and provider calls. No separate Firebase Function or Firestore trigger in this version.
- Business logic lives in `web/shared/` with plain inputs and injected dependencies, independent of Next HTTP types. Routes are adapters; a future Function can reuse those services. Server-only adapters and secrets must never be imported into browser code.
- Saved events/pitches carry pending/processing/error status and retries. A separate processor invocation runs AutoMod, optional LLM extraction, Google Places/hours, Google Routes, and saved poll events. Wire reliable dispatch/recovery during implementation; a Firestore write alone does not run Next code, and fire-and-forget work after returning the webhook is not the processing strategy. Duplicate deliveries and interrupted work must be safe to retry.
- RealtimeIRL location updates go to scoped backend endpoints for search origin, arrival, and the public map projection. Overlay credentials cannot approve pitches or access owner tokens.
- Emulator mode uses fake owner and deterministic fake Twitch/AutoMod/LLM/Google/location providers through the same core flow. Require emulator configuration server-side; never allow a query parameter to enable production simulator access.
- Keep state simple: processing/review/approved/rejected pitch status, one current poll, one current mission, per-record retry count/error and redemption refund/fulfillment status. Stable IDs, transactions, and current-poll checks prevent duplicate effects; no general operation ledger.
- Google integration uses only required response fields, preserves attribution, and respects provider storage requirements. Opening hours are informational initially, not an automatic rejection rule. Walking distance is a Routes result, not a straight-line estimate.

## Essential tests and release gate

Test owner-only access and OAuth state; emulator-only fake login; webhook signatures/replays; edit un-approval; AutoMod/no-place rejection versus processing errors; human review of flags; 2–5 approved poll choices; stale/duplicate poll results; one-time arrival and timer reload; hidden destination/base-zone payloads; retries/refunds; a complete emulator walkthrough.

By Friday night, verify the real flow on the configured Twitch account and phone/OBS: redemption → review → poll → winner → arrival → complete/fail → next poll → refund. Mocked tests alone do not satisfy live readiness.

## Optional later

Command intake and chat announcements remain optional follow-ups. The public destinations map, route/trail, and terminal recap behavior above are part of the current application rather than future scope.
