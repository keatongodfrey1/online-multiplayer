import { useGame } from '../game/store'
import { RESOURCE_OPTIONS } from '../game/types'
import { POINTS } from '../game/constants'
import { totalPoints } from '../game/scoring'
import { outcomeLabel } from './labels'

const COLORS = ['#b74545', '#4a7ab8', '#3e8b5a', '#c9a140', '#5c3d8a', '#b55a9b']

export function PlayerPanel() {
  const { state } = useGame()
  const current = state.players.find((p) => p.id === state.currentPlayerId)
  if (!current) return null

  return (
    <section className="player-panel panel">
      <header
        className="player-panel-header"
        style={{ borderColor: COLORS[current.colorIndex % COLORS.length] }}
      >
        <h2>
          {current.name}
          {current.dungeon.inDungeon && <span className="chip dungeon">⛓ In Dungeon</span>}
          {current.inventory.knight && <span className="chip queen">🛡 Knight</span>}
          {current.inventory.queen && <span className="chip queen">👑 Queen</span>}
          {current.inventory.allied && <span className="chip ally">🤝 Allied</span>}
          {state.bailiff.kind === 'held' && state.bailiff.by === current.id && (
            <span className="chip bailiff">🪙 Bailiff</span>
          )}
        </h2>
        <div className="muted">Score: {totalPoints(current.inventory)} pts</div>
      </header>

      <div className="player-panel-body">
        <ResourceInventory />
        <PalaceProgress />
      </div>

      <WorkerPreferenceToggle />

      <ResourceCardView />
    </section>
  )
}

function ResourceInventory() {
  const { state } = useGame()
  const p = state.players.find((pp) => pp.id === state.currentPlayerId)!
  const inv = p.inventory
  return (
    <div className="inventory">
      <h4>Inventory</h4>
      <div className="inv-grid">
        <InvCell icon="💰" label="Cash" value={inv.dollars} />
        <InvCell icon="🧱" label="Bricks" value={inv.bricks} />
        <InvCell icon="🪵" label="Sticks" value={inv.sticks} />
        <InvCell icon="🟫" label="Walls" value={inv.walls} />
        <InvCell icon="🏠" label="Roofs" value={inv.roofs} />
        <InvCell icon="🚪" label="Rooms" value={inv.rooms} points={inv.rooms * POINTS.room} />
        <InvCell icon="🏢" label="Buildings" value={inv.buildings} points={inv.buildings * POINTS.building} />
        <InvCell
          icon="🏬"
          label="3-Story Bldgs"
          value={inv.threeStoryBuildings}
          points={inv.threeStoryBuildings * POINTS.threeStoryBuilding}
        />
        <InvCell
          icon="🏰"
          label="Palaces"
          value={inv.palaces}
          points={inv.palaces * POINTS.palace}
          highlight
        />
        <InvCell icon="🔨" label="Workers" value={inv.workers} points={inv.workers * POINTS.worker} />
        <InvCell icon="🍽" label="Servers" value={inv.servers} points={inv.servers * POINTS.server} />
        <InvCell icon="👨‍🍳" label="Chefs" value={inv.chefs} points={inv.chefs * POINTS.chef} />
        <InvCell icon="🧹" label="Cleaners" value={inv.cleaners} points={inv.cleaners * POINTS.cleaner} />
        <InvCell
          icon="🧽"
          label="WHC"
          value={inv.wholeHouseCleaners}
          points={inv.wholeHouseCleaners * POINTS.wholeHouseCleaner}
        />
        {inv.pardonCards > 0 && <InvCell icon="🎟" label="Pardon" value={inv.pardonCards} highlight />}
      </div>
    </div>
  )
}

function InvCell({
  icon,
  label,
  value,
  points,
  highlight,
}: {
  icon?: string
  label: string
  value: number | boolean
  points?: number
  highlight?: boolean
}) {
  const v = typeof value === 'boolean' ? (value ? '✓' : '—') : value
  return (
    <div className={`inv-cell ${highlight ? 'inv-cell-highlight' : ''}`}>
      <div className="inv-cell-label">
        {icon && <span className="inv-cell-icon">{icon}</span>} {label}
      </div>
      <div className="inv-cell-value">{v}</div>
      {points != null && points > 0 && <div className="inv-cell-points">+{points} pts</div>}
    </div>
  )
}

function PalaceProgress() {
  const { state } = useGame()
  const p = state.players.find((pp) => pp.id === state.currentPlayerId)!
  const inv = p.inventory

  const buildings = inv.buildings
  const threeStory = inv.threeStoryBuildings
  const palaces = inv.palaces

  // Bricks accumulated (in hand or in construction) toward a palace's total (540).
  const totalBricksNeeded = 540
  const bricksAvailable =
    inv.bricks + inv.walls * 5 + inv.rooms * 20 + inv.buildings * 60 +
    inv.threeStoryBuildings * 180 + inv.palaces * 540
  const bricksPct = Math.min(100, (bricksAvailable / totalBricksNeeded) * 100)
  const totalSticksNeeded = 135
  const sticksAvailable =
    inv.sticks + inv.roofs * 5 + inv.rooms * 5 + inv.buildings * 15 +
    inv.threeStoryBuildings * 45 + inv.palaces * 135
  const sticksPct = Math.min(100, (sticksAvailable / totalSticksNeeded) * 100)

  return (
    <div className="palace-progress">
      <h4>Progress toward Palace</h4>
      <ProgressBar label={`Bricks (${bricksAvailable}/${totalBricksNeeded})`} pct={bricksPct} />
      <ProgressBar label={`Sticks (${sticksAvailable}/${totalSticksNeeded})`} pct={sticksPct} />
      <div className="muted small">
        Rooms: {inv.rooms} · Buildings: {buildings} · 3-Story: {threeStory} · Palaces: {palaces}
      </div>
    </div>
  )
}

