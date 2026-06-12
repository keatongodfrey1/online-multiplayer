/**
 * Space Chase - pure board/movement math. No Colyseus imports: everything
 * here is deterministic, synchronous, and unit-testable without a server.
 *
 * The room owns WHAT happens (card rules, shields, turn flow); this module
 * owns WHERE rockets end up (board clamps, portal traversal, landings) and
 * returns a step list the room translates into synced events.
 *
 * Implements the INTENDED rules from "Space Chase/MECHANICS_AND_RULINGS.md":
 *  - landing on a portal mouth by ANY means enters the portal (centralized
 *    in landOn(), which every terminal landing funnels through);
 *  - exiting a portal costs one extra move, overflow continues on the
 *    board in the same direction;
 *  - backing out (negative movement inside) exits at the entry mouth,
 *    also costing one move;
 *  - the justExitedPortal guard blocks immediate re-entry into the mouth
 *    just exited (cleared by the room at the owner's next turn start).
 */
import {
  CARD_DEFS,
  PortalDef,
  SC_FINISH,
  SC_PORTALS,
  SC_SIX_SEVEN_ID,
  SC_START,
  portalAt,
} from "@backbone/shared";

/** The mutable position fields of a seat (SpaceChaseSeat satisfies this). */
export interface SeatPos {
  position: number;
  portalId: number;
  portalProgress: number;
  portalForward: boolean;
  justExitedPortal: number;
}

/** One thing that happened during a movement, in order. */
export type MoveStep =
  | { kind: "move"; from: number; to: number }
  | { kind: "teleport"; from: number; to: number }
  | { kind: "enterPortal"; portalId: number; mouth: number }
  | { kind: "portalMove"; portalId: number; from: number; to: number }
  | { kind: "exitPortal"; portalId: number; mouth: number };

export function portalById(id: number): PortalDef | undefined {
  return SC_PORTALS.find((p) => p.id === id);
}

/**
 * Land on a board space after any movement/teleport. Sets position and
 * enters a portal if the space is a mouth (unless it is the mouth the
 * seat just exited). The ONLY way a rocket ever enters a portal.
 */
export function landOn(seat: SeatPos, space: number): MoveStep[] {
  seat.position = space;
  const portal = portalAt(space);
  if (!portal || space === seat.justExitedPortal) return [];
  if (space <= SC_START || space >= SC_FINISH) return []; // defensive; mouths are 1..67
  seat.portalId = portal.id;
  seat.portalProgress = 0;
  seat.portalForward = space === portal.a;
  return [{ kind: "enterPortal", portalId: portal.id, mouth: space }];
}

/** Leave whatever portal the seat is in without spending moves (teleports, swaps). */
function exitPortalSilently(seat: SeatPos): void {
  seat.portalId = 0;
  seat.portalProgress = 0;
  seat.portalForward = true;
}

/**
 * Move by `amount` spaces (negative = backward), through portals and
 * board clamps. Mutates `seat`; returns the steps that occurred.
 */
