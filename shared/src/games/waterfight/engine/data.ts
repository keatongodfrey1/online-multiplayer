// Card data + tuning constants for the Water Fight engine.

import type { Card, CardKind } from "./types.js";

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
