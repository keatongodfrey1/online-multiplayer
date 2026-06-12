# Claude Code prompt — finish the Splendor app (build `apps/web`)

> Paste everything below into Claude Code, running from the root of the `splendor-monorepo` repository.
> If you placed `SPEC.md` / `splendor_data.json` next to the repo, copy `SPEC.md` to the repo root (or `docs/SPEC.md`) first.

---

You are working in the `splendor-monorepo` repository: an online-multiplayer **Splendor** clone where each player plays from their **own device** (no pass-and-play, no install). Two of the three packages are already built and fully tested. Your job is to **finish the app**: build the `apps/web` React PWA client and wire everything so two browsers can actually play a complete game against each other (and AI) end-to-end.

## 0) Orient yourself first — read, don't assume

Before writing anything, read these (they are the ground truth; treat them as authoritative over anything I say here):

- `README.md` and `SPEC.md` (if present) — overall design. The client UI requirements live in the SPEC's client/UI section.
- `packages/engine/README.md`, `packages/engine/src/types.ts`, `packages/engine/src/index.ts` — the pure rules engine and its public API.
- `packages/server/README.md`, `packages/server/src/protocol.ts` — **the wire protocol is your contract.** Build the client against the `ClientMessage` / `ServerMessage` / `RoomView` / `RedactedState` types exactly.
- `packages/server/src/room.ts` — how the server behaves (what it sends, when, and what it enforces).

Then write a short PLAN.md (or print a plan) describing your milestones and the key design decisions below, and proceed milestone by milestone.

## 1) What already exists (and must not regress)

- **`@splendor/engine`** — pure, deterministic, browser- and Node-safe rules engine. No I/O, no `Math.random`, no DOM. `createGame / legalMoves / isLegalMove / applyMove / applyResolution / applyPass / redact / ranking`, plus `GreedyPolicy`/`RandomPolicy` and `assertInvariants`. 14/14 tests pass.
- **`@splendor/server`** — authoritative WebSocket server: rooms, crypto session tokens, per-recipient redaction, turn/legality enforcement, `reqId` idempotency, AI + server-driven forced pass, disconnect → AI takeover, host migration, reconnect, spectators. 13/13 tests pass. Transport-agnostic core (`GameServer` + `Room`) with a thin `ws` adapter (`wsAdapter.ts` → `startServer(port)`).

**Do not change the rules or the engine/server behavior.** Engine changes must be **purely additive** and covered by tests (see §3). The protocol in `protocol.ts` is fixed; if you truly need a new message, add it additively and update the server + its tests in the same change.

## 2) The one principle that governs the client

**The server is the only authority; the client is a view + an input device.** The client never decides rules outcomes. It renders the latest `RedactedState` the server sends and submits the player's intended `Move`/`Resolution`. The shared engine is used **only for optimistic UI** — highlighting which actions are currently legal/affordable so the board feels instant — and the server's `REJECTED` is always the final word.

## 3) Critical technical notes / gotchas (read carefully — these are real)

1. **The client gets `RedactedState`, not `GameState`.** `engine.legalMoves(state)` takes a full `GameState`, which the client does **not** have. So you must compute the current player's legal moves from the redacted view. The redacted view contains everything needed for *that* (public supply, public market cards, `deckCounts`, and the viewer's own gems/gold/bonuses/reserved via `players[you]`); opponents' hidden info never affects the viewer's own legal moves.
   - **Required additive engine work:** add pure helpers to `@splendor/engine`, e.g. `legalMovesForView(view: RedactedState): Move[]` and `affordableFromView(view, card)`, valid when `view.you === view.awaiting.seat && view.awaiting.inputType === 'MOVE'`.
   - **Cross-check test (do not skip):** in the engine's fuzz, at every MOVE step assert `legalMovesForView(redact(state, seat))` equals `legalMoves(state)` for that seat. This is the proof the client's optimistic legality matches the server's authority. If they ever disagree, the helper is wrong — fix it, don't paper over it.

2. **Never bundle the server's runtime into the browser.** `@splendor/server`'s barrel re-exports `wsAdapter`, which imports `ws` (Node-only). Do **not** import server runtime code in the client. **Preferred:** extract the wire types (`ClientMessage`, `ServerMessage`, `RoomView`, `RoomSeatView`, `Difficulty`, `LobbySettings`) into a tiny new `packages/protocol` package with **no runtime dependencies**; have `@splendor/server` import its protocol types from there, and the client import types from there too. (Acceptable lighter alternative: `import type { … }` from `@splendor/server` so the import is erased at compile — but the shared package is cleaner; pick one and justify it in PLAN.md.)

