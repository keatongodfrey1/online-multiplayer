# Settlers of Catan — Implementation Specification (Base Game, 3–4 Players)

A complete, implementation-oriented description of the rules, geometry, state, and edge cases of *Settlers of Catan*, written so a coding agent (e.g., Claude Code) can build a faithful clone.

> **Legal / naming note for a real clone:** The *rules and mechanics* of a board game are not protected by copyright (you may freely implement them). The name **"Catan" / "Settlers of Catan"**, the box/logo, and the original board artwork **are** trademarked/copyrighted. If you ship this publicly, use an original name and original art. This spec describes mechanics only and reproduces no proprietary text or artwork.

---

## 1. Overview

Catan is a turn-based, resource-management strategy game for 3–4 players (this spec covers the base game; the 5–6 player extension changes only counts and adds a "special build phase," noted briefly at the end).

Players build **roads**, **settlements**, and **cities** on a shared hexagonal island. Each turn, dice rolls produce resources from terrain hexes; players spend resources to build, trade with each other and the bank, and buy development cards. **The first player to reach 10 victory points on their own turn wins.**

The whole game reduces to:
1. A **board** = a graph of hexes, vertices (intersections), and edges (paths).
2. **Resource economy** driven by 2d6 rolls.
3. **Placement rules** for pieces on that graph.
4. **Victory-point accounting**.

---

## 2. Components (Base Game Inventory)

| Component | Count | Notes |
|---|---|---|
| Terrain (resource) hexes | 19 | See breakdown below |
| Number tokens (chits) | 18 | Numbers 2–12 except 7 |
| Sea frame pieces | 6 | Form the hexagonal ocean border; carry the ports |
| Ports / harbors | 9 | 4× generic (3:1), 5× resource-specific (2:1) |
| Resource cards | 95 | 19 each of 5 resources |
| Development cards | 25 | See breakdown in §13 |
| Special cards | 2 | "Longest Road" and "Largest Army" |
| Dice | 2 | Standard six-sided |
| Robber | 1 | Pawn; starts on the desert |

**Player pieces (per player, in 4 colors — typically red, blue, white, orange):**

| Piece | Count per player | Victory points |
|---|---|---|
| Settlements | 5 | 1 each |
| Cities | 4 | 2 each |
| Roads | 15 | 0 |

These counts are hard limits. If a player has all 5 settlements on the board, they cannot place another until one is upgraded to a city (which returns the settlement piece to their supply). Cities cap at 4.

### 2.1 Terrain hexes → resources

| Terrain | Hex count | Produces resource |
|---|---|---|
| Forest | 4 | **Lumber** (wood) |
| Pasture | 4 | **Wool** (sheep) |
| Fields | 4 | **Grain** (wheat) |
| Hills | 3 | **Brick** |
| Mountains | 3 | **Ore** |
| Desert | 1 | Nothing (robber starts here) |

Total = 4+4+4+3+3+1 = **19**.

### 2.2 Resource cards
Five resource types, **19 cards of each** in the bank: Lumber, Brick, Wool, Grain, Ore. The bank is finite — see the production edge case in §9.2.

---

## 3. Board Geometry & Coordinate System

This is the part most likely to trip up an implementation, so it is specified precisely.

The 19 land hexes are arranged in a **large hexagon of "radius" 2** (rows of 3-4-5-4-3). Around them sit 6 sea-frame pieces forming the coastline that carries the ports.

The board has exactly:
- **19 hexes**
- **54 vertices** (intersections — where settlements/cities go)
- **72 edges** (paths — where roads go)

Use these three counts as a sanity check when you generate the board: if your generator does not produce exactly 19 / 54 / 72, the topology is wrong.

### 3.1 Recommended hex coordinates (cube/axial)

Use **cube coordinates** `(x, y, z)` with the constraint `x + y + z = 0`. The 19 valid land hexes are exactly those where `max(|x|, |y|, |z|) <= 2`:

- 1 center hex `(0,0,0)`
- 6 hexes at distance 1
- 12 hexes at distance 2

→ 1 + 6 + 12 = 19. ✔

(Axial `(q, r)` is equivalent: `x = q`, `z = r`, `y = -q-r`. Use whichever you prefer; cube makes neighbor math symmetric.)

The 6 neighbor directions in cube space are:
`(+1,-1,0), (+1,0,-1), (0,+1,-1), (-1,+1,0), (-1,0,+1), (0,-1,+1)`.

