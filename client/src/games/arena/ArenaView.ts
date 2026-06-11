/**
 * Dot Arena view - the reference example for real-time game UIs.
 * Canvas rendering at display framerate with interpolation toward the
 * server state (which arrives ~20x/second). Keyboard (arrows/WASD) and
 * touch-joystick input, sent only when the direction changes.
 */
import type { Room } from "@colyseus/sdk";
import {
  ARENA_HEIGHT,
  ARENA_PELLET_RADIUS,
  ARENA_PLAYER_RADIUS,
  ARENA_TICK_RATE,
  ARENA_WIN_SCORE,
  ARENA_WIDTH,
  ArenaMsg,
  type ArenaPlayer,
  type ArenaState,
  type BaseState,
} from "@backbone/shared";
import type { GameView, GameViewContext } from "../../framework/GameView.js";

const SEAT_COLORS = [
  "#5b8cff",
  "#e35d6a",
  "#41c98a",
  "#e3b341",
  "#b06fe8",
  "#4fd1c5",
  "#f08a4b",
  "#9aa0b4",
];

interface Display {
  x: number;
  y: number;
}

export class ArenaView implements GameView {
  private root?: HTMLElement;
  private room?: Room<any, ArenaState>;
  private ctx2d?: CanvasRenderingContext2D;
  private myId = "";
  private raf = 0;
  private lastFrame = 0;
  private displayPos = new Map<string, Display>();

  // Current input state.
  private keys = new Set<string>();
  private touchVector: { dx: number; dy: number } | null = null;
  private lastSent = { dx: 0, dy: 0 };
  private touchOrigin: { x: number; y: number } | null = null;
  // Outbound input is rate-limited to the server tick rate (see sendInput).
  private lastSentAt = 0;
  private trailingTimer = 0;

  private readonly onKeyDown = (e: KeyboardEvent) => {
    if (KEY_VECTORS[e.key]) {
      e.preventDefault();
      this.keys.add(e.key);
      this.sendInput();
    }
  };
  private readonly onKeyUp = (e: KeyboardEvent) => {
    if (this.keys.delete(e.key)) this.sendInput();
  };

  mount(root: HTMLElement, room: Room<any, BaseState>, ctx: GameViewContext): void {
    this.root = root;
    this.room = room as unknown as Room<any, ArenaState>;
    this.myId = ctx.mySessionId;

    root.innerHTML = `
      <div class="arena">
        <p class="center muted">First to ${ARENA_WIN_SCORE} pellets wins.
          Arrow keys / WASD, or drag on the field.</p>
        <canvas id="arena-canvas" width="${ARENA_WIDTH}" height="${ARENA_HEIGHT}"></canvas>
      </div>
    `;
    const canvas = root.querySelector<HTMLCanvasElement>("#arena-canvas")!;
    this.ctx2d = canvas.getContext("2d") ?? undefined;

    window.addEventListener("keydown", this.onKeyDown);
    window.addEventListener("keyup", this.onKeyUp);

    // Touch joystick: where the finger lands is the neutral point;
    // dragging away steers in that direction.
    canvas.addEventListener("touchstart", (e) => {
      e.preventDefault();
      const t = e.touches[0]!;
      this.touchOrigin = { x: t.clientX, y: t.clientY };
    });
    canvas.addEventListener("touchmove", (e) => {
      e.preventDefault();
      if (!this.touchOrigin) return;
      const t = e.touches[0]!;
      const dx = t.clientX - this.touchOrigin.x;
      const dy = t.clientY - this.touchOrigin.y;
      const len = Math.hypot(dx, dy);
      const DEADZONE = 12;
      this.touchVector =
        len < DEADZONE ? { dx: 0, dy: 0 } : { dx: dx / len, dy: dy / len };
      this.sendInput();
    });
    const endTouch = (e: TouchEvent) => {
      e.preventDefault();
      this.touchOrigin = null;
      this.touchVector = null;
      this.sendInput();
    };
    canvas.addEventListener("touchend", endTouch);
    canvas.addEventListener("touchcancel", endTouch);

    this.lastFrame = performance.now();
    this.raf = requestAnimationFrame((t) => this.frame(t));
  }

  unmount(): void {
    cancelAnimationFrame(this.raf);
    if (this.trailingTimer) clearTimeout(this.trailingTimer);
    window.removeEventListener("keydown", this.onKeyDown);
    window.removeEventListener("keyup", this.onKeyUp);
    this.displayPos.clear();
    this.root = undefined;
    this.room = undefined;
    this.ctx2d = undefined;
  }

