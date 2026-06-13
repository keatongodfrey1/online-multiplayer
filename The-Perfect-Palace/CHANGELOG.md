# Changelog

Phase-by-phase history of *The Perfect Palace*. Newest first.

Each entry points to the actual commits — for full diffs, run `git log <hash>` or `git show <hash>`.

---

## 2026-04-19 — Board overflow fix (purple panel shorter than tile grid)

Follow-up to `b2bf2eb`. The 56 → 64 px tile-floor bump in that commit pushed the grid's intrinsic height (7 × 64 + 24 gap + 16 padding = 488 px) above the existing `max-height: 50vh` cap, so the bottom row of tiles overflowed below the purple `.board` panel on most viewports. Dropped `max-height: 50vh` from `.board`; kept `aspect-ratio: 10/7` and `max-width: 900px`. Trade-off: on short viewports (≤ 768 px tall) the panels-row may now need scrolling — accepted as the right call vs. visibly broken board layout. One-line CSS change.

## 2026-04-19 — Scoring rebalance + Knight + Queen-no-immunity + scoreboard width + tile legibility + column swap

Six bundled changes, one commit.

- **Scoring rebalanced so upgrades reward.** Building 10 → **20** (3 Rooms = 15 pts, upgrade nets +5). Three-Story 20 → **75** (3 Buildings = 60, upgrade nets +15). Palace 250 → **300** (3 × 3-Story = 225, upgrade nets +75 *and* triggers end-game). Worker 0 → **5** so the $50 investment isn't a dead spend at game end. Servers / Chefs / Cleaners / WHC / Queen unchanged. Tests for `totalPoints`, plus per-item Worker/Building/3-Story/Palace assertions.
- **Knight character added — pure Bailiff immunity, decoupled from Queen.** New shop item: $75, max 1 per player, permanent, 5 pts, tiebreaker weight 1. While you own a Knight, the Bailiff can never target you (silent no-op; the holder's once-per-turn flag is not consumed). New `knight: boolean` on `PlayerInventory`, new `'knight'` ShopItem, new `canBuy`/`buy` cases. Why split: at $300 the Queen tied immunity to a scoring-dominant late-game purchase; the Knight gives families a cheap, accessible defensive option without forcing the Queen on you.
- **Queen loses Bailiff immunity (the only Queen change).** $300 / 200 pts / max 1 / permanent / staff weight 10 all unchanged. Existing "Queen immunity" reducer test rewritten to assert the steal now succeeds against a Queen-only holder; new "Knight immunity" test asserts the silent no-op pattern. UI: BailiffSteal target filter now `!p.inventory.knight`, copy updated. Old saves restored after this change: Queen-only holders become vulnerable to the Bailiff next time they're targeted (acceptable; they can buy a Knight that turn).
- **End-game scoreboard widened.** `.endgame { max-width: 600px }` → `max-width: min(100%, 1200px)`. The 9-column score table (Rank / Player / Points / Staff / Cash / Rooms / Buildings / 3-Story / Palaces) was clipping at 600 px. Existing `overflow-x: auto` on the table stays as a fallback for narrow viewports.
- **Board tiles widened for legibility on 10" screens.** Tile floor 56 → **64 px** (rows + columns). Token 20 → **16 px** (font 0.7 → 0.6) to make room. Removed the per-tile `<div className="sq-short">` effect summary — the active player's `CurrentSquare` banner already shows the full effect on landing, hover/title still surfaces flavor, and the tile now fits `#N` + label + tokens at 1024 × 768 without clipping. Dropped the now-dead `shortEffect` helper. Sidebar column min 180 → **150 px** so the 3-col layout still fits at a 1024 viewport with the wider board.
- **Top-row column order: Board | Log | Players** (was Board | Players | Log). JSX-only swap inside `.game-top-row` — Log moves to the middle, the Players sidebar with the buttons strip (💾 📖 🏳) moves to the right. CSS grid columns unchanged; mobile stack order becomes Board → Log → Players.
- **Knight badge on the board token** (🛡 left, 👑 right) so the role is glanceable. Knight chip in PlayerPanel header + OtherPlayers row. `.token-badge.knight` / `.token-badge.queen` staggered to avoid clipping when both are held.
- **DESIGN.md** §6 (Knight + revised Queen note), §8 (point bumps + Knight + Worker), §9 (Knight immunity), §12 (Knight = 1 staff) — all stamped `(revised 2026-04-19)` or `(added 2026-04-19)`. RulesModal shop / Bailiff / construction-ladder text mirrored to match.
- **Tests: 134** (was 127). +7 new (Knight-buy, Knight-cap, Knight-immunity, Worker pts, Building pts, 3-Story pts, Palace pts). Queen-immunity test rewritten to assert the new behavior. `totalPoints`/`staffWeight` literals updated with `knight: false` and the new expected total (580 → 710).

## 2026-04-19 — 3-column top band + no-overpay fine payment

Two changes in one commit.

- **Layout: Board | Players | Log side-by-side.** Replaced the 2-column grid (board left, sidebar right with OtherPlayers+Log stacked) with a 3-column top band. Buttons (💾 📖 🏳) sit above the Players column. Below the top band: CurrentSquare banner, then the Actions + PlayerPanel row. 3-col active at ≥ 1000 px viewport; stacks below. Board tile floor bumped back up from 48 → 56 px so squares are readable.
- **No-overpay rule for money fines.** `payFine` + `FinePaymentPrompt` reject any selection whose total exceeds the owed amount. Rule: exact → pay; overpay → reject; underpay with feasibly-addable items → reject; underpay with no addable item that would fit → accept (partial stiff). DESIGN.md §1 updated; previously stated overpay was allowed, now explicitly not. +2 reducer tests (overpay rejected; partial stiff when no item fits the gap).

## 2026-04-19 — 10" layout, End Turn at top, Build-panel WHC prereq bug fix

Four items in one commit:

- **Bug: 3-Story Building button stays disabled with a WHC in hand.** Build.tsx has its own UI-side prereq checks that disable the button when the player lacks a raw Cleaner — the Bug 7 fix in 3afe0d2 only updated the reducer's `canBuild`. A reducer test dispatching directly doesn't catch this (the UI's guard sits in front of the dispatch). Fix: duplicate the `effectiveCleaners(p) = cleaners + wholeHouseCleaners` helper into Build.tsx and route the `building` and `threeStoryBuilding` prereqs through it. Tooltip labels updated to "Cleaner (or WHC)". Shop.tsx was already using an analogous `hasRoomPrereq` duplicate — same pattern.
- **Layout: compact for 10" screens.** Sidebar column 300 → 240 px. Gaps 0.75 → 0.5 rem. Panels-row min cols 380/280 → 320/240. Mobile-stack breakpoint pushed from 960 → 899 px so 2-column survives down to a 900-wide viewport. Board tile floor 64 → 48 px lets the board scale gracefully in tight columns; board `max-height` 55 → 50 vh reclaims vertical room for the panels-row on short viewports. `.app` outer padding 0.75 → 0.5 rem.
- **End Turn button moved to the top of the TurnBar.** Was in a bottom `.turn-bar-footer`, requiring a scroll past Shop/Build/Trade on small screens. New `.turn-bar-top-row` puts the header line on the left and the End Turn button on the right, both visible without scrolling.
- **Sidebar button label** shortened from "💾 Save / Load" to "💾 Save" so all three sidebar buttons fit in a 240-px-wide sidebar row. The SaveSlotsModal handles both save and load; the label shortens without changing behavior.

## 2026-04-19 — Tighter layout + mid-game remove-player UI

- **Layout: less vertical scroll.** `Game.tsx` reshuffled so the top row is Board | (Save/Load, Rules, Quit buttons + Players summary + Log) and the row below the board puts the actions panel (TurnBar) side-by-side with the inventory PlayerPanel. No more stacking PlayerPanel under TurnBar. CSS widths tuned via `minmax(420px, 3fr)` for actions and `minmax(320px, 2fr)` for the player panel; sidebar widened from 300px → 340px to give the Players list and Log room.
- **Remove-player button (mid-game).** Each row in the sidebar's Players list now has a ✕ button that dispatches `system/removePlayer` after a `confirm()` dialog. Per DESIGN.md §14: the removed player's Bailiff returns to middle, inventory clears, and turn advances if it was theirs. Button is disabled during unstable phases (duel, any bailiff-steal phase, fine-payment) to avoid corrupting in-flight state.
- **Auto-game-over when ≤ 1 player remains.** `removePlayerMidGame` now transitions straight to `game-over` if the removal leaves only one (or zero) non-removed players. Scoreboard still renders normally with the survivor at rank 1.
- Tests: 125 (was 122). +3 new reducer tests covering active-player removal, down-to-one auto-game-over, and down-to-zero.

## 2026-04-19 — Setup remove-then-add duplicate-ID fix

Playtest bug: remove a player during Setup, then add a new one → the newly-added player's roll on the "Roll for Turn Order" screen silently updated a different (existing) player instead, because `addPlayer` generated the new player's `id` from `players.length + 1`, which collides with an existing id after a mid-list removal. Fix: derive the new `id` (and `colorIndex`) from `max(existing) + 1` in [`src/game/reducer.ts`](src/game/reducer.ts). Two new reducer tests lock in the repro: one asserts unique IDs after `add A/B/C/D → remove p2 → add E` (new id = p5, not a duplicate p4), and one asserts that dispatching `initialRoll/rollForPlayer` with the new player's id updates only the new player.

## 2026-04-19 — Playtest round 3: eight bug fixes

Eight issues surfaced by the third family playtest, shipped as one commit.

- **Bug 3 — money fines no longer send to the dungeon.** #7, #28, and #11 now use a unified "cash-first, then item-forfeit dialog" rule. If the player's cash can't cover the fine, a new `FinePaymentPrompt` opens with per-item pickers for bricks, sticks, walls, and roofs (protected: rooms, buildings, 3-story, palaces, all staff, pardon cards, Bailiff). Item values: 1 brick/stick = $1; 1 wall/roof = $5. If they have nothing forfeit-eligible, the fine is partially stiffed — no dungeon entry, no Bailiff loss. DESIGN.md §1 #7/#11/#28 rows, §1 "Money fees & insolvency", and §10 "Dungeon entry triggers" all rewritten.
- **Bug 5 — staff Room prereq now counts any Room-or-higher.** `hasRoomPrereq(p)` checks `rooms + buildings + threeStoryBuildings + palaces >= 1`, so a player who built their rooms up into a Three-Story + 2 Buildings (zero raw Rooms but 15 Rooms' worth of construction) still passes the Server/Chef/Cleaner prereq. Tooltip updated. DESIGN.md §6 Central Shop prereq column revised.
- **Bug 7 — WHC counts as a Cleaner for construction prereqs.** `effectiveCleaners(p)` = `cleaners + wholeHouseCleaners`. `canBuild('building')` and `canBuild('threeStoryBuilding')` use it — a player with 1 WHC but 0 raw Cleaners can build Buildings and Three-Story Buildings (provided Server + Chef for the latter). Does NOT affect `tryConvertWHC`, which still requires 5 raw Cleaners. DESIGN.md §7 Construction Ladder prereqs revised.
- **Bug 6 — trader once per turn on both #8 and #29.** New `turn.traderUsedThisTurn` flag. #29's shop→trade→shop→trade money loop (trade 100 bricks → $150 → buy 100 bricks for $100 → trade again → +$50/cycle) is closed. Multiple batches allowed within a single trade action; after that, the trader panel shows a disabled "Already used the Trader this turn" state. Resets on endTurn and extra-turn consumption. DESIGN.md §1 #8/#29 rows + "Discount-while-on-square" summary revised.
- **Bug 4 — center-of-board roll display.** New `LastRollDisplay` component mounts in the board's center (stacked below the Bailiff token when unheld). Shows "🎲 N rolled" plus a per-player row with the name chip and their mapped outcome for the face rolled ("drew a card" for draw-card). Hidden during turn-start and setup phases; updates each roll including the #24 re-roll.
- **Bug 1 — pre-move Bailiff steal from a drawn card.** New `pre-move-bailiff` phase + two new actions (`bailiffStealPreMove`, `bailiffStealPreMoveSkip`). When the active player acquires the Bailiff via a card drawn during `distributeResources` (e.g. rolling a "draw-card" face and drawing card #18), the turn pauses BEFORE movement for a steal opportunity. Previously the steal was only offered after the square effect, so landing on #10 (which strips the Bailiff on dungeon entry) voided the steal entirely. Extracted `completeRollAfterDistribute` helper shared by `commitRoll` and the pre-move handlers. DESIGN.md §9 Bailiff timing clarified with both acquisition paths.
- **Bug 2 — defensive hardening on end-game turn counting.** The `baseTurnsTaken` double-count fix in 9048e5c almost certainly already resolved the user's report ("2-player game, 3 extra turns after p1 built palace instead of 1"). Rather than rewriting end-game logic on a symptom that may be gone, this bundle adds: (a) an expanded `checkPalaceTrigger` log line showing `triggerCount` + each player's current `baseTurnsTaken`; (b) a game-over log line listing final turn counts; (c) four regression tests covering 2-player palace-build scenarios at different turn counts, including a #24 sequence inside the palace-build round.
- **Bug 8 — end-game scoreboard shows full construction breakdown.** Added 4 columns to the score table: Rooms, Buildings, 3-Story, Palaces. Ranking logic untouched (still points → staff → cash).
- **Defensive reducer gates** — `turn/endTurn` now rejects when `pendingFine` is set OR when the phase is `pre-move-bailiff`. The UI doesn't expose End Turn in those states, but the gates prevent a future UI bug from stiffing fines or leaving a turn stuck mid-roll.
- **`system/loadState` validator** (landed previously as part of the save-slots feature) rejects payloads without required shape (`phase`, `players`, `turnOrder`, `turn`, `bailiff`, `deck`, `discard`, `log`). Prevents tampered / malformed saves from corrupting the app.
- **Tests: 120** (was 97). +23 new tests covering the eight bugs; 1 existing test rewritten for the new #7 insolvency flow.

## 2026-04-19 — Save slots, Quit, #24 re-roll flow, Bailiff cap fix

Four bundled changes from the third playtest session:

- **Named save slots.** New `💾 Save / Load` sidebar button opens a modal over the existing `listNamedSaves` / `writeNamedSave` / `deleteNamedSave` helpers. Saves sorted newest-first; default save-name is today's short date-time so the kids don't have to type; 20-slot cap; confirms on overwrite / load / delete; surfaces a red error line if `localStorage` is full or disabled. `tpp:autosave` survives a load (gets overwritten by the loaded state via the existing useEffect). Hardened `system/loadState` with a shape-light validator — tampered or malformed blobs are silently rejected instead of crashing the reducer.
- **Quit Game.** New `🏳 Quit Game` sidebar button opens a confirmation modal (Cancel / Save first… / Quit). Quit clears `tpp:autosave` and dispatches `system/reset` (back to setup). Named saves are preserved.
- **#24 "Roll Again" flow change.** Landing on #24 now auto-ends the first roll's phase and jumps straight back to the roll button — no intervening shop/build/trade. Both rolls still distribute resources to every player; shop/build/trade runs once, after the 2nd roll's square effect. Added `TurnState.skipOptionalActions` (set by the `'roll-again'` square effect, checked in `advanceAfterSquare`, `duelResolve`, and the new Bailiff post-roll exit paths). **Also fixed two adjacent bugs the new flow would have amplified:** (a) the post-roll-bailiff phase was sticky — skipping the post-roll steal didn't advance phase, and the game got stuck on the Steal UI. Both steal-commit and steal-skip handlers now transition to `optional-actions` (or auto-end on #24). (b) `baseTurnsTaken` was being double-incremented on #24 extra turns, contradicting DESIGN.md §1's "extras are invisible to the equal-turns tally" rule. `endTurn` now only credits a base turn when actually advancing to the next player. (c) Worker/WHC passives now fire **once** per #24 sequence (at the start of roll 1, not re-fired on the re-roll) so the #24 sequence behaves like a single turn.
- **Bailiff once-per-turn-sequence cap enforced.** `turn/bailiffStealPostRoll` now rejects if `bailiffStealUsedThisTurnSequence` is already set. Landing on a Bailiff square (#5/#13/#27) while you already hold the Bailiff is a silent no-op (no re-transfer, no post-roll-steal prompt). Same guard for card #18 drawn by the current holder. DESIGN.md §9 already specified this rule; code now matches.
- **Tests:** 97 total (was 92). Added 5 new (#24 auto-end flow, #24 + same-square duel, #24 sequence counts as one base turn, Bailiff-holder landing on Bailiff square is a no-op, post-roll Bailiff skip → optional-actions + post-roll once-per-sequence cap). Rewrote 2 (the #24 queue-extra test and the advance-to-next-player test).
- **DESIGN.md** §1 #24 row + §5 Turn Structure step 5 and step 8 updated to reflect the new flow.

## 2026-04-18 — Playtest round 2 fixes

Three items surfaced by the second family playtest:

- **Worker + Whole House Cleaner passives now fire at the START of the owner's own turn**, not at end of turn. This means the walls/roofs/dollars are available during the very turn they produce — the Worker's "2 walls OR 1 wall + 1 roof" output can be spent in the same buy/build/trade phase. **No benefit on the acquisition / conversion turn** — buying a Worker (or auto-converting 5 Cleaners into a WHC) no longer pays out on the turn it happens; the first payout is the next time that player's own turn begins. Logic centralized in `firePlayerStartPassives(state, playerId)`, called from every transition into `turn-start` for the active player (next-player advance, #24 extra-turn consumption, Royal Pardon redemption, and the first game turn). Removed the now-unused `turn.startedInDungeonThisTurn` flag.
- **Fixed the scroll-jump that happened on every shop / build / trade click.** `GameLog` used `scrollIntoView`, which scrolls the nearest scrollable ancestor — when the log panel's overflow region wasn't strict enough, the browser bubbled the scroll up to the window and yanked the page back to the top. Replaced with a direct `scrollTop = scrollHeight` update on the log's own container, which can only ever scroll the log itself.
- **2:1 trade minimum + step is now 10, not 2.** Since bricks and sticks are bought in bundles of 5, the smallest sensible trade is 10 → 5. Raised the UI `QtyPicker` and reducer validation to require amounts ≥ 10 and multiples of 10. New `BRICK_STICK_TRADE_MIN_BATCH` constant.
- **Tests:** 92 total. Replaced 3 endTurn-based Worker/WHC tests with 5 new turn-start tests (acquisition-turn skip, `wall-wall` preference, conversion-turn skip, no-fire on other players' turns, imprisoned-player skip). Added a rejection test for `trade(4)` and tightened the multi-batch trade test to 10-step.

## 2026-04-18 — Batch purchasing / building / trading

- **Bricks & sticks now sell in bundles of 5** (min 5, increments of 5). No more buying 6 bricks or 7 sticks. Unit price stays $1 ($5 per bundle).
- **One-click multi-quantity** throughout Shop, Build, and Trade. Every row has a quantity picker with −/+ buttons, a numeric input, and a "max" shortcut. Build 4 walls → one click; trade 20 bricks → one click.
- **Shop re-laid out as a list of rows**: icon · name · price per unit · qty picker · total-cost button. Affordability, prereqs, and stack caps are baked into the displayed max so you can't overshoot.
- **Build panel** computes the max buildable for each tier (walls/roofs/rooms/buildings/3-story/palace) from your inventory + staff prereqs. Button label shows the exact count it will build.
- **Trade** now has one row per direction (🧱→🪵 and 🪵→🧱), each with its own step-2 qty picker and a "trade X for Y" button.
- **4 new tests** (90 total) covering: buy 20 bricks in one action, reject `buy(brick, 6)` as not a multiple of 5, reject `buy(stick, 7)`, build 4 walls in one action, multi-build stops at what resources allow.

## 2026-04-18 — Playtest round 1 fixes

Landed after first family playtest:

- **Board orientation flipped.** Start is now at the **bottom-right**; clockwise movement goes LEFT along the bottom row first (matching Monopoly). Logic unchanged — purely a visual re-map in `Board.tsx`.
- **Resource card now enforces the one-to-one mapping.** Before: you could set all 6 die faces to `$10`. Now picking a new outcome for a slot **swaps** it with whichever slot currently holds that outcome, so every outcome always appears exactly once. Invalid cards submitted to `setInitialMapping` are rejected.
- **Initial-roll ties now force a re-roll.** If two or more players tie for the highest roll, "Lock Order" stays disabled and the tied rows are highlighted with a "TIED — re-roll" chip until one player is uniquely highest.
- **Worker output picker always visible.** Previously only appeared after buying a Worker; now shows in the PlayerPanel with a disabled state + "no Workers yet" chip so players can see the `2 walls` vs `1 wall + 1 roof` choice before they own one.
- **Current-square info panel** between the board and the turn bar — always shows the active player's current square with full flavor text, so you can see what happened when you landed.
- **Each board tile** now shows a one-line effect summary (e.g., `+100 🧱`, `-$100 tribute`, `Draw 3 cards`, `½ Cleaner ($10)`), not just the square name.
- **3 new tests** (86 total) for the permutation invariant, swap behavior, and the top-tie re-roll rule.

## 2026-04-18 — Docs sync + `check` script

- Refreshed `README.md`, `RESUME.md`, and project memory after the audit + tests landed — previous versions still claimed "no tests yet" and "Worker UI pending."
- Added `CHANGELOG.md` (this file) and `REMOTE_SETUP.md` (off-machine-backup guide).
- Added `bun run check` = typecheck + tests + build in one, for use as a pre-commit smoke test.
- Added a "Docs sync at phase boundaries" rule to `memory/feedback_collaboration_style.md` so future Claude sessions automatically keep docs in sync.

## 2026-04-18 — Test suite — commit `197ad72`

- Installed vitest; added `bun run test` and `bun run test:watch` scripts.
- Wrote `src/game/reducer.test.ts` — 82 unit tests covering every major rule in `DESIGN.md`: setup, initial mapping, turn loop, every square type, Kingdom Alliance, Bailiff mechanics, Dungeon flow, same-square duel (including tie re-roll contender-narrowing), Shop / Build / Trade, Card effects, multi-player draw order, Worker / WHC passives, win condition + tiebreaker, mid-game removal.
- All 82 tests pass consistently.

## 2026-04-18 — Component audit + cleanup — commit `5d3a668`

- `PlayerPanel.tsx`: resource-card changes now gated by the lap-credit counter chip; Bailiff chip in header; Worker preference toggle (2 walls OR 1 wall + 1 roof) when the player owns a Worker.
- `TurnBar.tsx`: don't render the dungeon-turn UI for players who just entered mid-turn — they finish their current turn normally.
- `Duel.tsx`: honor the new `DuelState.contenders` field — eliminated players shown struck-through; "all rolled" now computed on contenders, not participants.
- `Board.tsx` + `actions.ts`: drop dead exports (`TOTAL_SQUARES`, `card/*` placeholder actions).
- `addInventory`: narrow to numeric deltas only; `patchInventory` handles booleans.

## 2026-04-18 — Reducer audit: 8 bugs fixed — commit `b39832f`

Found during a skeptical pass over `reducer.ts`:

1. **Duel tie re-roll** — only tied "contenders" now compete; non-tied participants (who contributed to the pot) can no longer win on a later low roll.
2. **Bailiff via card** — only set `acquiredBailiffThisTurn` when the DRAWER is the active player (fixes phantom post-roll-steal phase on multi-player draws).
3. **Mapping-change gating** — new `mappingChangesAvailable` on Player; passing Start grants +1, `changeOneMappingSlot` consumes 1 (mid-game only).
4. **Dungeon entry mid-turn** — new `turn.enteredDungeonThisTurn` so buy/trade/build still allowed the rest of the current turn.
5. **Release-turn passives** — new `turn.startedInDungeonThisTurn`; Worker / WHC suspended on release turns.
6. **Worker output choice** — `Player.workerPreference` (`'wall-roof' | 'wall-wall'`) + `turn/setWorkerPreference` action.
7. **`advanceAfterSquare` idempotent** — no-op when phase is already past `square-effect`.
8. **Duel skipped when current player is imprisoned** (e.g., just landed on #10 with others at #25).

## 2026-04-17 → 2026-04-18 — MVP — commit `cd05c16`

- Scaffolded Vite + React + TypeScript (no framework; hand-written CSS with palace-themed palette).
- Wrote `DESIGN.md` — 547 lines, source of truth for rules, theme, UX principles, and the full 30-square + 18-card deck specification.
- Built the full turn loop: setup → initial roll → hidden mapping → reveal → turns → game-over.
- Implemented: 30 squares, 18 cards, Bailiff + steal + Queen immunity, Dungeon + Royal Pardon + 3-turn timer, same-square duel, Kingdom Alliance, Worker / WHC passives, auto-save via `localStorage`, staff-weighted tiebreaker.
- Palace-themed visual style (Cinzel + warm cream / regal purple / gold accents).
- README, RESUME, memory files.

## 2026-04-17 → 2026-04-18 — Build hygiene — commit `1fd3ba0`

- Dropped `tsconfig.*.tsbuildinfo` from version control.
