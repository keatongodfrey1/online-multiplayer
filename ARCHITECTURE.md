# Architecture

This document is written for the engineers - human or AI - who build new
games on this framework. Read it fully before changing anything in a
`framework/` directory.

## The one-paragraph mental model

The **server is the single source of truth**. Each running game is a
Colyseus *Room* on the server holding a *schema state* object; Colyseus
automatically streams every state change to all connected clients
(~20x/second). Clients never change state directly - they send small
*messages* ("I press cell 4", "I steer right"), the server validates them,
mutates state, and the sync does the rest. The framework
(`BaseGameRoom` on the server, `RoomScreen`/`GameClient` on the client)
handles everything that is identical across games - joining, lobby,
host, reconnection, game over - so a game implements only its rules and
its in-game UI.

## Pinned versions - DO NOT "fix" these from memory

Colyseus 0.17 (Feb 2026) renamed packages and changed core APIs. Training
data older than that will suggest wrong code. In particular:

| Correct (this repo) | WRONG (older Colyseus) |
|---|---|
| `@colyseus/sdk` client package | `colyseus.js` |
| `Callbacks.get(room)` | `getStateCallbacks(room)`, `state.players.onAdd(...)` |
| `onDrop(client, code)` + `allowReconnection` inside it | `onLeave(client, consented)` with `allowReconnection` inside |
| `client.view` + `@view()` for private state | `@filter(...)` |
| `state = new MyState()` property | `this.setState(new MyState())` |
| `defineServer({ rooms: { name: defineRoom(Room) } })` | `gameServer.define("name", Room)` |

Versions: `colyseus ^0.17.10`, `@colyseus/sdk ^0.17.42`,
`@colyseus/schema ^4.0.26`, `@colyseus/tools ^0.17.19`,
`@colyseus/testing ^0.17.11`, Node 22, Vite 8, TypeScript 5.x,
express 4 (not 5). Do not upgrade casually; if you must, re-run the whole
test suite and the manual smoke test.

## Packages

```
shared/   - imported by BOTH server and client (raw TypeScript source).
            protocol.ts: phases, framework message names, error codes.
            state.ts:    BaseState + BasePlayer schema classes.
            games/*.ts:  per-game schema classes, message names, constants.
server/   - the Colyseus app.
            src/app.config.ts: room registry + express routes (healthz,
                               prod static serving, dev-only monitor/playground).
            src/framework/:    BaseGameRoom, roomCodes, TurnManager,
                               TickLoop, privateState. THE BACKBONE.
            src/games/<game>/: one room class per game.
            test/:             mocha + @colyseus/testing suites.
client/   - the website (Vite + vanilla TS, no UI framework).
            src/framework/:    GameClient (connect/join/resume),
                               session (localStorage), GameView interface.
            src/lobby/:        HomeScreen (create/join forms),
                               RoomScreen (lobby/ended chrome, overlay).
            src/games/<game>/: one view class per game + registry.ts.
```

Module conventions: ESM everywhere, imports between files use `.js`
extensions (TypeScript NodeNext style). `shared` is consumed as raw TS -
the server tsconfig MUST keep `../shared/src` in its `include` (that is
what makes tsx compile the schema decorators in legacy mode; removing it
breaks the server at runtime with a `__decorateElement` error).

## Server lifecycle (BaseGameRoom)

```
create  -> onCreate: roomId = unique 4-letter code (Presence registry),
           setPrivate(), maxClients, rate limit, lobby message handlers,
           then game hook onRoomCreate(options)
join    -> onJoin: validate nickname (1-16 chars, no duplicates,
           reject if full / already started unless allowLateJoin),
           assign lowest free seat, first joiner = host
           game hook onPlayerJoinedMidGame(player) for late joins
start   -> host sends LobbyMsg.START; needs >= minPlayers; phase="playing";
           lock() unless allowLateJoin; game hook onGameStart()
           (onGameStart MUST fully re-initialize game state - it runs
           again on every rematch)
drop    -> onDrop (abnormal close: refresh, signal loss): player.connected
           = false, allowReconnection(180s playing / 30s lobby),
           game hook onPlayerDropped(player)
return  -> onReconnect: connected = true, game hooks
           onPlayerReconnected(player) + syncPrivate(client)
gone    -> onLeave (consented quit, kick, or grace expired):
           remove player, migrate host if needed, game hook
           onPlayerLeftForGood(player); if playing and players <
           minPlayers -> endGame("abandoned")
end     -> game calls this.endGame("win:<seat>" | "draw" | "abandoned");
           phase="ended"; game hook onGameEnded() (stop timers/loops here)
rematch -> every player sends LobbyMsg.REMATCH -> phase="playing",
           votes cleared, onGameStart() again
dispose -> room empties -> onDispose releases the room code
```

