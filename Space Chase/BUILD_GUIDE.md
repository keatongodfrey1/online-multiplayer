# Space Chase — Build Guide

Rebuild the game from scratch with minimal back-and-forth. Two parts: a **paste-ready kickoff
brief** to start a fresh session, then a **step-by-step order with gotchas** and an
**acceptance-test checklist**.

---

## Part A — Paste-ready kickoff brief

> Copy everything in this block into a fresh coding session to start the rebuild.

```
Build me a web board game called "Space Chase" — vanilla HTML/CSS/JavaScript only.

HARD CONSTRAINTS (do not break):
- No frameworks, no bundler, no build step, no server.
- Plain <script src> tags using global functions/vars — NOT ES modules (no type="module").
  It must run by double-clicking index.html from file:// with a blank-page-free load.
- Load order: js/board.js, js/cards.js, js/ui.js, js/game.js.
- Card art already exists in ./space_chase_cards/ (41 fronts + space_chase_back.png).
  Keep that folder; reference images as space_chase_cards/<name>.png.

This repo already contains the full spec. Read these first and implement to them exactly:
- README.md                  (overview, how to run, tech constraints, asset manifest)
- GAME_RULES.md              (board, START, portals, all 41 cards, win/tie, collisions)
- MECHANICS_AND_RULINGS.md   (every edge case + the corrected rules to implement)
- ARCHITECTURE.md            (data model, turn state machine, algorithms, DOM-ID contract,
                              visual spec, and the "Known issues to fix" list)

Implement the CORRECTED behavior described in those docs (notably: Shield = 3 full table
go-arounds; Space Suit doubles "everyone" cards for the wearer only; landing on a portal mouth
by ANY means/direction enters the portal). It's a family game played mostly 2-player — make sure
2-player works perfectly.

Build in the order in BUILD_GUIDE.md Part B, and verify each step before moving on.
```

---

## Part B — Build order (with ⚠️ gotchas)

Each step ends with a quick check. Don't advance until it passes.

**0. Skeleton & constraints.** Create `index.html` linking `style.css` (at root) and the four
`js/` files in order. ⚠️ Plain `<script src>` only — no `type="module"`.
*Check:* double-click `index.html`; page loads with no console errors.

**1. Board + START + theme.** In `board.js`: `TOTAL_SPACES=68`, `COLS=10`, `ROWS=7`; snake-grid
layout; render spaces 1–67 + Finish; the starfield; and the full-width **START** bar below the
board. ⚠️ START is **position 0**, distinct from Space 1.
*Check:* 67 numbered tiles + Finish in a snake; START bar spans the board's width beneath it.

**2. Portals (visual).** Define `PORTALS` (4↔36/7, 28↔61/3, 39↔51/3); draw glowing dashed Bézier
curves with internal-space dots; store `portalPaths[]`; implement `getPortalPixelPosition`.
*Check:* three labeled, glowing tunnels connect the right spaces; dots sit along each curve.

**3. Landmarks.** Style + label spaces 20/33/46/50/52/58/64 distinctly.
*Check:* all seven look special and show their names.

**4. Players & rockets.** 2–5 players, `PLAYER_COLORS`, name entry; rockets = colored circle +
initial + 🚀; `positionAllRockets` handles board / START / inside-portal, with the fan-out offsets.
⚠️ Lead your testing with **2 players**.
*Check:* 2–5 distinguishable rockets all start on the START bar.

**5. Turn system.** `startTurn → onRollDice|onDrawCard → … → afterAction → checkWin → nextTurn`;
Roll-or-Draw buttons; extra-turn loop; lost-turn skip. Add `GameState.roundNumber` (+1 on wrap).
*Check:* turns alternate; buttons enable/disable correctly.

**6. Dice & basic movement.** `animateDice` (Unicode glyphs); `movePlayerBy` with START handling
(0→1 on first move; clamp back to 0, never below). ⚠️ "Back to Start" = 0, not 1.
*Check:* rolling moves the rocket forward step-by-step; a big backward effect lands on START.

**7. Deck.** 41 `CARD_DEFS` + **a second copy of #30** (42 total); Fisher-Yates shuffle on every
game; draw; reshuffle when empty; show card art in the modal. ⚠️ Deck is **42, not 41**; reshuffle
fresh on Play Again. ⚠️ Verify every `image` path resolves against `space_chase_cards/`.
*Check:* draw shows the correct art; count counts down; reshuffles after the pile empties.

