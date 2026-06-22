/**
 * Splendor room - drives the ported pure engine (shared/games/splendor/engine)
 * and mirrors it into the synced schema.
 *
 * Authority model: `engine` is the server-only source of truth. Clients send
 * raw Move/Resolution JSON; everything is whitelist-sanitized and validated
 * before it touches the engine. The schema mirror (`syncFromEngine`) is
 * rebuilt in place after every accepted input.
 *
 * Seats: engine seats are 0..N-1 in `seatOrder` order (players sorted by
 * framework seat at game start). `frameworkSeatByEngineSeat` is snapshotted
 * for the final "win:<seat>" mapping because the winner may have left the
 * players map by the time the game ends.
 *
 * Players who leave for good mid-game (3-4p) are played out by a seeded
 * RandomPolicy ghost; 2p games end "abandoned" via the framework instead.
 */
import type { Client } from "colyseus";
import type { Delayed } from "@colyseus/timer";
import { ArraySchema } from "@colyseus/schema";
import {
  type BasePlayer,
  ColorCounts,
  EndReason,
  isValidSplendorTurnSeconds,
  Phase,
  SPLENDOR,
  SplendorCard,
  SplendorEngine,
  SplendorMsg,
  SplendorNoble,
  SplendorPlayer,
  SplendorSeat,
  SplendorState,
} from "@backbone/shared";
import { BaseGameRoom, type FrameworkSaveSeat } from "../../framework/BaseGameRoom.js";
import { TurnManager } from "../../framework/TurnManager.js";
import { grantPrivateView, revokePrivateView } from "../../framework/privateState.js";
import { parseSave, serializeSave, type ParsedSave, type SaveSeat } from "./save.js";

const {
  COLORS,
  applyMove,
  applyPass,
  applyResolution,
  createGame,
  GreedyPolicy,
  isLegalMove,
  legalMoves,
  playerPoints,
  ranking,
  RandomPolicy,
} = SplendorEngine;
type Policy = SplendorEngine.Policy;
type GameState = SplendorEngine.GameState;
type EngineCard = SplendorEngine.Card;
type EngineNoble = SplendorEngine.Noble;
type Move = SplendorEngine.Move;
type Resolution = SplendorEngine.Resolution;
type Color = SplendorEngine.Color;
type Tier = SplendorEngine.Tier;

export class SplendorRoom extends BaseGameRoom<SplendorState> {
  state = new SplendorState();
  readonly minPlayers = 2;
  readonly maxPlayers = 4;
  override supportsBots = true;
  override supportsSaves = true;
  // Never lock the room - a newcomer with the code can take over a seat that
  // has fallen to autopilot (see the reclaim hooks).
  override allowLateJoin = true;
  override supportsReclaim = true;

  /** Server-only engine truth (never synced). Public for white-box tests. */
  public engine!: GameState;
  /** sessionIds in engine-seat order (index = engine seat), snapshotted at game start. */
  public seatOrder: string[] = [];
  /** Framework seat per engine seat, snapshotted at start (for win:<seat>). */
  public frameworkSeatByEngineSeat: number[] = [];

  /** Plays vacated seats (and their pending sub-decisions). Reseeded per game. */
  private ghost = new RandomPolicy(1);
  /** Brains for seated AI players, by bot sessionId. Rebuilt per game. Public for tests. */
  public botBrains = new Map<string, Policy>();
  /** Difficulty per bot sessionId, chosen when the host seats it. */
  private botDifficulty = new Map<string, "easy" | "hard">();
  /**
   * Pace of bot decisions. Instant bot turns would make the board mutate
   * with no visible cause; ~a second reads as "the bot took its turn".
   * Public so tests can shrink it.
   */
  public botDelayMs = 900;
  private botTimer?: Delayed;
  private seedOption?: number;
  /** The reserved-cards ArraySchema each session was granted (re-granted per game). */
  private grantedReserved = new Map<string, ArraySchema<SplendorCard>>();

  /**
   * Built fresh each onGameStart so the lobby-chosen turn limit applies
   * (TurnManager options are fixed at construction). Absent until the first
   * game starts.
   */
  private turns?: TurnManager;
  /** Frozen countdown remainder while the current player is disconnected. */
  private pausedTurnRemainingMs?: number;

  protected createPlayer(): SplendorPlayer {
    return new SplendorPlayer();
  }

