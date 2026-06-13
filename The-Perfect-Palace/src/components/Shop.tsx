import { useState } from 'react'
import { useGame } from '../game/store'
import {
  PRICE,
  TRADER_WALLS_DEAL,
  HALF_PRICE_CLEANER_COST,
  TRADER_BRICKS_DEAL,
} from '../game/constants'
import type { ShopItem } from '../game/actions'
import type { Player } from '../game/types'
import { QtyPicker } from './QtyPicker'

// Mirror of reducer.ts hasRoomPrereq — a player has met the Room prereq if they
// own any Room or higher (built-up tiers count, since Rooms get consumed on
// upgrade).
function hasRoomPrereq(p: Player): boolean {
  return (
    p.inventory.rooms +
      p.inventory.buildings +
      p.inventory.threeStoryBuildings +
      p.inventory.palaces >=
    1
  )
}

interface ShopEntry {
  item: ShopItem
  label: string
  icon: string
  unitPrice: number
  step: number
  min: number
  tooltip?: string
  /** Compute the max purchasable quantity from current inventory + prereqs + funds. */
  max: (p: Player) => number
  /** Why the player can't buy ANY right now (for the disabled-button tooltip). */
  unavailableReason: (p: Player) => string | null
}

const ENTRIES: ShopEntry[] = [
  {
    item: 'brick',
    label: 'Brick',
    icon: '🧱',
    unitPrice: PRICE.brick,
    step: 5,
    min: 5,
    tooltip: 'Sold in bundles of 5 — $5 per bundle.',
    max: (p) => Math.floor(p.inventory.dollars / PRICE.brick / 5) * 5,
    unavailableReason: (p) => (p.inventory.dollars < 5 ? 'Need at least $5 for one bundle (5 bricks).' : null),
  },
  {
    item: 'stick',
    label: 'Stick',
    icon: '🪵',
    unitPrice: PRICE.stick,
    step: 5,
    min: 5,
    tooltip: 'Sold in bundles of 5 — $5 per bundle.',
    max: (p) => Math.floor(p.inventory.dollars / PRICE.stick / 5) * 5,
    unavailableReason: (p) => (p.inventory.dollars < 5 ? 'Need at least $5 for one bundle (5 sticks).' : null),
  },
  {
    item: 'worker',
    label: 'Worker',
    icon: '🔨',
    unitPrice: PRICE.worker,
    step: 1,
    min: 1,
    tooltip: 'Gives 2 walls OR 1 wall + 1 roof per turn (pick in the Player panel).',
    max: (p) => Math.floor(p.inventory.dollars / PRICE.worker),
    unavailableReason: (p) => (p.inventory.dollars < PRICE.worker ? `Needs $${PRICE.worker}.` : null),
  },
  {
    item: 'server',
    label: 'Server',
    icon: '🍽',
    unitPrice: PRICE.server,
    step: 1,
    min: 1,
    tooltip: 'Needs at least 1 Room, Building, 3-Story, or Palace. 5 pts at game end.',
    max: (p) => (!hasRoomPrereq(p) ? 0 : Math.floor(p.inventory.dollars / PRICE.server)),
    unavailableReason: (p) =>
      !hasRoomPrereq(p)
        ? 'Needs at least 1 Room, Building, 3-Story, or Palace.'
        : p.inventory.dollars < PRICE.server
          ? `Needs $${PRICE.server}.`
          : null,
  },
  {
    item: 'chef',
    label: 'Chef',
    icon: '👨‍🍳',
    unitPrice: PRICE.chef,
    step: 1,
    min: 1,
    tooltip: 'Needs at least 1 Room, Building, 3-Story, or Palace. 10 pts.',
    max: (p) => (!hasRoomPrereq(p) ? 0 : Math.floor(p.inventory.dollars / PRICE.chef)),
    unavailableReason: (p) =>
      !hasRoomPrereq(p)
        ? 'Needs at least 1 Room, Building, 3-Story, or Palace.'
        : p.inventory.dollars < PRICE.chef
          ? `Needs $${PRICE.chef}.`
          : null,
  },
  {
    item: 'cleaner',
    label: 'Cleaner',
    icon: '🧹',
    unitPrice: PRICE.cleaner,
    step: 1,
    min: 1,
    tooltip: 'Needs at least 1 Room, Building, 3-Story, or Palace. 5 pts. 5 Cleaners + 1 Building → 1 Whole House Cleaner (50 pts).',
    max: (p) => (!hasRoomPrereq(p) ? 0 : Math.floor(p.inventory.dollars / PRICE.cleaner)),
    unavailableReason: (p) =>
      !hasRoomPrereq(p)
        ? 'Needs at least 1 Room, Building, 3-Story, or Palace.'
        : p.inventory.dollars < PRICE.cleaner
          ? `Needs $${PRICE.cleaner}.`
          : null,
  },
]

