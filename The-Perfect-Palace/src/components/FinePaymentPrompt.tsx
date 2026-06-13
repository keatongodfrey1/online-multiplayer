import { useState } from 'react'
import { useGame } from '../game/store'
import { QtyPicker } from './QtyPicker'

const ITEM_VALUE = { bricks: 1, sticks: 1, walls: 5, roofs: 5 } as const

/**
 * Shown during phase === 'square-effect' when state.turn.pendingFine is set —
 * i.e., a #7/#28/#11 money fine exceeded the player's cash. Player picks items
 * to forfeit (bricks/sticks/walls/roofs only).
 *
 * No-overpay rule (DESIGN.md §1, revised 2026-04-19):
 *   - selectedValue === owed → Pay (exact).
 *   - selectedValue > owed  → Pay disabled ("reduce selection").
 *   - selectedValue < owed and the player could add any item without
 *     exceeding owed → Pay disabled ("add more").
 *   - selectedValue < owed and no addable item fits → Pay enabled
 *     (partial stiff — the shortfall is forgiven).
 */
export function FinePaymentPrompt() {
  const { state, dispatch } = useGame()
  const p = state.players.find((pp) => pp.id === state.currentPlayerId)!
  const pending = state.turn.pendingFine!

  const [bricks, setBricks] = useState(0)
  const [sticks, setSticks] = useState(0)
  const [walls, setWalls] = useState(0)
  const [roofs, setRoofs] = useState(0)

  const selectedValue =
    bricks * ITEM_VALUE.bricks +
    sticks * ITEM_VALUE.sticks +
    walls * ITEM_VALUE.walls +
    roofs * ITEM_VALUE.roofs
  const owed = pending.amount

  const overBy = Math.max(0, selectedValue - owed)
  const shortBy = Math.max(0, owed - selectedValue)

  const canAddBrick = bricks < p.inventory.bricks && selectedValue + 1 <= owed
  const canAddStick = sticks < p.inventory.sticks && selectedValue + 1 <= owed
  const canAddWall = walls < p.inventory.walls && selectedValue + 5 <= owed
  const canAddRoof = roofs < p.inventory.roofs && selectedValue + 5 <= owed
  const canAddMore = canAddBrick || canAddStick || canAddWall || canAddRoof

  let canPay = false
  let statusChip: { label: string; tone: 'exact' | 'over' | 'short' | 'max' } | null = null
  if (selectedValue === owed) {
    canPay = true
    statusChip = { label: 'exact ✓', tone: 'exact' }
  } else if (selectedValue > owed) {
    canPay = false
    statusChip = { label: `Over by $${overBy} — reduce selection`, tone: 'over' }
  } else if (canAddMore) {
    canPay = false
    statusChip = { label: `Short $${shortBy} — add more items`, tone: 'short' }
  } else {
    canPay = true
    statusChip = { label: `Max without overpay — $${shortBy} stiffed`, tone: 'max' }
  }

  const label =
    pending.source === 'invasion' ? 'Invading-armies tribute' : 'Lose-money square fine'

  return (
    <div className="turn-bar panel fine-payment">
      <h3>💸 {label} — pay ${owed} in items</h3>
      <p className="muted small">
        Your cash didn't cover the full fine. You owe <strong>${owed}</strong> more in
        items. Pick from your bricks, sticks, walls, or roofs. (Rooms, buildings, staff,
        and the Bailiff are protected.) Overpay is not allowed — if exact change isn't
        possible, the remainder is forgiven.
      </p>
      <p className="muted small">
        Rates: 1 brick = $1 · 1 stick = $1 · 1 wall = $5 · 1 roof = $5
      </p>

      <div className="fine-row">
        <label>🧱 Bricks (max {p.inventory.bricks})</label>
        <QtyPicker
          value={bricks}
          min={0}
          max={p.inventory.bricks}
          step={1}
          onChange={setBricks}
          showMax
          disabled={p.inventory.bricks === 0}
        />
      </div>
      <div className="fine-row">
        <label>🪵 Sticks (max {p.inventory.sticks})</label>
        <QtyPicker
          value={sticks}
          min={0}
          max={p.inventory.sticks}
          step={1}
          onChange={setSticks}
          showMax
          disabled={p.inventory.sticks === 0}
        />
      </div>
      <div className="fine-row">
        <label>🟫 Walls (max {p.inventory.walls}, $5 each)</label>
        <QtyPicker
          value={walls}
          min={0}
          max={p.inventory.walls}
          step={1}
          onChange={setWalls}
          showMax
          disabled={p.inventory.walls === 0}
        />
      </div>
      <div className="fine-row">
        <label>🏠 Roofs (max {p.inventory.roofs}, $5 each)</label>
        <QtyPicker
          value={roofs}
          min={0}
          max={p.inventory.roofs}
          step={1}
          onChange={setRoofs}
          showMax
          disabled={p.inventory.roofs === 0}
        />
      </div>

      <div className="fine-total">
        Selected: <strong>${selectedValue}</strong> of ${owed}{' '}
        {statusChip && (
          <span
            className={`chip ${
              statusChip.tone === 'exact' || statusChip.tone === 'max' ? 'queen' : ''
            }`}
          >
            {statusChip.label}
          </span>
        )}
      </div>

      <button
        className="gold big"
        disabled={!canPay}
        title={
          canPay
            ? 'Forfeit the selected items.'
            : selectedValue > owed
              ? 'Reduce your selection to owed amount or less.'
              : 'Add more items (you can still pay more without exceeding the fine).'
        }
        onClick={() =>
          dispatch({ type: 'turn/payFine', bricks, sticks, walls, roofs })
        }
      >
        💸 Pay
      </button>
    </div>
  )
}
