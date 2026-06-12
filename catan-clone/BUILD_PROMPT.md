# Build prompt — multiplayer Catan-style game (separate devices)

Paste this into your coding AI to build the app. It treats the engine and spec
in this folder as a **starting roadmap you may improve or replace**, and targets
**real-time multiplayer with each player on their own tablet** (not single-screen
hotseat). Assumes `catan-engine/` and `catan_clone_spec.md` are in the repo.

---

You are building a real-time, multiplayer Catan-style board game where EACH PLAYER PLAYS ON THEIR OWN SEPARATE DEVICE (tablets). This is NOT a single-screen hotseat game. Players join a shared game from different tablets and play together over the network, each seeing only their own private information.

## Mindset: the existing work is a ROADMAP, not a spec to obey
A previous pass produced a working, well-tested rules engine and a detailed rules document. Treat them as a strong reference implementation and a head start — NOT as constraints. You have full latitude to refactor, re-architect, re-model, change the API, port to a different language/stack, or rewrite any part (including the engine itself) if you can do it better. Disagree with our choices freely; just briefly document why when you diverge.

The one thing to preserve is the hard-won CORRECTNESS, which is encoded in the test suite. If you keep the engine, keep its tests green; if you restructure or rewrite it, carry over equivalent-or-stronger tests so rules fidelity doesn't regress (resource conservation, longest-road transfer/tie/removal, bank scarcity, robber/discard/steal, dev-card timing, victory detection including cross-turn wins, the special building phase, redaction, replay determinism). Improvements to known-open decisions are explicitly welcome — see "Open questions" below.

## What exists (read it as reference, improve as you see fit)
- `catan-engine/` — a pure, deterministic rules engine in ESM TypeScript (Node 22+, run via `node --experimental-strip-types <file>`).
  - `src/types.ts` — domain types/constants (Resource, Terrain, ResourceBag, DevCard, Port, COSTS, PIECE_LIMITS, GameState, Phase, PendingTrade, WINNING_VP=10, etc.).
  - `src/geometry.ts` — pure board topology + queries: buildBoardGeometry(coords?), STANDARD_HEX_COORDS, hexRadius, edgeMidpoint, edgeOutwardNormal, coastalEdgesOrdered, and pure validators getValidInitialSettlements / getValidSettlements / getValidCities / getValidRoads / portAccess / bestTradeRatio / computeLongestRoadLength. Pointy-top layout; Vertex.point / Hex.center give positions.
  - `src/stateMachine.ts` — createInitialGameState(geo, opts) and the reducer reduce(geo, state, action, opts) / tryReduce(...) -> {ok,state}|{ok,error}. Plus victoryPoints, getStealTargets, viewForPlayer (per-player redaction), serialize/deserialize/replay/actionsFromLog. Randomness is server-authoritative: opts.trustClientRandomness defaults FALSE, so client-supplied dice are ignored and dice/steals/dev-draws come from the engine's seeded RNG.
  - `src/render.ts` — a static SVG board renderer (reference for colors/positions).
  - `src/verify*.ts` — four test harnesses; run with `node --experimental-strip-types catan-engine/src/verify*.ts`.
- `catan_clone_spec.md` — full rules spec, with an edge-case checklist and a "subtle rules choices & known nuances" section. Read it for rules questions and to see where we made judgment calls.
- The README's "Subtle rules choices & known nuances" and "Honest remaining caveats" sections list what we deliberately deferred.

Action union the reference reducer accepts (change if you re-model): placeSetupSettlement{vertex}, placeSetupRoad{edge}, rollDice{dice?}, discard{player,cards}, moveRobber{hex}, steal{target}, buildRoad{edge}, buildSettlement{vertex}, buildCity{vertex}, buyDevCard, playKnight, playRoadBuilding, playYearOfPlenty{resources}, playMonopoly{resource}, maritimeTrade{give,receive}, proposeDomesticTrade{give,receive,to?}, respondDomesticTrade{player,accept}, confirmDomesticTrade{partner}, cancelDomesticTrade, endSpecialBuild, endTurn.
Phases: setupSettlement, setupRoad, preRoll, discard, moveRobber, steal, main, specialBuild (5-6 players), gameOver.

