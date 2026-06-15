/**
 * Paper.io ENGINE unit tests (pure rules, no Colyseus). Ported from the source
 * game's test/sim.test.js and extended for the framework changes: uniform
 * death/lives, elimination, last-survivor, timed win, equal bot/human speed,
 * and determinism under a fixed seed.
 */
import assert from "node:assert";
import { describe, it } from "mocha";
import { PaperIoEngine } from "@backbone/shared";

const { PaperIoWorld } = PaperIoEngine;
type World = InstanceType<typeof PaperIoWorld>;
type Actor = PaperIoEngine.Actor;
type SeatConfig = PaperIoEngine.SeatConfig;
type WinMode = PaperIoEngine.WinMode;

interface Over {
  cols?: number;
  rows?: number;
  speedCellsPerSec?: number;
  winMode?: WinMode;
  targetThreshold?: number;
  timedLimitMs?: number;
  lives?: number;
  seats?: SeatConfig[];
  seed?: number;
}

function makeWorld(over: Over = {}): World {
  const seats: SeatConfig[] = over.seats ?? [{ seat: 0, isBot: false, difficulty: "normal" }];
  return new PaperIoWorld(
    {
      cols: over.cols ?? 24,
      rows: over.rows ?? 24,
      speedCellsPerSec: over.speedCellsPerSec ?? 13,
      winMode: over.winMode ?? "target",
      targetThreshold: over.targetThreshold ?? 1,
      timedLimitMs: over.timedLimitMs ?? 120000,
      lives: over.lives ?? 3,
      seats,
    },
    over.seed ?? 12345
  );
}

function player(w: World): Actor {
  return w.actorBySeat(0)!;
}
function countOf(w: World, id: number): number {
  let n = 0;
  for (let i = 0; i < w.totalCells; i++) if (w.grid[i] === id) n++;
  return n;
}

