import { useGame } from '../game/store'
import { getSquare, BAILIFF_SQUARES, CARD_DRAW_SQUARES, WAR_SQUARES, ALLIANCE_SQUARES } from '../game/board'

/**
 * Always-visible panel that shows the current player's current square in full:
 * number, label, and the long-form `flavor` text so you always know what the
 * square does when you land on it. Sits between the Board and the TurnBar.
 */
export function CurrentSquare() {
  const { state } = useGame()
  const current = state.players.find((p) => p.id === state.currentPlayerId)
  if (!current) return null
  const sq = getSquare(current.position)

  const tags: string[] = []
  if (sq.side === 'corner') tags.push('Corner')
  if (BAILIFF_SQUARES.includes(sq.number)) tags.push('Bailiff transfer')
  if (CARD_DRAW_SQUARES.includes(sq.number)) tags.push('Draw cards')
  if (WAR_SQUARES.includes(sq.number)) tags.push('Invasion')
  if (ALLIANCE_SQUARES.includes(sq.number)) tags.push('Alliance offer')

  return (
    <section className="current-square panel">
      <div className="current-square-head">
        <div className="current-square-badge">#{sq.number}</div>
        <div>
          <div className="current-square-title">{sq.label}</div>
          <div className="muted small">
            {current.name} is here
            {tags.length > 0 && (
              <>
                {' · '}
                {tags.map((t) => (
                  <span key={t} className="chip" style={{ marginLeft: '0.25rem' }}>
                    {t}
                  </span>
                ))}
              </>
            )}
          </div>
        </div>
      </div>
      {sq.flavor && <p className="current-square-flavor">{sq.flavor}</p>}
    </section>
  )
}
