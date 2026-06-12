// A single room: lobby management + authoritative game play.
// Transport-agnostic — all output goes through the injected `deliver(connId, msg)`.
// Per-room message handling is synchronous, which guarantees the serialization
// the spec requires (no interleaving of two messages for the same room).

import {
  applyMove,
  applyPass,
  applyResolution,
  createGame,
  GameOptions,
  GameState,
  GreedyPolicy,
  isLegalMove,
  legalMoves,
  Move,
  Policy,
  RandomPolicy,
  ranking,
  redact,
  Resolution,
} from "@splendor/engine";
import { newSeed } from "./ids";
import { Scheduler, TimerHandle } from "./scheduler";
import { Difficulty, LobbySettings, RoomView, ServerMessage } from "./protocol";

type Occupant =
  | { type: "human"; token: string; name: string; connId: string | null; connected: boolean; timeout: TimerHandle | null }
  | { type: "ai"; name: string; difficulty: Difficulty };

const MAX_SEATS = 4;

export interface RoomDeps {
  deliver: (connId: string, msg: ServerMessage) => void;
  scheduler: Scheduler;
  newSeed?: () => number;
  turnTimeoutMs?: number;
}

export class Room {
  readonly code: string;
  phase: "lobby" | "playing" | "over" = "lobby";
  private seats: Occupant[] = [];
  private hostSeat = 0;
  private options: GameOptions;
  private aiDifficulty: Difficulty = "medium";
  private game: GameState | null = null;
  private seq = 0;
  private processedReqIds = new Set<string>();
  private spectators = new Map<string, { name: string; connId: string | null }>();

  private deliver: RoomDeps["deliver"];
  private scheduler: Scheduler;
  private seedSource: () => number;
  private turnTimeoutMs: number;

  constructor(code: string, deps: RoomDeps, settings?: LobbySettings) {
    this.code = code;
    this.deliver = deps.deliver;
    this.scheduler = deps.scheduler;
    this.seedSource = deps.newSeed ?? newSeed;
    this.turnTimeoutMs = deps.turnTimeoutMs ?? 90_000;
    this.options = {
      endGameMode: settings?.endGameMode ?? "finishRound",
      allowTakeFewerThanThree: settings?.allowTakeFewerThanThree ?? false,
      turnCap: settings?.turnCap ?? 3000,
    };
    if (settings?.aiDifficulty) this.aiDifficulty = settings.aiDifficulty;
  }

  // ---------- views & helpers ----------
  roomView(): RoomView {
    return {
      code: this.code,
      phase: this.phase,
      hostSeat: this.hostSeat,
      seats: this.seats.map((o, i) => ({
        seat: i,
        name: o.name,
        kind: o.type,
        connected: o.type === "ai" ? true : o.connected,
        ...(o.type === "ai" ? { difficulty: o.difficulty } : {}),
      })),
      options: this.options,
      aiDifficulty: this.aiDifficulty,
      spectatorCount: this.spectators.size,
    };
  }

  currentGame(): GameState | null {
    return this.game;
  }

  isEmpty(): boolean {
    const anyHuman = this.seats.some((o) => o.type === "human" && o.connId !== null);
    const anySpec = [...this.spectators.values()].some((s) => s.connId !== null);
    return !anyHuman && !anySpec;
  }

  private seatOfToken(token: string): number {
    return this.seats.findIndex((o) => o.type === "human" && o.token === token);
  }
  private reject(connId: string | null, code: string, message: string, reqId?: string): void {
    if (connId) this.deliver(connId, { type: "REJECTED", reqId, code, message });
  }
  private broadcast(msg: ServerMessage): void {
    for (const o of this.seats) if (o.type === "human" && o.connId) this.deliver(o.connId, msg);
    for (const s of this.spectators.values()) if (s.connId) this.deliver(s.connId, msg);
  }
  private broadcastRoom(): void {
    this.broadcast({ type: "ROOM_UPDATE", room: this.roomView() });
  }
  private sendStateAll(seq: number): void {
    if (!this.game) return;
    for (let i = 0; i < this.seats.length; i++) {
      const o = this.seats[i];
      if (o.type === "human" && o.connId) this.deliver(o.connId, { type: "GAME_STATE", you: i, seq, view: redact(this.game, i) });
    }
    for (const s of this.spectators.values()) {
      if (s.connId) this.deliver(s.connId, { type: "GAME_STATE", you: "spectator", seq, view: redact(this.game, "spectator") });
    }
  }

