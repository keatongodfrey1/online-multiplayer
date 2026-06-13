import { useGame } from '../game/store'
import { totalPoints } from '../game/scoring'
import { squareLabel } from './labels'
import type { Phase } from '../game/types'

const COLORS = ['#b74545', '#4a7ab8', '#3e8b5a', '#c9a140', '#5c3d8a', '#b55a9b']

// Phases where mid-game removal is safe to dispatch. Unstable phases have
// in-flight per-turn state (duel pot, pending steal target, pending fine
// selection) that half-removal would leave inconsistent.
const REMOVAL_SAFE_PHASES: Phase[] = ['turn-start', 'optional-actions']

export function OtherPlayers() {
  const { state, dispatch } = useGame()

  const removalSafe = REMOVAL_SAFE_PHASES.includes(state.turn.phase)
  const removalBlockedReason = removalSafe
    ? undefined
    : 'Finish the current action first (duel, steal, or fine payment).'

  const onRemove = (id: string, name: string) => {
    if (!window.confirm(
      `Remove ${name} from the game? Their cash, resources, items, and Bailiff (if held) will leave with them. This can't be undone.`,
    )) {
      return
    }
    dispatch({ type: 'system/removePlayer', id })
  }

  return (
    <aside className="other-players panel">
      <h3>Players</h3>
      <div className="others-list">
        {state.players.map((p) => {
          const active = p.id === state.currentPlayerId
          const inv = p.inventory
          const canRemove = !p.removed && removalSafe
          return (
            <div
              key={p.id}
              className={`other-row ${active ? 'active' : ''} ${p.removed ? 'removed' : ''}`}
              style={{ borderLeftColor: COLORS[p.colorIndex % COLORS.length] }}
            >
              <div className="other-header">
                <strong>{p.name}</strong>
                {p.removed && <span className="chip">Removed</span>}
                {p.dungeon.inDungeon && <span className="chip dungeon">⛓</span>}
                {p.inventory.knight && <span className="chip queen">🛡</span>}
                {p.inventory.queen && <span className="chip queen">👑</span>}
                {p.inventory.allied && <span className="chip ally">🤝</span>}
                {state.bailiff.kind === 'held' && state.bailiff.by === p.id && (
                  <span className="chip bailiff">🪙 Bailiff</span>
                )}
                {!p.removed && (
                  <button
                    className="other-remove"
                    title={removalBlockedReason ?? `Remove ${p.name} from the game`}
                    disabled={!canRemove}
                    onClick={() => onRemove(p.id, p.name)}
                    aria-label={`Remove ${p.name}`}
                  >
                    ✕
                  </button>
                )}
              </div>
              <div className="muted small">
                {squareLabel(p.position)} · {totalPoints(inv)} pts
              </div>
              <div className="muted small">
                ${inv.dollars} · 🧱{inv.bricks} · 🪵{inv.sticks} · Rm:{inv.rooms} · Bld:{inv.buildings}
                {inv.palaces > 0 && ` · 🏰${inv.palaces}`}
              </div>
            </div>
          )
        })}
      </div>
    </aside>
  )
}
