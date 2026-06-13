// The main reducer. State transitions for every phase of the game.
// Based on DESIGN.md. This is the source of authority for gameplay logic.

import type {
  GameState,
  Player,
  PlayerId,
  PlayerInventory,
  ResourceCard,
  DuelState,
  DuelStake,
  ResourceOutcome,
} from './types'
import { EMPTY_INVENTORY, EMPTY_STAKE, NOT_IN_DUNGEON, RESOURCE_OPTIONS } from './types'
import type { GameAction, ShopItem, BuildItem } from './actions'
import { advance, passedOrLandedOnStart, getSquare } from './board'
import { freshDeck, getCard, shuffle } from './cards'
import {
  BAILIFF_STEAL_AMOUNTS,
  BRICK_STICK_TRADE_MIN_BATCH,
  BRICK_STICK_TRADE_RATIO,
  DUEL_MIN_STAKE,
  DUNGEON_MAX_TURNS,
  HALF_PRICE_CLEANER_COST,
  KINGDOM_CARD_BONUS,
  PRICE,
  RECIPE,
  TRADER_BRICKS_DEAL,
  TRADER_WALLS_DEAL,
} from './constants'

// ==================== Initial state ====================

export function initialState(): GameState {
  return {
    phase: 'setup',
    players: [],
    turnOrder: [],
    currentPlayerId: null,
    turn: {
      phase: 'setup',
      activePlayerIndex: 0,
      extraTurnsQueued: 0,
      bailiffStealUsedThisTurnSequence: false,
      acquiredBailiffThisTurn: false,
      enteredDungeonThisTurn: false,
      skipOptionalActions: false,
      traderUsedThisTurn: false,
    },
    bailiff: { kind: 'middle' },
    deck: freshDeck(),
    discard: [],
    log: ['A new game is ready to begin.'],
  }
}

// ==================== Helpers ====================

function findPlayer(state: GameState, id: PlayerId): Player {
  const p = state.players.find((p) => p.id === id)
  if (!p) throw new Error(`Unknown player: ${id}`)
  return p
}

function findPlayerIndex(state: GameState, id: PlayerId): number {
  const idx = state.players.findIndex((p) => p.id === id)
  if (idx === -1) throw new Error(`Unknown player: ${id}`)
  return idx
}

function updatePlayer(
  state: GameState,
  id: PlayerId,
  updater: (p: Player) => Player,
): GameState {
  const idx = findPlayerIndex(state, id)
  const players = [...state.players]
  players[idx] = updater(players[idx])
  return { ...state, players }
}

function patchInventory(
  p: Player,
  patch: Partial<PlayerInventory>,
): Player {
  return { ...p, inventory: { ...p.inventory, ...patch } }
}

/**
 * Add numeric deltas (positive or negative) to a player's inventory fields.
 * Boolean fields (queen, allied) are NOT updated by this helper — use patchInventory.
 */
function addInventory(
  p: Player,
  delta: Partial<Record<keyof PlayerInventory, number>>,
): Player {
  const inv = { ...p.inventory }
  for (const k of Object.keys(delta) as (keyof PlayerInventory)[]) {
    const d = delta[k]
    if (typeof d === 'number') {
      ;(inv[k] as number) = (inv[k] as number) + d
    }
  }
  return { ...p, inventory: inv }
}

function log(state: GameState, message: string): GameState {
  return { ...state, log: [...state.log, message] }
}

function currentPlayer(state: GameState): Player {
  if (!state.currentPlayerId) throw new Error('No current player')
  return findPlayer(state, state.currentPlayerId)
}

function rollDie(rng: () => number = Math.random): number {
  return Math.floor(rng() * 6) + 1
}

/**
 * True when the player has owned a Room at any point — either a raw Room or
 * any higher tier built from consumed Rooms. Used to gate the Server/Chef/
 * Cleaner shop prereq. (Raw `rooms` decrements when building a Building;
 * "has a Building" is proof of at least one Room having existed.)
 */
function hasRoomPrereq(p: Player): boolean {
  return (
    p.inventory.rooms +
      p.inventory.buildings +
      p.inventory.threeStoryBuildings +
      p.inventory.palaces >=
    1
  )
}

/**
 * Count of Cleaners for construction prereq purposes. A Whole House Cleaner
 * is built out of 5 consumed Cleaners + 1 Building, so a player holding a
 * WHC has necessarily once owned Cleaners. Each WHC counts as 1 Cleaner for
 * prereq checks (we only need `>= 1` anywhere). Does NOT affect
 * `tryConvertWHC`, which still requires 5 raw Cleaners to trigger.
 */
function effectiveCleaners(p: Player): number {
  return p.inventory.cleaners + p.inventory.wholeHouseCleaners
}

/**
 * Shape-light validator for `system/loadState` payloads. Returns `true` if
 * `value` looks like a GameState we can safely swap in. The goal is to reject
 * tampered or malformed localStorage blobs without crashing — we don't try to
 * exhaustively validate every field (full schema validation would be its own
 * dependency). The checks cover the fields the reducer + UI read unconditionally.
 */
function isLoadableGameState(value: unknown): value is GameState {
  if (typeof value !== 'object' || value === null) return false
  const s = value as Record<string, unknown>
  if (typeof s.phase !== 'string') return false
  if (!Array.isArray(s.players)) return false
  if (!Array.isArray(s.turnOrder)) return false
  if (!(s.currentPlayerId === null || typeof s.currentPlayerId === 'string')) return false
  if (typeof s.turn !== 'object' || s.turn === null) return false
  const turn = s.turn as Record<string, unknown>
  if (typeof turn.phase !== 'string') return false
  if (typeof s.bailiff !== 'object' || s.bailiff === null) return false
  if (!Array.isArray(s.deck)) return false
  if (!Array.isArray(s.discard)) return false
  if (!Array.isArray(s.log)) return false
  return true
}

// ==================== Setup ====================

function addPlayer(state: GameState, name: string): GameState {
  if (state.players.length >= 6) return state
  // Derive the new player's id + colorIndex from MAX+1 of existing, not
  // the current array length. Length-based generation collided after a
  // remove-then-add (playtest round 4): e.g. [p1,p2,p3,p4] → remove p2
  // → [p1,p3,p4] (length 3) → add → id would be "p4", duplicating the
  // existing p4. The max-scan keeps ids unique across removes.
  const maxIdNum = state.players.reduce((m, p) => {
    const n = parseInt(p.id.slice(1), 10)
    return Number.isFinite(n) && n > m ? n : m
  }, 0)
  const idNum = maxIdNum + 1
  const id = `p${idNum}`
  const maxColor = state.players.reduce((m, p) => Math.max(m, p.colorIndex), -1)
  const colorIndex = maxColor + 1
  const defaultCard: ResourceCard = [
    RESOURCE_OPTIONS[0],
    RESOURCE_OPTIONS[1],
    RESOURCE_OPTIONS[2],
    RESOURCE_OPTIONS[3],
    RESOURCE_OPTIONS[4],
    RESOURCE_OPTIONS[5],
  ]
  const player: Player = {
    id,
    name: name.trim() || `Player ${idNum}`,
    colorIndex,
    position: 1,
    inventory: { ...EMPTY_INVENTORY },
    dungeon: { ...NOT_IN_DUNGEON },
    resourceCard: defaultCard,
    baseTurnsTaken: 0,
    removed: false,
    mappingChangesAvailable: 0,
    workerPreference: 'wall-roof',
  }
  return log({ ...state, players: [...state.players, player] }, `${player.name} joined.`)
}

function removePlayerFromSetup(state: GameState, id: PlayerId): GameState {
  const players = state.players.filter((p) => p.id !== id)
  return { ...state, players }
}

function renamePlayer(state: GameState, id: PlayerId, name: string): GameState {
  return updatePlayer(state, id, (p) => ({ ...p, name: name.trim() || p.name }))
}

// ==================== Initial roll (turn order) ====================

function startInitialRoll(state: GameState): GameState {
  if (state.players.length < 2) return state
  return {
    ...state,
    phase: 'initial-roll',
    turn: { ...state.turn, phase: 'initial-roll' },
    log: [...state.log, 'Rolling for turn order — highest roll goes first.'],
  }
}

function recordInitialRoll(state: GameState, id: PlayerId, value: number): GameState {
  return updatePlayer(state, id, (p) => ({ ...p, initialRoll: value }))
}

