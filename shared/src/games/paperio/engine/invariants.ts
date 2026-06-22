/**
 * Paper.io GRID invariants. Throws on the first violation. Paper.io is a
 * real-time tick loop (not turn-based), so the turn "soft-lock" failure mode
 * the card games guard against does NOT apply here. What CAN go wrong is the
 * mutable grid drifting out of sync with the actor set: an owned cell left
 * behind by an eliminated actor, the per-id territory counter disagreeing with
 * a fresh scan of the grid, a stale trail cell pointing at a dead actor, or a
 * head walking out of bounds.
 *
 * Run after EVERY step() in the fuzz harness. These checks read only the
 * public surface of PaperIoWorld (grid, counts via territoryOfId, the actor
 * arrays, geometry helpers) so they never reach into private state.
 */
import { PaperIoWorld } from "./world.js";
import type { Actor } from "./types.js";

const EMPTY = 0;

export function assertGridInvariants(world: PaperIoWorld): void {
  const { grid, cols, rows, totalCells } = world;
  if (grid.length !== totalCells) {
    throw new Error(`grid length ${grid.length} != totalCells ${totalCells}`);
  }

  // Every actor we know about, indexed by its grid id. Humans persist for the
  // round (eliminated ones stay flagged); live bots come and go. An eliminated
  // actor MUST own no cells (eliminate() frees its land), and a bot that has
  // been removed must likewise leave nothing behind.
  const humans = world.humans;
  const bots = world.bots;
  const byId = new Map<number, Actor>();
  for (const a of humans) byId.set(a.id, a);
  for (const a of bots) {
    if (byId.has(a.id)) throw new Error(`duplicate live actor id ${a.id}`);
    byId.set(a.id, a);
  }

  // (1) Every OWNED cell maps to a live (non-eliminated) actor, and the live
  //     per-id tally from a fresh scan matches.
  const scan = new Map<number, number>();
  for (let idx = 0; idx < totalCells; idx++) {
    const id = grid[idx]!;
    if (id === EMPTY) continue;
    if (id < 0) throw new Error(`cell ${idx} has negative owner id ${id}`);
    const owner = byId.get(id);
    if (!owner) throw new Error(`owned cell ${idx} maps to unknown actor id ${id}`);
    if (owner.eliminated) throw new Error(`owned cell ${idx} belongs to ELIMINATED actor id ${id}`);
    scan.set(id, (scan.get(id) ?? 0) + 1);
  }

  // (2) The world's maintained count (counts[id], exposed as territoryOfId)
  //     must agree with the fresh scan for every known live actor, and a fresh
  //     scan must find no owner the count map doesn't know about.
  for (const [id] of byId) {
    const fresh = scan.get(id) ?? 0;
    const tracked = world.territoryOfId(id);
    if (fresh !== tracked) {
      throw new Error(`territory count mismatch for id ${id}: tracked ${tracked} != scan ${fresh}`);
    }
  }

  // (3) No trail cell belongs to a dead/eliminated actor, and each live actor's
  //     trail is self-consistent: in bounds, set/array agree, and the actor is
  //     actively moving (a dead/eliminated actor's trail was cleared by
  //     killActor/eliminate, so an entry here is a leak).
  for (const a of byId.values()) {
    const stale = a.dead || a.eliminated;
    if (stale && a.trail.length !== 0) {
      throw new Error(`dead/eliminated actor id ${a.id} still holds ${a.trail.length} trail cells`);
    }
    if (stale && a.trailSet.size !== 0) {
      throw new Error(`dead/eliminated actor id ${a.id} still holds a non-empty trailSet`);
    }
    if (a.trail.length !== a.trailSet.size) {
      throw new Error(`actor id ${a.id} trail array/set out of sync (${a.trail.length} vs ${a.trailSet.size})`);
    }
    for (const k of a.trail) {
      if (k < 0 || k >= totalCells) throw new Error(`actor id ${a.id} trail cell ${k} out of range`);
      if (!a.trailSet.has(k)) throw new Error(`actor id ${a.id} trail array cell ${k} missing from trailSet`);
    }
  }

  // (4) Every live, non-dead actor's head position is in bounds and agrees with
  //     its grid coordinates. (Dead actors are mid-pause and not on the board.)
  for (const a of byId.values()) {
    if (!a.alive || a.dead || a.eliminated) continue;
    if (!world.inBounds(a.x, a.y)) {
      throw new Error(`live actor id ${a.id} head (${a.x},${a.y}) out of bounds (${cols}x${rows})`);
    }
    if (!Number.isInteger(a.x) || !Number.isInteger(a.y)) {
      throw new Error(`live actor id ${a.id} head (${a.x},${a.y}) is non-integer`);
    }
    if (a.fx < 0 || a.fx > cols || a.fy < 0 || a.fy > rows) {
      throw new Error(`live actor id ${a.id} float pos (${a.fx},${a.fy}) out of bounds`);
    }
  }
}