export function Shop() {
  const { state, dispatch } = useGame()
  const p = state.players.find((pp) => pp.id === state.currentPlayerId)!

  return (
    <div className="shop">
      <h4>🛍 Shop</h4>
      <div className="shop-list">
        {ENTRIES.map((e) => (
          <ShopRow key={e.item} entry={e} player={p} />
        ))}
        {/* Knight and Queen are special: max 1 per player, single-click button. */}
        <KnightRow player={p} dispatch={dispatch} />
        <QueenRow player={p} dispatch={dispatch} />
      </div>

      {/* On-square special deals */}
      {p.position === 8 && (
        <SpecialDealTrader
          title={`💰 Trader (#8): $${TRADER_WALLS_DEAL.cost} → ${TRADER_WALLS_DEAL.walls} walls`}
          costPerBatch={`$${TRADER_WALLS_DEAL.cost}`}
          yieldPerBatch={`${TRADER_WALLS_DEAL.walls} walls`}
          maxBatches={Math.floor(p.inventory.dollars / TRADER_WALLS_DEAL.cost)}
          onBuy={(batches) => dispatch({ type: 'turn/traderWallsBuy', batches })}
          disabled={state.turn.traderUsedThisTurn}
          disabledReason="Already used the Trader this turn."
        />
      )}
      {p.position === 29 && (
        <SpecialDealTrader
          title={`💰 Brick Trader (#29): ${TRADER_BRICKS_DEAL.bricks} bricks → $${TRADER_BRICKS_DEAL.dollars}`}
          costPerBatch={`${TRADER_BRICKS_DEAL.bricks} bricks`}
          yieldPerBatch={`$${TRADER_BRICKS_DEAL.dollars}`}
          maxBatches={Math.floor(p.inventory.bricks / TRADER_BRICKS_DEAL.bricks)}
          onBuy={(batches) => dispatch({ type: 'turn/traderBricksSell', batches })}
          disabled={state.turn.traderUsedThisTurn}
          disabledReason="Already used the Trader this turn."
        />
      )}
      {p.position === 14 && (
        <SpecialDealTrader
          title={`💰 Half-price Cleaner (#14): $${HALF_PRICE_CLEANER_COST} → 1 Cleaner (no Room prereq)`}
          costPerBatch={`$${HALF_PRICE_CLEANER_COST}`}
          yieldPerBatch="1 Cleaner"
          maxBatches={Math.floor(p.inventory.dollars / HALF_PRICE_CLEANER_COST)}
          onBuy={(count) => dispatch({ type: 'turn/halfPriceCleanerBuy', count })}
        />
      )}
    </div>
  )
}

function ShopRow({ entry, player }: { entry: ShopEntry; player: Player }) {
  const { dispatch } = useGame()
  const max = entry.max(player)
  const reason = entry.unavailableReason(player)
  const canBuyAny = max >= entry.min && reason == null
  const [qty, setQty] = useState(entry.min)

  // Keep qty in range when max shrinks (e.g., after spending money).
  const effectiveQty = canBuyAny ? Math.min(Math.max(qty, entry.min), max) : entry.min
  const totalCost = effectiveQty * entry.unitPrice
  const buyDisabled = !canBuyAny

  return (
    <div className="shop-row" title={entry.tooltip}>
      <div className="shop-row-head">
        <span className="shop-row-icon">{entry.icon}</span>
        <span className="shop-row-name">{entry.label}</span>
        <span className="shop-row-price">
          ${entry.unitPrice}
          {entry.step > 1 ? ` · ${entry.step}/bundle` : ' ea'}
        </span>
      </div>
      <div className="shop-row-controls">
        <QtyPicker
          value={effectiveQty}
          min={entry.min}
          max={canBuyAny ? max : entry.min}
          step={entry.step}
          disabled={!canBuyAny}
          onChange={setQty}
        />
        <button
          className="gold"
          disabled={buyDisabled}
          title={reason ?? undefined}
          onClick={() =>
            dispatch({ type: 'turn/buy', item: entry.item, quantity: effectiveQty })
          }
        >
          {canBuyAny ? `Buy ${effectiveQty} · $${totalCost}` : 'Unavailable'}
        </button>
      </div>
    </div>
  )
}

