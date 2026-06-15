/**
 * Paper.io view - real-time canvas UI with a follow camera so boards can be
 * larger than one screen and it plays on a phone. The camera centres the local
 * head (devicePixel-aware, viewport-filling canvas); only the visible cells are
 * drawn. A corner minimap shows the whole board. Humans are framework players
 * (seat colours); bots are engine-owned and synced in state.bots (a fresh hue
 * per spawn). Input is free-angle: drag (pointer/touch) or arrow keys / WASD,
 * sent only on change and throttled to the tick rate.
 */
import type { Room } from "@colyseus/sdk";
import {
  type BaseState,
  BOARD_SIZE_ORDER,
  BOARD_SIZES,
  BOT_COUNT_MAX,
  BOT_COUNT_MIN,
  DIFFICULTY_ORDER,
  EndReason,
  LIVES_MAX,
  LIVES_MIN,
  PAPERIO_TICK_RATE,
  type PaperIoBot,
  type PaperIoPlayer,
  PaperIoMsg,
  type PaperIoState,
  SPEED_ORDER,
  SPEEDS,
  TARGET_PCT_MAX,
  TARGET_PCT_MIN,
  TARGET_PCT_STEP,
  TIMED_SEC_MAX,
  TIMED_SEC_MIN,
  TIMED_SEC_STEP,
} from "@backbone/shared";
import type { GameView, GameViewContext, LobbySettingsContext } from "../../framework/GameView.js";
import { escapeHtml } from "../../lobby/HomeScreen.js";

interface Col {
  land: string;
  trail: string;
  head: string;
}
/** A distinct land/trail/head triple per HUMAN seat (0..7). */
const SEAT_COLORS: Col[] = [
  { land: "#e0455e", trail: "#ff90a3", head: "#ffd6dd" },
  { land: "#3f7fe0", trail: "#8fbcff", head: "#d6e6ff" },
  { land: "#2fae74", trail: "#7fe3b6", head: "#d4f6e6" },
  { land: "#d9a233", trail: "#ffd47a", head: "#fff0cf" },
  { land: "#9b5de0", trail: "#cfa3ff", head: "#ecdcff" },
  { land: "#27b3c0", trail: "#84e3ec", head: "#d3f6fa" },
  { land: "#e07a3f", trail: "#ffb98f", head: "#ffe5d4" },
  { land: "#6b7280", trail: "#b6bcc9", head: "#e4e7ee" },
];
function seatColor(seat: number): Col {
  return SEAT_COLORS[seat % SEAT_COLORS.length]!;
}
/** Bots get an ever-changing hue from their spawn seed (golden-angle spacing). */
function botColor(seed: number): Col {
  const h = Math.round((seed * 137.508 + 25) % 360);
  return { land: `hsl(${h},60%,52%)`, trail: `hsl(${h},80%,70%)`, head: `hsl(${h},92%,86%)` };
}

const FALLBACK: Col = { land: "#555a68", trail: "#888ea0", head: "#c0c6d4" };
const BOARD_BG = "#161b29";
const GRID_LINE = "#222a3d";
const VOID_BG = "#0c0e15";
const MINIMAP_MAX = 150;

interface Display {
  x: number;
  y: number;
}

export class PaperIoView implements GameView {
  private root?: HTMLElement;
  private room?: Room<any, PaperIoState>;
  private canvas?: HTMLCanvasElement;
  private g?: CanvasRenderingContext2D;
  private myId = "";
  private raf = 0;
  private lastFrame = 0;

  private cell = 18;
  private cssW = 0;
  private cssH = 0;
  private dpr = 1;
  private camX = 0;
  private camY = 0;

  private displayPos = new Map<string, Display>();
  private idColor = new Map<number, Col>();
  private mm?: HTMLCanvasElement;
  private mmCtx?: CanvasRenderingContext2D;
  private mmLast = 0;

