// Deck helpers shared by engine.ts and attack.ts (kept here to avoid an
// engine <-> attack import cycle). Both decks reshuffle their own discard when
// empty, using the game's deterministic RNG stream.

import { shuffleInPlace } from "./rng.js";
import type { Card, GameState, SplashCard } from "./types.js";

/** Route a played card to the right pile: main-deck cards (ids 1..mainIdMax) and
 *  resolved Events go to the main discard (they reshuffle back — D3); shop/big/
 *  injected cards go to the usedPile (removed from circulation, never recycled). */
export function discardCard(s: GameState, card: Card): void {
  if (card.kind === "event" || (card.id >= 1 && card.id <= s.mainIdMax)) s.mainDiscard.push(card);
  else s.usedPile.push(card);
}

/** Draw one card from the main deck, reshuffling the discard if needed.
 *  Returns null only if the entire main pool is somehow exhausted. */
export function drawMainCard(s: GameState): Card | null {
  if (s.mainDeck.length === 0) {
    if (s.mainDiscard.length === 0) return null;
    s.mainDeck = s.mainDiscard;
    s.mainDiscard = [];
    shuffleInPlace(s.mainDeck, s);
  }
  return s.mainDeck.pop() ?? null;
}

/** Flip the top Splash card (reshuffling its discard if empty). The flipped card
 *  is immediately discarded — it never enters a hand. */
export function flipSplash(s: GameState): SplashCard {
  if (s.splashPile.length === 0) {
    s.splashPile = s.splashDiscard;
    s.splashDiscard = [];
    shuffleInPlace(s.splashPile, s);
  }
  const card = s.splashPile.pop();
  if (card === undefined) throw new Error("splash pile empty (splashHit + splashMiss must be >= 1)");
  s.splashDiscard.push(card);
  return card;
}
