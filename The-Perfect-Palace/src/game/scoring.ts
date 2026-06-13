// Scoring and tiebreaker helpers.
// Source of truth: DESIGN.md Sections 8 & 12.

import type { PlayerInventory } from './types'
import { POINTS, STAFF_WEIGHT } from './constants'

export function totalPoints(inv: PlayerInventory): number {
  return (
    inv.rooms * POINTS.room +
    inv.buildings * POINTS.building +
    inv.threeStoryBuildings * POINTS.threeStoryBuilding +
    inv.palaces * POINTS.palace +
    inv.servers * POINTS.server +
    inv.chefs * POINTS.chef +
    inv.cleaners * POINTS.cleaner +
    inv.wholeHouseCleaners * POINTS.wholeHouseCleaner +
    (inv.queen ? POINTS.queen : 0) +
    (inv.knight ? POINTS.knight : 0) +
    inv.workers * POINTS.worker
  )
}

export function staffWeight(inv: PlayerInventory): number {
  return (
    inv.workers * STAFF_WEIGHT.worker +
    inv.servers * STAFF_WEIGHT.server +
    inv.chefs * STAFF_WEIGHT.chef +
    inv.cleaners * STAFF_WEIGHT.cleaner +
    inv.wholeHouseCleaners * STAFF_WEIGHT.wholeHouseCleaner +
    (inv.queen ? STAFF_WEIGHT.queen : 0) +
    (inv.knight ? STAFF_WEIGHT.knight : 0)
  )
}

export interface PlayerScore {
  id: string
  name: string
  points: number
  staff: number
  cash: number
}

/**
 * Rank players by: highest points → highest staff weight → highest cash.
 * Returns a sorted list with rank (1-based). Ties share a rank.
 */
export function rankPlayers(
  entries: PlayerScore[],
): (PlayerScore & { rank: number })[] {
  const sorted = [...entries].sort((a, b) => {
    if (b.points !== a.points) return b.points - a.points
    if (b.staff !== a.staff) return b.staff - a.staff
    return b.cash - a.cash
  })
  const ranked: (PlayerScore & { rank: number })[] = []
  let prevRank = 0
  let prevKey: string | null = null
  sorted.forEach((entry, i) => {
    const key = `${entry.points}:${entry.staff}:${entry.cash}`
    const rank = key === prevKey ? prevRank : i + 1
    ranked.push({ ...entry, rank })
    prevKey = key
    prevRank = rank
  })
  return ranked
}
