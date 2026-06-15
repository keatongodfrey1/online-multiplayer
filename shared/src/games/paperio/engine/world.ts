/**
 * Paper.io world - the pure simulation ported from the source game's sim.js.
 *
 * Owns the grid, the actors, free-angle movement, flood-fill territory
 * claiming, trail collisions, connectivity pruning, deaths/respawns/
 * eliminations, bot AI, and win detection. It has NO Colyseus/DOM/timer
 * dependencies: time is advanced by step(dt) and randomness comes from a
 * seeded RNG, so it is fully deterministic and unit-testable on its own.
 *
 * Actor model:
 *  - HUMANS are framework players (seats 0..7, grid id = seat+1) with a
 *    configurable number of lives. On death they respawn keeping their land;
 *    at zero lives they're eliminated and their land freed.
 *  - BOTS are engine-owned and dynamic: ids come from a pool above the human
 *    range, each has ONE life, and a fresh colour seed. The engine keeps the
 *    population topped up to `botCount` throughout the round (spawning a new
 *    bot at a random open patch on a timer), capped once a leader dominates.
 *
 * Movement: free-angle continuous for humans; bots grid-step but at the SAME
 * cell speed (a movement budget) - difficulty changes how bots play, never how
 * fast they move ("smarter, not faster").
 */
import {
  BOT_ID_BASE,
  DEATH_MS,
  DIFFICULTIES,
  SELF_GRACE,
  SPAWN_CAP_SHARE,
  SPAWN_INTERVAL_MS,
  START_BLOCK,
  TURN_RATE,
} from "./constants.js";
import { mulberry32 } from "./rng.js";
import type {
  Actor,
  BotAI,
  BotDifficulty,
  EndResult,
  GameEvent,
  Outcome,
  WorldOptions,
} from "./types.js";

const EMPTY = 0;

export class PaperIoWorld {
  readonly cols: number;
  readonly rows: number;
  readonly totalCells: number;
  readonly speedCellsPerSec: number;
  readonly winMode: WorldOptions["winMode"];
  readonly targetThreshold: number;
  readonly timedLimitMs: number;
  readonly humanLives: number;
  readonly botCount: number;
  readonly botDifficulty: BotDifficulty;
  readonly maxBots: number;

  /** Owner value per cell (actor.id, or 0). Flat, row-major (y * cols + x). */
  readonly grid: Int16Array;
  /** Per-id territory counts, kept up to date by setCell. Index = actor.id. */
  private readonly counts: Int32Array;
  /** Cells whose owner changed since the last drainDirty(); for schema sync. */
  readonly dirty = new Set<number>();
  /** Trail ownership across the whole board: packed cell index -> actor.id. */
  private readonly trailOwner = new Map<number, number>();

  /** Human actors (stable for the round; eliminated ones stay flagged). */
  readonly humans: Actor[] = [];
  /** Live bots (added on spawn, removed on elimination). */
  readonly bots: Actor[] = [];
  /** Sparse, indexed by human seat. */
  private readonly bySeatArr: (Actor | undefined)[] = [];
  /** Sparse, indexed by id. */
  private readonly byIdArr: (Actor | undefined)[] = [];

  /** Available bot ids (a pool above the human range). */
  private readonly freeBotIds: number[] = [];
  private nextColorSeed = 0;
  private spawnAccumMs = 0;

  elapsedMs = 0;
  ended = false;
  endResult: EndResult | null = null;
  private events: GameEvent[] = [];

  private readonly rng: () => number;
  private readonly outside: Uint8Array;
  private readonly comp: Int32Array;

  constructor(opts: WorldOptions, seed: number) {
    this.cols = opts.cols;
    this.rows = opts.rows;
    this.totalCells = opts.cols * opts.rows;
    this.speedCellsPerSec = opts.speedCellsPerSec;
    this.winMode = opts.winMode;
    this.targetThreshold = opts.targetThreshold;
    this.timedLimitMs = opts.timedLimitMs;
    this.humanLives = opts.humanLives;
    this.botCount = Math.max(0, Math.min(opts.botCount, opts.maxBots));
    this.botDifficulty = opts.botDifficulty;
    this.maxBots = opts.maxBots;
    this.rng = mulberry32(seed >>> 0);

    this.grid = new Int16Array(this.totalCells);
    this.outside = new Uint8Array(this.totalCells);
    this.comp = new Int32Array(this.totalCells);

    // ids: humans 1..8, bots [BOT_ID_BASE, BOT_ID_BASE + maxBots).
    this.counts = new Int32Array(BOT_ID_BASE + this.maxBots);
    for (let id = BOT_ID_BASE + this.maxBots - 1; id >= BOT_ID_BASE; id--) this.freeBotIds.push(id);

    this.build(opts);
  }