function finalizeInitialRoll(state: GameState): GameState {
  // All players must have rolled.
  if (state.players.some((p) => p.initialRoll == null)) return state
  // Reject if there's a tie for the highest roll — tied players must re-roll
  // so the first-turn seat is unambiguous.
  const highest = Math.max(...state.players.map((p) => p.initialRoll ?? 0))
  const tiedAtTop = state.players.filter((p) => (p.initialRoll ?? 0) === highest)
  if (tiedAtTop.length > 1) return state
  // Sort by initial-roll value descending.
  const ranked = [...state.players].sort((a, b) => (b.initialRoll ?? 0) - (a.initialRoll ?? 0))
  const turnOrder = ranked.map((p) => p.id)
  // Clear initialRoll on all players.
  const players = state.players.map((p) => {
    const { initialRoll: _unused, ...rest } = p
    return { ...rest, position: 1 } as Player
  })
  return {
    ...state,
    players,
    turnOrder,
    currentPlayerId: turnOrder[0],
    phase: 'initial-mapping',
    turn: { ...state.turn, phase: 'initial-mapping', activePlayerIndex: 0 },
    log: [
      ...state.log,
      `Turn order: ${ranked.map((p) => p.name).join(' → ')}. Now pick your resource cards.`,
    ],
  }
}

// ==================== Initial mapping ====================

/**
 * A resource card MUST be a one-to-one mapping — all 6 RESOURCE_OPTIONS appear
 * exactly once. This helper rejects malformed cards.
 */
export function isValidResourceCard(card: ResourceCard): boolean {
  const seen = new Set<string>()
  for (const o of card) {
    seen.add(JSON.stringify(o))
  }
  if (seen.size !== 6) return false
  for (const opt of RESOURCE_OPTIONS) {
    if (!seen.has(JSON.stringify(opt))) return false
  }
  return true
}

/**
 * Place `newOption` into `slotIndex` while preserving the one-to-one mapping:
 * whichever slot currently holds `newOption` receives the option displaced
 * from `slotIndex` (a swap). If the card is not a valid permutation to begin
 * with (shouldn't happen in normal play), we fall back to a plain set.
 */
function swapToSlot(
  card: ResourceCard,
  slotIndex: number,
  newOption: ResourceOutcome,
): ResourceCard {
  const targetKey = JSON.stringify(newOption)
  const otherSlot = card.findIndex((o) => JSON.stringify(o) === targetKey)
  const next = [...card] as ResourceOutcome[]
  if (otherSlot === -1) {
    next[slotIndex] = newOption
    return next as unknown as ResourceCard
  }
  if (otherSlot === slotIndex) return card // already there; no change
  const displaced = card[slotIndex]
  next[slotIndex] = newOption
  next[otherSlot] = displaced
  return next as unknown as ResourceCard
}

function setInitialMapping(state: GameState, id: PlayerId, card: ResourceCard): GameState {
  if (!isValidResourceCard(card)) return state // reject malformed cards silently
  return updatePlayer(state, id, (p) => ({ ...p, resourceCard: card, mappingLocked: true }))
}

function revealAllMappings(state: GameState): GameState {
  const firstId = state.turnOrder[0]
  const revealed: GameState = {
    ...state,
    phase: 'turn-start',
    turn: {
      ...state.turn,
      phase: 'turn-start',
      activePlayerIndex: 0,
      bailiffStealUsedThisTurnSequence: false,
      acquiredBailiffThisTurn: false,
      extraTurnsQueued: 0,
      skipOptionalActions: false,
      traderUsedThisTurn: false,
    },
    currentPlayerId: firstId,
    log: [...state.log, 'All mappings revealed. Let the game begin!'],
  }
  // Fire turn-start passives for the first player (no-op in practice since
  // inventory is empty at game start, but consistent with every other turn-start).
  return firePlayerStartPassives(revealed, firstId)
}

function changeOneMappingSlot(
  state: GameState,
  id: PlayerId,
  slotIndex: number,
  optionIndex: number,
): GameState {
  if (slotIndex < 0 || slotIndex > 5) return state
  if (optionIndex < 0 || optionIndex >= RESOURCE_OPTIONS.length) return state
  const p = findPlayer(state, id)
  const currentOption = p.resourceCard[slotIndex]
  const newOption = RESOURCE_OPTIONS[optionIndex]
  // No-op: changing to the same value doesn't consume a credit.
  if (JSON.stringify(currentOption) === JSON.stringify(newOption)) return state
  // During initial mapping, changes are unlimited.
  // After the game starts, changes are gated by mappingChangesAvailable (earned by passing Start).
  const midGame =
    state.phase !== 'setup' &&
    state.phase !== 'initial-roll' &&
    state.phase !== 'initial-mapping' &&
    state.phase !== 'mapping-reveal'
  if (midGame && p.mappingChangesAvailable <= 0) return state
  // Enforce one-to-one mapping via a swap: whichever slot currently holds
  // newOption receives the option displaced from slotIndex.
  const newCard = swapToSlot(p.resourceCard, slotIndex, newOption)
  return updatePlayer(state, id, (pp) => ({
    ...pp,
    resourceCard: newCard,
    mappingChangesAvailable: midGame
      ? Math.max(0, pp.mappingChangesAvailable - 1)
      : pp.mappingChangesAvailable,
  }))
}

// ==================== Turn: Bailiff pre-roll steal ====================

function bailiffSteal(
  state: GameState,
  holderId: PlayerId,
  targetId: PlayerId,
  item: 'wall' | 'roof' | 'bricks' | 'sticks' | 'dollars',
): GameState {
  // Knight protects absolutely (revised 2026-04-19).
  const target = findPlayer(state, targetId)
  if (target.inventory.knight) return state // guard (UI should have prevented)

  const holder = findPlayer(state, holderId)
  // Empty-target silent fail logic.
  const amt = BAILIFF_STEAL_AMOUNTS[item === 'wall' ? 'wall' : item === 'roof' ? 'roof' : item]
  let stole = false
  let newState = state

  if (item === 'wall') {
    if (target.inventory.walls >= 1) {
      newState = updatePlayer(newState, targetId, (p) => addInventory(p, { walls: -1 }))
      newState = updatePlayer(newState, holderId, (p) => addInventory(p, { walls: +1 }))
      stole = true
    }
  } else if (item === 'roof') {
    if (target.inventory.roofs >= 1) {
      newState = updatePlayer(newState, targetId, (p) => addInventory(p, { roofs: -1 }))
      newState = updatePlayer(newState, holderId, (p) => addInventory(p, { roofs: +1 }))
      stole = true
    }
  } else if (item === 'bricks') {
    if (target.inventory.bricks >= 5) {
      newState = updatePlayer(newState, targetId, (p) => addInventory(p, { bricks: -5 }))
      newState = updatePlayer(newState, holderId, (p) => addInventory(p, { bricks: +5 }))
      stole = true
    }
  } else if (item === 'sticks') {
    if (target.inventory.sticks >= 5) {
      newState = updatePlayer(newState, targetId, (p) => addInventory(p, { sticks: -5 }))
      newState = updatePlayer(newState, holderId, (p) => addInventory(p, { sticks: +5 }))
      stole = true
    }
  } else if (item === 'dollars') {
    if (target.inventory.dollars >= 5) {
      newState = updatePlayer(newState, targetId, (p) => addInventory(p, { dollars: -5 }))
      newState = updatePlayer(newState, holderId, (p) => addInventory(p, { dollars: +5 }))
      stole = true
    }
  }

  // Mark steal as used this turn sequence either way (fails silently count as used).
  newState = {
    ...newState,
    turn: { ...newState.turn, bailiffStealUsedThisTurnSequence: true },
  }
  const msg = stole
    ? `${holder.name} (Bailiff) took ${amt} ${item} from ${target.name}.`
    : `${holder.name} (Bailiff) tried to take ${item} from ${target.name} — nothing to take.`
  return log(newState, msg)
}

// ==================== Rolling, distributing, moving, square effect ====================

function applyResourceOutcome(p: Player, outcome: ResourceOutcome): Player {
  if (outcome.kind === 'sticks') return addInventory(p, { sticks: outcome.amount })
  if (outcome.kind === 'bricks') return addInventory(p, { bricks: outcome.amount })
  if (outcome.kind === 'dollars') return addInventory(p, { dollars: outcome.amount })
  // 'draw-card' is handled separately — it produces a deck-draw for that player.
  return p
}

function distributeResources(state: GameState, roll: number): GameState {
  // Every player gains what their resource card slot (roll-1) says.
  // Except imprisoned players DO still receive resources per DESIGN.md.
  let newState = state
  const draws: PlayerId[] = []

  // Process players in "clockwise from current turn's roller" order for draws.
  const startIdx = state.turnOrder.findIndex((id) => id === state.currentPlayerId)
  const orderedIds: PlayerId[] = []
  for (let i = 0; i < state.turnOrder.length; i++) {
    orderedIds.push(state.turnOrder[(startIdx + i) % state.turnOrder.length])
  }

  for (const pid of orderedIds) {
    const player = findPlayer(newState, pid)
    if (player.removed) continue
    const outcome = player.resourceCard[roll - 1]
    if (outcome.kind === 'draw-card') {
      draws.push(pid)
    } else {
      newState = updatePlayer(newState, pid, (p) => applyResourceOutcome(p, outcome))
    }
  }

  // Resolve draws in order (clockwise from roller).
  for (const pid of draws) {
    newState = drawOneCard(newState, pid)
  }

  return newState
}

