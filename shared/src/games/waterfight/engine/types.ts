// Core types for the Water Fight rules engine.
//
// PHASE A scope: turn = draw 2 -> throw a basic Water Balloon -> Splash flip ->
// Miss/Hit/Umbrella defense ladder -> damage -> soak -> last-standing win.
// Shop, Events, Support cards, big attacks, modifiers, Storm Cloud, Sudden-Death
// are Phase B+ and extend these unions + the attack state machine.

/** Every card kind in the game. Phase A only seeds balloon/miss/hit/treasure/wild
 *  into the main deck; umbrella (a shop card) is modeled so the ladder is complete
 *  and tests can inject one. */
export type CardKind = "balloon" | "miss" | "hit" | "treasure" | "wild" | "umbrella";

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
  /** Backstop so a pathological game still terminates. */
  turnCap: number;
}

export const DEFAULT_OPTIONS: GameOptions = {
  startingLives: 3,
  splashHit: 13,
  splashMiss: 7,
  turnCap: 4000,
};

/** Who/what the engine is waiting on. Phase A kinds; `seats` is an array for
 *  forward-compat with multi-target (Phase B) but holds exactly one seat here. */
export type AwaitKind = "MOVE" | "DEFEND" | "ATTACKER_RESPOND" | "GAME_OVER";

/** The dedicated attack state machine's persistent state (Issue 1bA). */
export interface AttackState {
  attackerSeat: number;
  targetSeat: number;
  blockNumber: number; // basic = 1 (Mega = 2 in Phase B)
  damage: number; // basic = 1 (Giant = 2 in Phase B)
  /** A defender's un-cancelled Miss currently stands. */
  blocked: boolean;
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
  splashPile: SplashCard[]; // SECRET, shuffled
  splashDiscard: SplashCard[];
  /** The active player (whose Main Action it is). */
  turnSeat: number;
  awaiting: Awaiting;
  turnCount: number;
  over: boolean;
  winner: number | null;
  endReason: EndReason | null;
  log: string[];
}

// ---- Moves (the active player's Main Action — Phase A subset) ----
export type Move = { kind: "THROW"; target: number } | { kind: "END_TURN" };

// ---- Resolutions (out-of-turn ladder responses) ----
export type Defense = "miss" | "umbrella" | "wild_miss" | "pass";
export type Respond = "hit" | "wild_hit" | "pass";
export type Resolution =
  | { kind: "DEFEND"; defense: Defense }
  | { kind: "ATTACKER_RESPOND"; respond: Respond };

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