  // ---- geometry helpers ---------------------------------------------------

  key(x: number, y: number): number {
    return y * this.cols + x;
  }
  inBounds(x: number, y: number): boolean {
    return x >= 0 && x < this.cols && y >= 0 && y < this.rows;
  }
  actorBySeat(seat: number): Actor | undefined {
    return this.bySeatArr[seat];
  }
  private byId(id: number): Actor | undefined {
    return this.byIdArr[id];
  }
  /** Every live actor (humans + live bots). Allocates - not for the hot path. */
  private allActors(): Actor[] {
    return this.humans.concat(this.bots);
  }
  territoryOf(seat: number): number {
    return this.counts[seat + 1] ?? 0;
  }
  territoryOfId(id: number): number {
    return this.counts[id] ?? 0;
  }

  /** Write a cell, keeping per-id counts and the dirty set in sync. */
  setCell(idx: number, id: number): void {
    const old = this.grid[idx]!;
    if (old === id) return;
    if (old !== EMPTY) this.counts[old]!--;
    if (id !== EMPTY) this.counts[id]!++;
    this.grid[idx] = id;
    this.dirty.add(idx);
  }

  // ---- test / setup helpers (keep counts + trail bookkeeping consistent) ----

  /** Wipe the board to empty and clear every actor's trail. */
  clearBoard(): void {
    for (let i = 0; i < this.totalCells; i++) this.setCell(i, EMPTY);
    this.trailOwner.clear();
    for (const a of this.allActors()) {
      a.trail = [];
      a.trailSet.clear();
      a.recent = [];
    }
  }

  /** Fill an inclusive rectangle with an owner id. */
  fillRect(id: number, x0: number, y0: number, x1: number, y1: number): void {
    for (let y = y0; y <= y1; y++)
      for (let x = x0; x <= x1; x++) if (this.inBounds(x, y)) this.setCell(this.key(x, y), id);
  }

  /** Lay one trail cell for an actor, as if it had walked there. */
  addTrailCell(a: Actor, x: number, y: number): void {
    const k = this.key(x, y);
    a.trail.push(k);
    a.trailSet.add(k);
    this.trailOwner.set(k, a.id);
    a.recent.push(k);
    if (a.recent.length > SELF_GRACE) a.recent.shift();
  }

  emit(e: GameEvent): void {
    this.events.push(e);
  }
  drainEvents(): GameEvent[] {
    const e = this.events;
    this.events = [];
    return e;
  }

  // ---- world setup --------------------------------------------------------

  private build(opts: WorldOptions): void {
    const initialBots = Math.min(this.botCount, this.maxBots);
    const homes = this.regionHomes(opts.humans.length + initialBots);
    opts.humans.forEach((cfg, i) => {
      const home = homes[i]!;
      const a = this.makeActor(cfg.seat + 1, cfg.seat, false, "normal", this.humanLives, cfg.seat, home.x, home.y);
      this.humans.push(a);
      this.bySeatArr[a.seat] = a;
      this.byIdArr[a.id] = a;
      this.stampHome(a);
    });
    for (let i = 0; i < initialBots; i++) {
      this.spawnBot(homes[opts.humans.length + i]);
    }
  }