function drawOneCard(state: GameState, drawerId: PlayerId): GameState {
  let newState = state
  if (newState.deck.length === 0) {
    // Reshuffle discard into deck.
    newState = { ...newState, deck: shuffle([...newState.discard]), discard: [] }
  }
  if (newState.deck.length === 0) return newState // nothing to draw (edge case)
  const [cardId, ...rest] = newState.deck
  newState = { ...newState, deck: rest }
  newState = applyCardEffect(newState, drawerId, cardId)
  return newState
}

function applyCardEffect(state: GameState, drawerId: PlayerId, cardId: number): GameState {
  const card = getCard(cardId)
  const drawer = findPlayer(state, drawerId)
  let newState = state
  const logMsg = (msg: string) => log(newState, `${drawer.name} drew "${card.name}" — ${msg}`)

  switch (card.effect.kind) {
    case 'gain-dollars':
      newState = updatePlayer(newState, drawerId, (p) =>
        addInventory(p, { dollars: card.effect.kind === 'gain-dollars' ? card.effect.amount : 0 }),
      )
      newState = logMsg(`+$${(card.effect as { amount: number }).amount}`)
      break
    case 'gain-bricks':
      newState = updatePlayer(newState, drawerId, (p) =>
        addInventory(p, { bricks: (card.effect as { amount: number }).amount }),
      )
      newState = logMsg(`+${(card.effect as { amount: number }).amount} bricks`)
      break
    case 'gain-sticks':
      newState = updatePlayer(newState, drawerId, (p) =>
        addInventory(p, { sticks: (card.effect as { amount: number }).amount }),
      )
      newState = logMsg(`+${(card.effect as { amount: number }).amount} sticks`)
      break
    case 'gain-bricks-and-sticks': {
      const eff = card.effect as { bricks: number; sticks: number }
      newState = updatePlayer(newState, drawerId, (p) =>
        addInventory(p, { bricks: eff.bricks, sticks: eff.sticks }),
      )
      newState = logMsg(`+${eff.bricks} bricks, +${eff.sticks} sticks`)
      break
    }
    case 'get-building':
      newState = updatePlayer(newState, drawerId, (p) => addInventory(p, { buildings: 1 }))
      newState = logMsg('gained a free Building')
      newState = checkPalaceTrigger(newState, drawerId)
      break
    case 'get-room':
      newState = updatePlayer(newState, drawerId, (p) => addInventory(p, { rooms: 1 }))
      newState = logMsg('gained a free Room')
      break
    case 'get-server':
      newState = updatePlayer(newState, drawerId, (p) => addInventory(p, { servers: 1 }))
      newState = logMsg('gained a free Server')
      break
    case 'get-cleaner':
      newState = updatePlayer(newState, drawerId, (p) => addInventory(p, { cleaners: 1 }))
      newState = logMsg('gained a free Cleaner')
      newState = tryConvertWHC(newState, drawerId)
      break
    case 'get-chef':
      newState = updatePlayer(newState, drawerId, (p) => addInventory(p, { chefs: 1 }))
      newState = logMsg('gained a free Chef')
      break
    case 'alliance-or-bonus':
      if (drawer.inventory.allied) {
        newState = updatePlayer(newState, drawerId, (p) =>
          addInventory(p, { dollars: KINGDOM_CARD_BONUS }),
        )
        newState = logMsg(`already allied — received +$${KINGDOM_CARD_BONUS}`)
      } else {
        newState = updatePlayer(newState, drawerId, (p) =>
          patchInventory(p, { allied: true }),
        )
        newState = logMsg('allied with the Neighboring Kingdom')
      }
      break
    case 'draw-another':
      newState = log(newState, `${drawer.name} drew "Draw Another Card" — chaining…`)
      newState = drawOneCard(newState, drawerId)
      break
    case 'royal-pardon':
      newState = updatePlayer(newState, drawerId, (p) =>
        addInventory(p, { pardonCards: 1 }),
      )
      newState = logMsg('Royal Pardon — hold for later escape from the dungeon')
      // Persistent card: do NOT discard; it stays with the player.
      return newState
    case 'get-bailiff': {
      // If the drawer already holds the Bailiff, the card is a silent no-op:
      // no transfer (nothing to transfer), no post-roll-steal prompt (which
      // would break the once-per-turn-sequence cap).
      const alreadyHolder =
        newState.bailiff.kind === 'held' && newState.bailiff.by === drawerId
      if (alreadyHolder) {
        break
      }
      newState = transferBailiffTo(newState, drawerId)
      newState = logMsg('took the Bailiff')
      // Only set the post-roll-steal flag if the drawer IS the active player.
      // A non-current player drawing the Bailiff via multi-player "draw a card"
      // distribution doesn't grant the active player a post-roll steal.
      if (drawerId === newState.currentPlayerId) {
        newState = {
          ...newState,
          turn: { ...newState.turn, acquiredBailiffThisTurn: true },
        }
      }
      break
    }
  }

  // Move card to discard (unless it was persistent, handled via early return above).
  newState = { ...newState, discard: [...newState.discard, cardId] }
  return newState
}

function transferBailiffTo(state: GameState, newHolderId: PlayerId): GameState {
  return {
    ...state,
    bailiff: { kind: 'held', by: newHolderId },
  }
}

function tryConvertWHC(state: GameState, playerId: PlayerId): GameState {
  const p = findPlayer(state, playerId)
  if (p.inventory.buildings < 1) return state // needs a building for conversion
  if (p.inventory.cleaners < 5) return state
  const groups = Math.floor(p.inventory.cleaners / 5)
  if (groups === 0) return state
  const newState = updatePlayer(state, playerId, (pp) =>
    addInventory(pp, {
      cleaners: -(groups * 5),
      wholeHouseCleaners: groups,
    }),
  )
  return log(
    newState,
    `${p.name}: ${groups * 5} Cleaners converted into ${groups} Whole House Cleaner${groups > 1 ? 's' : ''}.`,
  )
}

/**
 * Fire Worker + Whole House Cleaner passives for `playerId` at the start of
 * their own turn. Called on every transition INTO turn-start for the active
 * player (next-player, extra-turn, pardon redemption, game start).
 *
 * - Imprisoned players receive no passives (design rule).
 * - Inventory is read from state, so a Worker bought this same turn cannot fire
 *   (the buy happens in optional-actions, after this has already run).
 */
function firePlayerStartPassives(state: GameState, playerId: PlayerId): GameState {
  const p = findPlayer(state, playerId)
  if (p.removed) return state
  if (p.dungeon.inDungeon) return state
  let newState = state
  if (p.inventory.workers > 0) {
    const n = p.inventory.workers
    if (p.workerPreference === 'wall-wall') {
      newState = updatePlayer(newState, p.id, (pp) => addInventory(pp, { walls: n * 2 }))
      newState = log(newState, `${p.name}'s ${n} Worker(s) produce ${n * 2} wall(s).`)
    } else {
      newState = updatePlayer(newState, p.id, (pp) => addInventory(pp, { walls: n, roofs: n }))
      newState = log(newState, `${p.name}'s ${n} Worker(s) produce ${n} wall(s) + ${n} roof(s).`)
    }
  }
  if (p.inventory.wholeHouseCleaners > 0) {
    const income = p.inventory.wholeHouseCleaners * 15
    newState = updatePlayer(newState, p.id, (pp) => addInventory(pp, { dollars: income }))
    newState = log(newState, `${p.name}'s Whole House Cleaner(s) bring in $${income}.`)
  }
  return newState
}

function checkPalaceTrigger(state: GameState, builderId: PlayerId): GameState {
  const p = findPlayer(state, builderId)
  if (p.inventory.palaces < 1 || state.palaceBuiltBy) return state
  const triggerCount = p.baseTurnsTaken + 1
  const preCounts = state.players
    .filter((pp) => !pp.removed)
    .map((pp) => `${pp.name}=${pp.baseTurnsTaken}`)
    .join(', ')
  return {
    ...state,
    palaceBuiltBy: builderId,
    palaceTriggerTurnIndex: p.baseTurnsTaken,
    log: [
      ...state.log,
      `🏰 ${p.name} built a Palace! Each other player takes one more turn. (triggerCount=${triggerCount}; pre-endTurn counts: ${preCounts})`,
    ],
  }
}

// ==================== Dice roll & turn flow ====================

function commitRoll(state: GameState, value: number): GameState {
  const player = currentPlayer(state)

  // Imprisoned: check for release (roll a 1 or 3rd turn).
  if (player.dungeon.inDungeon) {
    return resolveDungeonTurn(state, value)
  }

  let newState: GameState = {
    ...state,
    turn: { ...state.turn, lastRoll: value, phase: 'distributing' },
    log: [...state.log, `${player.name} rolled a ${value}.`],
  }

  // Distribute resources to every player based on their mapping for `value`.
  newState = distributeResources(newState, value)

  // If a card drawn during the roll gave the ACTIVE player the Bailiff, pause
  // BEFORE movement so the player can use the Bailiff's one steal — otherwise
  // a movement that lands on #10 (or a tribute-insolvency prior to revision)
  // could strip the Bailiff before the steal opportunity ever fires. Imprisoned
  // players never get passives or steals, so gate on dungeon state defensively
  // (in practice imprisoned rollers go through resolveDungeonTurn, not here).
  if (newState.turn.acquiredBailiffThisTurn && !player.dungeon.inDungeon) {
    return { ...newState, turn: { ...newState.turn, phase: 'pre-move-bailiff' } }
  }

  return completeRollAfterDistribute(newState)
}

