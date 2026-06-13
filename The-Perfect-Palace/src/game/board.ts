// Static board data. 30 perimeter squares (4 corners + 26 non-corner).
// Clockwise from Start. Source of truth: DESIGN.md Section 1.

import type { SquareDef } from './types'

export const BOARD: readonly SquareDef[] = [
  {
    number: 1,
    side: 'corner',
    label: 'Start',
    flavor: 'Gain $10 and change 1 resource on your card.',
    effect: { kind: 'start' },
  },
  // First long side (#2-#9)
  {
    number: 2,
    side: 'long-a',
    label: 'Get a Room',
    flavor: 'Gain 1 Room for free.',
    effect: { kind: 'gain-room' },
  },
  {
    number: 3,
    side: 'long-a',
    label: 'Neighboring Kingdom',
    flavor: 'Offers alliance for 10 bricks + 10 sticks. If already allied, receive the same for free.',
    effect: { kind: 'alliance-offer', cost: { bricks: 10, sticks: 10 } },
  },
  {
    number: 4,
    side: 'long-a',
    label: 'Bounty',
    flavor: 'Gain 10 bricks + 10 sticks.',
    effect: { kind: 'gain-resources', bricks: 10, sticks: 10 },
  },
  {
    number: 5,
    side: 'long-a',
    label: 'Get the Bailiff',
    flavor: 'The Bailiff transfers to you.',
    effect: { kind: 'get-bailiff' },
  },
  {
    number: 6,
    side: 'long-a',
    label: 'Quarry',
    flavor: 'Gain 100 bricks.',
    effect: { kind: 'gain-resources', bricks: 100 },
  },
  {
    number: 7,
    side: 'long-a',
    label: 'Invading Armies!',
    flavor: 'Pay $100 tribute — skipped if allied. Insolvency: forfeit all cash + dungeon.',
    effect: { kind: 'invasion', cost: 100 },
  },
  {
    number: 8,
    side: 'long-a',
    label: 'Trader (walls)',
    flavor: 'Pay $10 for 3 walls. Unlimited while here.',
    effect: { kind: 'trader-walls' },
  },
  {
    number: 9,
    side: 'long-a',
    label: 'Forest',
    flavor: 'Gain 100 sticks.',
    effect: { kind: 'gain-resources', sticks: 100 },
  },
  // Corner 2
  {
    number: 10,
    side: 'corner',
    label: 'Royal Court',
    flavor: 'The Royal Court finds you guilty — to the dungeon!',
    effect: { kind: 'royal-court' },
  },
  // Short side (#11-#15)
  {
    number: 11,
    side: 'short-a',
    label: 'Fine',
    flavor: 'Lose $20 (or forfeit all cash if you cannot pay).',
    effect: { kind: 'lose-money', amount: 20 },
  },
  {
    number: 12,
    side: 'short-a',
    label: 'Treasury',
    flavor: 'Gain $100.',
    effect: { kind: 'gain-resources', dollars: 100 },
  },
  {
    number: 13,
    side: 'short-a',
    label: 'Get the Bailiff',
    flavor: 'The Bailiff transfers to you.',
    effect: { kind: 'get-bailiff' },
  },
  {
    number: 14,
    side: 'short-a',
    label: 'Half-Price Cleaner',
    flavor: 'Cleaners cost $10 each while here. Waives the Room prereq.',
    effect: { kind: 'half-price-cleaner' },
  },
  {
    number: 15,
    side: 'short-a',
    label: 'Fortune Teller',
    flavor: 'Draw 1 card.',
    effect: { kind: 'fortune-teller', count: 1 },
  },
  // Corner 3
  {
    number: 16,
    side: 'corner',
    label: 'Gift',
    flavor: 'Choose: 10 bricks OR 1 wall.',
    effect: { kind: 'bricks-or-wall' },
  },
  // Second long side (#17-#24)
  {
    number: 17,
    side: 'long-b',
    label: 'Forest',
    flavor: 'Gain 100 sticks.',
    effect: { kind: 'gain-resources', sticks: 100 },
  },
  {
    number: 18,
    side: 'long-b',
    label: 'Treasury',
    flavor: 'Gain $75.',
    effect: { kind: 'gain-resources', dollars: 75 },
  },
  {
    number: 19,
    side: 'long-b',
    label: 'Free Server',
    flavor: 'Gain a Server. Waives the Room prereq.',
    effect: { kind: 'get-server' },
  },
  {
    number: 20,
    side: 'long-b',
    label: 'Neighboring Kingdom',
    flavor: 'Offers alliance for 20 bricks + 20 sticks. If already allied, receive the same for free.',
    effect: { kind: 'alliance-offer', cost: { bricks: 20, sticks: 20 } },
  },
  {
    number: 21,
    side: 'long-b',
    label: 'Bounty',
    flavor: 'Gain 100 bricks + 50 sticks.',
    effect: { kind: 'gain-resources', bricks: 100, sticks: 50 },
  },
  {
    number: 22,
    side: 'long-b',
    label: 'Treasury',
    flavor: 'Gain $50.',
    effect: { kind: 'gain-resources', dollars: 50 },
  },
  {
    number: 23,
    side: 'long-b',
    label: 'Fortune Teller',
    flavor: 'Draw 3 cards.',
    effect: { kind: 'fortune-teller', count: 3 },
  },
  {
    number: 24,
    side: 'long-b',
    label: 'Roll Again',
    flavor: 'Take a full extra turn after this one.',
    effect: { kind: 'roll-again' },
  },
  // Corner 4
  {
    number: 25,
    side: 'corner',
    label: 'Dungeon / Just Passing',
    flavor: 'Where imprisoned players sit. Just passing does nothing.',
    effect: { kind: 'dungeon-just-passing' },
  },
  // Final short side (#26-#30)
  {
    number: 26,
    side: 'short-b',
    label: 'Quarry',
    flavor: 'Gain 100 bricks.',
    effect: { kind: 'gain-resources', bricks: 100 },
  },
  {
    number: 27,
    side: 'short-b',
    label: 'Get the Bailiff',
    flavor: 'The Bailiff transfers to you.',
    effect: { kind: 'get-bailiff' },
  },
  {
    number: 28,
    side: 'short-b',
    label: 'Invading Armies!',
    flavor: 'Pay $100 tribute — skipped if allied. Insolvency: forfeit all cash + dungeon.',
    effect: { kind: 'invasion', cost: 100 },
  },
  {
    number: 29,
    side: 'short-b',
    label: 'Trader (bricks)',
    flavor: 'Trade 10 bricks for $15 (multiples of 10, bricks only). Unlimited while here.',
    effect: { kind: 'trader-bricks' },
  },
  {
    number: 30,
    side: 'short-b',
    label: 'Free Building',
    flavor: 'Gain 1 Building. Waives all prereqs.',
    effect: { kind: 'get-building' },
  },
] as const

export const CORNERS = new Set([1, 10, 16, 25])
export const BAILIFF_SQUARES = [5, 13, 27]
export const WAR_SQUARES = [7, 28]
export const ALLIANCE_SQUARES = [3, 20]
export const CARD_DRAW_SQUARES = [15, 23]

export const TOTAL_SQUARES = 30

/**
 * Compute the destination square number after advancing `steps` from `from`.
 * Board is 1-indexed, 1..30, and wraps back to 1 after 30.
 */
export function advance(from: number, steps: number): number {
  return ((from - 1 + steps) % TOTAL_SQUARES) + 1
}

/**
 * Returns true if the player passed OR landed on the Start square during
 * a move from `from` advancing by `steps`. Passing counts even if the
 * destination is not Start (e.g., from 29 rolling 4 → dest 3, passes Start).
 */
export function passedOrLandedOnStart(from: number, steps: number): boolean {
  for (let i = 1; i <= steps; i++) {
    const pos = ((from - 1 + i) % TOTAL_SQUARES) + 1
    if (pos === 1) return true
  }
  return false
}

export function getSquare(number: number): SquareDef {
  const sq = BOARD.find((s) => s.number === number)
  if (!sq) throw new Error(`Invalid square number: ${number}`)
  return sq
}
