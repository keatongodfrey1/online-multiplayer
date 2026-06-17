/**
 * The Perfect Palace room — drives the ported pure engine
 * (shared/games/perfectpalace/engine) and mirrors it into the synced schema.
 *
 * Authority model: `engine` is the server-only source of truth. Clients send
 * tagged action JSON on PerfectPalaceMsg.ACTION; everything is whitelist-
 * sanitized (sanitize.ts — id/targetId bound to the sender, dice dropped), gated
 * by an isLegalSender phase check, then validated by the engine (tryReduce)
 * before it is adopted. The schema mirror (syncFromEngine) is rewritten in place
 * after every accepted action. All randomness is server-owned: die values come
 * from the engine's seeded PRNG, never from a client.
 *
 * Seats: engine players are array indices 0..N-1 in `seatOrder` order (players
 * sorted by framework seat at game start; engine id `p${i+1}`).
 * `frameworkSeatByEngineSeat` is snapshotted for the final "win:<seat>" mapping
 * because the winner may have left the players map by the time the game ends.
 *
 * No bots and no autopilot in v1: a player who leaves for good has any pending
 * decision auto-resolved with a safe default, then is removed via the engine's
 * system/removePlayer (Bailiff returns to the middle, turn advances, the game
 * auto-ends at <=1 player). The framework ends a <minPlayers game "abandoned".
 */
import { type Client } from "colyseus";
import {
  type BasePlayer,
  EndReason,
  isValidPerfectPalaceTurnSeconds,
  PERFECT_PALACE,
  PERFECT_PALACE_COLORS,
  PerfectPalaceEngine,
  PerfectPalaceMsg,
  PerfectPalacePlayer,
  PerfectPalaceState,
  Phase,
  PPDuel,
  PPDuelStake,
  PPInventory,
  PPResourceSlot,
  PPSeat,
} from "@backbone/shared";
import { ArraySchema } from "@colyseus/schema";
import type { Delayed } from "@colyseus/timer";
import { BaseGameRoom, type FrameworkSaveSeat } from "../../framework/BaseGameRoom.js";
import { sanitizeAction } from "./sanitize.js";
import { parseSave, serializeSave, type ParsedSave, type SaveSeat } from "./save.js";

const { chooseAction, createLineupState, tryReduce, rollDieFrom, rankPlayers, totalPoints, staffWeight } =
  PerfectPalaceEngine;
type GameState = PerfectPalaceEngine.GameState;
type GameAction = PerfectPalaceEngine.GameAction;
type Difficulty = PerfectPalaceEngine.Difficulty;
type EngineInventory = PerfectPalaceEngine.PlayerInventory;

const LOG_CAP = 60;
/** Backstop for a pathological auto-advance loop (humans never approach this). */
const MAX_ACTIONS_PER_GAME = 100_000;

export class PerfectPalaceRoom extends BaseGameRoom<PerfectPalaceState> {
  state = new PerfectPalaceState();
  readonly minPlayers = 2;
  readonly maxPlayers = 6;
  override supportsSaves = true;
  override supportsBots = true;
  // Never lock the room: anyone with the code can join mid-game to reclaim a
  // seat whose player left for good. The 180s in-game grace is the framework default.
  override allowLateJoin = true;
  override supportsReclaim = true;

  /** Server-only engine truth (never synced). Public for white-box tests. */
  public engine!: GameState;
  /** sessionId per engine seat index ("" once a seat is vacated). */
  public seatOrder: string[] = [];
  /** Framework seat per engine seat, snapshotted at start (for win:<seat>). */
  public frameworkSeatByEngineSeat: number[] = [];
  /** sessionId -> engine id (`p1`..`pN`), rebuilt at game start. */
  private engineIdBySession = new Map<string, string>();
  private seedOption?: number;
  private actionsApplied = 0;
  /** Dice-animation feed: a monotonic counter + the last die the server rolled. */
  private rollSeq = 0;
  private lastDieValue = 0;
  private lastDieBy = "";
  /** Display colour index per engine seat (lobby picks honoured; see buildColorIndices). */
  private seatColorIndex: number[] = [];
  /** Difficulty per bot sessionId, chosen when the host seats it. */
  private botDifficulty = new Map<string, Difficulty>();
  /** Turn timer: the armed timeout, a paused-mid-turn remainder, and the seat
   *  currently being auto-finished because its human ran out of time (-1 = none). */
  private turnTimer?: Delayed;
  private pausedTurnRemainingMs?: number;
  private timedOutTurnSeat = -1;
  /** Engine seat the current deadline is armed for (so it isn't reset per action). */
  private timerArmedSeat = -1;
  /** Pace of an AI / vacated-seat decision (~a second reads as "it took a turn"). */
  public botDelayMs = 850;
  private autoTimer?: Delayed;

  protected createPlayer(): PerfectPalacePlayer {
    return new PerfectPalacePlayer();
  }

