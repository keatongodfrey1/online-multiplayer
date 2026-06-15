/**
 * Paper.io tuning constants shared by the engine, the room, and the lobby UI.
 * Kept here (in the pure engine) so there is a single source of truth; the
 * schema package re-exports what the client needs.
 */
import type { BoardSizeKey, BotDifficulty, SpeedKey, WinMode } from "./types.js";

/** Server simulation rate (ticks/second), like Dot Arena. */
export const TICK_RATE = 20;
/** Home territory is START_BLOCK x START_BLOCK cells. */
export const START_BLOCK = 5;
/** Trail cells right behind the head that don't kill you on a sharp turn. */
export const SELF_GRACE = 3;
/** Radians/second a head curves toward its target heading (free-angle steer). */
export const TURN_RATE = 13;
/** How long an actor stays "dead" before respawn / elimination. */
export const DEATH_MS = 750;
/** Human framework seats occupy ids 1..8; bot ids start above them. */
export const MAX_HUMAN_SEATS = 8;
export const BOT_ID_BASE = MAX_HUMAN_SEATS + 1; // 9
/** Hard cap on simultaneous bots (sizes the id pool and the bot-count dial). */
export const MAX_BOTS = 16;
/** ms between topping the bot population back up to the chosen count. */
export const SPAWN_INTERVAL_MS = 7000;
/** Stop spawning bots once a leader already owns this share of the board. */
export const SPAWN_CAP_SHARE = 0.8;

export interface BoardDef {
  cols: number;
  rows: number;
  label: string;
}
/**
 * Board dimensions. With the follow camera the whole board no longer has to fit
 * one screen, so these are larger than a single viewport; kept within a range
 * that keeps the synced grid reasonable over the internet.
 */
export const BOARD_SIZES: Record<BoardSizeKey, BoardDef> = {
  small: { cols: 48, rows: 30, label: "Small" },
  medium: { cols: 72, rows: 46, label: "Medium" },
  large: { cols: 100, rows: 64, label: "Large" },
};
export const BOARD_SIZE_ORDER: BoardSizeKey[] = ["small", "medium", "large"];

export interface SpeedDef {
  cellsPerSec: number;
  label: string;
}
/** Movement speed (identical for every actor - difficulty never changes it). */
export const SPEEDS: Record<SpeedKey, SpeedDef> = {
  slow: { cellsPerSec: 9, label: "Slow" },
  normal: { cellsPerSec: 13, label: "Normal" },
  fast: { cellsPerSec: 18, label: "Fast" },
};
export const SPEED_ORDER: SpeedKey[] = ["slow", "normal", "fast"];

export interface DifficultyDef {
  label: string;
  /** [min, max] cells a bot pushes away from home before turning. */
  legOut: [number, number];
  /** [min, max] cells a bot runs perpendicular before heading home. */
  legSide: [number, number];
  /** Chance (0..1) an excursion becomes an aggressive push toward a rival. */
  aggression: number;
}
/**
 * Bots are "smarter, not faster": every difficulty moves at the shared speed.
 * Difficulty scales how much ground an excursion grabs and (at hard/extreme)
 * how often the bot hunts a rival's trail.
 */
export const DIFFICULTIES: Record<BotDifficulty, DifficultyDef> = {
  easy: { label: "Easy", legOut: [2, 4], legSide: [2, 3], aggression: 0 },
  normal: { label: "Normal", legOut: [3, 6], legSide: [3, 5], aggression: 0.05 },
  hard: { label: "Hard", legOut: [4, 8], legSide: [3, 6], aggression: 0.3 },
  extreme: { label: "Extreme", legOut: [5, 10], legSide: [4, 7], aggression: 0.55 },
};
export const DIFFICULTY_ORDER: BotDifficulty[] = ["easy", "normal", "hard", "extreme"];

export const LIVES_MIN = 1;
export const LIVES_MAX = 10;
export const LIVES_DEFAULT = 3;

export const BOT_COUNT_MIN = 0;
export const BOT_COUNT_MAX = MAX_BOTS;
export const BOT_COUNT_DEFAULT = 6;
export const BOT_DIFFICULTY_DEFAULT: BotDifficulty = "normal";

export const TARGET_PCT_MIN = 10;
export const TARGET_PCT_MAX = 90;
export const TARGET_PCT_STEP = 5;
export const TARGET_PCT_DEFAULT = 60;

export const TIMED_SEC_MIN = 30;
export const TIMED_SEC_MAX = 600;
export const TIMED_SEC_STEP = 30;
export const TIMED_SEC_DEFAULT = 120;

export const WIN_MODES: WinMode[] = ["target", "timed"];