  protected override onRoomCreate(options: unknown): void {
    // Optional deterministic shuffle seed (tests/dev). A set seed is reused
    // on rematch, so only ever pass one when reproducibility is the point.
    const seed = (options as { seed?: unknown } | null)?.seed;
    if (typeof seed === "number" && Number.isFinite(seed)) this.seedOption = seed >>> 0;
    this.onMessage(SplendorMsg.MOVE, (client, payload) => this.handleMove(client, payload));
    this.onMessage(SplendorMsg.RESOLVE, (client, payload) => this.handleResolve(client, payload));
    this.onMessage(SplendorMsg.CONFIG, (client, payload) => this.handleConfig(client, payload));
    this.onMessage(SplendorMsg.PAUSE, (client, payload) => this.handlePause(client, payload));
  }

  // ---- save/resume hooks (framework owns the orchestration) --------------

  protected override isGameOver(): boolean {
    return !this.engine || this.engine.over;
  }

  protected override loadedSaveTurnLabel(parsed: unknown): number {
    return (parsed as ParsedSave).engine.turnCount + 1;
  }

  /** Restore the saved turn timer. */
  protected override onSaveStaged(parsed: unknown): void {
    this.state.turnSeconds = (parsed as ParsedSave).turnSeconds;
  }

  /** Restore a re-seated bot's difficulty (and its name suffix). */
  protected override onLoadedBotSeated(bot: BasePlayer, savedSeat: FrameworkSaveSeat): void {
    const saved = (this.pendingLoad?.payload as ParsedSave | undefined)?.seats.find(
      (s) => s.isBot && s.nickname.toLowerCase() === savedSeat.nickname.toLowerCase()
    );
    this.botDifficulty.set(bot.sessionId, saved?.difficulty ?? "hard");
  }