  // Input
  private keys = new Set<string>();
  private pointerOrigin: { x: number; y: number } | null = null;
  private pointerNow: { x: number; y: number } | null = null;
  private currentHeading: number | null = null;
  private hasSteered = false;
  private lastSentHeading: number | null = null;
  private lastSentAt = 0;
  private trailingTimer = 0;
  private wasAlive = true;

  private readonly onKeyDown = (e: KeyboardEvent) => {
    if (KEY_VECTORS[e.key]) {
      e.preventDefault();
      this.keys.add(e.key);
      this.steerFromKeys();
    }
  };
  private readonly onKeyUp = (e: KeyboardEvent) => {
    this.keys.delete(e.key); // no "stop" in paper.io: keep the current heading
  };
  private readonly onResize = () => this.layout();

  mount(root: HTMLElement, room: Room<any, BaseState>, ctx: GameViewContext): void {
    this.root = root;
    this.room = room as unknown as Room<any, PaperIoState>;
    this.myId = ctx.mySessionId;

    root.innerHTML = `
      <div class="pio-wrap">
        <canvas id="pio-canvas"></canvas>
        <p class="center muted pio-hint">Drag anywhere (or arrow keys / WASD) to steer.
          Close a loop to claim land; don't cross a trail.</p>
      </div>`;
    this.canvas = root.querySelector<HTMLCanvasElement>("#pio-canvas")!;
    this.g = this.canvas.getContext("2d") ?? undefined;
    this.mm = document.createElement("canvas");
    this.mmCtx = this.mm.getContext("2d") ?? undefined;
    this.layout();

    window.addEventListener("keydown", this.onKeyDown);
    window.addEventListener("keyup", this.onKeyUp);
    window.addEventListener("resize", this.onResize);
    this.canvas.addEventListener("pointerdown", this.onPointerDown);
    this.canvas.addEventListener("pointermove", this.onPointerMove);
    this.canvas.addEventListener("pointerup", this.onPointerUp);
    this.canvas.addEventListener("pointercancel", this.onPointerUp);

    this.lastFrame = performance.now();
    this.raf = requestAnimationFrame((t) => this.frame(t));
  }

  unmount(): void {
    cancelAnimationFrame(this.raf);
    if (this.trailingTimer) clearTimeout(this.trailingTimer);
    window.removeEventListener("keydown", this.onKeyDown);
    window.removeEventListener("keyup", this.onKeyUp);
    window.removeEventListener("resize", this.onResize);
    this.canvas?.removeEventListener("pointerdown", this.onPointerDown);
    this.canvas?.removeEventListener("pointermove", this.onPointerMove);
    this.canvas?.removeEventListener("pointerup", this.onPointerUp);
    this.canvas?.removeEventListener("pointercancel", this.onPointerUp);
    this.displayPos.clear();
    this.idColor.clear();
    this.root = undefined;
    this.room = undefined;
    this.canvas = undefined;
    this.g = undefined;
    this.mm = undefined;
    this.mmCtx = undefined;
  }

  // ---- layout (viewport-filling canvas + fixed zoom) ----------------------

  private layout(): void {
    const canvas = this.canvas;
    if (!canvas) return;
    this.cssW = Math.max(240, Math.min(window.innerWidth - 12, 1180));
    this.cssH = Math.max(240, Math.min(window.innerHeight - 132, 820));
    this.dpr = Math.min(2, window.devicePixelRatio || 1);
    canvas.style.width = `${this.cssW}px`;
    canvas.style.height = `${this.cssH}px`;
    canvas.width = Math.round(this.cssW * this.dpr);
    canvas.height = Math.round(this.cssH * this.dpr);
    // Fixed zoom so the camera scrolls; bigger cells on bigger screens.
    this.cell = Math.max(13, Math.min(30, Math.round(Math.min(this.cssW, this.cssH) / 20)));
  }

  // ---- input --------------------------------------------------------------