## Target architecture: separate devices, authoritative server
- AUTHORITATIVE SERVER holds the single source-of-truth game state and is the only place actions are applied and randomness is generated. A Node/TypeScript server can reuse the engine modules directly (no rewrite needed) — but you may choose another stack; just keep one authoritative server.
- REAL-TIME TRANSPORT (e.g., WebSockets) so every tablet updates live: dice rolls, robber moves, whose turn it is, trade offers, etc. Avoid poll-only.
- PER-DEVICE PRIVACY IS NON-NEGOTIABLE: the server sends each tablet ONLY that player's redacted view (the reference engine's viewForPlayer is built for exactly this). Never send the full game state to any client — it contains every hand, the dev-deck order, and the RNG seed. A client must not be able to see opponents' hands, read the deck, or predict steals/draws.
- SERVER-SIDE FAIRNESS: the server ignores any client-supplied randomness (keep trustClientRandomness off) and only accepts actions from the player who is actually allowed to act right now (current player; the special builder during specialBuild; any player who owes a discard after a 7; the relevant participants in a domestic trade). Reject and report everything else without crashing (tryReduce-style).
- LOBBY / ROOMS: create a game, get a short join code, players join from their tablets, choose seat/color in a shared lobby, host starts. Support 3-6 players.
- RECONNECTION & PERSISTENCE: a tablet that refreshes or drops can rejoin its seat (seat token) and receive the current view; persist game state (serialize/deserialize) so a game survives a server restart.
- CLIENTS may reuse the engine's PURE geometry + validators locally for legal-move highlighting (the board in a player's view is public), while the server stays authoritative for applying moves. Optional optimistic UI is fine as long as the server is the source of truth.

## Client: touch-first, one seat per device
- Web app each tablet opens in a browser (responsive, installable/PWA is a plus). React Native/Expo is acceptable if you prefer installable apps — your call.
- TOUCH-FIRST UX: large tap targets, no hover-dependent interactions, legible at arm's length, works in landscape on a tablet.
- Each device shows only its own seat: its hand and dev cards, the public board, and other players as public info (hand counts, played dev cards, VP that's public, badges for Longest Road / Largest Army).
- Phase-driven, and interactive only when it's this player's moment: highlight legal vertices/edges/hexes during your turn (using the pure validators on the public board); show a Roll button in preRoll (send rollDice with no dice — the server rolls); a discard prompt on every device that owes cards after a 7; a robber-move + steal-target picker for the current player; a build/buy/trade/play-dev/end-turn action bar in main; special-building controls for 5-6 players. Domestic trades fan out: the proposer offers, other tablets see the offer and accept/decline, the proposer confirms.
- Clear shared status everyone can see: whose turn it is, the last roll, the robber, awards, and a win banner at 10 VP.

## Open questions you may decide (and improve on)
- Special building phase: should reaching 10 VP win immediately during your special-build window, or only on your next turn? The reference allows immediate; the strict reading defers. Pick what's best and note it.
- The exact retail 5-6 board layout and the harbour positions in the reference are reasonable-but-not-exact; improve toward the real layouts if you want.
- API ergonomics, performance, and state representation are all open to redesign.

## Build in milestones, validating each
1. Server skeleton that owns a game (reuse or rebuild the engine), applies actions authoritatively, and exposes per-player redacted views. Keep/port the rules tests and confirm green.
2. Real-time transport + a lobby: create/join by code, seat selection, host starts a 3-4 player game.
3. Two real devices can play the core turn loop live (setup snake-draft, roll, production, build, end turn) — each seeing only its own hand.
4. Robber/7 across devices (simultaneous discards, robber move, steal), and trading (maritime + domestic offer/accept/confirm fan-out).
5. Reconnection (rejoin a seat) and persistence (survive a server restart).
6. Polish: touch UX, awards/victory, PWA/installability, and 5-6 player special building phase.
7. (Optional) AI players to fill empty seats — leave a clean seam even if you don't build it now.

## Acceptance criteria
- A full game is playable end-to-end across at least two SEPARATE devices, each controlling one seat, with live updates.
- Private information never reaches another device (no opponent hands, no deck order, no predictable randomness on the client); the server is authoritative and rejects illegal/out-of-turn actions without crashing.
- Reconnecting to a seat works; a game survives a server restart.
- Rules correctness is preserved: the carried-over/rewritten test suite passes, and matches or exceeds the reference engine's coverage.
- 3-6 players supported, including the special building phase.

Start by reading the spec, the engine README (including the nuances/caveats sections), and the engine source. Then propose your architecture and stack and a short milestone plan — including any changes you'd make to the engine or rules model and why — before writing code. You are encouraged to improve on what exists.