Subclasses set `minPlayers`, `maxPlayers`, optionally `allowLateJoin`,
`reconnectionGraceSeconds`, `lobbyGraceSeconds`, and implement
`createPlayer(seat)` + `onGameStart()` plus any hooks they need. They
never override onCreate/onJoin/onDrop/onReconnect/onLeave/onDispose -
use the hooks.

## Capabilities the framework already provides (opt in, don't re-build)

Several things that look game-specific are actually framework features a
game turns on with a flag plus a couple of small hooks. A new game should
reach for these before writing its own - they are battle-tested across the
shipped games and come with their reconnection/host-migration edge cases
handled. ADDING_A_GAME.md has the exact wiring for each.

- **Reconnection + host migration** (always on): abnormal drops hold the
  seat for `reconnectionGraceSeconds` (default 180 - tuned for tablets that
  lock their screen mid-game); the host role migrates automatically when the
  host leaves. A game does nothing for this.
- **AI bots** (`supportsBots = true`): the framework owns the lobby roster
  entry (LobbyMsg.ADD_BOT, naming, removal); the game plays the bot's turns
  off `player.isBot` and may read a difficulty choice in `onBotAdded`.
- **Save / resume** (`supportsSaves = true`): the host snapshots a game
  mid-play and resumes it from the lobby. The framework owns the SAVE/LOAD
  messages, the lineup-gated start, and bot re-seating; the game implements
  only `serializeSave`/`parseSave`/`isGameOver`/`loadedSaveTurnLabel`. The
  blob lives in the host's browser and is re-validated on the way back in
  (`client/src/framework/saveSlots.ts` is the shared UI).
- **Mid-game seat reclaim** (`supportsReclaim = true` + `allowLateJoin`): a
  newcomer with the room code takes over a seat that has fallen to autopilot.
  The framework owns the join policy and the clean "no open seat" rejection;
  the game implements `findReclaimableSeat`/`reclaimSeat`.
- **Turn alerts** (client, `framework/turnAlert.ts`) and **slept-tablet
  recovery** (`framework/wakeUp.ts`): see ADDING_A_GAME.md - turn alerts are
  a default for any turn-based game, not an extra.
- **Crash-safety** (always on): `BaseGameRoom.onUncaughtException` is defined,
  so Colyseus wraps every message handler, the simulation tick, and clock
  timers - an uncaught throw is logged and swallowed instead of tearing the
  room down and dropping every player. A game does nothing for this and must
  NOT rely on it as a substitute for validating input up front; it is the
  backstop for the throw that slips past or an engine bug. (Without this hook
  defined, Colyseus does not catch handler throws at all - that was a real
  whole-room-crash bug before it was added.)

## State vs messages - the golden rule

- **State** (schema classes in `shared/`): anything a player must still
  see after refreshing the page. Board, scores, positions, whose turn.
  Server mutates it; clients render it. Survives reconnection for free.
- **Messages**: momentary things. Player inputs (client -> server) and
  one-shot effects like "you drew the Knight" (server -> client,
  `client.send`). Messages sent while a player was disconnected are GONE -
  if a reconnecting player needs the information, either keep it in state
  (preferred) or re-send it from the room's `syncPrivate(client)` hook.

Schema gotchas:
- Every synced field needs `@type(...)`. A subclass that adds NO new
  fields must be tagged `@entity` (see `TicTacToePlayer`).
- Only the server mutates state. Client-side state objects are read-only
  mirrors.
- Validate EVERY message payload on the server: type-check, range-check,
  turn-check. Assume clients are hostile. See `TicTacToeRoom.handleMove`
  and the arena's `bindInput` validator for the pattern.

## Turn-based games: TurnManager