/**
 * Resumes a turn after the pre-move-bailiff pause (or directly from commitRoll
 * when no pause was needed). Uses `state.turn.lastRoll` as the roll value.
 * Handles movement, pass-Start bonus, square effect, pendingDecision pauses,
 * and `advanceAfterSquare` routing.
 */
function completeRollAfterDistribute(state: GameState): GameState {
  const value = state.turn.lastRoll
  if (value == null) return state
  const player = currentPlayer(state)
  const destination = advance(player.position, value)
  const passedStart = passedOrLandedOnStart(player.position, value)

  let newState = updatePlayer(state, player.id, (p) => ({ ...p, position: destination }))
  newState = log(newState, `${player.name} moved to square ${destination}.`)

  if (passedStart) {
    newState = updatePlayer(newState, player.id, (p) => ({
      ...addInventory(p, { dollars: 10 }),
      mappingChangesAvailable: p.mappingChangesAvailable + 1,
    }))
    newState = log(newState, `${player.name} passed Start — +$10 and may change 1 resource card slot.`)
  }

  newState = { ...newState, turn: { ...newState.turn, phase: 'square-effect' } }
  newState = resolveSquareEffect(newState, destination)

  if (pendingDecision(newState)) return newState
  return advanceAfterSquare(newState)
}

function pendingDecision(state: GameState): boolean {
  const player = currentPlayer(state)
  const square = getSquare(player.position)
  if (square.effect.kind === 'alliance-offer' && !player.inventory.allied) return true
  if (square.effect.kind === 'bricks-or-wall') return true
  if (state.turn.pendingFine) return true
  return false
}

/**
 * End of a phase that would normally lead to 'optional-actions'. If the
 * #24-set `skipOptionalActions` flag is on, auto-end the turn instead
 * (the roller goes straight to their re-roll).
 */
function completeTurnOrEnterOptional(state: GameState): GameState {
  if (state.turn.skipOptionalActions) {
    return endTurn(state)
  }
  return { ...state, turn: { ...state.turn, phase: 'optional-actions' } }
}

function advanceAfterSquare(state: GameState): GameState {
  // Idempotent: once we've moved past square-effect, don't re-run duel checks.
  if (
    state.turn.phase === 'duel' ||
    state.turn.phase === 'post-roll-bailiff' ||
    state.turn.phase === 'optional-actions'
  ) {
    return state
  }
  const player = currentPlayer(state)
  // If the current player is imprisoned (just entered dungeon, or was already imprisoned somehow),
  // skip the duel and go straight to optional actions (which they can do IF they entered mid-turn).
  if (player.dungeon.inDungeon) {
    if (state.turn.acquiredBailiffThisTurn) {
      return { ...state, turn: { ...state.turn, phase: 'post-roll-bailiff' } }
    }
    return completeTurnOrEnterOptional(state)
  }
  // Same-square duel?
  const duelOthers = state.players.filter(
    (p) => p.id !== player.id && !p.removed && !p.dungeon.inDungeon && p.position === player.position,
  )
  if (duelOthers.length > 0) {
    const participants = [player.id, ...duelOthers.map((p) => p.id)]
    return {
      ...state,
      turn: { ...state.turn, phase: 'duel' },
      duel: {
        squareNumber: player.position,
        participants,
        contenders: [...participants],
        stake: { ...EMPTY_STAKE },
        rolls: {},
      },
      log: [...state.log, `Same-square duel at #${player.position}!`],
    }
  }
  // Post-roll Bailiff or optional actions.
  if (state.turn.acquiredBailiffThisTurn) {
    return { ...state, turn: { ...state.turn, phase: 'post-roll-bailiff' } }
  }
  return completeTurnOrEnterOptional(state)
}

function resolveDungeonTurn(state: GameState, value: number): GameState {
  const player = currentPlayer(state)
  let newState: GameState = {
    ...state,
    turn: { ...state.turn, lastRoll: value },
    log: [
      ...state.log,
      `${player.name} (in the dungeon) rolled a ${value}.`,
    ],
  }
  // Distribute resources to all players (including imprisoned).
  newState = distributeResources(newState, value)

  // Advance turns served.
  const newTurnsServed = player.dungeon.turnsServed + 1
  const released = value === 1 || newTurnsServed >= DUNGEON_MAX_TURNS
  if (released) {
    newState = updatePlayer(newState, player.id, (p) => ({
      ...p,
      position: 25,
      dungeon: { ...NOT_IN_DUNGEON },
    }))
    newState = log(
      newState,
      `${player.name} is released from the dungeon (${value === 1 ? 'rolled a 1' : 'served 3 turns'}). Moves to Just Passing — no further action this turn.`,
    )
  } else {
    newState = updatePlayer(newState, player.id, (p) => ({
      ...p,
      dungeon: { ...p.dungeon, turnsServed: newTurnsServed },
    }))
    newState = log(newState, `${player.name} remains in the dungeon (turn ${newTurnsServed}/${DUNGEON_MAX_TURNS}).`)
  }
  // Dungeon turn is fully consumed — go directly to end-of-turn.
  newState = endTurn(newState)
  return newState
}

/**
 * Apply a money fine (#7/#28 tribute or #11 lose-money) using the insolvency
 * forfeit rule (DESIGN.md §1 Money fees & insolvency, revised 2026-04-19).
 * Cash is deducted first; any shortfall becomes a `pendingFine` that pauses
 * the turn so the player can choose items (bricks/sticks/walls/roofs) to
 * forfeit via the FinePaymentPrompt. If the player has no forfeit-eligible
 * items, whatever cash they had is kept and the fine is underpaid with no
 * further penalty. No dungeon entry, no Bailiff loss.
 */
function resolveMoneyFine(
  state: GameState,
  playerId: PlayerId,
  cost: number,
  source: 'invasion' | 'lose-money',
  label: string,
): GameState {
  const p = findPlayer(state, playerId)
  const cashPaid = Math.min(p.inventory.dollars, cost)
  let newState = updatePlayer(state, playerId, (pp) =>
    addInventory(pp, { dollars: -cashPaid }),
  )
  const remaining = cost - cashPaid
  if (remaining === 0) {
    return log(newState, `${p.name} pays ${label}.`)
  }
  // Partial payment — inspect what items the player has available to forfeit.
  const refreshed = findPlayer(newState, playerId)
  const anyItems =
    refreshed.inventory.bricks +
      refreshed.inventory.sticks +
      refreshed.inventory.walls +
      refreshed.inventory.roofs >
    0
  if (!anyItems) {
    // Nothing takeable — log and continue. Fine is partially stiffed (matches
    // the historical #11 behavior: forfeit only what you have).
    return log(
      newState,
      `${p.name} owed ${label} but could only pay $${cashPaid} — nothing else to forfeit.`,
    )
  }
  // Pause the turn at 'square-effect' for a pendingFine decision. The
  // `pendingDecision` pause in commitRoll/helpers picks this up.
  newState = {
    ...newState,
    turn: { ...newState.turn, pendingFine: { amount: remaining, source } },
  }
  return log(
    newState,
    `${p.name} paid $${cashPaid} toward ${label} — $${remaining} remaining (forfeit items to cover).`,
  )
}

/**
 * Value a forfeit-eligible item selection in dollars. Used by payFine to
 * validate that the player's selection meets the pending-fine amount
 * (or equals their entire forfeit-eligible inventory, for partial payment).
 */
function fineSelectionValue(sel: {
  bricks: number
  sticks: number
  walls: number
  roofs: number
}): number {
  return sel.bricks * 1 + sel.sticks * 1 + sel.walls * 5 + sel.roofs * 5
}

