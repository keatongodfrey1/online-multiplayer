// Static card deck data. 18 unique cards, one of each.
// Source of truth: DESIGN.md Section 11.

import type { CardDef } from './types'

export const CARDS: readonly CardDef[] = [
  { id: 1, name: 'Get $50', effect: { kind: 'gain-dollars', amount: 50 } },
  { id: 2, name: 'Get a Building', effect: { kind: 'get-building' } },
  { id: 3, name: 'Get $20', effect: { kind: 'gain-dollars', amount: 20 } },
  { id: 4, name: 'Get 50 Bricks', effect: { kind: 'gain-bricks', amount: 50 } },
  { id: 5, name: 'Get $100', effect: { kind: 'gain-dollars', amount: 100 } },
  { id: 6, name: 'Get $75', effect: { kind: 'gain-dollars', amount: 75 } },
  { id: 7, name: 'Get a Server', effect: { kind: 'get-server' } },
  { id: 8, name: 'Get a Cleaner', effect: { kind: 'get-cleaner' } },
  { id: 9, name: 'Get a Chef', effect: { kind: 'get-chef' } },
  { id: 10, name: 'Get a Room', effect: { kind: 'get-room' } },
  { id: 11, name: 'Get $60', effect: { kind: 'gain-dollars', amount: 60 } },
  { id: 12, name: 'Get 50 Sticks', effect: { kind: 'gain-sticks', amount: 50 } },
  {
    id: 13,
    name: 'Get 50 Bricks + 50 Sticks',
    effect: { kind: 'gain-bricks-and-sticks', bricks: 50, sticks: 50 },
  },
  {
    id: 14,
    name: 'Ally with the Kingdom',
    effect: { kind: 'alliance-or-bonus' },
  },
  { id: 15, name: 'Get 75 Bricks', effect: { kind: 'gain-bricks', amount: 75 } },
  { id: 16, name: 'Draw Another Card', effect: { kind: 'draw-another' } },
  { id: 17, name: 'Royal Pardon', effect: { kind: 'royal-pardon' } },
  { id: 18, name: 'Get the Bailiff', effect: { kind: 'get-bailiff' } },
] as const

export const TOTAL_CARDS = CARDS.length // 18

export function getCard(id: number): CardDef {
  const card = CARDS.find((c) => c.id === id)
  if (!card) throw new Error(`Invalid card id: ${id}`)
  return card
}

/**
 * Shuffle an array in place using Fisher–Yates with a provided RNG.
 * Returns the array for convenience.
 */
export function shuffle<T>(arr: T[], rng: () => number = Math.random): T[] {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1))
    ;[arr[i], arr[j]] = [arr[j], arr[i]]
  }
  return arr
}

export function freshDeck(rng: () => number = Math.random): number[] {
  return shuffle(
    CARDS.map((c) => c.id),
    rng,
  )
}
