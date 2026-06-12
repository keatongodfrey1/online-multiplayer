# Splendor Clone — Build Specification (v3)

A complete, build-ready spec for a faithful, **online multiplayer** clone of
**Splendor** (Marc André, Space Cowboys, 2014), where **2–4 players each play from
their own phone, tablet, or laptop** — no pass-and-play, no app install (browser-based).

Hand this file plus `splendor_data.json` (data), `splendor_data.schema.json`
(structural validation), and the `tests/` bundle (data validator + rules oracle +
fuzzer) to a coding agent and it has everything needed.

### Changelog
**v3 — hardening from a fuzz-tested skeptical review.** A reference engine was
implemented from this spec and fuzzed over thousands of games; a JSON-Schema negative
test suite was run. Resulting changes: explicit non-negativity invariants (§19); a
gold-accounting implementation caution (§7); the hard turn cap reframed as **required**
with rationale (§9); server-side forced-pass auto-advance, crypto-random session
tokens, per-room serialized processing, host migration, and join-mid-game/spectator
rules (§13); event-log versioning + pinned-PRNG requirement for replay (§13/§19); a
tightened schema plus the code-level checks it cannot express (§11/§19); and a Client
UI section (§16).

**v2 — data corrections** (verified card-for-card across independent implementations):
(1) 5-point Tier-3 cards cost **7 of one color + 3 of the card's own color**; (2) the
noble set is **perfectly color-symmetric** (each color in exactly 5 nobles). See §18.

---

## Table of contents
1. Objective · 2. Color model · 3. Components & scaling · 4. Setup ·
5. Actions · 6. End-of-turn resolution · 7. Purchase algorithm · 8. Nobles ·
9. Game end / scoring / **stalemate & required turn cap** · 10. **Edge-case catalog** ·
11. Data model & files · 12. **Rules-engine API + pseudocode** ·
13. **Online multiplayer architecture** · 14. **Wire protocol** ·
15. **AI opponents** · 16. **Client UI & accessibility** · 17. **IP / legal** ·
18. Provenance & verification · 19. **Testing & the tests/ bundle** · 20. Residual limitations.

---

## 1. Objective
Each turn a player performs **exactly one** of four actions to gather gem tokens and
buy **development cards**. Cards give a permanent one-color **bonus** (a discount that
also satisfies noble requirements) and **prestige points**. Enough bonuses attract
**nobles** (3 pts each). The game ends at the end of the **round** in which a player
reaches **15 points**. Highest total wins; ties broken by fewest development cards.

## 2. Color model
Internal keys used everywhere in code: `white` (diamond), `blue` (sapphire),
`green` (emerald), `red` (ruby), `black` (onyx), and `gold` (wild joker). `gold` is
never a card bonus and never appears in any card cost; it is only a token and only a
wild during purchase.

## 3. Components and player scaling
- **90 development cards**: tiers **40 / 30 / 20** (Tier 1/2/3); **8 / 6 / 4** per
  color per tier.
- **10 noble tiles**, 3 points each.
- **Tokens** scale with player count; **gold is always 5**:

| Players | each gem color | gold | nobles revealed |
|---|---|---|---|
| 2 | 4 | 5 | 3 |
| 3 | 5 | 5 | 4 |
| 4 | 7 | 5 | 5 |

Nobles revealed = players + 1; remaining nobles removed unseen. **No other rule
differences between player counts** (no special 2-player variant).

## 4. Setup
1. Shuffle each tier deck independently (seeded, pinned PRNG — see §12/§13).
2. Reveal 4 cards from each deck → a 3×4 face-up market.
3. Build the 6 token piles per the table above.
4. Shuffle the 10 nobles; reveal players+1; remove the rest unseen.
5. Pick a starting player; turn order is fixed and clockwise for the game.

**Visibility:** tokens, market, every player's tableau, points, token counts, and
**reserved-card counts** are public. **Reserved-card identities are private to the
owner** (a deck-reserved card must never be revealed to opponents). Deck order is
secret from everyone (and so is the RNG seed — see §13).

## 5. The four actions (choose exactly one)
A player **must** act; voluntarily passing is **not** allowed when any legal action
exists. (For the rare genuine no-legal-action case, see §9/§10.)

