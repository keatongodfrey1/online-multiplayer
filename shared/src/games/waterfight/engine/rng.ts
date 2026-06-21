// Deterministic PRNG + shuffle for the Water Fight engine.
//
// Unlike Splendor (which shuffles once at createGame), Water Fight reshuffles
// the main deck and the Splash Pile mid-game (deck-out). So the RNG state lives
// IN GameState (`rngState`) and advances in place — this keeps every transition
// pure (clone-then-mutate) AND deterministic across reshuffles + save/resume.
// Changing this algorithm changes all shuffles for a seed; bump engineVersion.

import type { GameState } from "./types.js";

/** mulberry32 step: advances s.rngState and returns a float in [0,1). */
export function rand(s: GameState): number {
  let a = s.rngState | 0;
  a = (a + 0x6d2b79f5) | 0;
  s.rngState = a >>> 0;
  let t = Math.imul(a ^ (a >>> 15), 1 | a);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
}

/** Fisher–Yates in place, consuming the game's RNG stream. */
export function shuffleInPlace<T>(arr: T[], s: GameState): void {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(rand(s) * (i + 1));
    const tmp = arr[i]!;
    arr[i] = arr[j]!;
    arr[j] = tmp;
  }
}
