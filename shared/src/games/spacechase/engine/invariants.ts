/**
 * Structural invariants for the Space Chase engine. Throws on the first
 * violation. Run after EVERY applyMove / applyResolution / applyLeave in the
 * tests and the fuzz, and as the final gate in the save validator.
 *
 * Three jobs:
 *   1. card conservation (the 42-card pile: every id once, #30 twice) + board
 *      / portal position ranges (the original checks, preserved);
 *   2. over / winner consistency (a declared winner is a real, non-gone seat;
 *      a finished game stops awaiting input);
 *   3. the SOFT-LOCK detector - a running game must always have a seat that can
 *      act: the awaited seat exists, is not gone, and has a legal move or a
 *      deterministic auto-resolve pending (legalActionExists). A game that can
 *      do nothing is a dead end no player can escape.
 */
import { SC_FINISH, SC_SIX_SEVEN_ID } from "../constants.js";
import { portalById } from "./board.js";
import { legalActionExists } from "./engine.js";
import type { GameState } from "./types.js";

export function assertInvariants(state: GameState): void {
  // --- card conservation: the full 42-card pile lives across deck + discard ---
  const counts = new Map<number, number>();
  for (const id of [...state.deck, ...state.discard]) counts.set(id, (counts.get(id) ?? 0) + 1);
  for (let id = 1; id <= 41; id++) {
    const expected = id === SC_SIX_SEVEN_ID ? 2 : 1;
    if ((counts.get(id) ?? 0) !== expected) throw new Error(`card ${id}: expected ${expected} in pile`);
  }
  if (counts.size !== 41) throw new Error("unknown card id in pile");
  if (state.deck.length + state.discard.length !== 42) throw new Error("pile is not 42 cards");

  // --- per-seat board / portal position ranges ---
  for (const p of state.players) {
    if (p.position < 0 || p.position > SC_FINISH) throw new Error("position out of range");
    if (p.portalId < 0 || p.portalId > 3) throw new Error("bad portalId");
    if (p.portalId !== 0) {
      const def = portalById(p.portalId);
      if (!def || p.portalProgress < 0 || p.portalProgress > def.internal) throw new Error("bad portal progress");
    }
  }

  // --- over / winner consistency ---
  if (state.over) {
    // A finished game names a real, present winner (or null only when the room
    // ended it for abandonment) and stops asking anyone for input.
    if (state.winner !== null) {
      const w = state.players[state.winner];
      if (!w) throw new Error("winner is not a real seat");
      if (w.gone) throw new Error("declared winner has left the race");
    }
    if (state.awaiting.inputType !== "") throw new Error("game over but still awaiting input");
  } else {
    // --- the soft-lock detector ---
    if (state.winner !== null) throw new Error("winner set but game not over");
    const seat = state.players[state.awaiting.seat];
    if (!seat) throw new Error("awaiting a seat that does not exist");
    if (seat.gone) throw new Error(`awaiting a seat that has left the race (seat ${state.awaiting.seat})`);
    if (!legalActionExists(state)) {
      throw new Error(`soft-lock: awaited seat ${state.awaiting.seat} (${state.awaiting.inputType}) has no legal action`);
    }
  }
}