**A — Take 3 different gems.** One token each from 3 different gem piles (never gold).
If fewer than 3 colors have tokens, take from all that do (2 or 1). Never duplicate a
color to reach 3. *(Canonical: must take 3 if ≥3 colors are available. An
`allowTakeFewerThanThree` option may relax this; default off.)*

**B — Take 2 of one gem.** Allowed only if that pile has **≥4** tokens **before**
taking. Never gold.

**C — Reserve a card (+1 gold if available).** Reserve one market card **or** the top
of any deck (blind; you may look, opponents may not). Gain 1 gold if any remains
(else none). Legal only if you hold **<3** reserved cards. Reserving a market card
refills that slot from the same deck (if non-empty). Blind-reserving an empty deck is
illegal.

**D — Buy a card.** From the market or your own reserve. Pay the bonus-reduced cost in
gems, gold covering any shortfall (§7). Spent tokens (incl. gold) return to supply.
Place the card in your tableau (gain bonus + points). A bought market card refills
from the same deck (if non-empty); a bought reserved card leaves your reserve.

## 6. End-of-turn resolution (exact order)
1. **Refill market** if a face-up card left (already done inside the action).
2. **Noble visit.** If the player now meets any available noble's requirement, they
   **must** take one (cannot refuse); if several qualify, the player **chooses one**;
   the rest remain. **One noble per turn.** Requirements count **built-card bonuses
   only** (never tokens, never reserved cards); "meets" = ≥ requirement.
3. **Token limit.** If holding **>10 tokens total** (gems+gold), return tokens of the
   player's choice down to exactly 10.
4. **Win trigger.** If total points ≥ 15, set the end flag (game continues — see §9).

