// Decision policies for bots and fuzz tests. Each uses its OWN PRNG so it never
// perturbs the game's deterministic RNG stream.

import { legalMoves, legalResolutions } from "./engine.js";
import type { GameState, Move, Resolution } from "./types.js";

export interface Policy {
  /** Choose the active player's Main Action (always >= 1 option: END_TURN). */
  move(s: GameState): Move;
  /** Choose an out-of-turn ladder response. */
  resolve(s: GameState): Resolution;
}

function lcg(seed: number): () => number {
  let a = (seed >>> 0) || 0x9e3779b9;
  return () => {
    a = (Math.imul(a, 1664525) + 1013904223) >>> 0;
    return a / 4294967296;
  };
}

/** End-of-turn forced discard: drop the first `need` cards (any valid set works). */
function discardResolution(s: GameState): Resolution {
  const seat = s.awaiting.seats[0]!;
  const hand = s.players[seat]!.hand;
  const need = hand.length - s.options.handLimit;
  return { kind: "DISCARD", cardIds: hand.slice(0, need).map((c) => c.id) };
}

/** Picks uniformly at random among legal options. */
export class RandomPolicy implements Policy {
  private rng: () => number;
  constructor(seed: number) {
    this.rng = lcg(seed);
  }
  private pick<T>(arr: T[]): T {
    return arr[Math.floor(this.rng() * arr.length)]!;
  }
  move(s: GameState): Move {
    return this.pick(legalMoves(s));
  }
  resolve(s: GameState): Resolution {
    if (s.awaiting.kind === "DISCARD") return discardResolution(s);
    return this.pick(legalResolutions(s));
  }
}

/** Aggressive baseline: always throws if it can, always blocks/cancels if it can.
 *  Used to confirm games converge to a winner (not just terminate by cap). */
export class GreedyPolicy implements Policy {
  private rng: () => number;
  constructor(seed: number) {
    this.rng = lcg(seed ^ 0x55555555);
  }
  private pick<T>(arr: T[]): T {
    return arr[Math.floor(this.rng() * arr.length)]!;
  }
  move(s: GameState): Move {
    const throws = legalMoves(s).filter((m) => m.kind === "THROW" || m.kind === "STORM_THROW");
    return throws.length > 0 ? this.pick(throws) : { kind: "END_TURN" };
  }
  resolve(s: GameState): Resolution {
    if (s.awaiting.kind === "DISCARD") return discardResolution(s);
    const res = legalResolutions(s);
    const aggressive = res.filter(
      (r) =>
        (r.kind === "DEFEND" && r.defense !== "pass") ||
        (r.kind === "ATTACKER_RESPOND" && r.respond !== "pass"),
    );
    return aggressive.length > 0 ? this.pick(aggressive) : this.pick(res);
  }
}
