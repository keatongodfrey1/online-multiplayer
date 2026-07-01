// Core types for the Water Fight rules engine (the FULL ruleset).
//
// A turn = draw 2 -> optional Support -> one Main Action (throw / big attack /
// shop / pass) -> Splash flip -> the Miss/Hit/Umbrella defense ladder -> damage
// -> soak. Layered on top: the shop, seeded Events, throw modifiers (Soaker,
// multi-target spread with per-victim reactions, extra throws), out-of-turn
// reactions (Towel/Redirect/Water Trap/Lifeguard), peeks (Goggles/Sneaky Peek),
// Storm Cloud soft-elimination, Flash Flood, and the Sudden-Death phase.

/** Every card kind in the game. Phase A only seeds balloon/miss/hit/treasure/wild
 *  into the main deck; umbrella (a shop card) is modeled so the ladder is complete
 *  and tests can inject one. */
export type CardKind =
  // main deck
  | "balloon" | "miss" | "hit" | "treasure" | "wild" | "event"
  // Defense Depot (shop)
  | "umbrella" | "backpack" | "firstaid" | "towel" | "goggles" | "needle" | "lifeguard"
  // Mischief Market (shop)
  | "pickpocket" | "sabotage" | "cardswap" | "freezeout" | "hiddenstash"
  | "redirect" | "lemonadespill" | "sneakypeek" | "watertrap" | "switcheroo"
  // Attack Arsenal (shop)
  | "mega" | "launcher" | "triplesplash" | "golden" | "rapidfire"
  | "splashzone" | "giant" | "soaker" | "flashflood";

/** Big attacks (Attack Arsenal) — they auto-connect, skipping the Splash flip (E2). */
export type BigKind = "mega" | "giant" | "golden";
/** Attack kinds in the ladder. "flashflood" is the table-wide Main Action. */
export type AttackKind = "basic" | "flashflood" | BigKind;

/** Cards played in the Support slot (during your own turn). */
export type SupportKind =
  | "firstaid" | "backpack" | "goggles" | "needle"
  | "pickpocket" | "sabotage" | "cardswap" | "freezeout"
  | "hiddenstash" | "lemonadespill" | "sneakypeek" | "switcheroo";

export const SUPPORT_KINDS: readonly SupportKind[] = [
  "firstaid", "backpack", "goggles", "needle", "pickpocket", "sabotage",
  "cardswap", "freezeout", "hiddenstash", "lemonadespill", "sneakypeek", "switcheroo",
];

/** The three blind shop stacks. */
export type StackId = "defense" | "mischief" | "attack";

/** Events live ONLY in the main deck; they resolve on draw and count as a draw
 *  (D3/E5). Each maps to one immediate, self-contained effect (no awaiting). */
export type EventKind =
  // table-wide -1 life (the E9 Sudden-Death clamp keeps a simultaneous wipe from happening)
  | "mudslide" | "stormsurge" | "heatwave" | "downpour" | "tidalwave"
  // anti-leader: the player with the most lives loses 1
  | "lightning" | "targetedstorm"
  // heals (capped at starting lives — E8)
  | "sunbreak" | "rainbow" | "waterparkpass"
  // gain Treasure from the deck
  | "treasurechest" | "supplycache" | "supplydrop"
  // forced discards
  | "leakybucket" | "springcleaning"
  // misc
  | "lostandfound" // E7: the drawer takes a random card from each opponent
  | "calmwaters" | "falsealarm" | "gentlebreeze"; // duds (variance)

export interface Card {
  id: number;
  kind: CardKind;
  /** Set iff kind === "event" — which Event this card resolves to. */
  event?: EventKind;
}

/** The Splash Pile is a SEPARATE deck of only these two verdicts (default 13/7). */
export type SplashCard = "hit" | "miss";

export interface PlayerState {
  seat: number;
  name: string;
  lives: number;
  hand: Card[];
  /** Soaked: lives reached 0 — not "living", cannot win. */
  out: boolean;
  /** Soft elimination (D5): a soaked player who keeps playing from the sideline
   *  (draw 1/turn, may splash a random living player). Implies `out`. A finalist
   *  soaked during Sudden-Death is `out` but NOT a Storm Cloud (fully removed). */
  stormCloud: boolean;
  /** Pending status effects (set by opponents' cards; applied on this player's next turn). */
  statuses: {
    freezeOut: boolean; // Freeze Out: draw only 1 next turn
    noShop: boolean; // Lemonade Spill: may not Shop next turn
  };
}

