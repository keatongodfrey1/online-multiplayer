/**
 * Space Chase room - drives the pure rules engine (shared/games/spacechase/
 * engine) and mirrors it into the synced schema.
 *
 * Authority model: `engine` is the server-only source of truth. Clients send
 * tiny intent messages (ROLL/DRAW + prompt answers); each is whitelist-built
 * into a clean engine action, checked to be that seat's turn, then applied.
 * The schema mirror (`syncFromEngine`) is rebuilt in place after every accepted
 * input; nothing reads back out of it.
 *
 * Seats: engine seats are 0..N-1 in `seatOrder` order (players sorted by
 * framework seat at game start). `frameworkSeatByEngineSeat` is snapshotted for
 * the final "win:<seat>" mapping because the winner may have left the players
 * map by game-over.
 *
 * No bots: a player who leaves for good mid-game is removed from the race (the
 * engine skips their seat); a present-but-idle player who runs out the turn
 * clock is auto-played by the engine's deterministic `autoResolve`. A 2-player
 * quit ends the game "abandoned" via the framework.
 *
 * The turn clock is room-managed (not TurnManager): Space Chase has extra turns
 * (same seat again) and multi-step card prompts, so the deadline is keyed off
 * the engine's `turnCount` - a fresh ACTION resets it, the prompts of that turn
 * share it - and frozen while the current player is disconnected.
 */
import type { Client } from "colyseus";
import type { Delayed } from "@colyseus/timer";
import {
  type BasePlayer,
  EndReason,
  isValidSpaceChaseTurnSeconds,
  Phase,
  SC_EVENT_LOG_MAX,
  ScAwait,
  SPACE_CHASE,
  SpaceChaseEngine,
  SpaceChaseEvent,
  SpaceChaseMsg,
  SpaceChasePlayer,
  SpaceChaseSeat,
  SpaceChaseState,
} from "@backbone/shared";
import { BaseGameRoom, type FrameworkSaveSeat } from "../../framework/BaseGameRoom.js";
import { grantPrivateView, revokePrivateView } from "../../framework/privateState.js";
import { parseSave, serializeSave, type ParsedSave, type SaveSeat } from "./save.js";

type GameState = SpaceChaseEngine.GameState;
type GameEvent = SpaceChaseEngine.GameEvent;
type Move = SpaceChaseEngine.Move;
type Resolution = SpaceChaseEngine.Resolution;

const { applyLeave, applyMove, applyResolution, autoResolve, createGame, isLegalMove } = SpaceChaseEngine;

export class SpaceChaseRoom extends BaseGameRoom<SpaceChaseState> {
  state = new SpaceChaseState();
  readonly minPlayers = 2;
  readonly maxPlayers = 5;
  protected override supportsSaves = true;

  // ---- server-only truth (never synced). Public = white-box test seam. ----
  public engine!: GameState;
  /** sessionIds in engine-seat order ("" for a vacated seat). */
  public seatOrder: string[] = [];
  /** Framework seat per engine seat, snapshotted at start (for win:<seat>). */
  public frameworkSeatByEngineSeat: number[] = [];

  private seedOption?: number;
  private turnTimer?: Delayed;
  /** Frozen countdown remainder while the current player is disconnected. */
  private pausedTurnRemainingMs?: number;
  /** turnCount the live deadline was armed for, so prompts of a turn share it. */
  private armedTurn = -1;
  /** Monotonic event seq for the whole room lifetime (clients never see it rewind). */
  private eventSeq = 0;
  /** The peek ArraySchema each session was granted, re-granted per game/reconnect. */
  private grantedPeek = new Map<string, object>();

  protected createPlayer(): SpaceChasePlayer {
    return new SpaceChasePlayer();
  }

  protected override onRoomCreate(options: unknown): void {
    const seed = (options as { seed?: unknown } | null)?.seed;
    if (typeof seed === "number" && Number.isFinite(seed)) this.seedOption = seed >>> 0;

    this.onMessage(SpaceChaseMsg.ROLL, (client) => this.handleAction(client, { kind: "ROLL" }));
    this.onMessage(SpaceChaseMsg.DRAW, (client) => this.handleAction(client, { kind: "DRAW" }));
    this.onMessage(SpaceChaseMsg.TARGET, (client, p) => this.handleResolution(client, this.parseTarget(p)));
    this.onMessage(SpaceChaseMsg.TARGETS, (client, p) => this.handleResolution(client, this.parseTargets(p)));
    this.onMessage(SpaceChaseMsg.CHOICE, (client, p) => this.handleResolution(client, this.parseChoice(p)));
    this.onMessage(SpaceChaseMsg.SPACE, (client, p) => this.handleResolution(client, this.parseSpace(p)));
    this.onMessage(SpaceChaseMsg.SATELLITE, (client, p) => this.handleResolution(client, this.parseSatellite(p)));
    this.onMessage(SpaceChaseMsg.CONFIG, (client, p) => this.handleConfig(client, p));
  }

