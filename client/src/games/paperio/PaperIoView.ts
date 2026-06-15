/**
 * Paper.io view - real-time canvas UI. The whole (small) board is drawn at
 * once: territory from state.grid, each player's trail, and the heads. Heads
 * are interpolated toward their server position (state arrives ~20x/second),
 * like Dot Arena. Input is free-angle: drag (pointer/touch) or arrow keys /
 * WASD set a heading, sent only when it changes and throttled to the tick rate
 * (a touch drag fires far faster than the server consumes it).
 */
import type { Room } from "@colyseus/sdk";
import {
  type BaseState,
  BOARD_SIZE_ORDER,
  BOARD_SIZES,
  DIFFICULTY_ORDER,
  EndReason,
  LobbyMsg,
  LIVES_MAX,
  LIVES_MIN,
  PAPERIO_TICK_RATE,
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

interface SeatColor {
  land: string;
  trail: string;
  head: string;
}
/** A distinct land/trail/head triple per seat (0..7). */
const SEAT_COLORS: SeatColor[] = [
  { land: "#e0455e", trail: "#ff90a3", head: "#ffd6dd" },
  { land: "#3f7fe0", trail: "#8fbcff", head: "#d6e6ff" },
  { land: "#2fae74", trail: "#7fe3b6", head: "#d4f6e6" },
  { land: "#d9a233", trail: "#ffd47a", head: "#fff0cf" },
  { land: "#9b5de0", trail: "#cfa3ff", head: "#ecdcff" },
  { land: "#27b3c0", trail: "#84e3ec", head: "#d3f6fa" },
  { land: "#e07a3f", trail: "#ffb98f", head: "#ffe5d4" },
  { land: "#6b7280", trail: "#b6bcc9", head: "#e4e7ee" },
];
function seatColor(seat: number): SeatColor {
  return SEAT_COLORS[seat % SEAT_COLORS.length]!;
}

const BOARD_BG = "#161b29";
const GRID_LINE = "#222a3d";
const VOID_BG = "#0c0e15";

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
  private cell = 12;
  private displayPos = new Map<string, Display>();

  // Input
  private keys = new Set<string>();
  private pointerOrigin: { x: number; y: number } | null = null;
  private joyVec: { x: number; y: number } | null = null;
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
    this.keys.delete(e.key);
    // No "stop" in paper.io: releasing keys keeps your current heading.
  };
  private readonly onResize = () => this.layout();

  mount(root: HTMLElement, room: Room<any, BaseState>, ctx: GameViewContext): void {
    this.root = root;
    this.room = room as unknown as Room<any, PaperIoState>;
    this.myId = ctx.mySessionId;

    root.innerHTML = `
      <div class="pio-wrap">
        <canvas id="pio-canvas"></canvas>
        <p class="center muted pio-hint">Drag anywhere (or use arrow keys / WASD) to steer.
          Close a loop to claim land; don't cross a trail.</p>
      </div>`;
    this.canvas = root.querySelector<HTMLCanvasElement>("#pio-canvas")!;
    this.g = this.canvas.getContext("2d") ?? undefined;
    this.layout();

    window.addEventListener("keydown", this.onKeyDown);
    window.addEventListener("keyup", this.onKeyUp);
    window.addEventListener("resize", this.onResize);

    // Pointer events cover mouse, touch and pen: press to set the joystick
    // origin, drag to steer in that direction.
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
    this.root = undefined;
    this.room = undefined;
    this.canvas = undefined;
    this.g = undefined;
  }

  // ---- layout -------------------------------------------------------------

  private layout(): void {
    const state = this.room?.state;
    const canvas = this.canvas;
    if (!state || !canvas || !state.cols || !state.rows) return;
    const maxW = Math.min(window.innerWidth - 24, 1040);
    const maxH = Math.min(window.innerHeight - 210, 700);
    this.cell = Math.max(5, Math.min(22, Math.floor(Math.min(maxW / state.cols, maxH / state.rows))));
    canvas.width = state.cols * this.cell;
    canvas.height = state.rows * this.cell;
  }

  // ---- input --------------------------------------------------------------

  private readonly onPointerDown = (e: PointerEvent) => {
    e.preventDefault();
    this.pointerOrigin = { x: e.clientX, y: e.clientY };
    this.canvas?.setPointerCapture?.(e.pointerId);
  };
  private readonly onPointerMove = (e: PointerEvent) => {
    if (!this.pointerOrigin) return;
    e.preventDefault();
    const dx = e.clientX - this.pointerOrigin.x;
    const dy = e.clientY - this.pointerOrigin.y;
    const len = Math.hypot(dx, dy);
    const DEADZONE = 10;
    if (len < DEADZONE) return; // stay near the origin = keep current heading
    this.joyVec = { x: dx / len, y: dy / len };
    this.sendSteer(Math.atan2(dy, dx));
  };
  private readonly onPointerUp = (e: PointerEvent) => {
    this.pointerOrigin = null;
    this.joyVec = null;
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

  private draw(dt: number, now: number): void {
    const g = this.g!;
    const state = this.room!.state;
    const canvas = this.canvas!;
    if (!state.cols || !state.rows) return;
    if (canvas.width !== state.cols * this.cell) this.layout();
    const cell = this.cell;
    const cols = state.cols;

    g.fillStyle = VOID_BG;
    g.fillRect(0, 0, canvas.width, canvas.height);
    g.fillStyle = BOARD_BG;
    g.fillRect(0, 0, canvas.width, canvas.height);

    // Territory.
    const grid = state.grid;
    for (let i = 0; i < grid.length; i++) {
      const owner = grid[i]!;
      if (owner === 0) continue;
      const x = i % cols;
      const y = (i / cols) | 0;
      g.fillStyle = seatColor(owner - 1).land;
      g.fillRect(x * cell, y * cell, cell, cell);
    }

    // Grid lines (only when cells are big enough to be worth it).
    if (cell >= 9) {
      g.strokeStyle = GRID_LINE;
      g.lineWidth = 1;
      g.beginPath();
      for (let x = 0; x <= cols; x++) {
        g.moveTo(x * cell + 0.5, 0);
        g.lineTo(x * cell + 0.5, canvas.height);
      }
      for (let y = 0; y <= state.rows; y++) {
        g.moveTo(0, y * cell + 0.5);
        g.lineTo(canvas.width, y * cell + 0.5);
      }
      g.stroke();
    }

    // Trails.
    state.players.forEach((player) => {
      const p = player as PaperIoPlayer;
      if (p.trail.length === 0) return;
      g.fillStyle = seatColor(p.seat).trail;
      p.trail.forEach((idx) => {
        const x = idx % cols;
        const y = (idx / cols) | 0;
        g.fillRect(x * cell, y * cell, cell, cell);
      });
    });

    // Heads (interpolated).
    const seen = new Set<string>();
    const lerp = Math.min(1, dt * 14);
    state.players.forEach((player, sessionId) => {
      const p = player as PaperIoPlayer;
      seen.add(sessionId);
      if (p.eliminated) return;
      let d = this.displayPos.get(sessionId);
      if (!d) {
        d = { x: p.x, y: p.y };
        this.displayPos.set(sessionId, d);
      }
      // Snap on a big jump (respawn / fresh round), otherwise glide.
      if (Math.hypot(p.x - d.x, p.y - d.y) > 4) {
        d.x = p.x;
        d.y = p.y;
      } else {
        d.x += (p.x - d.x) * lerp;
        d.y += (p.y - d.y) * lerp;
      }
      const col = seatColor(p.seat);
      const cx = d.x * cell;
      const cy = d.y * cell;
      const r = Math.max(4, cell * 0.7);
      g.globalAlpha = p.dead ? 0.35 : p.connected ? 1 : 0.5;
      g.fillStyle = col.land;
      g.fillRect(cx - r / 2, cy - r / 2, r, r);
      g.fillStyle = col.head;
      g.fillRect(cx - r / 4, cy - r / 4, r / 2, r / 2);
      g.lineWidth = sessionId === this.myId ? 3 : 1.5;
      g.strokeStyle = sessionId === this.myId ? "#ffffff" : "#0b0e15";
      g.strokeRect(cx - r / 2, cy - r / 2, r, r);
      g.globalAlpha = 1;
    });
    for (const id of this.displayPos.keys()) if (!seen.has(id)) this.displayPos.delete(id);

    this.drawHud(g, state, now);
  }

  private drawHud(g: CanvasRenderingContext2D, state: PaperIoState, now: number): void {
    const total = state.cols * state.rows || 1;
    const players: PaperIoPlayer[] = [];
    state.players.forEach((p) => players.push(p as PaperIoPlayer));
    players.sort((a, b) => b.cellsOwned - a.cellsOwned || a.seat - b.seat);

    g.textAlign = "left";
    g.font = "600 14px system-ui, sans-serif";
    players.forEach((p, i) => {
      const pct = ((p.cellsOwned / total) * 100).toFixed(1);
      const col = seatColor(p.seat);
      const y = 20 + i * 19;
      g.fillStyle = col.land;
      g.fillRect(10, y - 11, 12, 12);
      g.fillStyle = "#e8eaf2";
      const hearts = p.eliminated ? "—" : "♥".repeat(Math.max(0, p.lives));
      const tag = p.eliminated ? " (out)" : !p.connected ? " (away)" : p.dead ? " (caught)" : "";
      g.fillText(`${p.nickname}${tag}  ${pct}%  ${hearts}`, 28, y);
    });

    // Win condition readout, top-right.
    g.textAlign = "right";
    g.font = "600 14px system-ui, sans-serif";
    g.fillStyle = "#cfd4e2";
    const w = this.canvas!.width;
    if (state.winMode === "timed") {
      const left = Math.max(0, Math.ceil((state.endsAt - Date.now()) / 1000));
      const m = Math.floor(left / 60);
      const s = left % 60;
      g.fillText(`⏱ ${m}:${String(s).padStart(2, "0")}`, w - 10, 20);
    } else {
      g.fillText(`🎯 first to ${state.targetPercent}%`, w - 10, 20);
    }

    // Local status banner.
    const me = state.players.get(this.myId) as PaperIoPlayer | undefined;
    if (me && (me.eliminated || me.dead)) {
      g.textAlign = "center";
      g.font = "700 22px system-ui, sans-serif";
      g.fillStyle = me.eliminated ? "#ff8080" : "#ffd166";
      const msg = me.eliminated ? "Out of lives — spectating" : "Caught! Respawning…";
      g.fillText(msg, this.canvas!.width / 2, this.canvas!.height / 2);
    }
    void now;
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

// ---- lobby settings + game summary (registry hooks) ------------------------

export function renderPaperIoLobbySettings(
  container: HTMLElement,
  room: Room<any, BaseState>,
  ctx: LobbySettingsContext
): void {
  const state = room.state as unknown as PaperIoState;
  const host = ctx.isHost;
  const dis = host ? "" : "disabled";
  const seatsLeft = (state.maxPlayers || 8) - state.players.size;

  const boardOpts = BOARD_SIZE_ORDER.map(
    (k) => `<option value="${k}" ${state.boardSize === k ? "selected" : ""}>${BOARD_SIZES[k].label}</option>`
  ).join("");
  const speedOpts = SPEED_ORDER.map(
    (k) => `<option value="${k}" ${state.speed === k ? "selected" : ""}>${SPEEDS[k].label}</option>`
  ).join("");
  const winValue =
    state.winMode === "timed"
      ? `${Math.floor(state.timedSeconds / 60)}:${String(state.timedSeconds % 60).padStart(2, "0")}`
      : `${state.targetPercent}%`;

  const addBot = host
    ? `<div class="pio-row">
         <select id="pio-bot-diff" class="pio-select" title="AI difficulty">
           ${DIFFICULTY_ORDER.map((d) => `<option value="${d}"${d === "normal" ? " selected" : ""}>${d[0]!.toUpperCase()}${d.slice(1)}</option>`).join("")}
         </select>
         <button id="pio-add-bot" class="secondary" ${seatsLeft > 0 ? "" : "disabled"}>➕ Add AI 🤖</button>
       </div>`
    : "";

  container.innerHTML = `
    <p class="muted">Paper.io — 2–8 players, one device each. Carve out territory and cut off
      rivals; first to the target share (or the most land when time's up) wins. Bots are smarter,
      not faster, at higher difficulty.${host ? "" : " (The host sets the options.)"}</p>
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
      <div class="pio-row"><span>Lives</span>
        <span class="pio-stepper">
          <button id="pio-lives-minus" class="secondary" ${dis}>−</button>
          <b class="pio-val">${state.startLives}</b>
          <button id="pio-lives-plus" class="secondary" ${dis}>+</button>
        </span></div>
    </div>
    ${addBot}`;

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
  container.querySelector<HTMLButtonElement>("#pio-add-bot")?.addEventListener("click", () => {
    const difficulty = container.querySelector<HTMLSelectElement>("#pio-bot-diff")?.value ?? "normal";
    room.send(LobbyMsg.ADD_BOT, { difficulty });
  });
}

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
  players.sort((a, b) => b.cellsOwned - a.cellsOwned || a.seat - b.seat);
  const rows = players
    .map((p) => {
      const pct = ((p.cellsOwned / total) * 100).toFixed(1);
      const crown = p.seat === winnerSeat ? " 👑" : "";
      const col = seatColor(p.seat);
      return `<tr>
        <td><span class="pio-swatch" style="background:${col.land}"></span>${escapeHtml(p.nickname)}${crown}</td>
        <td class="pio-num">${pct}%</td>
        <td class="pio-num">${p.eliminated ? "out" : "♥" + Math.max(0, p.lives)}</td>
      </tr>`;
    })
    .join("");
  container.innerHTML = `
    <table class="pio-summary">
      <thead><tr><th>Player</th><th class="pio-num">Land</th><th class="pio-num">Lives</th></tr></thead>
      <tbody>${rows}</tbody>
    </table>`;
}
