# Splendor (online multiplayer clone) — monorepo

A faithful, online-multiplayer clone of **Splendor** where each player plays from
their own device (no pass-and-play, no install). This repo currently contains the
**rules engine** — the pure, deterministic core that the server and web client will
both depend on. The full design lives in **`SPEC.md`** (shipped alongside this repo).

## Status
- ✅ `packages/engine` — pure rules engine, data validator, invariant fuzzer, CI. **Done & tested.**
- ✅ `packages/server` — authoritative WebSocket server (rooms, sessions, redaction, AI/forced-pass automation, reconnect/host-migration). **Done & tested.**
- ⬜ `apps/web` — React client / PWA. *Next.*

The engine and server are deliberately first: the engine is the single source of truth
for the rules, the server is the single source of truth for a *match*, and both are the
things most expensive to get wrong. The web client will import the engine for optimistic
UI and treat the server's state as authoritative.

## Layout
```
packages/engine/      # @splendor/engine — rules, types, data, validation, tests
  src/                # engine source (pure, no I/O; browser- and node-safe)
  test/               # node:test unit tests + invariant fuzz
  data/               # canonical splendor_data.json + JSON Schema
  scripts/gen-data.mjs# regenerates src/gameData.ts from data/splendor_data.json
packages/server/      # @splendor/server — authoritative WebSocket server
  src/                # transport-agnostic core (GameServer + Room) + ws adapter
  test/               # node:test: lobby, play, reconnect (no sockets, manual clock)
tsconfig.base.json    # shared TS config
.github/workflows/    # CI: engine (typecheck + data + fuzz) then server
```

## Quickstart
Requires Node 20+ (uses the built-in `node:test` runner and `structuredClone`).
```bash
npm install
npm run -w @splendor/engine test      # build + unit tests + data validation + fuzz
npm run -w @splendor/server test      # build + lobby/play/reconnect tests
```
The server depends on the engine's compiled output, so build/test the engine first
(CI does this automatically).

## How the pieces will fit (per SPEC §13)
The **engine** is pure and shared. The **server** holds the authoritative `GameState`,
applies only engine-validated moves, and sends each client a **redacted** view
(`redact(state, seat)`) so no one ever sees opponents' reserved cards, the deck order,
or the RNG seed. The **web client** imports the same engine for instant
affordability/legality highlighting, but always treats the server's state as truth.

See `SPEC.md` for the complete rules, wire protocol, AI design, accessibility
requirements, and IP guidance.
