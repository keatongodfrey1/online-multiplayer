# Space Chase — Architecture

How the game is built. Pair this with **[GAME_RULES.md](./GAME_RULES.md)** (what it does) and
**[MECHANICS_AND_RULINGS.md](./MECHANICS_AND_RULINGS.md)** (corner cases). Tech constraints
(vanilla, plain scripts, `file://`, load order) are in **[README.md](./README.md)** — they are
non-negotiable.

---

## 1. File responsibilities

Loaded in this order (globals shared across files; no modules):

| File | Owns |
|------|------|
| `js/board.js` | Constants (`TOTAL_SPACES`, `COLS`, `ROWS`, `LANDMARKS`, `PORTALS`); board-layout generation (snake grid); rendering spaces, landmarks, Finish, START; **portal SVG curves + `portalPaths[]` + `getPortalPixelPosition`**; star field; geometry helpers. |
| `js/cards.js` | `CARD_DEFS` (41 cards); deck build/shuffle/draw/reshuffle; **all card-effect resolution** (`resolveCard`, `resolveAttack`, and the special-card helpers). |
| `js/ui.js` | All DOM rendering & animation: player panel, rockets + positioning, movement/portal/teleport/dice/confetti animations, every modal (card, target, multi-target, choice, space-select, satellite), win screen, log/message helpers. |
| `js/game.js` | `GameState` + player objects; setup; **turn state machine**; movement (`movePlayerBy`, `moveInPortal`, `enterPortal`, `teleportPlayer`, move-all helpers); collisions; win/tie; resize handler; reset. Entry point (`DOMContentLoaded → initSetup`). |

---

## 2. State model

```js
const PLAYER_COLORS = ['#ff4444','#4488ff','#44dd44','#ffdd00','#cc44ff']; // P1..P5

const GameState = {
  players: [],            // player objects (below)
  currentPlayerIndex: 0,
  phase: 'setup',         // 'setup' | 'playing' | 'tiebreaker' | 'gameover'
  // ADD for corrected Shield:
  roundNumber: 0          // +1 each time turn order wraps last→first player
};
```

Player object (created in `startGame`):

```js
{
  id,                 // 0..4
  name,               // entered name or "Player N"
  color,              // PLAYER_COLORS[id]
  position,           // 0 = START, 1..67 board, 68 = Finish
  portal,             // null, or { portalDef, progress, totalInternal, exitSpace, entrySpace, forward }
  justExitedPortal,   // false, or the space # just exited (re-entry guard)
  lostTurns,          // skip this many upcoming turns
  spaceSuit,          // bool: next card doubled
  extraTurns,         // take this many more turns
  sixSevenCount,      // per-player count of 6-7 cards drawn
  lastAction,         // { type:'dice', result } | { type:'card', cardId } — for Time Loop
  // REPLACE shieldTurns (3-hit counter) WITH round-based shield:
  shieldExpiresRound  // active while GameState.roundNumber < this
}
```

> The shipped code currently has `shieldTurns` (a 3-hit counter) and no `roundNumber`. The
> round-based shield (§"Known issues") is the intended model.

---

## 3. Turn state machine

```
startTurn()
  • clear justExitedPortal; refresh panel
  • if lostTurns>0 → decrement, log skip, setTimeout(nextTurn, 1200ms), return
  • show "X's turn — Roll or Draw?" (+ portal progress if inside one)
  • enableActions(true)            // wires Roll/Draw onclick

onRollDice()                       onDrawCard()
  • enableActions(false)             • enableActions(false)
  • result = 1..6                    • card = drawCard(); updateDeckCount()
  • if spaceSuit → result*2          • if card != timeLoop: lastAction = {card}
  • lastAction = {dice, result}      • showCardModal(card, → resolveCard → afterAction)
  • animateDice → movePlayerBy
        → afterAction

afterAction(player)
  • if entered/within a portal → updatePanel, checkWin (skip collision; portal occupants exempt)
  • else if landed on a portal mouth (and not justExitedPortal) → enterPortal → checkWin
  • else → checkCollisions(→ checkWin)

checkWin(player)
  • finishers = players with position ≥ 68
  • >1 finisher → phase='tiebreaker'; startTiebreaker(finishers)
  • ==1 finisher → phase='gameover'; showWinScreen
  • else → nextTurn()

nextTurn()
  • if current.extraTurns>0 → decrement, setTimeout(startTurn, 600ms)   // same player
  • else → currentPlayerIndex = (i+1) % n;  [+1 roundNumber when wrapping to 0];  setTimeout(startTurn, 400ms)
```

`enableActions(enabled)` toggles both buttons' `disabled` and their `onclick`, and arms the 30s
safety re-enable timer when disabling (see Known issues).

---

## 4. Key algorithms