  protected override onRoomCreate(options: unknown): void {
    // Optional deterministic seed (tests/dev); reused on rematch.
    const seed = (options as { seed?: unknown } | null)?.seed;
    if (typeof seed === "number" && Number.isFinite(seed)) this.seedOption = seed >>> 0;
    this.onMessage(PerfectPalaceMsg.ACTION, (client, payload) => this.handleAction(client, payload));
    this.onMessage(PerfectPalaceMsg.PICK_COLOR, (client, payload) => this.handlePickColor(client, payload));
    this.onMessage(PerfectPalaceMsg.CONFIG, (client, payload) => this.handleConfig(client, payload));
  }

  /** Host sets the per-turn time limit in the lobby (0 = off). */
  private handleConfig(client: Client, payload: unknown): void {
    if (this.state.phase !== Phase.LOBBY) return;
    if (client.sessionId !== this.state.hostSessionId) return;
    const turnSeconds = (payload as { turnSeconds?: unknown } | null)?.turnSeconds;
    if (!isValidPerfectPalaceTurnSeconds(turnSeconds)) return;
    this.state.turnSeconds = turnSeconds;
  }

  /** Any player picks their palace colour in the lobby (-1 clears). Mirrors Catan. */
  private handlePickColor(client: Client, payload: unknown): void {
    if (this.state.phase !== Phase.LOBBY) return;
    const player = this.state.players.get(client.sessionId) as PerfectPalacePlayer | undefined;
    if (!player) return;
    const color = (payload as { color?: unknown } | null)?.color;
    if (color === -1) {
      player.colorChoice = -1;
      return;
    }
    if (typeof color !== "number" || !Number.isInteger(color) || color < 0 || color >= PERFECT_PALACE_COLORS.length) return;
    for (const p of this.state.players.values()) {
      if (p.sessionId !== client.sessionId && (p as PerfectPalacePlayer).colorChoice === color) return; // taken
    }
    player.colorChoice = color;
  }

  /** Final display colour index per ENGINE seat: honour each seat occupant's
   *  lobby pick, then fill the rest from the palette (unchosen humans + bots).
   *  Indexed via seatOrder so it's correct for both fresh and resumed games. */
  private buildColorIndices(): number[] {
    const n = this.engine.players.length;
    const out = new Array<number>(n).fill(-1);
    const used = new Set<number>();
    for (let i = 0; i < n; i++) {
      const sid = this.seatOrder[i];
      const p = sid ? (this.state.players.get(sid) as PerfectPalacePlayer | undefined) : undefined;
      const c = p?.colorChoice ?? -1;
      if (c >= 0 && c < PERFECT_PALACE_COLORS.length && !used.has(c)) {
        out[i] = c;
        used.add(c);
      }
    }
    let next = 0;
    for (let i = 0; i < n; i++) {
      if (out[i]! >= 0) continue;
      while (used.has(next)) next++;
      out[i] = next;
      used.add(next);
    }
    return out;
  }

  // ---- save/resume hooks (framework owns the orchestration) ----------------

  protected override isGameOver(): boolean {
    return !this.engine || this.engine.phase === "game-over";
  }

  protected override loadedSaveTurnLabel(parsed: unknown): number {
    return (parsed as ParsedSave).turnCount + 1;
  }

  protected override parseSave(raw: unknown): ParsedSave | null {
    return parseSave(raw);
  }

  protected override serializeSave(): object | null {
    return this.buildSave();
  }

  /** Current game -> save blob. Public for white-box tests. */
  public buildSave(): object {
    const seats: SaveSeat[] = this.seatOrder.map((sessionId, i) => {
      const isBot = sessionId ? this.state.players.get(sessionId)?.isBot === true : false;
      return {
        nickname: this.state.seats[i]?.nickname ?? `Seat ${i + 1}`,
        isBot,
        gone: !sessionId,
        ...(isBot ? { difficulty: this.botDifficulty.get(sessionId) ?? "normal" } : {}),
      };
    });
    // turnCount label = the furthest-along base turn (equal-turns accounting).
    const turnCount = this.engine.players.reduce((m, p) => Math.max(m, p.baseTurnsTaken), 0);
    return serializeSave({ engine: this.engine, seats, turnCount });
  }

  // ---- game start ----------------------------------------------------------

