// Card data + tuning constants for the Water Fight engine.

import type { Card, CardKind, EventKind, StackId } from "./types.js";

export const ENGINE_VERSION = "0.1.0";

/** Backstop on the attack ladder so a bug can never soft-lock the table. The
 *  unbounded Miss/Hit war is bounded in practice by cards in hand; this only
 *  ever fires if a transition bug fails to consume a card. */
export const MAX_ATTACK_ROUNDS = 500;

/** Cards drawn at the start of each turn. */
export const DRAW_PER_TURN = 2;

/** Main deck composition (D7). Umbrella/Towel/etc. come from the shop (Phase B),
 *  so they are NOT in the main deck — only these five kinds are seeded here. */
export const MAIN_DECK_COMPOSITION: Partial<Record<CardKind, number>> = {
  balloon: 20,
  miss: 20,
  hit: 20,
  treasure: 20,
  wild: 1,
};

export const MAIN_DECK_SIZE: number = Object.values(MAIN_DECK_COMPOSITION).reduce(
  (a, b) => a + (b ?? 0),
  0,
);

/** Build the ordered (unshuffled) main deck with unique ids. */
export function buildMainDeck(): Card[] {
  const deck: Card[] = [];
  let id = 1;
  for (const [kind, count] of Object.entries(MAIN_DECK_COMPOSITION)) {
    for (let i = 0; i < (count ?? 0); i++) deck.push({ id: id++, kind: kind as CardKind });
  }
  return deck;
}

// ---- Events (D3/E5) ----
// The full roster of 19. The lobby "event density" dial seeds a random subset of
// these into the main deck. Event cards carry kind "event" + their EventKind, and
// get ids in a dedicated range so they never collide with main/shop cards and are
// easy to conserve (they only ever live in the main deck + main discard).
export const EVENT_ID_BASE = 2000;
export const EVENT_KINDS: readonly EventKind[] = [
  "mudslide", "stormsurge", "heatwave", "downpour", "tidalwave",
  "lightning", "targetedstorm",
  "sunbreak", "rainbow", "waterparkpass",
  "treasurechest", "supplycache", "supplydrop",
  "leakybucket", "springcleaning",
  "lostandfound",
  "calmwaters", "falsealarm", "gentlebreeze",
];
export const EVENT_TOTAL = EVENT_KINDS.length; // 19

/** The ordered list of Event cards to seed (caller shuffles + assigns into the
 *  deck); `chosen` is a subset of EVENT_KINDS already trimmed to the density. */
export function buildEventCards(chosen: readonly EventKind[]): Card[] {
  return chosen.map((event, i) => ({ id: EVENT_ID_BASE + i, kind: "event" as CardKind, event }));
}

// ---- Shop stacks (D4; Soaker x3 per the user's tweak) ----
// Shop card ids start at SHOP_ID_BASE so they never collide with main-deck ids
// (1..MAIN_DECK_SIZE) and are routed to the usedPile when played.
export const SHOP_ID_BASE = 1000;

type Comp = Partial<Record<CardKind, number>>;

const DEFENSE_DEPOT: Comp = { umbrella: 3, backpack: 3, firstaid: 3, towel: 2, goggles: 2, needle: 2, lifeguard: 1 };
const MISCHIEF_MARKET: Comp = {
  pickpocket: 3, sabotage: 3, cardswap: 2, freezeout: 2, hiddenstash: 2,
  redirect: 2, lemonadespill: 2, sneakypeek: 1, watertrap: 1, switcheroo: 1,
};
const ATTACK_ARSENAL: Comp = {
  mega: 3, launcher: 3, triplesplash: 2, golden: 2, rapidfire: 2, splashzone: 1, giant: 1, soaker: 3, flashflood: 1,
};

export const STACK_COMPOSITIONS: Record<StackId, Comp> = {
  defense: DEFENSE_DEPOT,
  mischief: MISCHIEF_MARKET,
  attack: ATTACK_ARSENAL,
};

const compSize = (c: Comp): number => Object.values(c).reduce((a, b) => a + (b ?? 0), 0);
export const SHOP_TOTAL: number = compSize(DEFENSE_DEPOT) + compSize(MISCHIEF_MARKET) + compSize(ATTACK_ARSENAL);

/** Build the three ordered (unshuffled) shop stacks with unique ids. */
export function buildStacks(): Record<StackId, Card[]> {
  let id = SHOP_ID_BASE;
  const build = (comp: Comp): Card[] => {
    const arr: Card[] = [];
    for (const [kind, count] of Object.entries(comp)) {
      for (let i = 0; i < (count ?? 0); i++) arr.push({ id: id++, kind: kind as CardKind });
    }
    return arr;
  };
  return { defense: build(DEFENSE_DEPOT), mischief: build(MISCHIEF_MARKET), attack: build(ATTACK_ARSENAL) };
}