describe("paper.io engine", () => {
  it("claimFor encloses a rectangle: interior + trail captured, outside untouched", () => {
    const w = makeWorld({ targetThreshold: 1 });
    const p = player(w);
    w.clearBoard();
    w.fillRect(p.id, 5, 12, 14, 12); // home strip along row 12
    p.x = 5;
    p.y = 12;
    const path: [number, number][] = [];
    for (let y = 11; y >= 7; y--) path.push([5, y]); // up the left side
    for (let x = 6; x <= 14; x++) path.push([x, 7]); // across the top
    for (let y = 8; y <= 11; y++) path.push([14, y]); // down the right side
    path.push([14, 12]); // re-enter home -> claim
    for (const [x, y] of path) assert.ok(w.enterCell(p, x, y), `survive laying trail at ${x},${y}`);
    assert.equal(p.trail.length, 0, "trail consumed by the claim");
    assert.equal(w.grid[w.key(10, 9)], p.id, "interior cell captured by flood-fill");
    assert.equal(w.grid[w.key(5, 7)], p.id, "trail corner owned");
    assert.equal(w.grid[w.key(0, 0)], 0, "far outside cell NOT captured");
    assert.equal(w.grid[w.key(20, 20)], 0, "other outside cell NOT captured");
  });

  it("crossing your OWN older trail kills you and costs a life", () => {
    const w = makeWorld();
    const p = player(w);
    w.clearBoard();
    w.fillRect(p.id, 2, 12, 4, 12);
    p.x = 4;
    p.y = 12;
    const lives0 = p.lives;
    for (let x = 5; x <= 14; x++) assert.ok(w.enterCell(p, x, 12));
    const survived = w.enterCell(p, 6, 12); // an OLD trail cell behind the head
    assert.equal(survived, false, "entering old trail returns false");
    assert.equal(p.dead, true, "player marked dead");
    assert.equal(p.lives, lives0 - 1, "lost exactly one life");
  });

  it("SELF_GRACE: the cells right behind the head do NOT kill you", () => {
    const w = makeWorld();
    const p = player(w);
    w.clearBoard();
    w.fillRect(p.id, 2, 12, 4, 12);
    p.x = 4;
    p.y = 12;
    for (let x = 5; x <= 10; x++) assert.ok(w.enterCell(p, x, 12));
    const lastIdx = p.recent[p.recent.length - 1]!;
    const survived = w.enterCell(p, lastIdx % w.cols, (lastIdx / w.cols) | 0);
    assert.equal(survived, true, "recent trail cell is safe");
    assert.equal(p.dead, false, "still alive");
  });

  it("cutting a rival's trail kills them (a life), killer keeps moving, no absorb", () => {
    const w = makeWorld({
      seats: [
        { seat: 0, isBot: false, difficulty: "normal" },
        { seat: 1, isBot: true, difficulty: "normal" },
      ],
      lives: 3,
    });
    const p = player(w);
    const bot = w.actorBySeat(1)!;
    w.clearBoard();
    w.fillRect(bot.id, 16, 4, 20, 8); // bot's land
    for (const [x, y] of [[15, 6], [14, 6], [13, 6]] as [number, number][]) w.addTrailCell(bot, x, y);
    w.fillRect(p.id, 2, 4, 6, 8); // player's land
    p.x = 12;
    p.y = 6;
    const botLand = countOf(w, bot.id);
    const playerLand = countOf(w, p.id);
    const survived = w.enterCell(p, 13, 6); // step onto the bot's trail tip -> cut it
    assert.ok(survived, "killer survives the cut");
    assert.equal(bot.dead, true, "victim is dead");
    assert.equal(bot.lives, 2, "victim lost exactly one life");
    assert.equal(bot.trail.length, 0, "victim's trail cleared");
    assert.equal(countOf(w, bot.id), botLand, "victim keeps its territory (respawns later)");
    assert.equal(countOf(w, p.id), playerLand, "killer gained NO territory (no absorb)");
  });

  it("pruneTerritory keeps only the blob under the head", () => {
    const w = makeWorld();
    const p = player(w);
    w.clearBoard();
    w.fillRect(p.id, 1, 1, 4, 4); // blob A (head here)
    w.fillRect(p.id, 18, 18, 21, 21); // blob B (island)
    p.x = 2;
    p.y = 2;
    w.pruneTerritory(p);
    assert.equal(w.grid[w.key(2, 2)], p.id, "blob under head kept");
    assert.equal(w.grid[w.key(20, 20)], 0, "disconnected island dropped");
  });

  it("reaching the target share ends the game with a winner", () => {
    const w = makeWorld({ cols: 12, rows: 12, targetThreshold: 0.3, winMode: "target" });
    const p = player(w);
    w.clearBoard();
    w.fillRect(p.id, 0, 0, 11, 8); // pre-own most of the board
    p.x = 0;
    p.y = 8;
    w.enterCell(p, 0, 9); // small excursion
    w.enterCell(p, 0, 8); // back onto own land -> claim -> checkEnd
    assert.equal(w.ended, true, "game ended");
    assert.equal(w.endResult?.reason, "target", "ended by target threshold");
    assert.equal(w.endResult?.winnerSeat, p.seat, "player is the winner");
  });

  it("moveContinuous lays a 4-connected trail on a diagonal (no corner gaps)", () => {
    const w = makeWorld({ cols: 40, rows: 40, targetThreshold: 1, speedCellsPerSec: 20 });
    const p = player(w);
    w.clearBoard();
    w.fillRect(p.id, 2, 2, 6, 6);
    p.x = 6;
    p.y = 6;
    p.fx = 6.5;
    p.fy = 6.5;
    w.steer(0, Math.PI / 4); // head down-right at 45 degrees
    for (let f = 0; f < 30 && !p.dead && !w.ended; f++) w.moveContinuous(p, 1 / 30);
    assert.ok(p.trail.length >= 3, "laid a diagonal trail");
    for (let i = 1; i < p.trail.length; i++) {
      const ax = p.trail[i]! % w.cols;
      const ay = (p.trail[i]! / w.cols) | 0;
      const bx = p.trail[i - 1]! % w.cols;
      const by = (p.trail[i - 1]! / w.cols) | 0;
      assert.equal(Math.abs(ax - bx) + Math.abs(ay - by), 1, `cells 4-adjacent at index ${i}`);
    }
  });

  it("a death respawns (keeping territory) while lives remain, then eliminates at zero", () => {
    const w = makeWorld({ lives: 2 });
    const p = player(w);
    const landBefore = w.territoryOf(0);
    assert.ok(landBefore > 0, "starts with a home");

    // First death: lose a life, then respawn after the death pause keeps land.
    w.killActor(p, null);
    assert.equal(p.lives, 1);
    w.step(1); // 1s >> DEATH_MS
    assert.equal(p.dead, false, "respawned");
    assert.equal(p.alive, true);
    assert.equal(w.territoryOf(0), landBefore, "kept its territory on respawn");

    // Second death takes the last life: eliminated, land freed.
    w.killActor(p, null);
    assert.equal(p.lives, 0);
    w.step(1);
    assert.equal(p.eliminated, true, "eliminated at zero lives");
    assert.equal(w.territoryOf(0), 0, "territory freed on elimination");
  });

  it("last survivor wins once everyone else is eliminated", () => {
    const w = makeWorld({
      seats: [
        { seat: 0, isBot: false, difficulty: "normal" },
        { seat: 1, isBot: false, difficulty: "normal" },
      ],
      lives: 1,
    });
    const a = w.actorBySeat(0)!;
    const b = w.actorBySeat(1)!;
    w.killActor(b, a.seat); // b's last life
    w.step(1); // resolve the death pause -> eliminate -> checkEnd
    assert.equal(b.eliminated, true);
    assert.equal(w.ended, true, "round ended");
    assert.equal(w.endResult?.reason, "survivor");
    assert.equal(w.endResult?.winnerSeat, a.seat, "the survivor wins");
  });

  it("timed mode ends at the limit with the territory leader as winner", () => {
    const w = makeWorld({
      cols: 16,
      rows: 16,
      winMode: "timed",
      timedLimitMs: 1000,
      seats: [
        { seat: 0, isBot: false, difficulty: "normal" },
        { seat: 1, isBot: false, difficulty: "normal" },
      ],
    });
    const a = w.actorBySeat(0)!;
    const b = w.actorBySeat(1)!;
    // Give seat 0 a clear territory lead.
    w.fillRect(a.id, 0, 0, 15, 6);
    assert.ok(w.territoryOf(0) > w.territoryOf(1));
    w.step(1.5); // past the 1s limit (nobody moving -> grid unchanged)
    assert.equal(w.ended, true, "timed round ended");
    assert.equal(w.endResult?.reason, "timed");
    assert.equal(w.endResult?.winnerSeat, a.seat, "leader wins on time");
    void b;
  });

  it("bots move at the SAME cell speed as humans (no per-difficulty speed)", () => {
    const speed = 10;
    const ticks = 20;
    const dt = 1 / 20; // 20 ticks * 0.05s = 1.0s -> exactly `speed` cells

    // Human, steered straight on an open board.
    const wh = makeWorld({ cols: 60, rows: 60, speedCellsPerSec: speed, targetThreshold: 1 });
    const h = player(wh);
    wh.steer(0, 0); // head +x
    const fx0 = h.fx;
    for (let i = 0; i < ticks; i++) wh.step(dt);
    const humanCells = h.fx - fx0;
    assert.ok(Math.abs(humanCells - speed) <= 0.5, `human moved ~${speed} cells (got ${humanCells.toFixed(2)})`);

    // Bot on its own large board: sum the Manhattan path it steps each tick.
    const wb = makeWorld({
      cols: 60,
      rows: 60,
      speedCellsPerSec: speed,
      targetThreshold: 1,
      seats: [{ seat: 0, isBot: true, difficulty: "extreme" }],
    });
    const bot = wb.actorBySeat(0)!;
    let path = 0;
    for (let i = 0; i < ticks; i++) {
      const px = bot.x;
      const py = bot.y;
      wb.step(dt);
      path += Math.abs(bot.x - px) + Math.abs(bot.y - py);
    }
    assert.ok(Math.abs(path - speed) <= 1, `bot stepped ~${speed} cells in 1s (got ${path})`);
  });

  it("is deterministic: same seed -> identical grid and positions", () => {
    const seats: SeatConfig[] = [
      { seat: 0, isBot: false, difficulty: "normal" },
      { seat: 1, isBot: true, difficulty: "hard" },
    ];
    const run = () => {
      const w = makeWorld({ cols: 48, rows: 32, seats, seed: 999, targetThreshold: 1 });
      w.steer(0, Math.PI / 6);
      for (let i = 0; i < 60; i++) w.step(1 / 20);
      return w;
    };
    const a = run();
    const b = run();
    assert.deepEqual(Array.from(a.grid), Array.from(b.grid), "grids identical");
    const ab = a.actorBySeat(1)!;
    const bb = b.actorBySeat(1)!;
    assert.equal(ab.x, bb.x, "bot x identical");
    assert.equal(ab.y, bb.y, "bot y identical");
  });
});
