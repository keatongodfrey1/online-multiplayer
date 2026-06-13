import { useState } from 'react'
import { useGame } from '../game/store'

type StealItem = 'wall' | 'roof' | 'bricks' | 'sticks' | 'dollars'

const ITEMS: { key: StealItem; label: string; amount: string }[] = [
  { key: 'wall', label: 'Wall', amount: '1 wall' },
  { key: 'roof', label: 'Roof', amount: '1 roof' },
  { key: 'bricks', label: 'Bricks', amount: '5 bricks' },
  { key: 'sticks', label: 'Sticks', amount: '5 sticks' },
  { key: 'dollars', label: 'Cash', amount: '$5' },
]

type BailiffMode = 'pre-roll' | 'pre-move' | 'post-roll'

const COMMIT_ACTION: Record<BailiffMode, 'turn/bailiffStealPreRoll' | 'turn/bailiffStealPreMove' | 'turn/bailiffStealPostRoll'> = {
  'pre-roll': 'turn/bailiffStealPreRoll',
  'pre-move': 'turn/bailiffStealPreMove',
  'post-roll': 'turn/bailiffStealPostRoll',
}

const SKIP_ACTION: Record<BailiffMode, 'turn/bailiffStealSkip' | 'turn/bailiffStealPreMoveSkip' | 'turn/bailiffStealPostRollSkip'> = {
  'pre-roll': 'turn/bailiffStealSkip',
  'pre-move': 'turn/bailiffStealPreMoveSkip',
  'post-roll': 'turn/bailiffStealPostRollSkip',
}

const MODE_HINT: Record<BailiffMode, string> = {
  'pre-roll': 'before you roll',
  'pre-move': "after your roll's card draws, before you move — the card gave you the Bailiff",
  'post-roll': 'after your roll — first-turn exception',
}

export function BailiffSteal({ mode }: { mode: BailiffMode }) {
  const { state, dispatch } = useGame()
  const [target, setTarget] = useState<string>('')
  const [item, setItem] = useState<StealItem>('bricks')

  const targets = state.players.filter(
    (p) => p.id !== state.currentPlayerId && !p.removed && !p.inventory.knight,
  )

  const commit = () => {
    if (!target) return
    dispatch({ type: COMMIT_ACTION[mode], targetId: target, item })
  }

  const skip = () => {
    dispatch({ type: SKIP_ACTION[mode] })
  }

  return (
    <div className="bailiff-steal">
      <h4>🪙 You hold the Bailiff</h4>
      <p className="muted small">
        Pick a target and an item to steal ({MODE_HINT[mode]}). Knight-holders are immune.
      </p>
      {targets.length === 0 ? (
        <p className="muted">No valid targets (all opponents are Knight-protected or removed).</p>
      ) : (
        <>
          <div className="steal-row">
            <label>
              Target:{' '}
              <select value={target} onChange={(e) => setTarget(e.target.value)}>
                <option value="">— pick —</option>
                {targets.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.name} (${p.inventory.dollars}, 🧱{p.inventory.bricks}, 🪵{p.inventory.sticks})
                  </option>
                ))}
              </select>
            </label>
          </div>
          <div className="steal-row">
            <label>
              Item:{' '}
              <select value={item} onChange={(e) => setItem(e.target.value as StealItem)}>
                {ITEMS.map((it) => (
                  <option key={it.key} value={it.key}>
                    {it.amount}
                  </option>
                ))}
              </select>
            </label>
          </div>
        </>
      )}
      <div className="actions">
        <button className="gold" disabled={!target || targets.length === 0} onClick={commit}>
          Steal
        </button>
        <button className="ghost" onClick={skip}>
          Skip
        </button>
      </div>
    </div>
  )
}