Owned by the game room (see `TicTacToeRoom`):
`start(orderOfSessionIds)`, `isTurn(sessionId)` guard in move handlers,
`next()`, `remove(sessionId)` when a player leaves, `stop()` at game end.
Optional per-turn timeout (`turnSeconds` + `onTimeout`). Wire the
disconnect hooks so the clock pauses while the current player is away:
`onPlayerDropped -> pause()`, `onPlayerReconnected -> resume()`.

## Real-time games: TickLoop

Owned by the game room (see `ArenaRoom`): fixed-timestep loop (`tickRate`
ticks/second; `onTick(dt)` always gets a constant dt). Input pattern:
`bindInput(messageType, validate)` stores the latest sanitized input per
player; the tick consumes `loop.inputs`. Clients send inputs only when
they change, and no faster than the tick rate - the server keeps only the
latest input per tick, and flooding (e.g. one message per touch-move on a
phone) trips the room's `maxMessagesPerSecond` cap and force-disconnects the
player, so throttle the send (see `ArenaView.sendInput`). Disconnected
players: skip them in the tick (freeze) rather than removing them - their
seat is held for the grace period.

Client side, render at display framerate and interpolate toward the
server position (see `ArenaView` - `displayPos` lerp). Never move the
authoritative position locally.

## Hidden information (for Splendor/Catan-style games)

See `server/src/framework/privateState.ts` for both patterns:
1. Persistent private state (a hand of cards): mark fields `@view()
   @type(...)`, then `grantPrivateView(client, player.hand)` in onJoin.
   Synced only to that client; survives reconnection automatically.
2. One-shot secrets: `client.send(...)` + re-send from `syncPrivate`.

**Schema-v4 per-item gating gotcha (the one that bites).** A `@view()`
field that is a *collection* (an `ArraySchema`/`MapSchema`) gates each item
individually. `grantPrivateView(client, seat.reserved)` only covers the
items present in that array *at grant time*; any item you `push` later is
NOT visible to the client until you also `grantPrivateView(client, item)`
on the new item. Splendor's `syncReserved` shows the pattern - it grants
every freshly created reserved card, not just the array once. If a private
hand "goes blank" for its owner after a card is added, this is why. The
flip side: because the grant is per-array-instance, every `onGameStart`
that builds new schema seats must RE-grant (and revoke the stale array) -
see `regrantReserved`, called on start, reconnect, and seat reclaim.

## Engine-backed rooms (the Splendor/Catan pattern)

Rules-heavy games are not written directly against schema. They wrap a
**pure, server-only engine** (`shared/src/games/<game>/engine/`) that knows
nothing about Colyseus, and the room is the adapter between that engine and
the synced schema. This keeps the hard game logic unit-testable in isolation
and keeps the room small. Read `SplendorRoom.ts` and `CatanRoom.ts`
together - they are deliberately the same shape:

- **`engine` is the only source of truth** and is NEVER synced. Clients send
  raw move/resolution JSON; the room whitelist-sanitizes it (`parseMove`,
  `parseResolution` - rebuild a clean object, never trust the client's),
  checks it is that seat's turn and the move is legal, then advances the
  engine and rebuilds the schema mirror in place (`syncFromEngine`). The
  schema is a projection, written top-to-bottom after every accepted input;
  nothing reads back out of it.
- **Two seat maps, snapshotted at `onGameStart`.** `seatOrder[engineSeat] =
  sessionId` translates engine seats to players; `frameworkSeatByEngineSeat`
  is kept *separately* because the winner may have left the players map by
  game-over, and `endGame("win:<seat>")` still needs their framework seat.
  Reclaim and load both rebind these.
- **Vacated seats are played out, not removed.** A mid-game leaver's engine
  seat keeps existing; a seeded `RandomPolicy` "ghost" makes its decisions so
  the game never stalls (`settleEngine`). At 2 players there is no one to play
  on, so the framework ends the game `"abandoned"` instead - reclaim/ghost
  logic therefore only ever matters at 3-4 players.
- **Bots get a paced clock.** Bot decisions run one beat apart
  (`maybeScheduleBot` + `clock.setTimeout`) so the board visibly changes "as
  if someone took a turn" rather than all at once; chained sub-decisions each
  get their own beat.
- **`afterApply()` is the single funnel** run after every accepted input, every
  ghost/bot decision, and every mid-game roster change: settle -> mirror ->
  end-if-over -> re-align the turn rotation with the engine -> refreeze the
  clock -> re-arm bots. If you add a new way to advance the engine, route it
  through `afterApply` rather than re-implementing the tail.

When you build a third engine-backed game, copy one of these rooms wholesale
and swap the engine - do not start from the thin TicTacToe room.

**Every engine ships four safety nets** (Splendor and Water Fight are the
reference; the others were back-ported). They are not optional polish - a
rules-heavy engine without them ships soft-locks and state corruption that only
surface live, mid-game:

- **`engine/invariants.ts` -> `assertInvariants(state)`** (throws on violation):
  *conservation* (the fixed card/resource pool is accounted for across every
  pile and hand, no dupes, valid ranges) + a *soft-lock detector* ("the game is
  not over, yet no seat is awaited and no forced auto-step is pending" must
  never hold). Make it **phase-aware** - a check that assumes "in play" (a
  current player is set, turnOrder is a full permutation) must be gated off the
  setup/over phases, or it will fire on a legitimate state. This is the single
  highest-value net.
- **`engine/validateData.ts` -> `validate<Game>Data(): string[]`** (empty =
  valid): the static card/board/cost tables are well-formed and the id ranges
  (main / shop / event, etc.) never collide. A build-time data guard - a
  mistyped table fails a test instead of crashing a live game. Test-only.
- **A strict save validator** (`server/src/games/<game>/save.ts`): the blob is
  UNTRUSTED. `parseSave` rebuilds field-by-field, stamps + gates an
  `ENGINE_VERSION` (reject an incompatible save), then on the rebuilt state runs
  `assertInvariants` + a `legalMoves`/"can someone act?" smoke, rejecting on any
  throw. Do NOT re-implement `assertInvariants`' cross-checks inline here (a
  non-phase-aware copy wrongly rejects a legitimate mid-setup save - a bug we
  hit); call the phase-aware net and let it be the authority.
- **A fuzz suite** (`server/test/<game>Engine.test.ts`): random (and greedy)
  playouts at every player count, calling `assertInvariants` after EVERY reduce,
  under a termination guard. This is what actually proves the engine can't
  soft-lock or corrupt state - and an invariant that fires on a legal playout is
  too strict, so the fuzz is also how you tune the net.

## Client framework

- `GameClient.create/join` connect and persist `{reconnectionToken, code,
  gameType, nickname}` to localStorage. `tryResume()` runs once at page
  load and reconnects with the stored token; on failure it clears the
  session and falls back to the home screen.
- `RoomScreen` owns all generic chrome and re-renders it from BaseState on
  every patch. When phase becomes "playing" it mounts the game's
  `GameView` into `#game-root`; on "ended" it unmounts the view and shows
  the result + rematch UI. A rematch mounts a FRESH view instance - views
  must not assume they live across games.
- `GameView.unmount()` MUST remove every listener it added (state
  callbacks, window key handlers, rAF loops). See both demo views.
- Two reconnection layers, both automatic: the SDK retries transient
  drops in-page (RoomScreen shows the "Reconnecting..." overlay via
  room.onDrop/onReconnect), and a full page reload resumes via
  `tryResume()`.

## Testing

`server/test/` uses mocha + `@colyseus/testing`. Patterns that matter:
- Build a fresh `defineServer(...)` config PER SUITE (a config factory) -
  booting one shared config object from two files breaks the second boot.
- Drive real SDK clients: `colyseus.createRoom`, `colyseus.connectTo`,
  `colyseus.sdk.joinById`, `client.leave(false)` simulates an abnormal
  drop (refresh), `colyseus.sdk.reconnect(token)` tests resume.
- Don't use `waitForNextMessage` after `send` (it can subscribe too late
  and hang/desync). Use the `until(() => condition)` helper from
  `StubRoom.ts` to wait on observable state, and `sleep(80)` before
  asserting that something did NOT change.

## Security/abuse posture

- Rooms are `setPrivate()` - only joinable by code.
- Concurrent room cap (`MAX_CONCURRENT_ROOMS` in roomCodes.ts).
- `maxMessagesPerSecond = 60` per client (transport disconnects floods).
- Monitor/playground panels are dev-only (`NODE_ENV !== "production"`).
- All payloads validated server-side; all game rules enforced server-side.