> **Why order rarely matters:** a noble visit can occur only on a **buy** turn (only
> buying changes bonuses), and a discard only on a **take/reserve** turn (only those
> add tokens; buying spends them and can't push you over 10). Those are disjoint, so
> steps 2 and 3 never both fire on one turn. A noble's points **do** count toward the
> same turn's win check (resolve step 2 before step 4). Every player always starts a
> turn at ≤10 tokens because step 3 runs every turn.

## 7. Purchase cost algorithm
`cost[c]` = card cost per color; `bonus[c]` = buyer's built cards of color c;
`tok[c]` = buyer's gem tokens; `gold` = buyer's gold.
```
required[c] = max(0, cost[c] - bonus[c])            # bonuses reduce cost first
goldNeeded  = sum( max(0, required[c] - tok[c]) )    # uses CURRENT tok, BEFORE spending
affordable  = goldNeeded <= gold
# pay: spend min(required[c], tok[c]) gems per color, then goldNeeded gold;
#      all spent tokens return to supply
```
> **Implementation caution (tested pitfall).** Compute `goldNeeded` from the token
> counts **before** spending any gems. If you spend gems first and then recompute the
> shortfall, you double-charge gold and silently drive a player's gold **negative** —
> and a sum-only conservation check will *not* catch it (it still sums correctly). Our
> fuzz harness hit exactly this; see §19's non-negativity invariants.

- Bonuses only reduce cost; excess bonus in a color does **not** carry over. If
  `bonus[c] >= cost[c]` for every color, the card costs **0 tokens** — a **free
  purchase** (legal and common late game).
- Gold is a universal wild (one per missing gem); a card may be bought entirely in
  gold. Cards never cost gold.
- **Payment-choice policy:** spend real gems first, gold only for true shortfalls
  (minimize gold). Optionally expose manual gold allocation in the UI; it changes only
  which tokens leave, never legality.
- **Gold accumulation:** up to 5 gold may be held over time (≤1 per reserve). The cap
  is 3 *held reserved cards*, not gold; buying a reserved card frees a slot to reserve
  again.

## 8. Nobles
Requirements are bonus-card vectors — either two colors ×4 or three colors ×3 (data in
`splendor_data.json`). Awarded automatically at end of turn (§6 step 2); not an action;
free; cannot be refused; one per turn; player chooses if multiple qualify. A taken
noble is removed (no replenishment); over a game a player may collect several (one per
turn). A noble can be **sniped** by an opponent before you qualify again.

## 9. Game end, scoring, tiebreak, stalemate
**Trigger:** first time a player ends a turn with **points ≥ 15**.

**Finish the round** (canonical, official): continue until every player has had an
**equal number of turns** — i.e. until the last player in turn order completes their
turn this round. (Some rule summaries say "ends immediately"; the official rule is
round completion. Expose an `endGameMode: "finishRound" | "immediate"` option, default
`finishRound`.)
```
N = players; start = starting seat; lastInRound = (start - 1 + N) % N
loop:
  play turn for seat=current (action + end-of-turn resolution; set endFlag if pts>=15)
  if endFlag and current == lastInRound: break
  current = (current + 1) % N
```
**Winner:** most points (cards + nobles). **Tiebreak:** among the players tied for the
**most** points, the one with the **fewest development cards purchased** wins (built
cards only — nobles and reserved cards do **not** count). If still tied, it is a shared
win (or add a deterministic secondary key if your platform requires a single winner).

### Termination is guaranteed by TWO mechanisms — both required
**The base game has no intrinsic progress guarantee.** A non-improving (or adversarial)
player can cycle tokens forever — take three, discard, take three — and never choose to
buy toward 15, so `endFlag` never sets. In fuzzing, a naive greedy agent left ~5–10% of
**2-player** games still running at **4,000 turns**. Therefore:

1. **Hard turn cap (REQUIRED, not optional).** Cap total turns (a generous value, e.g.
   a few thousand) and end the game when hit, scoring by the normal rules. This is the
   real safety net for a public product where a client could stall or misbehave.
2. **No-legal-move stalemate (rare secondary case).** A position with **no** legal move
   is reachable: in a 4-player game the bank can be fully empty (4×10 = all 40 tokens
   held), decks exhausted, nothing affordable, reserves full → the player can only
   **pass**. Track consecutive forced passes; if **one full round (N turns) are all
   forced passes**, end immediately. (In correct play this is rare, because the bank
   seldom fully drains of gems — which is exactly why mechanism (1) is the one you
   actually rely on.)

## 10. Edge-case catalog (implement & test all)
1. Take-2 threshold checked **before** taking (≥4 present, ≥2 left).
2. Take-3 with scarce supply: take fewer; never duplicate a color (see option in §5).
3. Gold is never taken via A/B — only via reserving (C).
4. Reserve with 0 gold left is still legal (no gold gained).
5. Reserve cap = 3 *held* cards.
6. Blind reserve from an empty deck is illegal; a market slot needs a card present.
7. Refill only from the same tier deck; if empty the slot stays empty for the game.
8. 10-token cap is end-of-turn only, player-chosen discard (may discard the gold or
   gems just gained). Reserving at 10 tokens → 11 → discard 1.
9. Reserved cards never count toward bonuses, nobles, or the tiebreak.
10. One noble/turn, cannot refuse, choose if multiple, can be sniped.
11. Spent tokens (incl. gold) return to supply; re-evaluate the take-2 threshold live.
12. Excess bonus does not transfer across colors.
13. **Free (0-token) purchases** when bonuses ≥ cost everywhere — must be allowed.
14. You cannot dodge the win trigger by declining a noble (mandatory); you *can* choose
    which noble (may affect the tiebreak).
15. **No-legal-action / forced pass** and **stalemate + turn-cap termination** — see §9.
    The server applies forced passes automatically (§13) — it must not wait for input.
16. Buy + noble + win can co-occur in one turn; resolve noble before the win check.
17. Starting-player triggers 15 → all others still get their turn this round.
18. Partial payment is illegal (afford the full reduced cost or you can't buy).
19. Costs never include gold; a card's bonus is always exactly one color.
20. Between turns every player is ≤10 tokens and ≤3 reserved (enforced each turn).
21. **Headless/AI determinism:** the "choose a noble" and "discard down to 10"
    sub-decisions must have deterministic default policies for AI/automated play (§15).
22. **Non-negativity:** no player token count or gold may ever go below 0, and no bank
    pile may exceed its starting count (a frequently-missed corollary of conservation;
    see §7 caution and §19).

## 11. Data model and files
**Files shipped with this spec:**
- `splendor_data.json` — the 90 cards and 10 nobles (single source of truth).
- `splendor_data.schema.json` — JSON Schema (draft 2020-12), **structural validation
  only**.
- `tests/validate_data.py` — the **authoritative data gate**. It enforces what the
  schema *cannot* express: unique ids, the 40/30/20 split, 8/6/4 per-color counts,
  exact point distributions, total prestige = 140, the official example card, the exact
  noble shape (2×4 or 3×3), symmetric noble colors, and a `meta.checksums` cross-check.
  **Run the schema AND `validate_data.py` in CI** — the schema alone is not sufficient.

Card / noble shapes:
```jsonc
{ "id": 1, "tier": 1, "bonus": "black", "points": 0,
  "cost": { "white":1,"blue":1,"green":1,"red":1,"black":0 } }
{ "id": 8, "name": "Henry VIII", "points": 3,
  "requirement": { "white":0,"blue":0,"green":0,"red":4,"black":4 } }
```

**Runtime state (server-authoritative):**
```jsonc
GameState {
  engineVersion, seed, options,        // versioning + determinism + ruleset toggles
  players: [{
    seat, name, kind: "human"|"ai", connected,
    tokens:{white,blue,green,red,black,gold},
    bonuses:{white,blue,green,red,black},   // derived from built; cache
    reserved:[Card...],   // 0..3, PRIVATE
    built:[Card...], nobles:[Noble...], points  // points derived
  }],
  supply:{white,blue,green,red,black,gold},
  decks:{ "1":[Card...], "2":[Card...], "3":[Card...] },  // SECRET, shuffled
  market:{ "1":[Card|null x4], "2":[...], "3":[...] },
  nobles:[Noble...],          // available
  startSeat, currentSeat,
  awaiting:{ seat, inputType:"MOVE"|"DISCARD"|"PICK_NOBLE" },
  endFlag, forcedPassStreak, turnCount, winnerSeat
}
```

## 12. Rules-engine API + pseudocode
Build the engine as a **pure, deterministic, I/O-free module** shared by server and
client. Server = authority; client uses it for instant affordability/legality UI.
**Determinism requires a pinned seeded PRNG and a pinned shuffle algorithm** (e.g. a
named PRNG + Fisher–Yates); store `engineVersion` so replays are reproducible (§13/§19).

```
createGame(playerCount, seed, options) -> State           # seeded, pinned shuffles
legalMoves(State, seat) -> Move[]                          # [] => forced pass
isLegal(State, seat, Move) -> bool
applyMove(State, seat, Move) -> { state, awaiting, events }       # pure
applyResolution(State, seat, Resolution) -> { state, awaiting, events }
redact(State, seat | "spectator") -> RedactedState
isGameOver(State) -> bool ;  ranking(State) -> [{seat, points, cardsBought}]
```
`Move` union: `TAKE_THREE{colors[]}` · `TAKE_TWO{color}` ·
`RESERVE{ from: {market:{tier,index}} | {deck:{tier}} }` ·
`BUY{ from: {market:{tier,index}} | {reserve:{cardId}} }`.
`Resolution` union: `DISCARD{tokens:{color:n}}` · `PICK_NOBLE{nobleId}`.

Pseudocode (validation + application):
```
legalMoves(S, seat):
  if S.awaiting.inputType != "MOVE" or S.awaiting.seat != seat: return []
  moves = []
  colorsAvail = [c for gem c if S.supply[c] > 0]
  if len(colorsAvail) >= 3: moves += every 3-subset of colorsAvail
  elif colorsAvail:         moves += [take all available (1 or 2)]
  for gem c with S.supply[c] >= 4: moves += TAKE_TWO(c)
  if player.reserved.length < 3:
    for each non-null market card: moves += RESERVE(market)
    for tier t with decks[t] non-empty: moves += RESERVE(deck t)
  for each market card and each reserved card k:
    if affordable(player, k): moves += BUY(k)
  return moves   # empty => the server auto-applies a forced pass (see advanceTurn / §13)

applyMove(S, seat, m):       # assert isLegal; else return error
  case TAKE_THREE: move one token of each chosen color supply->player
  case TAKE_TWO:   move two tokens of the color supply->player
  case RESERVE:    take card (market->refill from deck, or pop deck top);
                   add to player.reserved; if supply.gold>0 move 1 gold->player
  case BUY:        compute goldNeeded BEFORE spending (§7); move tokens player->supply;
                   add card to player.built; recompute bonuses/points;
                   if from market: refill slot from same deck
  return endOfTurn(S, seat)

endOfTurn(S, seat):
  qualifying = [n in S.nobles if meetsNoble(player.bonuses, n)]
  if qualifying.length == 1: award(player, qualifying[0])
  elif qualifying.length > 1: return awaiting=PICK_NOBLE(seat)   # ask player/AI
  if player.tokenTotal() > 10: return awaiting=DISCARD(seat)     # ask player/AI
  if player.points >= 15: S.endFlag = true
  return advanceTurn(S, seat)

advanceTurn(S, seat):
  hadMove = (this seat had >=1 legal move this turn)
  S.forcedPassStreak = hadMove ? 0 : S.forcedPassStreak + 1
  S.turnCount += 1
  if S.endFlag and seat == lastInRound: return gameOver(S)     # points win
  if S.forcedPassStreak >= N: return gameOver(S)               # stalemate
  if S.turnCount > TURN_CAP: return gameOver(S)                # REQUIRED backstop (§9)
  S.currentSeat = next seat; return awaiting=MOVE(S.currentSeat)
```
`applyResolution` consumes DISCARD/PICK_NOBLE then re-enters `endOfTurn` where it left
off (after PICK_NOBLE → token-limit check; after DISCARD → win check). Engine is
**pure** ⇒ event sourcing (§13) works.

## 13. Online multiplayer architecture
**Goal:** each player on their own device; no shared screen; no install.
**Shape:** a **browser web app** (works on any phone/tablet/laptop via URL) talking to
an **authoritative server** over **WebSocket**, sharing one pure rules engine.

**Monorepo:**
```
/packages/engine   # pure rules engine + types + data JSON + schema (no I/O)
/packages/server   # WebSocket server: rooms, sessions, persistence, redaction
/apps/web          # React client (responsive; PWA-capable for "add to home screen")
```
Suggested stack: TypeScript everywhere; server on Node with `ws` or Socket.IO; client
React + a small state store; persistence in SQLite/Postgres (or in-memory + periodic
snapshot for a hobby deployment). The engine package is imported by **both** server
(authority) and client (optimistic UI + legal-move highlighting).

**Server responsibilities**
- **Rooms / lobby / seating** (see flow below).
- **Authority:** hold full `GameState`; apply only engine-validated moves; never trust
  client-asserted legality.
- **Per-recipient redaction (critical):** compute a tailored view per seat —
  - *Public to all:* market cards, per-deck remaining counts, available nobles, token
    bank, turn/awaiting info; for every player: built tableau, bonuses, points, token
    counts (per color + gold), **reserved-card count**, nobles.
  - *Private to owner only:* the **identities** of that player's reserved cards.
  - *Never sent to anyone:* opponents' reserved-card identities, deck contents/order,
    or the RNG seed (it would reveal the deck).
- **Serialize per room.** Process each room's messages one at a time (a per-room queue
  or lock). Turn enforcement and `reqId` idempotency are only correct if no two
  messages for a room are handled concurrently.
- **Turn/await enforcement:** maintain `awaiting={seat,inputType}`; reject any
  `MOVE`/`RESOLVE` whose sender ≠ `awaiting.seat` or whose kind ≠ `awaiting.inputType`.
- **Forced pass is server-driven.** When `legalMoves(state, seat)` is empty, the server
  **applies the pass and advances automatically** — it must **not** send
  `AWAITING_INPUT(MOVE)` and wait, because no move can arrive.
- **Disconnect / reconnect / timeout** (see policy).
- **Persistence** via event sourcing.

**Lobby flow**
1. Host opens app → `CREATE_ROOM` → gets a short `roomCode` + shareable link
   (e.g. `https://app/r/ABCD`).
2. Others open the link on their **own device** → `JOIN_ROOM` (enter display name).
3. Lobby shows seats; host can fill empty seats with **AI**, set options (player count
   2–4, turn timeout, AI difficulty, ruleset toggles), and `START_GAME` when 2–4 seats
   are filled. (Solo vs AI is fine: 1 human + AI seats.)
4. On start, the server creates the game with a fresh **secret** seed, assigns seats,
   and sends each client its redacted `GAME_STATE`.

**Sessions & reconnection** (essential on phones, which background/reload tabs)
- On join/create, issue a **cryptographically random, unguessable `sessionToken`**
  (e.g. 128-bit). The `(roomCode, seat)` binding is **server-side state keyed by the
  token**; the token value must **not** be derivable from roomCode/seat (or seats could
  be hijacked).
- `RECONNECT{sessionToken}` re-binds the socket to the seat and re-sends the current
  redacted `GAME_STATE` at the latest `seq`. A disconnected player's seat is reclaimed
  via its token — **not** by a fresh `JOIN_ROOM`.
- Store the token in `localStorage`; offer an explicit "leave / forget this game"
  control that clears it (important on shared devices).

**Joining after start / spectators**
- New arrivals after `START_GAME` become **spectators**: read-only, served
  `redact(state,"spectator")` (public info only — no reserved-card identities). They
  cannot occupy a seat; a seat is reclaimed only via its session token.

**Host migration**
- If the host disconnects, promote the lowest-seat connected human to host so lobby
  controls and configuration don't freeze. If no humans remain, pause and persist.

**Disconnect / timeout policy** (configurable per room)
- On socket drop: mark seat `connected:false`, broadcast `PLAYER_CONNECTION`; keep the
  seat reserved via its session token.
- If it is (or becomes) a disconnected human's turn: start a turn timer (default
  60–120 s). On expiry, **an AI plays one safe move** for that seat (recommended, to
  keep the table moving); the human reclaims the seat on reconnect. (Alternatives:
  auto-pass if legal, or host converts the seat to AI.) The same applies to a pending
  `DISCARD`/`PICK_NOBLE` sub-decision — the deterministic AI policy resolves it.