  // ---- save/resume hooks (framework owns the messages + lineup gating) ----

  protected override isGameOver(): boolean {
    return !this.engine || this.engine.over;
  }
  protected override loadedSaveTurnLabel(parsed: unknown): number {
    return (parsed as ParsedSave).engine.turnCount;
  }
  protected override onSaveStaged(parsed: unknown): void {
    this.state.turnSeconds = (parsed as ParsedSave).turnSeconds;
  }
  protected override parseSave(raw: unknown): ParsedSave | null {
    return parseSave(raw);
  }
  protected override serializeSave(): object | null {
    if (!this.engine || this.engine.over) return null;
    const seats: SaveSeat[] = this.seatOrder.map((sessionId, i) => ({
      nickname: this.engine.players[i]!.name,
      isBot: false,
      gone: this.engine.players[i]!.gone,
    }));
    return serializeSave({ engine: this.engine, seats, turnSeconds: this.state.turnSeconds });
  }

  // ---- lifecycle ----

  protected onGameStart(): void {
    const players = [...this.state.players.values()].sort((a, b) => a.seat - b.seat);
    const load = this.pendingLoad?.payload as ParsedSave | undefined;
    this.pendingLoad = undefined; // consumed; a later rematch starts fresh
    this.state.loadedSave = "";

    if (load) {
      // canStartGame() guaranteed the saved humans are all present.
      this.engine = JSON.parse(JSON.stringify(load.engine)) as GameState;
      this.seatOrder = this.engine.players.map((seat) => {
        if (seat.gone) return "";
        const match = players.find((p) => p.nickname.toLowerCase() === seat.name.toLowerCase());
        return match?.sessionId ?? "";
      });
      this.frameworkSeatByEngineSeat = this.seatOrder.map(
        (sessionId) => players.find((p) => p.sessionId === sessionId)?.seat ?? -1
      );
    } else {
      const seed = this.seedOption ?? (Math.floor(Math.random() * 0xffffffff) >>> 0);
      this.engine = createGame(players.length, seed, players.map((p) => p.nickname));
      this.seatOrder = players.map((p) => p.sessionId);
      this.frameworkSeatByEngineSeat = players.map((p) => p.seat);
    }

    // Build the schema seats once; syncFromEngine updates them in place after.
    this.state.seats.clear();
    for (let i = 0; i < this.engine.players.length; i++) {
      const seat = new SpaceChaseSeat();
      seat.nickname = this.engine.players[i]!.name;
      this.state.seats.push(seat);
    }
    this.eventSeq = 0;
    this.state.events.clear();
    this.armedTurn = -1;
    this.pausedTurnRemainingMs = undefined;
    this.grantedPeek.clear();

    this.syncFromEngine();
    this.armClock();
  }

  // ---- input handling ----

  private handleAction(client: Client, move: Move): void {
    if (!this.canAct(client, ScAwait.ACTION)) return;
    if (!isLegalMove(this.engine, move)) return;
    const r = applyMove(this.engine, move);
    this.engine = r.state;
    this.commit(r.events);
  }

  private handleResolution(client: Client, res: Resolution | null): void {
    if (!res) return;
    const expected = RESOLUTION_INPUT[res.kind];
    if (!this.canAct(client, expected)) return;
    let r: { state: GameState; events: GameEvent[] };
    try {
      r = applyResolution(this.engine, res);
    } catch {
      return; // illegal answer (wrong target, bad permutation, ...): ignore
    }
    this.engine = r.state;
    this.commit(r.events);
  }

  /** Common guard: game running, this client owns the awaiting seat, right phase. */
  private canAct(client: Client, expectedInput: string): boolean {
    if (this.state.phase !== Phase.PLAYING || !this.engine || this.engine.over) return false;
    if (this.engine.awaiting.inputType !== expectedInput) return false;
    return this.seatOrder[this.engine.awaiting.seat] === client.sessionId;
  }

  private handleConfig(client: Client, payload: unknown): void {
    if (this.state.phase !== Phase.LOBBY) return;
    if (client.sessionId !== this.state.hostSessionId) return;
    const turnSeconds = (payload as { turnSeconds?: unknown } | null)?.turnSeconds;
    if (!isValidSpaceChaseTurnSeconds(turnSeconds)) return;
    this.state.turnSeconds = turnSeconds;
  }

  // ---- the single funnel after any accepted input / leaver / timeout ----

  private commit(events: GameEvent[]): void {
    this.appendEvents(events);
    this.syncFromEngine();
    if (this.engine.over) {
      this.endGame(this.mapEndReason());
      return;
    }
    this.armClock();
  }