function payFine(
  state: GameState,
  sel: { bricks: number; sticks: number; walls: number; roofs: number },
): GameState {
  if (!state.turn.pendingFine) return state
  if (!state.currentPlayerId) return state
  const p = findPlayer(state, state.currentPlayerId)
  // Validate bounds on each selected count.
  if (
    sel.bricks < 0 ||
    sel.sticks < 0 ||
    sel.walls < 0 ||
    sel.roofs < 0 ||
    sel.bricks > p.inventory.bricks ||
    sel.sticks > p.inventory.sticks ||
    sel.walls > p.inventory.walls ||
    sel.roofs > p.inventory.roofs
  ) {
    return state
  }
  const selectedValue = fineSelectionValue(sel)
  const owed = state.turn.pendingFine.amount
  // No-overpay rule (DESIGN.md §1 Money fees & insolvency, revised 2026-04-19):
  // - selectedValue === owed  → accept (exact).
  // - selectedValue >  owed   → reject (overpay).
  // - selectedValue <  owed   → accept ONLY if the player can't add any more
  //   items without exceeding owed. Otherwise reject (force them to keep
  //   building toward the exact or max-feasible amount).
  if (selectedValue > owed) return state
  if (selectedValue < owed) {
    const canAddBrick = sel.bricks < p.inventory.bricks && selectedValue + 1 <= owed
    const canAddStick = sel.sticks < p.inventory.sticks && selectedValue + 1 <= owed
    const canAddWall = sel.walls < p.inventory.walls && selectedValue + 5 <= owed
    const canAddRoof = sel.roofs < p.inventory.roofs && selectedValue + 5 <= owed
    if (canAddBrick || canAddStick || canAddWall || canAddRoof) return state
  }
  let newState = updatePlayer(state, p.id, (pp) =>
    addInventory(pp, {
      bricks: -sel.bricks,
      sticks: -sel.sticks,
      walls: -sel.walls,
      roofs: -sel.roofs,
    }),
  )
  newState = {
    ...newState,
    turn: { ...newState.turn, pendingFine: undefined },
  }
  const paidTotal = selectedValue
  const shortfall = owed - paidTotal
  newState = log(
    newState,
    `${p.name} forfeited ${sel.bricks}🧱 + ${sel.sticks}🪵 + ${sel.walls}🟫 walls + ${sel.roofs}🏠 roofs ($${paidTotal} of $${owed}${shortfall > 0 ? ` — $${shortfall} stiffed` : ''}).`,
  )
  return advanceAfterSquare(newState)
}

function resolveSquareEffect(state: GameState, squareNum: number): GameState {
  const square = getSquare(squareNum)
  const player = currentPlayer(state)
  let newState = state

  switch (square.effect.kind) {
    case 'start':
      // Already awarded $10 via passedStart check in commitRoll.
      // Here, landing (not passing) also applies: since the `$10 + change 1` already fired
      // on the pass check, no double-fire. If the player ends turn ON Start specifically via
      // exact rolled-count landing, the pass check covered it.
      break
    case 'royal-court':
      newState = updatePlayer(newState, player.id, (p) => ({
        ...p,
        position: 25,
        dungeon: { inDungeon: true, turnsServed: 0 },
      }))
      newState = {
        ...newState,
        turn: { ...newState.turn, enteredDungeonThisTurn: true },
      }
      newState = log(newState, `${player.name} is sent to the dungeon!`)
      // Lose Bailiff if held.
      if (newState.bailiff.kind === 'held' && newState.bailiff.by === player.id) {
        newState = { ...newState, bailiff: { kind: 'middle' } }
        newState = log(newState, `The Bailiff returns to the middle of the board.`)
      }
      break
    case 'bricks-or-wall':
      // Player choice — UI will dispatch turn/gift10Bricks or turn/gift1Wall.
      // Temporarily stay in square-effect phase.
      break
    case 'dungeon-just-passing':
      // No effect.
      break
    case 'gain-resources': {
      const eff = square.effect
      const delta: Partial<Record<keyof PlayerInventory, number>> = {}
      if (eff.bricks) delta.bricks = eff.bricks
      if (eff.sticks) delta.sticks = eff.sticks
      if (eff.dollars) delta.dollars = eff.dollars
      newState = updatePlayer(newState, player.id, (p) => addInventory(p, delta))
      const parts: string[] = []
      if (eff.bricks) parts.push(`+${eff.bricks} bricks`)
      if (eff.sticks) parts.push(`+${eff.sticks} sticks`)
      if (eff.dollars) parts.push(`+$${eff.dollars}`)
      newState = log(newState, `${player.name} landed on ${square.label}: ${parts.join(', ')}`)
      break
    }
    case 'gain-room':
      newState = updatePlayer(newState, player.id, (p) => addInventory(p, { rooms: 1 }))
      newState = log(newState, `${player.name} gains a free Room.`)
      break
    case 'alliance-offer':
      // Branching: if already allied, auto-apply freebie; else UI prompts accept/decline.
      if (player.inventory.allied) {
        const cost = square.effect.cost
        newState = updatePlayer(newState, player.id, (p) =>
          addInventory(p, { bricks: cost.bricks, sticks: cost.sticks }),
        )
        newState = log(
          newState,
          `${player.name} is already allied — receives +${cost.bricks} bricks, +${cost.sticks} sticks.`,
        )
      }
      // else: wait for player decision via turn/acceptAlliance or turn/declineAlliance
      break
    case 'invasion': {
      const cost = square.effect.cost
      if (player.inventory.allied) {
        newState = log(newState, `${player.name} is allied with the Kingdom — tribute waived.`)
      } else {
        newState = resolveMoneyFine(newState, player.id, cost, 'invasion', `${cost} tribute`)
      }
      break
    }
    case 'lose-money': {
      const amt = square.effect.amount
      newState = resolveMoneyFine(newState, player.id, amt, 'lose-money', `$${amt}`)
      break
    }
    case 'get-bailiff':
      // If the current player already holds the Bailiff, landing on another
      // Bailiff square is a silent no-op — no transfer, no post-roll-steal
      // prompt (which would break the once-per-turn-sequence cap).
      if (newState.bailiff.kind === 'held' && newState.bailiff.by === player.id) {
        break
      }
      newState = transferBailiffTo(newState, player.id)
      newState = log(newState, `${player.name} takes the Bailiff.`)
      newState = {
        ...newState,
        turn: { ...newState.turn, acquiredBailiffThisTurn: true },
      }
      break
    case 'fortune-teller': {
      const count = square.effect.count
      newState = log(newState, `${player.name} draws ${count} card(s).`)
      for (let i = 0; i < count; i++) {
        newState = drawOneCard(newState, player.id)
      }
      break
    }
    case 'trader-walls':
    case 'trader-bricks':
    case 'half-price-cleaner':
      // These grant discounted actions while on the square.
      // Handled in optional actions. No automatic effect on landing.
      break
    case 'get-server':
      newState = updatePlayer(newState, player.id, (p) => addInventory(p, { servers: 1 }))
      newState = log(newState, `${player.name} gains a free Server.`)
      break
    case 'get-building':
      newState = updatePlayer(newState, player.id, (p) => addInventory(p, { buildings: 1 }))
      newState = log(newState, `${player.name} gains a free Building.`)
      newState = checkPalaceTrigger(newState, player.id)
      break
    case 'roll-again':
      // #24: queue an extra turn AND suppress the shop/build/trade phase for the
      // landing roll — the roller goes straight back to turn-start for the 2nd roll.
      newState = {
        ...newState,
        turn: {
          ...newState.turn,
          extraTurnsQueued: newState.turn.extraTurnsQueued + 1,
          skipOptionalActions: true,
        },
      }
      newState = log(newState, `${player.name} will roll again immediately!`)
      break
    case 'draw-cards': {
      const count = square.effect.count
      for (let i = 0; i < count; i++) {
        newState = drawOneCard(newState, player.id)
      }
      break
    }
  }
  return newState
}

// ==================== Alliance decisions ====================

function acceptAlliance(state: GameState): GameState {
  const player = currentPlayer(state)
  const square = getSquare(player.position)
  if (square.effect.kind !== 'alliance-offer') return state
  if (player.inventory.allied) return state // can't double-ally
  const cost = square.effect.cost
  if (player.inventory.bricks < cost.bricks || player.inventory.sticks < cost.sticks) return state
  let newState = updatePlayer(state, player.id, (p) =>
    addInventory(p, { bricks: -cost.bricks, sticks: -cost.sticks }),
  )
  newState = updatePlayer(newState, player.id, (p) => patchInventory(p, { allied: true }))
  newState = log(newState, `${player.name} allies with the Neighboring Kingdom!`)
  return advanceAfterSquare(newState)
}

function declineAlliance(state: GameState): GameState {
  const player = currentPlayer(state)
  return advanceAfterSquare(log(state, `${player.name} declines the alliance.`))
}

// ==================== #16 Bricks or Wall ====================

function gift10Bricks(state: GameState): GameState {
  const player = currentPlayer(state)
  if (player.position !== 16) return state
  const newState = updatePlayer(state, player.id, (p) => addInventory(p, { bricks: 10 }))
  return advanceAfterSquare(log(newState, `${player.name} chooses 10 bricks.`))
}

function gift1Wall(state: GameState): GameState {
  const player = currentPlayer(state)
  if (player.position !== 16) return state
  const newState = updatePlayer(state, player.id, (p) => addInventory(p, { walls: 1 }))
  return advanceAfterSquare(log(newState, `${player.name} chooses 1 wall.`))
}

// ==================== Shop / Trade / Build ====================