  private makeActor(
    id: number,
    seat: number,
    isBot: boolean,
    difficulty: BotDifficulty,
    lives: number,
    colorSeed: number,
    hx: number,
    hy: number
  ): Actor {
    return {
      seat,
      id,
      isBot,
      difficulty,
      colorSeed,
      alive: true,
      dead: false,
      eliminated: false,
      deadUntilMs: 0,
      lives,
      frozen: false,
      x: hx,
      y: hy,
      fx: hx + 0.5,
      fy: hy + 0.5,
      heading: 0,
      targetHeading: 0,
      moving: false,
      dx: 0,
      dy: 0,
      botBudget: 0,
      homeCx: hx,
      homeCy: hy,
      trail: [],
      trailSet: new Set(),
      recent: [],
      ai: { mode: "rest" },
    };
  }

  /** Spawn one bot (1 life, fresh colour) at a given or random open home. */
  private spawnBot(home?: { x: number; y: number }): Actor | null {
    if (this.freeBotIds.length === 0) return null;
    const spot = home ?? this.findFreeHome();
    if (!spot) return null;
    const id = this.freeBotIds.pop()!;
    const colorSeed = this.nextColorSeed++ & 0xffff;
    const a = this.makeActor(id, -1, true, this.botDifficulty, 1, colorSeed, spot.x, spot.y);
    this.bots.push(a);
    this.byIdArr[id] = a;
    this.stampHome(a);
    this.emit({ type: "spawn", id });
    return a;
  }

  /** Spread starting homes across a shuffled grid of regions so nobody clumps. */
  private regionHomes(n: number): { x: number; y: number }[] {
    const pad = ((START_BLOCK / 2) | 0) + 2;
    const gx = Math.ceil(Math.sqrt(n));
    const gy = Math.ceil(n / gx);
    const regions: { rx: number; ry: number }[] = [];
    for (let ry = 0; ry < gy; ry++) for (let rx = 0; rx < gx; rx++) regions.push({ rx, ry });
    for (let i = regions.length - 1; i > 0; i--) {
      const j = (this.rng() * (i + 1)) | 0;
      const t = regions[i]!;
      regions[i] = regions[j]!;
      regions[j] = t;
    }
    const cellW = (this.cols - 2 * pad) / gx;
    const cellH = (this.rows - 2 * pad) / gy;
    const homes: { x: number; y: number }[] = [];
    for (let i = 0; i < n; i++) {
      const r = regions[i]!;
      const x = Math.round(pad + r.rx * cellW + cellW * (0.25 + 0.5 * this.rng()));
      const y = Math.round(pad + r.ry * cellH + cellH * (0.25 + 0.5 * this.rng()));
      homes.push({
        x: Math.max(pad, Math.min(this.cols - 1 - pad, x)),
        y: Math.max(pad, Math.min(this.rows - 1 - pad, y)),
      });
    }
    return homes;
  }

  private stampHome(a: Actor): void {
    const r = (START_BLOCK / 2) | 0;
    for (let y = a.homeCy - r; y <= a.homeCy + r; y++)
      for (let x = a.homeCx - r; x <= a.homeCx + r; x++)
        if (this.inBounds(x, y)) this.setCell(this.key(x, y), a.id);
  }

  /** Find an empty patch big enough for a fresh home; null if the board is full. */
  private findFreeHome(): { x: number; y: number } | null {
    const r = (START_BLOCK / 2) | 0;
    const pad = r + 1;
    for (let t = 0; t < 80; t++) {
      const x = pad + ((this.rng() * (this.cols - 2 * pad)) | 0);
      const y = pad + ((this.rng() * (this.rows - 2 * pad)) | 0);
      let ok = true;
      for (let yy = y - r; yy <= y + r && ok; yy++)
        for (let xx = x - r; xx <= x + r; xx++) {
          if (!this.inBounds(xx, yy) || this.grid[this.key(xx, yy)] !== EMPTY || this.trailOwner.has(this.key(xx, yy))) {
            ok = false;
            break;
          }
        }
      if (ok) return { x, y };
    }
    return null;
  }

  // ---- input --------------------------------------------------------------

  /** Aim a (human) actor toward a heading in radians; first input starts it. */
  steer(seat: number, angle: number): void {
    const a = this.bySeatArr[seat];
    if (!a || !a.alive || a.dead) return;
    a.targetHeading = angle;
    if (!a.moving) {
      a.moving = true;
      a.heading = angle;
    }
  }

  // ---- movement -----------------------------------------------------------

