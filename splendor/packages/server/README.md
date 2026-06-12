# @splendor/server

The authoritative game server. It owns the one true `GameState`, applies **only**
engine-validated moves, and sends every client a **redacted** view so no one can see
opponents' reserved cards, the deck order, or the RNG seed.

## Design: a pure core + a thin transport
The interesting logic — rooms, seating, turn enforcement, redaction, AI/forced-pass
automation, disconnect/reconnect, host migration — lives in a **transport-agnostic core**
(`GameServer` + `Room`) that talks to clients through an abstract `Connection`
(`{ id, send, close }`). That is what makes it deterministically testable with a fake
connection and a manual clock — no sockets, no real timers, no flakiness. A thin
`ws` adapter (`wsAdapter.ts`) is the only piece that touches real WebSockets.

Per-room message handling is **synchronous**, which is exactly the serialization the
spec requires: two messages for the same room can never interleave.

## Run it
```bash
npm install                          # from the repo root (installs ws + workspaces)
npm run -w @splendor/engine build    # the server depends on the engine's compiled output
npm run -w @splendor/server test     # build + lobby/play/reconnect tests (no sockets)
```
To run a real server:
```ts
import { startServer } from "@splendor/server";
const { close } = startServer(8080);  // ws://localhost:8080
```

## What it enforces (SPEC §13/§14)
- **Authority & legality.** Every `MOVE`/`RESOLVE` is checked against the engine
  (`isLegalMove` / `applyResolution`); illegal or out-of-turn input is `REJECTED`
  (`OUT_OF_TURN`, `ILLEGAL_MOVE`, `ILLEGAL_RESOLUTION`, `NOT_A_PLAYER`, …).
- **Per-recipient redaction.** Each seat gets `redact(state, seat)`; spectators get
  `redact(state, "spectator")`. The wire never carries the deck order or the seed.
- **Idempotency.** Each mutating message carries a `reqId`; a duplicate re-syncs state
  instead of applying twice (covers client retries on a flaky connection).
- **Crypto-random identity.** 128-bit session tokens via `node:crypto`, not derivable
  from room code + seat; unambiguous human-typable room codes.
- **AI & forced pass.** AI seats play automatically; when any seat (human or AI) has no
  legal move the server applies the forced pass and advances — it never stalls waiting
  for a pass.
- **Resilience.** On disconnect the host migrates to the next connected human; the
  dropped player's turns are taken over by a safe AI after a timeout (and they can
  reconnect with their token to reclaim the seat); joining after start makes a spectator.

## Wire protocol
See `src/protocol.ts` for the full `ClientMessage` / `ServerMessage` unions and the
`RoomView` / `Connection` shapes.

## Tests (`node:test`, deterministic)
- **lobby** — create/join, host-only guards, AI seats + options, redaction on deal,
  spectator-on-join.
- **play** — turn-order + legality enforcement, `reqId` idempotency, and a complete
  human-vs-AI game driven through the server to `GAME_OVER`.
- **reconnect** — host migration, token reconnect, unknown-token rejection, and a full
  game completing under AI takeover of a disconnected seat (driven by a manual clock).

## Not yet done
A turn clock for *connected* players (only disconnected-seat takeover is implemented),
durable persistence/replay of the event log, and rate limiting are left for later;
hooks are in place (`reqId`, seq, the pinned-PRNG engine) to add them without redesign.
