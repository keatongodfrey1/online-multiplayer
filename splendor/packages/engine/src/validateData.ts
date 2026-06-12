// Code-level data validation (SPEC §11/§19) — the checks JSON Schema cannot
// express. Returns a list of failure messages (empty array => valid).

import { Card, Color, COLORS, GameData, Noble, Tier } from "./types";

const TIERS: Tier[] = [1, 2, 3];

export function validateGameData(data: GameData): string[] {
  const fail: string[] = [];
  const check = (cond: boolean, msg: string) => {
    if (!cond) fail.push(msg);
  };
  const cards: Card[] = data.cards;
  const nobles: Noble[] = data.nobles;

  // cards: structure
  check(cards.length === 90, "exactly 90 cards");
  const ids = cards.map((c) => c.id).sort((a, b) => a - b);
  check(JSON.stringify(ids) === JSON.stringify(Array.from({ length: 90 }, (_, i) => i + 1)),
    "card ids are exactly 1..90 (unique, contiguous)");
  const perTier: Record<number, number> = {};
  for (const c of cards) perTier[c.tier] = (perTier[c.tier] ?? 0) + 1;
  check(perTier[1] === 40 && perTier[2] === 30 && perTier[3] === 20, "tier split is 40 / 30 / 20");
  for (const t of TIERS) {
    for (const col of COLORS) {
      const n = cards.filter((c) => c.tier === t && c.bonus === col).length;
      const expect = t === 1 ? 8 : t === 2 ? 6 : 4;
      check(n === expect, `tier ${t}: ${expect} cards of ${col} (got ${n})`);
    }
  }

  // cards: points & costs
  const dist = (t: Tier) => {
    const m: Record<number, number> = {};
    for (const c of cards) if (c.tier === t) m[c.points] = (m[c.points] ?? 0) + 1;
    return m;
  };
  check(JSON.stringify(dist(1)) === JSON.stringify({ 0: 35, 1: 5 }), "tier 1 point distribution {0:35,1:5}");
  check(JSON.stringify(dist(2)) === JSON.stringify({ 1: 10, 2: 15, 3: 5 }), "tier 2 point distribution {1:10,2:15,3:5}");
  check(JSON.stringify(dist(3)) === JSON.stringify({ 3: 5, 4: 10, 5: 5 }), "tier 3 point distribution {3:5,4:10,5:5}");
  check(cards.reduce((s, c) => s + c.points, 0) === 140, "total prestige across all cards == 140");
  check(cards.every((c) => COLORS.every((col) => typeof c.cost[col] === "number")), "every cost has the 5 gem colors");
  check(cards.every((c) => COLORS.every((col) => c.cost[col] >= 0 && c.cost[col] <= 7)), "all cost values in 0..7");
  check(cards.every((c) => (COLORS as readonly string[]).includes(c.bonus)), "all bonuses are valid gem colors");
  const example = cards.filter(
    (c) => c.tier === 3 && c.bonus === "blue" && c.points === 4 &&
      c.cost.white === 6 && c.cost.blue === 3 && c.cost.black === 3 && c.cost.green === 0 && c.cost.red === 0,
  );
  check(example.length === 1, "official rulebook example card present (T3 blue, 4pt, 6w+3u+3k)");
  const t3 = cards.filter((c) => c.tier === 3);
  check(Math.abs(t3.reduce((s, c) => s + c.points, 0) / t3.length - 4.0) < 1e-9, "tier-3 average points == 4.0");

  // nobles
  check(nobles.length === 10, "exactly 10 nobles");
  const nids = nobles.map((n) => n.id).sort((a, b) => a - b);
  check(JSON.stringify(nids) === JSON.stringify(Array.from({ length: 10 }, (_, i) => i + 1)), "noble ids are exactly 1..10");
  check(nobles.every((n) => n.points === 3), "every noble worth 3 points");
  let shapeOk = true;
  for (const n of nobles) {
    const nonzero = COLORS.map((c) => n.requirement[c]).filter((v) => v > 0).sort((a, b) => a - b);
    const is44 = JSON.stringify(nonzero) === JSON.stringify([4, 4]);
    const is333 = JSON.stringify(nonzero) === JSON.stringify([3, 3, 3]);
    if (!is44 && !is333) shapeOk = false;
  }
  check(shapeOk, "every noble is exactly two colors x4 OR three colors x3");
  const appearances: Record<Color, number> = { white: 0, blue: 0, green: 0, red: 0, black: 0 };
  for (const n of nobles) for (const c of COLORS) if (n.requirement[c] > 0) appearances[c] += 1;
  check(COLORS.every((c) => appearances[c] === 5), `noble color appearances symmetric (5 each); got ${JSON.stringify(appearances)}`);

  // meta.checksums cross-check (if present)
  const meta = data.meta as { checksums?: Record<string, unknown> } | undefined;
  const cs = meta?.checksums;
  if (cs) {
    check(cs.totalCards === 90, "meta.checksums.totalCards == 90");
    check(cs.totalPrestigeOnAllCards === 140, "meta.checksums.totalPrestige == 140");
    check(JSON.stringify(cs.nobleColorAppearances) === JSON.stringify({ white: 5, blue: 5, green: 5, red: 5, black: 5 }),
      "meta.checksums noble appearances == 5 each");
  }

  return fail;
}
