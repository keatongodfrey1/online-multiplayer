/**
 * GameClient - thin wrapper over the Colyseus SDK that adds:
 *  - create / join-by-code with nickname
 *  - session persistence + tryResume() after a page refresh
 *  - friendly error messages for the join failure cases
 */
import { ColyseusSDK, type Room } from "@colyseus/sdk";
import {
  ConnectionMsg,
  JoinError,
  KEEPALIVE_INTERVAL_MS,
  ROOM_CODE_REGEX,
  type BaseState,
} from "@backbone/shared";
import {
  clearSession,
  loadSession,
  saveNickname,
  saveSession,
} from "./session.js";

/**
 * In dev the Vite client (e.g. :5173) talks to the Colyseus server on
 * :2567 of the same host - which also works for phones on the same LAN.
 * In production both are served from one origin.
 */
export function defaultServerUrl(): string {
  if (import.meta.env.DEV) {
    return `${location.protocol}//${location.hostname}:2567`;
  }
  return location.origin;
}

export class GameClient {
  readonly sdk: ColyseusSDK;

  constructor(serverUrl: string = defaultServerUrl()) {
    this.sdk = new ColyseusSDK(serverUrl);
  }

  async create(gameType: string, nickname: string): Promise<Room<any, BaseState>> {
    const room = await this.sdk.create<BaseState>(gameType, { nickname });
    this.persist(room, room.name || gameType, nickname);
    return room;
  }

  /** Join by code. The game type comes back from the server (room.name). */
  async join(code: string, nickname: string): Promise<Room<any, BaseState>> {
    const normalized = code.trim().toUpperCase();
    if (!ROOM_CODE_REGEX.test(normalized)) {
      throw new Error("Codes are 4 letters, like KXRT.");
    }
    const room = await this.sdk.joinById<BaseState>(normalized, { nickname });
    this.persist(room, room.name, nickname);
    return room;
  }

  /**
   * Try to resume the session stored on this device (page refresh, phone
   * coming back). Returns the room plus its gameType, or null if there is
   * nothing to resume / the game no longer exists.
   */
  async tryResume(): Promise<{ room: Room<any, BaseState>; gameType: string } | null> {
    const session = loadSession();
    if (!session) return null;
    try {
      const room = await this.sdk.reconnect<BaseState>(session.reconnectionToken);
      this.persist(room, session.gameType, session.nickname);
      return { room, gameType: session.gameType };
    } catch {
      clearSession();
      return null;
    }
  }

  private persist(room: Room<any, BaseState>, gameType: string, nickname: string): void {
    saveNickname(nickname);
    saveSession({
      reconnectionToken: room.reconnectionToken,
      code: room.roomId,
      gameType,
      nickname,
    });
    // The SDK's automatic reconnection refreshes the token after each
    // successful in-page reconnect; keep the stored copy current.
    room.onReconnect(() => {
      saveSession({
        reconnectionToken: room.reconnectionToken,
        code: room.roomId,
        gameType,
        nickname,
      });
    });
    this.startHeartbeat(room);
  }

  /**
   * Keep the WebSocket from being idle-closed by hosting proxies (Render): a
   * player just sitting in the lobby sends nothing, so we send a tiny heartbeat
   * upstream on a short interval (the server warms the downstream half - see
   * BaseGameRoom). Runs for the life of the room; the SDK buffers sends across
   * brief reconnects, so we stop only when the room is left for good.
   */
  private startHeartbeat(room: Room<any, BaseState>): void {
    const timer = setInterval(() => {
      try {
        room.send(ConnectionMsg.HEARTBEAT);
      } catch {
        // The SDK can reject a send in the gap between drop and reconnect.
      }
    }, KEEPALIVE_INTERVAL_MS);
    room.onLeave(() => clearInterval(timer));
  }
}

/** Map a join failure to a message a player can act on. */
export function friendlyJoinError(error: unknown): string {
  const e = error as { code?: number; message?: string };
  switch (e?.code) {
    case JoinError.INVALID_NICKNAME:
    case JoinError.DUPLICATE_NICKNAME:
    case JoinError.GAME_IN_PROGRESS:
    case JoinError.ROOM_FULL:
    case JoinError.SERVER_AT_CAPACITY:
      return e.message || "Could not join the game.";
    default:
      break;
  }
  const msg = (e?.message || "").toLowerCase();
  if (msg.includes("not found") || msg.includes("locked") || msg.includes("no longer exists")) {
    return "Game not found. Check the code - or the game may have ended.";
  }
  if (e?.message && e.message.length < 120) {
    return e.message;
  }
  return "Could not join the game. Check the code and try again.";
}