  // ---------- lobby ----------
  addHuman(token: string, name: string, connId: string): number {
    if (this.seats.length >= MAX_SEATS) throw new Error("ROOM_FULL");
    const seat = this.seats.length;
    this.seats.push({ type: "human", token, name: name || `Player ${seat + 1}`, connId, connected: true, timeout: null });
    if (this.seats.length === 1) this.hostSeat = 0;
    this.deliver(connId, { type: "SESSION", sessionToken: token, seat });
    this.broadcastRoom();
    return seat;
  }

  addAi(byToken: string, difficulty?: Difficulty): void {
    const by = this.seatOfToken(byToken);
    if (by !== this.hostSeat) return this.rejectByToken(byToken, "NOT_HOST", "only the host can add AI");
    if (this.phase !== "lobby") return this.rejectByToken(byToken, "NOT_LOBBY", "cannot add AI after start");
    if (this.seats.length >= MAX_SEATS) return this.rejectByToken(byToken, "ROOM_FULL", "no free seat");
    const d = difficulty ?? this.aiDifficulty;
    const seat = this.seats.length;
    this.seats.push({ type: "ai", name: `AI ${seat + 1} (${d})`, difficulty: d });
    this.broadcastRoom();
  }

  removeSeat(byToken: string, index: number): void {
    const by = this.seatOfToken(byToken);
    if (by !== this.hostSeat) return this.rejectByToken(byToken, "NOT_HOST", "only the host can remove a seat");
    if (this.phase !== "lobby") return this.rejectByToken(byToken, "NOT_LOBBY", "cannot change seats after start");
    if (index === this.hostSeat) return this.rejectByToken(byToken, "BAD_SEAT", "host cannot remove their own seat");
    if (index < 0 || index >= this.seats.length) return this.rejectByToken(byToken, "BAD_SEAT", "no such seat");
    this.seats.splice(index, 1);
    if (index < this.hostSeat) this.hostSeat -= 1;
    this.broadcastRoom();
  }

  setOptions(byToken: string, opts: LobbySettings): void {
    const by = this.seatOfToken(byToken);
    if (by !== this.hostSeat) return this.rejectByToken(byToken, "NOT_HOST", "only the host can set options");
    if (this.phase !== "lobby") return this.rejectByToken(byToken, "NOT_LOBBY", "cannot change options after start");
    if (opts.endGameMode) this.options.endGameMode = opts.endGameMode;
    if (typeof opts.allowTakeFewerThanThree === "boolean") this.options.allowTakeFewerThanThree = opts.allowTakeFewerThanThree;
    if (typeof opts.turnCap === "number") this.options.turnCap = opts.turnCap;
    if (opts.aiDifficulty) this.aiDifficulty = opts.aiDifficulty;
    this.broadcastRoom();
  }

  start(byToken: string): void {
    const by = this.seatOfToken(byToken);
    if (by !== this.hostSeat) return this.rejectByToken(byToken, "NOT_HOST", "only the host can start");
    if (this.phase !== "lobby") return this.rejectByToken(byToken, "NOT_LOBBY", "already started");
    if (this.seats.length < 2 || this.seats.length > 4) return this.rejectByToken(byToken, "BAD_PLAYER_COUNT", "need 2-4 seats");
    const game = createGame(this.seats.length, this.seedSource(), this.options);
    for (let i = 0; i < this.seats.length; i++) {
      game.players[i].name = this.seats[i].name;
      game.players[i].kind = this.seats[i].type;
    }
    this.game = game;
    this.phase = "playing";
    this.seq = 0;
    this.processedReqIds.clear();
    this.broadcastRoom();
    this.sendStateAll(++this.seq); // initial snapshot
    this.advanceAutomation();
  }