- If all humans disconnect: pause and persist; resume on return, or expire after a TTL.

**Persistence / replay / crash recovery (event sourcing)**
- Persist `{engineVersion, seed, playerCount, options}` + the **ordered list of applied
  `Move`/`Resolution` events**. State = fold(`applyMove`/`applyResolution`) from the
  initial setup. Snapshot every N events for speed.
- **Replay reproducibility requires a pinned PRNG + shuffle and a matching
  `engineVersion`.** A different PRNG, or a rules change, breaks old logs — so gate
  replay/restore on `engineVersion` and migrate when it changes.

**Security / anti-cheat**
- Server authoritative; validate sender (token→seat) and message schema on every
  message; ignore out-of-turn/wrong-type input.
- Redact hidden info per recipient (never leak reserved-card identities, deck order,
  or seed).
- **Rate-limit per connection**; `reqId` idempotency (ignore duplicate submits /
  double-taps). For public deployments, add **chat moderation/abuse controls** and treat
  session tokens as sensitive.

**Latency / UX**
- Turn-based ⇒ latency-tolerant. Use light optimistic feedback (disable controls on
  submit; show a spinner), but treat the server's `GAME_STATE` as truth and reconcile.
  Drive animations from `MOVE_APPLIED` events.

**Scaling**
- A single Node process holds many tiny in-memory rooms — plenty for friends-play.
- To scale horizontally: route by `roomCode` with sticky sessions, or use a shared
  store + pub/sub (e.g. Socket.IO Redis adapter). (Optional; not needed initially.)

