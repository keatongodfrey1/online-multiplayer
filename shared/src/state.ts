/**
 * Base schema classes every game's state extends.
 *
 * These are @colyseus/schema classes: the server mutates them and Colyseus
 * automatically syncs changes to every connected client. The client imports
 * them for typing (and they are safe to import at runtime - the client SDK
 * already bundles @colyseus/schema).
 */
import { MapSchema, Schema, type } from "@colyseus/schema";

export class BasePlayer extends Schema {
  /** Colyseus session id - the key into BaseState.players. */
  @type("string") sessionId = "";
  @type("string") nickname = "";
  /** Stable 0-based seat index; survives reconnection. */
  @type("uint8") seat = 0;
  @type("boolean") connected = true;
  @type("boolean") isHost = false;
  /** True while this player has voted to play again (ended phase only). */
  @type("boolean") wantsRematch = false;
}

export class BaseState extends Schema {
  /** "lobby" | "playing" | "ended" - see Phase in protocol.ts. */
  @type("string") phase = "lobby";
  /** All players, keyed by sessionId. */
  @type({ map: BasePlayer }) players = new MapSchema<BasePlayer>();
  @type("string") hostSessionId = "";
  /** Why the game ended: "win:<seat>" | "draw" | "abandoned" | "". */
  @type("string") endReason = "";
  /** The 4-letter join code (also the Colyseus roomId), mirrored for UI. */
  @type("string") roomCode = "";
  /** Player count limits, mirrored from the room config for lobby UI. */
  @type("uint8") minPlayers = 0;
  @type("uint8") maxPlayers = 0;
}
