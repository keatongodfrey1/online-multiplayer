# Adding a new game

Adding a game touches **exactly five places** (plus a test file). Nothing
in any `framework/` directory changes - if you think you need to edit the
framework, stop and reconsider (or extend it deliberately as its own
task). Read ARCHITECTURE.md first.

Use Tic-Tac-Toe as the template for turn-based games and Dot Arena for
real-time games. The fastest path is: copy the closest existing game's
three files, rename, then change the rules.

## The five places (game name: `foo`)

### 1. `shared/src/games/foo.ts` - state schema + messages

```ts
import { entity, type } from "@colyseus/schema";
import { BasePlayer, BaseState } from "../state.js";

export const FOO = "foo"; // the room name / gameType

export const FooMsg = {
  PLAY: "foo/play", // client -> server; document the payload shape
} as const;

export interface FooPlayPayload {
  card: number;
}

export class FooPlayer extends BasePlayer {
  @type("uint8") coins = 0; // synced to everyone automatically
}
// If FooPlayer added NO new fields, tag it with @entity instead.

export class FooState extends BaseState {
  @type("string") currentTurn = "";
}
```

Then add one line to `shared/src/index.ts`:

```ts
export * from "./games/foo.js";
```

### 2. `server/src/games/foo/FooRoom.ts` - the rules

```ts
import type { Client } from "colyseus";
import { FooMsg, FooPlayer, FooState, Phase, /* ... */ } from "@backbone/shared";
import { BaseGameRoom } from "../../framework/BaseGameRoom.js";

export class FooRoom extends BaseGameRoom<FooState> {
  state = new FooState();
  readonly minPlayers = 2;
  readonly maxPlayers = 4;
  // allowLateJoin = true;       // for drop-in games (default false)

  protected createPlayer(): FooPlayer {
    return new FooPlayer();
  }

  protected override onRoomCreate(): void {
    this.onMessage(FooMsg.PLAY, (client, payload) => this.handlePlay(client, payload));
  }

  protected onGameStart(): void {
    // MUST fully (re)initialize ALL game state - this also runs on rematch.
  }

  private handlePlay(client: Client, payload: unknown): void {
    // VALIDATE EVERYTHING: phase, turn, payload types/ranges, legality.
    // Then mutate this.state. Call this.endGame(this.winBySeat(seat)) /
    // this.endGame(EndReason.DRAW) when the game is decided.
  }
}
```

Available hooks (all optional): `onPlayerJoinedMidGame`, `onPlayerDropped`,
`onPlayerReconnected`, `onPlayerLeftForGood`, `syncPrivate`, `onGameEnded`.
Turn-based? Instantiate a `TurnManager` (copy TicTacToeRoom). Real-time?
Instantiate a `TickLoop` (copy ArenaRoom).

### 3. `server/src/app.config.ts` - one line in the rooms map

```ts
[FOO]: defineRoom(FooRoom),
```

### 4. `client/src/games/foo/FooView.ts` - the in-game UI

Implement the `GameView` interface (copy the closest demo view):

```ts
export class FooView implements GameView {
  mount(root, room, ctx) { /* build DOM, subscribe, render */ }
  unmount() { /* remove EVERY listener you added */ }
}
```

Rules of the road: render from `room.state`, send messages on user
actions, never mutate state locally. The framework already renders the
lobby, the "Reconnecting..." overlay, and the game-over/rematch screen -
your view only covers the playing phase.

Turn alerts are a default, not an extra: players on other tablets need to
hear/see when it is their moment. Use `client/src/framework/turnAlert.ts` -
call `turnChime()` + `flashToast(root, "Your turn!")` on the RISING EDGE of
"this player must act" (track a boolean across renders so it fires once),
and offer a 🔔/🔕 button wired to `isMuted()`/`setMuted()` (one shared,
site-wide preference). See SplendorView and CatanView for the pattern.

### 5. `client/src/games/registry.ts` - one entry

```ts
{
  gameType: FOO,
  displayName: "Foo",
  description: "2-4 players",
  createView: () => new FooView(),
},
```

