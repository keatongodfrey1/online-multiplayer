/**
 * Deterministic PRNG for Paper.io. A deliberate copy of the pinned mulberry32
 * (the framework keeps each game's engine independent - do not import another
 * game's rng). A fixed seed gives a reproducible game: identical home
 * placement and identical bot decisions, which is what the engine/room tests
 * rely on. Treat the algorithm as frozen.
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
