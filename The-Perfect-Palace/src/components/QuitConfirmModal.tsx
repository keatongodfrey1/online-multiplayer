import { clearAutoSave, useGame } from '../game/store'

interface QuitConfirmModalProps {
  onClose: () => void
  onSaveFirst: () => void
}

export function QuitConfirmModal({ onClose, onSaveFirst }: QuitConfirmModalProps) {
  const { dispatch } = useGame()

  const onQuit = () => {
    clearAutoSave()
    dispatch({ type: 'system/reset' })
  }

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal quit-modal" onClick={(e) => e.stopPropagation()}>
        <header>
          <h2>🏳 Quit the current game?</h2>
          <button className="small ghost" onClick={onClose}>
            ✕ Close
          </button>
        </header>
        <div className="quit-body">
          <p>
            This returns to the setup screen and clears the autosave. Named save slots are
            preserved — you can always come back to them from Save / Load.
          </p>
          <p className="muted small">
            Tip: if you want to resume this exact game later, save it to a slot first.
          </p>
          <div className="quit-actions">
            <button className="ghost" onClick={onClose}>
              Cancel
            </button>
            <button className="primary" onClick={onSaveFirst}>
              💾 Save first…
            </button>
            <button className="gold" onClick={onQuit}>
              🏳 Quit
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}
