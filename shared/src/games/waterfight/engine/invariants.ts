// Structural invariants. Throws on the first violation. Run after EVERY reduce
// in tests/fuzz — the load-bearing one is "<= 1 living but game not over", which
// catches an attack-state-machine soft-lock (the failure mode the eng review
// flagged as critical).

import { MAIN_DECK_SIZE } from "./data.js";
import { livingSeats } from "./engine.js";
import type { GameState } from "./types.js";

export function assertInvariants(s: GameState): void {
  // --- main card conservation: count only main-deck cards (ids 1..MAIN_DECK_SIZE)
  //     across deck + discard + hands. Shop/big/injected cards (other ids) are a
  //     separate pool and are intentionally ignored here. ---
  const ids = new Set<number>();
  let mainCount = 0;
  const countMain = (c: { id: number }): void => {
    if (c.id >= 1 && c.id <= MAIN_DECK_SIZE) {
      mainCount++;
      ids.add(c.id);
    }
  };
  for (const c of s.mainDeck) countMain(c);
  for (const c of s.mainDiscard) countMain(c);
  for (const p of s.players) for (const c of p.hand) countMain(c);
  if (mainCount !== MAIN_DECK_SIZE) throw new Error(`main card conservation: ${mainCount} != ${MAIN_DECK_SIZE}`);
  if (ids.size !== MAIN_DECK_SIZE) throw new Error(`duplicate or missing main card ids: ${ids.size} != ${MAIN_DECK_SIZE}`);
  // The main deck itself must never hold a non-main card (a reshuffle mis-route).
  for (const c of s.mainDeck) if (c.id < 1 || c.id > MAIN_DECK_SIZE) throw new Error(`non-main card ${c.id} in main deck`);

  // --- splash conservation (pile + discard) ---
  const splashCount = s.splashPile.length + s.splashDiscard.length;
  const splashTotal = s.options.splashHit + s.options.splashMiss;
  if (splashCount !== splashTotal) throw new Error(`splash conservation: ${splashCount} != ${splashTotal}`);

  // --- per-player ---
  for (const p of s.players) {
    if (p.lives < 0 || p.lives > s.options.startingLives) throw new Error(`seat ${p.seat} lives out of range: ${p.lives}`);
    if (p.out !== (p.lives <= 0)) throw new Error(`seat ${p.seat} out flag mismatch (lives=${p.lives}, out=${p.out})`);
  }

  // --- living / over consistency (the soft-lock detector) ---
  const living = livingSeats(s);
  if (!s.over && living.length <= 1) throw new Error(`<= 1 living but game not over (living=${living.length})`);

  if (s.over) {
    if (s.winner !== null && s.players[s.winner]?.out) throw new Error("declared winner is soaked");
  } else {
    if (s.awaiting.seats.length === 0) throw new Error("not over but nobody is awaited");
    const seat = s.awaiting.seats[0]!;
    if (s.players[seat]?.out) throw new Error(`awaiting a soaked seat ${seat}`);
    // An attack in progress must have a target that is still alive.
    if (s.awaiting.attack) {
      const t = s.players[s.awaiting.attack.targetSeat];
      if (!t || t.out) throw new Error("attack targets a soaked/absent seat");
    }
  }
}