## 14. Wire protocol (concrete messages)
Envelope: client→server messages carry a `reqId`; server→client state messages carry a
monotonic `seq`. JSON over WebSocket.

**Client → Server**
```jsonc
CREATE_ROOM { displayName, settings? }
JOIN_ROOM   { roomCode, displayName }
LEAVE_ROOM  { }
ADD_AI      { seat?, difficulty }      REMOVE_SEAT { seat }
SET_OPTIONS { playerCount?, turnTimeoutSec?, endGameMode?, allowTakeFewerThanThree?, aiDifficulty? }  // host
START_GAME  { }                        // host
MOVE        { reqId, move }            // Move union (§12); only when awaiting MOVE
RESOLVE     { reqId, resolution }      // Resolution union; only when awaiting DISCARD/PICK_NOBLE
RECONNECT   { sessionToken }
CHAT        { text }                   // optional
```
**Server → Client**
```jsonc
ROOM_UPDATE      { room: { code, hostSeat, phase, settings,
                           seats:[{seat,name,kind,connected}] } }
SESSION          { sessionToken, seat }                 // after join/create
GAME_STATE       { you: seat, seq, view: RedactedState } // on start & reconnect (full snapshot)
MOVE_APPLIED     { seq, by: seat, move|resolution, summary } // for log/animation
AWAITING_INPUT   { seat, inputType: "MOVE"|"DISCARD"|"PICK_NOBLE", context?, deadlineTs? }
REJECTED         { reqId, code, message }               // illegal/out-of-turn/dup
GAME_OVER        { ranking:[{seat,points,cardsBought}], winnerSeat }
PLAYER_CONNECTION{ seat, connected }
CHAT             { seat, text }
ERROR            { code, message }
```
Keep it simple: send the **full redacted `RedactedState`** each update (the state is
small). Add deltas later only if needed. `RedactedState` is exactly the §13 "Public to
all" view plus the recipient's own reserved-card identities. Forced passes still emit a
`MOVE_APPLIED` (kind `PASS`) + the next `GAME_STATE`/`AWAITING_INPUT`, with no
`AWAITING_INPUT(MOVE)` for the passed seat.