  protected onGameStart(): void {
    // Full re-init (also runs on rematch). A staged saved game is consumed here
    // and cleared, so a later rematch starts fresh.
    const players = [...this.state.players.values()].sort((a, b) => a.seat - b.seat);
    const load = this.pendingLoad?.payload as ParsedSave | undefined;
    this.pendingLoad = undefined;
    this.state.loadedSave = "";
    const seed = this.seedOption ?? Math.floor(Math.random() * 0xffffffff) >>> 0;

    if (load) {
      this.engine = load.engine;
      // Match saved seats to present players by nickname + role (humans rejoin;
      // bots are re-seated by the framework before start). A gone seat stays "".
      this.seatOrder = load.seats.map((s) => {
        if (s.gone) return "";
        const match = players.find(
          (p) => p.isBot === s.isBot && p.nickname.toLowerCase() === s.nickname.toLowerCase(),
        );
        return match?.sessionId ?? "";
      });
      this.engine.log = [`Game resumed (turn ${load.turnCount + 1}).`];
    } else {
      this.engine = createLineupState(
        players.map((p) => ({ name: p.nickname })),
        seed,
      );
      // createLineupState builds engine.players in seat order: players[i] <-> p${i+1},
      // parked in 'initial-roll' so everyone clicks "Roll for turn order" first.
      this.seatOrder = players.map((p) => p.sessionId);
    }
    this.frameworkSeatByEngineSeat = this.seatOrder.map((sid) =>
      sid ? players.find((p) => p.sessionId === sid)?.seat ?? -1 : -1,
    );
    this.engineIdBySession.clear();
    this.engine.players.forEach((ep, i) => {
      const sid = this.seatOrder[i];
      if (sid) this.engineIdBySession.set(sid, ep.id);
    });
    this.seatColorIndex = this.buildColorIndices();
    this.actionsApplied = 0;
    this.rollSeq = 0;
    this.lastDieValue = 0;
    this.lastDieBy = "";

    // Seats mirror engine players (rebuilt every game; the view never persists).
    this.state.seats.clear();
    this.engine.players.forEach((ep, i) => {
      const seat = new PPSeat();
      seat.engineId = ep.id;
      seat.sessionId = this.seatOrder[i] ?? "";
      seat.nickname = ep.name;
      seat.colorIndex = this.seatColorIndex[i] ?? i % PERFECT_PALACE_COLORS.length;
      this.state.seats.push(seat);
    });

    this.timedOutTurnSeat = -1;
    this.timerArmedSeat = -1;
    this.pausedTurnRemainingMs = undefined;
    this.syncFromEngine();
    this.armTurnTimer(); // start the per-turn clock if the host enabled one
    this.maybeScheduleAuto(); // bots (and any resumed-gone seats) start playing
  }

  // ---- message handling ----------------------------------------------------

  private handleAction(client: Client, payload: unknown): void {
    if (this.state.phase !== Phase.PLAYING || !this.engine || this.engine.phase === "game-over") return;
    const senderId = this.engineIdBySession.get(client.sessionId);
    if (!senderId) return;
    const action = sanitizeAction(payload, senderId);
    if (!action) return;
    if (!this.isLegalSender(action, senderId)) return;
    this.applyClientAction(action, senderId);
  }

  /**
   * Pin WHO may attempt each action, off the engine phase. The engine still
   * validates the move's legality; this stops a forged sender entirely.
   */
  private isLegalSender(action: GameAction, senderId: string): boolean {
    const e = this.engine;
    const tp = e.turn.phase;
    switch (action.type) {
      case "mapping/setInitial": {
        if (e.phase !== "initial-mapping") return false;
        return e.players.find((p) => p.id === senderId)?.mappingLocked !== true;
      }
      case "mapping/changeOneSlot":
        // Own card; the engine gates phase + lap credits + own-turn (mid-game).
        return true;
      case "initialRoll/roll":
        // Opening roll: only during initial-roll, only if this sender hasn't rolled.
        return e.phase === "initial-roll" && e.players.find((p) => p.id === senderId)?.initialRoll == null;
      case "turn/duelSetStake":
      case "turn/duelCancel":
        // The arriver (current player) sets the stake or calls off a no-contest duel.
        return tp === "duel" && senderId === e.currentPlayerId;
      case "turn/duelRollForPlayer":
        return tp === "duel" && !!e.duel?.contenders.includes(senderId) && e.duel.rolls[senderId] == null;
      default:
        // Everything else is the current player's action.
        return senderId === e.currentPlayerId;
    }
  }

  /** Client action: the server owns every die — for a turn or duel roll it
   *  generates the seeded value, records it for the animation, and dispatches. */
  private applyClientAction(action: GameAction, senderId: string): void {
    if (action.type === "turn/rollDie") return void this.rollAndDispatch("turn", senderId);
    if (action.type === "turn/duelRollForPlayer") return void this.rollAndDispatch("duel", senderId);
    if (action.type === "initialRoll/roll") return void this.rollAndDispatch("initial", senderId);
    this.dispatch(action);
  }

