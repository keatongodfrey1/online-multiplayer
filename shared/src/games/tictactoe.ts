/**
 * Tic-Tac-Toe - shared schema + messages.
 * The reference example for turn-based games (see ADDING_A_GAME.md).
 */
import { ArraySchema, entity, type } from "@colyseus/schema";
import { BasePlayer, BaseState } from "../state.js";

export const TICTACTOE = "tictactoe";

/** Client -> server messages. */
export const TicTacToeMsg = {
  /** Place a mark. Payload: { cell: 0-8 } (row-major). */
  MOVE: "ttt/move",
} as const;

export interface TicTacToeMovePayload {
  cell: number;
}

/** Seconds per turn before the turn is skipped. */
export const TTT_TURN_SECONDS = 60;

/**
 * No extra fields beyond BasePlayer. Schema subclasses that add no
 * @type() fields of their own must be tagged @entity to register with
 * the serializer's TypeRegistry.
 */
@entity
export class TicTacToePlayer extends BasePlayer {}

export class TicTacToeState extends BaseState {
  /** 9 cells, row-major. 0 = empty, 1 = seat 0 (X), 2 = seat 1 (O). */
  @type(["uint8"]) board = new ArraySchema<number>(0, 0, 0, 0, 0, 0, 0, 0, 0);
  /** sessionId of the player whose turn it is. */
  @type("string") currentTurn = "";
}

/** All 8 winning lines (indices into the board). */
export const TTT_LINES: ReadonlyArray<readonly [number, number, number]> = [
  [0, 1, 2],
  [3, 4, 5],
  [6, 7, 8],
  [0, 3, 6],
  [1, 4, 7],
  [2, 5, 8],
  [0, 4, 8],
  [2, 4, 6],
];