## 15. AI opponents
Used for single-player, filling empty seats, and disconnect-takeover. AIs use the same
engine interface (`legalMoves` + `applyMove`/`applyResolution`) — they cannot cheat.

- **Easy:** random legal move, lightly weighted (prefer buying an affordable card,
  else take gems).
- **Medium (recommended default):** greedy heuristic scoring each legal move by:
  points gained now; progress toward an affordable point card; progress toward the
  nearest noble (fewest bonus cards still needed); bonus-color diversity; a penalty for
  hoarding tokens near the 10 cap; value of reserving a high-point card you can soon
  afford or that blocks an opponent's noble.
- **Hard (optional):** depth-limited search / MCTS. Note: card draws after buy/reserve
  are **chance nodes** (the next deck card is unknown); cap sampling there to keep the
  tree tractable.
- **Deterministic sub-decision policies** (also used as the default for human timeouts):
  - `DISCARD`: drop the tokens you hold most of and need least for reachable target
    cards; break ties by a fixed color order. Never discard below a color you need.
  - `PICK_NOBLE`: choose the noble that best advances progress toward a *second* noble;
    break ties by lowest `id`. (Deterministic ⇒ reproducible replays.)

`tests/reference_engine.py` ships a working easy/greedy policy and the deterministic
sub-decision policies as a starting point.