  /** Generate the seeded server die, record it (feeds the client dice animation
   *  via lastRollSeq/Value/By in syncFromEngine), thread the rng, and dispatch. */
  private rollAndDispatch(kind: "turn" | "duel" | "initial", byEngineId: string): boolean {
    const { value, rngState } = rollDieFrom(this.engine);
    this.engine = { ...this.engine, rngState };
    this.rollSeq++;
    this.lastDieValue = value;
    this.lastDieBy = byEngineId;
    if (kind === "duel") return this.dispatch({ type: "turn/duelRollForPlayer", id: byEngineId, value });
    if (kind === "initial") return this.dispatch({ type: "initialRoll/rollForPlayer", id: byEngineId, value });
    return this.dispatch({ type: "turn/rollDieWithValue", value });
  }

  /** Validate via the engine; adopt + funnel when accepted. */
  private dispatch(action: GameAction): boolean {
    const out = tryReduce(this.engine, action);
    if (!out.ok) return false;
    this.engine = out.state;
    this.actionsApplied++;
    this.afterApply();
    return true;
  }

  /** Single funnel after every accepted action and roster change. */
  private afterApply(): void {
    this.autoAdvance();
    this.syncFromEngine();
    if (this.engine.phase === "game-over") {
      this.finishGame();
      return;
    }
    this.armTurnTimer();
    this.maybeScheduleAuto();
  }

  // ---- AI / vacated-seat auto-play -----------------------------------------

  /** A seat played by the server: an AI bot, a human who left for good, or a
   *  human whose turn ran out (timedOutTurnSeat). A merely-disconnected human
   *  (within the 180s grace) is NOT auto-played — the table waits for them, then
   *  their seat vacates and a bot takes over. */
  private isAutoSeat(i: number): boolean {
    if (i === this.timedOutTurnSeat) return true;
    const sid = this.seatOrder[i];
    if (!sid) return true; // vacated (left for good)
    return this.state.players.get(sid)?.isBot === true;
  }

  /** Engine seats that must act now (mapping: every unlocked seat; duel: every
   *  contender yet to roll; otherwise the current player), filtered to auto seats. */
  private awaitingAutoSeats(): number[] {
    const e = this.engine;
    if (!e || e.phase === "game-over") return [];
    let seats: number[];
    if (e.phase === "initial-roll") {
      seats = e.players.map((_, i) => i).filter((i) => !e.players[i]!.removed && e.players[i]!.initialRoll == null);
    } else if (e.phase === "initial-mapping") {
      seats = e.players.map((_, i) => i).filter((i) => !e.players[i]!.removed && !e.players[i]!.mappingLocked);
    } else if (e.turn.phase === "duel" && e.duel) {
      const d = e.duel;
      seats = d.contenders.filter((id) => d.rolls[id] == null).map((id) => e.players.findIndex((p) => p.id === id));
    } else {
      const idx = e.players.findIndex((p) => p.id === e.currentPlayerId);
      seats = idx >= 0 ? [idx] : [];
    }
    return seats.filter((i) => i >= 0 && this.isAutoSeat(i));
  }

  /** If an auto seat is waiting, play ONE of its actions a beat from now. The
   *  decision runs afterApply(), which calls back here — so chained actions and
   *  back-to-back auto seats each get their own visible beat. */
  private maybeScheduleAuto(): void {
    this.autoTimer?.clear();
    this.autoTimer = undefined;
    if (this.state.phase !== Phase.PLAYING || !this.engine || this.engine.phase === "game-over") return;
    if (this.awaitingAutoSeats().length === 0) return;
    this.autoTimer = this.clock.setTimeout(() => {
      this.autoTimer = undefined;
      if (this.state.phase !== Phase.PLAYING || this.engine.phase === "game-over") return;
      const seat = this.awaitingAutoSeats()[0];
      if (seat === undefined) return;
      this.playAuto(seat);
    }, this.botDelayMs);
  }

  private playAuto(seatIdx: number): void {
    const engineId = this.engine.players[seatIdx]?.id;
    if (!engineId) return;
    // A seated bot plays at its chosen difficulty; a vacated seat or a timed-out
    // human turn is finished at "normal".
    const sid = this.seatOrder[seatIdx];
    const difficulty = (sid && this.botDifficulty.get(sid)) || "normal";
    const action = chooseAction(this.engine, engineId, difficulty);
    // Rolls go through the same server-owned die path as a human's (so the bot's
    // rolls animate too); everything else dispatches directly.
    const ok =
      action.type === "turn/rollDie"
        ? this.rollAndDispatch("turn", engineId)
        : action.type === "turn/duelRollForPlayer"
          ? this.rollAndDispatch("duel", engineId)
          : action.type === "initialRoll/roll"
            ? this.rollAndDispatch("initial", engineId)
            : this.dispatch(action);
    if (ok) return;
    // Safety net: the policy emitted something illegal (shouldn't happen) — end
    // the turn so the table never stalls; if even that is illegal, re-schedule.
    if (!this.dispatch({ type: "turn/endTurn" })) this.maybeScheduleAuto();
  }

  // ---- turn timer ----------------------------------------------------------

