/**
 * Paper.io room - drives the pure rules engine (shared/games/paperio/engine)
 * and mirrors it into the synced schema, real-time: a TickLoop (fixed-step)
 * advances the world every tick and pushes the changes into the schema.
 *
 * Authority model: `world` is the server-only source of truth. Humans send
 * tiny STEER messages (a heading); the loop keeps only the latest per player
 * and feeds it to the engine each tick. Bots are engine-owned and dynamic -
 * the engine spawns/eliminates them and keeps the population topped up; the
 * room just mirrors the live bots into state.bots. Disconnected humans are
 * frozen in place (seat held by the framework's grace period), not removed.
 */
import {
  BOARD_SIZES,
  type BasePlayer,
  BOT_COUNT_DEFAULT,
  BOT_DIFFICULTY_DEFAULT,
  type BotDifficulty,
  EndReason,
  isBoardSize,
  isBotDifficulty,
  isSpeed,
  isValidBotCount,
  isValidLives,
  isValidTargetPercent,
  isValidTimedSeconds,
  isWinMode,
  LIVES_DEFAULT,
  MAX_BOTS,
  PAPERIO,
  PAPERIO_TICK_RATE,
  PaperIoBot,
  PaperIoEngine,
  PaperIoMsg,
  PaperIoPlayer,
  PaperIoState,
  Phase,
  SPEEDS,
  TARGET_PCT_DEFAULT,
  TIMED_SEC_DEFAULT,
} from "@backbone/shared";
import type { Client } from "colyseus";
import { Encoder } from "@colyseus/schema";
import { BaseGameRoom } from "../../framework/BaseGameRoom.js";
import { TickLoop } from "../../framework/TickLoop.js";

// Paper.io syncs a per-cell territory grid (up to ~6400 cells) plus per-actor
// trails for many bots. A big claim or the initial board can exceed @colyseus/
// schema's 8 KB default encode buffer (which then auto-grows with a console
// warning); raise it once, up front, to a size that fits the worst case.
const PAPERIO_ENCODE_BUFFER = 1024 * 1024;
if (Encoder.BUFFER_SIZE < PAPERIO_ENCODE_BUFFER) Encoder.BUFFER_SIZE = PAPERIO_ENCODE_BUFFER;

interface SteerInput {
  heading: number;
}

export class PaperIoRoom extends BaseGameRoom<PaperIoState> {
  state = new PaperIoState();
  readonly minPlayers = 1; // solo vs bots is allowed
  readonly maxPlayers = 8; // humans; bots are engine-owned and not seated here
  // allowLateJoin stays false: players gather in the lobby, then a round runs
  // to a finish. A mid-game refresh still reconnects to its seat (framework grace).
  // supportsBots stays false: bots are not roster players - the host sets a
  // count + one difficulty and the engine manages them.

  /** Server-only truth (never synced). Public = white-box test seam. */
  public world?: PaperIoEngine.PaperIoWorld;

  private seedOption?: number;

  private loop = new TickLoop<SteerInput>(this, {
    tickRate: PAPERIO_TICK_RATE,
    onTick: (dt) => this.tick(dt),
  });

  protected createPlayer(): PaperIoPlayer {
    return new PaperIoPlayer();
  }

  protected override onRoomCreate(options: unknown): void {
    const seed = (options as { seed?: unknown } | null)?.seed;
    if (typeof seed === "number" && Number.isFinite(seed)) this.seedOption = seed >>> 0;

    // Lobby defaults (host can change them before starting).
    this.state.boardSize = "medium";
    this.state.speed = "normal";
    this.state.winMode = "target";
    this.state.targetPercent = TARGET_PCT_DEFAULT;
    this.state.timedSeconds = TIMED_SEC_DEFAULT;
    this.state.startLives = LIVES_DEFAULT;
    this.state.botCount = BOT_COUNT_DEFAULT;
    this.state.botDifficulty = BOT_DIFFICULTY_DEFAULT;

    this.loop.bindInput(PaperIoMsg.STEER, (raw) => {
      const h = (raw as { heading?: unknown } | null)?.heading;
      if (typeof h !== "number" || !Number.isFinite(h)) return null;
      return { heading: h };
    });
    this.onMessage(PaperIoMsg.CONFIG, (client, payload) => this.handleConfig(client, payload));
  }

  // ---- lobby settings ------------------------------------------------------

  private handleConfig(client: Client, payload: unknown): void {
    if (this.state.phase !== Phase.LOBBY) return;
    if (client.sessionId !== this.state.hostSessionId) return;
    const p = (payload ?? {}) as Record<string, unknown>;
    if (isBoardSize(p.boardSize)) this.state.boardSize = p.boardSize;
    if (isSpeed(p.speed)) this.state.speed = p.speed;
    if (isWinMode(p.winMode)) this.state.winMode = p.winMode;
    if (isValidTargetPercent(p.targetPercent)) this.state.targetPercent = p.targetPercent;
    if (isValidTimedSeconds(p.timedSeconds)) this.state.timedSeconds = p.timedSeconds;
    if (isValidLives(p.lives)) this.state.startLives = p.lives;
    if (isValidBotCount(p.botCount)) this.state.botCount = p.botCount;
    if (isBotDifficulty(p.botDifficulty)) this.state.botDifficulty = p.botDifficulty;
  }

  // ---- lifecycle -----------------------------------------------------------

