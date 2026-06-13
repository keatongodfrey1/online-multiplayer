// The Perfect Palace bot policy — a pure, deterministic strategy. Given the
// engine state, a seat's engine id, and a difficulty, it returns ONE legal
// action; the room loops it (for AI players, for a dropped human's seat until
// reclaim, and to finish a timed-out turn). It must always make progress toward
// endTurn and never invent randomness: roll actions carry no value (the reducer
// derives turn/rollDie; the room injects the seeded die for duel rolls).
//
// Difficulty:
//  - easy:   builds only from on-hand resources, never buys — a pushover.
//  - normal: greedy build-the-ladder (buys bricks/sticks + staff) — the default,
//            also used for vacated seats and timed-out turns.
//  - hard:   normal PLUS aggression — Bailiff-steals from the leader, accepts
//            alliances, grabs the Queen, raises duel stakes, buys a Knight.

import type { DuelStake, GameState, Player, PlayerId } from './types.js'
import type { GameAction } from './actions.js'
import { getSquare } from './board.js'
import { DUEL_MIN_STAKE, PRICE, RECIPE } from './constants.js'
import { totalPoints } from './scoring.js'

export type Difficulty = 'easy' | 'normal' | 'hard'

function seatOf(state: GameState, id: PlayerId): Player | undefined {
  return state.players.find((p) => p.id === id)
}

/**
 * The single next action for `id`. The room only calls this for a seat that is
 * genuinely awaiting (the active player, or — in mapping/duel — any seat still
 * owing an action), so the relevant branch always applies. endTurn is the safe
 * terminal fallback.
 */
export function chooseAction(state: GameState, id: PlayerId, difficulty: Difficulty = 'normal'): GameAction {
  const me = seatOf(state, id)
  if (!me) return { type: 'turn/endTurn' }

  // Initial mapping: lock the (default) one-to-one card so the reveal can fire.
  if (state.phase === 'initial-mapping') {
    return { type: 'mapping/setInitial', id, card: me.resourceCard }
  }

  // Same-square duel: the arriver sets the stake, then every contender rolls.
  if (state.turn.phase === 'duel' && state.duel) {
    const d = state.duel
    const stakeSet =
      d.stake.dollars + d.stake.bricks + d.stake.sticks + d.stake.walls + d.stake.roofs + d.stake.rooms > 0
    if (!stakeSet && state.currentPlayerId === id) {
      return { type: 'turn/duelSetStake', stake: duelStake(me, difficulty) }
    }
    // Value is injected by the room from the seeded PRNG (clients/bots never roll).
    return { type: 'turn/duelRollForPlayer', id, value: 0 }
  }

  // Single-actor phases (id === currentPlayerId here).
  switch (state.turn.phase) {
    case 'turn-start':
      if (me.dungeon.inDungeon && me.inventory.pardonCards > 0) return { type: 'dungeon/redeemPardon' }
      if (difficulty === 'hard') {
        const steal = hardSteal(state, me, 'turn/bailiffStealPreRoll')
        if (steal) return steal
      }
      return { type: 'turn/rollDie' }
    case 'rolling':
      return { type: 'turn/rollDie' }
    case 'pre-move-bailiff':
      return (difficulty === 'hard' && hardSteal(state, me, 'turn/bailiffStealPreMove')) || { type: 'turn/bailiffStealPreMoveSkip' }
    case 'post-roll-bailiff':
      return (difficulty === 'hard' && hardSteal(state, me, 'turn/bailiffStealPostRoll')) || { type: 'turn/bailiffStealPostRollSkip' }
    case 'square-effect': {
      if (state.turn.pendingFine) return payFineAction(me, state.turn.pendingFine.amount)
      const sq = getSquare(me.position)
      if (sq.effect.kind === 'alliance-offer') {
        const c = sq.effect.cost
        const canAfford = me.inventory.bricks >= c.bricks && me.inventory.sticks >= c.sticks
        return difficulty === 'hard' && canAfford ? { type: 'turn/acceptAlliance' } : { type: 'turn/declineAlliance' }
      }
      if (sq.effect.kind === 'bricks-or-wall') return { type: 'turn/gift10Bricks' }
      return { type: 'turn/advancePhase' }
    }
    case 'optional-actions':
      return optionalAction(me, difficulty)
    default:
      return { type: 'turn/endTurn' }
  }
}

/** The highest-points opponent the Bailiff can legally rob (not me/removed, no
 *  Knight, and holding something), or undefined. */
function leaderTarget(state: GameState, myId: PlayerId): Player | undefined {
  let best: Player | undefined
  for (const p of state.players) {
    if (p.id === myId || p.removed || p.inventory.knight) continue
    const inv = p.inventory
    const hasLoot = inv.dollars >= 5 || inv.walls >= 1 || inv.roofs >= 1 || inv.bricks >= 5 || inv.sticks >= 5
    if (!hasLoot) continue
    if (!best || totalPoints(inv) > totalPoints(best.inventory)) best = p
  }
  return best
}

/** A Hard Bailiff steal of the leader's best loot, or undefined when it can't
 *  steal now (doesn't hold it, already used it this sequence, or no target). */
function hardSteal(
  state: GameState,
  me: Player,
  type: 'turn/bailiffStealPreRoll' | 'turn/bailiffStealPreMove' | 'turn/bailiffStealPostRoll',
): GameAction | undefined {
  if (state.bailiff.kind !== 'held' || state.bailiff.by !== me.id) return undefined
  if (state.turn.bailiffStealUsedThisTurnSequence) return undefined
  const t = leaderTarget(state, me.id)
  if (!t) return undefined
  const inv = t.inventory
  const item =
    inv.dollars >= 5 ? 'dollars' : inv.walls >= 1 ? 'wall' : inv.roofs >= 1 ? 'roof' : inv.bricks >= 5 ? 'bricks' : 'sticks'
  return { type, targetId: t.id, item }
}

