// Server-side game bootstrap. The standalone hotseat game walked the host
// through addPlayer → startInitialRoll → (each player rolls) → finalize →
// (each player secretly maps) → revealAll. In multiplayer the framework already
// knows the roster when the host presses Start, and turn-order dice must come
// from the SERVER's seeded PRNG (not a client). createReadyState runs that
// preamble deterministically and hands the room a state parked at the first
// genuinely interactive multiplayer moment: the simultaneous, hidden resource-
// card pick (phase 'initial-mapping').

import type { GameState, Player } from './types.js'
import { initialState, reducer, rollDieFrom } from './reducer.js'

export interface SeatSpec {
  name: string
}

/**
 * Build a ready-to-play GameState from a seat lineup and a seed.
 *
 * Engine player ids come out as p1..pN in seat order (addPlayer derives
 * `p${maxId+1}`), and colorIndex 0..N-1 in the same order, so the room can map
 * engine seat index i ↔ seats[i] ↔ engine.players[i] (id `p${i+1}`).
 *
 * Turn order is rolled with the seeded PRNG; a tie for the highest roll is
 * re-rolled (only the tied-at-top players) until the first seat is unambiguous,
 * exactly mirroring finalizeInitialRoll's rule.
 */
export function createReadyState(seats: SeatSpec[], seed: number): GameState {
  let s = initialState(seed)
  for (const seat of seats) {
    s = reducer(s, { type: 'setup/addPlayer', name: seat.name })
  }
  s = reducer(s, { type: 'setup/startInitialRoll' })

  // Roll for turn order. Loop because finalize rejects (no-ops) on a top tie.
  // Guard with a generous iteration cap so a pathological seed can't spin.
  for (let guard = 0; guard < 1000; guard++) {
    for (const p of s.players) {
      if (p.initialRoll != null) continue
      const { value, rngState } = rollDieFrom(s)
      s = { ...s, rngState }
      s = reducer(s, { type: 'initialRoll/rollForPlayer', id: p.id, value })
    }
    const after = reducer(s, { type: 'initialRoll/finalize' })
    if (after.phase === 'initial-mapping') {
      return after
    }
    // Top tie: clear the tied-at-top players' rolls and re-roll just them.
    s = clearTopTie(s)
  }
  // Unreachable in practice; return whatever we have so the room never hangs.
  return s
}

/** Clear `initialRoll` on every player tied for the current highest roll. */
function clearTopTie(state: GameState): GameState {
  const highest = Math.max(...state.players.map((p) => p.initialRoll ?? 0))
  const players: Player[] = state.players.map((p) => {
    if ((p.initialRoll ?? 0) !== highest) return p
    const { initialRoll: _drop, ...rest } = p
    return rest as Player
  })
  return { ...state, players }
}