  private appendEvents(events: GameEvent[]): void {
    for (const e of events) {
      const row = new SpaceChaseEvent();
      row.seq = ++this.eventSeq;
      row.kind = e.kind;
      row.seat = e.seat;
      row.a = e.a;
      row.b = e.b;
      row.text = e.text;
      this.state.events.push(row);
    }
    while (this.state.events.length > SC_EVENT_LOG_MAX) this.state.events.shift();
  }

  private mapEndReason(): string {
    const w = this.engine.winner;
    if (w !== null && w >= 0) {
      const frameworkSeat = this.frameworkSeatByEngineSeat[w];
      if (frameworkSeat !== undefined && frameworkSeat >= 0) return this.winBySeat(frameworkSeat);
    }
    return EndReason.DRAW; // defensive: a single winner is always chosen
  }

  // ---- schema mirror ----

  private syncFromEngine(): void {
    const e = this.engine;
    const aw = e.awaiting;
    this.engine.players.forEach((p, i) => {
      const seat = this.state.seats[i];
      if (!seat) return;
      seat.nickname = p.name;
      seat.gone = p.gone;
      seat.sessionId = p.gone ? "" : (this.seatOrder[i] ?? "");
      seat.position = p.position;
      seat.portalId = p.portalId;
      seat.portalProgress = p.portalProgress;
      seat.portalForward = p.portalForward;
      seat.justExitedPortal = p.justExitedPortal;
      seat.lostTurns = Math.min(p.lostTurns, 255);
      seat.extraTurns = Math.min(p.extraTurns, 255);
      seat.shieldExpiresRound = p.shieldExpiresRound;
      seat.spaceSuit = p.spaceSuit;
      seat.sixSevenCount = p.sixSevenCount;
      seat.lastActionType = p.lastActionType;
      seat.lastActionValue = Math.min(p.lastActionValue, 255);
      // Private Satellite peek: only the seat with the open SATELLITE prompt.
      const wantPeek = !e.over && aw.inputType === ScAwait.SATELLITE && aw.seat === i ? aw.peek : [];
      this.setPeek(i, seat, wantPeek);
    });

    this.state.roundNumber = e.roundNumber;
    this.state.deckCount = e.deck.length;
    this.state.discardCount = e.discard.length;
    this.state.lastCardId = e.discard.length > 0 ? e.discard[e.discard.length - 1]! : 0;

    this.state.currentSeat = aw.seat;
    this.state.currentTurn = e.over ? "" : (this.seatOrder[aw.seat] ?? "");
    this.state.awaitingType = e.over ? "" : aw.inputType;
    this.state.promptSeat = aw.seat;
    this.state.promptCardId = aw.cardId;
    this.state.promptContext = e.over ? "" : aw.context;
    this.state.promptMult = aw.mult;
    this.state.promptCount = aw.count;
    this.state.promptTargetSeat = aw.targetSeat;
  }

  /** Rewrite a seat's private peek and (re)grant it to the owner only. */
  private setPeek(i: number, seat: SpaceChaseSeat, ids: number[]): void {
    const same = seat.peek.length === ids.length && ids.every((v, k) => seat.peek[k] === v);
    if (!same) {
      seat.peek.clear();
      for (const id of ids) seat.peek.push(id);
    }
    const sessionId = this.seatOrder[i] ?? "";
    const client = sessionId ? this.clients.getById(sessionId) : undefined;
    if (ids.length > 0 && client) {
      if (this.grantedPeek.get(sessionId) !== seat.peek) {
        grantPrivateView(client, seat.peek);
        this.grantedPeek.set(sessionId, seat.peek);
      }
    } else if (ids.length === 0 && sessionId && this.grantedPeek.has(sessionId)) {
      if (client) revokePrivateView(client, seat.peek);
      this.grantedPeek.delete(sessionId);
    }
  }

  // ---- turn clock (room-managed) ----

  private armClock(): void {
    if (this.state.phase !== Phase.PLAYING || this.engine.over) return;
    if (this.state.turnSeconds === 0) {
      this.clearTimer();
      this.state.turnDeadline = 0;
      this.armedTurn = this.engine.turnCount;
      return;
    }
    if (this.engine.turnCount === this.armedTurn) return; // same turn (mid-prompt): keep running
    this.armedTurn = this.engine.turnCount;
    this.pausedTurnRemainingMs = undefined;
    this.startTimer(this.state.turnSeconds * 1000);
  }

  /** (Re)start the live deadline for `ms`, or freeze it if the current player is away. */
  private startTimer(ms: number): void {
    this.clearTimer();
    const sessionId = this.seatOrder[this.engine.awaiting.seat] ?? "";
    const connected = sessionId !== "" && this.state.players.get(sessionId)?.connected !== false;
    if (!connected) {
      this.pausedTurnRemainingMs = ms;
      this.state.turnDeadline = 0;
      return;
    }
    this.state.turnDeadline = Date.now() + ms;
    this.turnTimer = this.clock.setTimeout(() => this.onTurnTimeout(), ms);
  }

