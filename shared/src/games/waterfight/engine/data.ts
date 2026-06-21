// Card data + tuning constants for the Water Fight engine.

import type { Card, CardKind, EventKind, StackId } from "./types.js";

export const ENGINE_VERSION = "0.2.0"; // bumped for the dialed deck + new options (invalidates older saves)

/** Backstop on the attack ladder so a bug can never soft-lock the table. The
 *  unbounded Miss/Hit war is bounded in practice by cards in hand; this only
 *  ever fires if a transition bug fails to consume a card. */
export const MAX_ATTACK_ROUNDS = 500;

/** Cards drawn at the start of each turn. */
export const DRAW_PER_TURN = 2;

/** Flash Flood (Main Action, table-wide): damage per opponent + blocks to stop it. */
export const FLASH_FLOOD_DAMAGE = 2;
export const FLASH_FLOOD_BLOCK = 1;

/** Default main deck composition (D7). Balloon/Treasure (20) and Wild (1) are
 *  fixed; Hit/Miss are a lobby dial (default 20/20). Umbrella/Towel/etc. come from
 *  the shop, so they are NOT in the main deck. */
export const MAIN_DECK_COMPOSITION: Partial<Record<CardKind, number>> = {
  balloon: 20,
  miss: 20,
  hit: 20,
  treasure: 20,
  wild: 1,
};
/** Fixed (non-dialed) main-deck counts. */
const MAIN_BALLOON = 20;
const MAIN_TREASURE = 20;
const MAIN_WILD = 1;
export const DEFAULT_MAIN_HIT = 20;
export const DEFAULT_MAIN_MISS = 20;

export const MAIN_DECK_SIZE: number = Object.values(MAIN_DECK_COMPOSITION).reduce(
  (a, b) => a + (b ?? 0),
  0,
);

/** Full main-deck size for the given Hit/Miss counts (= highest card id). */
export function mainDeckSize(mainHit: number, mainMiss: number): number {
  return MAIN_BALLOON + mainMiss + mainHit + MAIN_TREASURE + MAIN_WILD;
}

/** Build the ordered (unshuffled) main deck with unique ids 1..size. */
export function buildMainDeck(mainHit = DEFAULT_MAIN_HIT, mainMiss = DEFAULT_MAIN_MISS): Card[] {
  const comp: [CardKind, number][] = [
    ["balloon", MAIN_BALLOON],
    ["miss", mainMiss],
    ["hit", mainHit],
    ["treasure", MAIN_TREASURE],
    ["wild", MAIN_WILD],
  ];
  const deck: Card[] = [];
  let id = 1;
  for (const [kind, count] of comp) for (let i = 0; i < count; i++) deck.push({ id: id++, kind });
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
