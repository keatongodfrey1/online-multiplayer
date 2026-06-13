# The Perfect Palace — Game Design & Implementation Plan

> **Status as of 2026-04-18:** Rules, product/tech direction, and thematic naming all finalized. A father-and-daughter collaboration capturing every rule, edge case, assumption, and UX principle needed to build a playable hotseat MVP.

---

## Context

A father and daughter are co-designing a multiplayer, Monopoly-style web-based board game called (tentatively) *The Perfect Palace*. Players roll a single die to earn resources, move around a perimeter board, and spend resources to progress through a construction hierarchy that culminates in building palaces. The project will ship first as a hotseat web app (single device, pass-and-play) and later add real-time networked multiplayer.

---

## Assumptions — all confirmed as of 2026-04-18

Originally flagged as inferences; all have been verified with the user.

- ~~Minimum player count is 2.~~ ✓ **Confirmed 2026-04-18.**
- ~~All players start on square #1 (Start).~~ ✓ **Confirmed 2026-04-18.**
- ~~Exactly one Bailiff token exists in the game.~~ ✓ **Confirmed 2026-04-18.**
- ~~Nobody holds the Bailiff at game start.~~ ✓ **Confirmed 2026-04-18:** Bailiff sits in the middle of the board, unused, until first acquired.
- ~~The die is a standard 6-sided die (d6).~~ ✓ **Confirmed 2026-04-18.**
- ~~"Purchase" for Buildings / Whole House Cleaner is loose phrasing.~~ ✓ **Confirmed 2026-04-18:** Buildings are constructed from resources + staff prereq; Whole House Cleaners only via 5-Cleaner auto-conversion. Neither has a shop money price.
- ~~Staff abilities~~ ✓ **Updated 2026-04-18:** Queen protects from the Bailiff (absolute, permanent, max 1 per player); Whole House Cleaner gives +$15 per own-turn income (stacks); Worker gives 2 walls OR 1 wall + 1 roof per turn (choice, automatic, stacks). Server, Chef, Cleaner have no in-game abilities.
- ~~Multiple players can occupy the same square.~~ ✓ **Confirmed 2026-04-18:** mandatory same-square duel resolves (see Section 13).
- ~~Imprisoned players still roll on their own turn.~~ ✓ **Confirmed 2026-04-18:** the imprisoned player rolls; all players gain resources; the imprisoned roller doesn't move; rolling a 1 releases them.

---

## 1. Board

- **Shape:** 10 squares (long sides) × 7 squares (short sides), counting corners.
- **Perimeter squares:** 30 total — 4 corners + 26 non-corner path squares.
- **Numbering:** Clockwise from Start. The first side clockwise from Start is a long side.
  - **#1** — Start (corner 1)
  - **#2–#9** — first long side (8 non-corner squares)
  - **#10** — corner 2 ("The Royal Court finds you guilty — to the dungeon!")
  - **#11–#15** — short side (5 non-corner squares)
  - **#16** — corner 3 ("Get 10 Bricks or 1 Wall")
  - **#17–#24** — second long side (8 non-corner squares)
  - **#25** — corner 4 ("Dungeon or Just Passing")
  - **#26–#30** — short side (5 non-corner squares)
  - Loop back to #1
- **Math check:** 4 corners + 8 + 5 + 8 + 5 = 30 ✓
- *(User initially said "8 squares long and 6 squares wide excluding corners" in the opening message, which would have given 28 non-corner + 4 = 32 total. This was corrected to 10×7 / 30 total in a later message.)*

### Corner squares (fully defined)

| # | Name | Effect |
|---|------|--------|
| 1 | **Start** | Gain **$10** AND change **1** resource on your resource card. **Fires on both passing AND landing** (confirmed 2026-04-18). |
| 10 | **The Royal Court finds you guilty — to the dungeon!** | **Every player who lands on #10 goes to the dungeon** (confirmed 2026-04-18), regardless of whether they held the Bailiff's role. If the landing player held the Bailiff's role, they also **lose it** (the Bailiff returns to the middle of the board). |
| 16 | **Get 10 Bricks or 1 Wall** | Landing player chooses: 10 raw bricks, OR 1 pre-built wall |
| 25 | **Dungeon or Just Passing** | Where imprisoned players sit. If a non-imprisoned player lands on #25 while moving normally, **nothing happens** — "Just Passing" means no effect (confirmed 2026-04-18). Also the "Just Passing" landing spot where released players stop without further movement. |

### Square effect triggers — general rule (confirmed 2026-04-18)

**Every square fires its effect every time a player lands on it.** Rewards, costs, and status changes are **repeatable** — there is no "once per game" limitation on square effects. This applies to corner squares and non-corner squares alike.

Applied examples:
- Square #2 ("Get a Room") grants a Room on every landing.
- Square #6 ("Get 100 bricks") grants 100 bricks on every landing.
- Corner #16 ("Get 10 Bricks or 1 Wall") fires every landing; player picks each time.
- Corner #1 (Start) fires every time a player **passes OR lands on it** (confirmed 2026-04-18).

### Money fees & insolvency — general rule (revised 2026-04-19)

