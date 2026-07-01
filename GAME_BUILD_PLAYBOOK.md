# Game-build playbook — start here for any new game

This is the single home for the **UI/UX house rules and protocol/architecture
gotchas** that aren't obvious from the framework code and that have cost real
rework. `CLAUDE.md`, `ADDING_A_GAME.md`, and `ARCHITECTURE.md` point here; they
don't restate it.

Why this exists: Water Fight needed two painful rounds of cleanup (PR #35, #36)
because the original build missed conventions that live in the codebase but
weren't written down — light text on a dark app, cramped layout on tablets,
a new engine action silently dropped by the sanitize whitelist, "seat 1" in the
log instead of names. **Every fix already had a pattern in the repo to copy.**
This doc points at those patterns so the next game is right the first time.

> Read this alongside `ADDING_A_GAME.md` (the exact five-place recipe) and
> `ARCHITECTURE.md` (framework lifecycle + API gotchas). This doc is the
> *conventions* layer on top of those two.

---

## Table of contents

1. [Kickoff brief — paste this to start a build](#1-kickoff-brief)
2. [UI/UX house rules](#2-uiux-house-rules)
3. [Show, don't hide — and respect secrecy](#3-show-dont-hide)
4. [Architecture rework-savers](#4-architecture-rework-savers)
5. [Cross-game gotchas already paid for](#5-cross-game-gotchas)
6. [Copy-from reference table](#6-copy-from-reference-table)
7. [Pre-flight checklist](#7-pre-flight-checklist)
8. [Keeping this current (living doc)](#8-keeping-this-current)

---

<a id="1-kickoff-brief"></a>
## 1. Kickoff brief — paste this to start a build

Fill in the blanks and hand this to the agent at the start of a new game. It
front-loads the four locked decisions (`CLAUDE.md`) plus the device target —
the things that shape the schema and room and are a rewrite to change later.

> Build a new game in this monorepo: **\<NAME\>** — \<one-line pitch\>.
>
> Locked decisions:
> - Players: **\<min\>–\<max\>** (is there a 2-player edge case — abandon vs. play on?)
> - AI bots: **\<yes / no\>** (difficulty levels?)
> - Hidden information: **\<none / private hands / secret roles\>**
> - Device target: **iPad mini + larger tablets + laptops + phones** (the owner
>   plays on an iPad mini — tablet-wide layout AND phone-narrow both matter)
>
> Follow `ADDING_A_GAME.md` (the five places, literally) and
> `GAME_BUILD_PLAYBOOK.md` (UI house rules + protocol rework-savers). For a
> rules-heavy game, **port the rules as a pure engine first**
> (`shared/src/games/<game>/engine/`, no Colyseus imports), unit-test the
> engine, then write the room as a thin adapter (copy `SplendorRoom`/`CatanRoom`,
> not the thin TicTacToe room).
>
> **Show AND explain every beat (see §3):** make every consequential moment — dice
> roll, card drawn, card played, card bought, attack, block, life/coin change,
> turn-order, triggered event — instantly obvious AND explained (what the card/event
> does, not just its name), held long enough to read. Audit for silent actions that
> change state but show nothing. Build this in from the first commit — it is part of
> the definition of done, not a later polish pass.
>
> **The ending is part of the game:** at game-over, show who won, why, and the
> deciding move *before* the standings screen (a held reveal beat — see §3). Build
> it from the start; don't ship a bare standings card and wait to be asked.
>
> Verify in two browser windows at **tablet (~1024) AND phone (~390)** widths,
> including a mid-game refresh, and **send screenshots** (the owner is a
> non-coder; the screenshot is how they confirm it works).

---

<a id="2-uiux-house-rules"></a>
## 2. UI/UX house rules

The app is a **dark theme** played on **tablets and phones** by a non-coder.
Every rule below has a copy-from reference — open it, don't reinvent it.

- **Dark theme tokens only.** Use the CSS variables from `:root`
  (`client/src/style.css:2`): `--bg --card --text --muted --accent --accent-press
  --danger --ok --warn`. Never hardcode a light color (`#fff`, `white`,
  `background: none`). The single biggest Water Fight bug was light text that was
  invisible on the dark app.

- **Mobile-first AND tablet/laptop-wide.** The base `#app` column is capped near
  480px. Break out of it for your game root with a `:has()` rule keyed on the
  game's root class — copy `#app:has(.spl)` (`style.css:237`) or
  `#app:has(.wf)` (`style.css:2265`, which lifts to 1040px / 1180px ≥900px /
  100% ≤768px). Give the game root a short class (`.spl`, `.pp`, `.wf`). On wide
  screens use a **two-column dashboard**; collapse to a single flex column on a
  phone. Don't grid a flat list of children — wrap them into two explicit
  containers (e.g. `.wf-main` / `.wf-side`).

- **44px minimum touch targets.** The owner plays on an iPad mini. The default
  `button { padding: 12px }` is ~44px — don't override it smaller. Icon buttons
  get an explicit `width/height: 44px` (see `.wf-ic`).

- **No `title` tooltips — they never appear on touch.** To explain a control,
  use the shared tap-popover: `infoButton(hint, label)` renders an ⓘ button and
  `wireInfoButtons(container)` wires the popover (`client/src/framework/infoPopover.ts`).
  The popover lives on `document.body`, so a re-render of the surrounding subtree
  can't destroy it mid-open. For card meanings, also offer a tappable card → a
  detail modal (below).

- **Lobby number settings = `−` / `+` steppers, not `<input type=number>`.**
  Native number inputs show **no spinner arrows on mobile**. Copy the stepper:
  the global `.wf-stepper` CSS (`style.css:2234`) + `renderWaterFightLobbySettings()`
  (`WaterFightView.ts`), which renders each row from the shared `WF_SETTINGS`
  descriptor table (`shared/src/games/waterfight/index.ts:46`) — every setting
  carries a `label` + a `hint`, and the row auto-gets an ⓘ via `infoButton`.
  **Define settings as a descriptor table, not hand-rolled per row.**
  **Lobby CSS MUST be global** in `client/src/style.css` — the lobby renders the
  game's settings while the in-game view (and its injected `<style>`) is
  unmounted, so an in-game `<style>` block won't apply.

- **One shared card/piece-info table = single source of truth.** Put labels +
  one-line descriptions in `shared/src/games/<game>/constants.ts` typed as
  `Record<Kind, {label; desc; …}>` (copy `CARD_INFO`,
  `shared/src/games/waterfight/constants.ts:28`; import the `Kind` type-only).
  `Record<Kind>` gives **compile-time completeness** (a missing kind won't
  compile), and a cross-check test (in the engine test file) keeps it from
  drifting against the deck/stack data. The hand tiles, the tap-to-review modal,
  and the Help legend all read this one table.

- **Animated / scrollable overlays go in a guarded sibling host node.** The view
  rebuilds its `innerHTML` on every `onStateChange`; an overlay painted inside
  that subtree flickers, restarts its animation, and loses scroll position every
  sync. Paint it into a **sibling host** of the game root and only repaint when
  identity changes. Copy `WaterFightView` `mount()` (it adds
  `<div class="wf-splash-host">` + `<div class="wf-modal-host">` as siblings of
  `.wf`) + `renderSplash()` / `renderModal()` (repaint only when a `dataset.key`
  changes). Author **dark** modal styles — reuse `.pp-modal-backdrop` STRUCTURE
  but NOT Perfect Palace's light/serif `.pp-modal` skin (it reads as a different
  app on the dark theme). Keep z-index below the turn-toast and reconnect overlay.

- **Stacked fixed overlays: check their EXTENTS overlap, not just their anchors.**
  Two `position: fixed` overlays with different `top` anchors can still collide once
  you add their rendered height. Water Fight's flourish (`top:35%`) and the personal
  turn-toast (`top:45%`, `translate(-50%,-50%)`) had non-overlapping anchors but
  overlapping *bands* (~35–51% vs ~41–49%), so the opaque toast painted over the
  flourish's effect line. Compute the pixel band (anchor ± half-height) for each and
  keep them disjoint (the fix: move the flourish band wholly above the toast).

- **Interpolate a JS constant into CSS-in-JS, never duplicate the number.** When a
  duration/size lives in both a JS constant (a `setTimeout`, a queue tick) and a CSS
  string built as a template literal, inject it — `animation: … ${FLOURISH_TOTAL_MS}ms`
  — so the two can't silently drift (a CSS animation longer than the JS timer repaints
  over a still-animating node; shorter leaves a gap). Hardcoding `2580ms` in both is a
  latent bug.

---

<a id="3-show-dont-hide"></a>
## 3. Show, don't hide — and respect secrecy

**THE rule this app keeps relearning the hard way: make every consequential beat
instantly OBVIOUS and UNDERSTANDABLE — and EXPLAIN what it does, don't just name
it.** A player who sees "Mudslide" or "Sabotage" learns nothing; show **what the
card/event IS and what it DOES to whom** ("🌊 Mudslide — everyone takes 1 damage").
Three non-negotiables:

1. **Cover EVERY consequential beat** — dice roll, card drawn, card played, **card
   bought**, attack, **block**, hit/miss or splash flip, turn-order being decided, a
   life/coin change, a triggered event. **Audit for silent ones:** an action that
   changes state but emits nothing on the event stream is invisible (Water Fight's
   shop/buy and in-turn block emitted nothing until PR2 — the audit is what caught
   them). The synced **log is a backup, never the only feedback** — if a player must
   scroll the log or already know the cards to follow the game, the design has failed.
   **When you surface a CATEGORY of action, key on the OUTCOME, not a subset predicate,
   and enumerate every variant.** Water Fight's "blocked!" flourish was gated on
   `isBlocked` (umbrella or enough Miss cards) — a Wild-as-Miss block sets neither, so
   that block was silently invisible. The fix keyed it on the real outcome (any
   ladder resolution that isn't a hit is a block). A gate on a partial condition drops
   the variants it forgot, silently — the exact failure this whole section is about.
2. **EXPLAIN it, with readable pacing.** Each beat gets an **interactive action**
   (the player triggers it) or an **animated/centered reveal that STATES the effect**,
   held long enough to read (~2.6s for a sentence — NOT a ~0.9s toast flash), PLUS a
   transient **toast** naming who did what to whom. Reuse `flashToast` / `turnChime`
   (`client/src/framework/turnAlert.ts`) and pull the effect text from the **shared
   card-info table** (`CARD_INFO[kind].desc` + an events-effect table) so the reveal,
   the help screen, and the toast never drift.
3. **Build it in from the first commit** — like the end-of-game reveal (below). This
   is a from-kickoff design requirement and part of the definition of done, **not a
   polish pass** bolted on after the owner asks. (On Water Fight the owner had to ask
   for this repeatedly across the audit, the ending beat, and the explanatory
   flourishes — don't make them ask.)

**Reference implementation = Space Chase** (`SpaceChaseView`, PR #17). Copy its
reveal mechanics exactly:
- The player who **triggered** the reveal (the drawer/roller) gets a blocking
  overlay and **taps OK to dismiss** — they study it as long as they like.
- **Everyone else's** copy **auto-closes ~2.6s** with a **~12s safety timeout**,
  so a walked-away player can't stall the table.
- A roll/flip must **linger long enough to read** (Space Chase holds the die
  ~1.75s).
- The **first** action of a game must animate. Beware a "skip the first / cold
  reveal" optimization — instead **prime `lastSeq` to the newest event on mount**
  (`SpaceChaseView` sets `this.lastSeq = this.maxSeq()` in `mount`) so a fresh
  mount/refresh doesn't *replay* history, rather than skipping the first reveal.

**…but respect the secret/public boundary.** Show the SPECIFIC detail only to
the player who should know it; everyone else sees a GENERIC version that conveys
the action without leaking the secret. This mirrors the existing `@view()`
private hands + `grantPrivateView` (`server/src/framework/privateState.ts:24`) +
the per-client private message channel (`WaterFightMsg.REVEAL`).

- Buyer's own toast: **"Keaton bought Goggles."**
- Every other player's toast: **"Keaton bought a card from the Mischief Market."**

**Never put secret info in the synced `log` — it is public to every client.**
So:
- The **public** log/toast carries the generic event (the engine's blind-shop
  log is already generic — e.g. "…buys [mischief]", naming the stack, not the
  card).
- The **specific** detail is delivered to the owner from their OWN private state
  (their `@view()` hand) or via the private `REVEAL` message — **never broadcast**.

### The ending is a moment too — show it, by default

**Every game's game-over must show who won, why it ended, and the deciding move —
build this from the start, don't wait to be asked.** A bare framework standings
card is not enough; the ending is the payoff and belongs to "Show, don't hide."

The catch (and the reusable pattern): **the framework UNMOUNTS the whole game view
the instant `state.phase` flips PLAYING→ENDED** and swaps in the standings/rematch
card (`RoomScreen.renderEnded`). So the game has no chance to show anything *after*
the fact. The only way to show a result moment is for the **server to hold
`phase=PLAYING` for a brief "reveal beat" before declaring the game over.**

This is a room-level hold — **no framework / engine-await / sanitize / new save-kind
edits** (the engine already reaches a terminal `GAME_OVER` state, and every input/
auto path already no-ops on `engine.over`). Copy-from **Water Fight's result-reveal
beat**:
- The room enters the beat once in `afterApply` (`beginResultReveal`): keep
  `phase=PLAYING`, project the outcome to a synced result sub-object
  (`result.pending=true`), arm a **public** `revealHoldMs` timer.
- **Any seated player taps "Continue →"** (a plain `CONTINUE` `onMessage` →
  `handleContinue` → `finishGame`), OR the server timer auto-advances (so a
  walked-away tablet never stalls the table). `finishGame` is **idempotent** (the
  Continue-vs-timer race) and clears the timer on every end path incl. `onGameEnded`.
- The view renders a guarded `.wf-result-host` overlay off the `result.pending`
  **level** (so a mid-beat refresh reconstructs it; no rising-edge latch). It plays
  the finishing splash first, then the victory card (`getMeansLabel` names the
  deciding card). Reset every result field in `syncFromEngine` when `!over` (the
  unconditional-projection rework-saver — see §4).
- To NAME the deciding move, the engine records a `finalBlow {attacker, victim,
  means}` at the elimination site — captured at the damage **callers** (see §4
  "attribute at the callers").

---

<a id="4-architecture-rework-savers"></a>
## 4. Architecture rework-savers

These caused silent failures in Water Fight. Each has a copy-from.

- **A new engine `Move` / `Resolution` kind MUST be whitelisted in the room's
  `sanitize.ts`** (`parseMove` / `parseResolution`,
  `server/src/games/waterfight/sanitize.ts`) — the switch has `default: return
  null`, and `handleMove` / `handleResolve` drop a null parse. A kind that isn't
  added is **silently dropped over the wire**. The trap: **bots bypass sanitize**
  (they call the engine directly via the policy), so AI/self-play tests pass
  while human play fails. **Always cover a new action with a wire-level *room*
  test, not just an engine test.** (Water Fight's interactive splash-draw button
  was dead until `DRAW_SPLASH` was added to `parseResolution`.)

- **`syncFromEngine` mirrors engine→schema UNCONDITIONALLY.** Write every derived
  field every sync, and **reset to default (0 / "") when the engine value is
  null** (`WaterFightRoom.syncFromEngine`, `server/src/games/waterfight/WaterFightRoom.ts:433`).
  "Engine is source of truth; the schema is a top-down projection." A field
  written only `if (engineValue)` keeps the **prior game's value across a
  rematch** — the `State` instance is reused — silently breaking the next game.
  (Water Fight's splash reveal stayed suppressed into the next game this way.)

- **Save/resume completeness.** If `supportsSaves`: add any new await kind to the
  `AWAIT_KINDS` set (`server/src/games/waterfight/save.ts:52`) and any new engine
  state field to a `rebuild*` validator + the awaiting/turn cross-checks, or the
  blob is **silently rejected**. Keep OLD saves loadable: an absent field →
  null/default. The save blob is UNTRUSTED — `parseSave` rebuilds field-by-field
  and re-validates (it calls `assertInvariants`; don't inline phase-aware checks
  — see §5).

- **Log player NAMES, not seat indices.** The pure engine logs by seat number;
  the room must populate `PlayerState.name`. Pass names into `createGame(...)` so
  even the opening draw logs correctly, and add an `applyEngineNames()` helper
  called on **start, load, AND reclaim** (`WaterFightRoom.applyEngineNames`,
  `WaterFightRoom.ts:139`). On the client, **never blind substring-replace a name
  into already-escaped HTML** — that corrupts markup for short/substring
  nicknames ("b", "amp"). Use a word-boundary, single-pass tokenizer that escapes
  name and non-name segments separately (`emphasizeNames` in `WaterFightView.ts`).

- **Attribute at the CALLERS, not inside a shared mutator.** When you need to name
  *who/what* caused an event that a shared low-level function produces (e.g. one
  `damageSeat` called from a thrown balloon, a storm Event, a bounce), capture the
  attribution **at each caller — where the context lives** — gated on the real
  state transition (a player went `out` false→true, so a non-fatal hit or a
  Lifeguard save records nothing). Putting the capture *inside* the shared mutator
  records the wrong thing (it can't see the attacker/means) or nothing. Copy-from
  Water Fight's `finalBlow` capture (`recordSoak`/`damageAndRecord` at the
  `damageSeat` callers in `engine.ts`). Keep the mutator pure (`seat, dmg`).

---

<a id="5-cross-game-gotchas"></a>
## 5. Cross-game gotchas already paid for

Most engine/transport safety nets are **already documented** — inherit them, don't
re-derive them.

### Already in `ARCHITECTURE.md` / `ADDING_A_GAME.md` — link, don't restate
- **Crash-safety** (always on): `BaseGameRoom.onUncaughtException`
  (`ARCHITECTURE.md:132`).
- **The four engine safety nets** for engine-backed games: `engine/invariants.ts`
  (`assertInvariants` — conservation + a **phase-aware** soft-lock detector),
  `validateData.ts`, a version-gated `parseSave` that **calls** `assertInvariants`
  (do **not** copy the phase-aware cross-checks inline — a non-phase-aware copy
  false-rejected a legit mid-setup save, PR #32), and a **fuzz suite** asserting
  invariants after every reduce (`ARCHITECTURE.md:252-280`,
  `ADDING_A_GAME.md:219-231`, `:244-256`).
- **Reconnection (180s grace) + host migration** — automatic (`ARCHITECTURE.md`
  capabilities section, `:104`).
- **`@view()` private state** + the schema-v4 per-item gating gotcha — read it
  *before* designing a schema with hidden info (`ARCHITECTURE.md:187-205`).
- **`npm run typecheck` is the type authority** — tsx tests do NOT type-check, so
  green tests can hide type errors (`ADDING_A_GAME.md:242`).
- **Real-time input must be throttled to the tick rate** (`ARCHITECTURE.md:176`,
  `ArenaView.sendInput`) — see below.

### NOT documented elsewhere — captured here
- **Audio is gesture-gated.** Reuse the shared chime
  (`client/src/framework/turnAlert.ts` `turnChime`) — it unlocks the
  `AudioContext` on the **first real gesture** (pointerdown / keydown /
  touchstart). **Never `resume()` or play sound from a network/turn callback** or
  before the first gesture — the browser autoplay policy rejects it (silent
  failure; PR #30/#34).
- **Seeded RNG correctness.** Use the shared `engine/rng.ts` (mulberry32 carried
  in `GameState`, save-resumable; e.g. `shared/src/games/waterfight/engine/rng.ts`).
  If you write engine RNG, **carry the full 32-bit accumulator** in `rngState` —
  **never re-seed the PRNG from its own output**. Re-seeding traps a short cycle
  and **biases dice** (the die formula isn't the bug — PR #20). Bump
  `ENGINE_VERSION` if you change a shuffle.
- **Transport heartbeat** keeps the socket warm both directions (~4s) — handled
  by the framework (`GameClient` `ConnectionMsg.HEARTBEAT` + `BaseGameRoom`
  keepalive). Production proxies idle-close quiet sockets in ~5–15s (PR #3/#4).
  **Don't disable it.**
- **Real-time `touchmove` floods get you force-disconnected.** A phone dragging
  sends a flood that trips the server's `maxMessagesPerSecond` and disconnects
  the *phone*. Throttle outbound input to the tick rate, leading+trailing (copy
  `ArenaView.sendInput`; PR #7). Real-time games only.
- **`[hidden]` needs `!important`.** `[hidden] { display: none !important }`
  (`style.css:29`) is required so a `[hidden]` element beats a class's `display`
  (equal specificity). Without it, a `.overlay { display: flex }[hidden]` element
  (the "Reconnecting…" overlay) stays visible (PR #5).
- **Schema-v4 caps a structure at ~63 `@type` fields.** When a `State` class nears
  the cap (Water Fight was ~53/63), **nest related fields into a sub-schema**
  referenced by one `@type` field, instead of adding flat fields — exceeding the
  cap is a confusing crash, not a clear error, and a near-full state blocks future
  features. Copy-from the `WaterFightResult` sub-schema (8 reveal fields → 1 field
  on `WaterFightState`). Bonus: a sub-object is also one tidy thing to reset.
- **Big synced state overflows the default encode buffer.** A data-heavy game (a
  capped log + every seat's hand) can exceed `@colyseus/schema`'s default 8 KB
  buffer on a full sync (e.g. at game-over) — it prints a `buffer overflow` warning
  and auto-grows (works, but noisy + a little slower). Set it once at server boot:
  `import { Encoder } from "@colyseus/schema"; Encoder.BUFFER_SIZE = 16 * 1024;`.
  (A framework/boot change, not per-game.)

#### The synced event stream — the engine behind "show, don't hide" (Water Fight PR1/PR2)
- **A seq'd synced event list is the canonical "show, don't hide" enabler.** Copy
  Space Chase: a `<Game>Event` sub-schema `{seq, kind, seat, target, amount, text,
  detailKind}`, a room-owned monotonic `eventSeq` + `appendEvents` (capped, FIFO
  trim), and a client that primes `lastSeq = maxSeq()` on mount, diffs `seq > lastSeq`
  each sync, and **burst-snaps on reconnect** (>N new at once → advance the seq, no
  replay storm). Toasts (PR1) and animated flourishes (PR2) both ride this one diff.
- **Never put a raw `Move`/`Resolution` (or any input object) into a synced event or
  `log`.** Water Fight's first cut stored the whole move (`detail = move`) — it carried
  exact `cardId`s and the defense played, so the synced stream would have broadcast
  every player's secret cards. A synced PUBLIC payload is **flat primitives + an
  engine-built GENERIC `text`**; the SPECIFIC secret goes only via the private `REVEAL`
  channel. (Two-tier: public generic event + private specific; a before/after hand-diff
  to capture "what you lost/drew" only works for **one-directional** effects — exclude
  2-way / whole-hand swaps like cardSwap/switcheroo, where the diff is ambiguous.)
- **Capture engine output at the SINGLE apply funnel, not per call-site.** A game
  applies the engine at several sites (human move, resolve, bot move, gentle/auto-pass).
  Patch only the human ones and **every bot/auto-pass action silently emits nothing** —
  the same blind spot as "bots bypass sanitize". Drain `engine.events` once in the
  shared `afterApply`.
- **Transient channels need a capped queue + a multi-target collapse.** The shared
  `flashToast` (and any single centered reveal host) is a singleton that overwrites, so
  rapid moments lose all but the last and a slow drip (bots act faster than a toast
  drains) lags arbitrarily behind real state. Add a small queue with a **cap +
  drop-oldest**, and collapse a multi-target reduce (Flash Flood hitting everyone) to
  **ONE summary**, not N — pick the highest-priority event per reduce.
- **A new synced field must be copied in `appendEvents` AND survive a refresh.** When
  you add a field to the event sub-schema (e.g. `detailKind`), copy it in the room's
  `appendEvents`, and remember the client diff is reconnection-safe only because
  `lastSeq` is primed on mount — verify a mid-game refresh neither replays nor storms.

---

<a id="6-copy-from-reference-table"></a>
## 6. Copy-from reference table

The highest-value section — open these files. Line numbers drift; the symbol /
selector name is the durable anchor.

| Pattern | Copy from | Notes |
|---|---|---|
| Dark theme tokens | `client/src/style.css:2` (`:root`) | `--bg --card --text --muted --accent --accent-press --danger --ok --warn`. Every game uses these. |
| Width breakout (tablet/laptop) | `#app:has(.spl)` `style.css:237`; `#app:has(.wf)` `style.css:2265` | Game root gets a short class; `:has()` lifts the ~480px `#app` cap. |
| Two-column dashboard | `WaterFightView` STYLE (`.wf` grid `1fr minmax(280px,340px)` ≥900px) + `render()` building `.wf-main` / `.wf-side` | Stacks to one flex column on phone. Wrap children into two explicit containers, don't grid a flat list. |
| −/+ lobby steppers | `.wf-stepper` `style.css:2234` (global) + `renderWaterFightLobbySettings()` (`WaterFightView.ts`) off `WF_SETTINGS` (`shared/.../waterfight/index.ts:46`) | Native `<input type=number>` shows no arrows on mobile. Lobby CSS MUST be global. Drive rows off a descriptor table. |
| Tap-popover (replaces `title`) | `infoButton(hint,label)` + `wireInfoButtons(container)` (`client/src/framework/infoPopover.ts`) | `title=` never shows on touch. Popover lives on `document.body` so a re-render can't kill it mid-open. |
| 44px touch targets | `.wf-ic { width/height:44px }`; default `button{padding:12px}` | Owner tests on iPad mini. Don't override smaller. |
| Card/piece-info single source | `CARD_INFO: Record<Kind,…>` (`shared/.../waterfight/constants.ts:28`) | Drives hand tiles + tap-review modal + Help legend. `Record<Kind>` = compile-time completeness; cross-check test against deck/stack data. |
| Guarded sibling-host overlay | `WaterFightView` `mount()` (`.wf-splash-host` / `.wf-modal-host` siblings) + `renderSplash` / `renderModal` (repaint only when `dataset.key` changes) | The view rebuilds its innerHTML each sync; overlays inside it flicker / restart / lose scroll. |
| Dark modal | WF `.wf-modal` / `.wf-modal-backdrop` | Reuse `.pp-modal-backdrop` STRUCTURE, NOT Perfect Palace's light/Cinzel `.pp-modal` skin. Keep z-index below turn-toast + reconnect overlay. |
| Show-don't-hide reveal | `SpaceChaseView` `revealCard` / `dismissReveal` + `sc-reveal` CSS (PR #17) | Actor taps OK; watchers auto-close ~2.6s + ~12s safety; rolls linger ~1.75s; prime `lastSeq = maxSeq()` on mount (don't replay/skip cold). |
| End-of-game reveal beat | `WaterFightRoom` `beginResultReveal` / `handleContinue` (public `revealHoldMs` timer) + `WaterFightResult` sub-schema + `.wf-result-host` overlay + `getMeansLabel` (PR #40) | The view is unmounted on the PLAYING→ENDED flip, so the server holds `phase=PLAYING` for a beat to show winner/why/finishing-move first. Any-tap or timer advances; `finishGame` idempotent; reset result fields on `!over`. |
| Schema field-cap → nest | `WaterFightResult` sub-schema (`shared/.../waterfight/index.ts`) — 8 fields behind one `@type(WaterFightResult) result` | schema-v4 caps a structure at ~63 `@type` fields; nest when nearing it. |
| Attribute at the callers | `recordSoak` / `damageAndRecord` at the `damageSeat` callers (`engine.ts`) | Capture who/what at the caller (context lives there), on the `out` false→true transition; keep the shared mutator pure. |
| Toast helper | `client/src/framework/turnAlert.ts` `flashToast` / `turnChime` | Who-did-what toasts + the turn chime. Audio gesture-gated (see §5). |
| Secrecy boundary | `@view()` hands + `grantPrivateView` (`server/src/framework/privateState.ts:24`) + private `WaterFightMsg.REVEAL` channel (`shared/.../waterfight/index.ts:27`, sent per-client in `WaterFightRoom`) | Specific detail → owner only; generic event → public log/toast. Never put secrets in the synced log. |
| Sanitize whitelist | `parseMove` / `parseResolution` (`server/.../waterfight/sanitize.ts`, `default: return null`) | A new Move/Resolution kind not added here is silently dropped over the wire. |
| Bots bypass sanitize | `WaterFightRoom` autoPlay → policy → `WF.applyMove/applyResolution` directly | AI tests pass while human play fails. Always add a wire-level room test for a new action. |
| Save/resume completeness | `server/.../waterfight/save.ts` `AWAIT_KINDS` (`:52`) + `rebuild*` validators (`:298`, `:317`) + awaiting/turn cross-checks; `supportsSaves=true` | New await kind → add to `AWAIT_KINDS`. New field → `rebuild*` + return it. Old saves: absent → null. |
| Engine→schema projection | `WaterFightRoom.syncFromEngine()` (`:433`) | Mirror EVERY derived field every sync (reset to default when null) — a conditional write keeps the prior game's value on rematch (State is reused). |
| Names in the log | `who(s,i)` (`engine/engine.ts`); `createGame(playerCount,seed,opts?,names?)` (`engine/setup.ts`); `applyEngineNames()` (`WaterFightRoom.ts:139`, start+load+reclaim); `emphasizeNames()` (`WaterFightView.ts`) | Engine logs by seat; room populates `PlayerState.name`. Never blind substring-replace a name into escaped HTML. |
| Framework flags | `server/src/framework/BaseGameRoom.ts:56-87`; `WaterFightRoom.ts:44-47` | `supportsBots / allowLateJoin / supportsReclaim / supportsSaves / reconnectionGraceSeconds`. |
| Per-game client surface | `client/src/framework/GameView.ts:26` (`GameDefinition`: `createView`, `renderLobbySettings?`, `renderGameSummary?`) + `client/src/games/registry.ts` | One registry entry per game. |
| Pure engine + saves UI | `shared/src/games/splendor/` & `catan/` (engine reference); client `framework/saveSlots.ts`, `turnAlert.ts`, `wakeUp.ts` | Port rules as a pure engine first; room is a thin adapter. |
| Engine safety nets | `engine/invariants.ts` (`assertInvariants`, phase-aware) + `validateData.ts` + version-gated `parseSave` + fuzz block; `BaseGameRoom.onUncaughtException`. Docs: `ARCHITECTURE.md:252-280`, `ADDING_A_GAME.md:219-231` | Required for engine-backed games. Don't inline phase-aware checks in `parseSave` (PR #32). |
| Seeded RNG (unbiased) | `shared/src/games/*/engine/rng.ts` (mulberry32, full 32-bit `rngState`) | Never re-seed the PRNG from its own output (biases dice — PR #20). Save-resumable; bump `ENGINE_VERSION` on change. |
| Audio gesture-unlock | `turnAlert.ts` `turnChime` (first pointerdown/keydown/touchstart unlocks `AudioContext`) | Never play/`resume()` from a network callback or before the first gesture (PR #30/#34). |
| Real-time input throttle | `client/src/games/arena/ArenaView.ts` `sendInput` (throttle to tick rate, leading+trailing) | Real-time only: a phone `touchmove` flood trips `maxMessagesPerSecond` → force-disconnect (PR #7). `ARCHITECTURE.md:176`. |
| Transport heartbeat | `GameClient` `ConnectionMsg.HEARTBEAT` + `BaseGameRoom` keepalive (~4s both ways) | Framework-handled; proxies idle-close quiet sockets in 5–15s (PR #3/#4). Don't disable. |
| `[hidden]` CSS win | `client/src/style.css:29` `[hidden]{display:none!important}` | Beats a class's `display` (equal specificity) — kept the "Reconnecting…" overlay stuck (PR #5). |

---

<a id="7-pre-flight-checklist"></a>
## 7. Pre-flight checklist — before declaring a game done

- [ ] `npm run typecheck && npm test && npm run build` all green (typecheck is the
      type authority — tsx tests don't type-check).
- [ ] **Two-window browser smoke at tablet (~1024) AND phone (~390)** widths,
      including a **mid-game refresh** (and, for drop-in games, a fresh-browser rejoin).
- [ ] Dark-theme legibility: no light-on-dark text anywhere; every color is a `:root` token.
- [ ] 44px touch targets; lobby uses `−`/`+` steppers with ⓘ hints, not number inputs.
- [ ] The game **log shows player names**, not "seat N".
- [ ] Every random/consequential event is **shown** (interactive or animated) +
      toasted — not log-only; secrets stay owner-only and out of the synced log.
- [ ] **Game-over shows who won, why, and the deciding move** *before* the standings
      screen (a held reveal beat — §3), not a bare standings card.
- [ ] The reveal/modal **survives opponents' turns** (guarded sibling host; no flicker).
- [ ] The seats row **wraps at max players**.
- [ ] A new engine action has a **wire-level room test** (not just an engine test).
- [ ] **Send the owner screenshots** of the real result (non-coder — the screenshot
      is how they confirm it works). Never declare a UI change done on green tests alone.

---

<a id="8-keeping-this-current"></a>
## 8. Keeping this current (living doc)

This playbook only stays valuable if it grows with each game. **The owner decides
what gets added — the agent never edits it silently.**

At the end of **a game build, a non-trivial game fix, or a `/review` that
surfaces a real class of bug**, the agent:
1. Identifies the **durable** learnings — a bug class, a convention, or a gotcha
   that cost rework. NOT one-off facts about a single game.
2. Proposes them to the owner via an **AskUserQuestion** (Add to playbook / Skip,
   per item).
3. Appends each approved learning using this **entry template**:

   > **\<short title\>** — \<the rule, one or two sentences\>. Copy from
   > `\<file:line\>`. (\<why it bit us / PR #N\>)

(This is enforced by the standing instruction in `CLAUDE.md`, so it happens
proactively — not only when the owner asks.)