**Snake (boustrophedon) grid** — `board.js / generateBoardLayout`:
```
rowFromBottom = floor(i/COLS); colInRow = i%COLS
col = (rowFromBottom even) ? colInRow : (COLS-1-colInRow)
row = (ROWS-1) - rowFromBottom         // CSS grid is 1-indexed → use col+1,row+1
```

**Deck** — `cards.js`: `initDeck` = ids of all 41 cards **plus a second `30`** (42 total), then
Fisher-Yates `shuffleDeck`. `drawCard` pops the tail; when empty, `deck = [...discardPile]`,
clear discard, reshuffle. Fresh shuffle happens every `startGame`.

**Fisher-Yates:**
```js
for (let i = deck.length-1; i>0; i--){ const j = Math.floor(Math.random()*(i+1)); [deck[i],deck[j]]=[deck[j],deck[i]]; }
```

**Portal traversal** — `game.js / moveInPortal` (see MECHANICS §1 for the rules). Exit costs one
move: forward overflow = `newProgress - totalInternal - 1`; backward overflow = `newProgress + 1`.
On exit, set `position = exit/entry space`, `portal = null`, `justExitedPortal = that space`, then
recurse `movePlayerBy(overflow)` if nonzero.

**Bézier rocket placement** — `board.js`: each portal is a quadratic curve `M a Q c b`, with
control point `c` offset 60px perpendicular to the a→b midpoint. `portalPaths[i] =
{ax,ay,bx,by,cx,cy}` is stored at render time. `getPortalPixelPosition(i, t, forward)` returns the
point at parameter `t = progress/totalInternal` (flipping to `1-t` when `!forward`).

**Collisions** — `game.js / checkCollisions`: bucket players by `position` excluding `position<=0`,
`position>=68`, and `portal!=null`; any bucket with ≥2 → send all to START (animated), then
continue. Runs after movement, before win check.

**Round counter (for Shield)** — increment `GameState.roundNumber` in `nextTurn` exactly when
`currentPlayerIndex` wraps from the last player back to 0.

**Animation pattern** — everything is **callback-chained** (no async/await): each animator
(`animateMovement` 150ms/step, `animatePortalMove` 200ms/step, `animateTeleport` 400ms flash,
`animateDice` ~80ms×12 then 700ms settle) calls a `callback` when done; turn logic threads
`afterAction` through as the final callback. Preserve this style so flows stay sequential.

**Resize handling** — store the handler on `window._spaceChaseResizeHandler`, **remove the old one
before adding a new one** (prevents listener stacking across games); on resize it re-runs
`renderPortals()` + `positionAllRockets()` (both recompute from live element rects).

---

## 5. Constants & timings (preserve for matching "feel")

| Constant | Value | Where |
|----------|-------|-------|
| `TOTAL_SPACES` | 68 | board.js |
| `COLS` × `ROWS` | 10 × 7 | board.js |
| `PORTALS` | `[{a:4,b:36,internal:7,color:'#ff44ff'},{a:28,b:61,internal:3,color:'#44ffff'},{a:39,b:51,internal:3,color:'#ffaa00'}]` | board.js |
| `LANDMARKS` | 20,33,46,50,52,58,64 (see GAME_RULES) | board.js |
| `PLAYER_COLORS` | red/blue/green/yellow/purple | game.js |
| Deck size | 42 (41 + second 6-7) | cards.js |
| Star count | 200 | board.js |
| Confetti count | 60 | ui.js |
| Move step | 150 ms / space | ui.js |
| Portal step | 200 ms / internal space | ui.js |
| Teleport flash | 400 ms | ui.js |
| Dice spin | ~80 ms × 12, then 700 ms settle | ui.js |
| Next-player delay | 400 ms | game.js |
| Extra-turn delay | 600 ms | game.js |
| Lost-turn skip pause | 1200 ms | game.js |
| Tiebreaker pacing | 1000 ms start, 800 ms between rolls | game.js |
| Action safety timeout | 30000 ms | game.js |

---

## 6. DOM-ID contract (index.html ↔ ui.js/game.js)

A regenerated `index.html` **must keep these IDs** or the JS silently breaks.

- **Setup:** `#setup-screen`, `.player-count-btn[data-count]`, `#player-names`, `#start-game`.
- **Game shell:** `#game-screen`, `#board-container`, `#board`, `#portal-overlay` (SVG),
  `#sidebar`, `#stars-bg`. (`#start-space` is created by JS inside `#board-container`.)
- **Sidebar:** `#player-status-panel`, `#action-panel`, `#current-player-info`, `#roll-dice-btn`,
  `#draw-card-btn` (contains `img.card-back-mini`), `#dice-display`, `#message-area`,
  `#deck-count`, `#turn-log`, `#end-game-btn`.
