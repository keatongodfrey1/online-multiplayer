// Structural invariants for the Catan engine. Throws on the first violation,
// so it can run after EVERY reduce in tests/fuzz AND at runtime (parseSave runs
// it on a resumed save before the state is trusted).
//
// These are the conservation + limit + win-detection checks that lived as a
// private `invariantsOk` helper inside server/test/catanEngine.test.ts; they are
// MOVED here verbatim (same conditions, same messages) so the runtime save path
// reuses the exact net the fuzz relies on. The 2-player variant fuzz keeps its
// own extra token/neutral checks inline — those are variant-only and not part of
// this shared net.

import { RESOURCES, WINNING_VP } from "./types.js";
import type { GameState } from "./types.js";
import { victoryPoints } from "./stateMachine.js";

/**
 * Assert the engine's core invariants. Throws Error on the first violation.
 * @param where label included in messages (e.g. a seed) to locate failures.
 */
export function assertInvariants(s: GameState, where = "invariant"): void {
  for (const r of RESOURCES) {
    let total = s.bank[r];
    for (const p of s.players) total += p.hand[r];
    if (total !== 19) throw new Error(`[${where}] conservation broken for ${r}`);
    if (!(s.bank[r] >= 0)) throw new Error(`[${where}] negative bank ${r}`);
  }
  for (const p of s.players) {
    for (const r of RESOURCES) if (!(p.hand[r] >= 0)) throw new Error(`[${where}] negative hand p${p.id} ${r}`);
    if (!(p.piecesLeft.roads >= 0 && p.piecesLeft.settlements >= 0 && p.piecesLeft.cities >= 0))
      throw new Error(`[${where}] negative pieces p${p.id}`);
  }
  if (s.phase !== "gameOver") {
    for (const p of s.players)
      if (!(victoryPoints(s, p.id) < WINNING_VP))
        throw new Error(`[${where}] missed win: p${p.id} at ${victoryPoints(s, p.id)} VP`);
  }
}
