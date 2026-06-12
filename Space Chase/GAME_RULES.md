# Space Chase — Game Rules (complete & corrected)

This is the **single source of truth for what the game does**. It is the original brief rewritten
to include everything we learned in play. Where the *current shipped code* differs from these
rules, that difference is called out in **[MECHANICS_AND_RULINGS.md](./MECHANICS_AND_RULINGS.md)**
as a "known issue to fix on rebuild." When rebuilding, **follow this document.**

---

## 1. The board

- **68 positions:** Spaces **1–67** plus the **Finish** (internally position **68**).
- **START** is a separate place **before Space 1** (internally position **0**) — a full-width bar
  below the board where all rockets begin. **START is not Space 1.** "Go back to Start" sends a
  rocket to START (0), *not* to Space 1.
- The path **winds** like a snake (boustrophedon): a 10-wide, 7-tall grid; the bottom row reads
  left→right, the next row right→left, and so on up to the Finish.
- **Theme:** dark space background with twinkling stars and nebula glows; bright, cartoonish,
  neon style. The board is drawn in code — no board image.

### Landmark spaces (visually distinct + labeled)

| Space | Landmark |
|------:|----------|
| 20 | The Space Permit |
| 33 | The Star |
| 46 | The Dice |
| 50 | The Spear |
| 52 | (White Hole destination — labeled "White Hole Dest.") |
| 58 | The Moon |
| 64 | 5:20 |

---

## 2. Portals (traversable shortcuts — NOT instant teleports)

There are **3 portals**. Each connects two board spaces and has a number of **internal spaces**
you travel through. **Portals work in both directions.**

| Portal | Ends | Internal spaces |
|--------|------|----------------:|
| 1 | Space 4 ↔ Space 36 | 7 |
| 2 | Space 28 ↔ Space 61 | 3 |
| 3 | Space 39 ↔ Space 51 | 3 |

**How a portal works:**

- **Landing on either end** (by any means — dice, a card, a teleport) puts your rocket **inside**
  the portal at the entrance.
- On your following turns, your movement carries you **through the internal spaces**.
- **Exiting the far end costs one move.** So a 3-internal-space portal takes **4 moves** to clear
  (3 to cross the internal spaces + 1 to step out the other end). A 7-internal-space portal takes
  **8 moves** to clear.
- **Leftover movement continues on the main board** from the exit space, in the same direction.
- Portals are shown as **glowing dashed curved tunnels** with the internal spaces as dots along
  the curve; your rocket rides the curve as you travel.

> Worked example: you're inside Portal 3 having just entered at **Space 51**, and you move 7.
> 3 moves cross the internal spaces, 1 move exits at **Space 39**, leaving 3 → you continue
> forward to **Space 42**. (Full math in MECHANICS_AND_RULINGS.md.)

---

## 3. Players

- **2 to 5 players.** **2-player is the primary mode.**
- Each player is a **rocket of a distinct bright color**, shown as a colored circle with the
  player's first initial (so they're easy to tell apart even at a glance):
  Player 1 red, 2 blue, 3 green, 4 yellow, 5 purple.
- Turn order is fixed; **Player 1 goes first**.

---

## 4. A turn

On your turn, choose **one**:

1. **Roll the Dice** — roll one die (1–6) and move forward that many spaces. Safe and
   predictable.
2. **Draw a Card** — take the top card of the deck. Could be great or terrible. A gamble.

After the action fully resolves, play passes to the next player — **unless** a card granted you
extra turns, in which case you go again.

- **A card with no useful effect still uses your turn** (e.g. Rocket while you're already in the
  lead, or an attack fully blocked by a shield). No redraw, no refund.

---

## 5. The deck (41 cards, 42 in the pile)

- The deck is **shuffled at the start of every game** (and on every "Play Again") with a true
  random shuffle. Dice rolls are random too.