function canBuy(p: Player, item: ShopItem): { ok: boolean; reason?: string } {
  switch (item) {
    case 'brick':
      return p.inventory.dollars >= PRICE.brick
        ? { ok: true }
        : { ok: false, reason: 'Not enough cash.' }
    case 'stick':
      return p.inventory.dollars >= PRICE.stick
        ? { ok: true }
        : { ok: false, reason: 'Not enough cash.' }
    case 'worker':
      return p.inventory.dollars >= PRICE.worker
        ? { ok: true }
        : { ok: false, reason: `Needs $${PRICE.worker}.` }
    case 'server':
      if (!hasRoomPrereq(p))
        return { ok: false, reason: 'Needs at least 1 Room, Building, 3-Story, or Palace.' }
      return p.inventory.dollars >= PRICE.server
        ? { ok: true }
        : { ok: false, reason: `Needs $${PRICE.server}.` }
    case 'chef':
      if (!hasRoomPrereq(p))
        return { ok: false, reason: 'Needs at least 1 Room, Building, 3-Story, or Palace.' }
      return p.inventory.dollars >= PRICE.chef
        ? { ok: true }
        : { ok: false, reason: `Needs $${PRICE.chef}.` }
    case 'cleaner':
      if (!hasRoomPrereq(p))
        return { ok: false, reason: 'Needs at least 1 Room, Building, 3-Story, or Palace.' }
      return p.inventory.dollars >= PRICE.cleaner
        ? { ok: true }
        : { ok: false, reason: `Needs $${PRICE.cleaner}.` }
    case 'queen':
      if (p.inventory.queen) return { ok: false, reason: 'You already own the Queen (max 1).' }
      return p.inventory.dollars >= PRICE.queen
        ? { ok: true }
        : { ok: false, reason: `Needs $${PRICE.queen}.` }
    case 'knight':
      if (p.inventory.knight) return { ok: false, reason: 'You already own a Knight (max 1).' }
      return p.inventory.dollars >= PRICE.knight
        ? { ok: true }
        : { ok: false, reason: `Needs $${PRICE.knight}.` }
  }
}

// True when the active player is imprisoned AND didn't just enter this turn.
// Used to gate optional actions (buy/trade/build) — players who entered mid-turn
// still finish their current turn normally per DESIGN.md §5.
function imprisonedAndLocked(state: GameState): boolean {
  const p = currentPlayer(state)
  return p.dungeon.inDungeon && !state.turn.enteredDungeonThisTurn
}

function buy(state: GameState, item: ShopItem, quantity = 1): GameState {
  const player = currentPlayer(state)
  if (imprisonedAndLocked(state)) return state
  const q = Math.max(1, Math.floor(quantity))
  // Bricks and sticks only sell in bundles of 5.
  if ((item === 'brick' || item === 'stick') && (q < 5 || q % 5 !== 0)) {
    return state
  }

  let newState = state
  for (let i = 0; i < q; i++) {
    const player = currentPlayer(newState)
    const check = canBuy(player, item)
    if (!check.ok) break

    switch (item) {
      case 'brick':
        newState = updatePlayer(newState, player.id, (p) =>
          addInventory(p, { dollars: -PRICE.brick, bricks: 1 }),
        )
        break
      case 'stick':
        newState = updatePlayer(newState, player.id, (p) =>
          addInventory(p, { dollars: -PRICE.stick, sticks: 1 }),
        )
        break
      case 'worker':
        newState = updatePlayer(newState, player.id, (p) =>
          addInventory(p, { dollars: -PRICE.worker, workers: 1 }),
        )
        break
      case 'server':
        newState = updatePlayer(newState, player.id, (p) =>
          addInventory(p, { dollars: -PRICE.server, servers: 1 }),
        )
        break
      case 'chef':
        newState = updatePlayer(newState, player.id, (p) =>
          addInventory(p, { dollars: -PRICE.chef, chefs: 1 }),
        )
        break
      case 'cleaner':
        newState = updatePlayer(newState, player.id, (p) =>
          addInventory(p, { dollars: -PRICE.cleaner, cleaners: 1 }),
        )
        newState = tryConvertWHC(newState, player.id)
        break
      case 'queen':
        newState = updatePlayer(newState, player.id, (p) =>
          addInventory(p, { dollars: -PRICE.queen }),
        )
        newState = updatePlayer(newState, player.id, (p) => patchInventory(p, { queen: true }))
        break
      case 'knight':
        newState = updatePlayer(newState, player.id, (p) =>
          addInventory(p, { dollars: -PRICE.knight }),
        )
        newState = updatePlayer(newState, player.id, (p) => patchInventory(p, { knight: true }))
        break
    }
  }
  return log(newState, `${player.name} bought ${q}× ${item}.`)
}

function trade(state: GameState, from: 'bricks' | 'sticks', amount: number): GameState {
  const player = currentPlayer(state)
  if (imprisonedAndLocked(state)) return state
  // Trades happen in batches of BRICK_STICK_TRADE_MIN_BATCH (10). Anything smaller
  // or not a multiple is rejected outright — no rounding.
  if (amount < BRICK_STICK_TRADE_MIN_BATCH) return state
  if (amount % BRICK_STICK_TRADE_MIN_BATCH !== 0) return state
  if (player.inventory[from] < amount) return state

  const to = from === 'bricks' ? 'sticks' : 'bricks'
  const received = amount / BRICK_STICK_TRADE_RATIO
  const newState = updatePlayer(state, player.id, (p) =>
    addInventory(p, { [from]: -amount, [to]: received }),
  )
  return log(newState, `${player.name} traded ${amount} ${from} for ${received} ${to}.`)
}

function traderWallsBuy(state: GameState, batches: number): GameState {
  const player = currentPlayer(state)
  if (imprisonedAndLocked(state)) return state
  if (player.position !== 8) return state // only at #8
  if (state.turn.traderUsedThisTurn) return state // once per turn sequence
  if (batches <= 0) return state
  const cost = batches * TRADER_WALLS_DEAL.cost
  if (player.inventory.dollars < cost) return state
  const walls = batches * TRADER_WALLS_DEAL.walls
  let newState = updatePlayer(state, player.id, (p) =>
    addInventory(p, { dollars: -cost, walls }),
  )
  newState = { ...newState, turn: { ...newState.turn, traderUsedThisTurn: true } }
  return log(newState, `${player.name} bought ${walls} walls from the Trader for $${cost}.`)
}

function traderBricksSell(state: GameState, batches: number): GameState {
  const player = currentPlayer(state)
  if (imprisonedAndLocked(state)) return state
  if (player.position !== 29) return state // only at #29
  if (state.turn.traderUsedThisTurn) return state // once per turn sequence
  if (batches <= 0) return state
  const bricks = batches * TRADER_BRICKS_DEAL.bricks
  if (player.inventory.bricks < bricks) return state
  const dollars = batches * TRADER_BRICKS_DEAL.dollars
  let newState = updatePlayer(state, player.id, (p) =>
    addInventory(p, { bricks: -bricks, dollars }),
  )
  newState = { ...newState, turn: { ...newState.turn, traderUsedThisTurn: true } }
  return log(newState, `${player.name} traded ${bricks} bricks for $${dollars}.`)
}

function halfPriceCleanerBuy(state: GameState, count: number): GameState {
  const player = currentPlayer(state)
  if (imprisonedAndLocked(state)) return state
  if (player.position !== 14) return state // only at #14
  if (count <= 0) return state
  const cost = count * HALF_PRICE_CLEANER_COST
  if (player.inventory.dollars < cost) return state
  // #14 waives the Room prereq.
  let newState = updatePlayer(state, player.id, (p) =>
    addInventory(p, { dollars: -cost, cleaners: count }),
  )
  newState = log(
    newState,
    `${player.name} hired ${count} Cleaner(s) at half price for $${cost}.`,
  )
  newState = tryConvertWHC(newState, player.id)
  return newState
}

function canBuild(p: Player, item: BuildItem): { ok: boolean; reason?: string } {
  switch (item) {
    case 'wall':
      return p.inventory.bricks >= RECIPE.wall.bricks
        ? { ok: true }
        : { ok: false, reason: `Needs ${RECIPE.wall.bricks} bricks.` }
    case 'roof':
      return p.inventory.sticks >= RECIPE.roof.sticks
        ? { ok: true }
        : { ok: false, reason: `Needs ${RECIPE.roof.sticks} sticks.` }
    case 'room':
      if (p.inventory.walls < RECIPE.room.walls)
        return { ok: false, reason: `Needs ${RECIPE.room.walls} walls.` }
      if (p.inventory.roofs < RECIPE.room.roofs)
        return { ok: false, reason: `Needs ${RECIPE.room.roofs} roof.` }
      return { ok: true }
    case 'building':
      if (p.inventory.rooms < RECIPE.building.rooms)
        return { ok: false, reason: `Needs ${RECIPE.building.rooms} Rooms.` }
      if (p.inventory.servers + p.inventory.chefs + effectiveCleaners(p) < 1)
        return { ok: false, reason: 'Needs at least 1 Server/Chef/Cleaner (WHC counts).' }
      return { ok: true }
    case 'threeStoryBuilding':
      if (p.inventory.buildings < RECIPE.threeStoryBuilding.buildings)
        return {
          ok: false,
          reason: `Needs ${RECIPE.threeStoryBuilding.buildings} Buildings.`,
        }
      if (p.inventory.servers < 1) return { ok: false, reason: 'Needs a Server.' }
      if (p.inventory.chefs < 1) return { ok: false, reason: 'Needs a Chef.' }
      if (effectiveCleaners(p) < 1)
        return { ok: false, reason: 'Needs a Cleaner (or Whole House Cleaner).' }
      return { ok: true }
    case 'palace':
      return p.inventory.threeStoryBuildings >= RECIPE.palace.threeStoryBuildings
        ? { ok: true }
        : {
            ok: false,
            reason: `Needs ${RECIPE.palace.threeStoryBuildings} Three-Story Buildings.`,
          }
  }
}