  private readonly onPointerDown = (e: PointerEvent) => {
    e.preventDefault();
    this.pointerOrigin = { x: e.clientX, y: e.clientY };
    this.pointerNow = { x: e.clientX, y: e.clientY };
    this.canvas?.setPointerCapture?.(e.pointerId);
  };
  private readonly onPointerMove = (e: PointerEvent) => {
    if (!this.pointerOrigin) return;
    e.preventDefault();
    this.pointerNow = { x: e.clientX, y: e.clientY };
    const dx = e.clientX - this.pointerOrigin.x;
    const dy = e.clientY - this.pointerOrigin.y;
    const len = Math.hypot(dx, dy);
    if (len < 10) return; // deadzone: keep the current heading
    this.sendSteer(Math.atan2(dy, dx));
  };
  private readonly onPointerUp = (e: PointerEvent) => {
    this.pointerOrigin = null;
    this.pointerNow = null;
    this.canvas?.releasePointerCapture?.(e.pointerId);
  };

  private steerFromKeys(): void {
    let dx = 0;
    let dy = 0;
    for (const key of this.keys) {
      const v = KEY_VECTORS[key];
      if (v) {
        dx += v[0];
        dy += v[1];
      }
    }
    if (dx === 0 && dy === 0) return;
    this.sendSteer(Math.atan2(dy, dx));
  }

  /** Send a heading at most once per server tick (leading edge + trailing coalesce). */
  private sendSteer(heading: number, force = false): void {
    this.currentHeading = heading;
    this.hasSteered = true;
    if (!force && this.lastSentHeading !== null && Math.abs(heading - this.lastSentHeading) < 1e-4) return;
    const minInterval = 1000 / PAPERIO_TICK_RATE;
    const wait = minInterval - (performance.now() - this.lastSentAt);
    if (force || wait <= 0) {
      this.lastSentHeading = heading;
      this.lastSentAt = performance.now();
      this.room?.send(PaperIoMsg.STEER, { heading });
    } else if (!this.trailingTimer) {
      this.trailingTimer = window.setTimeout(() => {
        this.trailingTimer = 0;
        if (this.currentHeading !== null) this.sendSteer(this.currentHeading);
      }, wait);
    }
  }

  // ---- render loop --------------------------------------------------------

  private frame(now: number): void {
    if (!this.g || !this.room) return;
    const dt = Math.min(0.1, (now - this.lastFrame) / 1000);
    this.lastFrame = now;
    this.resumeAfterRespawn();
    this.draw(dt, now);
    this.raf = requestAnimationFrame((t) => this.frame(t));
  }

  /** Auto-resume movement in the last direction after a respawn. */
  private resumeAfterRespawn(): void {
    const me = this.room?.state.players.get(this.myId) as PaperIoPlayer | undefined;
    if (!me) return;
    const alive = me.alive && !me.dead;
    if (alive && !this.wasAlive && this.hasSteered && this.currentHeading !== null) {
      this.sendSteer(this.currentHeading, true);
    }
    this.wasAlive = alive;
  }

  private colorForId(id: number): Col {
    return this.idColor.get(id) ?? FALLBACK;
  }