  // ---------- play ----------
  applyClientMove(token: string, reqId: string, move: Move): void {
    const connId = this.connOf(token);
    if (this.phase !== "playing" || !this.game) return this.reject(connId, "NOT_PLAYING", "no game in progress", reqId);
    if (this.processedReqIds.has(reqId)) return this.sendStateAll(this.seq); // idempotent replay
    const seat = this.seatOfToken(token);
    if (seat < 0) return this.reject(connId, "NOT_A_PLAYER", "you are not seated in this game", reqId);
    const a = this.game.awaiting;
    if (a.inputType !== "MOVE" || a.seat !== seat) return this.reject(connId, "OUT_OF_TURN", "not your turn to move", reqId);
    if (!isLegalMove(this.game, move)) return this.reject(connId, "ILLEGAL_MOVE", "that move is not legal", reqId);
    this.processedReqIds.add(reqId);
    this.cancelTimeout(seat);
    const r = applyMove(this.game, move);
    this.game = r.state;
    this.emit(seat, { move }, this.summarize(seat, { move }));
    this.advanceAutomation();
  }

  applyClientResolution(token: string, reqId: string, resolution: Resolution): void {
    const connId = this.connOf(token);
    if (this.phase !== "playing" || !this.game) return this.reject(connId, "NOT_PLAYING", "no game in progress", reqId);
    if (this.processedReqIds.has(reqId)) return this.sendStateAll(this.seq);
    const seat = this.seatOfToken(token);
    if (seat < 0) return this.reject(connId, "NOT_A_PLAYER", "you are not seated in this game", reqId);
    const a = this.game.awaiting;
    const want = resolution.kind; // "DISCARD" | "PICK_NOBLE"
    if (a.seat !== seat || a.inputType !== want) return this.reject(connId, "OUT_OF_TURN", "not awaiting that input from you", reqId);
    let next;
    try {
      next = applyResolution(this.game, resolution);
    } catch (e) {
      return this.reject(connId, "ILLEGAL_RESOLUTION", (e as Error).message, reqId);
    }
    this.processedReqIds.add(reqId);
    this.cancelTimeout(seat);
    this.game = next.state;
    this.emit(seat, { resolution }, this.summarize(seat, { resolution }));
    this.advanceAutomation();
  }

  chat(token: string, text: string): void {
    const clean = (text ?? "").toString().slice(0, 500).trim();
    if (!clean) return;
    const seat = this.seatOfToken(token);
    if (seat >= 0) {
      this.broadcast({ type: "CHAT", seat, name: this.seats[seat].name, text: clean });
      return;
    }
    const spec = this.spectators.get(token);
    if (spec) this.broadcast({ type: "CHAT", seat: "spectator", name: spec.name, text: clean });
  }

  // ---------- connection lifecycle ----------
  addSpectator(token: string, name: string, connId: string): void {
    this.spectators.set(token, { name: name || "Spectator", connId });
    this.deliver(connId, { type: "SESSION", sessionToken: token, seat: "spectator" });
    if (this.game) this.deliver(connId, { type: "GAME_STATE", you: "spectator", seq: this.seq, view: redact(this.game, "spectator") });
    else this.deliver(connId, { type: "ROOM_UPDATE", room: this.roomView() });
    this.broadcastRoom();
  }

  reconnect(token: string, connId: string): boolean {
    const seat = this.seatOfToken(token);
    if (seat >= 0) {
      const o = this.seats[seat] as Extract<Occupant, { type: "human" }>;
      o.connId = connId;
      o.connected = true;
      this.cancelTimeout(seat);
      this.deliver(connId, { type: "SESSION", sessionToken: token, seat });
      if (this.game) this.deliver(connId, { type: "GAME_STATE", you: seat, seq: this.seq, view: redact(this.game, seat) });
      this.broadcast({ type: "PLAYER_CONNECTION", seat, connected: true });
      this.broadcastRoom();
      return true;
    }
    const spec = this.spectators.get(token);
    if (spec) {
      spec.connId = connId;
      this.deliver(connId, { type: "SESSION", sessionToken: token, seat: "spectator" });
      if (this.game) this.deliver(connId, { type: "GAME_STATE", you: "spectator", seq: this.seq, view: redact(this.game, "spectator") });
      return true;
    }
    return false;
  }

