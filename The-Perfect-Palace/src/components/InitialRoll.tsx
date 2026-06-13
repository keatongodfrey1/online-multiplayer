import { useGame } from '../game/store'

export function InitialRoll() {
  const { state, dispatch } = useGame()

  const roll = (id: string) => {
    const value = Math.floor(Math.random() * 6) + 1
    dispatch({ type: 'initialRoll/rollForPlayer', id, value })
  }

  const allRolled = state.players.every((p) => p.initialRoll != null)

  // Detect a tie for highest — the top seat must be unambiguous before the
  // order can be locked. Ties force a re-roll for the tied players.
  let highest = 0
  let tiedAtTop: string[] = []
  if (allRolled) {
    highest = Math.max(...state.players.map((p) => p.initialRoll ?? 0))
    tiedAtTop = state.players.filter((p) => (p.initialRoll ?? 0) === highest).map((p) => p.id)
  }
  const hasTopTie = tiedAtTop.length > 1

  const ranked = allRolled
    ? [...state.players].sort((a, b) => (b.initialRoll ?? 0) - (a.initialRoll ?? 0))
    : []

  return (
    <main className="panel">
      <h2>🎲 Roll for Turn Order</h2>
      <p className="muted">
        Each player rolls once. Highest roll goes first; turn order proceeds clockwise.
        If two or more players tie for the highest roll, the tied players <strong>must re-roll</strong> until one is highest.
      </p>

      <div className="roll-list">
        {state.players.map((p, i) => {
          const isTied = hasTopTie && tiedAtTop.includes(p.id)
          return (
            <div
              key={p.id}
              className={`player-row color-${i} ${isTied ? 'tied' : ''}`}
              title={isTied ? `Tied at ${highest} — must re-roll.` : undefined}
            >
              <span className="badge">{p.name}</span>
              <span className="roll-value">
                {p.initialRoll != null ? (
                  <>
                    🎲 {p.initialRoll}
                    {isTied && <span className="chip dungeon" style={{ marginLeft: '0.5rem' }}>TIED — re-roll</span>}
                  </>
                ) : (
                  '— not rolled —'
                )}
              </span>
              <button className="small" onClick={() => roll(p.id)}>
                {p.initialRoll != null ? 'Re-roll' : 'Roll 🎲'}
              </button>
            </div>
          )
        })}
      </div>

      {allRolled && !hasTopTie && (
        <p className="muted">
          Order:{' '}
          <strong>
            {ranked.map((p) => p.name).join(' → ')}
          </strong>
        </p>
      )}

      {hasTopTie && (
        <p className="muted" style={{ color: 'var(--red)' }}>
          ⚔️ Tie at {highest} between{' '}
          <strong>
            {tiedAtTop
              .map((id) => state.players.find((p) => p.id === id)?.name ?? id)
              .join(' and ')}
          </strong>
          . Those players must re-roll.
        </p>
      )}

      <div className="setup-actions">
        <button
          className="gold big"
          onClick={() => dispatch({ type: 'initialRoll/finalize' })}
          disabled={!allRolled || hasTopTie}
          title={
            !allRolled
              ? 'All players must roll first.'
              : hasTopTie
                ? 'Tied players must re-roll to resolve the top seat.'
                : ''
          }
        >
          Lock Order →
        </button>
      </div>
    </main>
  )
}