export interface GameOptions {
  startingLives: number;
  /** Splash Pile composition (the lobby "splash odds" dial). */
  splashHit: number; // default 13
  splashMiss: number; // default 7
  /** Main-deck Hit/Miss HAND-card counts (the defense-layer dial). Balloon/
   *  Treasure (20 each) and Wild (1) are fixed; these tune the deck size. */
  mainHit: number; // default 20
  mainMiss: number; // default 20
  /** Discard down to this many cards at end of turn. */
  handLimit: number; // default 8
  /** Coins to buy one card from a shop stack. */
  shopCost: number; // default 4
  /** How many of the 19 Events are seeded into the main deck (0-19, default 8). */
  eventDensity: number;
  /** Storm Cloud sideline rate (D5): cards drawn and balloons thrown per turn. */
  stormDraw: number; // default 1
  stormThrows: number; // default 1
  /** Soft cap on a defense-ladder's back-and-forth (0 = unlimited, backstopped). */
  maxReactions: number; // default 0
  /** Backstop so a pathological game still terminates. */
  turnCap: number;
}

export const DEFAULT_OPTIONS: GameOptions = {
  startingLives: 3,
  splashHit: 13,
  splashMiss: 7,
  mainHit: 20,
  mainMiss: 20,
  handLimit: 8,
  shopCost: 4,
  eventDensity: 8,
  stormDraw: 1,
  stormThrows: 1,
  maxReactions: 0,
  turnCap: 4000,
};

/** Who/what the engine is waiting on. `seats` holds the single seat acting now
 *  (a multi-target attack resolves its targets one at a time, not all at once). */
export type AwaitKind =
  | "MOVE" | "REACT" | "DEFEND" | "ATTACKER_RESPOND" | "DISCARD" | "EXTRA_THROW" | "SPLASH_DRAW" | "GAME_OVER";

/** A SINGLE-target card committed but not yet resolved — held during the pre-effect
 *  reaction window (E10/E11). On pass it resolves; Towel cancels it; Redirect /
 *  Water Trap re-point or bounce it (attacks only). The played card(s) are already
 *  spent. (Spread attacks never use this path — they open per-target windows.) */
export interface PendingAction {
  kind: "THROW" | "PLAY_BIG" | "SUPPORT";
  attacker: number; // the seat whose hits resolve in the ladder (swapped by Water Trap)
  target: number; // the current (possibly redirected) target
  big?: BigKind;
  soaker?: boolean;
  support?: SupportKind;
  /** Seats that already spent a discrete reaction (Redirect/Water Trap) — caps the chain. */
  redirectedSeats: number[];
}

/** A throw committed and past its pre-flip reaction window, now waiting for the
 *  ATTACKER to flip the Splash Pile (the interactive hit/miss draw). Held in its
 *  own slot — never `s.pending`, which an invariant forbids outside a REACT window.
 *  On DRAW_SPLASH the engine flips, records `lastSplash`, and resolves Miss/Hit. */
export interface PendingFlip {
  attacker: number;
  target: number;
  soaker: boolean;
  spread?: Spread;
}

/** The most recent Splash flip, mirrored to all clients so the table can show the
 *  HIT/MISS reveal. `seq` advances on every flip so a client can detect a NEW draw. */
export interface SplashReveal {
  seq: number;
  attacker: number;
  target: number;
  verdict: SplashCard;
}

/** The soak that ended the game (for the synced victory reveal). `means` is the
 *  SPECIFIC finishing kind so the client can name it: an attack kind ("basic" |
 *  "mega" | "giant" | "golden" | "flashflood") or a damaging EventKind. `attacker`
 *  is null for an Event kill (no player threw it). Overwritten on every soak, so at
 *  game-over it holds the eliminating blow. */
export interface FinalBlow {
  attacker: number | null;
  victim: number;
  means: string;
}