When a square or game event requires a player to pay money (examples so far: #11 "Lose $20", #7 and #28 "Tribute $100"):
- If the player has enough cash, they pay the full amount.
- **If the player doesn't have enough cash**, cash is taken first up to whatever they have. Any shortfall opens a **forfeit dialog** where the player picks items to cover the rest, valued at:
  - 1 brick = $1, 1 stick = $1, 1 wall = $5, 1 roof = $5.
- **Protected items** (cannot be taken): rooms, buildings, 3-story buildings, palaces, all staff (Worker / Server / Chef / Cleaner / Whole House Cleaner / Queen), pardon cards, Bailiff.
- If the player has **no forfeit-eligible items** and not enough cash, whatever cash they had is taken and the fine is partially stiffed. **No further penalty** — never a dungeon entry, never a Bailiff loss.
- **Overpay is NOT allowed** (revised 2026-04-19). The payment UI rejects any selection whose total exceeds the owed amount. If the player can't make exact change from their items (e.g. owed $73, player has only walls at $5 each), they forfeit as much as possible without exceeding owed and **stiff the remainder** — no further penalty. In the pathological case where even one small item would overpay (owed $4, player holds only 1 wall = $5), the player pays $0 and stiffs the fine; the wall is kept. Rare in practice since fines are multiples of $5 and cash is deducted first.

This rule is unified across all money fines: **no exceptions** (revised 2026-04-19 — the prior "#7 sends to the dungeon on insolvency" exception was removed during playtest round 3).

### Non-corner squares (all 26 captured ✓)

**First long side — captured 2026-04-18:**

| # | Effect |
|---|--------|
| 2 | **Get a Room** (free, instant) |
| 3 | **The Neighboring Kingdom offers alliance** — **If not allied:** optionally pay **10 bricks + 10 sticks** to become allied. **If already allied:** receive **10 bricks + 10 sticks** for free (confirmed 2026-04-18). |
| 4 | Get **10 bricks + 10 sticks** |
| 5 | **Get the Bailiff** |
| 6 | Get **100 bricks** |
| 7 | **Invading armies demand tribute!** Pay **$100** — skipped if you are allied with the Neighboring Kingdom. **Insolvency (revised 2026-04-19):** cash is taken first up to $100; any shortfall opens a forfeit dialog where the player picks items (bricks / sticks / walls / roofs — **never** staff, rooms, buildings, 3-story, palaces, pardon cards) to cover the rest at 1 brick = 1 stick = $1, 1 wall = 1 roof = $5. If the player has no forfeit-eligible items, whatever cash they had is kept and the fine is partially stiffed (no further penalty). **No dungeon entry, no Bailiff loss** — same as #11. |
| 8 | **You find a Trader** — pay **$10 for 3 walls**. **One trade per turn** while on this square (revised 2026-04-19; previously unlimited). Multiple batches allowed in that one trade. |
| 9 | **You find a Forest** — get **100 sticks** |

**Short side — #11 to #15 (captured 2026-04-18):**

| # | Effect |
|---|--------|
| 11 | **Lose $20** — pay $20 in cash. **Insolvency (revised 2026-04-19):** any shortfall opens the same forfeit dialog as #7/#28 — player picks bricks/sticks/walls/roofs to cover (never staff/rooms/buildings/3-story/palaces). If items can't cover, whatever they had is forfeited and the rest is stiffed. |
| 12 | **Get $100** |
| 13 | **Get the Bailiff** — if another player currently holds it, they lose it and it transfers to you. If you already hold it, nothing changes. |
| 14 | **A Cleaner wants to work for you at half price** — optionally buy Cleaners at **$10 each** (vs. normal $20) while on this square. Unlimited purchases while here, subject to available cash. **Waives the ≥1 Room prerequisite** (confirmed 2026-04-18) — you can buy Cleaners from #14 even if you own no Rooms. |
| 15 | **You meet a Fortune Teller** — draw a card. |

**Second long side — #17 to #24 (captured 2026-04-18):**

| # | Effect |
|---|--------|
| 17 | Get **100 sticks** |
| 18 | Get **$75** |
| 19 | **Get a free Server** — gain 1 Server at no cost. **Waives the ≥1 Room prerequisite** (confirmed 2026-04-18): always granted on landing regardless of what the player owns. |
| 20 | **The Neighboring Kingdom offers alliance** — **If not allied:** optionally pay **20 bricks + 20 sticks** to become allied (more expensive than #3 — second-chance offer). **If already allied:** receive **20 bricks + 20 sticks** for free (confirmed 2026-04-18). |
| 21 | Get **100 bricks + 50 sticks** |
| 22 | Get **$50** |
| 23 | **You meet a Fortune Teller** — draw **3 cards**. |
| 24 | **Roll again** — landing on #24 triggers an **immediate re-roll** (revised 2026-04-19 after playtest round 2). Flow: roll 1 → resources distributed to every player → roller moves → lands on #24 → **skip shop/build/trade** and go straight back to the roller's roll phase → roll 2 → resources distributed again → roller moves → square effect of the new landing → shop/build/trade **once** → end of turn. **Chaining:** theoretical only (a d6 from #24 can only reach #25–#30). **End-game accounting:** the whole #24 sequence counts as **one base turn** (extra rolls don't increment `baseTurnsTaken`). **Passives (Worker / WHC):** fire exactly **once** per #24 sequence, at the start of roll 1 — they do not re-fire for the re-roll. **Dungeon:** non-interaction (imprisoned players can't land on #24; no card grants extra turns). |

**Final short side — #26 to #30 (captured 2026-04-18):**

| # | Effect |
|---|--------|
| 26 | Get **100 bricks** |
| 27 | **Get the Bailiff** — standard Bailiff transfer rule applies. |
| 28 | **Invading armies demand tribute!** Pay **$100** — skipped if you are allied with the Neighboring Kingdom. Insolvency handled identically to #7 (revised 2026-04-19): cash-first then the forfeit dialog; no dungeon, no Bailiff loss. |
| 29 | **You find a Trader** — trade bricks for money at **10 bricks → $15**, scalable. **Multiples of 10 bricks only** — no partial batches (confirmed 2026-04-18). **Bricks only** — sticks are never convertible to money (confirmed 2026-04-18). **One trade per turn** while on the square (revised 2026-04-19; previously unlimited, which enabled a shop/trade money loop). Multiple batches allowed within that one trade. **This is the only exception in the game to the "no items → money" rule.** |
| 30 | **Get a Building** — gain 1 Building at no cost. **Waives all normal prerequisites** (3 Rooms + ≥1 Server/Chef/Cleaner) (confirmed 2026-04-18): always granted on landing regardless of what the player owns. The free Building is a **full Building** (confirmed 2026-04-18): counts toward the 3-Buildings → Three-Story Building ladder, satisfies the ≥1 Building requirement for Whole House Cleaner conversion, and scores the usual 10 points at game end. |

**All 26 non-corner squares captured** ✓ — next: the card deck.

**Concepts introduced by the 26-square walk** — to integrate into their own sections once the card deck is also captured:

- **Kingdom Alliance** — a **permanent** status a player can acquire at **two** squares (confirmed 2026-04-18 that it persists for the rest of the game):
  - **#3:** if not allied, optionally pay **10 bricks + 10 sticks** to ally. **If already allied, receive 10 bricks + 10 sticks for free** (confirmed 2026-04-18).
  - **#20:** if not allied, optionally pay **20 bricks + 20 sticks** to ally (second-chance offer). **If already allied, receive 20 bricks + 20 sticks for free** (confirmed 2026-04-18).
  - Alliance squares are always beneficial once allied — you convert the would-be alliance cost into a free resource reward on every landing.
  - **Sole effect of alliance:** waives the $100 tribute payment at Invasion squares (#7, #28) (confirmed 2026-04-18). **Permanent — alliance cannot be removed** by any card, event, or mechanic.
- **Invasion squares** — forced $100 payment, waived for Kingdom allies. Insolvency uses the unified "cash-first, then item forfeit dialog" rule (revised 2026-04-19) — no dungeon, no Bailiff loss. **Instances:** #7, #28.
- **Money-losing squares** (beyond Invasion):
  - **#11:** Lose $20. Same insolvency rule (cash-first, then forfeit dialog, revised 2026-04-19).
- **Bailiff-granting squares** — landing always transfers the Bailiff to the landing player (from whoever held it, if anyone). If the landing player already holds it, nothing changes. **Instances:** #5, #13, #27.
- **Card-drawing squares** — trigger a card draw for the landing player. Count varies per square:
  - **#15 (Fortune Teller):** draw **1** card.
  - **#23 (Fortune Teller):** draw **3** cards.
- **Discount-while-on-square pattern** — some squares offer a discounted or special-rate purchase. The traders (#8, #29) are limited to **one trade per turn** (revised 2026-04-19) — multiple batches allowed within a single trade, but you can't cycle (shop → trade → shop → trade). Half-price Cleaner (#14) stays unlimited.
  - **#8 (Trader):** $10 for 3 walls (saves $5 per batch vs. $15 baseline). **One trade per turn** while on this square (revised 2026-04-19; previously unlimited).
  - **#14 (Half-price Cleaner):** $10 per Cleaner (vs. $20 baseline). **Waives the ≥1 Room prerequisite** while on the square (confirmed 2026-04-18). Unlimited purchases per turn (no exploit path — cleaners aren't convertible to money).
  - **#29 (Brick Trader):** 10 bricks → $15, in **multiples of 10 only** (no partial batches). **Bricks only** — sticks are never convertible to money (confirmed 2026-04-18). **One trade per turn** while on the square (revised 2026-04-19 — previously unlimited, which enabled a shop/trade money loop). Multiple batches allowed within that one trade. Only exception in the game to the "items cannot be converted to money" rule.
- **Free-item squares** — grant a built item at no resource/money cost:
  - **#2:** free Room.
  - **#19:** free Server. **Waives the ≥1 Room prerequisite** (confirmed 2026-04-18).
  - **#30:** free Building. **Waives all prerequisites** (3 Rooms + Server/Chef/Cleaner) (confirmed 2026-04-18). Counts as a full Building — advances the ladder, satisfies Whole House Cleaner's building requirement, scores 10 points.
  - *Corner #16:* "10 bricks or 1 wall" — the wall option grants a free item.
- **"Roll again" mechanic (#24)** — landing on #24 triggers an **immediate re-roll** (revised 2026-04-19 after playtest round 2). Both rolls distribute resources to every player, but the roller only gets **one** shop/build/trade phase, after the 2nd roll's square effect. The whole #24 sequence counts as **one** base turn for the end-game equal-turns tally, and Worker/WHC passives fire exactly once (at the start of roll 1, not re-fired on the re-roll). Chains theoretically but unreachable with a d6 from #24. Dungeon interaction is a non-concern.
- **Big resource bonus squares** — free resource pickups (every landing, repeatable):
  - #4 (10 bricks + 10 sticks), #6 (100 bricks), #9 (100 sticks), #12 ($100), #17 (100 sticks), #18 ($75), #21 (100 bricks + 50 sticks), #22 ($50), #26 (100 bricks).

---

## 2. Players

- **Supported count:** 2–6 (confirmed 2026-04-18).
- **Platform roadmap:**
  - **Phase 1 — Hotseat:** one browser/device, players pass the device around.
  - **Phase 2 — Networked:** each player on their own device with a server syncing state.
- **Starting state:** Zero of every resource and item. **All players start at square #1 (Start)** (confirmed 2026-04-18).
- **Turn order (confirmed 2026-04-18):** each player rolls the die at game start; **highest roll goes first**, then turns proceed **clockwise around the table**. Ties re-roll.
- **Initial resource-card mapping (confirmed 2026-04-18):** all players pick their initial mapping **simultaneously, hidden**, then all mappings are **revealed at once** before turn 1 begins. Mappings are public for the rest of the game.

---

## 3. The Die

- **One standard 6-sided die** (confirmed 2026-04-18).
- Only one die is ever rolled (so there are no "doubles" — this matters for Dungeon escape).

---

## 4. Resources & the Resource Card

- **Six outcomes on the resource card:**
  1. 5 sticks
  2. 5 bricks
  3. 10 bricks
  4. $5
  5. $10
  6. **Draw a card** *(replaces the originally-planned "2 sticks")*
- **Mapping:** Each player has their own resource card — a one-to-one mapping from die faces (1–6) to the six outcomes above.
- **Visibility:** Mappings are **visible to all players** (public, not secret).
- **Initial mapping:** Each player picks their own mapping **at game start**. (User's opening description: the mapping is how "every player gets certain resources" from the rolled number — e.g., "$10 correspond[s] with the 3 being rolled and the $5 correspond[s] with the 4 being rolled.")
- **Changing the mapping mid-game:** **Passing or landing on the Start square (#1)** (confirmed 2026-04-18: both trigger) lets the player change exactly **one** slot on their resource card AND collect $10.
  - Early rule: "every time you complete the full round trip around the board, you can select which resources correspond with each number."
  - Refinement (via corner #1's effect): it's "change 1 resource," not re-pick the whole mapping.
  - **Implementation (2026-04-18):** because all six outcomes must stay one-to-one, "changing one slot" is a **swap** — choosing a new outcome for face A automatically trades it with whichever face currently holds that outcome. The card's permutation invariant is preserved. This is the only natural reading of "change 1 slot" that keeps all 6 outcomes unique.
- **Distribution on each roll:** When any player rolls, **every player** (including the roller) gains the outcome their own mapping assigns to the rolled number. If the outcome is "Draw a card," that player draws a card.
- **Multi-player "Draw a card" on one roll (confirmed 2026-04-18):** if multiple players have "Draw a card" mapped to the rolled number, **all of them draw**. Draw order is **clockwise starting from the current turn's roller**. Example: on Player 3's turn, if Players 3, 4, 1, and 2 all have "draw a card" at the rolled position, Player 3 draws first, then Player 4, then Player 1, then Player 2. Each drawn card resolves fully before the next player draws (so a Card #18 "Get the Bailiff" could change who holds the Bailiff mid-sequence, etc.).

---

## 5. Turn Structure (in order)

1. **(If the roller holds the Bailiff from a prior turn)** — before rolling, the roller may use the Bailiff to steal one of: 1 wall, 1 roof, 5 bricks, 5 sticks, or $5 from any one opponent. Steal is optional.
2. **Roll** the die.
3. **Every player** gains resources per their own resource card, based on the rolled number.
4. **Roller advances** clockwise by the rolled number of squares.
5. **Roller triggers** the effect of the square they land on. **(If the landed square is #24 "Roll again")** — skip straight to step 2 for a second roll in the same turn sequence; the rest of this step list runs off the 2nd landing. See §1 #24 for the details.
6. **(If the roller's token now shares a square with one or more other players)** — a mandatory **same-square duel** resolves (see Section 13).
7. **(If the roller acquired the Bailiff on this turn — via the square they just landed on, or from a card drawn this turn)** — the roller may use the Bailiff to steal once, *after* rolling. (This is the only turn the Bailiff can act post-roll.)
8. **Roller's optional actions** — on their turn only, in any order the roller chooses. Fires **once** per turn sequence, after the final roll's square effect (so #24 landings skip this step on the 1st roll and run it after the 2nd roll). **No per-turn limits** (confirmed 2026-04-18): the roller may buy any number of items, do any number of 2:1 bricks↔sticks trade-ins, trade any number of 10-brick batches at #29 (while on that square), and build as much as their resources allow.
   - **Buy** items at the central shop
   - **Trade-in** resources (bricks ↔ sticks at 2:1; bricks → money at #29)
   - **Build** (consume resources to produce walls/roofs/rooms/buildings/etc.)
- **Inter-player trading is NOT allowed** right now (user flagged "right now we don't think the players can trade with each other" — may revisit later).

### Turn caveats (confirmed 2026-04-18)

- **Dungeon entry mid-turn:** When a player lands on #10 and is sent to the dungeon, they **finish their current turn normally** — they still get optional actions (buy/trade/build) on that turn. Dungeon restrictions only start on their next turn.
- **Dungeon release turn:** The release turn (rolling a 1, or hitting the 3rd in-dungeon turn) is **forfeit after release** — no optional actions on that turn. The player's next turn is fully normal.

---

## 6. Central Shop (available only on your own turn)

| Item | Cost | Prerequisites | Points |
|------|-----:|---------------|-------:|
| Brick | $1 each | — | — |
| Stick | $1 each | — | — |
| Worker | $50 | — | **5** (revised 2026-04-19) |
| Server | $15 | ≥ 1 Room, Building, 3-Story, or Palace (revised 2026-04-19) | 5 |
| Chef | $30 | ≥ 1 Room, Building, 3-Story, or Palace (revised 2026-04-19) | 10 |
| Cleaner | $20 | ≥ 1 Room, Building, 3-Story, or Palace (revised 2026-04-19) | 5 |
| Knight | **$75** | **None** — purchasable anytime on your turn (added 2026-04-19) | **5** |
| Queen | $300 | **None** — purchasable anytime on your turn (confirmed 2026-04-18) | 200 |

**Important notes:**

- **Worker:** Every turn you own a Worker, you automatically gain **either 2 walls OR 1 wall + 1 roof** (player's choice each turn) — no resource cost (confirmed 2026-04-18). **Output is always taken — you cannot skip it** (confirmed 2026-04-18); the only decision is the 2-walls vs 1-wall-1-roof choice. Worth 0 points at game end — purely a game-accelerator. **Multiple Workers stack** (confirmed 2026-04-18): each Worker independently produces its output per turn (so 2 Workers → two independent picks per turn). **Timing (confirmed 2026-04-18):** the output fires at the **start of the owner's own turn**, before the roll, so the walls/roofs are available to spend during optional actions. **No benefit on the acquisition turn** — buying a Worker yields no output that turn; the first payout is the next time that player's own turn begins.
- **Whole House Cleaner:** **Not directly purchasable** (confirmed 2026-04-18). The only acquisition path is the auto-conversion: every 5 Cleaners you own **are consumed and transformed** into 1 Whole House Cleaner (confirmed 2026-04-18), and you must own at least 1 Building for the conversion to be allowed. Example: 10 Cleaners + 1 Building → 2 WHCs + 0 Cleaners. **Active ability: +$15 passive income on your own turn only** (confirmed 2026-04-18) — once per round, not every player's turn. **Timing (confirmed 2026-04-18):** the income fires at the **start of the owner's own turn**, same as Worker output. **No benefit on the conversion turn** — the 5-Cleaner → WHC auto-conversion pays no $15 that turn; the first payout is the next time that player's own turn begins. **Multiple WHCs stack** (confirmed 2026-04-18): 2 WHCs → $30/turn, 3 WHCs → $45/turn, etc.
- **Knight (added 2026-04-19):** **Protects from the Bailiff absolutely** — while you own a Knight, the Bailiff can never pick you as a steal target (silent no-op if attempted; the holder's once-per-turn flag is not consumed). **Max 1 Knight per player** (second purchase rejected). **Permanent once acquired** — a Knight cannot be removed by any card, event, or other mechanic. **Acquisition path: shop only** — no card or square grants a Knight. Tiebreaker staff weight: 1.
- **Queen (revised 2026-04-19):** Pure scoring piece — 200 points and tiebreaker weight 10. **Max 1 Queen per player** (confirmed 2026-04-18). **Permanent once acquired** (confirmed 2026-04-18) — a Queen cannot be removed by any card, event, or other mechanic. **No longer grants Bailiff immunity (revised 2026-04-19)** — that role moved to the Knight.
- **"Purchase" ambiguity:** User used the word "purchase" for acquiring Buildings and Three-story buildings, but those are produced by the construction ladder (Section 7) from owned resources and don't have a stated dollar price. Treat these as **construction** actions (not shop purchases) unless the user clarifies otherwise.
- **Staff Room prereq (revised 2026-04-19):** the "≥ 1 Room" prereq on Server / Chef / Cleaner is satisfied by any Room-or-higher — Room, Building, Three-Story Building, or Palace. Since Rooms get consumed when building up the ladder (4 walls + 1 roof → Room → consumed into a Building), a player with e.g. 1 Three-Story + 2 Buildings has zero raw Rooms but has built 15 Rooms' worth of construction; the prereq stays satisfied. Any construction tier at or above Room proves the player has owned a Room.

### Trade-in (only on your turn)

- **Cannot** sell bricks or sticks for money in the general case. **One exception:** while a player's token is on **square #29 ("Trader")**, they may trade **10 bricks → $15** (scalable — e.g., 30 bricks → $45), repeatedly. **Bricks only** — sticks are never convertible to money (confirmed 2026-04-18). This is the only place in the game where a resource/item can be converted back to money.
- **Cannot** convert built items — walls, roofs, rooms, buildings, three-story buildings, palaces, staff (Server/Chef/Cleaner/Queen/Whole House Cleaner), or Worker — into money under any circumstance. Items are one-way acquisitions.
- **Can** trade bricks ↔ sticks at a **2:1** ratio on any of the roller's turns (not tied to a specific square).
  - Example: 10 bricks → 5 sticks, or 10 sticks → 5 bricks.
  - **Batches of 10 only** (confirmed 2026-04-18): the minimum trade-in is 10 of the source resource, and all trades are in multiples of 10. So 10 → 5, 20 → 10, 30 → 15, etc. Smaller batches (e.g. 2 → 1) are not allowed — since bricks and sticks are themselves bought in bundles of 5, the smallest meaningful trade is a whole bundle-worth.

---

## 7. Construction Ladder (build using owned resources)

Each step consumes the inputs and yields the output.

| Output | Cost (direct) | Total bricks + sticks |
|--------|---------------|------------------------|
| Wall | 5 bricks | 5 bricks |
| Roof | 5 sticks | 5 sticks |
| Room | 4 walls + 1 roof | 20 bricks + 5 sticks |
| Building | 3 rooms | 60 bricks + 15 sticks |
| Three-story building | 3 buildings | 180 bricks + 45 sticks |
| Palace | 3 three-story buildings | **540 bricks + 135 sticks** |

### Prerequisites layered on top of the ladder

- **Building:** requires owning **at least 1 Server, Chef, Cleaner, OR Whole House Cleaner** (any one) (revised 2026-04-19).
- **Three-story building:** requires owning **at least 1 Server AND 1 Chef AND 1 Cleaner (or Whole House Cleaner)** (revised 2026-04-19 — WHC counts as a Cleaner for prereq purposes).
- **Whole house cleaner:** requires owning **at least 1 Building** at the time the 5-cleaner auto-conversion happens. (The auto-conversion itself still needs 5 **raw** Cleaners — a WHC does not count as "5 Cleaners" for triggering another conversion.)
- **Why WHC counts for the Cleaner prereq (revised 2026-04-19):** a WHC is built out of 5 consumed Cleaners + 1 Building, so any WHC holder has necessarily once owned Cleaners. Treating a WHC as a Cleaner for construction prereqs keeps the ladder progressing naturally once the first WHC is earned.
- **Palace:** no staff prerequisite — just 3 Three-Story Buildings (confirmed 2026-04-18).

---

## 8. Points (final scoring table)

| Item | Points |
|------|-------:|
| Room | 5 |
| Building | **20** (revised 2026-04-19; previously 10) |
| Three-story building | **75** (revised 2026-04-19; previously 20) |
| **Palace** | **300** (revised 2026-04-19; previously 250) |
| Server | 5 |
| Chef | 10 |
| Cleaner | 5 |
| Whole house cleaner | 50 |
| **Queen** | **200** |
| **Knight** | **5** (added 2026-04-19) |
| Worker | **5** (revised 2026-04-19; previously 0) |

- **Unassembled walls and roofs** (not yet part of a Room) score **0 points** (confirmed 2026-04-18).
- **Unspent resources** (bricks, sticks, cash) at game end score **0 points** (confirmed 2026-04-18).
- **Scoring rule:** only the items listed in the table above contribute to the final score. Everything else is worth zero.

---

## 9. The Bailiff

- **Exactly one Bailiff** exists in the game (confirmed 2026-04-18) — never multiple, never zero once in play. Held by at most one player at a time, or sits in the middle of the board if unheld.
- **Effect:** On a turn the holder has the Bailiff, they **may** (optional) steal **one** of the following from any one opponent of their choice: **1 wall, 1 roof, 5 bricks, 5 sticks, or $5**. Holder picks both the target and the item. **Opponents who own a Knight are immune (revised 2026-04-19)** — they cannot be selected as a target (a steal attempt against a Knight-holder is a silent no-op; the holder's once-per-turn flag is not consumed). The Queen no longer grants Bailiff immunity. **Empty target (confirmed 2026-04-18):** if the holder opts to steal and commits to a target who has no stealable items (no walls, no roofs, <5 bricks, <5 sticks, <$5), the steal **fails silently** — no re-pick, the steal opportunity is spent. (The holder should verify targets before committing.)
- **Once-per-turn cap, including extra turns (confirmed 2026-04-18):** the Bailiff steal fires at most **once per turn sequence**, regardless of #24 extra turns. A Bailiff-holder who rolls #24 does NOT get a second steal on their extra turn.
- **Timing:**
  - **Default**: steal happens **before the roll**.
  - **Exception (revised 2026-04-19):** on the turn the Bailiff is first acquired, the steal happens once after the roll — timing depends on HOW it was acquired:
    - **Acquired via a drawn card (resource-card face = "draw-card", card #18 drawn):** steal fires **after the roll's card draws but BEFORE movement**. This prevents a movement-driven loss (e.g. landing on #10 and being sent to the dungeon, which strips the Bailiff) from voiding the steal opportunity. Previously the steal was offered after movement, which could deprive the player of their one steal entirely.
    - **Acquired via a Bailiff square (#5, #13, #27):** steal fires **after movement and the square's effect**, as before. The square itself is the acquisition point, so "after" is simply "after the square effect."
  - Either path fires **at most once** per turn sequence; the once-per-turn-sequence cap (next bullet) is absolute.
- **Acquisition:** Landing on **square #5, #13, or #27** OR drawing **Card #18 ("Get the Bailiff")**.
- **Loss:** Another player lands on the corresponding square OR draws the corresponding card. Additionally, **any time the Bailiff-holder is sent to the dungeon, they lose the Bailiff** — via square #10 ("Royal Court"). The Bailiff returns to the middle of the board. (Revised 2026-04-19: the prior exception for Invasion-square insolvency (#7, #28) was removed when those squares stopped sending players to the dungeon.)
- **Unheld Bailiff location:** sits in the **middle of the board** (confirmed 2026-04-18) — unused until a player first acquires it by landing on a Bailiff-granting square (#5, #13, #27) or drawing a Bailiff card.

---

## 10. Dungeon

- **Entry triggers (revised 2026-04-19):**
  - Landing on **square #10** ("Royal Court") — every player who lands goes to the dungeon. **This is the only path to the dungeon.**
  - **Invasion-square insolvency (#7, #28) no longer sends to the dungeon.** Previously an exception to the default forfeit-cash rule; now unified under the standard "cash-first, then forfeit dialog" rule (§1 Money fees & insolvency).
  - **No card sends players to the dungeon** (confirmed 2026-04-18 after card deck capture — no such card exists in the 18-card deck).
- **Location while imprisoned:** **Square #25** ("Dungeon or Just Passing").
- **Restrictions while imprisoned:**
  - Cannot **move** (token does not advance on own rolls)
  - Cannot **trade-in** resources
  - Cannot **buy** resources or items
  - Cannot **build**
  - Cannot **steal with the Bailiff** — in fact, **entering the dungeon causes the player to lose the Bailiff** (confirmed 2026-04-18), so this is moot.
  - **Passive abilities are suspended** (confirmed 2026-04-18) — Worker does NOT produce walls/roofs while imprisoned; Whole House Cleaners do NOT pay out $15/turn while imprisoned. **Implementation:** passives fire at the start of the owner's own turn; the turn-start check skips the payout if the owner is in the dungeon at that moment. These abilities resume on the next own-turn where the player is no longer imprisoned (a redemption via Royal Pardon counts — a full normal turn begins, and passives fire).
  - **Still receives** resources from other players' rolls per the resource-card mapping (the only thing that still flows in).
- **Imprisoned player's own turn:** Imprisoned player **still rolls** the die. All players receive resources from that roll. The imprisoned player does not advance their token. The roll is also checked for the release condition (rolling a 1).
- **Release conditions:**
  - **Roll a 1** on any of the 3 dungeon turns, OR
  - Automatically released on the **3rd turn** regardless of roll.
- **On release:** Player moves to "Just Passing" (square #25) but **does NOT advance further** on that release turn. **Release turn is otherwise forfeit** (confirmed 2026-04-18) — no optional actions (buy/trade/build) on the release turn. The next turn is fully normal.
- **Dungeon entry mid-turn:** When a player lands on #10, they **complete their current turn normally** (confirmed 2026-04-18), including optional actions. Dungeon restrictions only apply starting on their next turn.

---

## 11. Cards

- **One deck** of **18 cards total** — 1 of each card type (confirmed 2026-04-18).
- **Drawn when:**
  - The roller's own resource card maps the rolled number to "Draw a card" — roller draws.
  - A player lands on a card-drawing square: **#15** (draw 1 card), **#23** (draw 3 cards).
- **Deck mechanics** (confirmed 2026-04-18): drawn card's effect resolves, then the card goes to a **discard pile**. When the draw pile empties, the **discard pile is reshuffled** into a fresh draw pile.
- **Persistent cards** — Card #17 ("Get out of dungeon") is held in the player's hand indefinitely after drawing and moves to the discard only on redemption (see Card #17 below). All other cards resolve and discard immediately.
- **Compound triggers** (confirmed 2026-04-18): **all triggers stack**. If a player rolls "Draw a card" AND lands on a card-drawing square, they draw once per trigger — e.g., roll "Draw a card" + land on #23 = 4 total cards drawn (1 from the roll + 3 from #23).

### Card types (captured 2026-04-18)

| # | Card | Effect |
|---|------|--------|
| 1 | **Get $50** | Gain $50. |
| 2 | **Get a Building** | Gain 1 Building for free. **Waives all prereqs** (confirmed 2026-04-18) \u2014 consistent with square #30. Counts as a full Building (advances ladder, satisfies WHC requirement, scores 10 points). |
| 3 | **Get $20** | Gain $20. |
| 4 | **Get 50 bricks** | Gain 50 bricks. |
| 5 | **Get $100** | Gain $100. |
| 6 | **Get $75** | Gain $75. |
| 7 | **Get a Server** | Gain 1 Server for free. **Waives the ≥1 Room prereq** (confirmed 2026-04-18). |
| 8 | **Get a Cleaner** | Gain 1 Cleaner for free. **Waives the ≥1 Room prereq** (confirmed 2026-04-18). |
| 9 | **Get a Chef** | Gain 1 Chef for free. **Waives the ≥1 Room prereq** (confirmed 2026-04-18). |
| 10 | **Get a Room** | Gain 1 Room for free. (Consistent with square #2.) |
| 11 | **Get $60** | Gain $60. |
| 12 | **Get 50 sticks** | Gain 50 sticks. |
| 13 | **Get 50 bricks + 50 sticks** | Gain 50 bricks and 50 sticks. |
| 14 | **Be allies with the Neighboring Kingdom** | **If not allied:** become allied with the Neighboring Kingdom for free (skip the 10b+10s or 20b+20s cost of squares #3/#20). **If already allied:** receive **$50** (confirmed 2026-04-18). |
| 15 | **Get 75 bricks** | Gain 75 bricks. |
| 16 | **Draw another card** | Draw one more card from the deck immediately. **Chains indefinitely** (confirmed 2026-04-18): if the new card is also #16 (possible after reshuffle), keep drawing. |
| 17 | **Royal Pardon** (escape the dungeon) | Held in the player's hand **indefinitely** after drawing (persistent card). **Redeemed BEFORE rolling on a dungeon turn** (confirmed 2026-04-18), skipping the roll entirely. After redemption, the player takes a **full normal turn**: roll the die (resources distributed to all), move, trigger the square's effect, and take full optional actions (buy/trade/build). Strictly better than natural release (which only moves to Just Passing with no further actions). Only 1 copy exists in the deck, so a player can hold at most one at a time. |
| 18 | **Get the Bailiff** | Acquire the Bailiff. Standard transfer rule applies (if someone else has it, it transfers to you; if no one has it, it comes off the middle of the board to you). |

**Observation:** Many cards mirror specific square effects (e.g., "Get a Building" mirrors #30; "Get a Room" mirrors #2; "Get the Bailiff" mirrors #5/#13/#27; "Be allies with the Neighboring Kingdom" mirrors #3/#20). Cards provide alternative paths to the same outcomes.

---

## 12. Win Condition

- **Trigger:** The first player to **build a palace** begins the end-of-game sequence.
- **End condition:** The game ends at the end of the current round, once **every player has had the same number of turns**.
  - **User's example:** In a 4-player game, if Player 2 finishes their palace, Players 3 and 4 each take one more turn, then the game ends.
- **Winner:** The player with the **highest point total** at game end.
- **Implication:** The palace builder is **not automatically the winner** — another player could out-score them via multiple Buildings, Three-story buildings, Queens, etc. during the final turns.
- **Multiple palaces in the final round:** allowed — each Palace adds 300 points to that player's total (confirmed 2026-04-18; point value revised 2026-04-19).
- **Tiebreaker (confirmed 2026-04-18; Knight added 2026-04-19):** if two or more players tie for the highest point total, the tie is broken by **total staff count**, where:
  - **Queen** = 10 staff
  - **Whole House Cleaner** = 5 staff
  - **Worker, Server, Chef, Cleaner, Knight** = 1 staff each
  - If still tied on staff, the player with the **most cash** wins.
  - If still tied after both staff and cash, *TBD* (rare enough to revisit during playtest if it happens).

---

## 13. Same-square duel (confirmed 2026-04-18)

When a player **arrives via movement** on a square where one or more other players' tokens already sit, a **same-square duel** is triggered. The duel is **mandatory** — it cannot be declined.

**"Landing" means arriving via movement** (confirmed 2026-04-18) — not starting there. At game start, all players begin on #1 together, and **no duel happens** on turn 1 when Player 1 moves off. Duels only trigger when a token arrives at an occupied square through normal clockwise movement.

### Sequence

1. The square's normal effect fires first for the arriving player (e.g., "Get 100 bricks" is awarded before the duel).
2. The **arriving (most recent) player** chooses the stake — any combination of:
   - A dollar amount
   - A number of bricks
   - A number of sticks
   - A number of walls, roofs, or rooms (usable as item-stakes if a player can't meet the minimum with money/bricks/sticks)
3. **Minimum stake:** at least **$5, or 5 bricks, or 5 sticks** (or an item equivalent — see below).
4. **Item-stake equivalents** (confirmed 2026-04-18): a player can stake items instead of / in addition to cash/bricks/sticks. Equivalents are **flexible** — the staker chooses which equivalence applies based on what the stake is denominated in:
   - **1 wall** = **5 bricks** OR **$5**
   - **1 roof** = **5 sticks** OR **$5**
   - **1 room** = **20 bricks + 5 sticks** OR **$25** (inferred from shop rates — confirm if asked)
   - Example: if the stake is "$5" and you lack cash, put in 1 wall (valued at $5). If the stake is "5 bricks" and you lack bricks, put in 1 wall (valued at 5 bricks).
   - **This flexible conversion applies only within duels** — items still cannot be converted to money or other resources outside the duel context.
5. **Stake must be matchable by every player on the square** (using any mix of cash, bricks, sticks, walls, roofs, or rooms). If any co-located player can't contribute, the **arriver must lower the stake** until everyone can match (subject to the minimum).
6. Each player on the square contributes the stake into a shared pot.
7. Each player on the square rolls the die.
8. **Highest roll wins the entire pot** (from all participants).
9. **Ties for highest** → tied players re-roll until a sole winner emerges.

### 3+ players

All co-located players participate simultaneously in a single pot. One die roll per player; single highest-roller takes the whole pot.

### Duel edge cases (mostly resolved)

- **Insufficient funds** — largely resolved by the item-stake equivalents (walls/roofs/rooms can substitute for cash/bricks/sticks). A player with any assets can stake something. A fully-broke player (zero cash, zero resources, zero items) is an edge case that's unlikely to occur in practice once play has started. *Implicit: if truly no one can meet minimum, the duel can't proceed — confirm if needed.*
- **Cascade** — if a new player later arrives at the same square via a subsequent turn (e.g., via #24 extra turn from a different player), a fresh duel triggers with the new arriver per the same rules.
- **Duel die roll** is separate from the turn's main roll (which distributes resources). The duel roll only determines the duel winner.

---

## 14. Implementation plan (confirmed 2026-04-18)

### Product direction

- **Official title:** *The Perfect Palace*.
- **Primary audience:** an 11-year-old girl (plus family members). Design should feel welcoming and fun for that audience while remaining playable for adults.
- **Visual style:** **clean, minimal flat design** with **palace-themed accents** (motifs like crowns, turrets, regal color palette) woven in — not ornate or heavy, but enough personality to match the title and audience.
- **UX priority:** buying, trading, and exchanging resources/items must feel **very easy** — low-friction UI for the shop, trade-in dialogs, duel staking, and the resource card.
- **Accessibility:** family-friendly defaults — readable body text (≥16px), generous click targets, high-contrast palette, no formal WCAG AA requirement.

### UX principles (confirmed 2026-04-18)

- **Show all actions, disable unavailable ones with a tooltip explanation.** Every buyable/buildable item always appears in the UI; items the player can't currently acquire are disabled with a tooltip explaining why (e.g., "Needs ≥1 Room to buy a Server"). This teaches the rules instead of hiding them.
- **Progress bars for building goals, raw counters for resources.** Building-toward-palace (and intermediate tiers) is shown as a progress bar (e.g., "Palace: 245 / 540 bricks"). Resource inventories (bricks, sticks, cash) show raw numbers.
- **Glanceable role icons above player tokens.** The Bailiff-holder shows a Bailiff icon above their token on the board. Knight-owners show a 🛡 badge; Queen-owners show a 👑 badge. Always visible without clicking. (Knight added 2026-04-19.)
- **Rules sheet / help page instead of tutorial (for MVP).** No step-by-step tutorial in Phase 1. A help modal summarizes all rules; players can open it anytime.
- **Duel UI walks the arriver through the stake input step-by-step** — stake type picker, minimum enforcement, matchability check, item-equivalent conversion all handled by the UI (the player should never do math).

### Theme / naming (confirmed 2026-04-18)

The game's narrative framing leans medieval / palace to match the title and audience:

| Internal mechanic | In-game name / framing |
|-------------------|------------------------|
| Robber token | **The Bailiff** (old-English tax collector flavor) |
| Jail | **The Dungeon** |
| Corner #10 | "The Royal Court finds you guilty — to the dungeon!" |
| US Alliance | **Kingdom Alliance** with the **Neighboring Kingdom** |
| War squares (#7, #28) | "Invading armies demand tribute!" |
| Tribute/war payment | "tribute" |
| Card #17 (Get out of jail) | **Royal Pardon** |

### Tech stack

- **Framework:** **React + TypeScript**, built with **Vite**.
- **Styling:** TBD (likely Tailwind or CSS modules) — decide during scaffolding.
- **State management:** TBD (likely `useReducer` + context for game state; consider Zustand if it grows).
- **Persistence (Phase 1):** **localStorage** — auto-save on every turn + **manual named save/load slots**.
- **No accounts in Phase 1.**
- **Audio/animations:** optional polish for later; not MVP.

### Phases

- **Phase 1 (MVP):** hotseat on one device. One browser window, players pass the device around. All rules implemented.
- **Phase 2 (later):** networked multiplayer. Backend stack deferred — decide when Phase 1 is solid.

### Quitting / resignation (confirmed 2026-04-18; Quit button added 2026-04-19)

- **Default behavior: pause + auto-save + resume when the player returns.** If the browser is closed mid-game, the save auto-restores on reopen. Hotseat naturally pauses between turns anyway.
- **Named save slots (added 2026-04-19):** the sidebar `💾 Save / Load` button opens a modal for creating, loading, and deleting named saves. 20-slot cap per device. Named saves survive a full-game reset; only the single rolling `tpp:autosave` key is cleared.
- **Quit Game (added 2026-04-19):** the sidebar `🏳 Quit Game` button abandons the current game and returns to the setup screen. Confirmation modal warns that the autosave will be cleared; a `Save first…` shortcut routes to the save slots modal. Named saves are untouched.
- **Opt-in "remove player" action (UI added 2026-04-19):** each row in the sidebar's Players list has a ✕ button. A confirm dialog asks before dispatch. On removal:
  - The removed player's Bailiff (if held) returns to the middle of the board.
  - The removed player's cash, resources, and items (including any Royal Pardon card in hand) leave the game.
  - The game continues with the remaining players in the same turn order, skipping the removed player's slot.
  - **Auto-game-over (added 2026-04-19):** if the removal leaves **≤ 1** non-removed player, the game ends immediately. The lone survivor (if any) wins by default — the scoreboard still tallies scores from current inventories.
  - **Phase gating:** the ✕ button is disabled during unstable phases (`duel`, `pre-move-bailiff`, `post-roll-bailiff`, any `square-effect` with a pending decision) to avoid corrupting in-flight state. Safe phases are `turn-start` and `optional-actions`.
- **Save portability:** localStorage only (confirmed 2026-04-18) — saves live on the device; no export/import in Phase 1.

### Pacing

- **Target game length:** **medium (45–90 minutes)** for a typical game.
- Current resource economy (palace = 540 bricks + 135 sticks) is tuned toward that range. Expect to **fine-tune during playtest** — starting resources, square rewards, or palace cost may shift.

### Suggested scaffold order (not a final implementation plan — just a rough order)

1. Scaffold Vite + React + TS project.
2. Build the board layout (30 squares, corners, clickable).
3. Player turn loop: roll → distribute resources → move → square effect → optional actions.
4. Shop UI (buy/trade/build) — prioritize ease-of-use.
5. Resource card UI (per-player, visible to all).
6. Dungeon logic (entry, in-dungeon turn, release).
7. Bailiff logic (acquisition, steal, Queen protection).
8. Card deck (draw, discard, reshuffle; persistent Card #17).
9. Same-square duel UI (stake entry, roll-off, item-stake equivalents).
10. Win condition + end-game tally.
11. Save/load slots in localStorage.
12. Playtest loop with daughter. Tune pacing as needed.

---

## Open items / TBD

### A. Board content
1. ~~**The 26 non-corner squares**~~ ✓ **Captured 2026-04-18** (see Section 1).
2. ~~**Card deck**~~ ✓ **Captured 2026-04-18:** 18 cards, 1 of each type (see Section 11). Discard-pile mechanics, compound-trigger stacking, and Card #17 persistence all confirmed.
3. ~~**Which squares give/remove the Bailiff**~~ ✓ **Captured 2026-04-18:** Bailiff-granting squares are **#5, #13, #27**. The Bailiff is lost either by being transferred (another player lands on one of those squares) or by landing on corner **#10** (which also sends the holder to dungeon).
4. ~~**Which squares trigger "draw a card"**~~ ✓ **Captured 2026-04-18:** #15 (draw 1 card), #23 (draw 3 cards). Plus the "Draw a card" outcome on the resource card.

### B. Rules clarifications on things already discussed
5. ~~**Lap re-mapping timing**~~ ✓ **Resolved 2026-04-18:** both passing AND landing on Start trigger the $10 and the 1-resource change.
6. ~~**Queen prerequisites**~~ ✓ **Resolved 2026-04-18:** no prereqs — purchasable anytime on your turn for $300.
7. ~~**Staff abilities**~~ ✓ **Resolved 2026-04-18:** Queen protects from Bailiff; Whole House Cleaner +$15/turn; Worker +2 walls OR +1 wall + 1 roof/turn (choice). Server, Chef, Cleaner have no in-game ability.
8. ~~**"Purchase" vs "build" for Building and Whole House Cleaner**~~ ✓ **Resolved 2026-04-18:** confirmed as non-shop actions. Buildings are **built** (construct from 3 Rooms + ≥1 Server/Chef/Cleaner prereq). Whole House Cleaners are only acquired via **5-Cleaner auto-conversion** (requires ≥1 Building). Neither has a shop money price.
9. ~~**Whole house cleaner direct purchase**~~ ✓ **Resolved 2026-04-18:** no direct-purchase path. The only way to acquire a Whole House Cleaner is the 5-Cleaner auto-conversion (requires ≥1 Building).
10. ~~**Worker — automatic or optional?**~~ ✓ **Resolved 2026-04-18:** fully automatic each turn. Player cannot skip the Worker's output. The only choice is 2 walls vs 1 wall + 1 roof each turn. (Revised output: 2w OR 1w+1r, not the simple 1+1 previously recorded.)
11. ~~**Worker's output counts toward building**~~ ✓ **Resolved 2026-04-18:** Worker-produced walls/roofs are identical to resource-built ones and can be used in Room construction normally.
12. ~~**Palace staff prerequisite**~~ ✓ **Resolved 2026-04-18:** none — just 3 Three-story Buildings.
13. ~~**Loose walls/roofs scoring**~~ ✓ **Resolved 2026-04-18:** score 0 points (only items in the Section 8 table count).
14. ~~**End-game resource scoring**~~ ✓ **Resolved 2026-04-18:** unspent bricks/sticks/cash score 0 points.
15. ~~**Max simultaneous items**~~ ✓ **Resolved 2026-04-18:** Queen is **capped at 1 per player**. All other items (Workers, Whole House Cleaners, Servers, Chefs, Cleaners, Buildings, Three-story Buildings, Palaces) are **uncapped** — a player can own as many as their resources allow, and Worker/WHC abilities stack.
16. **Square #16 balance** — "10 bricks OR 1 wall" — 10 bricks (= 2 walls' worth) is strictly better than 1 wall. Is the wall option intended as a convenience (skip the build step), or is this a balance oversight?

### C. Edge cases and flow
17. ~~**Bailiff token when unheld**~~ ✓ **Resolved 2026-04-18:** sits in the middle of the board, unused, until first acquired.
18. ~~**Bailiff quantity**~~ ✓ **Resolved 2026-04-18:** exactly one Bailiff exists in the game. Always somewhere — either in a player's possession or sitting in the middle of the board.
19. ~~**Dungeon entry mid-turn**~~ ✓ **Resolved 2026-04-18:** the player finishes the current turn normally (optional actions allowed). Dungeon restrictions begin on the next turn.
20. ~~**Dungeon release turn**~~ ✓ **Resolved 2026-04-18:** release turn is forfeit after being moved to Just Passing — no optional actions. Next turn is fully normal.
21. ~~**Landing on square #25 without being imprisoned**~~ ✓ **Resolved 2026-04-18:** nothing happens. "Just Passing" means no effect.
22. ~~**Same-square occupancy**~~ ✓ **Resolved 2026-04-18:** mandatory same-square duel (Section 13) — stake + roll, highest wins pot. Items can be staked as equivalents when cash/resources are short.
23. ~~**Card drawing edge cases**~~ ✓ **Resolved 2026-04-18:** cards resolve then go to discard pile; when draw pile empties, discard is reshuffled back into draw pile. Compound triggers stack (roll "draw a card" + square trigger = both draws). Persistent cards: only Card #17 (Get out of dungeon) is held in hand; it discards on redemption. All other cards resolve and discard immediately.
24. ~~**Game start — Bailiff holder**~~ ✓ **Resolved 2026-04-18:** Bailiff starts in the middle of the board, unheld, until a player acquires it.
25. ~~**Game start — starting square**~~ ✓ **Resolved 2026-04-18:** all players begin on square #1.
26. ~~**Multiple palaces in final round**~~ ✓ **Resolved 2026-04-18:** no caps on Palaces per player, so yes — each Palace (from any player) adds 300 points (revised 2026-04-19; previously 250) to that player's score at game end.
27. ~~**Order of optional on-turn actions**~~ ✓ **Resolved 2026-04-18:** any order, **no per-turn limits** on buy / trade-in / build. The roller can interleave freely and do each action any number of times.

### D. Product / tech
28. ~~**UI/UX direction**~~ ✓ **Resolved 2026-04-18:** clean, minimal flat design with palace-themed accents; targeting an 11-year-old girl + family; family-friendly defaults.
29. ~~**Tech stack**~~ ✓ **Resolved 2026-04-18:** React + TypeScript + Vite. Persistence = localStorage + manual named save/load slots. No accounts in Phase 1.
30. ~~**Game length expectations**~~ ✓ **Resolved 2026-04-18:** target medium (45–90 min); will fine-tune during playtest; UX priority on easy buy/trade/exchange.
31. ~~**Accessibility**~~ ✓ **Resolved 2026-04-18:** family-friendly defaults (readable text ≥16px, high-contrast palette, generous click targets). No formal WCAG AA requirement.

---

## Ready to build

All rules and product/tech decisions are locked. Remaining note:
- **Item 16:** Square #16 balance observation (10 bricks vs. 1 wall) — not a blocker; revisit during playtest if needed.

Suggested next step: exit plan mode and begin scaffolding (see Section 14 for scaffold order).

---

*Rules capture: 2026-04-17 evening (start) → 2026-04-18 (complete). Board + 26 non-corner squares + 4 corners + 18-card deck + duel + all mechanics + implementation plan.*