  private draw(dt: number, now: number): void {
    const g = this.g!;
    const state = this.room!.state;
    if (!state.cols || !state.rows) return;
    const cell = this.cell;
    const cols = state.cols;
    const rows = state.rows;
    const boardW = cols * cell;
    const boardH = rows * cell;

    // Colour lookup for every live id (humans by seat, bots by spawn seed).
    this.idColor.clear();
    state.players.forEach((p) => this.idColor.set((p as PaperIoPlayer).seat + 1, seatColor((p as PaperIoPlayer).seat)));
    state.bots.forEach((b) => this.idColor.set(b.id, botColor(b.colorSeed)));

    // Interpolate every head toward its server position.
    const lerp = Math.min(1, dt * 14);
    const seen = new Set<string>();
    const updateHead = (key: string, x: number, y: number) => {
      seen.add(key);
      let d = this.displayPos.get(key);
      if (!d) {
        d = { x, y };
        this.displayPos.set(key, d);
        return d;
      }
      if (Math.hypot(x - d.x, y - d.y) > 4) {
        d.x = x;
        d.y = y;
      } else {
        d.x += (x - d.x) * lerp;
        d.y += (y - d.y) * lerp;
      }
      return d;
    };
    state.players.forEach((p, sid) => {
      const pl = p as PaperIoPlayer;
      if (!pl.eliminated) updateHead(`h:${sid}`, pl.x, pl.y);
    });
    state.bots.forEach((b, key) => updateHead(`b:${key}`, b.x, b.y));
    for (const key of this.displayPos.keys()) if (!seen.has(key)) this.displayPos.delete(key);

    // Camera: follow the local head (or the leader once eliminated), clamped.
    const focus = this.cameraFocus(state);
    this.camX = boardW <= this.cssW ? (boardW - this.cssW) / 2 : clamp(focus.x * cell - this.cssW / 2, 0, boardW - this.cssW);
    this.camY = boardH <= this.cssH ? (boardH - this.cssH) / 2 : clamp(focus.y * cell - this.cssH / 2, 0, boardH - this.cssH);

    g.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    g.fillStyle = VOID_BG;
    g.fillRect(0, 0, this.cssW, this.cssH);

    g.save();
    g.translate(-this.camX, -this.camY);
    g.fillStyle = BOARD_BG;
    g.fillRect(0, 0, boardW, boardH);

    // Visible cell window.
    const x0 = Math.max(0, Math.floor(this.camX / cell));
    const x1 = Math.min(cols, Math.ceil((this.camX + this.cssW) / cell));
    const y0 = Math.max(0, Math.floor(this.camY / cell));
    const y1 = Math.min(rows, Math.ceil((this.camY + this.cssH) / cell));

    const grid = state.grid;
    for (let y = y0; y < y1; y++) {
      let i = y * cols + x0;
      for (let x = x0; x < x1; x++, i++) {
        const owner = grid[i]!;
        if (owner === 0) continue;
        g.fillStyle = this.colorForId(owner).land;
        g.fillRect(x * cell, y * cell, cell, cell);
      }
    }

    if (cell >= 10) {
      g.strokeStyle = GRID_LINE;
      g.lineWidth = 1;
      g.beginPath();
      for (let x = x0; x <= x1; x++) {
        g.moveTo(x * cell + 0.5, y0 * cell);
        g.lineTo(x * cell + 0.5, y1 * cell);
      }
      for (let y = y0; y <= y1; y++) {
        g.moveTo(x0 * cell, y * cell + 0.5);
        g.lineTo(x1 * cell, y * cell + 0.5);
      }
      g.stroke();
    }

    // Trails.
    const drawTrail = (trail: ArrayLike<number>, color: string) => {
      g.fillStyle = color;
      for (let k = 0; k < trail.length; k++) {
        const idx = trail[k]!;
        const x = idx % cols;
        const y = (idx / cols) | 0;
        if (x < x0 - 1 || x > x1 || y < y0 - 1 || y > y1) continue;
        g.fillRect(x * cell, y * cell, cell, cell);
      }
    };
    state.players.forEach((p) => {
      const pl = p as PaperIoPlayer;
      if (pl.trail.length) drawTrail(pl.trail, seatColor(pl.seat).trail);
    });
    state.bots.forEach((b) => {
      if (b.trail.length) drawTrail(b.trail, botColor(b.colorSeed).trail);
    });

    // Heads.
    const drawHead = (key: string, id: number, dead: boolean, self: boolean, faded: boolean) => {
      const d = this.displayPos.get(key);
      if (!d) return;
      const col = this.colorForId(id);
      const cx = d.x * cell;
      const cy = d.y * cell;
      const r = Math.max(6, cell * 0.78);
      g.globalAlpha = dead ? 0.35 : faded ? 0.5 : 1;
      g.fillStyle = col.land;
      g.fillRect(cx - r / 2, cy - r / 2, r, r);
      g.fillStyle = col.head;
      g.fillRect(cx - r / 4, cy - r / 4, r / 2, r / 2);
      g.lineWidth = self ? 3 : 1.5;
      g.strokeStyle = self ? "#ffffff" : "#0b0e15";
      g.strokeRect(cx - r / 2, cy - r / 2, r, r);
      g.globalAlpha = 1;
    };
    state.bots.forEach((b, key) => drawHead(`b:${key}`, b.id, b.dead, false, false));
    state.players.forEach((p, sid) => {
      const pl = p as PaperIoPlayer;
      if (!pl.eliminated) drawHead(`h:${sid}`, pl.seat + 1, pl.dead, sid === this.myId, !pl.connected);
    });

    g.restore();

    this.drawHud(g, state);
    this.drawMinimap(g, state, now);
  }

