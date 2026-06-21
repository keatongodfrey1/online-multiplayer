// The dedicated attack state machine (Issue 1bA). The single most complex,
// genuinely-novel piece of the engine, isolated and exhaustively tested. It
// MUTATES the (already-cloned) state — flipping the Splash Pile, setting
// `awaiting`, discarding played cards — but does NOT apply damage or advance the
// turn. It returns an AttackOutcome; engine.ts owns the consequences. That
// one-way dependency (engine -> attack -> deck) keeps the modules acyclic.
//
//   THROW ──flip Splash──> [miss] ──────────────────────────> attack ends, no damage
//   PLAY_BIG (Mega/Giant/Golden) ──auto-connect (no flip)──┐
//   [hit] ─────────────────────────────────────────────────┴─> DEFEND (target)
//        DEFEND (target needs `blockNumber` blocks):
//          ├─ pass (under-blocked) ───────────────────────────> HIT (damage)
//          ├─ Miss  ─> missBlocks++; if < blockNumber stay DEFEND, else ATTACKER_RESPOND
//          ├─ Umbrella ─> basic: uncancelable MISS │ Mega: full block -> ATTACKER_RESPOND (R1)
//          └─ Wild (as miss) ─────────────────────────────────> MISS (unblockable)
//        ATTACKER_RESPOND (attacker chips the block):
//          ├─ pass (block stands) ────────────────────────────> MISS
//          ├─ Hit  ─> removes ONE block (a Miss, or the whole Umbrella — R1); back to DEFEND
//          └─ Wild (as hit) ──────────────────────────────────> HIT (unblockable)
//
// The Miss/Hit alternation is unbounded (D2) but self-limiting (every step
// consumes a hand card). MAX_ATTACK_ROUNDS is a pure backstop against bugs.

import { MAX_ATTACK_ROUNDS } from "./data.js";
import { discardCard, flipSplash } from "./deck.js";
import type { AttackState, BigKind, CardKind, GameState, Resolution } from "./types.js";

export type AttackOutcome = { resolved: true; hit: boolean } | { resolved: false };

/** Remove the first card of `kind` from a seat's hand to the right discard pile. */
function discardOne(s: GameState, seat: number, kind: CardKind): void {
  const hand = s.players[seat]!.hand;
  const idx = hand.findIndex((c) => c.kind === kind);
  if (idx < 0) throw new Error(`seat ${seat} has no ${kind} to play`);
  const [card] = hand.splice(idx, 1);
  discardCard(s, card!);
}

function isBlocked(atk: AttackState): boolean {
  return atk.umbrellaBlock || atk.missBlocks >= atk.blockNumber;
}

function bigStats(big: BigKind): { blockNumber: number; damage: number } {
  switch (big) {
    case "mega":
      return { blockNumber: 2, damage: 1 };
    case "giant":
      return { blockNumber: 1, damage: 2 };
    case "golden":
      return { blockNumber: 1, damage: 1 };
  }
}

function openLadder(
  s: GameState,
  attackerSeat: number,
  targetSeat: number,
  kind: AttackState["kind"],
  blockNumber: number,
  damage: number,
): void {
  const attack: AttackState = {
    attackerSeat,
    targetSeat,
    kind,
    blockNumber,
    damage,
    missBlocks: 0,
    umbrellaBlock: false,
    rounds: 0,
  };
  s.awaiting = { seats: [targetSeat], kind: "DEFEND", attack };
}

/** Begin a basic Water Balloon attack: flip the Splash Pile, then either resolve
 *  a Miss or open the defender's ladder on a Hit. */
export function startAttack(s: GameState, attackerSeat: number, targetSeat: number): AttackOutcome {
  const verdict = flipSplash(s);
  s.log.push(`seat ${attackerSeat} throws at seat ${targetSeat}: splash ${verdict}`);
  openLadder(s, attackerSeat, targetSeat, "basic", 1, 1);
  return verdict === "miss" ? { resolved: true, hit: false } : { resolved: false };
}

/** Begin a big attack (Mega/Giant/Golden): auto-connect, no Splash flip (E2). */
export function startBigAttack(
  s: GameState,
  attackerSeat: number,
  targetSeat: number,
  big: BigKind,
): AttackOutcome {
  const { blockNumber, damage } = bigStats(big);
  s.log.push(`seat ${attackerSeat} plays ${big} at seat ${targetSeat} (auto-connect)`);
  openLadder(s, attackerSeat, targetSeat, big, blockNumber, damage);
  return { resolved: false };
}

/** Advance the ladder with one DEFEND or ATTACKER_RESPOND resolution. */
export function advanceAttack(s: GameState, res: Resolution): AttackOutcome {
  const atk = s.awaiting.attack;
  if (!atk) throw new Error("no attack in progress");
  if (++atk.rounds > MAX_ATTACK_ROUNDS) return { resolved: true, hit: !isBlocked(atk) };

  if (s.awaiting.kind === "DEFEND" && res.kind === "DEFEND") {
    switch (res.defense) {
      case "miss":
        discardOne(s, atk.targetSeat, "miss");
        atk.missBlocks += 1;
        // Fully blocked -> attacker may chip it; otherwise the defender adds more.
        if (isBlocked(atk)) s.awaiting = { seats: [atk.attackerSeat], kind: "ATTACKER_RESPOND", attack: atk };
        return { resolved: false };
      case "umbrella":
        discardOne(s, atk.targetSeat, "umbrella");
        atk.umbrellaBlock = true;
        if (atk.blockNumber === 1) return { resolved: true, hit: false }; // R1: uncancelable vs a normal balloon
        s.awaiting = { seats: [atk.attackerSeat], kind: "ATTACKER_RESPOND", attack: atk }; // R1: Hit-cancelable vs Mega
        return { resolved: false };
      case "wild_miss":
        discardOne(s, atk.targetSeat, "wild");
        return { resolved: true, hit: false };
      case "pass":
        return { resolved: true, hit: !isBlocked(atk) };
    }
  }

  if (s.awaiting.kind === "ATTACKER_RESPOND" && res.kind === "ATTACKER_RESPOND") {
    switch (res.respond) {
      case "hit":
        discardOne(s, atk.attackerSeat, "hit");
        if (atk.umbrellaBlock) {
          atk.umbrellaBlock = false; // R1: one Hit cancels the whole Umbrella; defender re-blocks to full
          atk.missBlocks = 0;
        } else {
          atk.missBlocks = Math.max(0, atk.missBlocks - 1);
        }
        s.awaiting = { seats: [atk.targetSeat], kind: "DEFEND", attack: atk };
        return { resolved: false };
      case "wild_hit":
        discardOne(s, atk.attackerSeat, "wild");
        return { resolved: true, hit: true };
      case "pass":
        return { resolved: true, hit: false };
    }
  }

  throw new Error(`illegal resolution ${res.kind} for await ${s.awaiting.kind}`);
}
