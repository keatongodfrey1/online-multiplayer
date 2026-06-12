# Space Chase — Mechanics & Rulings

The precise, corner-case behavior we worked out through play. Each section states the **intended
rule** (what a rebuild should do). Where today's shipped code differs, a **`⚠️ Current code`**
note explains the gap so you can decide to match or fix it. (Per project decision, the rebuild
should implement the **intended** rule.)

Legend: **[FIX]** = current code differs from intended and should be corrected on rebuild.

---

## 1. Portal traversal

State carried on a player while inside a portal:
`portal = { portalDef, progress, totalInternal, exitSpace, entrySpace, forward }`, where
`progress` runs from `0` (just entered) up to `totalInternal`.

**Rules:**
- **Entering:** landing on a portal end sets up the portal state at `progress = 0`. `forward` is
  `true` if you entered at the portal's `a` end (heading `a→b`), `false` if at the `b` end.
- **Moving through:** dice/card movement adds to `progress`.
- **Exiting costs one extra move.** To leave the far end you must spend `totalInternal + 1` moves
  total. Any **overflow** continues on the main board from `exitSpace`, in the same direction.
- **Backing out:** negative movement can take `progress` below 0; you then exit back at
  `entrySpace` (also costing one move) and any remaining backward movement continues on the board.
- **Re-entry guard:** the space you just exited onto is itself a portal mouth, so a flag
  (`justExitedPortal = <that space #>`) prevents you from immediately re-entering the portal you
  just left. It's cleared at the start of your next turn.

**Worked example (the one we debugged):** A rocket entered **Portal 3 at Space 51** (so
`forward=false`, `exitSpace=39`, `totalInternal=3`). A "move forward 7" resolves:
`3` to cross the internal spaces → `1` to exit at **Space 39** → `3` left over → continue forward
to **Space 42**. (Not Space 58 — that was the bug: a player sitting *on* 51 who hadn't entered the
portal yet was moved 51→58 on the board.)

**⚠️ Current code — landing consistency [FIX]:** A rocket only auto-enters a portal it lands on
in some cases:
- The **active player** entering a portal mouth via dice/their own card → handled in
  `afterAction` ✅.
- A **non-active** player pushed **forward** onto a mouth by a "move everyone" card → handled in
  `movePlayerBy` ✅.
- But a player **teleported** onto a mouth by an attack (Black Hole, 6-7, Shooting Star) does
  **not** enter the portal, and a **backward** "move everyone" that lands a non-active player on a
  mouth does **not** enter either.
- **Intended:** landing on a portal mouth by **any** means and from **either** direction enters
  the portal. Centralize the "did I land on a mouth? → enter" check so every movement path
  (dice, move-all both directions, teleport, attack-teleport, self-teleport) runs it.

---

## 2. Collisions

After **any** movement resolves, scan all players: if **2+ share the same board space**, send
**all** of them back to START.

- **Exempt:** players at START (position 0) and players inside a portal.
- **Triggers from any source**, including a teleport that lands a victim on an occupied space
  (e.g. **Black Hole** dropping Player 2 onto Player 3 → both to START).
- **Cascades terminate safely:** the collided players all go to START (0), which is exempt, so no
  further collision fires.
- For "move everyone" cards, run the collision scan **once after all players have finished
  moving** (not per-player mid-resolution).

