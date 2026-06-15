/**
 * Paper.io room - drives the pure rules engine (shared/games/paperio/engine)
 * and mirrors it into the synced schema, exactly like the engine-backed games
 * but real-time: a TickLoop (fixed-step) advances the world every tick and
 * pushes the changes into the schema.
 *
 * Authority model: `world` is the server-only source of truth. Humans send
 * tiny STEER messages (a heading); the loop keeps only the latest per player
 * and feeds it to the engine each tick. Bots are played entirely by the
 * engine (their brains run inside world.step). Disconnected humans are frozen
 * in place (seat held by the framework's grace period), not removed.
 */
import {
  BOARD_SIZES,
  type BasePlayer,
  type BotDifficulty,
  DIFFICULTIES,
  EndReason,
  isBoardSize,
  isBotDifficulty,
  isSpeed,
  isValidLives,
  isValidTargetPercent,
  isValidTimedSeconds,
  isWinMode,
  LIVES_DEFAULT,
  PAPERIO,
  PAPERIO_TICK_RATE,
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

// Paper.io syncs a per-cell territory grid (up to ~2560 cells) plus per-player
// trails. A big territory claim or the initial board can exceed @colyseus/
// schema's 8 KB default encode buffer (which then auto-grows with a console
// warning); raise it once, up front, to a size that fits the worst case.
const PAPERIO_ENCODE_BUFFER = 256 * 1024;
if (Encoder.BUFFER_SIZE < PAPERIO_ENCODE_BUFFER) Encoder.BUFFER_SIZE = PAPERIO_ENCODE_BUFFER;

interface SteerInput {
  heading: number;
}

export class PaperIoRoom extends BaseGameRoom<PaperIoState> {
  state = new PaperIoState();
  readonly minPlayers = 2;
  readonly maxPlayers = 8;
  override supportsBots = true;
  // allowLateJoin stays false: players gather in the lobby, then a round runs
  // to a finish. A mid-game refresh still reconnects to its seat (framework grace).

  /** Server-only truth (never synced). Public = white-box test seam. */
  public world?: PaperIoEngine.PaperIoWorld;

  private botDifficulty = new Map<string, BotDifficulty>();
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

    this.loop.bindInput(PaperIoMsg.STEER, (raw) => {
      const h = (raw as { heading?: unknown } | null)?.heading;
      if (typeof h !== "number" || !Number.isFinite(h)) return null;
      return { heading: h };
    });
    this.onMessage(PaperIoMsg.CONFIG, (client, payload) => this.handleConfig(client, payload));
  }

  // ---- bots ----------------------------------------------------------------

  protected override onBotAdded(bot: BasePlayer, options: unknown): void {
    const raw = (options as { difficulty?: unknown } | null)?.difficulty;
    const diff: BotDifficulty = isBotDifficulty(raw) ? raw : "normal";
    this.botDifficulty.set(bot.sessionId, diff);
    bot.nickname = `${bot.nickname} (${DIFFICULTIES[diff].label})`;
  }

  protected override onBotRemoved(sessionId: string): void {
    this.botDifficulty.delete(sessionId);
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
        lives: this.state.startLives,
        seats: players.map((p) => ({
          seat: p.seat,
          isBot: p.isBot,
          difficulty: p.isBot ? this.botDifficulty.get(p.sessionId) ?? "normal" : "normal",
        })),
      },
      seed
    );

    this.state.cols = board.cols;
    this.state.rows = board.rows;
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

    this.loop.inputs.clear();
    this.loop.start();
  }

  private tick(dt: number): void {
    const w = this.world;
    if (!w || this.state.phase !== Phase.PLAYING) return;

    // Feed the latest steer for each connected human; freeze the disconnected.
    for (const player of this.state.players.values()) {
      const a = w.actorBySeat(player.seat);
      if (!a || a.isBot) continue;
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
    this.botDifficulty.delete(player.sessionId);
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
    for (const player of this.state.players.values()) {
      this.syncPlayer(player as PaperIoPlayer);
    }
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
    // The engine trail only ever grows (append) or clears to empty.
    if (a.trail.length === 0) {
      if (pl.trail.length > 0) pl.trail.clear();
    } else if (a.trail.length > pl.trail.length) {
      for (let i = pl.trail.length; i < a.trail.length; i++) pl.trail.push(a.trail[i]!);
    } else if (a.trail.length < pl.trail.length) {
      pl.trail.clear();
      for (const idx of a.trail) pl.trail.push(idx);
    }
  }

  private finishFromWorld(): void {
    const r = this.world?.endResult;
    if (!r || r.winnerSeat === null || r.winnerSeat < 0) this.endGame(EndReason.DRAW);
    else this.endGame(this.winBySeat(r.winnerSeat));
  }
}

export { PAPERIO };
