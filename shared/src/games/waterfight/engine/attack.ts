// The dedicated attack state machine (Issue 1bA). Isolated, exhaustively tested.
// It MUTATES the (already-cloned) state — setting `awaiting`, discarding played
// cards — but does NOT apply damage, advance the turn, or flip the Splash Pile
// (engine.ts owns the flip, damage, multi-target loop, and extra throws). The
// one-way dependency (engine -> attack -> deck) keeps the modules acyclic.
//
//   per target (resolved sequentially — E3):
//     DEFEND (target needs `blockNumber` blocks; Soaker negates hand-Miss — R2)
//       ├─ pass (under-blocked) ───────────────────────────> HIT (damage)
//       ├─ Miss  ─> missBlocks++; if < blockNumber stay, else ATTACKER_RESPOND
//       ├─ Umbrella ─> basic: uncancelable MISS │ Mega: -> ATTACKER_RESPOND (R1)
//       └─ Wild (as miss) ─────────────────────────────────> MISS
//     ATTACKER_RESPOND (attacker chips the block):
//       ├─ pass (block stands) ────────────────────────────> MISS
//       ├─ Hit  ─> removes ONE block (a Miss, or the whole Umbrella — R1); -> DEFEND
//       └─ Wild (as hit) ──────────────────────────────────> HIT
//
// MAX_ATTACK_ROUNDS backstops the otherwise-unbounded (D2) alternation.

import { MAX_ATTACK_ROUNDS } from "./data.js";
import { discardCard } from "./deck.js";
import type { AttackState, BigKind, CardKind, GameState, Resolution } from "./types.js";

export type AttackOutcome = { resolved: true; hit: boolean } | { resolved: false };

function discardOne(s: GameState, seat: number, kind: CardKind): void {
  const hand = s.players[seat]!.hand;
  const idx = hand.findIndex((c) => c.kind === kind);
  if (idx < 0) throw new Error(`seat ${seat} has no ${kind} to play`);
  discardCard(s, hand.splice(idx, 1)[0]!);
}

function isBlocked(atk: AttackState): boolean {
  return atk.umbrellaBlock || atk.missBlocks >= atk.blockNumber;
}

export function currentTarget(atk: AttackState): number {
  return atk.targets[atk.targetIdx]!;
}

export function bigStats(big: BigKind): { blockNumber: number; damage: number } {
  switch (big) {
    case "mega":
      return { blockNumber: 2, damage: 1 };
    case "giant":
      return { blockNumber: 1, damage: 2 };
    case "golden":
      return { blockNumber: 1, damage: 1 };
  }
}

/** Set up an attack against its target list and open the first target's ladder.
 *  engine.ts wraps this to insert a per-target reaction window when
 *  perTargetReactions is set (multi-target). */
export function openAttack(
  s: GameState,
  attackerSeat: number,
  targets: number[],
  kind: AttackState["kind"],
  blockNumber: number,
  damage: number,
  soaker: boolean,
  perTargetReactions: boolean,
): void {
  const attack: AttackState = {
    attackerSeat,
    targets,
    targetIdx: 0,
    kind,
    blockNumber,
    damage,
    soaker,
    perTargetReactions,
    redirectedSeats: [],
    missBlocks: 0,
    umbrellaBlock: false,
    rounds: 0,
  };
  s.awaiting = { seats: [targets[0]!], kind: "DEFEND", attack };
}

/** Reset the per-target ladder and open the current target's DEFEND. */
export function openTarget(s: GameState): void {
  const atk = s.awaiting.attack!;
  atk.missBlocks = 0;
  atk.umbrellaBlock = false;
  atk.rounds = 0;
  s.awaiting = { seats: [currentTarget(atk)], kind: "DEFEND", attack: atk };
}

/** Advance the current target's ladder with one DEFEND/ATTACKER_RESPOND resolution. */
export function advanceLadder(s: GameState, res: Resolution): AttackOutcome {
  const atk = s.awaiting.attack;
  if (!atk) throw new Error("no attack in progress");
  // The lobby MAX_REACTIONS dial soft-caps the back-and-forth (0 = unlimited),
  // never above the hard MAX_ATTACK_ROUNDS bug-backstop.
  const cap = s.options.maxReactions > 0 ? Math.min(s.options.maxReactions, MAX_ATTACK_ROUNDS) : MAX_ATTACK_ROUNDS;
  if (++atk.rounds > cap) return { resolved: true, hit: !isBlocked(atk) };

  if (s.awaiting.kind === "DEFEND" && res.kind === "DEFEND") {
    switch (res.defense) {
      case "miss":
        if (atk.soaker) throw new Error("Soaker Cannon negates hand-Miss"); // R2
        discardOne(s, currentTarget(atk), "miss");
        atk.missBlocks += 1;
        if (isBlocked(atk)) s.awaiting = { seats: [atk.attackerSeat], kind: "ATTACKER_RESPOND", attack: atk };
        return { resolved: false };
      case "umbrella":
        discardOne(s, currentTarget(atk), "umbrella");
        atk.umbrellaBlock = true;
        if (atk.blockNumber === 1) return { resolved: true, hit: false }; // R1: uncancelable vs a normal balloon
        s.awaiting = { seats: [atk.attackerSeat], kind: "ATTACKER_RESPOND", attack: atk }; // R1: Hit-cancelable vs Mega
        return { resolved: false };
      case "wild_miss":
        discardOne(s, currentTarget(atk), "wild");
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
          atk.umbrellaBlock = false; // R1: one Hit cancels the whole Umbrella; defender re-blocks
          atk.missBlocks = 0;
        } else {
          atk.missBlocks = Math.max(0, atk.missBlocks - 1);
        }
        s.awaiting = { seats: [currentTarget(atk)], kind: "DEFEND", attack: atk };
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