function build(state: GameState, item: BuildItem, count: number): GameState {
  const player = currentPlayer(state)
  if (imprisonedAndLocked(state)) return state
  if (count <= 0) return state

  let newState = state
  for (let i = 0; i < count; i++) {
    const p = currentPlayer(newState)
    const check = canBuild(p, item)
    if (!check.ok) break

    switch (item) {
      case 'wall':
        newState = updatePlayer(newState, p.id, (pp) =>
          addInventory(pp, { bricks: -RECIPE.wall.bricks, walls: 1 }),
        )
        break
      case 'roof':
        newState = updatePlayer(newState, p.id, (pp) =>
          addInventory(pp, { sticks: -RECIPE.roof.sticks, roofs: 1 }),
        )
        break
      case 'room':
        newState = updatePlayer(newState, p.id, (pp) =>
          addInventory(pp, {
            walls: -RECIPE.room.walls,
            roofs: -RECIPE.room.roofs,
            rooms: 1,
          }),
        )
        break
      case 'building':
        newState = updatePlayer(newState, p.id, (pp) =>
          addInventory(pp, { rooms: -RECIPE.building.rooms, buildings: 1 }),
        )
        newState = tryConvertWHC(newState, p.id)
        break
      case 'threeStoryBuilding':
        newState = updatePlayer(newState, p.id, (pp) =>
          addInventory(pp, {
            buildings: -RECIPE.threeStoryBuilding.buildings,
            threeStoryBuildings: 1,
          }),
        )
        break
      case 'palace':
        newState = updatePlayer(newState, p.id, (pp) =>
          addInventory(pp, {
            threeStoryBuildings: -RECIPE.palace.threeStoryBuildings,
            palaces: 1,
          }),
        )
        newState = checkPalaceTrigger(newState, p.id)
        break
    }
  }
  return log(newState, `${player.name} built ${count}× ${item}.`)
}

// ==================== Duel ====================

function duelSetStake(state: GameState, stake: DuelStake): GameState {
  const existing = state.duel
  if (!existing) return state
  // Validate stake against each participant (can everyone match?)
  // Minimum: at least $5 OR 5 bricks OR 5 sticks OR at least 1 item.
  const totalMin =
    stake.dollars >= DUEL_MIN_STAKE.dollars ||
    stake.bricks >= DUEL_MIN_STAKE.bricks ||
    stake.sticks >= DUEL_MIN_STAKE.sticks ||
    stake.walls >= 1 ||
    stake.roofs >= 1 ||
    stake.rooms >= 1
  if (!totalMin) return state
  // Participants contribute the literal stake. No conversions: UI should have validated.
  let newState: GameState = { ...state, duel: { ...existing, stake } }
  for (const pid of existing.participants) {
    newState = updatePlayer(newState, pid, (p) =>
      addInventory(p, {
        dollars: -stake.dollars,
        bricks: -stake.bricks,
        sticks: -stake.sticks,
        walls: -stake.walls,
        roofs: -stake.roofs,
        rooms: -stake.rooms,
      }),
    )
  }
  return log(newState, `Duel stakes set. Everyone roll!`)
}

function duelRoll(state: GameState, id: PlayerId, value: number): GameState {
  if (!state.duel) return state
  const rolls = { ...state.duel.rolls, [id]: value }
  const newDuel: DuelState = { ...state.duel, rolls }
  return { ...state, duel: newDuel }
}

function duelResolve(state: GameState): GameState {
  if (!state.duel) return state
  const d = state.duel
  const rolls = d.rolls
  // Only contenders compete — participants who were eliminated in prior tie rounds
  // have their stake in the pot but can't win.
  const contenders = d.contenders
  // Need all contenders to have rolled.
  if (contenders.some((pid) => rolls[pid] == null)) return state
  // Find highest among contenders.
  const highest = Math.max(...contenders.map((pid) => rolls[pid]!))
  const winners = contenders.filter((pid) => rolls[pid] === highest)
  if (winners.length > 1) {
    // Re-roll only tied contenders; eliminate non-tied players from future rounds.
    const newRolls: Partial<Record<string, number>> = {}
    // Preserve nothing (clear all tied rolls); non-tied contenders are eliminated.
    return log(
      { ...state, duel: { ...d, rolls: newRolls, contenders: winners } },
      `Tie at ${highest}! ${winners.length} tied players re-roll (others eliminated).`,
    )
  }
  const winnerId = winners[0]
  const multiplier = d.participants.length
  // Pot = stake × participants (everyone contributed). Winner takes all.
  const pot = d.stake
  let newState = updatePlayer(state, winnerId, (p) =>
    addInventory(p, {
      dollars: pot.dollars * multiplier,
      bricks: pot.bricks * multiplier,
      sticks: pot.sticks * multiplier,
      walls: pot.walls * multiplier,
      roofs: pot.roofs * multiplier,
      rooms: pot.rooms * multiplier,
    }),
  )
  newState = tryConvertWHC(newState, winnerId)
  const winner = findPlayer(newState, winnerId)
  newState = log(newState, `🎲 ${winner.name} wins the duel (rolled ${highest})!`)
  // Clear duel, resume turn phase.
  newState = { ...newState, duel: undefined }
  // Proceed to post-roll Bailiff if applicable, else optional actions (or auto-end on #24).
  if (newState.turn.acquiredBailiffThisTurn) {
    newState = { ...newState, turn: { ...newState.turn, phase: 'post-roll-bailiff' } }
    return newState
  }
  return completeTurnOrEnterOptional(newState)
}

// ==================== End turn / next player ====================

function endTurn(state: GameState): GameState {
  // Defensive gates: the UI doesn't expose End Turn during fine-payment or
  // pre-move-bailiff, but reject here too so a future UI bug can't stiff
  // a fine or leave the turn stuck mid-roll.
  if (state.turn.pendingFine) return state
  if (state.turn.phase === 'pre-move-bailiff') return state

  let newState = state
  const p = currentPlayer(newState)

  // NOTE: Worker + WHC passives fire at turn-start (see firePlayerStartPassives),
  // NOT at endTurn. Acquiring a Worker or WHC this turn yields no output this turn —
  // first payout is the next time this player's own turn begins.

  // Handle #24 extra turns FIRST: if queued > 0, the same player goes again and
  // this is still the SAME turn sequence. Per DESIGN.md §1 #24, extra turns are
  // invisible to the equal-turns tally — so we do NOT increment baseTurnsTaken,
  // and Worker/WHC passives do NOT re-fire on the re-roll (one payout per #24
  // sequence, taken on the base turn-start).
  if (newState.turn.extraTurnsQueued > 0) {
    newState = {
      ...newState,
      turn: {
        ...newState.turn,
        extraTurnsQueued: newState.turn.extraTurnsQueued - 1,
        phase: 'turn-start',
        lastRoll: undefined,
        acquiredBailiffThisTurn: false,
        enteredDungeonThisTurn: false,
        skipOptionalActions: false,
        traderUsedThisTurn: false,
        // bailiffStealUsedThisTurnSequence persists across extra turns (once per turn sequence).
      },
    }
    newState = log(newState, `${p.name} rolls again.`)
    return newState
  }

  // This is the real end-of-sequence for this player: credit one base turn and
  // move on (or trigger game-over).
  newState = updatePlayer(newState, p.id, (pp) => ({ ...pp, baseTurnsTaken: pp.baseTurnsTaken + 1 }))

  // Check for game over.
  if (newState.palaceBuiltBy) {
    // Everyone must have taken at least as many base turns as the trigger.
    const triggerCount = newState.palaceTriggerTurnIndex! + 1 // builder took their turn to build
    const allCaughtUp = newState.players.every(
      (pp) => pp.removed || pp.baseTurnsTaken >= triggerCount,
    )
    if (allCaughtUp) {
      const finalCounts = newState.players
        .filter((pp) => !pp.removed)
        .map((pp) => `${pp.name}=${pp.baseTurnsTaken}`)
        .join(', ')
      return {
        ...newState,
        phase: 'game-over',
        turn: { ...newState.turn, phase: 'game-over' },
        log: [
          ...newState.log,
          `🏁 Game over! Final turn counts: ${finalCounts}`,
          'Tallying scores…',
        ],
      }
    }
  }

  // Advance to next player in turnOrder (skipping removed players).
  const turnOrder = newState.turnOrder
  let nextIdx = (turnOrder.findIndex((id) => id === newState.currentPlayerId) + 1) % turnOrder.length
  for (let tries = 0; tries < turnOrder.length; tries++) {
    const candidate = findPlayer(newState, turnOrder[nextIdx])
    if (!candidate.removed) break
    nextIdx = (nextIdx + 1) % turnOrder.length
  }
  const nextId = turnOrder[nextIdx]

  newState = {
    ...newState,
    currentPlayerId: nextId,
    turn: {
      ...newState.turn,
      phase: 'turn-start',
      activePlayerIndex: newState.players.findIndex((pp) => pp.id === nextId),
      lastRoll: undefined,
      acquiredBailiffThisTurn: false,
      bailiffStealUsedThisTurnSequence: false, // new turn sequence, reset
      enteredDungeonThisTurn: false,
      skipOptionalActions: false,
      traderUsedThisTurn: false,
      pendingFine: undefined,
    },
  }
  return firePlayerStartPassives(newState, nextId)
}