  /**
   * Actor `a` enters grid cell (cx,cy). Returns false if it can't keep moving
   * this step (it died, or the game ended).
   */
  enterCell(a: Actor, cx: number, cy: number): boolean {
    const k = this.key(cx, cy);
    const owner = this.trailOwner.get(k);
    if (owner !== undefined) {
      if (owner === a.id) {
        if (a.recent.indexOf(k) !== -1) return true; // grace: just-laid trail behind the head
        this.killActor(a, null); // crossed your own older trail
        return false;
      }
      const victim = this.byId(owner);
      if (victim) this.killActor(victim, a); // cut a rival's trail
      if (this.ended) return false;
    }
    if (this.grid[k] === a.id) {
      if (a.trail.length > 0) this.claimFor(a);
      return !this.ended;
    }
    a.trail.push(k);
    a.trailSet.add(k);
    this.trailOwner.set(k, a.id);
    a.recent.push(k);
    if (a.recent.length > SELF_GRACE) a.recent.shift();
    return !this.ended;
  }

  /** Bots: grid-step one cell at a time. */
  private moveActorBot(a: Actor): void {
    if (a.dx === 0 && a.dy === 0) return;
    const nx = a.x + a.dx;
    const ny = a.y + a.dy;
    if (!this.inBounds(nx, ny)) {
      a.ai.mode = "home";
      const h = this.homeStep(a);
      a.dx = h[0];
      a.dy = h[1];
      return;
    }
    a.x = nx;
    a.y = ny;
    this.enterCell(a, nx, ny);
  }

  /**
   * Continuous (human) movement: the heading curves toward the target and the
   * head paints its trail cell-by-cell (4-connected, no corner gaps).
   */
  moveContinuous(a: Actor, dt: number): void {
    if (!a.moving || a.dead || a.frozen) return;
    let dh = a.targetHeading - a.heading;
    while (dh > Math.PI) dh -= 2 * Math.PI;
    while (dh < -Math.PI) dh += 2 * Math.PI;
    const maxTurn = TURN_RATE * dt;
    a.heading += Math.max(-maxTurn, Math.min(maxTurn, dh));
    const sp = this.speedCellsPerSec * dt;
    const nx = Math.max(0.001, Math.min(this.cols - 0.001, a.fx + Math.cos(a.heading) * sp));
    const ny = Math.max(0.001, Math.min(this.rows - 0.001, a.fy + Math.sin(a.heading) * sp));
    const segX = nx - a.fx;
    const segY = ny - a.fy;
    const steps = Math.max(1, Math.ceil(Math.hypot(segX, segY) / 0.34));
    let curCx = Math.floor(a.fx);
    let curCy = Math.floor(a.fy);
    for (let i = 1; i <= steps; i++) {
      const t = i / steps;
      const cx = Math.floor(a.fx + segX * t);
      const cy = Math.floor(a.fy + segY * t);
      if (cx === curCx && cy === curCy) continue;
      if (cx !== curCx && cy !== curCy && this.inBounds(cx, curCy)) {
        // 4-connect across a diagonal corner
        a.x = cx;
        a.y = curCy;
        if (!this.enterCell(a, cx, curCy)) return;
      }
      curCx = cx;
      curCy = cy;
      if (this.inBounds(cx, cy)) {
        a.x = cx;
        a.y = cy;
        if (!this.enterCell(a, cx, cy)) return;
      }
    }
    a.fx = nx;
    a.fy = ny;
    a.x = Math.floor(nx);
    a.y = Math.floor(ny);
  }

  // ---- claim + prune ------------------------------------------------------

  private floodSeed(x: number, y: number, aId: number, stack: number[]): void {
    if (!this.inBounds(x, y)) return;
    const idx = this.key(x, y);
    if (this.outside[idx] || this.grid[idx] === aId) return;
    this.outside[idx] = 1;
    stack.push(idx);
  }

