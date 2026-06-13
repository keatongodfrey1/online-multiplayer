// Core types for the Space Chase rules engine. Plain data only - the whole
// GameState is serializable (for saves) and every apply function is pure.

import type { ScAwaitType } from "../constants.js";

/** One engine seat. Engine seat index === SpaceChaseState.seats index. */
export interface EngineSeat {
  /** Engine seat index (0-based, = turn order). */
  seat: number;
  /** Nickname, carried for event text + the save lineup. */
  name: string;
  /** Left for good: rocket off the board, skipped in the rotation. */
  gone: boolean;
  /** 0 = START, 1..67 = board, 68 = Finish. Entry mouth while in a portal. */
  position: number;
  portalId: number;
  portalProgress: number;
  portalForward: boolean;
  justExitedPortal: number;
  lostTurns: number;
  extraTurns: number;
  /** Shield active while roundNumber < this; 0 = none. */
  shieldExpiresRound: number;
  spaceSuit: boolean;
  sixSevenCount: number;
  /** Time Loop source for this seat. */
  lastActionType: "" | "dice" | "card";
  /** dice: amount moved (already doubled if suited); card: card id. */
  lastActionValue: number;
}

/** What the engine is waiting for and the sub-step context. */
export interface Awaiting {
  seat: number;
  inputType: ScAwaitType;
  /** ScPrompt sub-step key; "" while awaiting ACTION. */
  context: string;
  /** Card that opened the prompt (0 for ACTION). */
  cardId: number;
  /** Space-Suit multiplier captured when the card was drawn (1 or 2). */
  mult: number;
  /** Required selection count for MULTI_TARGET. */
  count: number;
  /** Step-1 target carried into step 2 (Black Hole / 6-7); -1 = none. */
  targetSeat: number;
  /** Satellite peek (card ids, next-draw first); only while SATELLITE is open. */
  peek: number[];
}

export interface GameState {
  engineVersion: string;
  seed: number;
  /** mulberry32 accumulator; advances as dice/shuffles consume randomness. */
  rngState: number;
  /** Scripted die results consumed before the rng (tests + tiebreak determinism). */
  forcedRolls: number[];
  players: EngineSeat[];
  /** Draw pile; TOP = last element. Server-only (never synced). */
  deck: number[];
  discard: number[];
  /** Full table go-arounds completed (drives shield expiry). */
  roundNumber: number;
  /** Increments each time a new turn (ACTION) begins; the room's clock keys off it. */
  turnCount: number;
  awaiting: Awaiting;
  over: boolean;
  /** Winning engine seat, or null (none yet / abandoned handled by the room). */
  winner: number | null;
}

// ---- Actions ----

/** The top-level turn action (awaiting ACTION). */
export type Move = { kind: "ROLL" } | { kind: "DRAW" };

/** A mid-card prompt answer (awaiting TARGET/MULTI_TARGET/CHOICE/SPACE/SATELLITE). */
export type Resolution =
  | { kind: "TARGET"; seat: number }
  | { kind: "TARGETS"; seats: number[] }
  | { kind: "CHOICE"; choice: string }
  | { kind: "SPACE"; space: number }
  | { kind: "SATELLITE"; order: number[] };

export interface GameEvent {
  kind: string;
  /** Acting/affected engine seat, or -1. */
  seat: number;
  a: number;
  b: number;
  text: string;
}

export interface ApplyResult {
  state: GameState;
  events: GameEvent[];
}

export interface RankEntry {
  seat: number;
  position: number;
  rank: number;
}