3. **Engine module format.** The engine currently builds CommonJS. Vite usually consumes a pure CJS dep fine via interop; try the default first. Only if Vite chokes, add an ESM build output to the engine (additive) rather than hacking the client.

4. **Session persistence + reconnect.** Persist `sessionToken` (and room code) in `localStorage`. On socket (re)connect, if a token exists, send `RECONNECT { sessionToken }`; on `ERROR UNKNOWN_SESSION`, clear it and show the lobby. Implement WebSocket auto-reconnect with backoff and a visible "reconnecting…" state.

5. **Ignore stale state.** `GAME_STATE` carries a monotonic `seq`. Track the highest applied `seq` and ignore any out-of-order/older message. Tag each outbound `MOVE`/`RESOLVE` with a fresh `reqId` (uuid). The server already re-syncs on duplicate `reqId`, so retries are safe.

6. **Don't reimplement rules in the UI.** Affordability/legality highlighting comes from the engine helpers in (1). The board never computes winners, noble eligibility, gold math, etc. itself.

## 4) Tech stack

- **Vite + React + TypeScript (strict).** Add `apps/web` to the workspace (update root `package.json` `workspaces` to include `apps/*`).
- **Vitest + React Testing Library** for tests.
- **`vite-plugin-pwa`** for the installable PWA (manifest + service worker / app-shell caching).
- A small state store is fine (`useReducer` or Zustand). Keep one source of truth driven by `ServerMessage`s.
- Config the server URL via `VITE_WS_URL` (default `ws://localhost:8080`).

## 5) What to build (feature scope — see the SPEC's UI section for detail)

