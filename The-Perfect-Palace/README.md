# The Perfect Palace

A multiplayer, Monopoly-style web board game. Designed by a father and daughter.

## 🎮 Running the game

```bash
bun install        # one-time
bun run dev        # dev server at http://localhost:5173
bun run build      # production build
bun run typecheck  # TypeScript check only
bun run test       # run the full test suite (once)
bun run test:watch # tests on save
bun run check      # typecheck + test + build (pre-commit smoke test)
```

(`npm` / `pnpm` would also work; this project uses [Bun](https://bun.sh) by default.)

## 📖 Documentation

| File | Purpose |
|---|---|
| [`DESIGN.md`](./DESIGN.md) | The source of truth for every rule, edge case, and product decision. |
| [`CHANGELOG.md`](./CHANGELOG.md) | Phase-by-phase history (what shipped in each commit cluster). |
| [`RESUME.md`](./RESUME.md) | How to pick up in a fresh Claude Code session with full context. |
| [`REMOTE_SETUP.md`](./REMOTE_SETUP.md) | Copy-paste steps for pushing to GitHub / any git remote. |

## 🧭 Codebase layout

```
src/
├─ main.tsx            App entry
├─ App.tsx             Phase router (setup → initial-roll → mapping → game → game-over)
├─ index.css           Global palace theme (palette, typography)
├─ App.css             Header layout
├─ game/
│  ├─ types.ts         Core types (Player, Resource, Card, Square, GameState)
│  ├─ board.ts         30-square static board data + clockwise/advance helpers
│  ├─ cards.ts         18-card deck data + shuffle / freshDeck
│  ├─ constants.ts     Prices, recipes, points, stake/tiebreaker weights
│  ├─ scoring.ts       Points & tiebreaker (staff-weighted, then cash)
│  ├─ actions.ts       GameAction discriminated union
│  ├─ reducer.ts       The whole turn loop + all mechanics
│  ├─ reducer.test.ts  Unit tests for every rule in DESIGN.md
│  └─ store.tsx        GameContext + useReducer + localStorage autosave
└─ components/
   ├─ Setup.tsx          Player names + start
   ├─ InitialRoll.tsx    Rolling for turn order
   ├─ InitialMapping.tsx Per-player resource-card picker + reveal
   ├─ Game.tsx           Main layout (Board + panels + sidebar)
   ├─ Board.tsx          10×7 perimeter grid, tokens, role icons
   ├─ PlayerPanel.tsx    Current player inventory + progress + resource card + Worker toggle
   ├─ OtherPlayers.tsx   Other players at-a-glance
   ├─ TurnBar.tsx        Phase-driven controls
   ├─ Shop.tsx           Buy bricks/sticks/staff/Queen (+ special deals on #8, #14, #29)
   ├─ Build.tsx          Construction ladder (wall → palace)
   ├─ Trade.tsx          2:1 bricks ↔ sticks
   ├─ Duel.tsx           Stake picker + roll-off (honors contenders)
   ├─ BailiffSteal.tsx   Target picker for Bailiff stealing
   ├─ DecisionPrompt.tsx Alliance / bricks-or-wall choices
   ├─ EndGame.tsx        Final scoreboard + tiebreaker
   ├─ RulesModal.tsx     Help page with all rules
   ├─ GameLog.tsx        Chronological game log
   ├─ Game.css           All game-screen styles
   ├─ Board.css          Board-specific styles
   └─ labels.ts          Display helpers (outcome / square labels)
```

## ✅ Tests

Run `bun run test`. Coverage lives in [`src/game/reducer.test.ts`](./src/game/reducer.test.ts) and exercises every major rule in `DESIGN.md`: setup, initial mapping, turn loop, every square type, Kingdom Alliance, Bailiff mechanics, Dungeon flow, same-square duel (including tie re-roll elimination), Shop / Build / Trade, Card effects, multi-player draw order, Worker / WHC passives, win condition + tiebreaker, mid-game removal.

## 🎨 Phase 1 MVP — scope

- Hotseat for 2–6 players on one device.
- Full rule coverage per `DESIGN.md`.
- Save / resume via `localStorage` (key `tpp:autosave`) — reopen the tab to continue.

## 🔜 What's next

See [`CHANGELOG.md`](./CHANGELOG.md) for the rolling list of open items. Current standing gaps: animations / sound polish, Phase 2 (networked multiplayer).
