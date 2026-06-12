// Simple policies used by the fuzzer and as an AI baseline.
// Each policy is deterministic given its own seeded RNG.

import { affordable, legalMoves, totalTokens } from "./engine";
import { mulberry32 } from "./rng";
import { buyFromIsMarket, Card, Color, COLORS, GameState, Move, Resolution } from "./types";

function pick<T>(arr: T[], rng: () => number): T {
  return arr[Math.floor(rng() * arr.length)];
}

function cardForBuy(s: GameState, move: Extract<Move, { kind: "BUY" }>): Card {
  const seat = s.awaiting.seat;
  if (buyFromIsMarket(move.from)) return s.market[move.from.market.tier][move.from.market.index] as Card;
  const { cardId } = move.from.reserve;
  return s.players[seat].reserved.find((c) => c.id === cardId) as Card;
}

export interface Policy {
  move(s: GameState): Move | null; // null => no legal move (caller should pass)
  pickNoble(s: GameState): Resolution;
  discard(s: GameState): Resolution;
}

export class GreedyPolicy implements Policy {
  protected rng: () => number;
  constructor(seed = 1) {
    this.rng = mulberry32(seed);
  }
  move(s: GameState): Move | null {
    const moves = legalMoves(s);
    if (moves.length === 0) return null;
    const buys = moves.filter((m): m is Extract<Move, { kind: "BUY" }> => m.kind === "BUY");
    const takes3 = moves.filter((m) => m.kind === "TAKE_THREE");
    if (buys.length) {
      buys.sort((a, b) => {
        const ca = cardForBuy(s, a);
        const cb = cardForBuy(s, b);
        const pa = ca.points;
        const pb = cb.points;
        if (pa !== pb) return pb - pa;
        const sa = COLORS.reduce((x, c) => x + ca.cost[c], 0);
        const sb = COLORS.reduce((x, c) => x + cb.cost[c], 0);
        return sb - sa;
      });
      if (cardForBuy(s, buys[0]).points > 0 || takes3.length === 0) return buys[0];
    }
    if (takes3.length) return pick(takes3, this.rng);
    if (buys.length) return buys[0];
    const takes2 = moves.filter((m) => m.kind === "TAKE_TWO");
    if (takes2.length) return pick(takes2, this.rng);
    const reserves = moves.filter((m) => m.kind === "RESERVE");
    if (reserves.length) return pick(reserves, this.rng);
    return null;
  }
  pickNoble(s: GameState): Resolution {
    const choices = s.awaiting.nobleChoices ?? [];
    return { kind: "PICK_NOBLE", nobleId: Math.min(...choices) };
  }
  discard(s: GameState): Resolution {
    const p = s.players[s.awaiting.seat];
    const need = totalTokens(p) - 10;
    const gems: Partial<Record<Color, number>> = {};
    const held: Record<Color, number> = { ...p.gems };
    let gold = p.gold;
    let goldDrop = 0;
    for (let i = 0; i < need; i++) {
      let best: Color | null = null;
      for (const c of COLORS) if (held[c] > 0 && (best === null || held[c] > held[best])) best = c;
      if (best) {
        held[best] -= 1;
        gems[best] = (gems[best] ?? 0) + 1;
      } else {
        gold -= 1;
        goldDrop += 1;
      }
    }
    return { kind: "DISCARD", gems, gold: goldDrop };
  }
}

export class RandomPolicy extends GreedyPolicy {
  override move(s: GameState): Move | null {
    const moves = legalMoves(s);
    return moves.length ? pick(moves, this.rng) : null;
  }
  override pickNoble(s: GameState): Resolution {
    const choices = s.awaiting.nobleChoices ?? [];
    return { kind: "PICK_NOBLE", nobleId: pick(choices, this.rng) };
  }
}
