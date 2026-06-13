import { BOARD } from '../game/board'
import { useGame } from '../game/store'
import type { Player } from '../game/types'
import { LastRollDisplay } from './LastRollDisplay'
import './Board.css'

// Map square number (1-30) to CSS grid position (row, col) in a 10-col × 7-row layout.
// #1 (Start) at bottom-RIGHT. Clockwise motion: LEFT along bottom → up left column →
// RIGHT along top → down right column → back to Start.
//   Bottom row (row 6):  #10 (col 0), #2-#9 (cols 1-8, RIGHT to LEFT as numbers increase), #1 (col 9)
//   Left col  (col 0):   #11-#15 (rows 5-1, BOTTOM to TOP as numbers increase)
//   Top row   (row 0):   #16 (col 0), #17-#24 (cols 1-8), #25 (col 9)
//   Right col (col 9):   #26-#30 (rows 1-5, TOP to BOTTOM as numbers increase)
function squarePosition(n: number): { row: number; col: number } {
  if (n === 1) return { row: 6, col: 9 }
  if (n >= 2 && n <= 9) return { row: 6, col: 9 - (n - 1) } // cols 8..1 as n goes 2..9
  if (n === 10) return { row: 6, col: 0 }
  if (n >= 11 && n <= 15) return { row: 6 - (n - 10), col: 0 } // rows 5..1 as n goes 11..15
  if (n === 16) return { row: 0, col: 0 }
  if (n >= 17 && n <= 24) return { row: 0, col: n - 16 } // cols 1..8 as n goes 17..24
  if (n === 25) return { row: 0, col: 9 }
  if (n >= 26 && n <= 30) return { row: n - 25, col: 9 } // rows 1..5 as n goes 26..30
  throw new Error(`Bad square number: ${n}`)
}

const COLORS = ['#b74545', '#4a7ab8', '#3e8b5a', '#c9a140', '#5c3d8a', '#b55a9b']

export function Board() {
  const { state } = useGame()
  const activePlayer = state.currentPlayerId

  return (
    <div className="board-wrap">
      <div className="board">
        {BOARD.map((sq) => {
          const { row, col } = squarePosition(sq.number)
          const playersHere = state.players.filter(
            (p) => !p.removed && p.position === sq.number,
          )
          const isCorner = sq.side === 'corner'
          const isActive = playersHere.some((p) => p.id === activePlayer)
          return (
            <div
              key={sq.number}
              className={[
                'board-square',
                `side-${sq.side}`,
                isCorner ? 'corner' : '',
                isActive ? 'active' : '',
              ]
                .filter(Boolean)
                .join(' ')}
              style={{ gridRow: row + 1, gridColumn: col + 1 }}
              title={sq.flavor ?? sq.label}
            >
              <div className="sq-number">#{sq.number}</div>
              <div className="sq-label">{sq.label}</div>
              <Tokens players={playersHere} activeId={activePlayer} />
            </div>
          )
        })}

        <div className="board-center">
          <div className="board-title">The Perfect Palace</div>
          <BailiffIcon />
          <LastRollDisplay />
          <Legend />
        </div>
      </div>
    </div>
  )
}

function Tokens({ players, activeId }: { players: Player[]; activeId: string | null }) {
  if (players.length === 0) return null
  return (
    <div className="tokens">
      {players.map((p) => (
        <div
          key={p.id}
          className={`token ${p.id === activeId ? 'token-active' : ''}`}
          style={{ background: COLORS[p.colorIndex % COLORS.length] }}
          title={p.name}
        >
          {p.name.charAt(0).toUpperCase()}
          {p.inventory.knight && <span className="token-badge knight" title="Knight">🛡</span>}
          {p.inventory.queen && <span className="token-badge queen" title="Queen">👑</span>}
        </div>
      ))}
    </div>
  )
}

function BailiffIcon() {
  const { state } = useGame()
  const bailiff = state.bailiff
  if (bailiff.kind === 'middle') {
    return (
      <div className="bailiff-middle" title="The Bailiff waits — unclaimed.">
        🪙 Bailiff
      </div>
    )
  }
  const holder = state.players.find((p) => p.id === bailiff.by)
  return (
    <div className="bailiff-middle held" title={`The Bailiff is held by ${holder?.name}`}>
      🪙 {holder?.name}
    </div>
  )
}

function Legend() {
  return (
    <div className="legend">
      <small>🛡 Knight · 👑 Queen · 🪙 Bailiff · 🏰 Palace</small>
    </div>
  )
}

