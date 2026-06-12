// Wire protocol (SPEC §14). JSON over WebSocket.
// Client->server messages carry a reqId on mutating actions; server->client
// state messages carry a monotonic seq.

import type { GameOptions, InputType, Move, RankEntry, RedactedState, Resolution } from "@splendor/engine";

export type Difficulty = "easy" | "medium" | "hard";

export interface RoomSeatView {
  seat: number;
  name: string;
  kind: "human" | "ai";
  connected: boolean;
  difficulty?: Difficulty;
}

export interface RoomView {
  code: string;
  phase: "lobby" | "playing" | "over";
  hostSeat: number;
  seats: RoomSeatView[];
  options: GameOptions;
  aiDifficulty: Difficulty;
  spectatorCount: number;
}

export type LobbySettings = Partial<GameOptions> & { aiDifficulty?: Difficulty };

// ---- client -> server ----
export type ClientMessage =
  | { type: "CREATE_ROOM"; displayName: string; settings?: LobbySettings }
  | { type: "JOIN_ROOM"; roomCode: string; displayName: string }
  | { type: "LEAVE_ROOM" }
  | { type: "ADD_AI"; difficulty?: Difficulty }
  | { type: "REMOVE_SEAT"; seat: number }
  | { type: "SET_OPTIONS"; options: LobbySettings }
  | { type: "START_GAME" }
  | { type: "MOVE"; reqId: string; move: Move }
  | { type: "RESOLVE"; reqId: string; resolution: Resolution }
  | { type: "RECONNECT"; sessionToken: string }
  | { type: "CHAT"; text: string };

// ---- server -> client ----
export type ServerMessage =
  | { type: "ROOM_UPDATE"; room: RoomView }
  | { type: "SESSION"; sessionToken: string; seat: number | "spectator" }
  | { type: "GAME_STATE"; you: number | "spectator"; seq: number; view: RedactedState }
  | { type: "MOVE_APPLIED"; seq: number; by: number; move?: Move; resolution?: Resolution | "PASS"; summary: string }
  | { type: "AWAITING_INPUT"; seat: number; inputType: InputType; nobleChoices?: number[]; discardCount?: number; deadlineTs?: number }
  | { type: "REJECTED"; reqId?: string; code: string; message: string }
  | { type: "GAME_OVER"; ranking: RankEntry[]; winnerSeat: number }
  | { type: "PLAYER_CONNECTION"; seat: number; connected: boolean }
  | { type: "CHAT"; seat: number | "spectator"; name: string; text: string }
  | { type: "ERROR"; code: string; message: string };

/** A transport-agnostic client connection. The ws adapter implements this. */
export interface Connection {
  id: string;
  send(msg: ServerMessage): void;
  close(): void;
}
