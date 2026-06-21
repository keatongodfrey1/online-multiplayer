// Structural invariants. Throws on the first violation. Run after EVERY reduce
// in tests/fuzz — the load-bearing one is "<= 1 living but game not over", which
// catches an attack-state-machine soft-lock (the failure mode the eng review
// flagged as critical).

import { SHOP_ID_BASE, SHOP_TOTAL } from "./data.js";
import { livingSeats } from "./engine.js";
import type { GameState } from "./types.js";

export function assertInvariants(s: GameState): void {
  // --- main card conservation: count only main-deck cards (ids 1..mainIdMax)
  //     across deck + discard + hands. Shop/big/injected cards (other ids) are a
  //     separate pool and are intentionally ignored here. ---
  const max = s.mainIdMax;
  const ids = new Set<number>();
  let mainCount = 0;
  const countMain = (c: { id: number }): void => {
    if (c.id >= 1 && c.id <= max) {
      mainCount++;
      ids.add(c.id);
    }
  };
  for (const c of s.mainDeck) countMain(c);
  for (const c of s.mainDiscard) countMain(c);
  for (const p of s.players) for (const c of p.hand) countMain(c);
  if (mainCount !== max) throw new Error(`main card conservation: ${mainCount} != ${max}`);
  if (ids.size !== max) throw new Error(`duplicate or missing main card ids: ${ids.size} != ${max}`);
  // The main deck may only hold main-deck cards or Events (a reshuffle mis-route
  // would surface a shop/big card here).
  for (const c of s.mainDeck) {
    if (c.kind !== "event" && (c.id < 1 || c.id > max)) throw new Error(`non-main card ${c.id} in main deck`);
  }
  // Events live ONLY in the main deck + main discard (resolve-on-draw, never held).
  const eventOutsideDeck = (c: { kind: string }): boolean => c.kind === "event";
  for (const p of s.players) for (const c of p.hand) if (eventOutsideDeck(c)) throw new Error(`Event card in seat ${p.seat}'s hand`);
  for (const st of ["defense", "mischief", "attack"] as const) for (const c of s.stacks[st]) if (eventOutsideDeck(c)) throw new Error("Event card in a shop stack");
  for (const c of s.usedPile) if (eventOutsideDeck(c)) throw new Error("Event card in the usedPile");

  // --- splash conservation (pile + discard) ---
  const splashCount = s.splashPile.length + s.splashDiscard.length;
  const splashTotal = s.options.splashHit + s.options.splashMiss;
  if (splashCount !== splashTotal) throw new Error(`splash conservation: ${splashCount} != ${splashTotal}`);

  // --- shop conservation: shop-id cards across stacks + hands + usedPile ---
  const shopIds = new Set<number>();
  let shopCount = 0;
  const countShop = (c: { id: number }): void => {
    if (c.id >= SHOP_ID_BASE && c.id < SHOP_ID_BASE + SHOP_TOTAL) {
      shopCount++;
      shopIds.add(c.id);
    }
  };
  for (const st of ["defense", "mischief", "attack"] as const) for (const c of s.stacks[st]) countShop(c);
  for (const p of s.players) for (const c of p.hand) countShop(c);
  for (const c of s.usedPile) countShop(c);
  if (shopCount !== SHOP_TOTAL) throw new Error(`shop card conservation: ${shopCount} != ${SHOP_TOTAL}`);
  if (shopIds.size !== SHOP_TOTAL) throw new Error(`duplicate or missing shop ids: ${shopIds.size} != ${SHOP_TOTAL}`);

  // --- per-player ---
  for (const p of s.players) {
    if (p.lives < 0 || p.lives > s.options.startingLives) throw new Error(`seat ${p.seat} lives out of range: ${p.lives}`);
    if (p.out !== (p.lives <= 0)) throw new Error(`seat ${p.seat} out flag mismatch (lives=${p.lives}, out=${p.out})`);
    if (p.stormCloud && !p.out) throw new Error(`seat ${p.seat} is a Storm Cloud but not out`);
    if (s.phase === "sudden-death" && p.stormCloud && !p.out) throw new Error("Storm Cloud acting in Sudden-Death");
  }

  // --- pending action / reaction window consistency ---
  if (s.awaiting.kind === "REACT") {
    // Either a pre-flip pending action OR a mid-attack per-target reaction.
    if (!s.pending && !s.awaiting.attack) throw new Error("REACT window without a pending action or attack");
    if (s.pending && s.players[s.pending.target]?.out) throw new Error("reaction targets a soaked seat");
  } else if (s.pending) {
    throw new Error("pending action set outside a REACT window");
  }

  // --- living / over consistency (the soft-lock detector) ---
  const living = livingSeats(s);
  if (!s.over && living.length <= 1) throw new Error(`<= 1 living but game not over (living=${living.length})`);

  if (s.over) {
    if (s.winner !== null && s.players[s.winner]?.out) throw new Error("declared winner is soaked");
  } else {
    if (s.awaiting.seats.length === 0) throw new Error("not over but nobody is awaited");
    const seat = s.awaiting.seats[0]!;
    const ap = s.players[seat];
    // A Storm Cloud legitimately acts while `out`: its MOVE turn, and ATTACKER_RESPOND
    // while it is splashing (it may play Hit). Any other await of an out seat
    // (DEFEND/REACT/DISCARD/EXTRA_THROW) is a bug.
    const stormOk = ap?.stormCloud && (s.awaiting.kind === "MOVE" || s.awaiting.kind === "ATTACKER_RESPOND");
    if (ap?.out && !stormOk) {
      throw new Error(`awaiting a soaked seat ${seat} (kind ${s.awaiting.kind})`);
    }
    // An attack in progress must have a CURRENT target that is still alive.
    if (s.awaiting.attack) {
      const atk = s.awaiting.attack;
      const t = s.players[atk.targets[atk.targetIdx]!];
      if (!t || t.out) throw new Error("attack targets a soaked/absent seat");
    }
  }
}
