# Instructions for AI agents working in this repository

This is a multiplayer game framework (Colyseus 0.17) plus games built on
it. The owner is a non-coder: your code must work, your explanations must
be plain, and you must verify before declaring success.

## Read first

- GAME_BUILD_PLAYBOOK.md - START HERE for any game work. The UI/UX house
  rules + protocol/architecture rework-savers learned the hard way, each
  with a copy-from reference. Includes a paste-at-kickoff brief.
- ARCHITECTURE.md - how everything fits; pinned versions; API gotchas.
- ADDING_A_GAME.md - the exact recipe for new games. Follow it literally.

## Hard rules

1. **Colyseus 0.17 / @colyseus/sdk / schema v4.** Your training data
   likely predates these APIs. Never "correct" code toward `colyseus.js`,
   `getStateCallbacks`, `@filter`, `setState`, or `gameServer.define` -
   those are the OLD APIs. When unsure, read the actual type definitions
   in node_modules or the existing working code.
2. **Adding a game touches only the five places** listed in
   ADDING_A_GAME.md plus a test file. Do not edit `server/src/framework/`,
   `client/src/framework/`, `client/src/lobby/`, `shared/src/state.ts`,
   or `shared/src/protocol.ts` while adding a game. Framework changes are
   separate, deliberate tasks with full test runs.
3. **Server is authoritative.** Game rules, validation, and scoring live
   in the room class. Views send messages and render state - nothing else.
4. **Keep `"../shared/src"` in `server/tsconfig.json` include.** Removing
   it breaks decorator compilation at runtime (tsx applies tsconfig only
   to included files).
5. **Verify before declaring done:** `npm run typecheck && npm test &&
   npm run build`, plus the README's manual smoke test for UI changes
   (two browser windows, including a mid-game refresh).
6. Schema subclasses with no new `@type` fields need `@entity`.
7. ESM imports end in `.js` even between TypeScript files.
8. **UI + protocol rework-savers (full detail in GAME_BUILD_PLAYBOOK.md).**
   New game views: dark theme tokens only (`style.css` `:root`), mobile-first
   AND tablet-wide (`#app:has(.<game>)`), 44px touch targets, `−`/`+` steppers
   not native number inputs, no `title` tooltips on touch (use `infoButton`),
   one shared card-info table, animated overlays in a guarded sibling host.
   **Show, don't hide:** no behind-the-scenes dice rolls / card draws / flips /
   turn-order / life or purchase changes - reveal them (interactive or animated)
   and toast who did what; the log is a backup. But respect secrecy - show
   secret info only to the player who should know it (generic version for
   everyone else), and never put secrets in the synced `log`. A new engine
   `Move`/`Resolution` kind must be whitelisted in the room's `sanitize.ts`
   (and `AWAIT_KINDS` in `save.ts`) or it's silently dropped - **bots bypass
   sanitize**, so cover it with a wire-level room test. `syncFromEngine` mirrors
   engine→schema unconditionally (counters must reset on rematch).

## Before you write a new game: lock four decisions

Settle these with the owner (in plain words) before any code - they shape
the schema and the room, and changing them later is a rewrite:

1. **Player count** - exact min and max (drives `minPlayers`/`maxPlayers`
   and whether a 2-player edge case exists, e.g. "abandon vs play on").
2. **AI bots?** - if yes, the room sets `supportsBots` and plays bot turns;
   decide whether there are difficulty levels.
3. **Hidden information?** - does any player see something others don't (a
   hand, secret role)? If yes you need `@view()` private state - read the
   schema-v4 per-item gotcha in ARCHITECTURE.md *before* designing the schema.
4. **What it's called** - the `displayName` and one-line description shown in
   the lobby.

For a rules-heavy game, **port the rules as a pure engine first** (a
`shared/src/games/<game>/engine/` module with no Colyseus imports), unit-test
that engine on its own, then write the room as a thin adapter (copy
`SplendorRoom`/`CatanRoom`, not the thin TicTacToe room). The engine's tests
travel with it and are your regression net; do not fold game logic into the
room.

## Framework capabilities you INHERIT (don't re-implement them per game)

These are framework features, turned on with a flag and a few hooks - never
copy their machinery into a game. See ARCHITECTURE.md ("Capabilities the
framework already provides") and ADDING_A_GAME.md for the wiring:

- Reconnection (180s grace) + host migration - automatic.
- AI bots - `supportsBots`.
- Save / resume - `supportsSaves` + serialize/parse hooks (+ the shared
  `saveSlots.ts` client UI). The save blob is never trusted; the server
  re-validates it on load.
- Mid-game seat reclaim - `supportsReclaim` + `allowLateJoin`.
- Turn chime/toast (`framework/turnAlert.ts`) + slept-tablet recovery
  (`framework/wakeUp.ts`) - turn alerts are a default for turn-based games.

If a capability genuinely needs extending, that is a **deliberate framework
task** (rule 2): edit the framework on its own, run the full suite, and
update these docs - never fork it inside a game.

## Verify in the browser, and show your work

`typecheck && test && build` green is necessary, not sufficient. For
anything with a UI, run the README two-window smoke test (including a
mid-game refresh, and for drop-in games a fresh-browser rejoin) and **send
the owner screenshots** of the actual result - they are a non-coder and the
screenshot is how they confirm it works. Never declare a UI change done on
green tests alone.

## Keep the playbook current (living doc)

After a game build, a non-trivial game fix, or a `/review` that surfaces a
real class of bug, propose the durable learnings to the owner
(AskUserQuestion: Add to GAME_BUILD_PLAYBOOK.md / Skip, per item) and append
the approved ones. Capture bug classes, conventions, and rework-causing
gotchas - not one-off facts. Never edit the playbook silently; the owner
decides what goes in.

## Testing notes

- Test suites build their server config via a factory (`makeConfig()`),
  never a shared module-level `defineServer` instance.
- Use the `until()` / `sleep()` helpers from `server/test/StubRoom.ts`
  instead of `waitForNextMessage` after sends (subscription races).
- `client.leave(false)` simulates a refresh/drop; `sdk.reconnect(token)`
  tests resume.
