// Core types for the Splendor rules engine.

export type Color = "white" | "blue" | "green" | "red" | "black";
export const COLORS: readonly Color[] = ["white", "blue", "green", "red", "black"];
export type Tier = 1 | 2 | 3;

export type ColorMap = Record<Color, number>;

export interface Card {
  id: number;
  tier: Tier;
  bonus: Color;
  points: number;
  cost: ColorMap;
}

export interface Noble {
  id: number;
  name?: string;
  points: number; // always 3
  requirement: ColorMap;
}

export interface PlayerState {
  seat: number;
  name: string;
  kind: "human" | "ai";
  connected: boolean;
  gems: ColorMap; // gem tokens held (no gold)
  gold: number; // gold/wild tokens held
  bonuses: ColorMap; // derived from built cards (cached)
  reserved: Card[]; // 0..3, PRIVATE to owner
  built: Card[];
  nobles: Noble[];
}

export interface GameOptions {
  endGameMode: "finishRound" | "immediate";
  allowTakeFewerThanThree: boolean;
  turnCap: number; // REQUIRED backstop (SPEC §9)
}

export const DEFAULT_OPTIONS: GameOptions = {
  endGameMode: "finishRound",
  allowTakeFewerThanThree: false,
  turnCap: 3000,
};

export type InputType = "MOVE" | "DISCARD" | "PICK_NOBLE";

export interface Awaiting {
  seat: number;
  inputType: InputType;
  nobleChoices?: number[]; // for PICK_NOBLE
  discardCount?: number; // for DISCARD
}

export type EndReason = "points" | "stalemate" | "cap";

export interface GameState {
  engineVersion: string;
  seed: number;
  options: GameOptions;
  players: PlayerState[];
  supplyGems: ColorMap;
  supplyGold: number;
  decks: Record<Tier, Card[]>; // SECRET, shuffled
  market: Record<Tier, (Card | null)[]>; // 4 slots per tier
  nobles: Noble[]; // available nobles (players + 1 at start)
  startSeat: number;
  awaiting: Awaiting;
  endFlag: boolean;
  forcedPassStreak: number;
  turnCount: number;
  over: boolean;
  endReason: EndReason | null;
}

// ---- Moves (the four turn actions) ----
export interface MarketRef {
  tier: Tier;
  index: number;
}
export type BuyFrom = { market: MarketRef } | { reserve: { cardId: number } };
export type ReserveFrom = { market: MarketRef } | { deck: { tier: Tier } };

export function buyFromIsMarket(f: BuyFrom): f is { market: MarketRef } {
  return "market" in f;
}
export function reserveFromIsMarket(f: ReserveFrom): f is { market: MarketRef } {
  return "market" in f;
}

export type Move =
  | { kind: "TAKE_THREE"; colors: Color[] }
  | { kind: "TAKE_TWO"; color: Color }
  | { kind: "RESERVE"; from: ReserveFrom }
  | { kind: "BUY"; from: BuyFrom };

// ---- Resolutions (mid-turn sub-decisions) ----
export type Resolution =
  | { kind: "DISCARD"; gems: Partial<ColorMap>; gold?: number }
  | { kind: "PICK_NOBLE"; nobleId: number };

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

export interface RankEntry {
  seat: number;
  points: number;
  cardsBought: number;
  rank: number;
}

// ---- Redacted (per-recipient) views ----
export interface RedactedPlayer {
  seat: number;
  name: string;
  kind: "human" | "ai";
  connected: boolean;
  gems: ColorMap;
  gold: number;
  bonuses: ColorMap;
  points: number;
  built: Card[];
  nobles: Noble[];
  reservedCount: number;
  reserved?: Card[]; // present ONLY for the viewer's own seat
}

export interface RedactedState {
  engineVersion: string;
  options: GameOptions;
  you: number | "spectator";
  supplyGems: ColorMap;
  supplyGold: number;
  market: Record<Tier, (Card | null)[]>;
  deckCounts: Record<Tier, number>;
  nobles: Noble[];
  players: RedactedPlayer[];
  startSeat: number;
  awaiting: Awaiting;
  turnCount: number;
  over: boolean;
  endReason: EndReason | null;
}

export interface GameData {
  meta: unknown;
  cards: Card[];
  nobles: Noble[];
}