  /** Engine seat of the current player, or -1. */
  private currentSeatIndex(): number {
    return this.engine ? this.engine.players.findIndex((p) => p.id === this.engine.currentPlayerId) : -1;
  }

  /** Keep a FIXED per-turn deadline (not reset per action). Runs at the end of
   *  afterApply + onGameStart. Arms ONLY for a connected human's single-actor
   *  turn — bot/vacated/timed-out seats auto-play with no clock, and the
   *  simultaneous mapping/duel phases are not timed. A disconnected human is
   *  parked (paused) until they return. */
  private armTurnTimer(): void {
    const seat = this.currentSeatIndex();
    // A turn that advanced away from the timed-out seat is finished — clear it.
    if (seat !== this.timedOutTurnSeat) this.timedOutTurnSeat = -1;
    const off =
      this.state.phase !== Phase.PLAYING ||
      !this.engine ||
      this.engine.phase === "game-over" ||
      this.state.turnSeconds === 0 ||
      this.engine.phase === "initial-mapping" ||
      this.engine.turn.phase === "duel" ||
      seat < 0 ||
      this.isAutoSeat(seat);
    if (off) {
      this.clearTurnTimer();
      this.state.turnDeadline = 0;
      this.pausedTurnRemainingMs = undefined;
      this.timerArmedSeat = -1;
      return;
    }
    // Already running for THIS turn — leave the deadline alone (a fixed limit).
    if (seat === this.timerArmedSeat && (this.turnTimer || this.pausedTurnRemainingMs !== undefined)) return;
    this.timerArmedSeat = seat;
    this.startTurnTimer(this.state.turnSeconds * 1000);
  }

  private startTurnTimer(ms: number): void {
    this.clearTurnTimer();
    const sid = this.seatOrder[this.currentSeatIndex()] ?? "";
    const connected = sid !== "" && this.state.players.get(sid)?.connected !== false;
    if (!connected) {
      // Human is mid-grace disconnected — pause; resume on reconnect.
      this.pausedTurnRemainingMs = ms;
      this.state.turnDeadline = 0;
      return;
    }
    this.state.turnDeadline = Date.now() + ms;
    this.turnTimer = this.clock.setTimeout(() => this.onTurnTimeout(), ms);
  }

  private clearTurnTimer(): void {
    this.turnTimer?.clear();
    this.turnTimer = undefined;
  }

  /** Pause/resume the deadline as the player on the clock drops/returns. */
  private syncTurnClock(): void {
    if (this.state.phase !== Phase.PLAYING || !this.engine || this.engine.phase === "game-over") return;
    if (this.state.turnSeconds === 0) return;
    const sid = this.seatOrder[this.currentSeatIndex()] ?? "";
    const connected = sid !== "" && this.state.players.get(sid)?.connected !== false;
    if (!connected && this.state.turnDeadline > 0) {
      this.pausedTurnRemainingMs = Math.max(0, this.state.turnDeadline - Date.now());
      this.state.turnDeadline = 0;
      this.clearTurnTimer();
    } else if (connected && this.state.turnDeadline === 0 && this.pausedTurnRemainingMs !== undefined) {
      const ms = this.pausedTurnRemainingMs;
      this.pausedTurnRemainingMs = undefined;
      this.startTurnTimer(ms);
    }
  }

  /** The current human's turn ran out: hand it to the AI (Normal), which finishes
   *  it one beat at a time via the existing auto-play. */
  private onTurnTimeout(): void {
    this.turnTimer = undefined;
    if (this.state.phase !== Phase.PLAYING || !this.engine || this.engine.phase === "game-over") return;
    if (this.engine.phase === "initial-mapping" || this.engine.turn.phase === "duel") return;
    const seat = this.currentSeatIndex();
    if (seat < 0 || this.isAutoSeat(seat)) return; // already auto / not a human turn
    this.timedOutTurnSeat = seat;
    this.engine = { ...this.engine, log: [...this.engine.log, `${this.engine.players[seat]!.name}'s turn ran out — the AI is finishing it.`] };
    this.state.turnDeadline = 0;
    this.syncFromEngine();
    this.maybeScheduleAuto();
  }

