/**
 * Paper.io - shared schema + messages.
 *
 * The rules live in the ported engine (./engine/, server-driven); this schema
 * is the public mirror the server syncs to clients. There is no hidden
 * information - everyone sees the whole board - so no @view() private state.
 */
import { ArraySchema, Schema, type } from "@colyseus/schema";
import { BasePlayer, BaseState } from "../../state.js";
import {
  BOARD_SIZE_ORDER,
  DIFFICULTY_ORDER,
  LIVES_MAX,
  LIVES_MIN,
  SPEED_ORDER,
  TARGET_PCT_MAX,
  TARGET_PCT_MIN,
  TARGET_PCT_STEP,
  TIMED_SEC_MAX,
  TIMED_SEC_MIN,
  TIMED_SEC_STEP,
} from "./engine/constants.js";
import type { BoardSizeKey, BotDifficulty, SpeedKey, WinMode } from "./engine/types.js";

export * as PaperIoEngine from "./engine/index.js";
// Re-export the tuning the lobby UI + room need directly.
export {
  BOARD_SIZES,
  BOARD_SIZE_ORDER,
  DIFFICULTIES,
  DIFFICULTY_ORDER,
  LIVES_DEFAULT,
  LIVES_MAX,
  LIVES_MIN,
  SPEEDS,
  SPEED_ORDER,
  TARGET_PCT_DEFAULT,
  TARGET_PCT_MAX,
  TARGET_PCT_MIN,
  TARGET_PCT_STEP,
  TICK_RATE as PAPERIO_TICK_RATE,
  TIMED_SEC_DEFAULT,
  TIMED_SEC_MAX,
  TIMED_SEC_MIN,
  TIMED_SEC_STEP,
} from "./engine/constants.js";
export type { BoardSizeKey, BotDifficulty, SpeedKey, WinMode } from "./engine/types.js";

export const PAPERIO = "paperio";

/** Client -> server messages. */
export const PaperIoMsg = {
  /** Steer the head. Payload: { heading: number } radians. Send on change, throttled. */
  STEER: "paperio/steer",
  /**
   * Host-only, lobby-only lobby settings. Partial payload, any of:
   * { boardSize, speed, winMode, targetPercent, timedSeconds, lives }.
   */
  CONFIG: "paperio/config",
} as const;

export interface PaperIoSteerPayload {
  heading: number;
}

// ---- lobby-setting validators (used by the room to reject bad input) --------

export function isBoardSize(v: unknown): v is BoardSizeKey {
  return typeof v === "string" && (BOARD_SIZE_ORDER as string[]).includes(v);
}
export function isSpeed(v: unknown): v is SpeedKey {
  return typeof v === "string" && (SPEED_ORDER as string[]).includes(v);
}
export function isWinMode(v: unknown): v is WinMode {
  return v === "target" || v === "timed";
}
export function isBotDifficulty(v: unknown): v is BotDifficulty {
  return typeof v === "string" && (DIFFICULTY_ORDER as string[]).includes(v);
}
export function isValidLives(v: unknown): v is number {
  return typeof v === "number" && Number.isInteger(v) && v >= LIVES_MIN && v <= LIVES_MAX;
}
export function isValidTargetPercent(v: unknown): v is number {
  return (
    typeof v === "number" &&
    Number.isInteger(v) &&
    v >= TARGET_PCT_MIN &&
    v <= TARGET_PCT_MAX &&
    v % TARGET_PCT_STEP === 0
  );
}
export function isValidTimedSeconds(v: unknown): v is number {
  return (
    typeof v === "number" &&
    Number.isInteger(v) &&
    v >= TIMED_SEC_MIN &&
    v <= TIMED_SEC_MAX &&
    v % TIMED_SEC_STEP === 0
  );
}

// ---- synced schema ----------------------------------------------------------

export class PaperIoPlayer extends BasePlayer {
  /** Smooth head position, in cell units (matches the engine's float pos). */
  @type("float32") x = 0;
  @type("float32") y = 0;
  @type("float32") heading = 0;
  @type("uint8") lives = 0;
  /** On the board right now (false during the death pause). */
  @type("boolean") alive = true;
  /** In the short death pause. */
  @type("boolean") dead = false;
  /** Out of the round for good. */
  @type("boolean") eliminated = false;
  /** Cells owned (for the HUD percentage / scoreboard). */
  @type("uint16") cellsOwned = 0;
  /** Current trail, as packed cell indices (y * cols + x). */
  @type(["uint16"]) trail = new ArraySchema<number>();
}

export class PaperIoState extends BaseState {
  @type("uint16") cols = 0;
  @type("uint16") rows = 0;
  /** Territory owner per cell: actor.id (seat + 1), or 0 for empty. Row-major. */
  @type(["uint8"]) grid = new ArraySchema<number>();

  // ---- lobby settings (mirrored for the lobby UI; host-set) ----
  @type("string") boardSize = "medium";
  @type("string") speed = "normal";
  @type("string") winMode = "target";
  @type("uint8") targetPercent = 0;
  @type("uint16") timedSeconds = 0;
  @type("uint8") startLives = 0;
  /** Epoch ms the round ends in timed mode (0 otherwise); clients show a countdown. */
  @type("float64") endsAt = 0;
}
