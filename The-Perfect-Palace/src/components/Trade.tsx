import { useState } from 'react'
import { useGame } from '../game/store'
import { QtyPicker } from './QtyPicker'

const MIN_BATCH = 10 // bricks↔sticks trade in batches of 10 (min & step).

/**
 * Two 2:1 trade rows — one per direction.
 * Input is the amount of the source resource to spend; must be a multiple of 10.
 */
export function TradePanel() {
  const { state } = useGame()
  const p = state.players.find((pp) => pp.id === state.currentPlayerId)!

  return (
    <div className="trade">
      <h4>🔄 Trade (2:1)</h4>
      <p className="muted small">Every 10 of one becomes 5 of the other — 2:1 ratio, in batches of 10.</p>
      <TradeRow from="bricks" maxFrom={Math.floor(p.inventory.bricks / MIN_BATCH) * MIN_BATCH} />
      <TradeRow from="sticks" maxFrom={Math.floor(p.inventory.sticks / MIN_BATCH) * MIN_BATCH} />
    </div>
  )
}

function TradeRow({
  from,
  maxFrom,
}: {
  from: 'bricks' | 'sticks'
  maxFrom: number
}) {
  const { dispatch } = useGame()
  const [amount, setAmount] = useState(MIN_BATCH)
  const disabled = maxFrom < MIN_BATCH
  const effective = disabled ? MIN_BATCH : Math.min(Math.max(amount, MIN_BATCH), maxFrom)
  const to = from === 'bricks' ? 'sticks' : 'bricks'
  const fromIcon = from === 'bricks' ? '🧱' : '🪵'
  const toIcon = to === 'bricks' ? '🧱' : '🪵'
  const received = effective / 2

  return (
    <div className="trade-row">
      <div className="trade-row-head">
        <span>
          {fromIcon} {from} → {toIcon} {to}
        </span>
      </div>
      <div className="trade-row-controls">
        <QtyPicker
          value={effective}
          min={MIN_BATCH}
          max={Math.max(MIN_BATCH, maxFrom)}
          step={MIN_BATCH}
          disabled={disabled}
          onChange={setAmount}
        />
        <button
          className="primary"
          disabled={disabled}
          title={
            disabled
              ? `Need at least ${MIN_BATCH} ${from} to trade.`
              : `Trade ${effective} ${from} for ${received} ${to}.`
          }
          onClick={() => dispatch({ type: 'turn/trade', from, amount: effective })}
        >
          {disabled ? 'Unavailable' : `Trade ${effective} ${from} → ${received} ${to}`}
        </button>
      </div>
    </div>
  )
}