  /**
   * Drive the two server-side transitions the hotseat UI used buttons for:
   *  - reveal all resource cards once every active player has locked their pick;
   *  - resolve a duel once every contender has rolled (tie re-rounds clear the
   *    rolls, so the loop re-checks and stops to wait for the re-rolls).
   * Loops because one transition can enable the next; never recurses afterApply.
   */
  private autoAdvance(): void {
    let guard = 0;
    while (++guard <= 1000) {
      const e = this.engine;
      if (e.phase === "game-over") return;
      if (e.phase === "initial-roll") {
        const active = e.players.filter((p) => !p.removed);
        if (active.length > 0 && active.every((p) => p.initialRoll != null)) {
          // All rolled: finalize order, or — on a top tie — clear the tied rolls so
          // just those players re-roll (finalize no-ops on a tie, so it's rejected).
          const fin = tryReduce(e, { type: "initialRoll/finalize" });
          if (fin.ok) {
            this.engine = fin.state;
            this.actionsApplied++;
            continue;
          }
          const clr = tryReduce(e, { type: "initialRoll/clearTopTie" });
          if (clr.ok) {
            this.engine = clr.state;
            this.actionsApplied++;
            continue;
          }
        }
        return;
      }
      if (e.phase === "initial-mapping") {
        const active = e.players.filter((p) => !p.removed);
        if (active.length > 0 && active.every((p) => p.mappingLocked)) {
          const out = tryReduce(e, { type: "mapping/revealAll" });
          if (out.ok) {
            this.engine = out.state;
            this.actionsApplied++;
            continue;
          }
        }
        return;
      }
      if (e.turn.phase === "duel" && e.duel) {
        const d = e.duel;
        if (d.contenders.length > 0 && d.contenders.every((id) => d.rolls[id] != null)) {
          const out = tryReduce(e, { type: "turn/duelResolve" });
          if (out.ok) {
            this.engine = out.state;
            this.actionsApplied++;
            continue;
          }
        }
        return;
      }
      return;
    }
  }

  private finishGame(): void {
    const winnerId = this.computeWinnerId();
    this.state.winnerId = winnerId;
    const engineSeat = this.engine.players.findIndex((p) => p.id === winnerId);
    const fwSeat = engineSeat >= 0 ? this.frameworkSeatByEngineSeat[engineSeat] : undefined;
    this.endGame(fwSeat !== undefined && fwSeat >= 0 ? this.winBySeat(fwSeat) : EndReason.DRAW);
  }

  /** Winner = top of the staff-weighted tiebreaker (points -> staff -> cash). */
  private computeWinnerId(): string {
    const entries = this.engine.players
      .filter((p) => !p.removed)
      .map((p) => ({
        id: p.id,
        name: p.name,
        points: totalPoints(p.inventory),
        staff: staffWeight(p.inventory),
        cash: p.inventory.dollars,
      }));
    if (!entries.length) return "";
    return rankPlayers(entries)[0]?.id ?? "";
  }

  // ---- engine -> schema mirror (in place) ----------------------------------

  private syncFromEngine(): void {
    const e = this.engine;
    const s = this.state;
    const over = e.phase === "game-over";
    // The initial pick is hidden: cards are only published once revealed.
    const cardsRevealed = e.phase !== "initial-mapping" && e.phase !== "initial-roll" && e.phase !== "setup";

    e.players.forEach((ep, i) => {
      const seat = s.seats[i];
      if (!seat) return;
      const sid = this.seatOrder[i] ?? "";
      set(seat, "sessionId", sid);
      set(seat, "nickname", ep.name);
      set(seat, "colorIndex", this.seatColorIndex[i] ?? i % PERFECT_PALACE_COLORS.length);
      set(seat, "position", ep.position);
      writeInventory(seat.inventory, ep.inventory);
      set(seat, "inDungeon", ep.dungeon.inDungeon);
      set(seat, "dungeonTurnsServed", ep.dungeon.turnsServed);
      set(seat, "mappingLocked", ep.mappingLocked === true);
      set(seat, "baseTurnsTaken", ep.baseTurnsTaken);
      set(seat, "removed", ep.removed);
      set(seat, "gone", !sid || ep.removed);
      set(seat, "mappingChangesAvailable", ep.mappingChangesAvailable);
      set(seat, "workerPreference", ep.workerPreference);
      set(seat, "initialRoll", ep.initialRoll ?? 0);
      if (cardsRevealed) writeResourceCard(seat.resourceCard, ep.resourceCard);
      else if (seat.resourceCard.length) seat.resourceCard.clear();
    });

    set(s, "enginePhase", e.phase);
    set(s, "turnPhase", e.turn.phase);
    set(s, "currentPlayerId", e.currentPlayerId ?? "");
    rewriteStrings(s.turnOrder, e.turnOrder);
    set(s, "activePlayerIndex", e.turn.activePlayerIndex);
    set(s, "lastRoll", e.turn.lastRoll ?? 0);
    set(s, "extraTurnsQueued", e.turn.extraTurnsQueued);
    set(s, "bailiffStealUsed", e.turn.bailiffStealUsedThisTurnSequence);
    set(s, "acquiredBailiffThisTurn", e.turn.acquiredBailiffThisTurn);
    set(s, "enteredDungeonThisTurn", e.turn.enteredDungeonThisTurn);
    set(s, "skipOptionalActions", e.turn.skipOptionalActions);
    set(s, "traderUsedThisTurn", e.turn.traderUsedThisTurn);

    const fine = e.turn.pendingFine;
    set(s, "finePending", !!fine);
    set(s, "fineAmount", fine?.amount ?? 0);
    set(s, "fineSource", fine?.source ?? "");

    const d = e.duel;
    set(s, "duelActive", !!d && e.turn.phase === "duel");
    if (d) {
      set(s.duel, "squareNumber", d.squareNumber);
      rewriteStrings(s.duel.participants, d.participants);
      rewriteStrings(s.duel.contenders, d.contenders);
      writeStake(s.duel.stake, d.stake);
      const rollIds = Object.keys(d.rolls);
      rewriteStrings(s.duel.rollPlayers, rollIds);
      // Redact roll VALUES while the duel is live — the client only shows who has
      // rolled ("✓"). The room auto-resolves the instant the last contender rolls,
      // so the numbers are revealed together in the resolution log, never streamed.
      rewriteNumbers(s.duel.rollValues, rollIds.map(() => 0));
      set(s.duel, "winner", d.winner ?? "");
    } else {
      clearDuel(s.duel);
    }

    set(s, "bailiffKind", e.bailiff.kind);
    set(s, "bailiffBy", e.bailiff.kind === "held" ? e.bailiff.by : "");
    set(s, "deckCount", e.deck.length);
    set(s, "discardCount", e.discard.length);

    set(s, "lastRollSeq", this.rollSeq);
    set(s, "lastRollValue", this.lastDieValue);
    set(s, "lastRollBy", this.lastDieBy);

    set(s, "winnerId", over ? this.computeWinnerId() : "");
    set(s, "palaceBuiltBy", e.palaceBuiltBy ?? "");
    set(s, "palaceTriggerTurnIndex", e.palaceTriggerTurnIndex ?? -1);

    rewriteStrings(s.log, e.log.slice(-LOG_CAP));
    set(s, "currentTurn", this.singleActorSession());
  }