  protected override onBotRemoved(sessionId: string): void {
    this.botDifficulty.delete(sessionId);
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
      const player = sessionId ? this.state.players.get(sessionId) : undefined;
      return {
        nickname: this.state.seats[i]?.nickname ?? `Seat ${i + 1}`,
        isBot: player?.isBot === true,
        gone: !player,
        ...(player?.isBot ? { difficulty: this.botDifficulty.get(sessionId) ?? "hard" } : {}),
      };
    });
    return serializeSave({ engine: this.engine, seats, turnSeconds: this.state.turnSeconds });
  }

  /** Host adjusts the turn timer while in the lobby. */
  private handleConfig(client: Client, payload: unknown): void {
    if (this.state.phase !== Phase.LOBBY) return;
    if (client.sessionId !== this.state.hostSessionId) return;
    const turnSeconds = (payload as { turnSeconds?: unknown } | null)?.turnSeconds;
    if (!isValidSplendorTurnSeconds(turnSeconds)) return;
    this.state.turnSeconds = turnSeconds;
  }

  /** Read the host's difficulty pick for a freshly seated bot. */
  protected override onBotAdded(bot: BasePlayer, options: unknown): void {
    const difficulty = (options as { difficulty?: unknown } | null)?.difficulty;
    const easy = difficulty === "easy";
    this.botDifficulty.set(bot.sessionId, easy ? "easy" : "hard");
    bot.nickname = `${bot.nickname} (${easy ? "easy" : "hard"})`;
  }

  /**
   * Any player pauses/resumes a timed game (family-table etiquette: whoever
   * needs to step away hits pause; whoever is back first hits resume).
   * Untimed games have nothing to pause - the game already waits forever.
   */
  private handlePause(client: Client, payload: unknown): void {
    if (this.state.phase !== Phase.PLAYING || this.state.turnSeconds === 0) return;
    const player = this.state.players.get(client.sessionId);
    if (!player) return;
    const paused = (payload as { paused?: unknown } | null)?.paused;
    if (typeof paused !== "boolean" || paused === this.state.paused) return;
    this.state.paused = paused;
    this.state.pausedBy = paused ? player.nickname : "";
    this.syncClock();
    this.maybeScheduleBot(); // cancels a pending bot move on pause, re-arms on resume
  }

  protected onGameStart(): void {
    // Full re-init - this also runs on rematch.
    const players = [...this.state.players.values()].sort((a, b) => a.seat - b.seat);
    const load = this.pendingLoad?.payload as ParsedSave | undefined;
    this.pendingLoad = undefined; // consumed; a rematch later starts fresh
    this.state.loadedSave = "";

    const seed = this.seedOption ?? Math.floor(Math.random() * 0xffffffff) >>> 0;
    if (load) {
      // canStartGame() guaranteed the lineup matches the save.
      this.engine = load.engine;
      this.seatOrder = load.seats.map((s) => {
        if (s.gone) return ""; // stays ghost-played, like when they left
        const match = players.find(
          (p) => p.isBot === s.isBot && p.nickname.toLowerCase() === s.nickname.toLowerCase()
        );
        return match?.sessionId ?? "";
      });
      this.frameworkSeatByEngineSeat = this.seatOrder.map(
        (sessionId) => players.find((p) => p.sessionId === sessionId)?.seat ?? -1
      );
    } else {
      this.engine = createGame(players.length, seed);
      this.seatOrder = players.map((p) => p.sessionId);
      this.frameworkSeatByEngineSeat = players.map((p) => p.seat);
    }
    this.ghost = new RandomPolicy(seed ^ 0x9e3779b9);
    this.botBrains.clear();
    players.forEach((p, i) => {
      if (!p.isBot) return;
      const botSeed = (seed ^ ((i + 1) * 0x5bd1e995)) >>> 0;
      const easy = this.botDifficulty.get(p.sessionId) === "easy";
      this.botBrains.set(p.sessionId, easy ? new RandomPolicy(botSeed) : new GreedyPolicy(botSeed));
    });

    this.state.seats.clear();
    this.state.market.clear();
    for (let i = 0; i < 12; i++) this.state.market.push(new SplendorCard());
    this.seatOrder.forEach((sessionId, i) => {
      const seat = new SplendorSeat();
      seat.sessionId = sessionId;
      seat.nickname = load ? load.seats[i]!.nickname : (players[i]?.nickname ?? "");
      this.state.seats.push(seat);
      if (sessionId) this.regrantReserved(sessionId, seat.reserved);
    });
    this.state.lastRound = false;
    this.state.paused = false;
    this.state.pausedBy = "";
    this.syncFromEngine();

    this.turns?.stop();
    this.pausedTurnRemainingMs = undefined;
    this.turns = new TurnManager(this, {
      ...(this.state.turnSeconds > 0 ? { turnSeconds: this.state.turnSeconds } : {}),
      onTurnChange: (sessionId) => {
        this.state.currentTurn = sessionId;
        this.pausedTurnRemainingMs = undefined; // any pause belonged to the previous turn
        this.state.turnDeadline =
          this.state.turnSeconds > 0 ? Date.now() + this.state.turnSeconds * 1000 : 0;
      },
      onTimeout: (sessionId) => this.handleTurnTimeout(sessionId),
    });
    // Vacated seats (only possible in a resumed save) never join the rotation.
    this.turns.start(this.seatOrder.filter((sessionId) => sessionId !== ""));
    // Settle anything no human can act on (a resumed save can be awaiting a
    // vacated seat), align the rotation with the engine, arm bots/clock.
    this.afterApply();
  }

  /**
   * The turn clock ran out: the ghost finishes the seat's whole turn (the
   * move plus any chained discard / noble decision), then play moves on.
   */
  private handleTurnTimeout(sessionId: string): void {
    if (this.state.phase !== Phase.PLAYING || !this.engine || this.engine.over) return;
    const seat = this.engine.awaiting.seat;
    if (this.seatOrder[seat] !== sessionId) return;
    let guard = 0;
    while (!this.engine.over && this.engine.awaiting.seat === seat && ++guard <= 10) {
      this.engine = this.playOneDecisionFor(seat).state;
    }
    this.afterApply();
  }

  /**
   * Point a session's private view at its current reserved-cards array.
   * Each game builds new SplendorSeat instances, so grants must be re-issued
   * (and stale ones revoked) on every onGameStart.
   */
  private regrantReserved(sessionId: string, reserved: ArraySchema<SplendorCard>): void {
    const client = this.clients.getById(sessionId);
    if (!client) return; // disconnected right now: granted in onPlayerReconnected
    const old = this.grantedReserved.get(sessionId);
    if (old && old !== reserved) revokePrivateView(client, old);
    grantPrivateView(client, reserved);
    this.grantedReserved.set(sessionId, reserved);
  }

  // ---- message handlers ----------------------------------------------------

  private handleMove(client: Client, payload: unknown): void {
    if (this.state.phase !== Phase.PLAYING || !this.engine || this.engine.over) return;
    if (this.state.paused) return;
    if (this.engine.awaiting.inputType !== "MOVE") return;
    if (this.seatOrder[this.engine.awaiting.seat] !== client.sessionId) return;
    const move = parseMove(payload);
    if (!move || !isLegalMove(this.engine, move)) return;
    try {
      this.engine = applyMove(this.engine, move).state;
    } catch {
      return; // a move that passes isLegalMove but still throws: ignore, don't desync (mirrors handleResolve)
    }
    this.afterApply();
  }

  private handleResolve(client: Client, payload: unknown): void {
    if (this.state.phase !== Phase.PLAYING || !this.engine || this.engine.over) return;
    if (this.state.paused) return;
    const awaiting = this.engine.awaiting;
    if (awaiting.inputType === "MOVE") return;
    if (this.seatOrder[awaiting.seat] !== client.sessionId) return;
    const res = parseResolution(payload);
    if (!res || res.kind !== awaiting.inputType) return;
    try {
      this.engine = applyResolution(this.engine, res).state;
    } catch {
      return; // wrong count / noble not among choices / over-discard: ignore
    }
    this.afterApply();
  }

  // ---- engine driving --------------------------------------------------------

  private isVacated(engineSeat: number): boolean {
    const sessionId = this.seatOrder[engineSeat];
    return !sessionId || !this.state.players.has(sessionId);
  }

  /**
   * Resolve every state no connected human can act on, synchronously:
   *  - vacated seats are played by the ghost policy;
   *  - a present player with zero legal moves is force-passed (applyPass is
   *    only legal in exactly that case; chains of forced passes end the game
   *    as a stalemate).
   * Leaves the engine at a human-actionable state or game over.
   */
  private settleEngine(): void {
    let guard = 0;
    while (!this.engine.over && ++guard <= 10_000) {
      const awaiting = this.engine.awaiting;
      if (this.isVacated(awaiting.seat)) {
        this.engine = this.playOneDecisionFor(awaiting.seat).state;
      } else if (awaiting.inputType === "MOVE" && legalMoves(this.engine).length === 0) {
        this.engine = applyPass(this.engine).state;
      } else {
        break;
      }
    }
  }

  /** The brain for a seat: its bot policy if it is a bot, else the ghost. */
  private policyFor(engineSeat: number): Policy {
    return this.botBrains.get(this.seatOrder[engineSeat] ?? "") ?? this.ghost;
  }

  private isBotSeat(engineSeat: number): boolean {
    const sessionId = this.seatOrder[engineSeat];
    return !!sessionId && this.state.players.get(sessionId)?.isBot === true;
  }

  /**
   * Have the seat's policy act once (its move OR pending sub-decision).
   * Used by the ghost loop, the turn-timer timeout, and the paced bot turns.
   */
  private playOneDecisionFor(engineSeat: number): SplendorEngine.ApplyResult {
    const awaiting = this.engine.awaiting;
    if (awaiting.seat !== engineSeat) throw new Error("not this seat's decision");
    const policy = this.policyFor(engineSeat);
    if (awaiting.inputType === "MOVE") {
      const move = policy.move(this.engine);
      return move ? applyMove(this.engine, move) : applyPass(this.engine);
    }
    if (awaiting.inputType === "PICK_NOBLE") {
      return applyResolution(this.engine, policy.pickNoble(this.engine));
    }
    return applyResolution(this.engine, policy.discard(this.engine));
  }

  /**
   * If a bot must act next, schedule its decision one beat from now.
   * Each decision runs afterApply(), which calls back here - so a bot's
   * chained sub-decisions, and back-to-back bot seats, each get their own
   * visible beat. Cleared and re-armed on every call; paused games
   * reschedule when someone resumes.
   */
  private maybeScheduleBot(): void {
    this.botTimer?.clear();
    this.botTimer = undefined;
    if (this.state.phase !== Phase.PLAYING || !this.engine || this.engine.over) return;
    if (this.state.paused) return;
    if (!this.isBotSeat(this.engine.awaiting.seat)) return;
    this.botTimer = this.clock.setTimeout(() => {
      this.botTimer = undefined;
      if (this.state.phase !== Phase.PLAYING || this.engine.over || this.state.paused) return;
      const seat = this.engine.awaiting.seat;
      if (!this.isBotSeat(seat)) return;
      this.engine = this.playOneDecisionFor(seat).state;
      this.afterApply();
    }, this.botDelayMs);
  }

  /** Run after every accepted engine input (and after a mid-game departure). */
  private afterApply(): void {
    this.settleEngine();
    this.syncFromEngine();
    if (this.engine.over) {
      this.endGame(this.mapEndReason());
      return;
    }
    // Align the rotation with the engine. Post-settle the awaiting seat is a
    // present player, so its sessionId is in the rotation; bounded anyway.
    const target = this.seatOrder[this.engine.awaiting.seat];
    let steps = 0;
    while (target && this.turns && this.turns.current() !== target && ++steps <= this.maxPlayers) {
      this.turns.next();
    }
    // Turn rotation starts a fresh clock; refreeze it if the game is paused
    // (e.g. a quitter's seat was ghost-resolved while everyone was away).
    this.syncClock();
    this.maybeScheduleBot();
  }

  /**
   * Freeze or run the turn clock to match the current freeze conditions:
   * a manual pause, or the current player being disconnected. Idempotent;
   * safe to call after anything that may have rotated or restarted turns.
   * (Never called from inside onTurnChange - TurnManager only arms the
   * timer after that callback returns, so pausing there would be a no-op.)
   */
  private syncClock(): void {
    if (this.state.phase !== Phase.PLAYING || this.state.turnSeconds === 0 || !this.turns) return;
    const current = this.turns.current();
    const connected = !current || this.state.players.get(current)?.connected !== false;
    const shouldRun = !this.state.paused && connected;
    if (!shouldRun && this.state.turnDeadline > 0) {
      this.turns.pause();
      this.pausedTurnRemainingMs = Math.max(0, this.state.turnDeadline - Date.now());
      this.state.turnDeadline = 0;
    } else if (shouldRun && this.state.turnDeadline === 0 && this.pausedTurnRemainingMs !== undefined) {
      this.turns.resume();
      this.state.turnDeadline = Date.now() + this.pausedTurnRemainingMs;
      this.pausedTurnRemainingMs = undefined;
    }
  }

  private mapEndReason(): string {
    const winners = ranking(this.engine).filter((r) => r.rank === 1);
    if (winners.length === 1) {
      const frameworkSeat = this.frameworkSeatByEngineSeat[winners[0]!.seat];
      if (frameworkSeat !== undefined) return this.winBySeat(frameworkSeat);
    }
    return EndReason.DRAW;
  }

  // ---- engine -> schema mirror (in place; granted instances never replaced) --

  private syncFromEngine(): void {
    const e = this.engine;
    writeColors(this.state.bank, e.supplyGems);
    this.state.bankGold = e.supplyGold;
    let slot = 0;
    for (const t of [1, 2, 3] as const) {
      for (let i = 0; i < 4; i++, slot++) {
        writeCard(this.state.market[slot]!, e.market[t][i] ?? null);
      }
      this.state.deckCounts[t - 1] = e.decks[t].length;
    }
    rebuildNobles(this.state.nobles, e.nobles);
    e.players.forEach((p, idx) => {
      const seat = this.state.seats[idx];
      if (!seat) return;
      writeColors(seat.gems, p.gems);
      seat.gold = p.gold;
      writeColors(seat.bonuses, p.bonuses);
      seat.points = playerPoints(p);
      rebuildCards(seat.built, p.built);
      rebuildNobles(seat.nobles, p.nobles);
      seat.reservedCount = p.reserved.length;
      this.syncReserved(this.seatOrder[idx], seat.reserved, p.reserved);
      if (this.isVacated(idx)) {
        seat.gone = true;
        seat.sessionId = "";
      }
    });
    this.state.awaitingSeat = e.awaiting.seat;
    this.state.awaitingType = e.over ? "" : e.awaiting.inputType;
    this.state.discardCount = e.awaiting.discardCount ?? 0;
    this.state.nobleChoices.clear();
    if (!e.over) for (const id of e.awaiting.nobleChoices ?? []) this.state.nobleChoices.push(id);
    this.state.lastRound = e.endFlag;
    this.state.turnCount = e.turnCount;
    // currentTurn is written ONLY by TurnManager.onTurnChange / onGameEnded.
  }

  /**
   * Mirror one seat's reserved cards. Unlike the public arrays, every card
   * instance pushed here must ALSO be added to the owner's StateView:
   * schema v4 keeps per-item gating for default-tag @view() collections
   * (granting the array only covers items present at grant time). Reserved
   * contents are id-stable, so a quick id diff skips untouched seats.
   */
  private syncReserved(
    sessionId: string | undefined,
    dst: ArraySchema<SplendorCard>,
    src: EngineCard[]
  ): void {
    if (dst.length === src.length && src.every((c, i) => dst[i]?.id === c.id)) return;
    dst.clear();
    const client = sessionId ? this.clients.getById(sessionId) : undefined;
    for (const c of src) {
      const card = new SplendorCard();
      writeCard(card, c);
      dst.push(card);
      if (client?.view) grantPrivateView(client, card);
    }
  }

  // ---- framework hooks -------------------------------------------------------

  /**
   * Seat reclaim: a newcomer takes over a seat that left for good (the ghost
   * was playing it). onPlayerLeftForGood removed it from the TurnManager, so
   * reclaim must re-insert it into the rotation.
   */
  protected override findReclaimableSeat(): number {
    return [...this.state.seats].findIndex((seat) => seat.gone);
  }

  protected override reclaimSeat(i: number, player: BasePlayer): void {
    const seat = this.state.seats[i]!;
    this.seatOrder[i] = player.sessionId;
    this.frameworkSeatByEngineSeat[i] = player.seat; // else a win maps to the departed seat
    seat.sessionId = player.sessionId;
    seat.nickname = player.nickname;
    seat.gone = false;
    this.regrantReserved(player.sessionId, seat.reserved);
    this.turns?.insert(player.sessionId, i); // back into the rotation (removed on leave)
    this.afterApply(); // settle (ghost stops, isVacated is now false), sync, re-align the clock
  }

  protected override onPlayerDropped(player: BasePlayer): void {
    if (this.turns?.current() === player.sessionId) this.syncClock();
  }

  protected override onPlayerReconnected(player: BasePlayer): void {
    if (this.turns?.current() === player.sessionId) this.syncClock();
    if (this.state.phase !== Phase.PLAYING) return;
    const idx = this.seatOrder.indexOf(player.sessionId);
    const seat = idx >= 0 ? this.state.seats[idx] : undefined;
    const client = this.clients.getById(player.sessionId);
    // Re-grant if they were disconnected when the game (re)started, or if the
    // reconnected Client came back without its StateView.
    if (seat && (!client?.view || this.grantedReserved.get(player.sessionId) !== seat.reserved)) {
      this.regrantReserved(player.sessionId, seat.reserved);
    }
  }

  protected override onPlayerLeftForGood(player: BasePlayer): void {
    this.turns?.remove(player.sessionId);
    this.grantedReserved.delete(player.sessionId);
    this.botDifficulty.delete(player.sessionId);
    if (this.state.phase !== Phase.PLAYING || !this.engine || this.engine.over) return;
    // With too few humans left, the framework ends the game as "abandoned"
    // right after this hook - do not ghost-complete it first.
    if (this.state.players.size < this.minPlayers) return;
    this.afterApply(); // ghost resolves the leaver's pending decision / turns
  }

  protected override onGameEnded(): void {
    this.turns?.stop();
    this.botTimer?.clear();
    this.botTimer = undefined;
    this.pausedTurnRemainingMs = undefined;
    this.state.turnDeadline = 0;
    this.state.paused = false;
    this.state.pausedBy = "";
    this.state.currentTurn = "";
    this.state.awaitingType = "";
  }
}