  /** Close a loop: solidify the trail, then capture everything it enclosed. */
  claimFor(a: Actor): void {
    for (const idx of a.trail) {
      this.setCell(idx, a.id);
      this.trailOwner.delete(idx);
    }
    const outside = this.outside;
    outside.fill(0);
    const stack: number[] = [];
    for (let x = 0; x < this.cols; x++) {
      this.floodSeed(x, 0, a.id, stack);
      this.floodSeed(x, this.rows - 1, a.id, stack);
    }
    for (let y = 0; y < this.rows; y++) {
      this.floodSeed(0, y, a.id, stack);
      this.floodSeed(this.cols - 1, y, a.id, stack);
    }
    while (stack.length) {
      const idx = stack.pop()!;
      const x = idx % this.cols;
      const y = (idx / this.cols) | 0;
      this.floodSeed(x + 1, y, a.id, stack);
      this.floodSeed(x - 1, y, a.id, stack);
      this.floodSeed(x, y + 1, a.id, stack);
      this.floodSeed(x, y - 1, a.id, stack);
    }
    const captured: number[] = [];
    const affected = new Set<number>();
    for (let idx = 0; idx < this.totalCells; idx++) {
      if (this.grid[idx] !== a.id && !outside[idx]) {
        const prev = this.grid[idx]!;
        if (prev !== EMPTY) affected.add(prev);
        this.setCell(idx, a.id);
        captured.push(idx);
      }
    }
    this.emit({ type: "claim", id: a.id });
    if (a.isBot) {
      a.homeCx = a.x;
      a.homeCy = a.y;
      a.ai = { mode: "rest" };
    }
    a.trail = [];
    a.trailSet.clear();
    a.recent = [];
    // Anyone whose head we just enclosed is cut off from their land - caught.
    const capSet = new Set(captured);
    for (const o of this.allActors()) {
      if (o === a || !o.alive || o.dead || o.eliminated) continue;
      if (capSet.has(this.key(o.x, o.y))) this.killActor(o, a);
    }
    for (const oid of affected) {
      const o = this.byId(oid);
      if (o && o.alive && !o.eliminated) this.pruneTerritory(o);
    }
    this.checkEnd(a);
  }

  /** Keep only ONE connected blob of an actor's land (under its head, else the largest). */
  pruneTerritory(a: Actor): void {
    const { cols, rows, grid, comp } = this;
    const id = a.id;
    comp.fill(-1);
    const sizes: number[] = [];
    let nc = 0;
    for (let y = 0; y < rows; y++)
      for (let x = 0; x < cols; x++) {
        const start = y * cols + x;
        if (grid[start] !== id || comp[start] !== -1) continue;
        let sz = 0;
        const st = [start];
        comp[start] = nc;
        while (st.length) {
          const idx = st.pop()!;
          sz++;
          const cx = idx % cols;
          const cy = (idx / cols) | 0;
          if (cx + 1 < cols && grid[idx + 1] === id && comp[idx + 1] === -1) {
            comp[idx + 1] = nc;
            st.push(idx + 1);
          }
          if (cx - 1 >= 0 && grid[idx - 1] === id && comp[idx - 1] === -1) {
            comp[idx - 1] = nc;
            st.push(idx - 1);
          }
          if (cy + 1 < rows && grid[idx + cols] === id && comp[idx + cols] === -1) {
            comp[idx + cols] = nc;
            st.push(idx + cols);
          }
          if (cy - 1 >= 0 && grid[idx - cols] === id && comp[idx - cols] === -1) {
            comp[idx - cols] = nc;
            st.push(idx - cols);
          }
        }
        sizes.push(sz);
        nc++;
      }
    if (nc <= 1) return;
    let keep: number;
    const headIdx = this.key(a.x, a.y);
    if (grid[headIdx] === id) keep = comp[headIdx]!;
    else {
      keep = 0;
      for (let i = 1; i < nc; i++) if (sizes[i]! > sizes[keep]!) keep = i;
    }
    for (let idx = 0; idx < this.totalCells; idx++) {
      if (grid[idx] === id && comp[idx] !== keep) this.setCell(idx, EMPTY);
    }
  }

  // ---- death / respawn / elimination --------------------------------------

  /** A kill costs a life and clears the trail; resolution waits for the pause. */
  killActor(victim: Actor, killer: Actor | null): void {
    if (!victim.alive || victim.dead || victim.eliminated) return;
    for (const idx of victim.trail) this.trailOwner.delete(idx);
    victim.trail = [];
    victim.trailSet.clear();
    victim.recent = [];
    victim.lives -= 1;
    victim.dead = true;
    victim.moving = false;
    victim.deadUntilMs = this.elapsedMs + DEATH_MS;
    this.emit({ type: "death", id: victim.id });
    void killer;
  }

