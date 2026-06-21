// Code-level data validation for the Water Fight card pools — the structural
// checks JSON Schema can't express: main-deck composition, the three shop
// stacks, the event roster, and (most importantly) that the main / shop / event
// id ranges never collide. Returns a list of failure messages (empty => valid).
// Mirrors splendor/engine/validateData.ts; test-only (the build functions are
// the source of truth at runtime, this proves they stay self-consistent).
//
// The main deck is dialed (mainHit/mainMiss), so callers may validate a specific
// dial setting; the shop and event pools are fixed.

import {
  buildEventCards,
  buildMainDeck,
  buildStacks,
  DEFAULT_MAIN_HIT,
  DEFAULT_MAIN_MISS,
  EVENT_ID_BASE,
  EVENT_KINDS,
  EVENT_TOTAL,
  MAIN_DECK_COMPOSITION,
  SHOP_ID_BASE,
  SHOP_TOTAL,
  STACK_COMPOSITIONS,
  mainDeckSize,
} from "./data.js";
import type { Card, CardKind, StackId } from "./types.js";

const STACK_IDS: StackId[] = ["defense", "mischief", "attack"];
const MAIN_KINDS: CardKind[] = ["balloon", "miss", "hit", "treasure", "wild"];

/** Validate the built card pools for the given main-deck dials. Empty => valid. */
export function validateWaterFightData(
  mainHit: number = DEFAULT_MAIN_HIT,
  mainMiss: number = DEFAULT_MAIN_MISS,
): string[] {
  const fail: string[] = [];
  const check = (cond: boolean, msg: string): void => {
    if (!cond) fail.push(msg);
  };
  const countByKind = (cards: Card[]): Partial<Record<CardKind, number>> => {
    const m: Partial<Record<CardKind, number>> = {};
    for (const c of cards) m[c.kind] = (m[c.kind] ?? 0) + 1;
    return m;
  };
  const contiguousUnique = (ids: number[], lo: number, hi: number): boolean => {
    if (ids.length !== hi - lo + 1) return false;
    const sorted = [...ids].sort((a, b) => a - b);
    return sorted.every((id, i) => id === lo + i);
  };

  // --- main deck (dialed) ---
  const size = mainDeckSize(mainHit, mainMiss);
  const main = buildMainDeck(mainHit, mainMiss);
  check(main.length === size, `main deck size == ${size} (got ${main.length})`);
  check(contiguousUnique(main.map((c) => c.id), 1, size), `main ids are exactly 1..${size} (unique, contiguous)`);
  const mc = countByKind(main); // a kind with zero copies is absent from the map, so read via `?? 0`
  check((mc.balloon ?? 0) === MAIN_DECK_COMPOSITION.balloon, `main deck: ${MAIN_DECK_COMPOSITION.balloon} balloons (got ${mc.balloon ?? 0})`);
  check((mc.treasure ?? 0) === MAIN_DECK_COMPOSITION.treasure, `main deck: ${MAIN_DECK_COMPOSITION.treasure} treasures (got ${mc.treasure ?? 0})`);
  check((mc.wild ?? 0) === MAIN_DECK_COMPOSITION.wild, `main deck: ${MAIN_DECK_COMPOSITION.wild} wild (got ${mc.wild ?? 0})`);
  check((mc.hit ?? 0) === mainHit, `main deck: ${mainHit} hits (got ${mc.hit ?? 0})`);
  check((mc.miss ?? 0) === mainMiss, `main deck: ${mainMiss} misses (got ${mc.miss ?? 0})`);
  check(
    main.every((c) => MAIN_KINDS.includes(c.kind)),
    "the main deck holds only balloon/miss/hit/treasure/wild (every other card comes from the shop)",
  );

  // --- shop stacks (fixed) ---
  const stacks = buildStacks();
  const allShop: Card[] = STACK_IDS.flatMap((id) => stacks[id]);
  check(allShop.length === SHOP_TOTAL, `shop has ${SHOP_TOTAL} cards (got ${allShop.length})`);
  check(
    contiguousUnique(allShop.map((c) => c.id), SHOP_ID_BASE, SHOP_ID_BASE + SHOP_TOTAL - 1),
    `shop ids are exactly ${SHOP_ID_BASE}..${SHOP_ID_BASE + SHOP_TOTAL - 1} (unique, contiguous)`,
  );
  for (const id of STACK_IDS) {
    const got = countByKind(stacks[id]);
    const want = STACK_COMPOSITIONS[id];
    for (const kind of Object.keys(want) as CardKind[]) {
      check(got[kind] === want[kind], `stack ${id}: ${want[kind]} ${kind} (got ${got[kind] ?? 0})`);
    }
    check(
      (Object.keys(got) as CardKind[]).every((k) => want[k] !== undefined),
      `stack ${id} holds only its declared card kinds`,
    );
  }

  // --- events (fixed) ---
  check(EVENT_KINDS.length === EVENT_TOTAL, `${EVENT_TOTAL} event kinds (got ${EVENT_KINDS.length})`);
  check(new Set(EVENT_KINDS).size === EVENT_KINDS.length, "event kinds are unique");
  const events = buildEventCards(EVENT_KINDS);
  check(
    contiguousUnique(events.map((c) => c.id), EVENT_ID_BASE, EVENT_ID_BASE + EVENT_TOTAL - 1),
    `event ids are exactly ${EVENT_ID_BASE}..${EVENT_ID_BASE + EVENT_TOTAL - 1} (unique, contiguous)`,
  );
  check(events.every((c) => c.kind === "event"), "every built event card has kind 'event'");

  // --- cross-pool: the three id ranges must never overlap ---
  check(size < SHOP_ID_BASE, `the dialed main deck (max id ${size}) stays below the shop range (${SHOP_ID_BASE})`);
  check(SHOP_ID_BASE + SHOP_TOTAL <= EVENT_ID_BASE, `the shop range stays below the event range (${EVENT_ID_BASE})`);

  return fail;
}