### 3.2 Deriving vertices and edges (the clean way)

Rather than hand-number 54 vertices and 72 edges, **generate them and deduplicate**:

1. For each hex, compute the Cartesian center, then compute its **6 corner points** using a fixed corner layout (pointy-top or flat-top — pick one; pointy-top is conventional for Catan). Round corner coordinates to a small epsilon and use the rounded value as a **canonical key**. Shared corners between adjacent hexes collapse to the same key → **54 unique vertices**.
2. For each hex, its 6 edges connect consecutive corners. Each edge's canonical key is the unordered pair of its two vertex keys. Shared edges collapse → **72 unique edges**.

Alternative (no floating point): identify each vertex by the **sorted set of hexes it touches** (1, 2, or 3 hexes). Two adjacent hexes share an edge; three mutually adjacent hexes share a vertex. This is fully integer and deterministic. Either approach is fine; the float-dedupe approach is simplest to code.

### 3.3 Precomputed adjacency tables you will need

Build these once at board-creation time and store them (they never change during a game):

- `hexVertices[hex] → [up to 6 vertices]`
- `hexEdges[hex] → [up to 6 edges]`
- `vertexHexes[vertex] → [1–3 hexes]` (drives resource production)
- `vertexEdges[vertex] → [2–3 edges]` (which roads touch this intersection)
- `vertexNeighbors[vertex] → [2–3 vertices]` (the **distance rule** uses this)
- `edgeVertices[edge] → [exactly 2 vertices]` (road endpoints)
- `edgeNeighbors[edge] → [2–4 edges]` (road network connectivity; two edges are neighbors iff they share a vertex)

With these tables, every placement and scoring rule becomes a simple graph query.

### 3.4 Ports

There are **9 ports**, each sitting on one coastal edge of the sea frame and **associated with the 2 coastal vertices at the ends of that edge**. A player gains a port's trade ratio by having a **settlement or city on either of those 2 vertices**.

- 4 × **generic 3:1** ports (trade any 3 identical resources for 1 of choice).
- 5 × **specific 2:1** ports, one per resource: 2:1 Lumber, 2:1 Brick, 2:1 Wool, 2:1 Grain, 2:1 Ore.

In a fixed board the ports occupy fixed coastal positions; in a randomized board, port positions/types may also be shuffled. Model a port as `{ type: "generic" | resource, vertices: [vA, vB] }`.

---

## 4. Board Setup

Two valid setups; support at least the randomized one:

### 4.1 Randomized ("variable") setup
1. Arrange the 6 sea-frame pieces; optionally shuffle port positions.
2. Shuffle the 19 terrain hexes and place one per hex slot (so terrain–position pairing is random, subject to the fixed count in §2.1).
3. Place number tokens on all hexes **except the desert** (desert gets no token; the robber starts on it). See §5.
4. Place the **robber on the desert**.