  leave(token: string): void {
    const seat = this.seatOfToken(token);
    if (seat >= 0) {
      if (this.phase === "lobby") {
        this.seats.splice(seat, 1);
        if (seat < this.hostSeat) this.hostSeat -= 1;
        else if (seat === this.hostSeat) this.migrateHost();
        this.broadcastRoom();
      } else {
        this.markDisconnected(seat);
      }
      return;
    }
    if (this.spectators.delete(token)) this.broadcastRoom();
  }

  onConnectionLost(connId: string): void {
    const seat = this.seats.findIndex((o) => o.type === "human" && o.connId === connId);
    if (seat >= 0) {
      this.markDisconnected(seat);
      return;
    }
    for (const [t, s] of this.spectators) {
      if (s.connId === connId) {
        this.spectators.delete(t);
        this.broadcastRoom();
        return;
      }
    }
  }

  private markDisconnected(seat: number): void {
    const o = this.seats[seat] as Extract<Occupant, { type: "human" }>;
    o.connId = null;
    o.connected = false;
    this.broadcast({ type: "PLAYER_CONNECTION", seat, connected: false });
    if (seat === this.hostSeat) this.migrateHost();
    this.broadcastRoom();
    if (this.phase === "playing" && this.game && !this.game.over && this.game.awaiting.seat === seat) {
      this.scheduleTimeout(seat);
    }
  }

  private migrateHost(): void {
    const candidate = this.seats.findIndex((o) => o.type === "human" && o.connected);
    if (candidate >= 0) this.hostSeat = candidate;
    // else: no connected human; leave hostSeat as-is until someone reconnects.
  }

  // ---------- timeouts ----------
  private scheduleTimeout(seat: number): void {
    const o = this.seats[seat];
    if (o.type !== "human") return;
    this.cancelTimeout(seat);
    o.timeout = this.scheduler.schedule(this.turnTimeoutMs, () => this.onTimeout(seat));
  }
  private cancelTimeout(seat: number): void {
    const o = this.seats[seat];
    if (o.type === "human" && o.timeout !== null) {
      this.scheduler.cancel(o.timeout);
      o.timeout = null;
    }
  }
  private onTimeout(seat: number): void {
    const o = this.seats[seat];
    if (o.type !== "human" || o.connected) return; // reconnected meanwhile
    if (!this.game || this.game.over || this.game.awaiting.seat !== seat) return;
    // Play one safe move/resolution on behalf of the disconnected human.
    this.autoStep(seat, new GreedyPolicy((this.game.seed ^ (seat * 2654435761)) >>> 0), "timed out");
    this.advanceAutomation();
  }

  // ---------- automation (AI seats + server-driven forced pass) ----------
  private policyFor(difficulty: Difficulty, seat: number): Policy {
    const seed = ((this.game!.seed ^ (seat * 2654435761) ^ (this.game!.turnCount * 40503)) >>> 0) || 1;
    return difficulty === "easy" ? new RandomPolicy(seed) : new GreedyPolicy(seed);
  }

  private advanceAutomation(): void {
    const g = () => this.game!;
    while (this.game && !this.game.over) {
      const a = g().awaiting;
      const seat = a.seat;
      const occ = this.seats[seat];
      if (a.inputType === "MOVE") {
        if (legalMoves(g()).length === 0) {
          // Server-driven forced pass (applies to humans and AI alike).
          const r = applyPass(g());
          this.game = r.state;
          this.emit(seat, { pass: true }, this.summarize(seat, { pass: true }));
          continue;
        }
        if (occ.type === "ai") {
          this.autoStep(seat, this.policyFor(occ.difficulty, seat), "ai");
          continue;
        }
        break; // human with legal moves -> wait for them
      } else {
        if (occ.type === "ai") {
          this.autoStep(seat, this.policyFor(occ.difficulty, seat), "ai");
          continue;
        }
        break; // human sub-decision -> wait
      }
    }
    if (this.game && this.game.over) this.emitGameOver();
    else this.emitAwaiting();
  }

