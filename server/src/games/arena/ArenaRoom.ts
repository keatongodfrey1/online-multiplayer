/**
 * Dot Arena room - the reference example for real-time games.
 * Demonstrates: TickLoop (fixed-step simulation + validated input
 * buffer), server-authoritative movement, collision/scoring, late join,
 * and freezing disconnected players instead of removing them.
 */
import {
  ARENA_HEIGHT,
  ARENA_PELLET_COUNT,
  ARENA_PELLET_RADIUS,
  ARENA_PLAYER_RADIUS,
  ARENA_PLAYER_SPEED,
  ARENA_TICK_RATE,
  ARENA_WIDTH,
  ARENA_WIN_SCORE,
  ArenaMsg,
  ArenaPlayer,
  ArenaState,
  type BasePlayer,
  Pellet,
  Phase,
} from "@backbone/shared";
import { BaseGameRoom } from "../../framework/BaseGameRoom.js";
import { TickLoop } from "../../framework/TickLoop.js";

interface ArenaInput {
  dx: number;
  dy: number;
}

export class ArenaRoom extends BaseGameRoom<ArenaState> {
  state = new ArenaState();
  readonly minPlayers = 2;
  readonly maxPlayers = 8;
  override allowLateJoin = true;

  private pelletSeq = 0;
  private loop = new TickLoop<ArenaInput>(this, {
    tickRate: ARENA_TICK_RATE,
    onTick: (dt) => this.tick(dt),
  });

  protected createPlayer(): ArenaPlayer {
    const player = new ArenaPlayer();
    this.placeRandomly(player, ARENA_PLAYER_RADIUS);
    return player;
  }

  protected override onRoomCreate(): void {
    this.loop.bindInput(ArenaMsg.INPUT, (raw) => {
      const p = raw as { dx?: unknown; dy?: unknown };
      const dx = typeof p?.dx === "number" && Number.isFinite(p.dx) ? p.dx : NaN;
      const dy = typeof p?.dy === "number" && Number.isFinite(p.dy) ? p.dy : NaN;
      if (Number.isNaN(dx) || Number.isNaN(dy)) return null; // malformed
      // Clamp, then normalize so diagonals (or forged inputs) aren't faster.
      let vx = Math.max(-1, Math.min(1, dx));
      let vy = Math.max(-1, Math.min(1, dy));
      const len = Math.hypot(vx, vy);
      if (len > 1) {
        vx /= len;
        vy /= len;
      }
      return { dx: vx, dy: vy };
    });
  }

  protected onGameStart(): void {
    // Full re-init - also runs on rematch.
    this.state.pellets.clear();
    for (let i = 0; i < ARENA_PELLET_COUNT; i++) this.spawnPellet();
    for (const player of this.state.players.values()) {
      const p = player as ArenaPlayer;
      p.score = 0;
      this.placeRandomly(p, ARENA_PLAYER_RADIUS);
    }
    this.loop.inputs.clear();
    this.loop.start();
  }

  private tick(dt: number): void {
    if (this.state.phase !== Phase.PLAYING) return;

    for (const player of this.state.players.values()) {
      const p = player as ArenaPlayer;
      // Disconnected players freeze in place until they return.
      if (!p.connected) continue;
      const input = this.loop.inputs.get(p.sessionId);
      if (!input) continue;

      p.x += input.dx * ARENA_PLAYER_SPEED * dt;
      p.y += input.dy * ARENA_PLAYER_SPEED * dt;
      p.x = Math.max(ARENA_PLAYER_RADIUS, Math.min(ARENA_WIDTH - ARENA_PLAYER_RADIUS, p.x));
      p.y = Math.max(ARENA_PLAYER_RADIUS, Math.min(ARENA_HEIGHT - ARENA_PLAYER_RADIUS, p.y));

      // Pellet pickups.
      const reach = ARENA_PLAYER_RADIUS + ARENA_PELLET_RADIUS;
      for (const [id, pellet] of this.state.pellets.entries()) {
        if (Math.hypot(pellet.x - p.x, pellet.y - p.y) <= reach) {
          this.state.pellets.delete(id);
          this.spawnPellet();
          p.score += 1;
          if (p.score >= ARENA_WIN_SCORE) {
            this.endGame(this.winBySeat(p.seat));
            return;
          }
        }
      }
    }
  }

  protected override onPlayerJoinedMidGame(player: BasePlayer): void {
    // createPlayer already placed them; nothing else needed - this hook
    // exists so games can e.g. grant catch-up bonuses.
  }

  protected override onPlayerLeftForGood(player: BasePlayer): void {
    this.loop.clearInput(player.sessionId);
  }

  protected override onGameEnded(): void {
    this.loop.stop();
  }

  private spawnPellet(): void {
    const pellet = new Pellet();
    this.placeRandomly(pellet, ARENA_PELLET_RADIUS);
    this.state.pellets.set(`p${this.pelletSeq++}`, pellet);
  }

  private placeRandomly(entity: { x: number; y: number }, margin: number): void {
    entity.x = margin + Math.random() * (ARENA_WIDTH - margin * 2);
    entity.y = margin + Math.random() * (ARENA_HEIGHT - margin * 2);
  }
}

export { ARENA } from "@backbone/shared";
