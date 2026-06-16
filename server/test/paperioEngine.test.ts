/**
 * Paper.io ENGINE unit tests (pure rules, no Colyseus). Ported from the source
 * game's test/sim.test.js and extended for the framework model: humans with
 * configurable lives, engine-owned bots with ONE life that respawn fresh
 * throughout the round, win/wipeout outcomes, equal bot/human speed, and
 * determinism under a fixed seed.
 */
import assert from "node:assert";
import { describe, it } from "mocha";
import { PaperIoEngine } from "@backbone/shared";

const { PaperIoWorld } = PaperIoEngine;
type World = InstanceType<typeof PaperIoWorld>;
type Actor = PaperIoEngine.Actor;
type WinMode = PaperIoEngine.WinMode;
type BotDifficulty = PaperIoEngine.BotDifficulty;

interface Over {
  cols?: number;
  rows?: number;
  speedCellsPerSec?: number;
  winMode?: WinMode;
  targetThreshold?: number;
  timedLimitMs?: number;
  humanLives?: number;
  humans?: { seat: number }[];
  botCount?: number;
  botDifficulty?: BotDifficulty;
  seed?: number;
}

function makeWorld(over: Over = {}): World {
  return new PaperIoWorld(
    {
      cols: over.cols ?? 24,
      rows: over.rows ?? 24,
      speedCellsPerSec: over.speedCellsPerSec ?? 13,
      winMode: over.winMode ?? "target",
      targetThreshold: over.targetThreshold ?? 1,
      timedLimitMs: over.timedLimitMs ?? 120000,
      humanLives: over.humanLives ?? 3,
      humans: over.humans ?? [{ seat: 0 }],
      botCount: over.botCount ?? 0,
      botDifficulty: over.botDifficulty ?? "normal",
      maxBots: 16,
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

  it("cutting a bot's trail kills it (its 1 life), killer keeps moving, no absorb", () => {
    const w = makeWorld({ botCount: 1 });
    const p = player(w);
    const bot = w.bots[0]!;
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
    assert.equal(bot.lives, 0, "bot had a single life");
    assert.equal(bot.trail.length, 0, "victim's trail cleared");
    assert.equal(countOf(w, bot.id), botLand, "victim keeps its territory until it's removed");
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

  it("a human reaching the target share wins the round", () => {
    const w = makeWorld({ cols: 12, rows: 12, targetThreshold: 0.3, winMode: "target" });
    const p = player(w);
    w.clearBoard();
    w.fillRect(p.id, 0, 0, 11, 8); // pre-own most of the board
    p.x = 0;
    p.y = 8;
    w.enterCell(p, 0, 9); // small excursion
    w.enterCell(p, 0, 8); // back onto own land -> claim -> checkEnd
    assert.equal(w.ended, true, "game ended");
    assert.equal(w.endResult?.outcome, "target", "ended by target threshold");
    assert.equal(w.endResult?.winnerSeat, p.seat, "player is the winner");
  });

  it("a BOT reaching the target ends the round as a takeover (no human winner)", () => {
    const w = makeWorld({ cols: 12, rows: 12, targetThreshold: 0.3, winMode: "target", botCount: 1 });
    const p = player(w);
    const bot = w.bots[0]!;
    w.clearBoard();
    w.fillRect(p.id, 0, 0, 2, 2); // tiny human pocket so it isn't squeezed out
    w.fillRect(bot.id, 0, 4, 11, 11); // bot owns most of the board
    bot.x = 0;
    bot.y = 11;
    w.checkEnd(bot); // a bot over the target ends the round
    assert.equal(w.ended, true, "round ended");
    assert.equal(w.endResult?.outcome, "bot_takeover");
    assert.equal(w.endResult?.winnerSeat, null, "no human winner");
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

  it("a human death respawns while lives remain, then is eliminated at zero (wipeout)", () => {
    const w = makeWorld({ humanLives: 2 });
    const p = player(w);
    const landBefore = w.territoryOf(0);
    assert.ok(landBefore > 0, "starts with a home");

    w.killActor(p, null);
    assert.equal(p.lives, 1);
    w.step(1); // 1s >> DEATH_MS
    assert.equal(p.dead, false, "respawned");
    assert.equal(p.alive, true);
    assert.equal(w.territoryOf(0), landBefore, "kept its territory on respawn");

    w.killActor(p, null);
    assert.equal(p.lives, 0);
    w.step(1);
    assert.equal(p.eliminated, true, "eliminated at zero lives");
    assert.equal(w.territoryOf(0), 0, "territory freed on elimination");
    assert.equal(w.ended, true);
    assert.equal(w.endResult?.outcome, "wipeout", "solo human out of lives = wipeout");
  });

  it("last human standing wins once the other human is eliminated", () => {
    const w = makeWorld({ humans: [{ seat: 0 }, { seat: 1 }], humanLives: 1 });
    const a = w.actorBySeat(0)!;
    const b = w.actorBySeat(1)!;
    w.killActor(b, a); // b's only life
    w.step(1); // resolve the death pause -> eliminate -> checkEnd
    assert.equal(b.eliminated, true);
    assert.equal(w.ended, true, "round ended");
    assert.equal(w.endResult?.outcome, "last_human");
    assert.equal(w.endResult?.winnerSeat, a.seat, "the survivor wins");
  });

  it("timed mode ends at the limit with the top human as winner", () => {
    const w = makeWorld({
      cols: 16,
      rows: 16,
      winMode: "timed",
      timedLimitMs: 1000,
      humans: [{ seat: 0 }, { seat: 1 }],
    });
    const a = w.actorBySeat(0)!;
    w.fillRect(a.id, 0, 0, 15, 4); // give seat 0 a clear lead, clear of homes
    assert.ok(w.territoryOf(0) > w.territoryOf(1));
    w.step(1.5); // past the 1s limit (nobody steering -> grid stable)
    assert.equal(w.ended, true, "timed round ended");
    assert.equal(w.endResult?.outcome, "timed");
    assert.equal(w.endResult?.winnerSeat, a.seat, "leader wins on time");
  });

  it("bots have ONE life and a fresh bot replaces a killed one over time", () => {
    const w = makeWorld({ cols: 40, rows: 40, botCount: 1 });
    const bot = w.bots[0]!;
    const seed0 = bot.colorSeed;
    w.killActor(bot, null);
    assert.equal(bot.lives, 0);
    // Resolve the death pause: the bot is eliminated and removed.
    for (let i = 0; i < 10; i++) w.step(0.1); // ~1s
    assert.equal(w.bots.length, 0, "killed bot removed (1 life, no respawn-in-place)");
    // After the spawn interval a brand-new bot drops in (fresh colour seed).
    for (let i = 0; i < 70; i++) w.step(0.1); // ~7s more
    assert.equal(w.bots.length, 1, "population topped back up to 1");
    assert.notEqual(w.bots[0]!.colorSeed, seed0, "the replacement is a NEW bot");
  });

  it("stops spawning bots once a leader dominates (spawn cap)", () => {
    const w = makeWorld({ cols: 24, rows: 24, botCount: 1 });
    const p = player(w);
    w.fillRect(p.id, 0, 0, 23, 19); // human owns >80% of the board
    assert.ok(w.territoryOf(0) / w.totalCells > 0.8);
    const bot = w.bots[0]!;
    w.killActor(bot, null);
    for (let i = 0; i < 90; i++) w.step(0.1); // ~9s, well past the spawn interval
    assert.equal(w.bots.length, 0, "no new bot spawns while a leader dominates");
  });

  it("bots move at the SAME cell speed as humans (no per-difficulty speed)", () => {
    const speed = 10;
    const ticks = 20;
    const dt = 1 / 20; // 1.0s -> exactly `speed` cells

    // A stationary human keeps the round alive while we measure the bot.
    const w = makeWorld({ cols: 60, rows: 60, speedCellsPerSec: speed, botCount: 1, botDifficulty: "extreme" });
    const human = player(w);
    const fx0 = human.fx;
    const bot = w.bots[0]!;
    let path = 0;
    for (let i = 0; i < ticks; i++) {
      const px = bot.x;
      const py = bot.y;
      w.step(dt);
      path += Math.abs(bot.x - px) + Math.abs(bot.y - py);
    }
    assert.ok(Math.abs(human.fx - fx0) < 0.001, "an unsteered human does not move");
    assert.ok(Math.abs(path - speed) <= 1, `bot stepped ~${speed} cells in 1s (got ${path})`);
  });

  it("is deterministic: same seed -> identical grid", () => {
    const run = () => {
      const w = makeWorld({ cols: 48, rows: 32, humans: [{ seat: 0 }], botCount: 3, botDifficulty: "hard", seed: 999 });
      w.steer(0, Math.PI / 6);
      for (let i = 0; i < 80; i++) w.step(1 / 20);
      return w;
    };
    const a = run();
    const b = run();
    assert.deepEqual(Array.from(a.grid), Array.from(b.grid), "grids identical");
  });
});
