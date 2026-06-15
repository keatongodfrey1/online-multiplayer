/**
 * Paper.io world - the pure simulation ported from the source game's sim.js.
 *
 * Owns the grid, the actors, free-angle movement, flood-fill territory
 * claiming, trail collisions, connectivity pruning, deaths/respawns/
 * eliminations, bot AI, and win detection. It has NO Colyseus/DOM/timer
 * dependencies: time is advanced by step(dt) and randomness comes from a
 * seeded RNG, so it is fully deterministic and unit-testable on its own.
 *
 * Differences from the source (deliberate, agreed with the owner):
 *  - Free-angle continuous movement for humans; bots grid-step but at the
 *    SAME cell speed as humans (a movement budget), so difficulty changes how
 *    bots play, never how fast they move ("smarter, not faster").
 *  - Uniform death model: a kill (self-cut, a rival cutting your trail, or
 *    being squeezed to zero land) costs a life and clears your trail. With
 *    lives left you respawn keeping your territory; at zero lives you are
 *    eliminated and your land is freed. No territory is transferred on a kill.
 *  - Lives + elimination apply to bots too; the round ends on the target
 *    share, the timed limit, a last survivor, or all humans being out.
 */
import {
  DEATH_MS,
  DIFFICULTIES,
  SELF_GRACE,
  START_BLOCK,
  TURN_RATE,
} from "./constants.js";
import { mulberry32 } from "./rng.js";
import type {
  Actor,
  BotAI,
  EndResult,
  GameEvent,
  SeatConfig,
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
  readonly startLives: number;

  /** Owner value per cell (actor.id, or 0). Flat, row-major (y * cols + x). */
  readonly grid: Int16Array;
  /** Per-id territory counts, kept up to date by setCell. Index = actor.id. */
  private readonly counts: Int32Array;
  /** Cells whose owner changed since the last drainDirty(); for schema sync. */
  readonly dirty = new Set<number>();
  /** Trail ownership across the whole board: packed cell index -> actor.id. */
  private readonly trailOwner = new Map<number, number>();

  /** Actors in seat order. */
  readonly actorList: Actor[] = [];
  /** Sparse, indexed by seat. */
  private readonly bySeatArr: (Actor | undefined)[] = [];
  /** Sparse, indexed by id (= seat + 1). */
  private readonly byIdArr: (Actor | undefined)[] = [];

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
    this.startLives = opts.lives;
    this.rng = mulberry32(seed >>> 0);

    this.grid = new Int16Array(this.totalCells);
    this.outside = new Uint8Array(this.totalCells);
    this.comp = new Int32Array(this.totalCells);

    const maxId = opts.seats.reduce((m, s) => Math.max(m, s.seat + 1), 0);
    this.counts = new Int32Array(maxId + 1);

    this.build(opts.seats);
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
  territoryOf(seat: number): number {
    return this.counts[seat + 1] ?? 0;
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
    for (const a of this.actorList) {
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

  private build(seats: SeatConfig[]): void {
    const homes = this.regionHomes(seats.length);
    seats.forEach((cfg, i) => {
      const home = homes[i]!;
      const a = this.makeActor(cfg, home.x, home.y);
      this.actorList.push(a);
      this.bySeatArr[a.seat] = a;
      this.byIdArr[a.id] = a;
      this.stampHome(a);
    });
  }

  private makeActor(cfg: SeatConfig, hx: number, hy: number): Actor {
    return {
      seat: cfg.seat,
      id: cfg.seat + 1,
      isBot: cfg.isBot,
      difficulty: cfg.difficulty,
      alive: true,
      dead: false,
      eliminated: false,
      deadUntilMs: 0,
      lives: this.startLives,
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
      if (victim) this.killActor(victim, a.seat); // cut a rival's trail
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
    this.emit({ type: "claim", seat: a.seat });
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
    for (const o of this.actorList) {
      if (o === a || !o.alive || o.dead || o.eliminated) continue;
      if (capSet.has(this.key(o.x, o.y))) this.killActor(o, a.seat);
    }
    for (const oid of affected) {
      const o = this.byId(oid);
      if (o && o.alive && !o.eliminated) this.pruneTerritory(o);
    }
    this.checkEnd(a.seat);
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
  killActor(victim: Actor, killerSeat: number | null): void {
    if (!victim.alive || victim.dead || victim.eliminated) return;
    for (const idx of victim.trail) this.trailOwner.delete(idx);
    victim.trail = [];
    victim.trailSet.clear();
    victim.recent = [];
    victim.lives -= 1;
    victim.dead = true;
    victim.moving = false;
    victim.deadUntilMs = this.elapsedMs + DEATH_MS;
    this.emit({ type: "death", seat: victim.seat, killerSeat });
  }

  /** Lost a life but lives remain: keep territory, drop back on a safe owned cell. */
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
    this.emit({ type: "respawn", seat: a.seat });
  }

  /** Out of lives: free all land + trail and remove from play. */
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
    this.emit({ type: "eliminated", seat: a.seat });
  }

  /** Remove a seat that left the game for good (frees its land, ends if no humans left). */
  forceEliminate(seat: number): void {
    const a = this.bySeatArr[seat];
    if (!a || a.eliminated) return;
    a.lives = 0;
    this.eliminate(a);
    this.checkEnd(null);
  }

  // ---- endgame ------------------------------------------------------------

  private leader(): { seat: number; tie: boolean } {
    let bestSeat = -1;
    let best = -1;
    let tie = false;
    for (const a of this.actorList) {
      const n = this.counts[a.id] ?? 0;
      if (n > best) {
        best = n;
        bestSeat = a.seat;
        tie = false;
      } else if (n === best) {
        tie = true;
      }
    }
    return { seat: bestSeat, tie };
  }

  private endGame(reason: EndResult["reason"], winnerSeat: number | null): void {
    if (this.ended) return;
    this.ended = true;
    this.endResult = { reason, winnerSeat };
    this.emit({ type: "endgame", seat: winnerSeat ?? -1, reason, winnerSeat });
  }

  /** Check squeeze-to-zero, last-survivor / all-humans-out, then target share. */
  checkEnd(claimerSeat: number | null): void {
    if (this.ended) return;
    // Any alive actor squeezed to zero land loses a life like any other death.
    for (const a of this.actorList) {
      if (!a.alive || a.dead || a.eliminated) continue;
      if ((this.counts[a.id] ?? 0) === 0) this.killActor(a, null);
    }
    if (this.actorList.length > 1) {
      const contenders = this.actorList.filter((a) => !a.eliminated);
      if (contenders.length <= 1) {
        this.endGame("survivor", contenders[0]?.seat ?? null);
        return;
      }
      const humansLeft = contenders.some((a) => !a.isBot);
      if (!humansLeft) {
        const ld = this.leader();
        this.endGame("allout", ld.tie ? null : ld.seat);
        return;
      }
    }
    if (this.winMode === "target" && claimerSeat !== null) {
      const claimer = this.bySeatArr[claimerSeat];
      if (claimer && (this.counts[claimer.id] ?? 0) >= this.totalCells * this.targetThreshold) {
        this.endGame("target", claimer.seat);
      }
    }
  }

  private finishTimed(): void {
    const ld = this.leader();
    this.endGame("timed", ld.tie ? null : ld.seat);
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
    for (const o of this.actorList) {
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

  // ---- the tick -----------------------------------------------------------

  /** Advance the whole world by dt seconds. */
  step(dt: number): void {
    if (this.ended) return;
    this.elapsedMs += dt * 1000;

    // Resolve finished death pauses.
    for (const a of this.actorList) {
      if (a.dead && this.elapsedMs >= a.deadUntilMs) {
        if (a.lives > 0) this.respawn(a);
        else this.eliminate(a);
      }
    }
    this.checkEnd(null);
    if (this.ended) return;

    // Humans move continuously every tick.
    for (const a of this.actorList) {
      if (a.isBot || !a.alive || a.dead || a.frozen) continue;
      this.moveContinuous(a, dt);
      if (this.ended) return;
    }

    // Bots step whole cells, paced to the same cell speed as humans.
    for (const a of this.actorList) {
      if (!a.isBot || !a.alive || a.dead) continue;
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
    if (!this.ended && this.winMode === "timed" && this.elapsedMs >= this.timedLimitMs) this.finishTimed();
  }
}