Optional: if your game has pre-game settings (e.g. Splendor's turn timer),
add `renderLobbySettings` to the entry. The lobby calls it on every
re-render with an empty container; read current values from `room.state`,
send changes as a game message, and have the room validate them
(host-only, lobby-phase-only). See `renderSplendorLobbySettings` in
`client/src/games/splendor/SplendorView.ts` for the pattern.

Optional: `renderGameSummary` renders a final-score breakdown on the
game-over screen, above the rematch button (see
`renderSplendorGameSummary` for the pattern). Derive everything from the
last synced state - the server leaves it in place when the game ends.

## Opting into framework capabilities (NOT framework edits)

These turn on existing framework features with a flag plus a few small
hooks in YOUR room/view. You are *using* the framework, not editing it -
nothing in any `framework/` directory changes. See ARCHITECTURE.md for the
concepts. Splendor and Catan use all of these; copy from them.

### Save / resume

The host snapshots a game mid-play (a button that sends `LobbyMsg.SAVE`) and
resumes it from the lobby. The framework owns the SAVE/LOAD messages, the
lineup-gated start (it won't start until the saved humans are back), and bot
re-seating. In your room:

```ts
override supportsSaves = true;

protected override serializeSave(): object | null { return this.buildSave(); }     // game -> blob
protected override parseSave(raw: unknown) { return parseSave(raw); }               // validate untrusted blob -> null to reject
protected override isGameOver(): boolean { return this.engine.over; }              // don't offer Save on a finished game
protected override loadedSaveTurnLabel(parsed: unknown) { return (parsed as ParsedSave).turnCount + 1; }
// optional: restore lobby-config the save carried (turn timer, variant, ...)
protected override onSaveStaged(parsed: unknown): void { /* this.state.turnSeconds = ... */ }
// optional, for bot games: restore/clear per-bot state across re-seating
protected override onLoadedBotSeated(bot, savedSeat): void { /* recover difficulty */ }
protected override onBotRemoved(sessionId): void { /* clear per-bot state */ }
```

Keep your `serialize`/`parse` pair in a game `save.ts` (the validator is
the only thing standing between a tampered blob and your engine - rebuild a
clean object, never trust the input). In the view, wire the shared UI - no
bespoke slot code:

```ts
import { hookSaveData, renderSaveSlots } from "../../framework/saveSlots.js";
const KEY = "foo-saves";
const turnLabel = (blob: any) => (blob?.turnCount ?? 0) + 1; // the one blob-shape line

// in mount(): hookSaveData(room, KEY, turnLabel, () => flash("Saved ✓"));
// in lobby settings: renderSaveSlots(container, room, { key: KEY, isHost, loadedSave: room.state.loadedSave });
// a Save button sends: room.send(LobbyMsg.SAVE, {});
```

### Mid-game seat reclaim (drop-in turn games)

With `allowLateJoin`, a newcomer with the room code takes over a seat that
has fallen to autopilot (a player who left for good). The framework owns the
join policy and the clean "no open seat" rejection. In your room:

```ts
override allowLateJoin = true;
override supportsReclaim = true;

protected override findReclaimableSeat(): number {
  return [...this.state.seats].findIndex((s) => s.gone); // engine-seat index, or -1
}
protected override reclaimSeat(i: number, player: BasePlayer): void {
  // rebind your seat maps to the newcomer, re-grant any private view,
  // re-enter them in the TurnManager (turns.insert), then settle/sync.
}
```

Reclaim only matters at 3-4 players (a 2-player quit ends the game
"abandoned" before anyone can take over). If your turn-based game removes a
leaver from the `TurnManager`, reclaim must re-insert them (`turns.insert`) -
without it the reclaimed seat is skipped forever. Copy `SplendorRoom`'s
`reclaimSeat` for the full checklist.

## The test file

Copy `server/test/tictactoe.test.ts` (or `arena.test.ts`) to
`server/test/foo.test.ts`. Keep the structure: a `makeConfig()` factory, a
`startedGame()` helper, then test at minimum:

1. a full game to a win (scripted moves -> phase "ended", right endReason)
2. illegal moves are ignored (out of turn, malformed payload, out of range)
3. rematch fully resets the game
4. whatever is special about your game (late join, hidden info, ...)

**Engine-backed game?** Then the test file also carries the engine's safety
nets - these are required, not optional (see ARCHITECTURE.md "Engine-backed
rooms"; copy Water Fight / Splendor):

1. **`shared/src/games/foo/engine/invariants.ts`** exporting
   `assertInvariants(state)` - conservation + a soft-lock detector, **phase-aware**
   (gate "in play" checks off setup/over phases or they fire on legit states).
2. **`shared/src/games/foo/engine/validateData.ts`** exporting
   `validateFooData(): string[]` - static card/board/cost tables are well-formed,
   id ranges never collide. One pure test asserting it returns `[]`.
3. **A fuzz block** in `foo Engine.test.ts` - random playouts at every player
   count calling `assertInvariants` after every reduce, with a termination guard.
4. **A strict `parseSave`** (if `supportsSaves`): version-gated, runs
   `assertInvariants` + a legal-move smoke on the rebuilt state, rejects tampered
   blobs. Pure accept/reject unit tests (no server boot). Do NOT duplicate the
   phase-aware invariant cross-checks inline - call `assertInvariants`.

Run everything before calling it done:

```bash
npm run typecheck && npm test && npm run build
```

...then do the manual smoke test from the README (two browser windows,
including the mid-game refresh). Note: `npm test` (mocha + tsx) does NOT
type-check - `tsx` strips types - so a green test run can still hide type
errors; `npm run typecheck` is the authority for those.

## Checklist

- [ ] `shared/src/games/foo.ts` + export line in `shared/src/index.ts`
- [ ] `server/src/games/foo/FooRoom.ts`
- [ ] one line in `server/src/app.config.ts`
- [ ] `client/src/games/foo/FooView.ts`
- [ ] one entry in `client/src/games/registry.ts`
- [ ] `server/test/foo.test.ts`
- [ ] **engine-backed only:** `engine/invariants.ts` (`assertInvariants`,
      phase-aware) + `engine/validateData.ts` + a fuzz block asserting invariants
      after every reduce + (if saves) a version-gated `parseSave` that runs
      `assertInvariants` + a legal-move smoke
- [ ] typecheck + tests + build green; manual two-window test incl. refresh
- [ ] no edits inside any `framework/` directory
