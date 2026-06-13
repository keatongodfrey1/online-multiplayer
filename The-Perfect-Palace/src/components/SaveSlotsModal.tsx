import { useMemo, useState } from 'react'
import {
  deleteNamedSave,
  listNamedSaves,
  useGame,
  writeNamedSave,
  type NamedSave,
} from '../game/store'

const MAX_SLOTS = 20

function defaultSaveName(): string {
  const now = new Date()
  // Example: "Apr 19 7:42pm" — short and natural-feeling for kids.
  const opts: Intl.DateTimeFormatOptions = {
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  }
  return now.toLocaleString(undefined, opts).replace(',', '')
}

export function SaveSlotsModal({ onClose }: { onClose: () => void }) {
  const { state, dispatch } = useGame()
  // Tracked state: saves, the name input, an error banner, and a version bump
  // that forces a re-list after any write/delete.
  const [tick, setTick] = useState(0)
  const [name, setName] = useState<string>(defaultSaveName())
  const [error, setError] = useState<string | null>(null)

  const saves = useMemo(() => {
    // Newest first.
    return [...listNamedSaves()].sort((a, b) => b.savedAt - a.savedAt)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tick])

  const nameTrimmed = name.trim()
  const existingNames = new Set(saves.map((s) => s.name))
  const isOverwrite = existingNames.has(nameTrimmed)
  const atCap = saves.length >= MAX_SLOTS && !isOverwrite

  const bump = () => setTick((t) => t + 1)

  const onSave = () => {
    setError(null)
    if (!nameTrimmed) {
      setError('Please enter a name for this save.')
      return
    }
    if (atCap) {
      setError(`Delete an old save first (${MAX_SLOTS} slot max).`)
      return
    }
    if (isOverwrite && !window.confirm(`Overwrite "${nameTrimmed}"?`)) return
    try {
      writeNamedSave(nameTrimmed, state)
      bump()
      setName(defaultSaveName())
    } catch {
      setError('Browser storage is full or disabled — save failed.')
    }
  }

  const onLoad = (s: NamedSave) => {
    setError(null)
    if (
      !window.confirm(
        `Load "${s.name}"? This replaces the current game — the autosave will be overwritten.`,
      )
    )
      return
    dispatch({ type: 'system/loadState', state: s.state })
    onClose()
  }

  const onDelete = (s: NamedSave) => {
    setError(null)
    if (!window.confirm(`Delete "${s.name}"?`)) return
    try {
      deleteNamedSave(s.name)
      bump()
    } catch {
      setError('Browser storage is disabled — delete failed.')
    }
  }

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal saves-modal" onClick={(e) => e.stopPropagation()}>
        <header>
          <h2>💾 Save / Load</h2>
          <button className="small ghost" onClick={onClose}>
            ✕ Close
          </button>
        </header>
        <div className="saves-body">
          <div className="saves-new">
            <label htmlFor="save-name-input">Save the current game as:</label>
            <div className="saves-new-row">
              <input
                id="save-name-input"
                type="text"
                value={name}
                placeholder="e.g. Sunday playtest"
                onChange={(e) => setName(e.target.value)}
              />
              <button className="gold" onClick={onSave} disabled={!nameTrimmed}>
                💾 Save
              </button>
            </div>
            <p className="muted small">
              {isOverwrite
                ? `A save named "${nameTrimmed}" already exists — saving will overwrite it.`
                : `${saves.length} / ${MAX_SLOTS} slots used.`}
            </p>
          </div>

          <hr />

          <h3>Your saves</h3>
          {saves.length === 0 ? (
            <p className="muted">
              No saves yet. Enter a name above and click 💾 Save to create one.
            </p>
          ) : (
            <ul className="saves-list">
              {saves.map((s) => (
                <li key={s.name} className="saves-row">
                  <div className="saves-row-main">
                    <strong>{s.name}</strong>
                    <span className="muted small">
                      {new Date(s.savedAt).toLocaleString()}
                    </span>
                  </div>
                  <div className="saves-row-actions">
                    <button className="primary small" onClick={() => onLoad(s)}>
                      Load
                    </button>
                    <button className="ghost small" onClick={() => onDelete(s)}>
                      Delete
                    </button>
                  </div>
                </li>
              ))}
            </ul>
          )}

          {error && <p className="saves-error">{error}</p>}
        </div>
      </div>
    </div>
  )
}