function ProgressBar({ label, pct }: { label: string; pct: number }) {
  return (
    <div className="progress">
      <div className="progress-label">{label}</div>
      <div className="progress-bar">
        <div className="progress-fill" style={{ width: `${pct}%` }} />
      </div>
    </div>
  )
}

function WorkerPreferenceToggle() {
  const { state, dispatch } = useGame()
  const p = state.players.find((pp) => pp.id === state.currentPlayerId)!
  const n = p.inventory.workers
  const disabled = n === 0
  return (
    <div className={`worker-pref ${disabled ? 'is-disabled' : ''}`}>
      <h4>
        🔨 Worker output{' '}
        {disabled ? (
          <span className="chip" title="Buy a Worker ($50) at the shop to enable">no Workers yet</span>
        ) : (
          <span className="chip queen">
            {n} Worker{n > 1 ? 's' : ''}
          </span>
        )}
      </h4>
      <p className="muted small">
        At the <strong>start</strong> of each of your turns, every Worker you own produces walls/roofs for free. Pick the output:
      </p>
      <div className="worker-pref-row">
        <label title={disabled ? 'Buy a Worker at the shop first.' : undefined}>
          <input
            type="radio"
            name="worker-pref"
            disabled={disabled}
            checked={p.workerPreference === 'wall-roof'}
            onChange={() =>
              dispatch({ type: 'turn/setWorkerPreference', preference: 'wall-roof' })
            }
          />{' '}
          1 wall + 1 roof <span className="muted small">(good for building Rooms)</span>
        </label>
        <label title={disabled ? 'Buy a Worker at the shop first.' : undefined}>
          <input
            type="radio"
            name="worker-pref"
            disabled={disabled}
            checked={p.workerPreference === 'wall-wall'}
            onChange={() =>
              dispatch({ type: 'turn/setWorkerPreference', preference: 'wall-wall' })
            }
          />{' '}
          2 walls <span className="muted small">(good when you already have roofs)</span>
        </label>
      </div>
    </div>
  )
}

function ResourceCardView() {
  const { state, dispatch } = useGame()
  const p = state.players.find((pp) => pp.id === state.currentPlayerId)!
  const changesAvailable = p.mappingChangesAvailable
  // During initial-mapping this view isn't shown (PlayerPanel only renders in-game).
  const locked = changesAvailable <= 0

  return (
    <div className="resource-card">
      <h4>
        Resource Card{' '}
        {!locked && (
          <span className="chip queen" title="Pass Start to earn changes">
            {changesAvailable} change{changesAvailable > 1 ? 's' : ''} available
          </span>
        )}
      </h4>
      <div className="resource-slots">
        {p.resourceCard.map((o, i) => {
          const currentIdx = RESOURCE_OPTIONS.findIndex(
            (opt) => JSON.stringify(opt) === JSON.stringify(o),
          )
          return (
            <div key={`${p.id}-${i}-${currentIdx}`} className="slot">
              <div className="slot-face">🎲 {i + 1}</div>
              <select
                disabled={locked}
                title={locked ? 'Pass or land on Start to earn a change.' : 'Pick a new outcome — uses 1 lap credit.'}
                defaultValue={currentIdx}
                onChange={(e) => {
                  const idx = Number(e.target.value)
                  if (idx === currentIdx) return
                  const newOpt = RESOURCE_OPTIONS[idx]
                  const otherSlot = p.resourceCard.findIndex(
                    (oo) => JSON.stringify(oo) === JSON.stringify(newOpt),
                  )
                  const msg =
                    otherSlot >= 0 && otherSlot !== i
                      ? `Swap die face ${i + 1} ("${outcomeLabel(o)}") with die face ${otherSlot + 1} ("${outcomeLabel(newOpt)}")? This uses 1 lap credit.`
                      : `Change die face ${i + 1} from "${outcomeLabel(o)}" to "${outcomeLabel(newOpt)}"? This uses 1 lap credit.`
                  if (!confirm(msg)) {
                    e.currentTarget.value = String(currentIdx)
                    return
                  }
                  dispatch({
                    type: 'mapping/changeOneSlot',
                    id: p.id,
                    slotIndex: i,
                    option: idx,
                  })
                }}
              >
                {RESOURCE_OPTIONS.map((opt, idx) => (
                  <option key={idx} value={idx}>
                    {outcomeLabel(opt)}
                  </option>
                ))}
              </select>
            </div>
          )
        })}
      </div>
      <p className="muted small">
        {locked
          ? 'Pass or land on Start to earn a 1-slot swap.'
          : 'You have a lap credit — changing a slot swaps it with the face that already has that outcome. All 6 outcomes stay one-to-one.'}
      </p>
    </div>
  )
}
