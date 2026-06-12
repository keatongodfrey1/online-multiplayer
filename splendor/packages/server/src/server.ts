// Transport-agnostic server: owns connections, routes client messages to rooms,
// and manages room/session lifecycle. The ws adapter feeds it parsed messages.

import { newRoomCode, newSessionToken } from "./ids";
import { Room } from "./room";
import { RealScheduler, Scheduler } from "./scheduler";
import { ClientMessage, Connection, ServerMessage } from "./protocol";

export interface ServerOptions {
  scheduler?: Scheduler;
  newSeed?: () => number;
  turnTimeoutMs?: number;
}

export class GameServer {
  private connections = new Map<string, Connection>();
  private rooms = new Map<string, Room>();
  private bindings = new Map<string, { code: string; token: string }>(); // connId -> room/session
  private tokenIndex = new Map<string, string>(); // token -> room code
  private scheduler: Scheduler;
  private newSeed?: () => number;
  private turnTimeoutMs?: number;

  constructor(opts: ServerOptions = {}) {
    this.scheduler = opts.scheduler ?? new RealScheduler();
    this.newSeed = opts.newSeed;
    this.turnTimeoutMs = opts.turnTimeoutMs;
  }

  private deliver = (connId: string, msg: ServerMessage): void => {
    this.connections.get(connId)?.send(msg);
  };

  onConnect(conn: Connection): void {
    this.connections.set(conn.id, conn);
  }

  onDisconnect(connId: string): void {
    const b = this.bindings.get(connId);
    if (b) {
      const room = this.rooms.get(b.code);
      room?.onConnectionLost(connId);
      this.bindings.delete(connId);
      if (room && room.isEmpty() && room.phase !== "playing") this.gcRoom(b.code);
    }
    this.connections.delete(connId);
  }

  onMessage(connId: string, msg: ClientMessage): void {
    const send = (m: ServerMessage) => this.deliver(connId, m);
    switch (msg.type) {
      case "CREATE_ROOM": {
        if (this.bindings.has(connId)) return send({ type: "ERROR", code: "ALREADY_IN_ROOM", message: "leave first" });
        const code = this.uniqueCode();
        const room = new Room(code, { deliver: this.deliver, scheduler: this.scheduler, newSeed: this.newSeed, turnTimeoutMs: this.turnTimeoutMs }, msg.settings);
        this.rooms.set(code, room);
        const token = newSessionToken();
        room.addHuman(token, msg.displayName, connId);
        this.bind(connId, code, token);
        return;
      }
      case "JOIN_ROOM": {
        if (this.bindings.has(connId)) return send({ type: "ERROR", code: "ALREADY_IN_ROOM", message: "leave first" });
        const room = this.rooms.get(msg.roomCode.toUpperCase());
        if (!room) return send({ type: "ERROR", code: "NO_ROOM", message: "no such room" });
        const token = newSessionToken();
        if (room.phase === "lobby") {
          try {
            room.addHuman(token, msg.displayName, connId);
          } catch {
            room.addSpectator(token, msg.displayName, connId); // room full -> spectate
          }
        } else {
          room.addSpectator(token, msg.displayName, connId); // joining after start -> spectator
        }
        this.bind(connId, room.code, token);
        return;
      }
      case "RECONNECT": {
        const code = this.tokenIndex.get(msg.sessionToken);
        const room = code ? this.rooms.get(code) : undefined;
        if (!room || !room.reconnect(msg.sessionToken, connId)) {
          return send({ type: "ERROR", code: "UNKNOWN_SESSION", message: "cannot reconnect" });
        }
        this.bind(connId, room.code, msg.sessionToken);
        return;
      }
      case "LEAVE_ROOM": {
        const b = this.bindings.get(connId);
        if (!b) return;
        this.rooms.get(b.code)?.leave(b.token);
        this.bindings.delete(connId);
        this.tokenIndex.delete(b.token);
        const room = this.rooms.get(b.code);
        if (room && room.isEmpty() && room.phase !== "playing") this.gcRoom(b.code);
        return;
      }
      default: {
        // All remaining messages require an established binding.
        const b = this.bindings.get(connId);
        if (!b) return send({ type: "ERROR", code: "NOT_IN_ROOM", message: "join or create a room first" });
        const room = this.rooms.get(b.code);
        if (!room) return send({ type: "ERROR", code: "NO_ROOM", message: "room no longer exists" });
        this.routeRoom(room, b.token, msg);
      }
    }
  }

  private routeRoom(room: Room, token: string, msg: ClientMessage): void {
    switch (msg.type) {
      case "ADD_AI":
        return room.addAi(token, msg.difficulty);
      case "REMOVE_SEAT":
        return room.removeSeat(token, msg.seat);
      case "SET_OPTIONS":
        return room.setOptions(token, msg.options);
      case "START_GAME":
        return room.start(token);
      case "MOVE":
        return room.applyClientMove(token, msg.reqId, msg.move);
      case "RESOLVE":
        return room.applyClientResolution(token, msg.reqId, msg.resolution);
      case "CHAT":
        return room.chat(token, msg.text);
      default:
        return;
    }
  }

  // ---- helpers ----
  private bind(connId: string, code: string, token: string): void {
    this.bindings.set(connId, { code, token });
    this.tokenIndex.set(token, code);
  }
  private uniqueCode(): string {
    let code = newRoomCode();
    while (this.rooms.has(code)) code = newRoomCode();
    return code;
  }
  private gcRoom(code: string): void {
    this.rooms.delete(code);
    for (const [t, c] of this.tokenIndex) if (c === code) this.tokenIndex.delete(t);
  }

  // ---- introspection (tests / ops) ----
  getRoom(code: string): Room | undefined {
    return this.rooms.get(code);
  }
  roomCount(): number {
    return this.rooms.size;
  }
}
