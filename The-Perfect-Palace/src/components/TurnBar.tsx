import { useGame } from '../game/store'
import { Shop } from './Shop'
import { BuildPanel } from './Build'
import { TradePanel } from './Trade'
import { Duel } from './Duel'
import { BailiffSteal } from './BailiffSteal'
import { DecisionPrompt } from './DecisionPrompt'

export function TurnBar() {
  const { state, dispatch } = useGame()
  const player = state.players.find((p) => p.id === state.currentPlayerId)
  if (!player) return null

  const phase = state.turn.phase

  // Duel phase overrides everything.
  if (phase === 'duel') return <Duel />

  // Dungeon turn: if imprisoned AND this isn't the turn they entered mid-move,
  // offer Royal Pardon, then Roll. Mid-turn entries (entered dungeon just now)
  // continue with their normal turn flow — they see the square-effect / duel /
  // Bailiff / optional-actions UI.
  if (player.dungeon.inDungeon && !state.turn.enteredDungeonThisTurn) {
    return (
      <div className="turn-bar panel">
        <div className="turn-bar-head">
          <strong>{player.name}</strong> is in the dungeon (turn {player.dungeon.turnsServed + 1}/3).
        </div>
        <div className="turn-bar-body">
          {player.inventory.pardonCards > 0 && (
            <button
              className="gold"
              onClick={() => dispatch({ type: 'dungeon/redeemPardon' })}
            >
              🎟 Use Royal Pardon (take a full normal turn)
            </button>
          )}
          <button
            className="primary"
            onClick={() => dispatch({ type: 'turn/rollDie' })}
          >
            🎲 Roll (escape on a 1; auto-release on the 3rd dungeon turn)
          </button>
        </div>
      </div>
    )
  }

  // Turn start — show Bailiff pre-roll steal option if applicable, then Roll.
  if (phase === 'turn-start') {
    const holdsBailiff =
      state.bailiff.kind === 'held' &&
      state.bailiff.by === player.id &&
      !state.turn.bailiffStealUsedThisTurnSequence
    return (
      <div className="turn-bar panel">
        <div className="turn-bar-head">
          <strong>{player.name}</strong>'s turn.
        </div>
        <div className="turn-bar-body">
          {holdsBailiff && <BailiffSteal mode="pre-roll" />}
          <button
            className="gold big"
            onClick={() => dispatch({ type: 'turn/rollDie' })}
          >
            🎲 Roll the Die
          </button>
        </div>
      </div>
    )
  }

  // Square-effect phase with a pending branching decision (alliance, bricks-or-wall,
  // or fine-payment — all routed via DecisionPrompt).
  if (phase === 'square-effect') {
    return <DecisionPrompt />
  }

  // Pre-move Bailiff steal (card-acquired Bailiff, fires after distribute and
  // BEFORE movement so dungeon entry can't strip the Bailiff pre-steal).
  if (phase === 'pre-move-bailiff') {
    return (
      <div className="turn-bar panel">
        <BailiffSteal mode="pre-move" />
      </div>
    )
  }

  // Post-roll Bailiff steal.
  if (phase === 'post-roll-bailiff') {
    return (
      <div className="turn-bar panel">
        <BailiffSteal mode="post-roll" />
      </div>
    )
  }

  // Optional actions. End Turn button lives at the top of the panel so it's
  // always in reach without scrolling past the shop/build/trade sub-panels.
  if (phase === 'optional-actions') {
    return (
      <div className="turn-bar panel">
        <div className="turn-bar-top-row">
          <div className="turn-bar-head">
            <strong>{player.name}</strong>'s optional actions — buy, trade, build, or end turn.
          </div>
          <button
            className="primary big"
            onClick={() => dispatch({ type: 'turn/endTurn' })}
          >
            End Turn →
          </button>
        </div>
        <div className="turn-bar-body optional-actions-grid">
          <Shop />
          <BuildPanel />
          <TradePanel />
        </div>
      </div>
    )
  }

  return (
    <div className="turn-bar panel">
      <div className="muted">Phase: {phase}</div>
    </div>
  )
}

