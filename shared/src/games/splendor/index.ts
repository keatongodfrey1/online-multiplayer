/**
 * Splendor - shared schema + messages.
 *
 * The rules live in the ported engine (./engine/, server-driven); this schema
 * is the public mirror the server syncs to clients. Engine seats are array
 * indices here: SplendorState.seats[i] is engine seat i.
 */
import { ArraySchema, entity, Schema, type, view } from "@colyseus/schema";
import { BasePlayer, BaseState } from "../../state.js";

export * as SplendorEngine from "./engine/index.js";

export const SPLENDOR = "splendor";

/**
 * Client -> server messages. Payloads are engine Move / Resolution JSON
 * (whitelist-sanitized server-side). There is no PASS message: a forced pass
 * is only legal when a player has zero legal moves, so the server applies it
 * automatically.
 */
export const SplendorMsg = {
  MOVE: "splendor/move",
  RESOLVE: "splendor/resolve",
  /** Host-only, lobby-only. Payload: { turnSeconds: 0 | 15 | 30 | ... | 300 }. */
  CONFIG: "splendor/config",
  /**
   * Any player, timed games only. Payload: { paused: boolean }. Pausing
   * freezes the turn clock and blocks moves until someone resumes.
   */
  PAUSE: "splendor/pause",
} as const;

/** Turn-timer options: 0 = off, otherwise 15s steps up to 5 minutes. */
export const SPLENDOR_TURN_STEP_SECONDS = 15;
export const SPLENDOR_TURN_MAX_SECONDS = 300;
export const SPLENDOR_TURN_DEFAULT_SECONDS = 120;

export function isValidSplendorTurnSeconds(v: unknown): v is number {
  return (
    typeof v === "number" &&
    Number.isInteger(v) &&
    v >= 0 &&
    v <= SPLENDOR_TURN_MAX_SECONDS &&
    v % SPLENDOR_TURN_STEP_SECONDS === 0
  );
}

/** Reused for bank gems / player gems / bonuses / card costs / noble requirements. */
export class ColorCounts extends Schema {
  @type("uint8") white = 0;
  @type("uint8") blue = 0;
  @type("uint8") green = 0;
  @type("uint8") red = 0;
  @type("uint8") black = 0;
}

export class SplendorCard extends Schema {
  /** Engine card id 1..90; 0 = empty market slot sentinel. */
  @type("uint8") id = 0;
  @type("uint8") tier = 0;
  /** Bonus gem color ("white" | "blue" | "green" | "red" | "black"). */
  @type("string") bonus = "";
  @type("uint8") points = 0;
  @type(ColorCounts) cost = new ColorCounts();
}

export class SplendorNoble extends Schema {
  /** Engine noble id 1..10. */
  @type("uint8") id = 0;
  @type("uint8") points = 3;
  @type(ColorCounts) requirement = new ColorCounts();
}

/** One engine seat; SplendorState.seats index === engine seat. */
export class SplendorSeat extends Schema {
  /** Owning player's sessionId; "" once they left for good. */
  @type("string") sessionId = "";
  @type("string") nickname = "";
  /** Left for good - the server's policy plays this seat out. */
  @type("boolean") gone = false;
  @type(ColorCounts) gems = new ColorCounts();
  @type("uint8") gold = 0;
  @type(ColorCounts) bonuses = new ColorCounts();
  @type("uint8") points = 0;
  @type([SplendorCard]) built = new ArraySchema<SplendorCard>();
  @type([SplendorNoble]) nobles = new ArraySchema<SplendorNoble>();
  /** Public count of reserved cards (their identity is private). */
  @type("uint8") reservedCount = 0;
  /** PRIVATE: synced only to the owner via StateView (grantPrivateView). */
  @view() @type([SplendorCard]) reserved = new ArraySchema<SplendorCard>();
}

@entity
export class SplendorPlayer extends BasePlayer {}

export class SplendorState extends BaseState {
  @type([SplendorSeat]) seats = new ArraySchema<SplendorSeat>();
  @type(ColorCounts) bank = new ColorCounts();
  @type("uint8") bankGold = 0;
  /** 12 slots, row-major: 0-3 tier 1, 4-7 tier 2, 8-11 tier 3. id 0 = empty. */
  @type([SplendorCard]) market = new ArraySchema<SplendorCard>();
  /** Cards left in each hidden deck, [tier1, tier2, tier3]. */
  @type(["uint8"]) deckCounts = new ArraySchema<number>(0, 0, 0);
  /** Nobles still available on the board. */
  @type([SplendorNoble]) nobles = new ArraySchema<SplendorNoble>();
  /** sessionId of the seat that must act (move OR sub-decision). */
  @type("string") currentTurn = "";
  @type("uint8") awaitingSeat = 0;
  /** "MOVE" | "DISCARD" | "PICK_NOBLE"; "" once the game is over. */
  @type("string") awaitingType = "";
  /** Noble ids to choose from while awaitingType === "PICK_NOBLE". */
  @type(["uint8"]) nobleChoices = new ArraySchema<number>();
  /** Tokens to discard while awaitingType === "DISCARD". */
  @type("uint8") discardCount = 0;
  /** Engine endFlag: someone reached 15, the round is being finished. */
  @type("boolean") lastRound = false;
  @type("uint16") turnCount = 0;
  /** Turn time limit in seconds; 0 = untimed. Host-set in the lobby. */
  @type("uint16") turnSeconds = SPLENDOR_TURN_DEFAULT_SECONDS;
  /**
   * Epoch ms when the current turn expires (clients render the countdown
   * from this); 0 when untimed, paused, or game over.
   */
  @type("float64") turnDeadline = 0;
  /** Game manually paused (timed games only): clock frozen, moves blocked. */
  @type("boolean") paused = false;
  /** Nickname of whoever paused, for the banner. */
  @type("string") pausedBy = "";
}
