import { useState } from 'react'
import { useGame } from '../game/store'
import { RESOURCE_OPTIONS, type ResourceCard, type ResourceOutcome } from '../game/types'
import { outcomeLabel } from './labels'

// Swap `newOption` into `slotIndex`, displacing whichever slot currently holds
// it. Preserves the one-to-one mapping invariant during picker editing.
function swapToSlot(
  card: ResourceOutcome[],
  slotIndex: number,
  newOption: ResourceOutcome,
): ResourceOutcome[] {
  const targetKey = JSON.stringify(newOption)
  const otherSlot = card.findIndex((o) => JSON.stringify(o) === targetKey)
  const next = [...card]
  if (otherSlot === -1 || otherSlot === slotIndex) {
    next[slotIndex] = newOption
    return next
  }
  const displaced = card[slotIndex]
  next[slotIndex] = newOption
  next[otherSlot] = displaced
  return next
}

/**
 * Each player picks their 6-slot mapping (one of the 6 outcomes per die face).
 * To keep hotseat honest, we use a "pass the device" flow:
 *   - Player N sees their own picker.
 *   - They lock it; pass to player N+1.
 *   - Once all have locked, we reveal all mappings side-by-side.
 */
export function InitialMapping() {
  const { state } = useGame()
  const unlocked = state.players.find((p) => !p.mappingLocked)

  if (!unlocked) {
    return <MappingReveal />
  }

  return <SinglePlayerPicker playerId={unlocked.id} />
}

function SinglePlayerPicker({ playerId }: { playerId: string }) {
  const { state, dispatch } = useGame()
  const player = state.players.find((p) => p.id === playerId)!
  const [card, setCard] = useState<ResourceOutcome[]>(() => [...player.resourceCard])

  const setSlot = (slot: number, optionIndex: number) => {
    // Swap-based edit: placing option X on slot A moves whatever was on A to
    // the slot that used to hold X. Keeps the card a one-to-one mapping.
    setCard(swapToSlot(card, slot, RESOURCE_OPTIONS[optionIndex]))
  }

  const lock = () => {
    dispatch({
      type: 'mapping/setInitial',
      id: player.id,
      card: card as unknown as ResourceCard,
    })
  }

  return (
    <main className="panel mapping">
      <h2>Resource Card — {player.name}</h2>
      <p className="muted">
        Each of the 6 outcomes must appear exactly once — placing one on a die face will <strong>swap</strong> it with the face that used to hold it. Your mapping is hidden until everyone locks in.
      </p>

      <div className="mapping-grid">
        {card.map((outcome, i) => (
          <div key={i} className="mapping-row">
            <span className="die-face">🎲 {i + 1}</span>
            <select
              value={RESOURCE_OPTIONS.findIndex((o) => JSON.stringify(o) === JSON.stringify(outcome))}
              onChange={(e) => setSlot(i, Number(e.target.value))}
            >
              {RESOURCE_OPTIONS.map((o, idx) => (
                <option key={idx} value={idx}>
                  {outcomeLabel(o)}
                </option>
              ))}
            </select>
          </div>
        ))}
      </div>

      <div className="setup-actions">
        <button className="gold big" onClick={lock}>
          Lock In & Pass →
        </button>
      </div>
    </main>
  )
}

function MappingReveal() {
  const { state, dispatch } = useGame()
  return (
    <main className="panel">
      <h2>All Resource Cards Revealed</h2>
      <p className="muted">Review everyone's picks. When ready, begin play.</p>

      <div className="reveal-grid">
        {state.players.map((p, i) => (
          <div key={p.id} className={`reveal-card color-${i}`}>
            <h3>{p.name}</h3>
            <ol className="reveal-list">
              {p.resourceCard.map((o, idx) => (
                <li key={idx}>
                  <strong>{idx + 1}:</strong> {outcomeLabel(o)}
                </li>
              ))}
            </ol>
          </div>
        ))}
      </div>

      <div className="setup-actions">
        <button className="gold big" onClick={() => dispatch({ type: 'mapping/revealAll' })}>
          Begin the Game →
        </button>
      </div>
    </main>
  )
}