// ==================== Dungeon: Royal Pardon redemption ====================

function redeemPardon(state: GameState): GameState {
  const p = currentPlayer(state)
  if (!p.dungeon.inDungeon || p.inventory.pardonCards < 1) return state
  let newState = updatePlayer(state, p.id, (pp) => ({
    ...pp,
    position: 25,
    dungeon: { ...NOT_IN_DUNGEON },
    inventory: { ...pp.inventory, pardonCards: pp.inventory.pardonCards - 1 },
  }))
  // Discard the pardon card (id 17).
  newState = { ...newState, discard: [...newState.discard, 17] }
  newState = log(newState, `${p.name} redeems a Royal Pardon! Escaping to Just Passing for a full normal turn.`)
  // Take a full normal turn: re-enter turn-start so the player can roll, and
  // fire their Worker/WHC passives for this fresh own-turn (no longer imprisoned).
  newState = { ...newState, turn: { ...newState.turn, phase: 'turn-start' } }
  return firePlayerStartPassives(newState, p.id)
}

// ==================== System: remove player / load / reset ====================

function removePlayerMidGame(state: GameState, id: PlayerId): GameState {
  let newState = state
  const p = findPlayer(state, id)
  // Bailiff returns to middle if held.
  if (state.bailiff.kind === 'held' && state.bailiff.by === id) {
    newState = { ...newState, bailiff: { kind: 'middle' } }
  }
  newState = updatePlayer(newState, id, (pp) => ({
    ...pp,
    removed: true,
    inventory: { ...EMPTY_INVENTORY },
  }))
  newState = log(newState, `${p.name} has been removed from the game.`)

  // If ≤1 non-removed player remains, the game is over. The lone survivor (if
  // any) wins by default; the scoreboard still renders with current inventories.
  const remaining = newState.players.filter((pp) => !pp.removed)
  if (remaining.length <= 1) {
    const survivorName = remaining[0]?.name ?? 'No one'
    return {
      ...newState,
      phase: 'game-over',
      turn: { ...newState.turn, phase: 'game-over' },
      log: [
        ...newState.log,
        `🏁 Only ${survivorName} remains — the game ends.`,
      ],
    }
  }

  // If the removed player was the active player, advance turn to the next
  // non-removed player.
  if (state.currentPlayerId === id) {
    newState = endTurn(newState)
  }
  return newState
}

// ==================== Main reducer ====================

export function reducer(state: GameState, action: GameAction): GameState {
  switch (action.type) {
    // Setup
    case 'setup/addPlayer':
      return addPlayer(state, action.name)
    case 'setup/removePlayer':
      return removePlayerFromSetup(state, action.id)
    case 'setup/renamePlayer':
      return renamePlayer(state, action.id, action.name)
    case 'setup/startInitialRoll':
      return startInitialRoll(state)

    // Initial roll
    case 'initialRoll/rollForPlayer':
      return recordInitialRoll(state, action.id, action.value)
    case 'initialRoll/finalize':
      return finalizeInitialRoll(state)

    // Mapping
    case 'mapping/setInitial':
      return setInitialMapping(state, action.id, action.card)
    case 'mapping/revealAll':
      return revealAllMappings(state)
    case 'mapping/changeOneSlot':
      return changeOneMappingSlot(state, action.id, action.slotIndex, action.option)

    // Turn: Bailiff pre-roll
    case 'turn/bailiffStealPreRoll': {
      if (state.bailiff.kind !== 'held') return state
      if (state.bailiff.by !== state.currentPlayerId) return state
      if (state.turn.bailiffStealUsedThisTurnSequence) return state
      return bailiffSteal(state, state.bailiff.by, action.targetId, action.item)
    }
    case 'turn/bailiffStealSkip':
      return state // just continue — player declines

    // Turn: rolling
    case 'turn/rollDie':
      return commitRoll(state, rollDie())
    case 'turn/rollDieWithValue':
      return commitRoll(state, action.value)

    // Turn: alliance decisions
    case 'turn/acceptAlliance':
      return acceptAlliance(state)
    case 'turn/declineAlliance':
      return declineAlliance(state)

    // Turn: #16 gift choice
    case 'turn/gift10Bricks':
      return gift10Bricks(state)
    case 'turn/gift1Wall':
      return gift1Wall(state)

    // Duel
    case 'turn/duelSetStake':
      return duelSetStake(state, action.stake)
    case 'turn/duelRollForPlayer':
      return duelRoll(state, action.id, action.value)
    case 'turn/duelResolve':
      return duelResolve(state)

    // Turn: Bailiff pre-move (card-draw acquisition, before movement)
    case 'turn/bailiffStealPreMove': {
      if (state.turn.phase !== 'pre-move-bailiff') return state
      if (state.bailiff.kind !== 'held') return state
      if (state.bailiff.by !== state.currentPlayerId) return state
      if (state.turn.bailiffStealUsedThisTurnSequence) return state
      let stolen = bailiffSteal(state, state.bailiff.by, action.targetId, action.item)
      // Clear acquired-flag so advanceAfterSquare doesn't re-route to
      // post-roll-bailiff after the square effect.
      stolen = {
        ...stolen,
        turn: { ...stolen.turn, acquiredBailiffThisTurn: false },
      }
      return completeRollAfterDistribute(stolen)
    }
    case 'turn/bailiffStealPreMoveSkip': {
      if (state.turn.phase !== 'pre-move-bailiff') return state
      const cleared: GameState = {
        ...state,
        turn: { ...state.turn, acquiredBailiffThisTurn: false },
      }
      return completeRollAfterDistribute(cleared)
    }

    // Turn: Bailiff post-roll
    case 'turn/bailiffStealPostRoll': {
      if (state.bailiff.kind !== 'held') return state
      if (state.bailiff.by !== state.currentPlayerId) return state
      // Once-per-turn-sequence cap (DESIGN.md §9). Reject a second steal
      // attempt even on an acquisition turn where pre-roll was already used.
      if (state.turn.bailiffStealUsedThisTurnSequence) return state
      const stolen = bailiffSteal(state, state.bailiff.by, action.targetId, action.item)
      // Exit 'post-roll-bailiff' phase — either auto-end (on a #24 landing) or
      // continue into optional-actions.
      return completeTurnOrEnterOptional(stolen)
    }
    case 'turn/bailiffStealPostRollSkip':
      // Exit 'post-roll-bailiff' phase without stealing.
      return completeTurnOrEnterOptional(state)

    // Fine payment (#7/#11/#28 insolvency dialog).
    case 'turn/payFine':
      return payFine(state, {
        bricks: action.bricks,
        sticks: action.sticks,
        walls: action.walls,
        roofs: action.roofs,
      })

    // Optional actions
    case 'turn/buy':
      return buy(state, action.item, action.quantity)
    case 'turn/trade':
      return trade(state, action.from, action.amount)
    case 'turn/traderWallsBuy':
      return traderWallsBuy(state, action.batches)
    case 'turn/traderBricksSell':
      return traderBricksSell(state, action.batches)
    case 'turn/halfPriceCleanerBuy':
      return halfPriceCleanerBuy(state, action.count)
    case 'turn/build':
      return build(state, action.item, action.count)
    case 'turn/endTurn':
      return endTurn(state)
    case 'turn/advancePhase':
      return advanceAfterSquare(state)
    case 'turn/setWorkerPreference':
      if (!state.currentPlayerId) return state
      return updatePlayer(state, state.currentPlayerId, (p) => ({
        ...p,
        workerPreference: action.preference,
      }))

    // Dungeon
    case 'dungeon/redeemPardon':
      return redeemPardon(state)

    // System
    case 'system/removePlayer':
      return removePlayerMidGame(state, action.id)
    case 'system/loadState':
      return isLoadableGameState(action.state) ? action.state : state
    case 'system/reset':
      return initialState()
  }
}