  private clearTimer(): void {
    this.turnTimer?.clear();
    this.turnTimer = undefined;
  }

  /** Freeze the clock while the current player is disconnected; resume on return. */
  private syncClock(): void {
    if (this.state.phase !== Phase.PLAYING || this.engine.over || this.state.turnSeconds === 0) return;
    const sessionId = this.seatOrder[this.engine.awaiting.seat] ?? "";
    const connected = sessionId !== "" && this.state.players.get(sessionId)?.connected !== false;
    if (!connected && this.state.turnDeadline > 0) {
      this.pausedTurnRemainingMs = Math.max(0, this.state.turnDeadline - Date.now());
      this.state.turnDeadline = 0;
      this.clearTimer();
    } else if (connected && this.state.turnDeadline === 0 && this.pausedTurnRemainingMs !== undefined) {
      this.startTimer(this.pausedTurnRemainingMs);
      this.pausedTurnRemainingMs = undefined;
    }
  }

  private onTurnTimeout(): void {
    if (this.state.phase !== Phase.PLAYING || this.engine.over) return;
    const seat = this.engine.awaiting.seat;
    const events: GameEvent[] = [];
    let guard = 0;
    // Auto-play the whole turn (action + any chained prompt steps) then move on.
    while (!this.engine.over && this.engine.awaiting.seat === seat && ++guard <= 50) {
      const r = autoResolve(this.engine, seat);
      this.engine = r.state;
      events.push(...r.events);
      if (r.events.length === 0) break; // nothing happened: avoid a stall
    }
    this.commit(events);
  }

  // ---- disconnection / leaving ----

  protected override onPlayerDropped(): void {
    this.syncClock();
  }

  protected override onPlayerReconnected(player: BasePlayer): void {
    this.syncClock();
    if (this.state.phase !== Phase.PLAYING) return;
    // Re-grant the private peek if this player is mid-Satellite and lost its view.
    const i = this.seatOrder.indexOf(player.sessionId);
    if (i >= 0) {
      const seat = this.state.seats[i];
      if (seat && seat.peek.length > 0) {
        const client = this.clients.getById(player.sessionId);
        if (client) {
          grantPrivateView(client, seat.peek);
          this.grantedPeek.set(player.sessionId, seat.peek);
        }
      }
    }
  }

  protected override onPlayerLeftForGood(player: BasePlayer): void {
    this.grantedPeek.delete(player.sessionId);
    if (this.state.phase !== Phase.PLAYING || !this.engine || this.engine.over) return;
    const i = this.seatOrder.indexOf(player.sessionId);
    if (i < 0) return;
    const r = applyLeave(this.engine, i);
    this.engine = r.state;
    this.commit(r.events);
  }

  protected override onGameEnded(): void {
    this.clearTimer();
    this.pausedTurnRemainingMs = undefined;
    this.state.turnDeadline = 0;
    this.state.currentTurn = "";
    this.state.awaitingType = "";
    // Seats + events stay in place for the game-over summary.
  }

  // ---- payload sanitizers (rebuild clean objects; never trust the client) ----

  private parseTarget(p: unknown): Resolution | null {
    const seat = (p as { seat?: unknown } | null)?.seat;
    return Number.isInteger(seat) ? { kind: "TARGET", seat: seat as number } : null;
  }
  private parseTargets(p: unknown): Resolution | null {
    const seats = (p as { seats?: unknown } | null)?.seats;
    if (!Array.isArray(seats) || seats.some((s) => !Number.isInteger(s))) return null;
    return { kind: "TARGETS", seats: seats as number[] };
  }
  private parseChoice(p: unknown): Resolution | null {
    const choice = (p as { choice?: unknown } | null)?.choice;
    return typeof choice === "string" ? { kind: "CHOICE", choice } : null;
  }
  private parseSpace(p: unknown): Resolution | null {
    const space = (p as { space?: unknown } | null)?.space;
    return Number.isInteger(space) ? { kind: "SPACE", space: space as number } : null;
  }
  private parseSatellite(p: unknown): Resolution | null {
    const order = (p as { order?: unknown } | null)?.order;
    if (!Array.isArray(order) || order.some((x) => !Number.isInteger(x))) return null;
    return { kind: "SATELLITE", order: order as number[] };
  }
}

const RESOLUTION_INPUT: Record<Resolution["kind"], string> = {
  TARGET: ScAwait.TARGET,
  TARGETS: ScAwait.MULTI_TARGET,
  CHOICE: ScAwait.CHOICE,
  SPACE: ScAwait.SPACE,
  SATELLITE: ScAwait.SATELLITE,
};