  private cameraFocus(state: PaperIoState): Display {
    const me = state.players.get(this.myId) as PaperIoPlayer | undefined;
    if (me && !me.eliminated) {
      const d = this.displayPos.get(`h:${this.myId}`);
      return d ?? { x: me.x, y: me.y };
    }
    // Spectating: follow the territory leader.
    let best = -1;
    let focus: Display = { x: state.cols / 2, y: state.rows / 2 };
    state.players.forEach((p, sid) => {
      const pl = p as PaperIoPlayer;
      if (!pl.eliminated && pl.cellsOwned > best) {
        best = pl.cellsOwned;
        focus = this.displayPos.get(`h:${sid}`) ?? { x: pl.x, y: pl.y };
      }
    });
    state.bots.forEach((b, key) => {
      if (b.cellsOwned > best) {
        best = b.cellsOwned;
        focus = this.displayPos.get(`b:${key}`) ?? { x: b.x, y: b.y };
      }
    });
    return focus;
  }

  // ---- HUD (screen space) -------------------------------------------------

  private drawHud(g: CanvasRenderingContext2D, state: PaperIoState): void {
    const total = state.cols * state.rows || 1;
    interface Row {
      name: string;
      pct: number;
      col: Col;
      hearts: string;
      tag: string;
      self: boolean;
    }
    const rows: Row[] = [];
    state.players.forEach((p, sid) => {
      const pl = p as PaperIoPlayer;
      rows.push({
        name: pl.nickname,
        pct: (pl.cellsOwned / total) * 100,
        col: seatColor(pl.seat),
        hearts: pl.eliminated ? "—" : "♥".repeat(Math.max(0, pl.lives)),
        tag: pl.eliminated ? " (out)" : !pl.connected ? " (away)" : pl.dead ? " (caught)" : "",
        self: sid === this.myId,
      });
    });
    state.bots.forEach((b) => {
      rows.push({ name: "Bot", pct: (b.cellsOwned / total) * 100, col: botColor(b.colorSeed), hearts: "🤖", tag: "", self: false });
    });
    rows.sort((a, b) => b.pct - a.pct);

    // Top few, and always your own line if you fell out of the top.
    const top = rows.slice(0, 5);
    const meRow = rows.find((r) => r.self);
    if (meRow && !top.includes(meRow)) top.push(meRow);

    g.textAlign = "left";
    g.font = "600 14px system-ui, sans-serif";
    top.forEach((r, i) => {
      const y = 20 + i * 19;
      g.fillStyle = r.col.land;
      g.fillRect(10, y - 11, 12, 12);
      if (r.self) {
        g.strokeStyle = "#ffffff";
        g.lineWidth = 1.5;
        g.strokeRect(10, y - 11, 12, 12);
      }
      g.fillStyle = r.self ? "#ffffff" : "#e8eaf2";
      g.fillText(`${r.name}${r.tag}  ${r.pct.toFixed(1)}%  ${r.hearts}`, 28, y);
    });

    // Win-condition readout, top-right.
    g.textAlign = "right";
    g.fillStyle = "#cfd4e2";
    if (state.winMode === "timed") {
      const left = Math.max(0, Math.ceil((state.endsAt - Date.now()) / 1000));
      g.fillText(`⏱ ${Math.floor(left / 60)}:${String(left % 60).padStart(2, "0")}`, this.cssW - 12, 20);
    } else {
      g.fillText(`🎯 first to ${state.targetPercent}%`, this.cssW - 12, 20);
    }

    // Local status banner.
    const me = state.players.get(this.myId) as PaperIoPlayer | undefined;
    if (me && (me.eliminated || me.dead)) {
      g.textAlign = "center";
      g.font = "700 22px system-ui, sans-serif";
      g.fillStyle = me.eliminated ? "#ff8080" : "#ffd166";
      g.fillText(me.eliminated ? "Out of lives — spectating" : "Caught! Respawning…", this.cssW / 2, this.cssH / 2);
    }
  }

