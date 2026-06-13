import { useGame, clearAutoSave } from '../game/store'
import { rankPlayers, totalPoints, staffWeight } from '../game/scoring'

export function EndGame() {
  const { state, dispatch } = useGame()

  const entries = state.players
    .filter((p) => !p.removed)
    .map((p) => ({
      id: p.id,
      name: p.name,
      points: totalPoints(p.inventory),
      staff: staffWeight(p.inventory),
      cash: p.inventory.dollars,
    }))
  const ranked = rankPlayers(entries)
  const winner = ranked[0]

  // Side-table of construction details for display (not used by rankPlayers).
  const constructionById = new Map(
    state.players
      .filter((p) => !p.removed)
      .map((p) => [
        p.id,
        {
          rooms: p.inventory.rooms,
          buildings: p.inventory.buildings,
          threeStoryBuildings: p.inventory.threeStoryBuildings,
          palaces: p.inventory.palaces,
        },
      ]),
  )

  const reset = () => {
    clearAutoSave()
    dispatch({ type: 'system/reset' })
  }

  return (
    <main className="panel endgame">
      <h2>🏁 Game Over</h2>
      {winner && (
        <h3 className="winner">👑 {winner.name} wins!</h3>
      )}
      <table className="score-table">
        <thead>
          <tr>
            <th>Rank</th>
            <th>Player</th>
            <th>Points</th>
            <th>Staff</th>
            <th>Cash</th>
            <th>Rooms</th>
            <th>Buildings</th>
            <th>3-Story</th>
            <th>Palaces</th>
          </tr>
        </thead>
        <tbody>
          {ranked.map((r) => {
            const c = constructionById.get(r.id) ?? {
              rooms: 0,
              buildings: 0,
              threeStoryBuildings: 0,
              palaces: 0,
            }
            return (
              <tr key={r.id} className={r.rank === 1 ? 'winner-row' : ''}>
                <td>#{r.rank}</td>
                <td>{r.name}</td>
                <td>{r.points}</td>
                <td>{r.staff}</td>
                <td>${r.cash}</td>
                <td>{c.rooms}</td>
                <td>{c.buildings}</td>
                <td>{c.threeStoryBuildings}</td>
                <td>{c.palaces}</td>
              </tr>
            )
          })}
        </tbody>
      </table>
      <p className="muted small">
        Tiebreaker: staff count (Queen = 10, WHC = 5, others = 1), then cash.
      </p>
      <div className="setup-actions">
        <button className="gold big" onClick={reset}>
          New Game
        </button>
      </div>
    </main>
  )
}