  /** sessionId of the sole actor, or "" during multi-actor phases / game over. */
  private singleActorSession(): string {
    const e = this.engine;
    if (e.phase === "game-over" || e.phase === "initial-mapping" || e.turn.phase === "duel") return "";
    const idx = e.players.findIndex((p) => p.id === e.currentPlayerId);
    return idx >= 0 ? this.seatOrder[idx] ?? "" : "";
  }

  // ---- departures & mid-game seat reclaim ----------------------------------

  protected override onPlayerLeftForGood(player: BasePlayer): void {
    this.engineIdBySession.delete(player.sessionId);
    const idx = this.seatOrder.indexOf(player.sessionId);
    if (idx >= 0) this.seatOrder[idx] = ""; // vacate — do NOT remove from the engine

    if (this.state.phase !== Phase.PLAYING || !this.engine || this.engine.phase === "game-over") return;
    // The seat is now an auto seat: the bot policy plays it (resolving anything
    // the leaver owed — a duel roll, a pending decision) until someone reclaims it.
    // Two ways the game still ends: the framework ends "abandoned" when the
    // roster (humans + bots) drops below minPlayers, and the guard below ends it
    // when no humans remain at all (a bots-only table shouldn't run forever).
    if (this.humanCount() === 0) {
      this.endGame(EndReason.ABANDONED);
      return;
    }
    this.afterApply(); // re-project the vacated seat and (re)schedule auto-play
  }

  private humanCount(): number {
    let n = 0;
    for (const p of this.state.players.values()) if (!p.isBot) n++;
    return n;
  }

  /** First vacated (left-for-good) seat a newcomer can take over. */
  protected override findReclaimableSeat(): number {
    return this.seatOrder.findIndex((sid, i) => !sid && !!this.engine?.players[i]);
  }

  /** Bind a mid-game joiner to a vacated seat (its position/inventory intact). */
  protected override reclaimSeat(i: number, player: BasePlayer): void {
    const seat = this.state.seats[i];
    if (!seat || !this.engine?.players[i]) return;
    const oldNickname = seat.nickname;
    this.seatOrder[i] = player.sessionId;
    this.frameworkSeatByEngineSeat[i] = player.seat; // else a win maps to the departed seat
    this.engineIdBySession.set(player.sessionId, this.engine.players[i]!.id);
    seat.sessionId = player.sessionId;
    seat.nickname = player.nickname;
    seat.gone = false;
    this.engine = {
      ...this.engine,
      players: this.engine.players.map((p, idx) => (idx === i ? { ...p, name: player.nickname } : p)),
      log: [...this.engine.log, `${player.nickname} takes over ${oldNickname}'s seat.`],
    };
    this.afterApply(); // stop auto-playing the now-claimed seat; re-project
  }

  // ---- bots (framework owns roster entry / removal) ------------------------

  /** Read + clamp a difficulty from an ADD_BOT payload (default "normal"). */
  private parseDifficulty(options: unknown): Difficulty {
    const d = (options as { difficulty?: unknown } | null)?.difficulty;
    return d === "easy" || d === "hard" ? d : "normal";
  }