function KnightRow({
  player,
  dispatch,
}: {
  player: Player
  dispatch: ReturnType<typeof useGame>['dispatch']
}) {
  const owned = player.inventory.knight
  const canAfford = player.inventory.dollars >= PRICE.knight
  const disabled = owned || !canAfford
  const reason = owned ? 'You already own a Knight (max 1).' : !canAfford ? `Needs $${PRICE.knight}.` : undefined

  return (
    <div
      className="shop-row"
      title="Protects from the Bailiff absolutely. 5 pts at game end. Permanent."
    >
      <div className="shop-row-head">
        <span className="shop-row-icon">🛡</span>
        <span className="shop-row-name">Knight</span>
        <span className="shop-row-price">${PRICE.knight} · 1 max</span>
      </div>
      <div className="shop-row-controls">
        <button
          className="gold"
          disabled={disabled}
          title={reason}
          onClick={() => dispatch({ type: 'turn/buy', item: 'knight', quantity: 1 })}
        >
          {owned ? 'Owned' : `Buy Knight · $${PRICE.knight}`}
        </button>
      </div>
    </div>
  )
}

function QueenRow({
  player,
  dispatch,
}: {
  player: Player
  dispatch: ReturnType<typeof useGame>['dispatch']
}) {
  const owned = player.inventory.queen
  const canAfford = player.inventory.dollars >= PRICE.queen
  const disabled = owned || !canAfford
  const reason = owned ? 'You already own the Queen (max 1).' : !canAfford ? `Needs $${PRICE.queen}.` : undefined

  return (
    <div
      className="shop-row"
      title="200 pts at game end. Permanent. (Tiebreaker weight: 10.)"
    >
      <div className="shop-row-head">
        <span className="shop-row-icon">👑</span>
        <span className="shop-row-name">Queen</span>
        <span className="shop-row-price">${PRICE.queen} · 1 max</span>
      </div>
      <div className="shop-row-controls">
        <button
          className="gold"
          disabled={disabled}
          title={reason}
          onClick={() => dispatch({ type: 'turn/buy', item: 'queen', quantity: 1 })}
        >
          {owned ? 'Owned' : `Buy Queen · $${PRICE.queen}`}
        </button>
      </div>
    </div>
  )
}

function SpecialDealTrader({
  title,
  costPerBatch,
  yieldPerBatch,
  maxBatches,
  onBuy,
  disabled: externallyDisabled,
  disabledReason,
}: {
  title: string
  costPerBatch: string
  yieldPerBatch: string
  maxBatches: number
  onBuy: (batches: number) => void
  disabled?: boolean
  disabledReason?: string
}) {
  const [qty, setQty] = useState(1)
  const insufficient = maxBatches < 1
  const disabled = insufficient || Boolean(externallyDisabled)
  const effectiveQty = disabled ? 1 : Math.min(Math.max(qty, 1), maxBatches)
  const tooltip = externallyDisabled
    ? disabledReason
    : insufficient
      ? 'Not enough resources.'
      : undefined
  const footer = externallyDisabled
    ? disabledReason
    : 'Up to one trade per turn while you\u2019re on this square.'

  return (
    <div className="shop-row special" title={footer}>
      <div className="shop-row-head">
        <span className="shop-row-icon">💰</span>
        <span className="shop-row-name">{title}</span>
      </div>
      <div className="shop-row-controls">
        <QtyPicker
          value={effectiveQty}
          min={1}
          max={Math.max(1, maxBatches)}
          step={1}
          disabled={disabled}
          onChange={setQty}
        />
        <button
          className="primary"
          disabled={disabled}
          title={tooltip}
          onClick={() => onBuy(effectiveQty)}
        >
          {disabled
            ? 'Unavailable'
            : `Trade × ${effectiveQty} (${costPerBatch} → ${yieldPerBatch})`}
        </button>
      </div>
    </div>
  )
}