  /** Lost a life but lives remain (humans only): keep territory, drop home. */
  private respawn(a: Actor): void {
    a.trail = [];
    a.trailSet.clear();
    a.recent = [];
    a.dx = 0;
    a.dy = 0;
    a.botBudget = 0;
    a.dead = false;
    a.deadUntilMs = 0;
    a.alive = true;
    if (this.inBounds(a.homeCx, a.homeCy) && this.grid[this.key(a.homeCx, a.homeCy)] === a.id) {
      a.x = a.homeCx;
      a.y = a.homeCy;
    } else {
      const own: number[] = [];
      for (let idx = 0; idx < this.totalCells; idx++) if (this.grid[idx] === a.id) own.push(idx);
      if (own.length) {
        const s = own[(this.rng() * own.length) | 0]!;
        a.x = s % this.cols;
        a.y = (s / this.cols) | 0;
      } else {
        const h = this.findFreeHome() ?? { x: a.homeCx, y: a.homeCy };
        a.homeCx = h.x;
        a.homeCy = h.y;
        this.stampHome(a);
        a.x = h.x;
        a.y = h.y;
      }
    }
    a.fx = a.x + 0.5;
    a.fy = a.y + 0.5;
    a.heading = 0;
    a.targetHeading = 0;
    a.moving = false;
    a.ai = { mode: "rest" };
    this.emit({ type: "respawn", id: a.id });
  }

  /** Out of lives: free all land + trail. Bots are removed (id recycled). */
  private eliminate(a: Actor): void {
    for (let idx = 0; idx < this.totalCells; idx++) if (this.grid[idx] === a.id) this.setCell(idx, EMPTY);
    for (const idx of a.trail) this.trailOwner.delete(idx);
    a.trail = [];
    a.trailSet.clear();
    a.recent = [];
    a.alive = false;
    a.dead = false;
    a.eliminated = true;
    a.moving = false;
    this.emit({ type: "eliminated", id: a.id });
    if (a.isBot) {
      const i = this.bots.indexOf(a);
      if (i >= 0) this.bots.splice(i, 1);
      this.byIdArr[a.id] = undefined;
      this.freeBotIds.push(a.id);
    }
  }

  /** Remove a human seat that left the game for good (frees its land). */
  forceEliminate(seat: number): void {
    const a = this.bySeatArr[seat];
    if (!a || a.eliminated) return;
    a.lives = 0;
    this.eliminate(a);
    this.checkEnd(null);
  }

  // ---- endgame ------------------------------------------------------------

  /** Largest single actor's share of the board (0..1). */
  private topShare(): number {
    let m = 0;
    for (let id = 1; id < this.counts.length; id++) if (this.counts[id]! > m) m = this.counts[id]!;
    return m / this.totalCells;
  }

  /** The human with the most territory (among those still in the round). */
  private topHuman(): { seat: number; tie: boolean } {
    let bestSeat = -1;
    let best = -1;
    let tie = false;
    for (const h of this.humans) {
      if (h.eliminated) continue;
      const n = this.counts[h.id] ?? 0;
      if (n > best) {
        best = n;
        bestSeat = h.seat;
        tie = false;
      } else if (n === best) {
        tie = true;
      }
    }
    return { seat: bestSeat, tie };
  }

  private endGame(winnerSeat: number | null, outcome: Outcome): void {
    if (this.ended) return;
    this.ended = true;
    this.endResult = { winnerSeat, outcome };
    this.emit({ type: "endgame", id: -1 });
  }