- **Modals:** `#modal-overlay`; card `#card-modal` (`#card-image`,`#card-name`,`#card-desc`,
  `#card-actions`); target `#target-modal` (`#target-prompt`,`#target-buttons`); choice
  `#choice-modal` (`#choice-title`,`#choice-prompt`,`#choice-buttons`); space-select
  `#space-select-modal` (`#space-select-prompt`,`#space-select-input` min=1 max=67,
  `#space-select-ok`); satellite `#satellite-modal` (`#satellite-cards`, `#satellite-reset`,
  `#satellite-view-board`, `#satellite-ok`) + floating `#satellite-return-btn`.
- **Win:** `#win-screen` (`#confetti-container`, `#win-player-name`, `#play-again`).

Rocket elements are created at runtime as `#rocket-<playerId>`; spaces as `#space-<n>`.

---

## 7. Visual spec (match the current look)

**Fonts** (Google Fonts import at top of `style.css`): **Orbitron** (400/700/900) for
titles/numbers/labels; **Exo 2** (300/400/600) for body/inputs.

**Palette / background:** body `linear-gradient(135deg,#0a0a2e,#000010,#0a0a2e)`; board face is
layered radial nebula glows (purple `rgba(60,20,100,.3)`, blue `rgba(20,40,100,.3)`) over
`rgba(10,10,30,.6)`, rounded 16px, 2px border `rgba(100,100,200,.2)`. Star field = 200 absolutely
positioned white dots, 1–3px, `twinkle` 3s alternate. Title uses a 4-color gradient text clip
(`#ff44ff,#44ffff,#ffaa00,#44ff44`).

**Board sizing (responsive, landscape):** `#board` is `width:height: calc(100vh - 150px)` capped
`max-width:70vw`, 10×7 grid, 4px gap, 8px padding. Sidebar `flex:1`, `min 260 / max 340px`,
scrolls. `#game-screen` is a flex row, `height:100vh`, `overflow:hidden`.

**Spaces:** translucent white tiles, 8px radius; number in Orbitron `clamp(.55rem,1.2vw,.85rem)`.
- **Landmark** (`.space-landmark`): warm gold gradient + glow; label `#ffdd88`,
  `clamp(.35rem,.7vw,.55rem)`.
- **Finish** (`.space-finish`): gold gradient, gold glow, 🌟 glyph + "FINISH" label `#ffd700`.
- **Portal end** (`.space-portal`): border + glow in the portal's `--portal-color`.

**Portals (SVG):** dashed (`8 4`) curved `path` in the portal color, `stroke-width 3`, opacity .6,
Gaussian-blur glow filter, animated dash (`portalDash` 2s linear). Internal spaces drawn as
4px blurred circles along the curve.

**START bar:** `#start-space`, absolutely positioned full-width **below the board**
(`bottom:-52px; left/right:0; height:44px`), green gradient + glow, 🚀 + "START" (Orbitron, green,
letter-spacing 3px).

**Rockets:** 30px circle, `background:` player color, 2px white border, colored glow; 🚀 emoji at
the top-right corner + the player's **initial** centered (Orbitron 900, white). Multiple rockets
on one location fan out via offset array `[(0,0),(12,-8),(-12,-8),(12,8),(-12,8)]`. Teleport =
`teleportFlash` (scale-up fade) 0.4s.

**Dice:** big Unicode glyph in `#dice-display` (`font-size:4rem`, gold text-shadow); `dice-landed`
pop animation on settle.

**Cards:** modal art `#card-image` width **220px**, magenta glow; name Orbitron `#ffdd88`. Draw
button shows `card-back-mini` (48px). Satellite cards show 140px art with a green "1st/2nd…" badge
when picked.

**Win screen:** full-screen dark overlay, "🏆 WINNER 🏆", winner name 3rem in their color, 60-piece
`confettiFall` animation, "Play Again".

**Action buttons:** Roll (hover → amber glow, dice shake) and Draw (hover → magenta glow); disabled
at 0.25 opacity.

---

## 8. Known issues to fix on rebuild

Consolidated from MECHANICS_AND_RULINGS. Implement the **intended** behavior:

1. **Shield = 3 hits → 3 rounds.** Replace the `shieldTurns--`-per-hit counter with the
   `GameState.roundNumber` / `player.shieldExpiresRound` model (MECHANICS §4).
2. **Space Suit over-doubles "everyone" cards.** `moveAll`/`moveAllBack` currently double for all;
   double **only the suit-wearer's** move (MECHANICS §5).
3. **Portal landing is inconsistent.** Teleport-attacks and backward move-all don't pull a victim
   into a portal mouth. Centralize "landed on a mouth → enter, from either direction, by any
   means" (MECHANICS §1).
4. **30s safety timer can re-enable buttons mid-modal.** Drive re-enabling off real action
   completion; pause/remove the blind timeout while a modal is open (MECHANICS §10).
5. *(Optional polish)* **Satellite with 0 cards** shows an empty peek — force a reshuffle first.