### 4.2 Fixed / "beginner" setup
A predetermined arrangement of terrain, numbers, and ports plus fixed starting settlements/roads. Useful as an optional deterministic mode. (Don't copy the official beginner map verbatim; define your own fixed seed.)

---

## 5. Number Tokens & Probability

There are **18 number tokens**: one **2**, one **12**, and **two each** of 3, 4, 5, 6, 8, 9, 10, 11. (No 7 — 7 triggers the robber.)

Each token shows **pips** equal to the number of dice combinations that produce it (its probability weight). **6 and 8 are printed in red** because they are the most likely numbers.

2d6 probability table (out of 36):

| Roll | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9 | 10 | 11 | 12 |
|---|---|---|---|---|---|---|---|---|---|---|---|
| Ways | 1 | 2 | 3 | 4 | 5 | 6 | 5 | 4 | 3 | 2 | 1 |
| Pips | 1 | 2 | 3 | 4 | 5 | — | 5 | 4 | 3 | 2 | 1 |

### 5.1 Token placement
Two acceptable methods:
- **Alphabetical spiral (canonical):** tokens are lettered A–R on the back and laid in alphabetical order in a spiral starting from one corner of the island, skipping the desert. The fixed letter→number sequence (A→R) is:
  `5, 2, 6, 3, 8, 10, 9, 12, 11, 4, 8, 10, 9, 5, 6, 3, 11, 4`.
- **Fully random:** shuffle tokens onto non-desert hexes.

**Balancing rule to support (recommended toggle):** no two **red** numbers (6 and 8) may sit on adjacent hexes. If you randomize, reject-and-reshuffle (or swap) until this holds. Some groups also avoid same-number adjacency.

---

## 6. Players & Turn Order

3–4 players. To pick the starting player, each rolls 2d6; highest goes first; play proceeds **clockwise**. Track a fixed seating order; "next player" wraps around.

---

## 7. Initial Placement (Setup Snake Draft)

Before normal play, each player places **2 settlements and 2 roads** via a snake draft:

1. **Round 1** — in seating order (P1 → P2 → …): each player places **1 settlement** on any legal vertex, then **1 road** on an edge adjacent to that settlement.
2. **Round 2** — in **reverse** order (… → P2 → P1): each player places a **second settlement + adjacent road**.

Rules during setup:
- The **distance rule** (§12.3) applies to all settlement placements, including these.
- Setup settlements do **not** need to connect to a road (placement is free); the road placed must be adjacent to the settlement just placed.
- After placing the **second** settlement, each player immediately **collects one resource card for each terrain hex adjacent to that second settlement** (no resources from the first settlement; desert/sea give nothing).

Note the snake order means the last player places two settlements back-to-back (end of round 1, start of round 2).

---

## 8. Turn Structure (State Machine)

Normal turn, in order:

1. **(Optional) Play one development card** — a dev card may be played *before* rolling (commonly a Knight to pre-empt the robber). See §13 for the "only one per turn, not the turn you bought it" rules.
2. **Roll dice** (mandatory). Sum 2d6.
   - **If 7** → run the **robber sequence** (§10): discards, move robber, steal. **No resources are produced.**
   - **Else** → **produce resources** (§9).
3. **Trade** (optional, any number): domestic (player-to-player) and/or maritime (bank/port). See §11.
4. **Build / buy** (optional, any number, resources permitting): roads, settlements, cities, and/or buy development cards. See §12–13.
5. **Check victory** (§15): if the current player has ≥10 VP, they win immediately.
6. **End turn** → pass clockwise.

The official rulebook lists "trade" then "build" as ordered phases, but in practice players may **interleave** trading and building freely during steps 3–4. Allow free interleaving; only the roll is strictly ordered and mandatory.

Suggested explicit states for implementation:
`SETUP_SETTLEMENT_1 → SETUP_ROAD_1 → … → SETUP_SETTLEMENT_2 → SETUP_ROAD_2 → TURN_PRE_ROLL → AWAIT_ROLL → ROBBER_DISCARD → ROBBER_MOVE → ROBBER_STEAL → TURN_MAIN → TURN_END → GAME_OVER`.

---

## 9. Dice Roll & Resource Production

### 9.1 Production algorithm (non-7 roll `n`)
For every hex whose number token equals `n` **and that does not currently have the robber on it**:
- For each vertex of that hex that holds a building:
  - **Settlement** → its owner draws **1** card of that hex's resource.
  - **City** → its owner draws **2** cards of that hex's resource.

All players produce simultaneously, including players whose turn it is not. A single roll can give one player multiple cards if they border several matching hexes.

### 9.2 Bank-limit edge case (must implement)
The bank has only 19 of each resource. If a roll would distribute more of a resource than remain in the bank:
- **If exactly one player is entitled to that resource**, that player takes **as many as remain** (could be fewer than owed, or zero).
- **If two or more players are entitled to that resource and there aren't enough for all of them**, **no one receives any** of that resource for this roll.

Resolve each resource type independently. (When a card leaves a player's hand or is discarded, it returns to the bank and becomes available again.)

---

## 10. The Robber (Rolling a 7, and Knight cards)

Triggered by rolling a 7 **or** playing a Knight development card. A 7 runs all three steps below; a Knight runs only **Move** + **Steal** (no discard, since no 7 was rolled).

1. **Discard (7 only):** every player (including the roller) holding **more than 7** resource cards must discard **floor(handCount / 2)**, choosing which to discard. Examples: 7→0, 8→4, 9→4, 10→5, 11→5, 12→6, 13→6, 14→7. Discards return to the bank.
2. **Move robber:** the active player moves the robber to **any land hex other than its current hex** (it must move; the desert is a legal destination). The hex the robber occupies produces no resources until it moves again.
3. **Steal:** the active player steals **1 random resource card** from a single opponent who has a settlement or city **adjacent to the robber's new hex**.
   - If multiple eligible opponents, the active player **chooses** which one to steal from.
   - If the chosen player has 0 cards, nothing is stolen.
   - If no opponents border the hex (or only the active player does), no steal occurs.

The robber blocks production on its hex for everyone — a common defensive/offensive tactic.

---

## 11. Trading

Only the **active player** may initiate trades on their turn. Other players may only trade *with* the active player, never with each other.

### 11.1 Domestic (player-to-player) trade
- Resource-for-resource only; any number of cards each way.
- **No gifts** — both sides must give at least one card (you cannot hand over cards for nothing).
- **Development cards cannot be traded.**
- Implement as: active player proposes an offer; eligible opponents may accept/counter; active player confirms one. (For a hot-seat or AI build, you can simplify to direct offers/acceptances.)

### 11.2 Maritime (bank/port) trade
- **4:1** default: give 4 identical resources, take 1 of any resource. Always available.
- **3:1** if the player owns a building on a **generic port**.
- **2:1** if the player owns a building on the **specific port for that resource** (e.g., 2:1 Ore port lets them trade 2 Ore → 1 of any).
- A player uses their best applicable ratio per resource. Port access = settlement/city on either vertex of the port (§3.4).

---

## 12. Building

### 12.1 Costs

| Build | Cost |
|---|---|
| **Road** | 1 Lumber + 1 Brick |
| **Settlement** | 1 Lumber + 1 Brick + 1 Wool + 1 Grain |
| **City** (upgrade a settlement) | 3 Ore + 2 Grain |
| **Development card** | 1 Ore + 1 Wool + 1 Grain |

Spent resources return to the bank. A player may build as many things as they can afford in a turn, in any order.

### 12.2 Roads
- An edge holds **at most one road**.
- A new road must be **connected to the player's own network**: it must touch a vertex that already has one of the player's roads, settlements, or cities.
- **A road cannot extend through a vertex occupied by an opponent's settlement/city** for the purpose of network continuity — i.e., an opponent's building at a vertex blocks your road network from continuing *through* that vertex (this also breaks Longest Road, §14.1).
- Max 15 roads per player.

### 12.3 Settlements
- A vertex holds **at most one settlement/city**.
- **Distance rule:** a settlement may be placed only on a vertex where **all directly adjacent vertices are empty** (no building on any neighbor vertex, regardless of owner). Equivalently, two buildings can never be one edge apart.
- Outside of setup, a settlement must be built on a vertex **connected to one of the player's own roads**.
- Max 5 settlements per player. Worth **1 VP**. Produces 1 resource per matching adjacent hex.

### 12.4 Cities
- A city is an **upgrade of one of the player's existing settlements** on the same vertex; the settlement piece returns to the player's supply.
- Worth **2 VP**. Produces **2** resources per matching adjacent hex.
- Max 4 cities per player. (You cannot build a city on an empty vertex — only upgrade.)

---

## 13. Development Cards

Deck of **25**, drawn from the top after shuffling. Cost: 1 Ore + 1 Wool + 1 Grain.

| Card | Count | Effect |
|---|---|---|
| **Knight (Soldier)** | 14 | Run the robber's Move + Steal (§10), no discard. Counts toward **Largest Army** (§14.2). |
| **Victory Point** | 5 | +1 VP each. Kept **secret**; never "played"; revealed only to win. |
| **Road Building** | 2 | Place **2 roads for free**, following all road rules. |
| **Year of Plenty** | 2 | Take **any 2 resource cards** from the bank. |
| **Monopoly** | 2 | Name one resource; **every other player gives you all** their cards of that resource. |

14 + 5 + 2 + 2 + 2 = **25**. ✔

### 13.1 Dev card rules (important)
- **You may not play a development card on the same turn you bought it.** Track each card as "bought this turn" until the start of your next turn. (The VP cards are an exception only in the sense that they are never actively *played* — see below.)
- **You may play at most one development card per turn** (the Victory Point cards don't count, since they are passive and never "played").
- A dev card may be played at any point on your turn, **including before the dice roll** (e.g., Knight before rolling).
- **Victory Point cards** are held face-down. They contribute to your total at all times but are revealed to opponents only when you claim victory. A just-bought VP card *can* be the card that brings you to 10 and wins on the turn you buy it (because it isn't "played," it's revealed) — support this.
- Knights are placed **face-up** in front of the player when played (so Largest Army is publicly trackable).

---

## 14. Special Achievements

### 14.1 Longest Road (2 VP)
Awarded to the player with the longest **continuous road of length ≥ 5 segments**.

- "Continuous" = a **trail**: a path along connected road edges that **never reuses the same edge** (vertices/junctions *may* be revisited, e.g., a figure-eight). Count the **longest such trail** in the player's road subgraph.
- **Opponent buildings break the road:** if an opponent has a settlement/city on a vertex in the middle of the player's road, the path is **severed at that vertex** (the player may pass through their own buildings and empty vertices, but not through an opponent's). The two pieces on either side count separately.
- The card is awarded as soon as a player first reaches length ≥ 5. It **transfers** to another player only when that other player has a **strictly longer** road.
- If the current holder's longest road drops below 5 (e.g., it gets broken), they lose the card:
  - if exactly one other player now has the sole longest road ≥ 5, that player takes it;
  - if it's a tie for the new longest (≥ 5), or no one has ≥ 5, the card is **set aside** (held by no one).

**Algorithm:** for the player whose roads changed, build a graph from their road edges, mark vertices occupied by opponents as "blocking," and DFS the longest trail (no repeated edges, never traversing *through* a blocking vertex). The graph is tiny (≤15 edges), so exhaustive DFS from every edge in both directions is fine. Recompute on any event that adds a road or places a settlement (which could break someone's road).

### 14.2 Largest Army (2 VP)
Awarded to the first player to have played **3 or more Knight cards**. It **transfers** only to a player who has played **strictly more** knights than the current holder. Track each player's count of played knights; recompute holder whenever a Knight is played.

---

## 15. Victory Points & Win Condition

A player's total VP at any moment:

- +1 per **settlement** on the board
- +2 per **city** on the board
- +2 if holding **Longest Road**
- +2 if holding **Largest Army**
- +1 per **Victory Point development card** in hand (hidden from opponents)

**Win:** the **first player to reach 10 VP, checked on their own turn**, wins immediately. A player can cross 10 at any point during their turn (after building, after a Knight that takes Largest Army, or by revealing hidden VP cards). A player **cannot win on another player's turn**, even if that player's action would push someone to 10 — re-check only on the active player's turn.

(VP cards make it possible to "hide" a winning total; that's intended.)

---

## 16. Edge Cases & Nuance Checklist

Implement/verify each of these — they are the common sources of clone bugs:

- **Robber must move** to a different hex each time (cannot stay).
- **Discard threshold is *strictly greater than* 7** (a 7-card hand discards nothing).
- **Bank scarcity** resolution (§9.2): single-recipient vs. multi-recipient when a resource is short.
- **Distance rule** applies even in setup and even relative to *opponents'* buildings.
- **Road connectivity is blocked by opponent buildings** at a vertex (both for building and for Longest Road).
- **Longest Road is a trail (no repeated edges), not a simple path**, and it can be broken mid-game by a new opponent settlement.
- **Longest Road / Largest Army change hands only on a *strictly greater* value**, and Longest Road can become unheld.
- **One dev card per turn; not the turn it was bought; can be played pre-roll.**
- **VP cards are never "played"**, count continuously, and can win on the same turn they're bought.
- **No gifting** in domestic trades; **dev cards are never tradeable**.
- **Steal yields nothing** if the target has no cards; **no eligible target → no steal**.
- **Cities are upgrades only** (return the settlement piece; never placed on empty vertices).
- **Piece supply caps** (15 roads / 5 settlements / 4 cities) and **finite dev deck** (when empty, no more can be bought).
- **Starting resources come only from the second setup settlement.**
- **Initial player order**: highest 2d6 starts; clockwise; snake-draft setup.

---

## 17. Implementation Guidance

### 17.1 Suggested data model

```text
GameState {
  phase: enum                      // see state machine §8
  players: Player[]                // seating order
  currentPlayerIndex: int
  board: Board
  bank: { lumber, brick, wool, grain, ore }   // start 19 each
  devDeck: DevCard[]               // shuffled; 25 to start
  robberHex: HexId
  dice: { d1, d2 } | null
  longestRoadHolder: PlayerId | null
  largestArmyHolder: PlayerId | null
  winner: PlayerId | null
  setup: { roundDirection, placementsRemaining }
  log: Event[]                     // for undo / replay / networking
}

Board {
  hexes: { id, terrain, numberToken | null }[]   // 19
  vertices: { id, building: { owner, type } | null, port: PortId | null }[]  // 54
  edges: { id, road: { owner } | null }[]         // 72
  ports: { id, type, vertexIds:[2] }[]            // 9
  // precomputed static adjacency (see §3.3)
  hexVertices, hexEdges, vertexHexes, vertexEdges,
  vertexNeighbors, edgeVertices, edgeNeighbors
}

Player {
  id, color
  hand: { lumber, brick, wool, grain, ore }
  devCards: DevCard[]              // includes hidden VP cards; track boughtThisTurn
  knightsPlayed: int
  piecesLeft: { roads, settlements, cities }
  // settlements/cities/roads are stored on the board, not duplicated here
}
```

### 17.2 Core operations to expose (each returns success + new state, or a validation error)

- `getValidSettlementVertices(player)` — empty vertex + distance rule + (road-connected unless setup).
- `getValidCityVertices(player)` — vertices where the player has a settlement.
- `getValidRoadEdges(player)` — empty edge + connected to own network (respecting opponent-blocking vertices).
- `rollDice()` → resolves production or robber.
- `produceResources(roll)` — with bank-limit handling.
- `moveRobber(hex)`, `chooseStealTarget(player)`.
- `discardCards(player, cards)` (gated on 7).
- `buildRoad / buildSettlement / buildCity`.
- `buyDevelopment()`, `playDevelopment(card, args)`.
- `proposeTrade / acceptTrade`, `maritimeTrade(give, getResource)`.
- `recomputeLongestRoad()`, `recomputeLargestArmy()`, `checkVictory()`.

Centralize **all** mutations so resource counts, piece caps, the bank, and achievement holders stay consistent, and so the action log enables undo/replay and (optionally) networked play.

### 17.3 Longest-road computation (sketch)

```text
function longestRoadLength(player, board):
  edges = roads owned by player
  blocked = { vertices with an opponent's building }
  best = 0
  for each edge e in edges:
    for each endpoint v of e (not blocked):
      best = max(best, dfs(v, e, visitedEdges={e}))
  return best

function dfs(v, lastEdge, visitedEdges):
  best = visitedEdges.size
  if v in blocked: return best          // cannot pass through opponent building
  for each edge nx in player's roads incident to v:
    if nx in visitedEdges: continue
    w = other endpoint of nx
    best = max(best, dfs(w, nx, visitedEdges ∪ {nx}))
  return best
```

Run for each affected player; award the card per the transfer rules in §14.1. Graph size is trivial, so DFS is more than fast enough.

### 17.4 Suggested module breakdown
- `geometry/` — board generation, coordinates, adjacency precompute.
- `state/` — `GameState`, reducers, validators, action log.
- `rules/` — production, robber, trading, building, dev cards, scoring.
- `ui/` — board render (SVG/Canvas hexes; vertices and edges as click targets), hand, trade dialog, dev-card panel.
- `ai/` (optional) — bots.

### 17.5 Optional: bot AI notes
A simple but credible bot can: weight expansion vertices by the **pip sum** of adjacent hexes and resource diversity/port access; build settlements/cities greedily by VP-per-resource; play Knights to unblock its own hexes or block opponents' best hexes; pursue Longest Road / Largest Army when within reach. A stronger bot uses a heuristic board-value function plus limited lookahead.

---

## 18. 5–6 Player Extension (brief)

Not required for the base clone, but if you add it later: more hexes/tokens/pieces, two extra colors, and a **Special Build Phase** after each player's normal turn in which every *other* player may build/buy (but not move the robber or play dev cards). The core mechanics above are otherwise unchanged.

---

### Quick reference card

- **Win:** 10 VP on your turn.
- **Costs:** Road = wood+brick · Settlement = wood+brick+wool+grain · City = 3 ore+2 grain · Dev card = ore+wool+grain.
- **7:** discard if >7 cards (lose half), move robber, steal 1.
- **Distance rule:** every neighbor vertex of a settlement must be empty.
- **Longest Road:** ≥5 trail, breaks at opponent buildings, +2 VP.
- **Largest Army:** ≥3 knights, +2 VP.
- **Dev cards:** 1/turn, not the turn bought, VP cards are passive.
- **Board check:** 19 hexes / 54 vertices / 72 edges.