- **The pile contains 42 cards:** the 41 unique cards **plus a second copy of the "6-7" card**
  (#30), because its special power triggers on your *second* 6-7 (see below).
- When a card is drawn, its **art is shown**, then the effect happens.
- When the pile runs out, **everything is reshuffled** and play continues.

### Movement — forward
| # | Card | Effect |
|--:|------|--------|
| 1 | The Moon | Go forward 5 (zero gravity) |
| 2 | Robotic Planet | Go forward 5 |
| 3 | Space Dragon | Go forward 5 |
| 4 | Space Credit | Go forward 20 |
| 5 | Earth | Go forward 10 |
| 6 | Cosmic Chaos | **Everyone** goes forward 7 |
| 7 | Tidal Wave of Cosmic Dust | **All players** go forward 3 |
| 8 | Rover | All other players go forward 5; **you** go forward 7 |

### Movement — backward
| # | Card | Effect |
|--:|------|--------|
| 9 | Cosmic Thunder | Go back 3 |
| 10 | Asteroid | Go back 3 |
| 11 | Alien Fireball | Go back 7 |
| 12 | Alien Space Craft | You explode! Go back 20 |
| 13 | Time Bomb | Back in time! Go to **START** |
| 14 | Meteor Shower | **Everyone** goes back 5 |
| 15 | Solar Flare | **Each person** goes back 5 |

### Attack — affect other players (you may target **yourself** too, except where noted)
| # | Card | Effect |
|--:|------|--------|
| 16 | Nuclear Bomb | Send someone to **START** |
| 17 | Blaster | Make 1 person go back 3 |
| 18 | Alien Pirate | Choose 1 person to go back 10 |
| 19 | Fighter Jet | Make one player go back 3 **and** you go forward 3 |
| 20 | Black Hole | Teleport one player (**not you**) to any space you choose |
| 21 | Ion Space Bomb | Make one person lose a turn |
| 22 | Space Kraken | Choose: **3 people lose 1 turn** OR **1 person loses 3 turns** |

### Teleport — go to a specific space/landmark
| # | Card | Effect |
|--:|------|--------|
| 23 | White Hole | Go to Space 52 |
| 24 | Cosmic Space Spear | Go to The Spear (50) |
| 25 | Space Dice | Go to The Dice (46) |
| 26 | Space Permit | Go to The Space Permit (20) |
| 27 | Apollo 11 Spaceship | Go to The Moon (58) |
| 28 | Time Travel | Confusion! Teleport to 5:20 (64) |
| 29 | Shooting Star | Choose: send any player to The Star (33) **or** go there yourself |
| 30 | 6-7 | Send any player to Space 6 or 7 (you pick). **On your 2nd 6-7 of the game, you go to Space 67 instead.** |

### Extra turns / turn manipulation
| # | Card | Effect |
|--:|------|--------|
| 31 | Light Speed | Take 3 turns in a row |
| 32 | Nebula | Take 2 more turns |
| 33 | U.F.O. | Take 5 turns in a row |
| 34 | Time Loop | Repeat **your own** last turn (same action and result) |
| 35 | Rocket | Jump in front of the nearest person ahead of you |

### Penalty — lose turns
| # | Card | Effect |
|--:|------|--------|
| 36 | Space Gun | Your ship is down! Lose 2 turns |
| 37 | Alien Space Army | Taken to jail! Lose 5 turns (you stay in place, just skip 5 turns) |

### Special / modifier
| # | Card | Effect |
|--:|------|--------|
| 38 | Shield Generator | Immunity for the next **3 full rounds of play** (see §6) |
| 39 | Space Suit | Double the effect of your **next** card (see §6) |
| 40 | Satellite | Look at the next 5 cards and put them back in any order you choose |
| 41 | Worm Hole | Teleport! Swap positions with any opponent (**not yourself**) |

---

## 6. Two rules that need exact definitions

### Shield Generator (#38) — lasts **3 full table go-arounds**
- While active, you are **immune to every negative effect** aimed at you — any backward move,
  lost turn, send-to-START, forced teleport, or position swap — with **no limit** on how many
  hits it absorbs.
- It expires after **3 complete go-arounds of the table** (i.e., after every player has taken
  3 turns since you played it). It is **round-based**, so taking extra turns does **not** use it
  up faster.
- A shield is **never** affected by Space Suit (it does not become "6 rounds").

### Space Suit (#39) — doubles your **next** card
- It doubles the numeric part of your next card **for you**: your forward/back distance, the
  number of turns you gain or inflict, attack distances you deal, etc.
- On a card that affects **everyone** (Cosmic Chaos, Tidal Wave, Meteor Shower, Solar Flare),
  it doubles the effect **only for you** — everyone else moves the normal amount.
- It also doubles a **dice roll** if you choose to roll while wearing it.
- It does **not** double a Shield's duration.
- It is **consumed by your very next card no matter what** — if that card has no number to double
  (Satellite, Worm Hole, Rocket, Time Loop, or even another Shield), the Space Suit is simply
  used up with no benefit.

---

## 7. Collisions — two rockets can't share a space

- If, **after any movement**, **2 or more rockets end up on the same board space**, **all rockets
  on that space go back to START.**
- This applies no matter how they got there. Example: you play **Black Hole** and send an opponent
  onto a space another player is already standing on — **both** of those players go back to START.
- **Exempt:** rockets at **START** (many can wait there together) and rockets **inside a portal**.

---

## 8. Winning

- The first rocket to **land on or pass the Finish** (after Space 67) **wins.**
- **Ties:** if two or more rockets reach the Finish on the **same** turn (e.g. Cosmic Chaos pushes
  several players across at once), those tied players have a **dice roll-off — highest roll wins**
  (re-roll if still tied). You cannot win from inside a portal; you must exit onto the board first.
