/**
 * Dot Arena - shared schema + messages.
 * The reference example for real-time games (server tick loop,
 * continuous input, late join). 2-8 players race to collect pellets.
 */
import { MapSchema, Schema, type } from "@colyseus/schema";
import { BasePlayer, BaseState } from "../state.js";

export const ARENA = "arena";

/** Client -> server messages. */
export const ArenaMsg = {
  /**
   * Movement input. Payload: { dx, dy } each in -1..1 (direction the
   * player is steering; 0,0 = stop). Send on change, not per frame.
   */
  INPUT: "arena/input",
} as const;

export interface ArenaInputPayload {
  dx: number;
  dy: number;
}

export const ARENA_TICK_RATE = 20; // server ticks per second
export const ARENA_WIDTH = 800; // logical field size
export const ARENA_HEIGHT = 600;
export const ARENA_PLAYER_RADIUS = 14;
export const ARENA_PELLET_RADIUS = 7;
export const ARENA_PLAYER_SPEED = 220; // units per second
export const ARENA_PELLET_COUNT = 10;
export const ARENA_WIN_SCORE = 10;

export class ArenaPlayer extends BasePlayer {
  @type("float32") x = 0;
  @type("float32") y = 0;
  @type("uint8") score = 0;
}

export class Pellet extends Schema {
  @type("float32") x = 0;
  @type("float32") y = 0;
}

export class ArenaState extends BaseState {
  /** Pellets keyed by a server-assigned id. */
  @type({ map: Pellet }) pellets = new MapSchema<Pellet>();
}