  protected onGameStart(): void {
    const players = [...this.state.players.values()].sort((a, b) => a.seat - b.seat);
    const board = BOARD_SIZES[this.state.boardSize as keyof typeof BOARD_SIZES] ?? BOARD_SIZES.medium;
    const speed = (SPEEDS[this.state.speed as keyof typeof SPEEDS] ?? SPEEDS.normal).cellsPerSec;
    const winMode = this.state.winMode === "timed" ? "timed" : "target";
    const seed = this.seedOption ?? (Math.floor(Math.random() * 0xffffffff) >>> 0);

    this.world = new PaperIoEngine.PaperIoWorld(
      {
        cols: board.cols,
        rows: board.rows,
        speedCellsPerSec: speed,
        winMode,
        targetThreshold: winMode === "target" ? this.state.targetPercent / 100 : 1,
        timedLimitMs: this.state.timedSeconds * 1000,
        humanLives: this.state.startLives,
        humans: players.map((p) => ({ seat: p.seat })),
        botCount: this.state.botCount,
        botDifficulty: this.state.botDifficulty as BotDifficulty,
        maxBots: MAX_BOTS,
      },
      seed
    );

    this.state.cols = board.cols;
    this.state.rows = board.rows;
    this.state.outcome = "";
    this.state.endsAt = winMode === "timed" ? Date.now() + this.state.timedSeconds * 1000 : 0;

    // Full grid copy once; per-tick syncs apply only the dirty deltas.
    this.state.grid.clear();
    for (let i = 0; i < this.world.totalCells; i++) this.state.grid.push(this.world.grid[i]!);
    this.world.dirty.clear();

    for (const p of players) {
      const pl = p as PaperIoPlayer;
      pl.trail.clear();
      this.syncPlayer(pl);
    }
    this.state.bots.clear();
    this.syncBots();

    this.loop.inputs.clear();
    this.loop.start();
  }

  private tick(dt: number): void {
    const w = this.world;
    if (!w || this.state.phase !== Phase.PLAYING) return;

    // Feed the latest steer for each connected human; freeze the disconnected.
    for (const player of this.state.players.values()) {
      const a = w.actorBySeat(player.seat);
      if (!a) continue;
      a.frozen = !player.connected;
      if (!a.frozen) {
        const input = this.loop.inputs.get(player.sessionId);
        if (input) w.steer(player.seat, input.heading);
      }
    }

    w.step(dt);
    w.drainEvents(); // events are not synced; the view derives feedback from state

    this.syncFromWorld();

    if (w.ended) this.finishFromWorld();
  }

  protected override onPlayerLeftForGood(player: BasePlayer): void {
    this.loop.clearInput(player.sessionId);
    const w = this.world;
    if (this.state.phase !== Phase.PLAYING || !w) return;
    // Free the seat in the engine; this may end the round (no humans left).
    w.forceEliminate(player.seat);
    this.syncFromWorld();
    if (w.ended) this.finishFromWorld();
  }

  protected override onGameEnded(): void {
    this.loop.stop();
    this.state.endsAt = 0;
  }

  // ---- schema mirror -------------------------------------------------------

  private syncFromWorld(): void {
    const w = this.world!;
    for (const player of this.state.players.values()) this.syncPlayer(player as PaperIoPlayer);
    this.syncBots();
    // Apply only the cells that changed this tick.
    for (const idx of w.dirty) this.state.grid[idx] = w.grid[idx]!;
    w.dirty.clear();
  }

  private syncPlayer(pl: PaperIoPlayer): void {
    const w = this.world!;
    const a = w.actorBySeat(pl.seat);
    if (!a) return;
    pl.x = a.fx;
    pl.y = a.fy;
    pl.heading = a.heading;
    pl.alive = a.alive;
    pl.dead = a.dead;
    pl.eliminated = a.eliminated;
    pl.lives = a.lives;
    pl.cellsOwned = w.territoryOf(a.seat);
    this.syncTrail(pl.trail, a.trail);
  }

  private syncBots(): void {
    const w = this.world!;
    const live = new Set<string>();
    for (const b of w.bots) {
      const key = String(b.id);
      live.add(key);
      let sb = this.state.bots.get(key);
      if (!sb) {
        sb = new PaperIoBot();
        sb.id = b.id;
        sb.colorSeed = b.colorSeed;
        this.state.bots.set(key, sb);
      }
      sb.x = b.fx;
      sb.y = b.fy;
      sb.heading = b.heading;
      sb.dead = b.dead;
      sb.cellsOwned = w.territoryOfId(b.id);
      this.syncTrail(sb.trail, b.trail);
    }
    // Drop schema bots whose engine actor was eliminated this tick.
    for (const key of [...this.state.bots.keys()]) if (!live.has(key)) this.state.bots.delete(key);
  }

  /** Mirror an engine trail (only ever grows by append or clears to empty). */
  private syncTrail(dst: { length: number; clear: () => void; push: (v: number) => void }, src: number[]): void {
    if (src.length === 0) {
      if (dst.length > 0) dst.clear();
    } else if (src.length > dst.length) {
      for (let i = dst.length; i < src.length; i++) dst.push(src[i]!);
    } else if (src.length < dst.length) {
      dst.clear();
      for (const idx of src) dst.push(idx);
    }
  }

  private finishFromWorld(): void {
    const r = this.world?.endResult;
    this.state.outcome = r?.outcome ?? "draw";
    if (!r || r.winnerSeat === null || r.winnerSeat < 0) this.endGame(EndReason.DRAW);
    else this.endGame(this.winBySeat(r.winnerSeat));
  }
}

export { PAPERIO };