  /**
   * Resolve end conditions: squeeze-to-zero deaths, human survival
   * (last-human / wipeout), then the target share (a human wins, a bot ends
   * the round as a takeover). `claimer` is the actor that just claimed (or null).
   */
  checkEnd(claimer: Actor | null): void {
    if (this.ended) return;
    // Any alive actor squeezed to zero land loses a life like any other death.
    for (const a of this.allActors()) {
      if (!a.alive || a.dead || a.eliminated) continue;
      if ((this.counts[a.id] ?? 0) === 0) this.killActor(a, null);
    }
    // Human survival.
    const startedHumans = this.humans.length;
    const humanContenders = this.humans.filter((h) => !h.eliminated);
    if (humanContenders.length === 0) {
      this.endGame(null, "wipeout");
      return;
    }
    if (startedHumans >= 2 && humanContenders.length === 1) {
      this.endGame(humanContenders[0]!.seat, "last_human");
      return;
    }
    // Target share.
    if (this.winMode === "target" && claimer) {
      if ((this.counts[claimer.id] ?? 0) >= this.totalCells * this.targetThreshold) {
        if (claimer.isBot) this.endGame(null, "bot_takeover");
        else this.endGame(claimer.seat, "target");
      }
    }
  }

  private finishTimed(): void {
    const ld = this.topHuman();
    this.endGame(ld.seat < 0 || ld.tie ? null : ld.seat, ld.tie ? "draw" : "timed");
  }

  // ---- bot AI -------------------------------------------------------------

  private botThink(a: Actor): void {
    if (a.ai.mode === "home" && this.grid[this.key(a.x, a.y)] === a.id) a.ai = { mode: "rest" };
    const ai = a.ai;
    if (ai.mode === "rest") {
      a.ai = this.planExcursion(a);
      return this.botThink(a);
    }
    if (ai.mode === "out") {
      if (ai.stepsLeft! > 0 && this.inBounds(a.x + ai.outDir![0], a.y + ai.outDir![1])) {
        a.dx = ai.outDir![0];
        a.dy = ai.outDir![1];
        ai.stepsLeft!--;
        return;
      }
      ai.mode = "across";
      ai.stepsLeft = ai.legSide!;
    }
    if (ai.mode === "across") {
      if (ai.stepsLeft! > 0 && this.inBounds(a.x + ai.sideDir![0], a.y + ai.sideDir![1])) {
        a.dx = ai.sideDir![0];
        a.dy = ai.sideDir![1];
        ai.stepsLeft!--;
        return;
      }
      ai.mode = "home";
    }
    const h = this.homeStep(a);
    a.dx = h[0];
    a.dy = h[1];
  }

  private planExcursion(a: Actor): BotAI {
    const D = DIFFICULTIES[a.difficulty];
    const dirs: [number, number][] = [
      [1, 0],
      [-1, 0],
      [0, 1],
      [0, -1],
    ];
    for (let i = dirs.length - 1; i > 0; i--) {
      const j = (this.rng() * (i + 1)) | 0;
      const t = dirs[i]!;
      dirs[i] = dirs[j]!;
      dirs[j] = t;
    }
    const rngInt = (lo: number, hi: number) => lo + ((this.rng() * (hi - lo + 1)) | 0);

    // Aggressive push toward a rival (hard/extreme only): head where they are.
    if (this.rng() < D.aggression) {
      const target = this.nearestRivalHead(a);
      if (target) {
        const dxTo = target.x - a.x;
        const dyTo = target.y - a.y;
        const outDir: [number, number] =
          Math.abs(dxTo) >= Math.abs(dyTo) ? [Math.sign(dxTo) || 1, 0] : [0, Math.sign(dyTo) || 1];
        const perps: [number, number][] = outDir[0] !== 0 ? [[0, 1], [0, -1]] : [[1, 0], [-1, 0]];
        const sideDir = perps[this.rng() < 0.5 ? 0 : 1]!;
        const reach = Math.min(D.legOut[1] + 4, Math.abs(dxTo) + Math.abs(dyTo));
        return {
          mode: "out",
          outDir,
          sideDir,
          legSide: rngInt(D.legSide[0], D.legSide[1]),
          stepsLeft: Math.max(D.legOut[0], reach),
          hunting: true,
        };
      }
    }

    let outDir = dirs[0]!;
    for (const d of dirs) if (this.roomAhead(a, d, 8) >= 4) {
      outDir = d;
      break;
    }
    const perps: [number, number][] = outDir[0] !== 0 ? [[0, 1], [0, -1]] : [[1, 0], [-1, 0]];
    const sideDir = perps[this.rng() < 0.5 ? 0 : 1]!;
    return {
      mode: "out",
      outDir,
      sideDir,
      legSide: rngInt(D.legSide[0], D.legSide[1]),
      stepsLeft: rngInt(D.legOut[0], D.legOut[1]),
    };
  }