/** Duel stake: Hard stakes bigger when flush; otherwise the cheapest minimum. */
function duelStake(p: Player, difficulty: Difficulty): DuelStake {
  const z: DuelStake = { dollars: 0, bricks: 0, sticks: 0, walls: 0, roofs: 0, rooms: 0 }
  const inv = p.inventory
  if (difficulty === 'hard' && inv.dollars >= 2 * DUEL_MIN_STAKE.dollars) {
    return { ...z, dollars: 2 * DUEL_MIN_STAKE.dollars }
  }
  if (inv.dollars >= DUEL_MIN_STAKE.dollars) return { ...z, dollars: DUEL_MIN_STAKE.dollars }
  if (inv.bricks >= DUEL_MIN_STAKE.bricks) return { ...z, bricks: DUEL_MIN_STAKE.bricks }
  if (inv.sticks >= DUEL_MIN_STAKE.sticks) return { ...z, sticks: DUEL_MIN_STAKE.sticks }
  if (inv.walls >= 1) return { ...z, walls: 1 }
  if (inv.roofs >= 1) return { ...z, roofs: 1 }
  if (inv.rooms >= 1) return { ...z, rooms: 1 }
  return { ...z, dollars: DUEL_MIN_STAKE.dollars } // broke edge: stake the minimum anyway
}

/**
 * Forfeit the cheapest items covering the fine. The engine enforces no-overpay
 * (exact, or the max feasible below owed), so spend $1 items (bricks then sticks)
 * to land on the exact amount, then $5 items (walls/roofs) for whole-$5 chunks.
 */
function payFineAction(p: Player, owed: number): GameAction {
  const inv = p.inventory
  let need = owed
  const bricks = Math.min(inv.bricks, need)
  need -= bricks
  const sticks = Math.min(inv.sticks, need)
  need -= sticks
  let fives = Math.floor(need / 5)
  const walls = Math.min(inv.walls, fives)
  fives -= walls
  const roofs = Math.min(inv.roofs, fives)
  return { type: 'turn/payFine', bricks, sticks, walls, roofs }
}

/**
 * Build the highest legal tier (mirrors the engine's canBuild incl. staff
 * prereqs). Easy stops there (never buys); Normal/Hard then buy the cheapest
 * missing input toward the next tier. Hard also grabs the Queen (200 pts) and a
 * Knight when flush. One step per call (the room loops).
 */
function optionalAction(p: Player, difficulty: Difficulty): GameAction {
  const inv = p.inventory
  const anyStaff = inv.servers + inv.chefs + inv.cleaners + inv.wholeHouseCleaners >= 1
  const hasCleaner = inv.cleaners + inv.wholeHouseCleaners >= 1

  // 1) Build the highest legal tier (all difficulties build what they can).
  if (inv.threeStoryBuildings >= RECIPE.palace.threeStoryBuildings)
    return { type: 'turn/build', item: 'palace', count: 1 }
  if (inv.buildings >= RECIPE.threeStoryBuilding.buildings && inv.servers >= 1 && inv.chefs >= 1 && hasCleaner)
    return { type: 'turn/build', item: 'threeStoryBuilding', count: 1 }
  if (inv.rooms >= RECIPE.building.rooms && anyStaff)
    return { type: 'turn/build', item: 'building', count: 1 }
  if (inv.walls >= RECIPE.room.walls && inv.roofs >= RECIPE.room.roofs)
    return { type: 'turn/build', item: 'room', count: 1 }
  if (inv.sticks >= RECIPE.roof.sticks) return { type: 'turn/build', item: 'roof', count: 1 }
  if (inv.bricks >= RECIPE.wall.bricks) return { type: 'turn/build', item: 'wall', count: 1 }

  if (difficulty === 'easy') return { type: 'turn/endTurn' } // Easy never buys.

  // Hard: grab the Queen (200 pts) the moment it can afford it outright.
  if (difficulty === 'hard' && !inv.queen && inv.dollars >= PRICE.queen)
    return { type: 'turn/buy', item: 'queen' }

  // 2) Buy staff to unlock the next build (the bot has owned a Room, so the
  //    Server/Chef/Cleaner shop prereq is satisfied).
  if (inv.rooms >= RECIPE.building.rooms && !anyStaff && inv.dollars >= PRICE.server)
    return { type: 'turn/buy', item: 'server' }
  if (inv.buildings >= RECIPE.threeStoryBuilding.buildings) {
    if (inv.servers < 1 && inv.dollars >= PRICE.server) return { type: 'turn/buy', item: 'server' }
    if (inv.chefs < 1 && inv.dollars >= PRICE.chef) return { type: 'turn/buy', item: 'chef' }
    if (!hasCleaner && inv.dollars >= PRICE.cleaner) return { type: 'turn/buy', item: 'cleaner' }
  }

  // 3) Buy a bundle of bricks/sticks (sold in fives) toward the next wall/roof.
  if (inv.bricks < RECIPE.wall.bricks && inv.dollars >= 5 * PRICE.brick)
    return { type: 'turn/buy', item: 'brick', quantity: 5 }
  if (inv.sticks < RECIPE.roof.sticks && inv.dollars >= 5 * PRICE.stick)
    return { type: 'turn/buy', item: 'stick', quantity: 5 }

  // Hard: a Knight for Bailiff protection once comfortably rich.
  if (difficulty === 'hard' && !inv.knight && inv.dollars >= PRICE.knight + 100)
    return { type: 'turn/buy', item: 'knight' }

  return { type: 'turn/endTurn' }
}