// ---- engine -> schema writers (pure) ----------------------------------------

function writeColors(dst: ColorCounts, src: Record<Color, number>): void {
  dst.white = src.white;
  dst.blue = src.blue;
  dst.green = src.green;
  dst.red = src.red;
  dst.black = src.black;
}

function writeCard(dst: SplendorCard, src: EngineCard | null): void {
  if (!src) {
    dst.id = 0;
    dst.tier = 0;
    dst.bonus = "";
    dst.points = 0;
    dst.cost.white = dst.cost.blue = dst.cost.green = dst.cost.red = dst.cost.black = 0;
    return;
  }
  dst.id = src.id;
  dst.tier = src.tier;
  dst.bonus = src.bonus;
  dst.points = src.points;
  writeColors(dst.cost, src.cost);
}

function rebuildCards(dst: ArraySchema<SplendorCard>, src: EngineCard[]): void {
  dst.clear();
  for (const c of src) {
    const card = new SplendorCard();
    writeCard(card, c);
    dst.push(card);
  }
}

function rebuildNobles(dst: ArraySchema<SplendorNoble>, src: EngineNoble[]): void {
  dst.clear();
  for (const n of src) {
    const noble = new SplendorNoble();
    noble.id = n.id;
    noble.points = n.points;
    writeColors(noble.requirement, n.requirement);
    dst.push(noble);
  }
}