  protected override onBotAdded(bot: BasePlayer, options: unknown): void {
    const difficulty = this.parseDifficulty(options);
    this.botDifficulty.set(bot.sessionId, difficulty);
    bot.nickname = `${bot.nickname} (${difficulty})`; // e.g. "Botty (hard)"
  }

  protected override onLoadedBotSeated(bot: BasePlayer, savedSeat: FrameworkSaveSeat): void {
    const saved = (this.pendingLoad?.payload as ParsedSave | undefined)?.seats.find(
      (s) => s.isBot && s.nickname.toLowerCase() === savedSeat.nickname.toLowerCase(),
    );
    this.botDifficulty.set(bot.sessionId, saved?.difficulty ?? "normal");
  }

  protected override onBotRemoved(sessionId: string): void {
    this.botDifficulty.delete(sessionId);
  }

  /** Pause/resume the turn clock as the player on it drops/returns. */
  protected override onPlayerDropped(): void {
    this.syncTurnClock();
  }
  protected override onPlayerReconnected(): void {
    this.syncTurnClock();
  }

  protected override onGameEnded(): void {
    this.autoTimer?.clear();
    this.autoTimer = undefined;
    this.clearTurnTimer();
    this.pausedTurnRemainingMs = undefined;
    this.timedOutTurnSeat = -1;
    this.timerArmedSeat = -1;
    this.state.turnDeadline = 0;
    this.state.currentTurn = "";
    this.state.duelActive = false;
  }
}

// ---- small pure helpers ----------------------------------------------------

/** Assign only when changed (minimises schema patches / network churn). */
function set<T, K extends keyof T>(obj: T, key: K, value: T[K]): void {
  if (obj[key] !== value) obj[key] = value;
}

function writeInventory(dst: PPInventory, src: EngineInventory): void {
  set(dst, "bricks", src.bricks);
  set(dst, "sticks", src.sticks);
  set(dst, "dollars", src.dollars);
  set(dst, "walls", src.walls);
  set(dst, "roofs", src.roofs);
  set(dst, "rooms", src.rooms);
  set(dst, "buildings", src.buildings);
  set(dst, "threeStoryBuildings", src.threeStoryBuildings);
  set(dst, "palaces", src.palaces);
  set(dst, "workers", src.workers);
  set(dst, "servers", src.servers);
  set(dst, "chefs", src.chefs);
  set(dst, "cleaners", src.cleaners);
  set(dst, "wholeHouseCleaners", src.wholeHouseCleaners);
  set(dst, "queen", src.queen);
  set(dst, "knight", src.knight);
  set(dst, "allied", src.allied);
  set(dst, "pardonCards", src.pardonCards);
}

function writeStake(dst: PPDuelStake, src: PerfectPalaceEngine.DuelStake): void {
  set(dst, "dollars", src.dollars);
  set(dst, "bricks", src.bricks);
  set(dst, "sticks", src.sticks);
  set(dst, "walls", src.walls);
  set(dst, "roofs", src.roofs);
  set(dst, "rooms", src.rooms);
}

function writeResourceCard(dst: ArraySchema<PPResourceSlot>, src: PerfectPalaceEngine.ResourceCard): void {
  // Order-stable, length 6; only rebuild when the contents actually differ.
  const same =
    dst.length === src.length &&
    src.every((o, i) => {
      const d = dst[i];
      const amount = o.kind === "draw-card" ? 0 : o.amount;
      return d?.kind === o.kind && d.amount === amount;
    });
  if (same) return;
  dst.clear();
  for (const o of src) {
    const slot = new PPResourceSlot();
    slot.kind = o.kind;
    slot.amount = o.kind === "draw-card" ? 0 : o.amount;
    dst.push(slot);
  }
}

function clearDuel(d: PPDuel): void {
  if (d.squareNumber !== 0) d.squareNumber = 0;
  if (d.participants.length) d.participants.clear();
  if (d.contenders.length) d.contenders.clear();
  if (d.rollPlayers.length) d.rollPlayers.clear();
  if (d.rollValues.length) d.rollValues.clear();
  if (d.winner !== "") d.winner = "";
  writeStake(d.stake, { dollars: 0, bricks: 0, sticks: 0, walls: 0, roofs: 0, rooms: 0 });
}

function rewriteStrings(dst: ArraySchema<string>, src: readonly string[]): void {
  if (dst.length === src.length && src.every((v, i) => dst[i] === v)) return;
  dst.clear();
  for (const v of src) dst.push(v);
}

function rewriteNumbers(dst: ArraySchema<number>, src: readonly number[]): void {
  if (dst.length === src.length && src.every((v, i) => dst[i] === v)) return;
  dst.clear();
  for (const v of src) dst.push(v);
}

export { PERFECT_PALACE };
