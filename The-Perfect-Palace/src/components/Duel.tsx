import { useState } from 'react'
import { useGame } from '../game/store'
import type { DuelStake } from '../game/types'
import { DUEL_MIN_STAKE } from '../game/constants'

export function Duel() {
  const { state, dispatch } = useGame()
  const duel = state.duel
  if (!duel) return null

  const staked =
    duel.stake.dollars + duel.stake.bricks + duel.stake.sticks + duel.stake.walls + duel.stake.roofs + duel.stake.rooms > 0
  const allContendersRolled = duel.contenders.every((pid) => duel.rolls[pid] != null)

  if (!staked) {
    return <StakePicker />
  }

  return (
    <div className="panel duel">
      <h3>⚔️ Duel at square #{duel.squareNumber}</h3>
      <div className="duel-participants">
        {duel.participants.map((pid) => {
          const p = state.players.find((pp) => pp.id === pid)!
          const rolled = duel.rolls[pid]
          const isContender = duel.contenders.includes(pid)
          return (
            <div
              key={pid}
              className={`duel-participant ${isContender ? '' : 'eliminated'}`}
            >
              <strong>{p.name}</strong>
              {!isContender ? (
                <div className="duel-roll muted">— eliminated —</div>
              ) : rolled != null ? (
                <div className="duel-roll">🎲 {rolled}</div>
              ) : (
                <button
                  className="small"
                  onClick={() =>
                    dispatch({
                      type: 'turn/duelRollForPlayer',
                      id: pid,
                      value: Math.floor(Math.random() * 6) + 1,
                    })
                  }
                >
                  Roll 🎲
                </button>
              )}
            </div>
          )
        })}
      </div>
      {allContendersRolled && (
        <button
          className="gold big"
          onClick={() => dispatch({ type: 'turn/duelResolve' })}
        >
          Resolve Duel →
        </button>
      )}
    </div>
  )
}

function StakePicker() {
  const { state, dispatch } = useGame()
  const duel = state.duel!
  const [stake, setStake] = useState<DuelStake>({
    dollars: 0,
    bricks: 0,
    sticks: 0,
    walls: 0,
    roofs: 0,
    rooms: 0,
  })

  // Max each participant can contribute (simple view; UI could be richer).
  const minOf = (field: keyof DuelStake) =>
    Math.min(...duel.participants.map((pid) => {
      const p = state.players.find((pp) => pp.id === pid)!
      if (field === 'dollars') return p.inventory.dollars
      if (field === 'bricks') return p.inventory.bricks
      if (field === 'sticks') return p.inventory.sticks
      if (field === 'walls') return p.inventory.walls
      if (field === 'roofs') return p.inventory.roofs
      if (field === 'rooms') return p.inventory.rooms
      return 0
    }))

  const set = (k: keyof DuelStake, v: number) => {
    const max = minOf(k)
    setStake({ ...stake, [k]: Math.max(0, Math.min(max, Math.floor(v) || 0)) })
  }

  const totalUnits =
    stake.dollars + stake.bricks + stake.sticks + stake.walls + stake.roofs + stake.rooms
  const meetsMin =
    stake.dollars >= DUEL_MIN_STAKE.dollars ||
    stake.bricks >= DUEL_MIN_STAKE.bricks ||
    stake.sticks >= DUEL_MIN_STAKE.sticks ||
    stake.walls >= 1 ||
    stake.roofs >= 1 ||
    stake.rooms >= 1

  return (
    <div className="panel duel">
      <h3>⚔️ Duel at square #{duel.squareNumber}</h3>
      <p className="muted small">
        The arriving player sets a stake that every participant must match. Each player puts the
        same stake into a shared pot. Minimum: $5, 5 bricks, 5 sticks, or 1 wall/roof/room.
      </p>
      <div className="stake-grid">
        {(['dollars', 'bricks', 'sticks', 'walls', 'roofs', 'rooms'] as (keyof DuelStake)[]).map(
          (k) => (
            <label key={k} className="stake-field">
              <span className="stake-label">{k}</span>
              <input
                type="number"
                min={0}
                max={minOf(k)}
                value={stake[k]}
                onChange={(e) => set(k, Number(e.target.value))}
              />
              <span className="stake-max">max {minOf(k)}</span>
            </label>
          ),
        )}
      </div>
      <div className="muted small">
        Pot if locked: {totalUnits} units × {duel.participants.length} players
      </div>
      <button
        className="gold big"
        disabled={!meetsMin}
        title={meetsMin ? undefined : 'Minimum not met — set at least 5 of cash/bricks/sticks, or 1 item.'}
        onClick={() => dispatch({ type: 'turn/duelSetStake', stake })}
      >
        Lock Stake — Everyone Contributes →
      </button>
    </div>
  )
}