## 16. Client UI & accessibility
**Layout.** Three market rows (4 cards each) with per-deck remaining counts; the token
bank; the noble row; and per-player areas showing the tableau **grouped by color** (so
each color's bonus count is legible at a glance), token holdings, reserved-card backs
(face shown only to the owner), and the point total. Highlight, for the current player,
which market/reserved cards are **affordable right now** (and which are affordable with
gold). Give the **discard-to-10** and **choose-a-noble** sub-decisions explicit,
unambiguous interactive steps. Show whose turn it is and a connection indicator per
seat. On phones, prefer a vertical layout with the active player's controls in reach.

**Accessibility (hard requirements).**
- **Color independence (mandatory):** the five gems include the red/green pair — the
  classic colorblind confusion. Each gem MUST carry a **distinct shape/icon + text
  label**, not color alone; offer a colorblind palette toggle and optional patterns on
  tokens/cards. Affordability/turn cues must not rely on color alone.
- **Screen reader:** semantic ARIA. Each card announces e.g. "Tier 1, emerald bonus,
  0 points, cost 1 sapphire 1 ruby 1 onyx." Announce turn changes and awaited inputs
  via an ARIA live region. Label all controls.
- **Motor / touch:** ≥44 px touch targets; full keyboard navigation with visible focus;
  respect `prefers-reduced-motion`.
- **Text / layout:** scalable text; responsive from phone-portrait to desktop; never
  encode information in color or position alone.

## 17. IP / legal
Game **mechanics and rules are not copyrightable**, but the specific **expression** is.
The name **"Splendor,"** the box/card **art**, and the noble **portraits** (and the
historical-noble theming as trade dress/trademark) are protected by Space
Cowboys/Asmodee. The gem/cost/point **numbers** in the data are facts/mechanics and are
safe to use.

- **Public or commercial deployment:** use **original art** and a **different name**;
  **remove or replace the noble `name` fields** (they are flavor only and have no
  mechanical effect); do not copy card iconography.
- **Private play among friends:** lower risk, but still don't redistribute the
  publisher's assets.
- This is not legal advice; get counsel before any commercial release.

## 18. Provenance & verification
- **Rules** cross-checked against the official rulebook text (UltraBoardGames,
  64 Ounce Games, Dized, RulesPal) and Wikipedia ("Splendor (game)"): end-of-turn order,
  **round completion**, noble/joker rules, 10-token cap, replenishment.
- **90 development cards: verified card-for-card across two independent implementations**
  (a Rust minimax engine and a TypeScript clone) — exact multiset match. A third source
  (a Python/Flask implementation) had localized **Tier-2 errors** and was *not*
  followed. The official rulebook's worked example card (Tier-3 blue, 4 pts, 6 white +
  3 blue + 3 black) and the published "average Tier-3 card = 4 points" both match.