  // ---- minimap (cached offscreen, refreshed a few times a second) ---------

  private drawMinimap(g: CanvasRenderingContext2D, state: PaperIoState, now: number): void {
    const cols = state.cols;
    const rows = state.rows;
    const mm = this.mm!;
    const mmCtx = this.mmCtx!;
    if (mm.width !== cols || mm.height !== rows) {
      mm.width = cols;
      mm.height = rows;
      this.mmLast = 0;
    }
    if (now - this.mmLast > 140) {
      this.mmLast = now;
      mmCtx.fillStyle = "#0d1018";
      mmCtx.fillRect(0, 0, cols, rows);
      const grid = state.grid;
      for (let i = 0; i < grid.length; i++) {
        const owner = grid[i]!;
        if (owner === 0) continue;
        mmCtx.fillStyle = this.colorForId(owner).land;
        mmCtx.fillRect(i % cols, (i / cols) | 0, 1, 1);
      }
    }

    const scale = MINIMAP_MAX / Math.max(cols, rows);
    const w = cols * scale;
    const h = rows * scale;
    const ox = this.cssW - w - 10;
    const oy = this.cssH - h - 10;
    g.globalAlpha = 0.9;
    g.imageSmoothingEnabled = false;
    g.drawImage(mm, ox, oy, w, h);
    g.globalAlpha = 1;
    g.strokeStyle = "#3a425a";
    g.lineWidth = 1;
    g.strokeRect(ox - 0.5, oy - 0.5, w + 1, h + 1);

    // Camera viewport rectangle.
    g.strokeStyle = "rgba(255,255,255,0.6)";
    g.strokeRect(ox + (this.camX / this.cell) * scale, oy + (this.camY / this.cell) * scale, (this.cssW / this.cell) * scale, (this.cssH / this.cell) * scale);

    // Head dots.
    const dot = (key: string, fill: string, self: boolean) => {
      const d = this.displayPos.get(key);
      if (!d) return;
      g.fillStyle = fill;
      g.beginPath();
      g.arc(ox + d.x * scale, oy + d.y * scale, self ? 3 : 2, 0, Math.PI * 2);
      g.fill();
      if (self) {
        g.strokeStyle = "#fff";
        g.lineWidth = 1;
        g.stroke();
      }
    };
    state.bots.forEach((b, key) => dot(`b:${key}`, botColor(b.colorSeed).head, false));
    state.players.forEach((p, sid) => {
      const pl = p as PaperIoPlayer;
      if (!pl.eliminated) dot(`h:${sid}`, sid === this.myId ? "#ffffff" : seatColor(pl.seat).head, sid === this.myId);
    });
  }
}

function clamp(v: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, v));
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

// ---- lobby settings + game summary (registry hooks) ------------------------

