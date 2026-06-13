import { useEffect } from 'react'
import { useGame } from '../game/store'
import { getSquare } from '../game/board'
import { FinePaymentPrompt } from './FinePaymentPrompt'

/**
 * Shown during phase === 'square-effect' when the current square has a pending
 * decision (alliance offer when not allied; bricks-or-wall choice; or a
 * fine-payment forfeit dialog from #7/#28/#11 insolvency). The reducer
 * auto-advances the phase once the decision is dispatched.
 */
export function DecisionPrompt() {
  const { state, dispatch } = useGame()
  const player = state.players.find((p) => p.id === state.currentPlayerId)!
  const square = getSquare(player.position)

  // If there's no actual decision pending (shouldn't happen), nudge forward.
  useEffect(() => {
    if (
      square.effect.kind !== 'alliance-offer' &&
      square.effect.kind !== 'bricks-or-wall' &&
      !state.turn.pendingFine
    ) {
      dispatch({ type: 'turn/advancePhase' })
    }
  }, [square.effect.kind, state.turn.pendingFine, dispatch])

  // Fine-payment takes precedence over any other pending decision — the square's
  // effect already ran and left a pendingFine we can't advance past.
  if (state.turn.pendingFine) {
    return <FinePaymentPrompt />
  }

  if (square.effect.kind === 'alliance-offer' && !player.inventory.allied) {
    const cost = square.effect.cost
    const canAfford =
      player.inventory.bricks >= cost.bricks && player.inventory.sticks >= cost.sticks
    return (
      <div className="turn-bar panel">
        <h3>{square.label}</h3>
        <p>{square.flavor}</p>
        <div className="turn-bar-body">
          <button
            className="gold"
            disabled={!canAfford}
            title={canAfford ? undefined : `Needs ${cost.bricks} bricks + ${cost.sticks} sticks.`}
            onClick={() => dispatch({ type: 'turn/acceptAlliance' })}
          >
            🤝 Accept Alliance ({cost.bricks} bricks + {cost.sticks} sticks)
          </button>
          <button className="ghost" onClick={() => dispatch({ type: 'turn/declineAlliance' })}>
            Decline
          </button>
        </div>
      </div>
    )
  }

  if (square.effect.kind === 'bricks-or-wall') {
    return (
      <div className="turn-bar panel">
        <h3>{square.label}</h3>
        <p>{square.flavor}</p>
        <div className="turn-bar-body">
          <button className="gold" onClick={() => dispatch({ type: 'turn/gift10Bricks' })}>
            🧱 Take 10 Bricks
          </button>
          <button className="primary" onClick={() => dispatch({ type: 'turn/gift1Wall' })}>
            🟫 Take 1 Wall
          </button>
        </div>
      </div>
    )
  }

  return null
}
