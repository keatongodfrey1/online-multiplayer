import { useState } from 'react'
import { useGame } from '../game/store'
import { RECIPE } from '../game/constants'
import type { BuildItem } from '../game/actions'
import type { Player } from '../game/types'
import { QtyPicker } from './QtyPicker'

// Mirror of reducer.ts effectiveCleaners — a Whole House Cleaner counts as a
// Cleaner for construction prereqs (DESIGN.md §7, revised 2026-04-19). Local
// copy to keep the UI's disabled-button logic in sync with `canBuild`.
function effectiveCleaners(p: Player): number {
  return p.inventory.cleaners + p.inventory.wholeHouseCleaners
}

interface BuildEntry {
  item: BuildItem
  label: string
  icon: string
  recipe: string
  points: number
  /** Maximum buildable right now, given current inventory + prereqs. */
  max: (p: Player) => number
  /** Reason why building is currently blocked (null = allowed or just insufficient resources). */
  blockReason: (p: Player) => string | null
}

const ENTRIES: BuildEntry[] = [
  {
    item: 'wall',
    label: 'Wall',
    icon: '🟫',
    recipe: `${RECIPE.wall.bricks} bricks → 1 wall`,
    points: 0,
    max: (p) => Math.floor(p.inventory.bricks / RECIPE.wall.bricks),
    blockReason: () => null,
  },
  {
    item: 'roof',
    label: 'Roof',
    icon: '🏠',
    recipe: `${RECIPE.roof.sticks} sticks → 1 roof`,
    points: 0,
    max: (p) => Math.floor(p.inventory.sticks / RECIPE.roof.sticks),
    blockReason: () => null,
  },
  {
    item: 'room',
    label: 'Room',
    icon: '🚪',
    recipe: `${RECIPE.room.walls} walls + ${RECIPE.room.roofs} roof → 1 Room`,
    points: 5,
    max: (p) =>
      Math.min(
        Math.floor(p.inventory.walls / RECIPE.room.walls),
        Math.floor(p.inventory.roofs / RECIPE.room.roofs),
      ),
    blockReason: () => null,
  },
  {
    item: 'building',
    label: 'Building',
    icon: '🏢',
    recipe: `${RECIPE.building.rooms} Rooms + Staff → 1 Building`,
    points: 10,
    max: (p) => {
      if (p.inventory.servers + p.inventory.chefs + effectiveCleaners(p) < 1) return 0
      return Math.floor(p.inventory.rooms / RECIPE.building.rooms)
    },
    blockReason: (p) =>
      p.inventory.servers + p.inventory.chefs + effectiveCleaners(p) < 1
        ? 'Needs at least 1 Server, Chef, or Cleaner (WHC counts).'
        : null,
  },
  {
    item: 'threeStoryBuilding',
    label: '3-Story Building',
    icon: '🏬',
    recipe: `${RECIPE.threeStoryBuilding.buildings} Buildings + Server + Chef + Cleaner (WHC counts) → 1`,
    points: 20,
    max: (p) => {
      if (p.inventory.servers < 1 || p.inventory.chefs < 1 || effectiveCleaners(p) < 1) return 0
      return Math.floor(p.inventory.buildings / RECIPE.threeStoryBuilding.buildings)
    },
    blockReason: (p) => {
      const missing: string[] = []
      if (p.inventory.servers < 1) missing.push('Server')
      if (p.inventory.chefs < 1) missing.push('Chef')
      if (effectiveCleaners(p) < 1) missing.push('Cleaner (or WHC)')
      return missing.length > 0 ? `Needs one of each: ${missing.join(', ')}.` : null
    },
  },
  {
    item: 'palace',
    label: 'Palace 🏰',
    icon: '🏰',
    recipe: `${RECIPE.palace.threeStoryBuildings} 3-Story Buildings → 1 Palace (triggers game-end)`,
    points: 250,
    max: (p) => Math.floor(p.inventory.threeStoryBuildings / RECIPE.palace.threeStoryBuildings),
    blockReason: () => null,
  },
]

export function BuildPanel() {
  const { state } = useGame()
  const p = state.players.find((pp) => pp.id === state.currentPlayerId)!

  return (
    <div className="build">
      <h4>🔨 Build</h4>
      <div className="build-list">
        {ENTRIES.map((e) => (
          <BuildRow key={e.item} entry={e} player={p} />
        ))}
      </div>
    </div>
  )
}

function BuildRow({ entry, player }: { entry: BuildEntry; player: Player }) {
  const { dispatch } = useGame()
  const max = entry.max(player)
  const blockReason = entry.blockReason(player)
  const canBuildAny = max >= 1 && blockReason == null
  const [qty, setQty] = useState(1)

  const effectiveQty = canBuildAny ? Math.min(Math.max(qty, 1), max) : 1

  const insufficientReason =
    blockReason ??
    (max < 1
      ? (() => {
          switch (entry.item) {
            case 'wall':
              return `Needs ${RECIPE.wall.bricks} bricks.`
            case 'roof':
              return `Needs ${RECIPE.roof.sticks} sticks.`
            case 'room':
              return `Needs ${RECIPE.room.walls} walls + ${RECIPE.room.roofs} roof.`
            case 'building':
              return `Needs ${RECIPE.building.rooms} Rooms.`
            case 'threeStoryBuilding':
              return `Needs ${RECIPE.threeStoryBuilding.buildings} Buildings.`
            case 'palace':
              return `Needs ${RECIPE.palace.threeStoryBuildings} Three-Story Buildings.`
          }
        })()
      : null)

  return (
    <div
      className={`build-row ${entry.item === 'palace' ? 'palace' : ''}`}
      title={entry.recipe}
    >
      <div className="build-row-head">
        <span className="build-row-icon">{entry.icon}</span>
        <span className="build-row-name">{entry.label}</span>
        {entry.points > 0 && (
          <span className="build-row-pts">+{entry.points} pts</span>
        )}
      </div>
      <div className="build-row-controls">
        <QtyPicker
          value={effectiveQty}
          min={1}
          max={Math.max(1, max)}
          step={1}
          disabled={!canBuildAny}
          onChange={setQty}
        />
        <button
          className={entry.item === 'palace' ? 'gold' : 'primary'}
          disabled={!canBuildAny}
          title={canBuildAny ? undefined : insufficientReason ?? undefined}
          onClick={() =>
            dispatch({ type: 'turn/build', item: entry.item, count: effectiveQty })
          }
        >
          {canBuildAny ? `Build × ${effectiveQty}` : 'Unavailable'}
        </button>
      </div>
    </div>
  )
}