- **Connection + lobby:** create room (get a shareable room code), join by code on a separate device/tab, see the seat list update live, host-only controls (add AI with difficulty, set options, remove a seat, start), graceful handling of `REJECTED`/`ERROR` (e.g., `NOT_HOST`, `NO_ROOM`).
- **Board (from `GAME_STATE`):** the three market rows (4 cards each) + tier decks with remaining counts; the token bank (5 gems + gold) with counts; the available nobles; each player's tableau (built-card bonuses by color, tokens, points, noble count); the viewer's **own** reserved cards face-up; opponents' reserved shown only as a count (the redaction already enforces this — render exactly what's in the view).
- **The four actions + sub-decisions:** take 3 different gems, take 2 of one (only when that pile ≥4), reserve (a market card or a blind deck-top, gaining gold if available, max 3 held), buy (a market card or one of your reserved). Then the mid-turn sub-decisions the server asks for via `AWAITING_INPUT`: **discard down to 10** (let the user choose which tokens) and **pick a noble** when more than one qualifies. Use the engine helpers to enable/disable controls; submit the corresponding `Move`/`Resolution`.
- **Turn + activity feedback:** clear "your turn / waiting on \<name\>" indicator (also reflect `deadlineTs` if present), an activity feed from `MOVE_APPLIED.summary`, per-seat connected/disconnected indicators from `PLAYER_CONNECTION`, host-migration reflected from `ROOM_UPDATE`, and a chat panel (`CHAT`).
- **End + spectator:** a game-over screen from `GAME_OVER` (final `ranking`, winner, tiebreak by fewest cards is already computed server-side). Spectators (joining after start) see the spectator-redacted board and have no action controls.
- **Accessibility (required):** full keyboard operation of every action; ARIA labels that include the **gem name** not just the color (the data's `meta.colorToGemName`: diamond/sapphire/emerald/ruby/onyx) and the count; never rely on color alone (pair color with icon/label/pattern); focus-trapped modals for discard/noble selection; an `aria-live` region announcing whose turn it is and each `MOVE_APPLIED`; adequate contrast.
- **Responsive / mobile-first:** must be usable and legible on a ~360px-wide phone in portrait, with ≥44px tap targets, and also work on tablet/desktop. This is a phone-in-hand game.

## 6) Server entrypoint (so the client has something to connect to)

Add a runnable entry to `@splendor/server`: `src/main.ts` calling `startServer(Number(process.env.PORT) || 8080)`, plus `start`/`dev` npm scripts. Document running it locally. (For production, check the WebSocket `Origin`; for local dev no origin check is needed.)

## 7) Suggested milestones (commit after each; run `typecheck` + tests each time)

If the repo isn't a git repo, `git init` and commit per milestone.

- **M1 — Scaffold.** Vite React TS app under `apps/web`, wired into the workspace; the shared `packages/protocol` (or chosen type-import strategy); the engine view-legality helpers (§3.1) **with the cross-check test passing**; a typed WebSocket client module and the message reducer (no UI yet).
- **M2 — Lobby end-to-end.** Create/join/add-AI/options/start working against the running server; two tabs see each other.
- **M3 — Board (read-only).** Render the full board from `GAME_STATE`; verify spectator mode renders correctly with nothing hidden leaked.
- **M4 — Interactions.** All four actions + discard/noble sub-decisions, with optimistic enable/disable from the engine helpers and `REJECTED` surfaced as a toast. Two tabs + an AI play a full game to `GAME_OVER`.
- **M5 — Resilience.** Reconnect with stored token, disconnect/host-migration indicators, activity feed, chat, game-over screen.
- **M6 — PWA + polish.** Manifest, service worker, installable, offline app-shell with a "reconnecting" state; responsive/mobile layout; accessibility pass.
- **M7 — Tests, CI, self-review.** Reducer tests (feed `ServerMessage`s, assert derived UI state — no socket needed) + at least one e2e test that boots a real `startServer` on an ephemeral port and plays a full game through the client's WS layer. Update `.github/workflows/ci.yml` to build/test `apps/web` after engine+server. Then do the skeptical self-review (§9).

## 8) Definition of done (acceptance checklist)

- [ ] `npm install` at the root succeeds; `npm run -w @splendor/engine test` and `npm run -w @splendor/server test` still pass unchanged (engine 14/14, server 13/13).
- [ ] New: `legalMovesForView` (or equivalent) exists and its cross-check test (equality with server `legalMoves` across a fuzz game) passes.
- [ ] `apps/web` typechecks (strict) and its tests pass; CI runs all three.
- [ ] Manual e2e: start the server, open the client in **two browser tabs**, create a room in one, join from the other, add one AI, start, and **play a full game to a winner** — including at least one buy, one reserve, one take-2, a forced over-10 **discard**, and (if it arises) a noble pick. The AI takes its turns automatically.
- [ ] Reconnect works: refresh a mid-game tab and it rejoins its seat with full state. Joining after start lands as a spectator with no hidden info.
- [ ] The app is installable as a PWA and the UI is usable on a 360px-wide viewport and via keyboard, with screen-reader-friendly labels.
- [ ] No server runtime (`ws`) ends up in the browser bundle; no game-rule logic is duplicated in the client beyond the shared engine.

## 9) Working method / quality bar (this matters — match the existing rigor)

- **Verify by running, not by asserting.** After each milestone actually run typecheck and the tests and a manual smoke check; report real results, including failures and how you fixed them. Do not claim something works without running it.
- **Be skeptical of your own code.** Before declaring done, do an explicit self-review pass hunting for: rule logic leaking into the client; trusting client input anywhere; assuming you can see hidden info; reconnect/stale-`seq` races; missing `REJECTED`/`ERROR` handling; accessibility gaps; and mobile-layout breakage. Fix what you find; list what you checked.
- **Don't fabricate.** The engine, the data file, and the SPEC are the source of truth for rules and content. If something is ambiguous, read the code/SPEC or ask — don't invent rules, card data, or protocol fields.
- **Keep changes scoped and additive.** Don't refactor the engine/server beyond the additive helpers/entrypoint/protocol-extraction described here, and keep their tests green.
- **Small, reviewable steps.** Prefer incremental commits with passing checks over one giant change.

## 10) Don'ts

- Don't implement the rules in the client (no winner/affordability/noble math outside the shared engine helpers).
- Don't import `@splendor/server` *runtime* (only types) into the client.
- Don't use `localStorage` for anything except the session token / room code.
- Don't weaken redaction or expose hidden state "for convenience."
- Don't break or skip the engine/server tests.

When you're done, summarize: what you built, the design decisions you made (especially the shared-types approach and the view-legality helper), the exact commands to run the server + client locally, and the results of the acceptance checklist.
