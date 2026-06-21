// Core types for the Water Fight rules engine.
//
// PHASE A scope: turn = draw 2 -> throw a basic Water Balloon -> Splash flip ->
// Miss/Hit/Umbrella defense ladder -> damage -> soak -> last-standing win.
// Shop, Events, Support cards, big attacks, modifiers, Storm Cloud, Sudden-Death
// are Phase B+ and extend these unions + the attack state machine.

/** Every card kind in the game. Phase A only seeds balloon/miss/hit/treasure/wild
 *  into the main deck; umbrella (a shop card) is modeled so the ladder is complete
 *  and tests can inject one. */
export type CardKind =
  // main deck
  | "balloon" | "miss" | "hit" | "treasure" | "wild"
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
export type AttackKind = "basic" | BigKind;

/** Cards played in the Support slot (during your own turn). */
export type SupportKind =
  | "firstaid" | "backpack" | "goggles" | "needle"
  | "pickpocket" | "sabotage" | "cardswap" | "freezeout"
  | "hiddenstash" | "lemonadespill" | "sneakypeek" | "switcheroo";

export const SUPPORT_KINDS: readonly SupportKind[] = [
  "firstaid", "backpack", "goggles", "needle", "pickpocket", "sabotage",
  "cardswap", "freezeout", "hiddenstash", "lemonadespill", "sneakypeek", "switcheroo",
];

export interface Card {
  id: number;
  kind: CardKind;
}

/** The Splash Pile is a SEPARATE deck of only these two verdicts (default 13/7). */
export type SplashCard = "hit" | "miss";

export interface PlayerState {
  seat: number;
  name: string;
  lives: number;
  hand: Card[];
  /** Soaked: lives reached 0. (Phase A: removed from rotation; Storm Cloud is Phase B.) */
  out: boolean;
}

export interface GameOptions {
  startingLives: number;
  /** Splash Pile composition (the lobby "splash odds" dial). */
  splashHit: number; // default 13
  splashMiss: number; // default 7
  /** Discard down to this many cards at end of turn. */
  handLimit: number; // default 8
  /** Backstop so a pathological game still terminates. */
  turnCap: number;
}

export const DEFAULT_OPTIONS: GameOptions = {
  startingLives: 3,
  splashHit: 13,
  splashMiss: 7,
  handLimit: 8,
  turnCap: 4000,
};

/** Who/what the engine is waiting on. Phase A kinds; `seats` is an array for
 *  forward-compat with multi-target (Phase B) but holds exactly one seat here. */
export type AwaitKind = "MOVE" | "DEFEND" | "ATTACKER_RESPOND" | "DISCARD" | "GAME_OVER";

/** The dedicated attack state machine's persistent state (Issue 1bA). */
export interface AttackState {
  attackerSeat: number;
  targetSeat: number;
  kind: AttackKind;
  blockNumber: number; // basic/giant/golden = 1, mega = 2
  damage: number; // basic/mega/golden = 1, giant = 2
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
  players: PlayerState[];
  mainDeck: Card[]; // SECRET, shuffled
  mainDiscard: Card[];
  /** Played non-main cards (shop/big) — removed from circulation, never reshuffled. */
  usedPile: Card[];
  splashPile: SplashCard[]; // SECRET, shuffled
  splashDiscard: SplashCard[];
  /** The active player (whose Main Action it is). */
  turnSeat: number;
  /** Whether the active player has used their one Support card this turn. */
  supportUsed: boolean;
  awaiting: Awaiting;
  turnCount: number;
  over: boolean;
  winner: number | null;
  endReason: EndReason | null;
  log: string[];
}

// ---- Moves: one optional Support card + one Main Action per turn ----
export type Move =
  | { kind: "PLAY_SUPPORT"; support: SupportKind; target?: number } // Support slot (does not end the turn)
  | { kind: "THROW"; target: number } // Main Action
  | { kind: "PLAY_BIG"; big: BigKind; target: number } // Main Action
  | { kind: "END_TURN" }; // Main Action (pass)

// ---- Resolutions (out-of-turn ladder responses + end-of-turn discard) ----
export type Defense = "miss" | "umbrella" | "wild_miss" | "pass";
export type Respond = "hit" | "wild_hit" | "pass";
export type Resolution =
  | { kind: "DEFEND"; defense: Defense }
  | { kind: "ATTACKER_RESPOND"; respond: Respond }
  | { kind: "DISCARD"; cardIds: number[] };

export interface GameEvent {
  type: string;
  seat: number;
  detail?: unknown;
}

export interface ApplyResult {
  state: GameState;
  awaiting: Awaiting;
  events: GameEvent[];
}
