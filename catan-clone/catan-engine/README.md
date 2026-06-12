# Catan-clone engine (TypeScript)

A headless, deterministic rules engine for a Catan-style game, built to accompany
`catan_clone_spec.md`. Pure reducer core (`reduce(geo, state, action) -> state`),
exact integer board geometry, and a broad test suite.

> Mechanics only. Ship with an original name and original art (see the legal
> note at the top of the spec).

## Running

No install step — Node 22+ runs the TypeScript directly:

```bash
node --experimental-strip-types src/verify.ts            # geometry + turn flow
node --experimental-strip-types src/verify_actions.ts    # dev cards, trade, awards, victory
node --experimental-strip-types src/verify_advanced.ts   # the hard cases + every added feature
node --experimental-strip-types src/verify_property.ts   # randomized invariant testing (300 games)
```

Each harness prints a `PASS`/`FAIL` line per assertion and exits non-zero on failure.

## Files

- `src/types.ts` — domain types and constants. No logic.
- `src/geometry.ts` — pure board topology. Generates the 19/54/72 hex/vertex/edge
  graph from cube coordinates. **Vertex identity is exact** (a corner is keyed by
  the integer set of the three cube coords meeting there — no floating-point
  rounding). Provides placement validators, port/trade-ratio helpers,
  `computeLongestRoadLength`, and render helpers (`edgeMidpoint`,
  `edgeOutwardNormal`, `coastalEdgesOrdered`). The pointy-top orientation
  contract a UI must follow is documented in the file header.
- `src/stateMachine.ts` — `createInitialGameState` and the `reduce` reducer:
  setup snake-draft, roll + production (bank-scarcity aware), the full robber
  flow, building, all five dev cards, maritime + domestic trade, Longest Road /
  Largest Army, victory, **3–6 players with the special building phase**, plus
  `tryReduce` (typed errors), `viewForPlayer` (redaction), `serialize`/
  `deserialize`/`replay`, and a fast `cloneGameState`.
- `src/render.ts` — dependency-free SVG board renderer (`renderBoardSVG`).
- `src/verify*.ts` — the four test harnesses.
- `sample-board.svg` / `sample-board.png` — output of the renderer.

## How the 19 review items were resolved

1. **Port layout** — harbours follow a clean repeating 2-2-3 empty-edge gap
   rhythm (four 3:1 + one 2:1 per resource, none adjacent). This is a fair,
   fixed layout, not a reproduction of a specific retail board's printed
   harbour positions. `variablePorts` shuffles the chips, positions fixed.
2. **Longest Road** — implemented to the official rule (transfer only on a
   *strictly* longer road; ties set aside; holder keeps when tied). Documented
   why no build-event ordering is needed. Directly unit-tested. A 10th point
   gained via a Longest Road transfer on an *opponent's* turn is detected at the
   start of the beneficiary's own turn (never on someone else's turn).
3. **Year of Plenty** — takes whatever the bank can supply and skips what it
   can't, instead of failing all-or-nothing.
4. **Hidden information** — `viewForPlayer(state, viewer)` returns a redacted
   view: opponents' hands become a size only, their hidden dev cards a count,
   the dev deck a count, and the RNG seed is stripped.
5. **Randomness trust** — `reduce` ignores client-supplied dice unless
   `{ trustClientRandomness: true }` is passed (tests use it; production
   doesn't). Dice and steals come from the seeded server-side RNG.
6. **Typed errors** — `tryReduce` returns `{ ok: true, state } | { ok: false,
   error }` so a server never crashes on an illegal action.
7. **Fast clone** — a hand-written `cloneGameState` replaces `structuredClone`
   on the reducer's hot path (~73× faster in-process; matters for bot search).
8–13. **Test gaps closed** — dynamic Longest Road transfer/tie/removal; bank
   scarcity with single- and multi-claimant shortfalls; city-upgrade piece
   accounting; maritime 3:1 and 2:1; a Knight-before-the-roll followed by a 7
   (two robber moves in one turn); and (9) winning by buying the 10th-point VP
   card. All in `verify_advanced.ts` / `verify_actions.ts`.
14. **Property testing** — `verify_property.ts` plays 300 randomized games
   (3–6 players, dev-card plays, trades) asserting resource conservation,
   non-negativity, piece limits, and that no win is ever missed.
15. **Exact geometry** — vertex de-duplication is now integer-exact (see above),
   not floating-point.
16. **Orientation** — the pointy-top contract is documented and the SVG renderer
   demonstrates it.
17. **5–6 players** — the engine supports 3–6 players and implements the special
   building phase (a clockwise build round between turns; build/buy only;
   winnable). Custom boards are supported via `hexCoords` + `terrainBag` +
   `numberBag` + `bankPerResource`. See the caveat below on retail geometry.
18. **UI / persistence / networking** — `serialize`/`deserialize`/`replay` give
   persistence and deterministic replay; `renderBoardSVG` gives a static UI; the
   redaction + typed-error boundary are the server-side seam.
19. **Domestic trade** — fully implemented: `proposeDomesticTrade` /
   `respondDomesticTrade` / `confirmDomesticTrade` / `cancelDomesticTrade`,
   resource-for-resource, no gifts, holdings validated at confirm time.

## Subtle rules choices & known nuances

A second skeptical pass surfaced these — documented rather than hidden:

- **Winning during the special building phase is allowed.** A player who hits
  10 VP while building in their special-build window wins immediately. The
  strict reading ("win only on your turn") would defer this to their next turn;
  digital implementations differ. Chosen the immediate-win behaviour.
- **Replay must use the same `trustClientRandomness` setting as the original
  play.** Untrusted (RNG-driven) games replay deterministically with the
  default; a game played with scripted dice must be replayed with the trust
  flag set, or the rolls will diverge.
- **Played progress cards are public in views; unplayed ones are not.**
  `viewForPlayer` exposes each player's *played* dev cards and total dev-card
  count, but hides unplayed cards (including which are victory points).
- **Number placement is "balanced" (no adjacent red 6/8) or "random".** The
  canonical A–R spiral sequence is exported (`SPIRAL_NUMBER_SEQUENCE`) for
  callers who want beginner setup, but a spiral placement *mode* is not wired in.
- **The action log lives in the state and is copied each `reduce`** (shallow,
  O(log length)). Negligible at game scale; relevant only for very long
  replay-heavy loops.
- **`deserialize` trusts its input** (no schema validation) — fine for your own
  persistence, not for untrusted bytes.
- **Maritime trade has no per-turn limit** (correct), and domestic-trade
  conservation is verified by construction + the targeted tests rather than in
  the random property loop.

## Honest remaining caveats

- **Exact retail 5–6 board geometry.** The engine plays 3–6 players and runs the
  special building phase correctly, and `createInitialGameState` accepts custom
  `hexCoords` / `bankPerResource` / `devDeck`, so the official expansion board
  can be plugged in. By default it uses the standard 19-hex board; the exact
  retail 5–6 tile arrangement is not fabricated here.
- **Networking transport** is an app-layer concern. The engine provides the
  authoritative-server seam (pure reducer, redacted views, typed errors,
  serialization); it does not open sockets.
- **Interactive UI** is an app-layer concern. A static SVG renderer is included;
  click-to-build wiring is not.
- **Bot AI** is described in the spec, not implemented here.
