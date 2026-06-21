// The dedicated attack state machine (Issue 1bA). The single most complex,
// genuinely-novel piece of the engine lives here, isolated and exhaustively
// tested. It MUTATES the (already-cloned) state — flipping the Splash Pile,
// setting `awaiting`, and discarding played cards — but it does NOT apply damage
// or advance the turn. It returns an AttackOutcome; engine.ts owns the
// consequences (damage/soak/win/advance). That one-way dependency
// (engine -> attack -> deck) keeps the two modules acyclic.
//
//   THROW ──flip Splash──> [miss] ───────────────────────> attack ends, no damage
//                          [hit]  ─> DEFEND (target)
//                                     ├─ pass ─────────────────────> HIT  (damage)
//                                     ├─ Miss ─> ATTACKER_RESPOND (attacker)
//                                     │             ├─ pass ─> MISS (no damage)
//                                     │             ├─ Hit ──> back to DEFEND
//                                     │             └─ Wild ─> HIT  (damage)
//                                     ├─ Umbrella ─────────────────> MISS (no damage)
//                                     └─ Wild ─────────────────────> MISS (no damage)
//
// The Miss/Hit alternation is unbounded (D2) but self-limiting: every step
// consumes a card from a hand. MAX_ATTACK_ROUNDS is a pure backstop against bugs.

import { MAX_ATTACK_ROUNDS } from "./data.js";
import { flipSplash } from "./deck.js";
import type { AttackState, CardKind, GameState, Resolution } from "./types.js";

export type AttackOutcome = { resolved: true; hit: boolean } | { resolved: false };

/** Remove the first card of `kind` from a seat's hand into the main discard.
 *  Throws if the seat does not hold one (callers validate legality first). */
function discardOne(s: GameState, seat: number, kind: CardKind): void {
  const hand = s.players[seat]!.hand;
  const idx = hand.findIndex((c) => c.kind === kind);
  if (idx < 0) throw new Error(`seat ${seat} has no ${kind} to play`);
  const [card] = hand.splice(idx, 1);
  s.mainDiscard.push(card!);
}

/** Begin a basic Water Balloon attack: flip the Splash Pile and either resolve a
 *  Miss immediately or open the defender's ladder. */
export function startAttack(s: GameState, attackerSeat: number, targetSeat: number): AttackOutcome {
  const attack: AttackState = {
    attackerSeat,
    targetSeat,
    blockNumber: 1,
    damage: 1,
    blocked: false,
    rounds: 0,
  };
  const verdict = flipSplash(s);
  s.log.push(`seat ${attackerSeat} throws at seat ${targetSeat}: splash ${verdict}`);
  // Always set `attack` so finishAttack has its context. On a Miss the transient
  // DEFEND await is cleared immediately by finishAttack (within the same applyMove).
  s.awaiting = { seats: [targetSeat], kind: "DEFEND", attack };
  return verdict === "miss" ? { resolved: true, hit: false } : { resolved: false };
}

/** Advance the ladder with one DEFEND or ATTACKER_RESPOND resolution. */
export function advanceAttack(s: GameState, res: Resolution): AttackOutcome {
  const atk = s.awaiting.attack;
  if (!atk) throw new Error("no attack in progress");
  if (++atk.rounds > MAX_ATTACK_ROUNDS) return { resolved: true, hit: !atk.blocked };

  if (s.awaiting.kind === "DEFEND" && res.kind === "DEFEND") {
    switch (res.defense) {
      case "miss":
        discardOne(s, atk.targetSeat, "miss");
        atk.blocked = true;
        s.awaiting = { seats: [atk.attackerSeat], kind: "ATTACKER_RESPOND", attack: atk };
        return { resolved: false };
      case "umbrella":
        discardOne(s, atk.targetSeat, "umbrella");
        return { resolved: true, hit: false };
      case "wild_miss":
        discardOne(s, atk.targetSeat, "wild");
        return { resolved: true, hit: false };
      case "pass":
        // No block stands (a played Miss switches us to ATTACKER_RESPOND, so
        // `blocked` is always false here) -> the balloon lands.
        return { resolved: true, hit: true };
    }
  }

  if (s.awaiting.kind === "ATTACKER_RESPOND" && res.kind === "ATTACKER_RESPOND") {
    switch (res.respond) {
      case "hit":
        discardOne(s, atk.attackerSeat, "hit");
        atk.blocked = false;
        s.awaiting = { seats: [atk.targetSeat], kind: "DEFEND", attack: atk };
        return { resolved: false };
      case "wild_hit":
        discardOne(s, atk.attackerSeat, "wild");
        return { resolved: true, hit: true };
      case "pass":
        // The defender's un-cancelled Miss stands -> the balloon misses.
        return { resolved: true, hit: false };
    }
  }

  throw new Error(`illegal resolution ${res.kind} for await ${s.awaiting.kind}`);
}