  /** Combine keyboard/touch into one direction and send if changed. */
  private sendInput(): void {
    let dx = 0;
    let dy = 0;
    if (this.touchVector) {
      dx = this.touchVector.dx;
      dy = this.touchVector.dy;
    } else {
      for (const key of this.keys) {
        const v = KEY_VECTORS[key];
        if (v) {
          dx += v[0];
          dy += v[1];
        }
      }
      const len = Math.hypot(dx, dy);
      if (len > 1) {
        dx /= len;
        dy /= len;
      }
    }
    if (dx === this.lastSent.dx && dy === this.lastSent.dy) return;

    // Rate-limit to the server tick rate. The server ticks ARENA_TICK_RATE
    // times/second and only consumes each player's LATEST input per tick, so
    // sending faster is wasted work - and a touch drag fires one touchmove per
    // frame (60-120/s), which would exceed the room's per-client message cap
    // and get the player force-disconnected. Send on the leading edge, then
    // coalesce a trailing send so the final direction always lands.
    const minInterval = 1000 / ARENA_TICK_RATE;
    const wait = minInterval - (performance.now() - this.lastSentAt);
    if (wait <= 0) {
      this.lastSent = { dx, dy };
      this.lastSentAt = performance.now();
      this.room?.send(ArenaMsg.INPUT, { dx, dy });
    } else if (!this.trailingTimer) {
      this.trailingTimer = window.setTimeout(() => {
        this.trailingTimer = 0;
        this.sendInput();
      }, wait);
    }
  }

  private frame(now: number): void {
    if (!this.ctx2d || !this.room) return;
    const dt = Math.min(0.1, (now - this.lastFrame) / 1000);
    this.lastFrame = now;
    this.draw(dt);
    this.raf = requestAnimationFrame((t) => this.frame(t));
  }

  private draw(dt: number): void {
    const g = this.ctx2d!;
    const state = this.room!.state;
    if (!state?.players) return;

    g.clearRect(0, 0, ARENA_WIDTH, ARENA_HEIGHT);
    g.fillStyle = "#10131c";
    g.fillRect(0, 0, ARENA_WIDTH, ARENA_HEIGHT);

    // Pellets.
    g.fillStyle = "#e8eaf2";
    state.pellets.forEach((pellet) => {
      g.beginPath();
      g.arc(pellet.x, pellet.y, ARENA_PELLET_RADIUS, 0, Math.PI * 2);
      g.fill();
    });

    // Players (interpolated toward their server position).
    const seen = new Set<string>();
    const lerp = Math.min(1, dt * 12);
    state.players.forEach((player, sessionId) => {
      const p = player as ArenaPlayer;
      seen.add(sessionId);
      let d = this.displayPos.get(sessionId);
      if (!d) {
        d = { x: p.x, y: p.y };
        this.displayPos.set(sessionId, d);
      }
      d.x += (p.x - d.x) * lerp;
      d.y += (p.y - d.y) * lerp;

      const color = SEAT_COLORS[p.seat % SEAT_COLORS.length]!;
      g.globalAlpha = p.connected ? 1 : 0.35;
      g.fillStyle = color;
      g.beginPath();
      g.arc(d.x, d.y, ARENA_PLAYER_RADIUS, 0, Math.PI * 2);
      g.fill();
      if (sessionId === this.myId) {
        g.strokeStyle = "#ffffff";
        g.lineWidth = 3;
        g.stroke();
      }
      g.font = "13px system-ui, sans-serif";
      g.textAlign = "center";
      g.fillStyle = "#e8eaf2";
      g.fillText(p.nickname, d.x, d.y - ARENA_PLAYER_RADIUS - 6);
      g.globalAlpha = 1;
    });
    for (const id of this.displayPos.keys()) {
      if (!seen.has(id)) this.displayPos.delete(id);
    }

    // Scoreboard.
    const players: ArenaPlayer[] = [];
    state.players.forEach((p) => players.push(p as ArenaPlayer));
    players.sort((a, b) => b.score - a.score || a.seat - b.seat);
    g.textAlign = "left";
    g.font = "14px system-ui, sans-serif";
    players.forEach((p, i) => {
      g.fillStyle = SEAT_COLORS[p.seat % SEAT_COLORS.length]!;
      g.fillText(`${p.nickname}: ${p.score}`, 12, 22 + i * 18);
    });
  }
}

const KEY_VECTORS: Record<string, [number, number] | undefined> = {
  ArrowUp: [0, -1],
  ArrowDown: [0, 1],
  ArrowLeft: [-1, 0],
  ArrowRight: [1, 0],
  w: [0, -1],
  s: [0, 1],
  a: [-1, 0],
  d: [1, 0],
  W: [0, -1],
  S: [0, 1],
  A: [-1, 0],
  D: [1, 0],
};
