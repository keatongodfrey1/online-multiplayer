/**
 * Deterministic PRNG for Space Chase. A deliberate copy of the pinned
 * mulberry32 (the framework keeps each game's engine independent - do not
 * import another game's rng). Changing this algorithm changes every shuffle
 * and dice stream for a given seed, so a saved game would no longer resume
 * identically; treat it as frozen.
 *
 * The engine keeps its rng position as a plain number (`rngState`) inside the
 * GameState so the whole state stays serializable (for saves) and pure. Call
 * `nextRandom(s)` to advance that stream; `mulberry32`/`shuffle` are the
 * standalone forms used at create time and in tests.
 */

/** mulberry32: tiny, fast, deterministic 32-bit PRNG. Returns floats in [0,1). */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return function () {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Advance a stored rng accumulator one step. `holder.rngState` is the same
 * `a` mulberry32 keeps internally, exposed so it can live in (and serialize
 * with) the game state. Returns a float in [0,1) and writes back the
 * advanced accumulator.
 */
export function nextRandom(holder: { rngState: number }): number {
  let a = holder.rngState | 0;
  a = (a + 0x6d2b79f5) | 0;
  let t = Math.imul(a ^ (a >>> 15), 1 | a);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
  holder.rngState = a >>> 0;
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
}

/** Fisher-Yates using the supplied RNG. Returns a new array; input untouched. */
export function shuffle<T>(arr: readonly T[], rng: () => number): T[] {
  const a = arr.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    const tmp = a[i]!;
    a[i] = a[j]!;
    a[j] = tmp;
  }
  return a;
}