**8. Portal traversal.** `enterPortal` / `moveInPortal`; exit costs one move; overflow continues;
backward exit; `justExitedPortal` guard. ⚠️ Centralize "landed on a mouth → enter" so it fires for
**dice, move-all (both directions), teleport, and attack-teleport**.
*Check:* the §"Worked example" (51 + 7 → 42) is exact; entering from both ends works.

**9. All card effects.** Implement `resolveCard` + `resolveAttack` + helpers to the
**corrected** rules: Shield = 3 go-arounds; Space Suit doubles "everyone" cards for wearer only
and is consumed by the next card regardless; Time Loop replays the player's own last action and
never records itself; Fighter-Jet shield blocks the whole attack; Space Kraken exact target
counts; 6-7 per-player count → Space 67 on 2nd; attack self-targeting matrix; Satellite reorder +
View Board; Black Hole / Worm Hole / Rocket. ⚠️ Time Loop must **not** overwrite `lastAction` with
itself (infinite loop).
*Check:* spot-test one card per category; see acceptance matrix below.

**10. Collisions, win & tie.** `checkCollisions` (2+ on a space → all to START; START/portal
exempt; runs after movement). `checkWin`: one finisher wins; multiple finishers →
`startTiebreaker`/`resolveTiebreaker` (highest roll, re-roll on tie). Win screen + confetti +
Play Again. End Game button → reset.
*Check:* collision (incl. Black-Hole-induced) sends both to START; a tie triggers a roll-off; the
winner screen shows and Play Again reshuffles.

**11. Polish.** Animation timings (see ARCHITECTURE §5), hover states, resize handler (⚠️ remove
the old listener before adding a new one), scrollbars.
*Check:* resizing the window keeps portals and rockets aligned; no duplicate handlers after
several games.

---

## Part C — Acceptance-test checklist (lead with 2-player)

Run these manually in the browser before calling it done.

**Core (2-player):**
- [ ] New game starts with both rockets on START; deck shows a fresh shuffled count.
- [ ] Roll moves forward step-by-step; Draw shows art then applies the effect.
- [ ] Turn passes correctly; extra-turn cards let the same player go again; lost-turn cards skip.

**Portals (test each, both directions):**
- [ ] Land on 4 → travel 7 internal + exit → arrive 36 (overflow continues forward).
- [ ] Land on 36 → travel back through → arrive 4.
- [ ] 28↔61 and 39↔51 both work; the **51 + 7 → 42** example is exact.
- [ ] A rocket sitting *on* a mouth that's then hit by a move-all/teleport **enters** the portal.

**Cards (corrected behavior):**
- [ ] **Shield**: play it, then survive **3 full go-arounds** of attacks (unlimited blocks),
      and confirm it expires after the 3rd round — not after 3 hits.
- [ ] **Space Suit + The Moon** → you move 10. **Space Suit + Cosmic Chaos** → **you** move 14,
      the other player moves 7. Space Suit + Shield → suit wasted, shield still 3 rounds.
- [ ] **Time Loop** after a roll repeats that distance; after a card repeats that card; drawing
      Time Loop twice does **not** loop forever; replays your own action, not the opponent's.
- [ ] **Fighter Jet** on a shielded target: nobody moves. On an unshielded target: target −3,
      you +3.
- [ ] **6-7** first draw sends someone to 6/7; the same player's second 6-7 sends **them to 67**.
- [ ] **Nuclear Bomb / Time Bomb** land the target on **START**, not Space 1.
- [ ] **Satellite**: peek 5, reorder by clicking, "View Board" works, confirmed order is drawn.
- [ ] Attack cards let you pick **yourself**; Black Hole & Worm Hole do **not**.

**Collisions / win:**
- [ ] Two rockets forced onto one space → **both** to START. Black Hole onto an occupied space →
      both to START.
- [ ] **Cosmic Chaos** pushing two players past Finish together → **dice roll-off**.
- [ ] Single finisher → win screen + confetti; **Play Again** returns to setup with a fresh shuffle.
- [ ] **End Game** button mid-game returns to setup.

**Scale & robustness:**
- [ ] Repeat key flows with 3–5 players (rockets fan out and stay distinguishable).
- [ ] Draw through all 42 cards → deck reshuffles and play continues.
- [ ] Resize the window repeatedly → portals/rockets stay aligned; no errors.