export function renderPaperIoLobbySettings(
  container: HTMLElement,
  room: Room<any, BaseState>,
  ctx: LobbySettingsContext
): void {
  const state = room.state as unknown as PaperIoState;
  const host = ctx.isHost;
  const dis = host ? "" : "disabled";

  const boardOpts = BOARD_SIZE_ORDER.map(
    (k) => `<option value="${k}" ${state.boardSize === k ? "selected" : ""}>${BOARD_SIZES[k].label}</option>`
  ).join("");
  const speedOpts = SPEED_ORDER.map(
    (k) => `<option value="${k}" ${state.speed === k ? "selected" : ""}>${SPEEDS[k].label}</option>`
  ).join("");
  const diffOpts = DIFFICULTY_ORDER.map(
    (d) => `<option value="${d}" ${state.botDifficulty === d ? "selected" : ""}>${d[0]!.toUpperCase()}${d.slice(1)}</option>`
  ).join("");
  const winValue =
    state.winMode === "timed"
      ? `${Math.floor(state.timedSeconds / 60)}:${String(state.timedSeconds % 60).padStart(2, "0")}`
      : `${state.targetPercent}%`;

  container.innerHTML = `
    <p class="muted">Paper.io — 1–8 players, one device each (play solo against bots, or together).
      Carve out territory and cut off rivals; first to the target share (or the most land when time's up)
      wins. Bots are smarter, not faster, at higher difficulty, and fresh ones keep dropping in.${host ? "" : " (The host sets the options.)"}</p>
    <div class="pio-settings">
      <label class="pio-row"><span>Board</span>
        <select id="pio-board" class="pio-select" ${dis}>${boardOpts}</select></label>
      <label class="pio-row"><span>Speed</span>
        <select id="pio-speed" class="pio-select" ${dis}>${speedOpts}</select></label>
      <label class="pio-row"><span>Win by</span>
        <select id="pio-winmode" class="pio-select" ${dis}>
          <option value="target" ${state.winMode === "target" ? "selected" : ""}>Territory %</option>
          <option value="timed" ${state.winMode === "timed" ? "selected" : ""}>Timed</option>
        </select></label>
      <div class="pio-row"><span>${state.winMode === "timed" ? "Time limit" : "Target"}</span>
        <span class="pio-stepper">
          <button id="pio-win-minus" class="secondary" ${dis}>−</button>
          <b class="pio-val">${winValue}</b>
          <button id="pio-win-plus" class="secondary" ${dis}>+</button>
        </span></div>
      <div class="pio-row"><span>Player lives</span>
        <span class="pio-stepper">
          <button id="pio-lives-minus" class="secondary" ${dis}>−</button>
          <b class="pio-val">${state.startLives}</b>
          <button id="pio-lives-plus" class="secondary" ${dis}>+</button>
        </span></div>
      <div class="pio-row"><span>Bots</span>
        <span class="pio-stepper">
          <button id="pio-bots-minus" class="secondary" ${dis}>−</button>
          <b class="pio-val">${state.botCount}</b>
          <button id="pio-bots-plus" class="secondary" ${dis}>+</button>
        </span></div>
      <label class="pio-row"><span>Bot difficulty</span>
        <select id="pio-bot-diff" class="pio-select" ${dis}>${diffOpts}</select></label>
    </div>`;

  if (!host) return;
  const send = (patch: Record<string, unknown>) => room.send(PaperIoMsg.CONFIG, patch);
  container.querySelector<HTMLSelectElement>("#pio-board")?.addEventListener("change", (e) =>
    send({ boardSize: (e.target as HTMLSelectElement).value })
  );
  container.querySelector<HTMLSelectElement>("#pio-speed")?.addEventListener("change", (e) =>
    send({ speed: (e.target as HTMLSelectElement).value })
  );
  container.querySelector<HTMLSelectElement>("#pio-winmode")?.addEventListener("change", (e) =>
    send({ winMode: (e.target as HTMLSelectElement).value })
  );
  container.querySelector<HTMLSelectElement>("#pio-bot-diff")?.addEventListener("change", (e) =>
    send({ botDifficulty: (e.target as HTMLSelectElement).value })
  );
  container.querySelector("#pio-win-minus")?.addEventListener("click", () => {
    if (state.winMode === "timed") send({ timedSeconds: Math.max(TIMED_SEC_MIN, state.timedSeconds - TIMED_SEC_STEP) });
    else send({ targetPercent: Math.max(TARGET_PCT_MIN, state.targetPercent - TARGET_PCT_STEP) });
  });
  container.querySelector("#pio-win-plus")?.addEventListener("click", () => {
    if (state.winMode === "timed") send({ timedSeconds: Math.min(TIMED_SEC_MAX, state.timedSeconds + TIMED_SEC_STEP) });
    else send({ targetPercent: Math.min(TARGET_PCT_MAX, state.targetPercent + TARGET_PCT_STEP) });
  });
  container.querySelector("#pio-lives-minus")?.addEventListener("click", () =>
    send({ lives: Math.max(LIVES_MIN, state.startLives - 1) })
  );
  container.querySelector("#pio-lives-plus")?.addEventListener("click", () =>
    send({ lives: Math.min(LIVES_MAX, state.startLives + 1) })
  );
  container.querySelector("#pio-bots-minus")?.addEventListener("click", () =>
    send({ botCount: Math.max(BOT_COUNT_MIN, state.botCount - 1) })
  );
  container.querySelector("#pio-bots-plus")?.addEventListener("click", () =>
    send({ botCount: Math.min(BOT_COUNT_MAX, state.botCount + 1) })
  );
}