  private nearestRivalHead(a: Actor): { x: number; y: number } | null {
    let best: Actor | null = null;
    let bestD = Infinity;
    for (const o of this.allActors()) {
      if (o === a || !o.alive || o.dead || o.eliminated) continue;
      const d = Math.abs(o.x - a.x) + Math.abs(o.y - a.y);
      if (d < bestD) {
        bestD = d;
        best = o;
      }
    }
    return best ? { x: best.x, y: best.y } : null;
  }

  private roomAhead(a: Actor, d: [number, number], max: number): number {
    let n = 0;
    let x = a.x;
    let y = a.y;
    for (let i = 0; i < max; i++) {
      x += d[0];
      y += d[1];
      if (!this.inBounds(x, y)) break;
      n++;
    }
    return n;
  }

  private homeStep(a: Actor): [number, number] {
    const tx = a.homeCx;
    const ty = a.homeCy;
    const cand: [number, number][] = [];
    if (Math.abs(tx - a.x) >= Math.abs(ty - a.y)) {
      if (tx !== a.x) cand.push([Math.sign(tx - a.x), 0]);
      if (ty !== a.y) cand.push([0, Math.sign(ty - a.y)]);
    } else {
      if (ty !== a.y) cand.push([0, Math.sign(ty - a.y)]);
      if (tx !== a.x) cand.push([Math.sign(tx - a.x), 0]);
    }
    cand.push([1, 0], [-1, 0], [0, 1], [0, -1]);
    for (const d of cand) {
      const nx = a.x + d[0];
      const ny = a.y + d[1];
      if (!this.inBounds(nx, ny) || a.trailSet.has(this.key(nx, ny))) continue;
      return d;
    }
    return [a.dx || 1, a.dy || 0];
  }

  /** Live bots that are currently on the board (not in their death pause). */
  private aliveBotCount(): number {
    let n = 0;
    for (const b of this.bots) if (b.alive && !b.dead) n++;
    return n;
  }

  // ---- the tick -----------------------------------------------------------

  /** Advance the whole world by dt seconds. */
  step(dt: number): void {
    if (this.ended) return;
    this.elapsedMs += dt * 1000;

    // Resolve finished death pauses (snapshot: eliminate() mutates this.bots).
    for (const a of this.allActors()) {
      if (a.dead && this.elapsedMs >= a.deadUntilMs) {
        if (a.lives > 0) this.respawn(a);
        else this.eliminate(a);
      }
    }
    this.checkEnd(null);
    if (this.ended) return;

    // Humans move continuously every tick.
    for (const a of this.humans) {
      if (!a.alive || a.dead || a.frozen) continue;
      this.moveContinuous(a, dt);
      if (this.ended) return;
    }

    // Bots step whole cells, paced to the same cell speed as humans.
    for (const a of this.bots) {
      if (!a.alive || a.dead) continue;
      a.botBudget += this.speedCellsPerSec * dt;
      let guard = 0;
      while (a.botBudget >= 1 && a.alive && !a.dead && !this.ended && guard++ < 8) {
        a.botBudget -= 1;
        this.botThink(a);
        this.moveActorBot(a);
      }
      a.fx = a.x + 0.5;
      a.fy = a.y + 0.5;
      if (this.ended) return;
    }

    this.checkEnd(null);
    if (this.ended) return;

    // Top the bot population back up over time, until a leader dominates.
    this.spawnAccumMs += dt * 1000;
    while (this.spawnAccumMs >= SPAWN_INTERVAL_MS) {
      this.spawnAccumMs -= SPAWN_INTERVAL_MS;
      if (this.aliveBotCount() < this.botCount && this.topShare() < SPAWN_CAP_SHARE) this.spawnBot();
    }

    if (this.winMode === "timed" && this.elapsedMs >= this.timedLimitMs) this.finishTimed();
  }
}
