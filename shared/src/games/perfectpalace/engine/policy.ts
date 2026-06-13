// The Perfect Palace bot policy — a pure, deterministic "plays a real game"
// strategy. Given the engine state and a seat's engine id, it returns ONE legal
// action; the room loops it (paced for AI players, and for a dropped human's
// seat until someone reclaims it). It is used identically for AI opponents and
// for auto-playing vacated seats, so it must always make progress toward
// endTurn and never invent randomness: roll actions carry no value (the reducer
// derives turn/rollDie; the room injects the seeded die for duel rolls).
//
// Strategy: lock the default resource card; roll; skip risky Bailiff steals;
// decline costly alliances; pay fines from the cheapest items; in a duel stake
// the cheapest affordable minimum then roll; and in optional-actions greedily
// build up the construction ladder (buying the bricks/sticks the next tier
// needs) before ending the turn.

import type { DuelStake, GameState, Player, PlayerId } from './types.js'
import type { GameAction } from './actions.js'
import { getSquare } from './board.js'
import { DUEL_MIN_STAKE, PRICE, RECIPE } from './constants.js'

function seatOf(state: GameState, id: PlayerId): Player | undefined {
  return state.players.find((p) => p.id === id)
}

/**
 * The single next action for `id` to take in the current state. The room only
 * calls this for a seat that is genuinely awaiting (the active player, or — in
 * the simultaneous mapping/duel phases — any seat that still owes an action), so
 * the relevant branch always applies. endTurn is the safe terminal fallback.
 */
export function chooseAction(state: GameState, id: PlayerId): GameAction {
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
      return { type: 'turn/duelSetStake', stake: cheapestStake(me) }
    }
    // Value is injected by the room from the seeded PRNG (clients/bots never roll).
    return { type: 'turn/duelRollForPlayer', id, value: 0 }
  }

  // Single-actor phases (id === currentPlayerId here).
  switch (state.turn.phase) {
    case 'turn-start':
      if (me.dungeon.inDungeon && me.inventory.pardonCards > 0) return { type: 'dungeon/redeemPardon' }
      return { type: 'turn/rollDie' } // skip the optional pre-roll Bailiff steal
    case 'rolling':
      return { type: 'turn/rollDie' }
    case 'pre-move-bailiff':
      return { type: 'turn/bailiffStealPreMoveSkip' }
    case 'post-roll-bailiff':
      return { type: 'turn/bailiffStealPostRollSkip' }
    case 'square-effect': {
      if (state.turn.pendingFine) return payFineAction(me, state.turn.pendingFine.amount)
      const sq = getSquare(me.position)
      if (sq.effect.kind === 'alliance-offer') return { type: 'turn/declineAlliance' }
      if (sq.effect.kind === 'bricks-or-wall') return { type: 'turn/gift10Bricks' }
      return { type: 'turn/advancePhase' }
    }
    case 'optional-actions':
      return optionalAction(me)
    default:
      return { type: 'turn/endTurn' }
  }
}

/** The cheapest minimum stake this player can afford (DESIGN §13). */
function cheapestStake(p: Player): DuelStake {
  const z: DuelStake = { dollars: 0, bricks: 0, sticks: 0, walls: 0, roofs: 0, rooms: 0 }
  const inv = p.inventory
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
 * (exact, or the max feasible below owed when it can't be hit exactly), so spend
 * $1 items (bricks then sticks) first to land on the exact amount, then use $5
 * items (walls/roofs) only for whole-$5 chunks of any remainder.
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
 * Greedy build-the-ladder, one step per call (the room loops). Build the highest
 * tier that is actually legal — including the staff prerequisites the engine
 * enforces (a Building needs any 1 staff; a 3-Story needs a Server + Chef +
 * Cleaner) — then buy the cheapest missing input toward the next tier, else end
 * the turn. Checks mirror the engine's canBuild/canBuy so every emitted action
 * makes real progress (and a rejected one safely falls back to endTurn).
 */
function optionalAction(p: Player): GameAction {
  const inv = p.inventory
  const anyStaff = inv.servers + inv.chefs + inv.cleaners + inv.wholeHouseCleaners >= 1
  const hasCleaner = inv.cleaners + inv.wholeHouseCleaners >= 1

  // 1) Build the highest legal tier.
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

  // 2) Buy a staff member that unlocks the next build (the bot has owned a Room,
  //    so the Server/Chef/Cleaner shop prereq is satisfied).
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
  return { type: 'turn/endTurn' }
}
