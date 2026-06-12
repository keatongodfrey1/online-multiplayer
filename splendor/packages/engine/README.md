# @splendor/engine

The pure, deterministic Splendor rules engine. No I/O, no `Date`, no `Math.random`,
no DOM — it runs identically in Node and the browser, which is what lets the server
(authority) and the web client (optimistic UI) share exactly one implementation.

## Run it
```bash
npm install                          # from the repo root
npm run -w @splendor/engine test     # build + unit tests + data validation + fuzz
npm run -w @splendor/engine fuzz     # just the invariant fuzz
npm run -w @splendor/engine gen:data # regenerate src/gameData.ts from data/*.json
```

## API surface (see `src/types.ts` for the full types)
```ts
createGame(playerCount, seed, options?) -> GameState     // seeded, pinned shuffle
legalMoves(state) -> Move[]                              // [] => forced pass
isLegalMove(state, move) -> boolean
applyMove(state, move) -> { state, awaiting, events }     // pure (clones internally)
applyResolution(state, resolution) -> { ... }             // DISCARD / PICK_NOBLE
applyPass(state) -> { ... }                               // only when no legal move
redact(state, seat | "spectator") -> RedactedState        // per-recipient view
isGameOver(state) -> boolean ; ranking(state) -> RankEntry[]
assertInvariants(state)                                   // throws on any violation
validateGameData(data) -> string[]                        // [] === valid
GreedyPolicy, RandomPolicy                                // fuzz / AI baseline
```

A turn is: `applyMove` → if the engine returns `awaiting.inputType === "PICK_NOBLE"`
or `"DISCARD"`, answer with `applyResolution`; otherwise it is the next seat's turn.
When `legalMoves` is empty the caller (server) must `applyPass` — the engine does not
silently skip, because a forced pass still counts toward the stalemate check.

## Determinism (important)
Shuffling uses a **pinned PRNG** (`mulberry32`) + Fisher–Yates, seeded by the game
`seed`. Given the same `(engineVersion, seed, options, move list)` the engine reproduces
the exact same state — which is what makes event-sourced persistence and replay work
(SPEC §13). If you ever change `src/rng.ts` or the shuffle order in `createGame`, bump
`ENGINE_VERSION` so old replays are correctly rejected.

## Data & validation
- `data/splendor_data.json` is the canonical 90-card / 10-noble dataset (+ JSON Schema).
- `src/gameData.ts` is **generated** from it (`npm run gen:data`) and embedded so the
  engine needs no file I/O at runtime. A test asserts the two never drift.
- `validateGameData()` enforces what JSON Schema cannot (unique ids, the 40/30/20 split,
  8/6/4 per-color counts, exact point distributions, total prestige, the official example
  card, and the exact noble shape). It runs in CI on every push.

## Tests
`node:test` (no extra framework). Coverage includes determinism, opening legal-move
counts, the gold-accounting regression (spend gems before gold; never go negative),
free purchases, take-three scarcity, multi-noble resolution, immediate-mode end game,
redaction safety (no leaked reserved cards / deck order / seed), data validation, and an
**invariant fuzz**: hundreds of greedy + random games per player count asserting every
invariant on every step and that every game terminates (by points, stalemate, or the
required turn cap).