**⚠️ Current code:** the scan runs in `afterAction` (after the active player's action resolves)
and correctly covers all players. It is **skipped** when the active player just entered a portal
that turn — acceptable, since portal occupants are exempt anyway, but keep in mind if you
restructure.

---

## 3. Tie-break at the Finish

If `checkWin` finds **more than one** player at position ≥ 68 (Finish) at once, enter a
**tiebreaker**: each tied finisher rolls a die in turn; **highest roll wins**; **re-roll** among
those still tied. Implemented as `startTiebreaker` → `resolveTiebreaker` (recursive on ties).
A single finisher wins immediately. You can't be a "finisher" from inside a portal.

---

## 4. Shield Generator — 3 full table go-arounds [FIX]

**Intended:** immunity to **all** negative effects (backward move, lost turns, send-to-START,
forced teleport, swap) for **3 complete go-arounds of the table**, blocking **unlimited** hits in
that window, and **never** shortened by taking extra turns.

**Recommended implementation:**
- Add `GameState.roundNumber`, starting at 0, **incremented in `nextTurn()` each time the turn
  index wraps from the last player back to the first** (one full go-around).
- When Shield is played, store `player.shieldExpiresRound = GameState.roundNumber + 3`.
- A shield is **active** while `GameState.roundNumber < player.shieldExpiresRound`.
- On any negative effect targeting the player, if the shield is active → **block** (no decrement;
  it's purely time-based). Otherwise apply the effect.
- Show remaining rounds in the status panel.

**⚠️ Current code:** uses `shieldTurns = 3` as a **counter that decrements on each blocked hit**
(3 *hits*, not 3 *rounds*). Many sites do `if (player.shieldTurns > 0) { player.shieldTurns--;
/* block */ }`. Replace that pattern with the round-based check above. Keep the existing rule that
Space Suit does **not** change the shield amount.

---

## 5. Space Suit — doubling rules [FIX for "everyone" cards]

`resolveCard` reads `const suit = player.spaceSuit; if (suit) player.spaceSuit = false; const
mult = suit ? 2 : 1;` — i.e. the suit is **consumed by the very next card**, period.

**Intended doubling (mult = 2) applies to:**
- Your forward/back distance (moveForward, moveBack).
- A **dice roll**, if you roll while wearing it (`onRollDice` already does `result * 2`).
- Turn counts you gain (extraTurns) or inflict (loseTurns, including attack/Kraken).
- Attack distances you deal (Blaster/Alien Pirate moveBack, Fighter Jet's back-3/forward-3).
- **Rover:** doubles **only your** 7 → 14; others still move 5.

**Intended — "affects everyone" cards (Cosmic Chaos, Tidal Wave, Meteor Shower, Solar Flare):**
double **only the suit-wearer's** movement; everyone else moves the base amount.

**⚠️ Current code [FIX]:** for `moveAll`/`moveAllBack` it does `moveAllPlayers(card.amount * mult)`
— doubling for **everyone**. Change so the multiplier applies **only to the player who wore the
suit** (move others by the base amount, move the wearer by `amount * mult`).

**Edge rules to preserve:**
- The suit is consumed even if the next card has nothing to double (Satellite, Worm Hole, Rocket,
  Time Loop, Shield) — it's simply wasted. Document this in-game so it isn't reported as a bug.
- Never doubles Shield duration.

---

## 6. Time Loop (#34)

**Intended:** replays **the player's own previous action** (their last dice roll or last card),
exactly. Never causes an infinite loop.

How it stays safe (and must continue to):
- In `onDrawCard`, **do not overwrite `lastAction` when the drawn card is Time Loop** — it must
  read the action *before* it. (`if (card.type !== 'timeLoop') player.lastAction = {...}`.)
- `lastAction` is **per-player** (stored on the player object), so Time Loop always repeats *that*
  player's last turn, never another player's.
- Replaying a **dice** action replays the stored amount. Note this is the **already-doubled**
  value if the original roll was Space-Suited (`onRollDice` stores `result * 2`).
- Replaying a **card** re-resolves it by id via `resolveCard`. If that card needs a target (e.g.
  Blaster), the target prompt appears again against the current board.
- If there is **no** previous action (Time Loop is the player's first-ever action), it does
  nothing and says so.

---

## 7. Other tricky cards

- **Space Kraken (#22):** choice modal — "3 players lose 1 turn" vs "1 player loses 3 turns."
  - "1 player" → single-target (self allowed), lose `3 × mult` turns (shield blocks).
  - "3 players" → must pick **exactly `min(3, playerCount)`** targets (so in a 2-player game you
    pick 2). Each loses `1 × mult` turn unless shielded. The multi-select auto-confirms once the
    required count is chosen.

- **Fighter Jet (#19):** if the target is **shielded, the *entire* attack is blocked** — the
  target does **not** move back **and** the attacker does **not** get the forward 3. Only if the
  target is unshielded do both halves happen (`target −3×mult`, then `attacker +3×mult`).

- **6-7 (#30):** `player.sixSevenCount` is **per player**, incremented each draw. On the **2nd**
  draw by that player → teleport **that player to Space 67** (no target prompt). On the 1st →
  choose any player (self allowed; shield blocks) and send them to **Space 6 or 7**. This is why
  the pile has **two** copies of card 30 — a player must be able to draw it twice.

- **Black Hole (#20):** target is **anyone except yourself**; you then pick a destination space
  **1–67** (number input) and the victim is teleported there (shield blocks).

- **Worm Hole (#41):** swap positions with **an opponent (not yourself)**. Both players **exit any
  portal** they're in as part of the swap. (It's modeled as an `attack` with `action: 'wormHole'`.)

- **Rocket (#35, "rocketJump"):** exit any portal, then jump to **one space ahead of the nearest
  player who is ahead of you** (capped at Finish). If nobody is ahead, it does nothing (turn still
  spent).

- **Nuclear Bomb (#16) & Time Bomb (#13):** both send to **START (position 0)** — never Space 1.

---

## 8. Attack self-targeting matrix

`resolveAttack` builds its target list as: **all players including yourself**, *except* Black Hole
and Worm Hole, which exclude you.

| Card | Can target self? |
|------|:---:|
| Nuclear Bomb, Blaster, Alien Pirate, Fighter Jet, Ion Space Bomb | ✅ yes |
| Space Kraken ("1 player" & "3 players"), Shooting Star ("send"), 6-7 ("send") | ✅ yes |
| **Black Hole** | ❌ no (card says "not you") |
| **Worm Hole** | ❌ no (swap is with an opponent) |

---

## 9. Turn-economy interactions

- **Lost turns** are consumed at the **start** of a turn: if `lostTurns > 0`, decrement and skip
  immediately to the next player.
- **Extra turns** are consumed in `nextTurn`: if `extraTurns > 0`, decrement and the **same**
  player goes again.
- If a player has **both** queued, the lost-turn skip fires first on each of their turns (they
  burn lost turns before they can use extra turns). This is acceptable; just be aware.

---

## 10. Minor edge cases

- **Satellite with fewer than 5 cards left:** it peeks `min(5, deck.length)` and reorders those.
  With **0** cards left it would show an empty peek — low-stakes, but a rebuild may want to force a
  reshuffle first so there's always something to arrange.
- **30-second action safety timer (`actionSafetyTimer`):** if the action buttons stay disabled
  >30s, the code re-enables them. This is a band-aid against a stuck callback; it can theoretically
  re-enable buttons while a modal is legitimately open. **Intended:** drive re-enabling off actual
  action completion and remove/raise the blind timeout, or pause it while a modal is open.
