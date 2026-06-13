/**
 * Space Chase - synced schema + client->server messages.
 *
 * The rules live in the pure engine (./engine/, server-driven); this schema is
 * the public mirror the room syncs to clients. SpaceChaseState.seats[i] is
 * engine seat i. Anything a player must still see after a refresh lives here
 * (positions, whose turn, any open prompt); the deck CONTENTS stay server-only.
 */
import { ArraySchema, entity, Schema, type, view } from "@colyseus/schema";
import { BasePlayer, BaseState } from "../../state.js";
import { SC_TURN_DEFAULT_SECONDS } from "./constants.js";

// ── Messages (client -> server; every payload is validated server-side) ──

export const SpaceChaseMsg = {
  /** Roll the die. Payload: {} */
  ROLL: "spacechase/roll",
  /** Draw the top card. Payload: {} */
  DRAW: "spacechase/draw",
  /** Answer a TARGET prompt. Payload: { seat: number } (seats[] index). */
  TARGET: "spacechase/target",
  /** Answer a MULTI_TARGET prompt. Payload: { seats: number[] } - exactly promptCount distinct live seats. */
  TARGETS: "spacechase/targets",
  /** Answer a CHOICE prompt. Payload: { choice: string } (an ScChoice value). */
  CHOICE: "spacechase/choice",
  /** Answer a SPACE prompt. Payload: { space: number } (integer 1..67). */
  SPACE: "spacechase/space",
  /** Answer the SATELLITE prompt. Payload: { order: number[] } - a permutation of indices 0..peek.length-1 (indices, not card ids: #30 is duplicated). order[0] = next card drawn. */
  SATELLITE: "spacechase/satellite",
  /** Lobby setting (host + lobby phase only). Payload: { turnSeconds: number }. */
  CONFIG: "spacechase/config",
  // SAVE / LOAD / SAVE_DATA are framework messages (LobbyMsg / ServerMsg).
} as const;

export interface ScTargetPayload {
  seat: number;
}
export interface ScTargetsPayload {
  seats: number[];
}
export interface ScChoicePayload {
  choice: string;
}
export interface ScSpacePayload {
  space: number;
}
export interface ScSatellitePayload {
  order: number[];
}
export interface ScConfigPayload {
  turnSeconds: number;
}

// ── Schema ──

/**
 * One game event: drives the on-screen log and client animations.
 * `seq` is monotonically increasing for the whole game, so clients track
 * the last seq they animated and never replay after a refresh.
 * `a`/`b` are kind-specific details (e.g. move: from/to; roll: die value;
 * draw: card id; tiebreakRoll: seat's roll).
 */
export class SpaceChaseEvent extends Schema {
  @type("uint32") seq = 0;
  @type("string") kind = "";
  @type("int8") seat = -1;
  @type("int16") a = 0;
  @type("int16") b = 0;
  @type("string") text = "";
}

/**
 * A seat in turn order (index into SpaceChaseState.seats). Seats persist
 * for the whole game even if the player leaves (gone = true), so the
 * final-results screen can show everyone.
 */
export class SpaceChaseSeat extends Schema {
  @type("string") sessionId = "";
  @type("string") nickname = "";
  /** Left for good: rocket removed from the board, skipped in rotation. */
  @type("boolean") gone = false;
  /** 0 = START, 1..67 = board, 68 = Finish. Entry mouth while in a portal. */
  @type("uint8") position = 0;
  /** 0 = not in a portal, else PortalDef.id (1..3). */
  @type("uint8") portalId = 0;
  /** 0..internal - how far along the tunnel. */
  @type("uint8") portalProgress = 0;
  /** true = entered at the `a` end (heading a->b). */
  @type("boolean") portalForward = true;
  /** Mouth # just exited (re-entry guard); 0 = none. Cleared at own turn start. */
  @type("uint8") justExitedPortal = 0;
  @type("uint8") lostTurns = 0;
  @type("uint8") extraTurns = 0;
  /** Shield active while state.roundNumber < this. 0 = no shield. */
  @type("uint16") shieldExpiresRound = 0;
  @type("boolean") spaceSuit = false;
  /** How many "6-7" cards this seat has drawn (2nd one -> Space 67). */
  @type("uint8") sixSevenCount = 0;
  /** Time Loop source: "" | "dice" | "card". */
  @type("string") lastActionType = "";
  /** dice: amount moved (already doubled if suited); card: card id. */
  @type("uint8") lastActionValue = 0;
  /**
   * PRIVATE (owner-only via StateView): the Satellite peek, next-draw
   * first. Non-empty only while this seat's SATELLITE prompt is open.
   */
  @view() @type(["uint8"]) peek = new ArraySchema<number>();
}

/** No fields beyond BasePlayer; per-seat game data lives in SpaceChaseSeat. */
@entity
export class SpaceChasePlayer extends BasePlayer {}

export class SpaceChaseState extends BaseState {
  /** Index = turn order (seat 0 = Player 1, goes first). */
  @type([SpaceChaseSeat]) seats = new ArraySchema<SpaceChaseSeat>();
  /** sessionId of the acting player ("" between games). */
  @type("string") currentTurn = "";
  /** seats[] index of the acting player. */
  @type("uint8") currentSeat = 0;
  /** Full table go-arounds completed (drives shield expiry). */
  @type("uint16") roundNumber = 0;
  /** Cards left in the draw pile (contents are server-only). */
  @type("uint8") deckCount = 0;
  @type("uint8") discardCount = 0;
  /** Most recently drawn card id (top of discard); 0 = none yet. */
  @type("uint8") lastCardId = 0;
  // Open prompt - ground truth so a refresh restores any open modal.
  @type("string") awaitingType = "";
  /** seats[] index that must answer (always the current player). */
  @type("uint8") promptSeat = 0;
  /** Card that opened the prompt (0 while awaiting ACTION). */
  @type("uint8") promptCardId = 0;
  /** Sub-step key (an ScPrompt value). */
  @type("string") promptContext = "";
  /** Space-Suit multiplier captured when the card was drawn (1 or 2). */
  @type("uint8") promptMult = 1;
  /** Required selection count for MULTI_TARGET. */
  @type("uint8") promptCount = 0;
  /** Step-1 target carried into step 2 (Black Hole / 6-7); -1 = none. */
  @type("int8") promptTargetSeat = -1;
  // Turn timer.
  @type("uint16") turnSeconds = SC_TURN_DEFAULT_SECONDS;
  /** Epoch ms; 0 = untimed or frozen (current player disconnected). */
  @type("float64") turnDeadline = 0;
  /** Rolling event log (see SpaceChaseEvent). */
  @type([SpaceChaseEvent]) events = new ArraySchema<SpaceChaseEvent>();
  // loadedSave lives on BaseState (framework-owned save/resume).
}
