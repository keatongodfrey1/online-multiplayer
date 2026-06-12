import { GAME_DATA as raw } from "./gameData.js";
import type { Card, GameData, Noble } from "./types.js";

// gameData.ts is generated from data/splendor_data.json (npm run gen:data).
export const GAME_DATA: GameData = raw as unknown as GameData;

export const CARDS: Card[] = GAME_DATA.cards;
export const NOBLES: Noble[] = GAME_DATA.nobles;

export const TOKENS_PER_GEM_BY_PLAYERS: Record<number, number> = { 2: 4, 3: 5, 4: 7 };
export const GOLD_TOKENS = 5;
export const TARGET_PRESTIGE = 15;
export const MAX_TOKENS_HELD = 10;
export const MAX_RESERVED = 3;
export const TAKE_TWO_MIN_PILE = 4;
export const MARKET_SLOTS = 4;
export const ENGINE_VERSION = "1.0.0";