export function moveBy(seat: SeatPos, amount: number): MoveStep[] {
  if (amount === 0) return [];

  if (seat.portalId !== 0) {
    const portal = portalById(seat.portalId)!;
    const entryMouth = seat.portalForward ? portal.a : portal.b;
    const farMouth = seat.portalForward ? portal.b : portal.a;
    const progress = seat.portalProgress;
    const newProgress = progress + amount;

    if (newProgress >= 0 && newProgress <= portal.internal) {
      // Still inside the tunnel.
      seat.portalProgress = newProgress;
      return [{ kind: "portalMove", portalId: portal.id, from: progress, to: newProgress }];
    }

    const steps: MoveStep[] = [];
    if (newProgress > portal.internal) {
      // Cross the remaining internal spaces, spend 1 to step out the far
      // end, then continue forward on the board with what's left.
      const overflow = amount - (portal.internal - progress) - 1;
      if (portal.internal !== progress) {
        steps.push({ kind: "portalMove", portalId: portal.id, from: progress, to: portal.internal });
      }
      steps.push({ kind: "exitPortal", portalId: portal.id, mouth: farMouth });
      exitPortalSilently(seat);
      seat.position = farMouth;
      seat.justExitedPortal = farMouth;
      if (overflow > 0) steps.push(...moveBy(seat, overflow));
      return steps;
    }

    // newProgress < 0: back out the way we came in (exit costs 1 move),
    // remaining backward movement continues on the board.
    const remaining = newProgress + 1; // <= 0
    if (progress !== 0) {
      steps.push({ kind: "portalMove", portalId: portal.id, from: progress, to: 0 });
    }
    steps.push({ kind: "exitPortal", portalId: portal.id, mouth: entryMouth });
    exitPortalSilently(seat);
    seat.position = entryMouth;
    seat.justExitedPortal = entryMouth;
    if (remaining < 0) steps.push(...moveBy(seat, remaining));
    return steps;
  }

  // On the board.
  const from = seat.position;
  if (from >= SC_FINISH && amount > 0) return []; // already finished
  if (from === SC_START && amount < 0) return []; // can't go behind START
  const to = Math.max(SC_START, Math.min(from + amount, SC_FINISH));
  if (to === from) return [];
  const steps: MoveStep[] = [{ kind: "move", from, to }];
  if (to > SC_START && to < SC_FINISH) {
    steps.push(...landOn(seat, to));
  } else {
    seat.position = to; // START or Finish - never a portal mouth
  }
  return steps;
}

/**
 * Teleport straight to `space` (cards, attacks, swaps, send-to-START).
 * Exits any portal for free and ALWAYS allows entering a portal at the
 * destination (the re-entry guard only applies to walking back in).
 */
export function teleportTo(seat: SeatPos, space: number): MoveStep[] {
  const from = seat.position;
  if (seat.portalId !== 0) exitPortalSilently(seat);
  seat.justExitedPortal = 0;
  const steps: MoveStep[] = [{ kind: "teleport", from, to: space }];
  if (space > SC_START && space < SC_FINISH) {
    steps.push(...landOn(seat, space));
  } else {
    seat.position = space;
  }
  return steps;
}

/**
 * Collision scan, run once after a movement fully resolves: groups of 2+
 * rockets sharing a board space all go back to START. Exempt: START,
 * Finish, and rockets inside a portal. Returns groups of seat indices.
 *
 * Ruling: collisions ignore shields - GAME_RULES §7 states the rule with
 * no shield exception, and the shield (§6) blocks effects "aimed at you";
 * a collision is a board hazard, not an attack. Matches the original game.
 */
export function scanCollisions(seats: ReadonlyArray<SeatPos & { gone: boolean }>): number[][] {
  const bySpace = new Map<number, number[]>();
  seats.forEach((seat, i) => {
    if (seat.gone || seat.portalId !== 0) return;
    if (seat.position <= SC_START || seat.position >= SC_FINISH) return;
    const group = bySpace.get(seat.position);
    if (group) group.push(i);
    else bySpace.set(seat.position, [i]);
  });
  return [...bySpace.values()].filter((g) => g.length >= 2);
}

/**
 * For Rocket (#35): the seat index of the nearest live player strictly
 * ahead of `me` (in-portal players count at their entry-mouth position,
 * which is what `position` holds). -1 if nobody is ahead.
 */
export function nearestAhead(
  seats: ReadonlyArray<SeatPos & { gone: boolean }>,
  me: number
): number {
  const myPos = seats[me]!.position;
  let best = -1;
  seats.forEach((seat, i) => {
    if (i === me || seat.gone) return;
    if (seat.position <= myPos) return;
    if (best === -1 || seat.position < seats[best]!.position) best = i;
  });
  return best;
}

// ── Deterministic RNG + deck ──
// Deliberately a copy of the pinned PRNG (not imported from another
// game's engine): games stay independent, and changing this algorithm
// would change every shuffle for a given seed.

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

/**
 * The shuffled 42-card pile: every unique card once plus a SECOND copy
 * of #30 "6-7" (its power triggers on a player's second draw of it).
 * Convention: the TOP of the deck is the LAST element (draw = pop()).
 */
export function buildDeck(rng: () => number): number[] {
  const ids = CARD_DEFS.map((c) => c.id);
  ids.push(SC_SIX_SEVEN_ID);
  return shuffle(ids, rng);
}
