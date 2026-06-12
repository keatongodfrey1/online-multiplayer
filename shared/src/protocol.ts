/**
 * Protocol constants shared by server and client.
 *
 * Message names defined here are handled by the framework (BaseGameRoom /
 * lobby UI). Per-game messages live in shared/src/games/<game>.ts.
 */

/** Room codes are 4 letters, from an alphabet without lookalikes (I/O/Q/U). */
export const ROOM_CODE_ALPHABET = "ABCDEFGHJKLMNPRSTVWXYZ";
export const ROOM_CODE_LENGTH = 4;
export const ROOM_CODE_REGEX = /^[A-Z]{4}$/;

export const NICKNAME_MIN_LENGTH = 1;
export const NICKNAME_MAX_LENGTH = 16;

/** Game lifecycle phase, mirrored in BaseState.phase. */
export const Phase = {
  LOBBY: "lobby",
  PLAYING: "playing",
  ENDED: "ended",
} as const;
export type PhaseValue = (typeof Phase)[keyof typeof Phase];

/** Framework-level messages (client -> server), handled by BaseGameRoom. */
export const LobbyMsg = {
  /** Host only: start the game (requires minPlayers). */
  START: "lobby/start",
  /** Host only, lobby only: kick a player. Payload: { sessionId: string } */
  KICK: "lobby/kick",
  /** Any player, ended phase: vote to play again. */
  REMATCH: "lobby/rematch",
  /**
   * Host only, lobby only, games with supportsBots: seat an AI player.
   * Bots count toward min/max players, appear in the roster, and are
   * removed with the regular KICK message.
   */
  ADD_BOT: "lobby/addBot",
} as const;

/** Framework-level messages (server -> client). */
export const ServerMsg = {
  /** Sent when the player was kicked by the host. */
  KICKED: "lobby/kicked",
} as const;

/**
 * Connection keepalive plumbing (NOT game logic - nothing reads these).
 *
 * A WebSocket that goes quiet - e.g. a player just sitting in the lobby - can
 * be idle-closed by a hosting proxy (Render/Cloudflare) seconds after it
 * connects, producing an unrecoverable "Reconnecting..." overlay. WebSocket
 * control-frame pings don't help (those proxies don't reliably relay them,
 * which is why the transport's ping is disabled - see app.config.ts). Instead
 * we keep BOTH halves of the socket warm with tiny application data-frame
 * messages, which proxies do relay, on a short interval:
 *   - HEARTBEAT (client -> server): sent by GameClient for the life of the room.
 *   - KEEPALIVE (server -> client): broadcast by BaseGameRoom. The "__" prefix
 *     makes the client SDK ignore it silently, so no view code handles it.
 * Sending in both directions covers proxies that idle on either direction.
 */
export const ConnectionMsg = {
  HEARTBEAT: "fw/heartbeat",
  KEEPALIVE: "__keepalive",
} as const;

/**
 * How often each side sends its keepalive. Must stay comfortably BELOW the
 * proxy's idle timeout. Production drops were observed ~5-15s after connect, so
 * 4s leaves margin while staying cheap (a few bytes per beat).
 */
export const KEEPALIVE_INTERVAL_MS = 4000;

/**
 * Error codes used when rejecting a join (thrown as ServerError on the
 * server; surfaced in the client's catch handler). 4100+ to stay clear of
 * Colyseus' own 4000-4010 close-code range.
 */
export const JoinError = {
  INVALID_NICKNAME: 4101,
  DUPLICATE_NICKNAME: 4102,
  GAME_IN_PROGRESS: 4103,
  ROOM_FULL: 4104,
  SERVER_AT_CAPACITY: 4105,
} as const;

/** End-of-game reasons written to BaseState.endReason. */
export const EndReason = {
  /** A seat won. Full value is e.g. "win:0" (seat index). */
  WIN_PREFIX: "win:",
  DRAW: "draw",
  /** Too many players left to keep playing. */
  ABANDONED: "abandoned",
} as const;

export interface JoinOptions {
  nickname: string;
}