/** The dedicated attack state machine's persistent state (Issue 1bA). */
export interface AttackState {
  attackerSeat: number;
  /** Targets resolved sequentially (E3 multi-target); single-target = one entry. */
  targets: number[];
  targetIdx: number;
  kind: AttackKind;
  blockNumber: number; // basic/giant/golden = 1, mega = 2
  damage: number; // basic/mega/golden = 1, giant = 2
  /** Soaker Cannon: hand-Miss cards are negated for this whole attack (R2). */
  soaker: boolean;
  /** Multi-target (R3): each target gets its OWN pre-ladder reaction window and a
   *  peel (Redirect/Water Trap) affects only that instance — the rest still land. */
  perTargetReactions: boolean;
  /** Seats that already spent a discrete reaction (Redirect/Water Trap) this attack. */
  redirectedSeats: number[];
  // ---- ladder state for the CURRENT target ----
  /** Miss cards currently placed toward blockNumber. */
  missBlocks: number;
  /** An active Umbrella full-block (uncancelable vs a normal balloon; Hit-cancelable vs Mega — R1). */
  umbrellaBlock: boolean;
  /** MAX_ATTACK_ROUNDS backstop counter. */
  rounds: number;
}

export interface Awaiting {
  seats: number[];
  kind: AwaitKind;
  attack?: AttackState;
}

export type EndReason = "last-standing" | "cap";

export interface GameState {
  engineVersion: string;
  seed: number;
  /** Advancing PRNG state (see rng.ts) — enables deterministic mid-game reshuffles. */
  rngState: number;
  options: GameOptions;
  /** Highest main-deck card id (the deck size; main ids are 1..mainIdMax). Set at
   *  setup from the Hit/Miss dial — the conservation/routing boundary, replacing a
   *  fixed constant now that the deck size varies. */
  mainIdMax: number;
  players: PlayerState[];
  mainDeck: Card[]; // SECRET, shuffled
  mainDiscard: Card[];
  /** Played non-main cards (shop/big) — removed from circulation, never reshuffled. */
  usedPile: Card[];
  /** The three blind shop stacks (SECRET; never reshuffle when empty). */
  stacks: Record<StackId, Card[]>;
  splashPile: SplashCard[]; // SECRET, shuffled
  splashDiscard: SplashCard[];
  /** "playing", or "sudden-death" once a single source would have soaked every
   *  living player at once (E9) — multi-target/table/Storm-Cloud damage is then
   *  suppressed so only single-target soaks end the game (exactly one winner). */
  phase: "playing" | "sudden-death";
  /** The active player (whose Main Action it is). */
  turnSeat: number;
  /** Whether the active player has used their one Support card this turn. */
  supportUsed: boolean;
  /** Storm-Cloud throws used this turn (capped by options.stormThrows). */
  stormThrowsUsed: number;
  /** A committed targeting action awaiting its reaction window (null otherwise). */
  pending: PendingAction | null;
  /** A committed throw awaiting the attacker's interactive Splash flip (null otherwise);
   *  set iff `awaiting.kind === "SPLASH_DRAW"`. */
  pendingFlip: PendingFlip | null;
  awaiting: Awaiting;
  turnCount: number;
  over: boolean;
  winner: number | null;
  endReason: EndReason | null;
  log: string[];
  /** The most recent Splash flip (for the synced HIT/MISS reveal); null until the
   *  first throw flips. */
  lastSplash: SplashReveal | null;
  /** The most recent eliminating soak (for the synced end-of-game victory reveal);
   *  null until a player is soaked out. At game-over it names the finishing blow. */
  finalBlow: FinalBlow | null;
  /** Private peek/lost/drew output of the LAST reduce (forwarded to one seat only). */
  reveals: Reveal[];
  /** PUBLIC consequential moments of the LAST reduce (the room appends them to the
   *  synced event stream with a seq). Cleared each reduce, like `reveals`; never saved. */
  events: GameEvent[];
}

/** Multi-target spread, pre-declared on a throw; only consumed if the throw lands
 *  (Triple Splash = up to 3 targets; Splash Zone = all opponents). The engine
 *  resolves the targets sequentially (E3). Post-flip choice is a room-layer UX
 *  refinement; mechanically the modifier is spent only on a Hit. */
export type Spread = { modifier: "triplesplash" | "splashzone"; extraTargets: number[] };

