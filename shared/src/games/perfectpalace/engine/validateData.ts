// Code-level validation of The Perfect Palace static data — the structural
// checks JSON Schema can't express: the 18-card deck is the intended
// unique-id set, every referenced card id exists, the 30-square board is
// well-formed, and the cost/shop/point tables are positive and complete.
// Returns a list of failure messages (empty => valid). Test-only: the data
// modules are the source of truth at runtime; this proves they stay
// self-consistent. Mirrors waterfight/engine/validateData.ts.

import { BOARD, TOTAL_SQUARES } from "./board.js";
import { CARDS, TOTAL_CARDS } from "./cards.js";
import { PRICE, RECIPE, POINTS, STAFF_WEIGHT } from "./constants.js";
import { isValidResourceCard } from "./reducer.js";
import { RESOURCE_OPTIONS } from "./types.js";
import type { ResourceCard } from "./types.js";

export function validatePerfectPalaceData(): string[] {
  const fail: string[] = [];
  const check = (cond: boolean, msg: string): void => {
    if (!cond) fail.push(msg);
  };

  // ---- card deck: ids are exactly 1..TOTAL_CARDS, unique, with non-empty names ----
  check(CARDS.length === TOTAL_CARDS, `deck has ${TOTAL_CARDS} cards (got ${CARDS.length})`);
  const cardIds = CARDS.map((c) => c.id);
  const idSet = new Set(cardIds);
  check(idSet.size === cardIds.length, "card ids are unique");
  const sorted = [...cardIds].sort((a, b) => a - b);
  check(
    sorted.every((id, i) => id === i + 1),
    `card ids are exactly 1..${TOTAL_CARDS} (contiguous, no gaps)`,
  );
  for (const c of CARDS) {
    check(typeof c.name === "string" && c.name.length > 0, `card ${c.id} has a non-empty name`);
    check(!!c.effect && typeof c.effect.kind === "string", `card ${c.id} has a well-formed effect`);
    // Gain effects must carry a positive integer amount.
    const e = c.effect;
    if (e.kind === "gain-dollars" || e.kind === "gain-bricks" || e.kind === "gain-sticks") {
      check(Number.isInteger(e.amount) && e.amount > 0, `card ${c.id} gain amount is a positive integer`);
    }
    if (e.kind === "gain-bricks-and-sticks") {
      check(
        Number.isInteger(e.bricks) && e.bricks > 0 && Number.isInteger(e.sticks) && e.sticks > 0,
        `card ${c.id} gain-bricks-and-sticks amounts are positive integers`,
      );
    }
  }
  // The two cards the reducer references by literal id (Royal Pardon = 17,
  // Get the Bailiff = 18) must exist and carry the matching effect.
  const pardon = CARDS.find((c) => c.id === 17);
  check(!!pardon && pardon.effect.kind === "royal-pardon", "card 17 exists and is the Royal Pardon");
  const bailiff = CARDS.find((c) => c.id === 18);
  check(!!bailiff && bailiff.effect.kind === "get-bailiff", "card 18 exists and is Get the Bailiff");

  // ---- board: 30 squares numbered exactly 1..30, unique ----
  check(BOARD.length === TOTAL_SQUARES, `board has ${TOTAL_SQUARES} squares (got ${BOARD.length})`);
  const sqNums = BOARD.map((sq) => sq.number);
  check(new Set(sqNums).size === sqNums.length, "square numbers are unique");
  const sqSorted = [...sqNums].sort((a, b) => a - b);
  check(
    sqSorted.every((n, i) => n === i + 1),
    `square numbers are exactly 1..${TOTAL_SQUARES} (contiguous)`,
  );
  for (const sq of BOARD) {
    check(typeof sq.label === "string" && sq.label.length > 0, `square ${sq.number} has a non-empty label`);
    check(!!sq.effect && typeof sq.effect.kind === "string", `square ${sq.number} has a well-formed effect`);
    // Card-draw squares must request a positive count.
    if (sq.effect.kind === "draw-cards" || sq.effect.kind === "fortune-teller") {
      check(Number.isInteger(sq.effect.count) && sq.effect.count > 0, `square ${sq.number} draws a positive card count`);
    }
    if (sq.effect.kind === "invasion") {
      check(Number.isInteger(sq.effect.cost) && sq.effect.cost > 0, `square ${sq.number} invasion cost is a positive integer`);
    }
    if (sq.effect.kind === "lose-money") {
      check(Number.isInteger(sq.effect.amount) && sq.effect.amount > 0, `square ${sq.number} lose-money amount is a positive integer`);
    }
  }

  // ---- cost / recipe tables: every entry is a positive integer ----
  for (const [k, v] of Object.entries(PRICE)) {
    check(Number.isInteger(v) && v > 0, `PRICE.${k} is a positive integer (got ${v})`);
  }
  for (const [item, recipe] of Object.entries(RECIPE)) {
    for (const [k, v] of Object.entries(recipe)) {
      check(Number.isInteger(v) && v > 0, `RECIPE.${item}.${k} is a positive integer (got ${v})`);
    }
  }
  for (const [k, v] of Object.entries(POINTS)) {
    check(Number.isInteger(v) && v > 0, `POINTS.${k} is a positive integer (got ${v})`);
  }
  for (const [k, v] of Object.entries(STAFF_WEIGHT)) {
    check(Number.isInteger(v) && v > 0, `STAFF_WEIGHT.${k} is a positive integer (got ${v})`);
  }

  // ---- resource options: exactly 6 distinct, and the identity card built from
  //      them is a valid one-to-one mapping (every die face has an outcome) ----
  check(RESOURCE_OPTIONS.length === 6, `there are 6 resource options (got ${RESOURCE_OPTIONS.length})`);
  const optKeys = new Set(RESOURCE_OPTIONS.map((o) => JSON.stringify(o)));
  check(optKeys.size === 6, "the 6 resource options are distinct");
  const identity = [...RESOURCE_OPTIONS] as unknown as ResourceCard;
  check(isValidResourceCard(identity), "the identity resource card is a valid one-to-one mapping");

  return fail;
}