  /** Apply exactly one automated action for `seat` using `policy`. */
  private autoStep(seat: number, policy: Policy, _why: string): void {
    const a = this.game!.awaiting;
    if (a.inputType === "MOVE") {
      const mv = policy.move(this.game!);
      if (mv === null) {
        const r = applyPass(this.game!);
        this.game = r.state;
        this.emit(seat, { pass: true }, this.summarize(seat, { pass: true }));
        return;
      }
      const r = applyMove(this.game!, mv);
      this.game = r.state;
      this.emit(seat, { move: mv }, this.summarize(seat, { move: mv }));
    } else if (a.inputType === "PICK_NOBLE") {
      const res = policy.pickNoble(this.game!);
      this.game = applyResolution(this.game!, res).state;
      this.emit(seat, { resolution: res }, this.summarize(seat, { resolution: res }));
    } else {
      const res = policy.discard(this.game!);
      this.game = applyResolution(this.game!, res).state;
      this.emit(seat, { resolution: res }, this.summarize(seat, { resolution: res }));
    }
  }

  // ---------- emit ----------
  private emit(by: number, what: { move?: Move; resolution?: Resolution; pass?: boolean }, summary: string): void {
    const seq = ++this.seq;
    const msg: ServerMessage = {
      type: "MOVE_APPLIED",
      seq,
      by,
      summary,
      ...(what.move ? { move: what.move } : {}),
      ...(what.resolution ? { resolution: what.resolution } : {}),
      ...(what.pass ? { resolution: "PASS" as const } : {}),
    };
    this.broadcast(msg);
    this.sendStateAll(seq);
  }

  private emitAwaiting(): void {
    if (!this.game || this.game.over) return;
    const a = this.game.awaiting;
    const seat = a.seat;
    const o = this.seats[seat];
    const disconnectedHuman = o.type === "human" && !o.connected;
    const deadlineTs = disconnectedHuman ? this.scheduler.now() + this.turnTimeoutMs : undefined;
    this.broadcast({
      type: "AWAITING_INPUT",
      seat,
      inputType: a.inputType,
      ...(a.nobleChoices ? { nobleChoices: a.nobleChoices } : {}),
      ...(a.discardCount !== undefined ? { discardCount: a.discardCount } : {}),
      ...(deadlineTs !== undefined ? { deadlineTs } : {}),
    });
    // If it's a disconnected human's turn, (re)arm the AI-takeover timer.
    if (disconnectedHuman) this.scheduleTimeout(seat);
  }

  private emitGameOver(): void {
    if (!this.game) return;
    const r = ranking(this.game);
    this.phase = "over";
    this.broadcast({ type: "GAME_OVER", ranking: r, winnerSeat: r[0].seat });
    this.broadcastRoom();
  }

  // ---------- misc ----------
  private connOf(token: string): string | null {
    const seat = this.seatOfToken(token);
    if (seat >= 0) {
      const o = this.seats[seat];
      return o.type === "human" ? o.connId : null;
    }
    return this.spectators.get(token)?.connId ?? null;
  }
  private rejectByToken(token: string, code: string, message: string): void {
    this.reject(this.connOf(token), code, message);
  }

  private summarize(seat: number, what: { move?: Move; resolution?: Resolution; pass?: boolean }): string {
    const who = this.seats[seat]?.name ?? `Seat ${seat}`;
    if (what.pass) return `${who} had no legal move and passed`;
    if (what.move) {
      switch (what.move.kind) {
        case "TAKE_THREE":
          return `${who} took ${what.move.colors.length} gem(s)`;
        case "TAKE_TWO":
          return `${who} took 2 ${what.move.color}`;
        case "RESERVE":
          return `${who} reserved a card`;
        case "BUY":
          return `${who} bought a card`;
      }
    }
    if (what.resolution) {
      return what.resolution.kind === "PICK_NOBLE" ? `${who} was visited by a noble` : `${who} discarded down to 10`;
    }
    return `${who} acted`;
  }
}
