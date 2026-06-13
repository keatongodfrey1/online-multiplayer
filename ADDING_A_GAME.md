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

## The test file

Copy `server/test/tictactoe.test.ts` (or `arena.test.ts`) to
`server/test/foo.test.ts`. Keep the structure: a `makeConfig()` factory, a
`startedGame()` helper, then test at minimum:

1. a full game to a win (scripted moves -> phase "ended", right endReason)
2. illegal moves are ignored (out of turn, malformed payload, out of range)
3. rematch fully resets the game
4. whatever is special about your game (late join, hidden info, ...)

Run everything before calling it done:

```bash
npm run typecheck && npm test && npm run build
```

...then do the manual smoke test from the README (two browser windows,
including the mid-game refresh).

## Checklist

- [ ] `shared/src/games/foo.ts` + export line in `shared/src/index.ts`
- [ ] `server/src/games/foo/FooRoom.ts`
- [ ] one line in `server/src/app.config.ts`
- [ ] `client/src/games/foo/FooView.ts`
- [ ] one entry in `client/src/games/registry.ts`
- [ ] `server/test/foo.test.ts`
- [ ] typecheck + tests + build green; manual two-window test incl. refresh
- [ ] no edits inside any `framework/` directory