// ---- sanitizers: whitelist-copy clean objects from client JSON ---------------
// Never hand a raw client object to the engine - reject unknown kinds, wrong
// types, duplicate colors, and out-of-range values, then rebuild the payload
// from scratch. (Exported for direct unit testing.)

const COLOR_SET = new Set<string>(COLORS);

function parseTier(v: unknown): Tier | null {
  return v === 1 || v === 2 || v === 3 ? v : null;
}

function parseColor(v: unknown): Color | null {
  return typeof v === "string" && COLOR_SET.has(v) ? (v as Color) : null;
}

function parseCount(v: unknown, max: number): number | null {
  return typeof v === "number" && Number.isInteger(v) && v >= 0 && v <= max ? v : null;
}

export function parseMove(raw: unknown): Move | null {
  if (typeof raw !== "object" || raw === null) return null;
  const m = raw as Record<string, unknown>;
  switch (m.kind) {
    case "TAKE_THREE": {
      // 1..3 colors: the engine tolerates an empty take when all piles are
      // empty, but that would reset the forced-pass streak and stall
      // stalemate detection - never accept it from a client.
      if (!Array.isArray(m.colors) || m.colors.length < 1 || m.colors.length > 3) return null;
      const colors: Color[] = [];
      for (const c of m.colors) {
        const color = parseColor(c);
        if (!color) return null;
        colors.push(color);
      }
      if (new Set(colors).size !== colors.length) return null;
      return { kind: "TAKE_THREE", colors };
    }
    case "TAKE_TWO": {
      const color = parseColor(m.color);
      return color ? { kind: "TAKE_TWO", color } : null;
    }
    case "RESERVE": {
      const from = m.from as Record<string, unknown> | null | undefined;
      if (typeof from !== "object" || from === null) return null;
      if ("market" in from) {
        const market = from.market as Record<string, unknown> | null | undefined;
        const tier = parseTier(market?.tier);
        const index = parseCount(market?.index, 3);
        if (tier === null || index === null) return null;
        return { kind: "RESERVE", from: { market: { tier, index } } };
      }
      if ("deck" in from) {
        const deck = from.deck as Record<string, unknown> | null | undefined;
        const tier = parseTier(deck?.tier);
        return tier === null ? null : { kind: "RESERVE", from: { deck: { tier } } };
      }
      return null;
    }
    case "BUY": {
      const from = m.from as Record<string, unknown> | null | undefined;
      if (typeof from !== "object" || from === null) return null;
      if ("market" in from) {
        const market = from.market as Record<string, unknown> | null | undefined;
        const tier = parseTier(market?.tier);
        const index = parseCount(market?.index, 3);
        if (tier === null || index === null) return null;
        return { kind: "BUY", from: { market: { tier, index } } };
      }
      if ("reserve" in from) {
        const reserve = from.reserve as Record<string, unknown> | null | undefined;
        const cardId = parseCount(reserve?.cardId, 90);
        if (cardId === null || cardId < 1) return null;
        return { kind: "BUY", from: { reserve: { cardId } } };
      }
      return null;
    }
    default:
      return null;
  }
}

export function parseResolution(raw: unknown): Resolution | null {
  if (typeof raw !== "object" || raw === null) return null;
  const r = raw as Record<string, unknown>;
  if (r.kind === "PICK_NOBLE") {
    const nobleId = parseCount(r.nobleId, 10);
    return nobleId !== null && nobleId >= 1 ? { kind: "PICK_NOBLE", nobleId } : null;
  }
  if (r.kind === "DISCARD") {
    const gemsIn = (typeof r.gems === "object" && r.gems !== null ? r.gems : {}) as Record<
      string,
      unknown
    >;
    const gems: Partial<Record<Color, number>> = {};
    for (const key of Object.keys(gemsIn)) {
      const color = parseColor(key);
      const count = parseCount(gemsIn[key], 10);
      if (!color || count === null) return null;
      if (count > 0) gems[color] = count;
    }
    const gold = r.gold === undefined ? 0 : parseCount(r.gold, 5);
    if (gold === null) return null;
    return { kind: "DISCARD", gems, gold };
  }
  return null;
}

export { SPLENDOR };
