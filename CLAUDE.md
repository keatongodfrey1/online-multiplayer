# Instructions for AI agents working in this repository

This is a multiplayer game framework (Colyseus 0.17) plus games built on
it. The owner is a non-coder: your code must work, your explanations must
be plain, and you must verify before declaring success.

## Read first

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

## Testing notes

- Test suites build their server config via a factory (`makeConfig()`),
  never a shared module-level `defineServer` instance.
- Use the `until()` / `sleep()` helpers from `server/test/StubRoom.ts`
  instead of `waitForNextMessage` after sends (subscription races).
- `client.leave(false)` simulates a refresh/drop; `sdk.reconnect(token)`
  tests resume.
