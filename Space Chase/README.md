# Space Chase

A space-themed digital board game — like Chutes & Ladders, but with traversable **portals**,
a 41-card strategy **deck**, and 2–5 colorful rocket players. On each turn you choose to **Roll
the Dice** (safe) or **Draw a Card** (a gamble). First rocket to the Finish wins.

Built as a family game (a parent + son project). Plays primarily **2-player**.

---

## How to play it in a browser

1. Open the **`Space Chase`** folder.
2. **Double-click `index.html`** — it opens in your default browser. No internet, no install.
3. Pick the number of players, name them, hit **Launch!**
4. If you edit any file while it's open, press **Cmd+R** (Mac) or **Ctrl+R** (Windows) to reload.

That's it — the whole game runs locally from the file.

---

## ⚠️ Hard technical constraints (read before rebuilding)

These are not preferences — breaking them breaks the "double-click to play" experience that the
whole project depends on.

| Rule | Why it matters |
|------|----------------|
| **Vanilla HTML + CSS + JavaScript only.** No React/Vue/Svelte, no bundler, no build step, no server. | The owner is non-technical and just double-clicks a file. A build tool would require Node, a terminal, and a dev server. |
| **Plain `<script src="...">` tags using global functions/variables — NOT ES modules.** Do **not** add `type="module"`. | ES modules are blocked by browser CORS rules on `file://`, producing a **blank page** when double-clicked. The current code shares globals across files on purpose. |
| **Must run from `file://`** (double-click), with no local server. | Same reason — zero setup for the player. |
| **Script load order is significant:** `board.js → cards.js → ui.js → game.js`. | Later files use globals (`TOTAL_SPACES`, `PORTALS`, `GameState`, UI helpers) defined in earlier ones. |

---

## File map

```
Space Chase/
├── index.html                 ← the page; double-click to play. Defines all DOM element IDs.
├── style.css                  ← ALL styling (note: at the root, not in a css/ folder)
├── Card_Filename_Reference.md ← card → image-filename table (see note below)
├── js/
│   ├── board.js   ← board layout, landmarks, portal geometry + SVG, star field, constants
│   ├── cards.js   ← 41 card definitions, deck (shuffle/draw/reshuffle), card-effect resolution
│   ├── ui.js      ← DOM rendering, rockets, modals, dice/teleport/confetti animations
│   └── game.js    ← game state, turn flow, movement, portals, collisions, win/tie, setup
└── space_chase_cards/         ← 42 PNGs (41 card fronts + 1 card back)
```

The four JS files are **loaded in order** at the bottom of `index.html` and communicate through
**global** functions and variables (no modules/imports).

---

## Asset manifest

All art lives in **`space_chase_cards/`** and is referenced from code with that exact relative
path (e.g. `space_chase_cards/the_moon.png`).

- **41 card fronts** — see the full filename table in
  [`Card_Filename_Reference.md`](./Card_Filename_Reference.md).
- **1 card back** — `space_chase_back.png` (used for the face-down draw pile button).
- The board is **drawn entirely in code** (CSS grid + SVG portal curves + CSS-gradient starfield)
  — **there is no board background image** to source or recreate.
- The on-screen **die is rendered with Unicode glyphs** (`⚀ ⚁ ⚂ ⚃ ⚄ ⚅`), animated in JS — it is
  **not** an image. The file `space_dice.png` is **only the art for the "Space Dice" card (#25)**,
  not a die graphic.

> **Note on `Card_Filename_Reference.md`:** its intro text says to put images in `images/cards/`
> and name the back `card_back.png`. That is **outdated.** The shipped game uses the folder
> **`space_chase_cards/`** and back file **`space_chase_back.png`**. The filename table itself is
> correct. Trust the table + this manifest over the intro text.

> **Rebuilding in a fresh folder?** Copy the entire `space_chase_cards/` folder over first. Broken
> image paths are the single most common way a rebuild "looks broken."

---

## Documentation set

Read in this order to rebuild or modify the game:

1. **[GAME_RULES.md](./GAME_RULES.md)** — the complete, corrected rulebook (board, portals,
   all 41 cards, win/tie, collisions). The "what."
2. **[MECHANICS_AND_RULINGS.md](./MECHANICS_AND_RULINGS.md)** — every hard-won edge case and
   exact ruling we discovered in play. The "what, precisely, in the corner cases."
3. **[ARCHITECTURE.md](./ARCHITECTURE.md)** — data model, turn state machine, key functions,
   algorithms, the DOM-ID contract, the visual spec, and known issues. The "how."
4. **[BUILD_GUIDE.md](./BUILD_GUIDE.md)** — a paste-ready kickoff brief + step-by-step build
   order with gotchas, plus an acceptance-test checklist. The "in what order, and how to verify."

---

## Out of scope / future ideas (intentionally not built)

These never shipped; note them so they aren't mistaken for bugs:

- **Phone / portrait layout.** Current layout targets desktop/tablet landscape (board sized to
  viewport height, fixed-width sidebar). It is cramped/overflowing on a narrow phone.
- **Save / resume.** Refreshing the browser ends the game.
- **Choosing or randomizing who goes first.** Player 1 always starts.
- **Sound effects / music.**
