import { useGame } from '../game/store'
import type { Phase, ResourceOutcome } from '../game/types'

const SEAT_COLORS = ['#b74545', '#4a7ab8', '#3e8b5a', '#c9a140', '#5c3d8a', '#b55a9b']

// Phases where the roll display makes sense (the die has been rolled and the
// distribution is visible / relevant). Before the roll and after turn-end it's
// hidden so the center doesn't show stale info.
const VISIBLE_PHASES: Phase[] = [
  'distributing',
  'moving',
  'pre-move-bailiff',
  'square-effect',
  'duel',
  'post-roll-bailiff',
  'optional-actions',
]

function outcomeShort(o: ResourceOutcome): string {
  switch (o.kind) {
    case 'dollars':
      return `+$${o.amount}`
    case 'bricks':
      return `+${o.amount} 🧱`
    case 'sticks':
      return `+${o.amount} 🪵`
    case 'draw-card':
      return 'drew a card'
  }
}

export function LastRollDisplay() {
  const { state } = useGame()
  const lastRoll = state.turn.lastRoll
  if (lastRoll == null) return null
  if (!VISIBLE_PHASES.includes(state.turn.phase)) return null

  const activeId = state.currentPlayerId
  const rows = state.players.filter((p) => !p.removed)
  const faceIdx = lastRoll - 1

  return (
    <div className="last-roll-display">
      <div className="last-roll-heading">🎲 {lastRoll} rolled</div>
      <ul className="last-roll-rows">
        {rows.map((p) => {
          const outcome = p.resourceCard[faceIdx]
          return (
            <li key={p.id} className={p.id === activeId ? 'last-roll-row active' : 'last-roll-row'}>
              <span
                className="last-roll-chip"
                style={{ background: SEAT_COLORS[p.colorIndex % SEAT_COLORS.length] }}
              >
                {p.name}
              </span>
              <span className="last-roll-outcome">{outcomeShort(outcome)}</span>
            </li>
          )
        })}
      </ul>
    </div>
  )
}
