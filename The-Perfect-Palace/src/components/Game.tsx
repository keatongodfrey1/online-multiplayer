import { Board } from './Board'
import { CurrentSquare } from './CurrentSquare'
import { PlayerPanel } from './PlayerPanel'
import { OtherPlayers } from './OtherPlayers'
import { TurnBar } from './TurnBar'
import { GameLog } from './GameLog'
import { RulesModal } from './RulesModal'
import { SaveSlotsModal } from './SaveSlotsModal'
import { QuitConfirmModal } from './QuitConfirmModal'
import { useState } from 'react'
import './Game.css'

export function Game() {
  const [rulesOpen, setRulesOpen] = useState(false)
  const [savesOpen, setSavesOpen] = useState(false)
  const [quitOpen, setQuitOpen] = useState(false)

  return (
    <div className="game">
      <div className="game-top-row">
        <Board />
        <GameLog />
        <aside className="players-col">
          <div className="sidebar-actions">
            <button className="ghost small" onClick={() => setSavesOpen(true)}>
              💾 Save
            </button>
            <button className="ghost small" onClick={() => setRulesOpen(true)}>
              📖 Rules
            </button>
            <button className="ghost small" onClick={() => setQuitOpen(true)}>
              🏳 Quit
            </button>
          </div>
          <OtherPlayers />
        </aside>
      </div>
      <CurrentSquare />
      <div className="panels-row">
        <TurnBar />
        <PlayerPanel />
      </div>
      {rulesOpen && <RulesModal onClose={() => setRulesOpen(false)} />}
      {savesOpen && <SaveSlotsModal onClose={() => setSavesOpen(false)} />}
      {quitOpen && (
        <QuitConfirmModal
          onClose={() => setQuitOpen(false)}
          onSaveFirst={() => {
            setQuitOpen(false)
            setSavesOpen(true)
          }}
        />
      )}
    </div>
  )
}
