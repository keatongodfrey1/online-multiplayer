// Structural invariants (SPEC §19), including NON-NEGATIVITY — the check a
// sum-only conservation test silently misses. Throws on the first violation.

import { GOLD_TOKENS, TOKENS_PER_GEM_BY_PLAYERS } from "./data.js";
import { playerPoints, totalTokens } from "./engine.js";
import { COLORS, GameState, Tier } from "./types.js";

const TIERS: Tier[] = [1, 2, 3];

export function assertInvariants(s: GameState): void {
  const N = s.players.length;
  const gem = TOKENS_PER_GEM_BY_PLAYERS[N];

  for (const c of COLORS) {
    if (s.supplyGems[c] < 0) throw new Error(`negative bank gem ${c}`);
    let total = s.supplyGems[c];
    for (const p of s.players) total += p.gems[c];
    if (total !== gem) throw new Error(`token conservation ${c}: ${total} != ${gem}`);
  }

  if (s.supplyGold < 0 || s.supplyGold > GOLD_TOKENS) throw new Error(`bank gold out of range: ${s.supplyGold}`);
  let goldTotal = s.supplyGold;
  for (const p of s.players) goldTotal += p.gold;
  if (goldTotal !== GOLD_TOKENS) throw new Error("gold conservation");

  let cardCount = 0;
  for (const t of TIERS) {
    cardCount += s.decks[t].length;
    for (const x of s.market[t]) if (x) cardCount += 1;
  }
  for (const p of s.players) cardCount += p.reserved.length + p.built.length;
  if (cardCount !== 90) throw new Error(`card conservation: ${cardCount} != 90`);

  let nobleCount = s.nobles.length;
  for (const p of s.players) nobleCount += p.nobles.length;
  if (nobleCount !== N + 1) throw new Error(`noble conservation: ${nobleCount} != ${N + 1}`);

  for (const p of s.players) {
    for (const c of COLORS) if (p.gems[c] < 0) throw new Error(`NEGATIVE TOKEN seat ${p.seat} ${c}`);
    if (p.gold < 0) throw new Error(`NEGATIVE GOLD seat ${p.seat}`);
    if (p.reserved.length > 3) throw new Error(`reserved > 3 seat ${p.seat}`);
    // The >10 limit is a between-turns constraint; a player may transiently exceed
    // it only while they are the one being asked to discard (SPEC §6 step 3).
    const discardingNow = s.awaiting.inputType === "DISCARD" && s.awaiting.seat === p.seat;
    if (totalTokens(p) > 10 && !discardingNow) throw new Error(`tokens > 10 seat ${p.seat}: ${totalTokens(p)}`);
    let built = 0;
    for (const c of p.built) built += c.points;
    if (playerPoints(p) !== built + 3 * p.nobles.length) throw new Error("points derivation");
  }

  for (const t of TIERS) {
    if (s.market[t].length !== 4) throw new Error("market row not length 4");
    for (const x of s.market[t]) if (x === null && s.decks[t].length !== 0) throw new Error("empty slot but deck not exhausted");
  }
}