const OUTCOME_TITLE: Record<string, (name: string) => string> = {
  target: (n) => `${n} wins! 👑`,
  last_human: (n) => `${n} is the last one standing! 👑`,
  timed: (n) => `Time's up — ${n} leads! 👑`,
  bot_takeover: () => "A bot took over the board 🤖",
  wipeout: () => "Wiped out — the bots took the board",
  draw: () => "It's a draw",
};

export function renderPaperIoGameSummary(
  container: HTMLElement,
  room: Room<any, BaseState>,
  _ctx: GameViewContext
): void {
  const state = room.state as unknown as PaperIoState;
  const total = state.cols * state.rows || 1;
  const players = [...state.players.values()] as PaperIoPlayer[];
  if (players.length === 0) return;

  let winnerSeat: number | null = null;
  if (state.endReason.startsWith(EndReason.WIN_PREFIX)) {
    winnerSeat = Number(state.endReason.slice(EndReason.WIN_PREFIX.length));
  }
  const winner = players.find((p) => p.seat === winnerSeat);
  const title = (OUTCOME_TITLE[state.outcome] ?? OUTCOME_TITLE.draw!)(winner ? escapeHtml(winner.nickname) : "Nobody");

  players.sort((a, b) => b.cellsOwned - a.cellsOwned || a.seat - b.seat);
  const rows = players
    .map((p) => {
      const pct = ((p.cellsOwned / total) * 100).toFixed(1);
      const crown = p.seat === winnerSeat ? " 👑" : "";
      return `<tr>
        <td><span class="pio-swatch" style="background:${seatColor(p.seat).land}"></span>${escapeHtml(p.nickname)}${crown}</td>
        <td class="pio-num">${pct}%</td>
        <td class="pio-num">${p.eliminated ? "out" : "♥" + Math.max(0, p.lives)}</td>
      </tr>`;
    })
    .join("");
  container.innerHTML = `
    <p class="pio-outcome">${title}</p>
    <table class="pio-summary">
      <thead><tr><th>Player</th><th class="pio-num">Land</th><th class="pio-num">Lives</th></tr></thead>
      <tbody>${rows}</tbody>
    </table>`;
}