- **Nobles:** the one contested 4+4 tile (**black with red**, not green) was resolved by
  agreement of two independent sources and by design symmetry — the corrected set has
  **each color in exactly 5 nobles**, matching the perfectly symmetric 3+3+3 subset both
  sources share.
- **Honest caveat on independence.** The two agreeing card sources may share a common
  ancestor transcription; the only fully independent anchors are the official example
  card and the published Tier-3 average. The high-signal cards and all of Tiers 1 & 3
  are corroborated; for absolute parity with a specific retail printing, spot-check a
  few Tier-2 cards against physical cards.

## 19. Testing & the tests/ bundle
**Engine invariants — assert after every applied move:**
- Token conservation per color: `supply[c] + Σ players.tokens[c] == startCount[c]`;
  `supply.gold + Σ players.gold == 5`.
- **Non-negativity (do not skip):** no player token/gold < 0; every bank pile within
  `[0, startCount]`. Conservation sums alone are a *leaky* check — they pass even when
  balances go negative (we hit exactly this in testing; see §7).
- Each player: `reserved.length ≤ 3`; tokens total ≤ 10 between turns;
  `points == Σ built.points + 3·|nobles|`.
- Card conservation: decks + market + reserved + built == 90.
- Noble conservation: available + Σ players.nobles == players + 1; a taken noble is
  gone from `state.nobles`.
- Each market tier has 4 slots; a `null` slot implies that deck is exhausted.
- **Determinism:** same `(engineVersion, seed, options, move list)` ⇒ identical state.
- **Event replay:** folding the persisted event log equals the live state.
- **Redaction safety (security test):** `redact(state, seatX)` contains **no** opponent
  reserved-card identities, no deck contents, and no seed.
- **Termination:** every game ends — by points, by stalemate, or by the **required**
  turn cap (§9). Assert no game exceeds the cap silently.

**Property-based / fuzz testing (strongly recommended).** Play thousands of random and
greedy games to completion, asserting every invariant on every step and that every game
terminates. This is the cheapest way to catch accounting and end-condition bugs.

**The `tests/` bundle (Python) ships with this spec** and should run in CI:
- `validate_data.py` — authoritative data gate (the checks the schema can't express);
  **run it in addition to the JSON Schema**.
- `schema_tests.py` — schema regression guarantees.
- `reference_engine.py` — rules oracle with the full invariants above.
- `fuzz.py` — the fuzz harness (it already caught a real gold-accounting bug).

**Reference-oracle cross-check (optional, powerful).** To diff the production engine
against `reference_engine.py` on identical `(seed, moves)`, both must pin the **same**
seeded PRNG + shuffle (§12/§13); otherwise card order differs even when both are
correct. Without that, use the oracle as a *rules* reference, not a byte-for-byte match.

## 20. Residual limitations
- Tier-2 fidelity rests on two-source agreement that may share ancestry, not
  physical-card photography (§18).
- Three-way+ exact ties are undefined by base rules (shared win unless you add a key).
- Expansions (Cities of Splendor, Orient, Strongholds, Trading Posts) are **out of
  scope**; the *Cities* variant changes the victory condition, so do not blend it in.
- The `endGameMode: "immediate"` and `allowTakeFewerThanThree` options exist for parity
  with looser rule readings; the defaults match the official rulebook.
- The reference engine is a *rules* oracle in Python; exact RNG parity with a TS build
  requires porting/pinning the same PRNG (§12/§19).