// ---- Moves: one optional Support card + one Main Action per turn ----
export type Move =
  | { kind: "PLAY_SUPPORT"; support: SupportKind; target?: number } // Support slot (does not end the turn)
  | { kind: "THROW"; target: number; soaker?: boolean; spread?: Spread } // Main Action
  | { kind: "PLAY_BIG"; big: BigKind; target: number; soaker?: boolean; spread?: Spread } // Main Action
  | { kind: "SHOP"; sell: { balloons: number; treasures: number; wild: number }; buy: StackId[] } // Main Action
  | { kind: "FLASH_FLOOD" } // Main Action: auto-connects, soaks every opponent for 2 (blockable)
  | { kind: "STORM_THROW" } // a Storm Cloud's sideline splash (engine picks a random living target)
  | { kind: "END_TURN" }; // Main Action (pass)

// ---- Resolutions (out-of-turn ladder responses, discard, extra throw) ----
export type Defense = "miss" | "umbrella" | "wild_miss" | "pass";
export type Respond = "hit" | "wild_hit" | "pass";
/** Pre-effect reaction (E10/E11): pass · Towel (cancel) · Redirect (re-point) ·
 *  Water Trap (bounce to attacker). Redirect/Water Trap apply to attacks only. */
export type ReactAction = "pass" | "towel" | "redirect" | "watertrap";
export type Resolution =
  | { kind: "REACT"; action: ReactAction; target?: number }
  | { kind: "DEFEND"; defense: Defense }
  | { kind: "ATTACKER_RESPOND"; respond: Respond }
  | { kind: "DISCARD"; cardIds: number[] }
  | { kind: "EXTRA"; action: "throw" | "pass"; target?: number; soaker?: boolean }
  | { kind: "DRAW_SPLASH" }; // the attacker flips the Splash Pile for a committed throw

/** A consequential moment, surfaced as a PUBLIC toast on every client. FLAT PRIMITIVES
 *  ONLY + an engine-built GENERIC `text` — NEVER a Move/Resolution or a card identity
 *  (those carry secrets; the synced event stream is public to all). Specific secret
 *  detail (which exact card you lost/drew) goes through the private `Reveal` channel. */
export interface GameEvent {
  /** Routing key for the client (e.g. "damage" | "soak" | "save" | "heal" | "event"
   *  | "support" | "attack" | "react" | "suddendeath" | "turn" | "draw"). */
  kind: string;
  /** Actor seat, or -1 (e.g. a table Event has no actor). */
  seat: number;
  /** Victim/target seat, or -1. */
  target: number;
  /** Kind-specific magnitude (damage/heal/draw count); 0 when N/A. */
  amount: number;
  /** PUBLIC, GENERIC, pre-built human line (names already substituted). */
  text: string;
  /** The SPECIFIC card/event/defense kind that drove this event, when it is PUBLIC
   *  (attack big kind, support kind, react/defense kind, EventKind) — so the client can
   *  show its name + effect. "" when none or SECRET (a blind-shop buy, a generic balloon,
   *  or a post-hit consequence like damage/soak/heal). NEVER a hidden card identity. */
  detailKind: string;
}

/** A one-shot private reveal (Goggles peek the deck top, Sneaky Peek an opponent's
 *  hand). Produced by a reduce, forwarded by the room to `seat` ONLY — never synced
 *  to everyone. Ephemeral: cleared at the start of the next reduce. */
export interface Reveal {
  seat: number; // who may see it (the peeker / the owner of the lost-or-drawn cards)
  /** "deck-top"/"hand" = peeks (Goggles/Sneaky Peek); "lost"/"drew" = the specific
   *  cards a ONE-DIRECTIONAL effect removed from / added to YOUR hand (Sabotage,
   *  Pickpocket, forced discard, Golden/Backpack draw); "bought" = the cards you just
   *  bought from the blind shop (only you learn which). NEVER used for 2-way swaps. */
  kind: "deck-top" | "hand" | "lost" | "drew" | "bought";
  cards: Card[];
  ofSeat?: number; // for kind "hand": whose hand was peeked
}

export interface ApplyResult {
  state: GameState;
  awaiting: Awaiting;
  events: GameEvent[];
}
