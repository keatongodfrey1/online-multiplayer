import { useState } from 'react'
import { useGame, clearAutoSave } from '../game/store'
import { MAX_PLAYERS, MIN_PLAYERS } from '../game/constants'

export function Setup() {
  const { state, dispatch } = useGame()
  const [name, setName] = useState('')

  const addPlayer = () => {
    if (name.trim().length === 0) return
    dispatch({ type: 'setup/addPlayer', name: name.trim() })
    setName('')
  }

  const canStart = state.players.length >= MIN_PLAYERS

  const resetAll = () => {
    if (!confirm('Start a fresh game? Your current progress will be lost.')) return
    clearAutoSave()
    dispatch({ type: 'system/reset' })
  }

  return (
    <main className="setup panel">
      <h2>Players</h2>
      <p className="muted">
        Enter names for {MIN_PLAYERS}–{MAX_PLAYERS} players. The game is designed for the whole
        family, ages ~10 and up.
      </p>

      <div className="player-list">
        {state.players.map((p, i) => (
          <div key={p.id} className={`player-row color-${i}`}>
            <span className="badge">{i + 1}</span>
            <input
              className="name-input"
              value={p.name}
              onChange={(e) =>
                dispatch({ type: 'setup/renamePlayer', id: p.id, name: e.target.value })
              }
            />
            <button
              className="small"
              onClick={() => dispatch({ type: 'setup/removePlayer', id: p.id })}
            >
              Remove
            </button>
          </div>
        ))}
      </div>

      {state.players.length < MAX_PLAYERS && (
        <div className="add-player">
          <input
            value={name}
            placeholder={`Player ${state.players.length + 1} name`}
            onChange={(e) => setName(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') addPlayer()
            }}
          />
          <button className="primary" onClick={addPlayer} disabled={!name.trim()}>
            Add Player
          </button>
        </div>
      )}

      <div className="setup-actions">
        <button
          className="gold big"
          onClick={() => dispatch({ type: 'setup/startInitialRoll' })}
          disabled={!canStart}
          title={canStart ? '' : `Need at least ${MIN_PLAYERS} players.`}
        >
          Start Game →
        </button>
        <button className="small ghost" onClick={resetAll}>
          Reset
        </button>
      </div>
    </main>
  )
}
