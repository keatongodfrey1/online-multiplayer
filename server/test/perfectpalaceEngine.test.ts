// The Perfect Palace engine test suite — ported VERBATIM from
// The-Perfect-Palace/src/game/reducer.test.ts (vitest → mocha). It exercises
// every gameplay rule in DESIGN.md and is the regression net guarding the port.
// The only changes from the original are this import header (engine pulled from
// @backbone/shared instead of relative paths) and a tiny `expect` shim mapping
// the handful of vitest matchers the suite uses onto node:assert. Assertions in
// the body are unchanged so any behavior drift from the port fails loudly.

import assert from "node:assert/strict";
import { PerfectPalaceEngine } from "@backbone/shared";

const { initialState, reducer, isValidResourceCard, rankPlayers, totalPoints, staffWeight, RESOURCE_OPTIONS } =
  PerfectPalaceEngine;
type GameState = PerfectPalaceEngine.GameState;
type Player = PerfectPalaceEngine.Player;
type ResourceCard = PerfectPalaceEngine.ResourceCard;

// Minimal vitest-compatible matcher shim over node:assert. Covers exactly the
// matchers this suite uses: toBe, toEqual, toBeUndefined, toBeTruthy,
// toBeGreaterThanOrEqual, toContain, and the negations .not.toBe/.not.toContain.
function expect(actual: any) {
  return {
    toBe: (e: any) => assert.strictEqual(actual, e),
    toEqual: (e: any) => assert.deepStrictEqual(actual, e),
    toBeUndefined: () => assert.strictEqual(actual, undefined),
    toBeTruthy: () => assert.ok(actual),
    toBeGreaterThanOrEqual: (e: number) =>
      assert.ok(actual >= e, `expected ${actual} >= ${e}`),
    toContain: (e: any) =>
      assert.ok(
        actual.includes(e),
        `expected ${JSON.stringify(actual)} to contain ${JSON.stringify(e)}`,
      ),
    not: {
      toBe: (e: any) => assert.notStrictEqual(actual, e),
      toContain: (e: any) =>
        assert.ok(
          !actual.includes(e),
          `expected ${JSON.stringify(actual)} not to contain ${JSON.stringify(e)}`,
        ),
    },
  };
}

// ==================== Test helpers ====================

function setupGame(playerNames: string[]): GameState {
  // Fixed seed so the deck order is deterministic across runs. Deck-sensitive
  // tests still white-box `s.deck` directly; this just removes any flakiness.
  let s = initialState(0x9e3779b9)
  for (const name of playerNames) {
    s = reducer(s, { type: 'setup/addPlayer', name })
  }
  s = reducer(s, { type: 'setup/startInitialRoll' })
  // Give deterministic initial rolls so turn order is predictable (p1, p2, ...).
  for (let i = 0; i < playerNames.length; i++) {
    s = reducer(s, {
      type: 'initialRoll/rollForPlayer',
      id: `p${i + 1}`,
      value: playerNames.length - i, // p1 = N, p2 = N-1, ... ensuring p1 wins
    })
  }
  s = reducer(s, { type: 'initialRoll/finalize' })
  // Each player confirms the default mapping.
  for (const p of s.players) {
    s = reducer(s, { type: 'mapping/setInitial', id: p.id, card: p.resourceCard })
  }
  s = reducer(s, { type: 'mapping/revealAll' })
  return s
}

// Set a player's resource card for predictable roll outcomes.
// Mutates state directly (not via `mapping/setInitial`) so we can pin non-permutation
// cards like ALL_DRAWS purely for test isolation — the reducer's real validation
// only needs to hold for in-game flows.
function withResourceCard(s: GameState, id: string, card: ResourceCard): GameState {
  return {
    ...s,
    players: s.players.map((p) => (p.id === id ? { ...p, resourceCard: card } : p)),
  }
}

function playerById(s: GameState, id: string): Player {
  const p = s.players.find((pp) => pp.id === id)
  if (!p) throw new Error(`player ${id} not found`)
  return p
}

// Pre-built resource cards for predictable tests.
//
// Note: every die face MUST produce some outcome — there is no "no-op" option.
// These cards let tests assert specific resource totals without every roll
// also adding confounding resources via the card mapping.

const ALL_DOLLARS: ResourceCard = [
  { kind: 'dollars', amount: 5 },
  { kind: 'dollars', amount: 5 },
  { kind: 'dollars', amount: 5 },
  { kind: 'dollars', amount: 5 },
  { kind: 'dollars', amount: 5 },
  { kind: 'dollars', amount: 5 },
]

const ALL_DRAWS: ResourceCard = [
  { kind: 'draw-card' },
  { kind: 'draw-card' },
  { kind: 'draw-card' },
  { kind: 'draw-card' },
  { kind: 'draw-card' },
  { kind: 'draw-card' },
]

// Cards that let us roll without gaining bricks or sticks.
const ALL_STICKS_5: ResourceCard = [
  { kind: 'sticks', amount: 5 },
  { kind: 'sticks', amount: 5 },
  { kind: 'sticks', amount: 5 },
  { kind: 'sticks', amount: 5 },
  { kind: 'sticks', amount: 5 },
  { kind: 'sticks', amount: 5 },
]

/**
 * Overwrite every player's resource card (skips the lap-credit gate).
 * Used after setupGame() to pin known roll outcomes for a test.
 */
function pinCards(s: GameState, card: ResourceCard): GameState {
  return {
    ...s,
    players: s.players.map((p) => ({ ...p, resourceCard: card })),
  }
}

// ==================== Setup ====================

describe('Setup', () => {
  it('starts in the setup phase with zero players', () => {
    const s = initialState()
    expect(s.phase).toBe('setup')
    expect(s.players.length).toBe(0)
    expect(s.bailiff).toEqual({ kind: 'middle' })
    expect(s.deck.length).toBe(18)
    expect(s.discard.length).toBe(0)
  })

  it('adds up to 6 players and caps there', () => {
    let s = initialState()
    for (let i = 0; i < 8; i++) {
      s = reducer(s, { type: 'setup/addPlayer', name: `P${i + 1}` })
    }
    expect(s.players.length).toBe(6)
  })

  it('needs at least 2 players to start the initial roll', () => {
    let s = reducer(initialState(), { type: 'setup/addPlayer', name: 'Solo' })
    s = reducer(s, { type: 'setup/startInitialRoll' })
    expect(s.phase).toBe('setup') // blocked
  })

  it('assigns unique IDs and seat colors', () => {
    let s = initialState()
    s = reducer(s, { type: 'setup/addPlayer', name: 'A' })
    s = reducer(s, { type: 'setup/addPlayer', name: 'B' })
    expect(s.players[0]!.id).toBe('p1')
    expect(s.players[1]!.id).toBe('p2')
    expect(s.players[0]!.colorIndex).toBe(0)
    expect(s.players[1]!.colorIndex).toBe(1)
  })

  it('adding after removing a middle player assigns a fresh ID, not a duplicate', () => {
    let s = initialState()
    s = reducer(s, { type: 'setup/addPlayer', name: 'A' }) // p1
    s = reducer(s, { type: 'setup/addPlayer', name: 'B' }) // p2
    s = reducer(s, { type: 'setup/addPlayer', name: 'C' }) // p3
    s = reducer(s, { type: 'setup/addPlayer', name: 'D' }) // p4
    s = reducer(s, { type: 'setup/removePlayer', id: 'p2' })
    s = reducer(s, { type: 'setup/addPlayer', name: 'E' })
    // The new player's id should be max+1 = p5, NOT length+1 = p4 (which
    // would collide with the existing p4).
    const ids = s.players.map((p) => p.id)
    expect(ids).toEqual(['p1', 'p3', 'p4', 'p5'])
    expect(new Set(ids).size).toBe(ids.length) // all unique
    const colors = s.players.map((p) => p.colorIndex)
    expect(new Set(colors).size).toBe(colors.length) // colorIndex unique too
  })

  it('rolling for the newly-added player records against the correct player (bug repro)', () => {
    let s = initialState()
    s = reducer(s, { type: 'setup/addPlayer', name: 'A' })
    s = reducer(s, { type: 'setup/addPlayer', name: 'B' })
    s = reducer(s, { type: 'setup/addPlayer', name: 'C' })
    s = reducer(s, { type: 'setup/addPlayer', name: 'D' })
    s = reducer(s, { type: 'setup/removePlayer', id: 'p2' })
    s = reducer(s, { type: 'setup/addPlayer', name: 'E' }) // new player = p5
    s = reducer(s, { type: 'setup/startInitialRoll' })
    // Roll for the newly-added player by their id.
    s = reducer(s, { type: 'initialRoll/rollForPlayer', id: 'p5', value: 6 })
    // Only p5's initialRoll should be set. The existing p4 must NOT have
    // been updated (this was the bug — the roll fell through to p4).
    const p4 = s.players.find((p) => p.id === 'p4')!
    const p5 = s.players.find((p) => p.id === 'p5')!
    expect(p5.initialRoll).toBe(6)
    expect(p4.initialRoll).toBeUndefined()
  })
})

// ==================== Initial roll + mapping ====================

describe('Initial roll', () => {
  it('ranks turn order by descending roll', () => {
    let s = reducer(initialState(), { type: 'setup/addPlayer', name: 'A' })
    s = reducer(s, { type: 'setup/addPlayer', name: 'B' })
    s = reducer(s, { type: 'setup/addPlayer', name: 'C' })
    s = reducer(s, { type: 'setup/startInitialRoll' })
    s = reducer(s, { type: 'initialRoll/rollForPlayer', id: 'p1', value: 2 })
    s = reducer(s, { type: 'initialRoll/rollForPlayer', id: 'p2', value: 6 })
    s = reducer(s, { type: 'initialRoll/rollForPlayer', id: 'p3', value: 4 })
    s = reducer(s, { type: 'initialRoll/finalize' })
    expect(s.turnOrder).toEqual(['p2', 'p3', 'p1'])
    expect(s.currentPlayerId).toBe('p2')
    expect(s.phase).toBe('initial-mapping')
  })

  it('will not finalize until every player has rolled', () => {
    let s = reducer(initialState(), { type: 'setup/addPlayer', name: 'A' })
    s = reducer(s, { type: 'setup/addPlayer', name: 'B' })
    s = reducer(s, { type: 'setup/startInitialRoll' })
    s = reducer(s, { type: 'initialRoll/rollForPlayer', id: 'p1', value: 6 })
    s = reducer(s, { type: 'initialRoll/finalize' })
    expect(s.phase).toBe('initial-roll') // still blocked
  })

  it('refuses to finalize when two or more players tie for the highest roll', () => {
    let s = reducer(initialState(), { type: 'setup/addPlayer', name: 'A' })
    s = reducer(s, { type: 'setup/addPlayer', name: 'B' })
    s = reducer(s, { type: 'setup/addPlayer', name: 'C' })
    s = reducer(s, { type: 'setup/startInitialRoll' })
    s = reducer(s, { type: 'initialRoll/rollForPlayer', id: 'p1', value: 4 })
    s = reducer(s, { type: 'initialRoll/rollForPlayer', id: 'p2', value: 4 })
    s = reducer(s, { type: 'initialRoll/rollForPlayer', id: 'p3', value: 2 })
    s = reducer(s, { type: 'initialRoll/finalize' })
    expect(s.phase).toBe('initial-roll') // top tie blocks finalize
    // After a re-roll that breaks the tie, finalize succeeds.
    s = reducer(s, { type: 'initialRoll/rollForPlayer', id: 'p1', value: 6 })
    s = reducer(s, { type: 'initialRoll/finalize' })
    expect(s.phase).toBe('initial-mapping')
    expect(s.turnOrder[0]).toBe('p1')
  })
})

describe('Initial mapping', () => {
  it('locks the mapping when confirmed + transitions to reveal then turn-start', () => {
    let s = setupGame(['A', 'B'])
    // setupGame already reveals + starts turn
    expect(s.phase).toBe('turn-start')
    expect(s.currentPlayerId).toBe('p1')
  })

  it('starts each player at square #1 with zero inventory', () => {
    const s = setupGame(['A', 'B'])
    for (const p of s.players) {
      expect(p.position).toBe(1)
      expect(p.inventory.dollars).toBe(0)
      expect(p.inventory.bricks).toBe(0)
      expect(p.inventory.sticks).toBe(0)
    }
  })
})

// ==================== Mapping changes ====================

describe('Mid-game mapping changes', () => {
  it('blocks changes when no lap credits are available', () => {
    let s = setupGame(['A', 'B'])
    const p1Before = playerById(s, 'p1')
    s = reducer(s, {
      type: 'mapping/changeOneSlot',
      id: 'p1',
      slotIndex: 0,
      option: 5, // draw-card
    })
    const p1After = playerById(s, 'p1')
    // Unchanged because no credit
    expect(p1After.resourceCard[0]).toEqual(p1Before.resourceCard[0])
  })

  it('grants one credit on passing Start and spends it on change', () => {
    let s = setupGame(['A', 'B'])
    // Move p1 to #28 so a roll of 3 passes Start (#29→#30→#1)
    s = { ...s, players: s.players.map((p) => (p.id === 'p1' ? { ...p, position: 28 } : p)) }
    s = reducer(s, { type: 'turn/rollDieWithValue', value: 3 })
    expect(playerById(s, 'p1').mappingChangesAvailable).toBe(1)
    expect(playerById(s, 'p1').inventory.dollars).toBeGreaterThanOrEqual(10) // lap bonus

    s = reducer(s, {
      type: 'mapping/changeOneSlot',
      id: 'p1',
      slotIndex: 0,
      option: 5, // 0 was 5-sticks, 5 is draw-card
    })
    expect(playerById(s, 'p1').mappingChangesAvailable).toBe(0)
    expect(playerById(s, 'p1').resourceCard[0].kind).toBe('draw-card')
  })

  it('no-op change (same option) does not consume a credit', () => {
    let s = setupGame(['A', 'B'])
    s = { ...s, players: s.players.map((p) => (p.id === 'p1' ? { ...p, mappingChangesAvailable: 1 } : p)) }
    const currentSlot0 = playerById(s, 'p1').resourceCard[0]
    const optIdx = RESOURCE_OPTIONS.findIndex((o) => JSON.stringify(o) === JSON.stringify(currentSlot0))
    s = reducer(s, { type: 'mapping/changeOneSlot', id: 'p1', slotIndex: 0, option: optIdx })
    expect(playerById(s, 'p1').mappingChangesAvailable).toBe(1)
  })

  it('swaps slots to preserve the one-to-one mapping', () => {
    let s = setupGame(['A', 'B'])
    s = { ...s, players: s.players.map((p) => (p.id === 'p1' ? { ...p, mappingChangesAvailable: 1 } : p)) }
    // Default card: [5s, 5b, 10b, $5, $10, draw]
    // Put "draw-card" (option index 5) on slot 0 → slot 0 becomes draw, slot 5 becomes 5-sticks (old slot 0).
    s = reducer(s, { type: 'mapping/changeOneSlot', id: 'p1', slotIndex: 0, option: 5 })
    const card = playerById(s, 'p1').resourceCard
    expect(card[0].kind).toBe('draw-card')
    expect(card[5]).toEqual({ kind: 'sticks', amount: 5 })
    // Card must still be a valid permutation
    expect(isValidResourceCard(card)).toBe(true)
  })

  it('rejects setInitialMapping for a non-permutation card', () => {
    let s = setupGame(['A', 'B'])
    // Bad card: all slots are $10
    const badCard = [
      { kind: 'dollars', amount: 10 },
      { kind: 'dollars', amount: 10 },
      { kind: 'dollars', amount: 10 },
      { kind: 'dollars', amount: 10 },
      { kind: 'dollars', amount: 10 },
      { kind: 'dollars', amount: 10 },
    ] as unknown as ResourceCard
    const before = playerById(s, 'p1').resourceCard
    s = reducer(s, { type: 'mapping/setInitial', id: 'p1', card: badCard })
    // Card unchanged
    expect(playerById(s, 'p1').resourceCard).toEqual(before)
    expect(isValidResourceCard(playerById(s, 'p1').resourceCard)).toBe(true)
  })

  it('default resource card (after add/setup) is a valid permutation', () => {
    let s = setupGame(['A', 'B', 'C'])
    for (const p of s.players) {
      expect(isValidResourceCard(p.resourceCard)).toBe(true)
    }
  })
})

// ==================== Turn loop ====================

describe('Turn loop', () => {
  it('distributes resources to every player on a roll', () => {
    let s = setupGame(['A', 'B'])
    s = withResourceCard(s, 'p1', ALL_DOLLARS)
    s = withResourceCard(s, 'p2', ALL_DOLLARS)
    s = reducer(s, { type: 'mapping/revealAll' }) // re-reveal after reset
    // Roll a 4 → both p1 and p2 gain $5
    s = reducer(s, { type: 'turn/rollDieWithValue', value: 4 })
    expect(playerById(s, 'p1').inventory.dollars).toBe(5)
    expect(playerById(s, 'p2').inventory.dollars).toBe(5)
  })

  it('advances the roller clockwise by the rolled value', () => {
    let s = setupGame(['A', 'B'])
    s = reducer(s, { type: 'turn/rollDieWithValue', value: 4 })
    expect(playerById(s, 'p1').position).toBe(5) // 1 + 4 = 5
  })

  it('awards the lap bonus ($10 + 1 mapping credit) on passing Start', () => {
    let s = setupGame(['A', 'B'])
    // Put p1 on #28. Roll 3 → passes through #29, #30, then LANDS on #1.
    s = { ...s, players: s.players.map((p) => (p.id === 'p1' ? { ...p, position: 28 } : p)) }
    s = reducer(s, { type: 'turn/rollDieWithValue', value: 3 })
    const p1 = playerById(s, 'p1')
    expect(p1.position).toBe(1)
    expect(p1.inventory.dollars).toBeGreaterThanOrEqual(10) // lap $10
    expect(p1.mappingChangesAvailable).toBe(1)
  })

  it('ends turn and advances to next player clockwise', () => {
    let s = setupGame(['A', 'B', 'C'])
    s = reducer(s, { type: 'turn/rollDieWithValue', value: 4 }) // p1 lands on #5 (bailiff)
    // #5 acquires Bailiff — skipping now advances phase into optional-actions.
    s = reducer(s, { type: 'turn/bailiffStealPostRollSkip' })
    expect(s.turn.phase).toBe('optional-actions')
    s = reducer(s, { type: 'turn/endTurn' })
    expect(s.currentPlayerId).toBe('p2')
  })
})

// ==================== Squares ====================

describe('Square effects', () => {
  it('#2 "Get a Room" grants a free room on every landing', () => {
    let s = setupGame(['A', 'B'])
    s = reducer(s, { type: 'turn/rollDieWithValue', value: 1 }) // land on #2
    expect(playerById(s, 'p1').inventory.rooms).toBe(1)
  })

  it('#4 grants +10 bricks + 10 sticks', () => {
    let s = setupGame(['A', 'B'])
    s = pinCards(s, ALL_DOLLARS) // rolls give dollars, not bricks/sticks
    s = reducer(s, { type: 'turn/rollDieWithValue', value: 3 })
    const p1 = playerById(s, 'p1')
    expect(p1.inventory.bricks).toBe(10)
    expect(p1.inventory.sticks).toBe(10)
  })

  it('#5 grants the Bailiff to the current player (sets acquiredBailiffThisTurn)', () => {
    let s = setupGame(['A', 'B'])
    s = reducer(s, { type: 'turn/rollDieWithValue', value: 4 })
    expect(s.bailiff).toEqual({ kind: 'held', by: 'p1' })
    expect(s.turn.acquiredBailiffThisTurn).toBe(true)
    expect(s.turn.phase).toBe('post-roll-bailiff')
  })

  it('#6 grants +100 bricks', () => {
    let s = setupGame(['A', 'B'])
    s = reducer(s, { type: 'turn/rollDieWithValue', value: 5 })
    expect(playerById(s, 'p1').inventory.bricks).toBe(100)
  })

  it('#9 grants +100 sticks', () => {
    let s = setupGame(['A', 'B'])
    s = pinCards(s, ALL_DOLLARS)
    // Put p1 on #3 directly, roll 6 → lands on #9.
    s = { ...s, players: s.players.map((p) => (p.id === 'p1' ? { ...p, position: 3 } : p)) }
    s = reducer(s, { type: 'turn/rollDieWithValue', value: 6 })
    expect(playerById(s, 'p1').position).toBe(9)
    expect(playerById(s, 'p1').inventory.sticks).toBe(100)
  })

  it('corner #10 (Royal Court) sends the player to the dungeon and loses the Bailiff', () => {
    let s = setupGame(['A', 'B'])
    // Give p1 the Bailiff first.
    s = { ...s, bailiff: { kind: 'held', by: 'p1' } }
    s = { ...s, players: s.players.map((p) => (p.id === 'p1' ? { ...p, position: 7 } : p)) }
    s = reducer(s, { type: 'turn/rollDieWithValue', value: 3 }) // lands on #10
    expect(playerById(s, 'p1').dungeon.inDungeon).toBe(true)
    expect(playerById(s, 'p1').position).toBe(25)
    expect(s.bailiff).toEqual({ kind: 'middle' })
  })

  it('#7 Invasion: allied player skips tribute', () => {
    let s = setupGame(['A', 'B'])
    s = pinCards(s, ALL_STICKS_5) // avoid card-draw variance on face 6
    s = { ...s, players: s.players.map((p) => (p.id === 'p1' ? { ...p, position: 1, inventory: { ...p.inventory, allied: true, dollars: 50 } } : p)) }
    s = reducer(s, { type: 'turn/rollDieWithValue', value: 6 })
    expect(playerById(s, 'p1').inventory.dollars).toBe(50) // unchanged — tribute waived
    expect(playerById(s, 'p1').dungeon.inDungeon).toBe(false)
  })

  it('#7 Invasion: solvent player pays $100', () => {
    let s = setupGame(['A', 'B'])
    s = pinCards(s, ALL_STICKS_5) // rolls give sticks, not dollars
    s = { ...s, players: s.players.map((p) => (p.id === 'p1' ? { ...p, position: 1, inventory: { ...p.inventory, dollars: 150 } } : p)) }
    s = reducer(s, { type: 'turn/rollDieWithValue', value: 6 })
    expect(playerById(s, 'p1').inventory.dollars).toBe(50)
    expect(playerById(s, 'p1').dungeon.inDungeon).toBe(false)
  })

  it('#7 Invasion: insolvent player forfeits cash + opens fine dialog for items (no dungeon)', () => {
    let s = setupGame(['A', 'B'])
    s = pinCards(s, ALL_STICKS_5) // avoid card-draw variance on face 6
    s = {
      ...s,
      players: s.players.map((p) =>
        p.id === 'p1'
          ? { ...p, position: 1, inventory: { ...p.inventory, dollars: 40, bricks: 50, sticks: 20 } }
          : p,
      ),
    }
    s = reducer(s, { type: 'turn/rollDieWithValue', value: 6 })
    // Cash auto-drained; fine dialog opened for the remaining $60.
    expect(playerById(s, 'p1').inventory.dollars).toBe(0)
    expect(playerById(s, 'p1').dungeon.inDungeon).toBe(false)
    expect(playerById(s, 'p1').position).toBe(7)
    expect(s.turn.pendingFine?.amount).toBe(60)
    expect(s.turn.pendingFine?.source).toBe('invasion')
  })

  it('#7 Invasion: Bailiff holder stays holding after insolvency', () => {
    let s = setupGame(['A', 'B'])
    s = pinCards(s, ALL_STICKS_5)
    s = {
      ...s,
      bailiff: { kind: 'held', by: 'p1' },
      players: s.players.map((p) =>
        p.id === 'p1'
          ? { ...p, position: 1, inventory: { ...p.inventory, dollars: 10, bricks: 100 } }
          : p,
      ),
    }
    s = reducer(s, { type: 'turn/rollDieWithValue', value: 6 })
    expect(s.bailiff).toEqual({ kind: 'held', by: 'p1' })
    expect(playerById(s, 'p1').dungeon.inDungeon).toBe(false)
  })

  it('#7 Invasion: broke player with no items stiffs the fine and continues', () => {
    let s = setupGame(['A', 'B'])
    s = pinCards(s, ALL_DOLLARS) // roll gives dollars, not forfeit-eligible items
    s = {
      ...s,
      players: s.players.map((p) =>
        p.id === 'p1'
          ? { ...p, position: 1, inventory: { ...p.inventory, dollars: 0 } }
          : p,
      ),
    }
    s = reducer(s, { type: 'turn/rollDieWithValue', value: 6 })
    // Roll gave +$5, which is less than $100 tribute. Cash auto-deducts, no items
    // to forfeit → no dialog, no dungeon, turn continues.
    expect(s.turn.pendingFine).toBeUndefined()
    expect(playerById(s, 'p1').dungeon.inDungeon).toBe(false)
    expect(s.turn.phase).toBe('optional-actions')
  })

  it('Fine payment: selection >= owed deducts items and advances', () => {
    let s = setupGame(['A', 'B'])
    s = pinCards(s, ALL_STICKS_5)
    s = {
      ...s,
      players: s.players.map((p) =>
        p.id === 'p1'
          ? { ...p, position: 1, inventory: { ...p.inventory, dollars: 0, bricks: 80, walls: 5 } }
          : p,
      ),
    }
    s = reducer(s, { type: 'turn/rollDieWithValue', value: 6 })
    expect(s.turn.pendingFine?.amount).toBe(100)
    // Pay 80 bricks + 4 walls = $80 + $20 = $100 exactly.
    s = reducer(s, { type: 'turn/payFine', bricks: 80, sticks: 0, walls: 4, roofs: 0 })
    expect(s.turn.pendingFine).toBeUndefined()
    expect(playerById(s, 'p1').inventory.bricks).toBe(0)
    expect(playerById(s, 'p1').inventory.walls).toBe(1)
    expect(s.turn.phase).toBe('optional-actions')
  })

  it('Fine payment: selection below owed but deplete-all is accepted (partial stiff)', () => {
    let s = setupGame(['A', 'B'])
    s = pinCards(s, ALL_DOLLARS) // avoid stick/brick variance from the roll
    s = {
      ...s,
      players: s.players.map((p) =>
        p.id === 'p1'
          ? { ...p, position: 1, inventory: { ...p.inventory, dollars: 0, bricks: 10 } }
          : p,
      ),
    }
    s = reducer(s, { type: 'turn/rollDieWithValue', value: 6 })
    // Roll gave +$5 which paid $5 of the tribute. Remaining = $95.
    expect(s.turn.pendingFine?.amount).toBe(95)
    // Forfeit all 10 bricks ($10) — still < $95 but deplete-all applies.
    s = reducer(s, { type: 'turn/payFine', bricks: 10, sticks: 0, walls: 0, roofs: 0 })
    expect(s.turn.pendingFine).toBeUndefined()
    expect(playerById(s, 'p1').inventory.bricks).toBe(0)
  })

  it('Fine payment: selection below owed AND not deplete-all is rejected', () => {
    let s = setupGame(['A', 'B'])
    s = pinCards(s, ALL_DOLLARS)
    s = {
      ...s,
      players: s.players.map((p) =>
        p.id === 'p1'
          ? { ...p, position: 1, inventory: { ...p.inventory, dollars: 0, bricks: 50 } }
          : p,
      ),
    }
    s = reducer(s, { type: 'turn/rollDieWithValue', value: 6 })
    // Roll gave +$5 → $5 auto-paid → remaining $95.
    expect(s.turn.pendingFine?.amount).toBe(95)
    // Try to pay 10 bricks ($10) when you have 50 and owe $95 — must forfeit all 50.
    s = reducer(s, { type: 'turn/payFine', bricks: 10, sticks: 0, walls: 0, roofs: 0 })
    expect(s.turn.pendingFine?.amount).toBe(95) // unchanged — rejected
    expect(playerById(s, 'p1').inventory.bricks).toBe(50) // unchanged
  })

  it('Fine payment: overpay is rejected (no-overpay rule)', () => {
    let s = setupGame(['A', 'B'])
    s = pinCards(s, ALL_DOLLARS) // roll gives dollars only, not brick/stick/wall/roof
    // Land on #11 (lose $20). Player has $0 cash + 5 walls ($25 total).
    s = {
      ...s,
      players: s.players.map((p) =>
        p.id === 'p1'
          ? {
              ...p,
              position: 10, // one short of #11
              inventory: { ...p.inventory, dollars: 0, walls: 5 },
            }
          : p,
      ),
    }
    s = reducer(s, { type: 'turn/rollDieWithValue', value: 1 })
    // Roll gave p1 +$5 cash (from ALL_DOLLARS). They land on #11, cash $5 auto-
    // deducted → remaining $15 owed.
    expect(s.turn.pendingFine?.amount).toBe(15)
    // Try to forfeit 4 walls ($20) → overpay by $5 → rejected.
    s = reducer(s, { type: 'turn/payFine', bricks: 0, sticks: 0, walls: 4, roofs: 0 })
    expect(s.turn.pendingFine?.amount).toBe(15) // unchanged
    expect(playerById(s, 'p1').inventory.walls).toBe(5) // unchanged
    // Try to forfeit 3 walls ($15) → exact → accepted.
    s = reducer(s, { type: 'turn/payFine', bricks: 0, sticks: 0, walls: 3, roofs: 0 })
    expect(s.turn.pendingFine).toBeUndefined()
    expect(playerById(s, 'p1').inventory.walls).toBe(2)
  })

  it('Fine payment: partial stiff accepted when no item fits the gap', () => {
    let s = setupGame(['A', 'B'])
    s = pinCards(s, ALL_DOLLARS)
    // Land on #11. Player has $0 cash + 1 wall ($5 total).
    s = {
      ...s,
      players: s.players.map((p) =>
        p.id === 'p1'
          ? { ...p, position: 10, inventory: { ...p.inventory, dollars: 0, walls: 1 } }
          : p,
      ),
    }
    s = reducer(s, { type: 'turn/rollDieWithValue', value: 1 })
    // Roll gave $5 → auto-deducted; remaining $15 owed.
    expect(s.turn.pendingFine?.amount).toBe(15)
    // Forfeit 1 wall ($5). $5 < $15, but adding another wall would overpay
    // (player only has 1 wall) and there's nothing else. canAddMore=false → accept.
    s = reducer(s, { type: 'turn/payFine', bricks: 0, sticks: 0, walls: 1, roofs: 0 })
    expect(s.turn.pendingFine).toBeUndefined()
    expect(playerById(s, 'p1').inventory.walls).toBe(0)
  })

  it('endTurn is gated while pendingFine is set', () => {
    let s = setupGame(['A', 'B'])
    s = pinCards(s, ALL_STICKS_5)
    s = {
      ...s,
      players: s.players.map((p) =>
        p.id === 'p1'
          ? { ...p, position: 1, inventory: { ...p.inventory, dollars: 0, bricks: 50 } }
          : p,
      ),
    }
    s = reducer(s, { type: 'turn/rollDieWithValue', value: 6 })
    expect(s.turn.pendingFine).toBeTruthy()
    const before = s.currentPlayerId
    s = reducer(s, { type: 'turn/endTurn' })
    // No transition — endTurn rejected.
    expect(s.currentPlayerId).toBe(before)
    expect(s.turn.pendingFine).toBeTruthy()
  })

  it('#11 Lose $20 with sufficient funds', () => {
    let s = setupGame(['A', 'B'])
    s = { ...s, players: s.players.map((p) => (p.id === 'p1' ? { ...p, position: 10, inventory: { ...p.inventory, dollars: 100 } } : p)) }
    s = reducer(s, { type: 'turn/rollDieWithValue', value: 1 })
    expect(playerById(s, 'p1').inventory.dollars).toBe(80)
  })

  it('#11 Lose $20 with insufficient funds forfeits only what you have (no dungeon)', () => {
    let s = setupGame(['A', 'B'])
    s = { ...s, players: s.players.map((p) => (p.id === 'p1' ? { ...p, position: 10, inventory: { ...p.inventory, dollars: 5 } } : p)) }
    s = reducer(s, { type: 'turn/rollDieWithValue', value: 1 })
    expect(playerById(s, 'p1').inventory.dollars).toBe(0)
    expect(playerById(s, 'p1').dungeon.inDungeon).toBe(false)
  })

  it('#19 free Server waives the 1-Room prereq', () => {
    let s = setupGame(['A', 'B'])
    s = { ...s, players: s.players.map((p) => (p.id === 'p1' ? { ...p, position: 18 } : p)) }
    s = reducer(s, { type: 'turn/rollDieWithValue', value: 1 }) // lands on #19
    expect(playerById(s, 'p1').inventory.servers).toBe(1)
    expect(playerById(s, 'p1').inventory.rooms).toBe(0) // no room needed
  })

  it('corner #16 (bricks or wall): player choice — 10 bricks', () => {
    let s = setupGame(['A', 'B'])
    s = { ...s, players: s.players.map((p) => (p.id === 'p1' ? { ...p, position: 15 } : p)) }
    s = reducer(s, { type: 'turn/rollDieWithValue', value: 1 })
    expect(s.turn.phase).toBe('square-effect') // waiting on choice
    s = reducer(s, { type: 'turn/gift10Bricks' })
    expect(playerById(s, 'p1').inventory.bricks).toBe(10)
    expect(s.turn.phase).toBe('optional-actions')
  })

  it('corner #16 (bricks or wall): player choice — 1 wall', () => {
    let s = setupGame(['A', 'B'])
    s = { ...s, players: s.players.map((p) => (p.id === 'p1' ? { ...p, position: 15 } : p)) }
    s = reducer(s, { type: 'turn/rollDieWithValue', value: 1 })
    s = reducer(s, { type: 'turn/gift1Wall' })
    expect(playerById(s, 'p1').inventory.walls).toBe(1)
    expect(playerById(s, 'p1').inventory.bricks).toBe(0)
  })

  it('corner #25 (Just Passing) does nothing for a non-imprisoned landing', () => {
    let s = setupGame(['A', 'B'])
    s = { ...s, players: s.players.map((p) => (p.id === 'p1' ? { ...p, position: 24 } : p)) }
    s = reducer(s, { type: 'turn/rollDieWithValue', value: 1 })
    expect(playerById(s, 'p1').position).toBe(25)
    expect(playerById(s, 'p1').dungeon.inDungeon).toBe(false)
  })

  it('#24 Roll Again auto-ends the landing turn and re-enters turn-start for the same player', () => {
    let s = setupGame(['A', 'B'])
    s = { ...s, players: s.players.map((p) => (p.id === 'p1' ? { ...p, position: 23 } : p)) }
    s = reducer(s, { type: 'turn/rollDieWithValue', value: 1 }) // lands on #24
    // Under the new flow, #24 auto-ends without a shop/build/trade phase: the
    // extra turn is consumed immediately and we're back in turn-start for the
    // same player, ready to re-roll.
    expect(s.currentPlayerId).toBe('p1')
    expect(s.turn.phase).toBe('turn-start')
    expect(s.turn.extraTurnsQueued).toBe(0)
    expect(s.turn.skipOptionalActions).toBe(false) // reset after extra-turn consumption
  })

  it('#24 + same-square duel: auto-end fires after the duel resolves', () => {
    let s = setupGame(['A', 'B'])
    s = {
      ...s,
      players: s.players.map((p) =>
        p.id === 'p2'
          ? { ...p, position: 24, inventory: { ...p.inventory, dollars: 50 } }
          : { ...p, position: 23, inventory: { ...p.inventory, dollars: 50 } },
      ),
    }
    s = reducer(s, { type: 'turn/rollDieWithValue', value: 1 }) // p1 lands on #24, duel fires
    expect(s.turn.phase).toBe('duel')
    s = reducer(s, {
      type: 'turn/duelSetStake',
      stake: { dollars: 5, bricks: 0, sticks: 0, walls: 0, roofs: 0, rooms: 0 },
    })
    s = reducer(s, { type: 'turn/duelRollForPlayer', id: 'p1', value: 5 })
    s = reducer(s, { type: 'turn/duelRollForPlayer', id: 'p2', value: 3 })
    s = reducer(s, { type: 'turn/duelResolve' })
    // After the duel, the #24 auto-end fires — not optional-actions.
    expect(s.turn.phase).toBe('turn-start')
    expect(s.currentPlayerId).toBe('p1')
  })

  it('#24 sequence counts as one base turn (extra turn does not double-increment baseTurnsTaken)', () => {
    let s = setupGame(['A', 'B'])
    s = { ...s, players: s.players.map((p) => (p.id === 'p1' ? { ...p, position: 23 } : p)) }
    const before = playerById(s, 'p1').baseTurnsTaken
    s = reducer(s, { type: 'turn/rollDieWithValue', value: 1 }) // lands on #24, auto-ends to re-roll
    s = reducer(s, { type: 'turn/rollDieWithValue', value: 3 }) // lands on #27 (Bailiff square, ok)
    // Handle any acquisition prompts the 2nd roll triggered.
    if (s.turn.phase === 'post-roll-bailiff') {
      s = reducer(s, { type: 'turn/bailiffStealPostRollSkip' })
    }
    s = reducer(s, { type: 'turn/endTurn' })
    const after = playerById(s, 'p1').baseTurnsTaken
    expect(after).toBe(before + 1) // exactly one base turn for the whole sequence
  })
})

// ==================== Alliance squares ====================

describe('Kingdom Alliance', () => {
  it('#3 offer: not allied, accept — pays 10b + 10s and becomes allied', () => {
    let s = setupGame(['A', 'B'])
    s = pinCards(s, ALL_DOLLARS) // rolls give dollars, not bricks/sticks
    s = { ...s, players: s.players.map((p) => (p.id === 'p1' ? { ...p, position: 1, inventory: { ...p.inventory, bricks: 20, sticks: 20 } } : p)) }
    s = reducer(s, { type: 'turn/rollDieWithValue', value: 2 })
    expect(s.turn.phase).toBe('square-effect') // pending decision
    s = reducer(s, { type: 'turn/acceptAlliance' })
    const p1 = playerById(s, 'p1')
    expect(p1.inventory.allied).toBe(true)
    expect(p1.inventory.bricks).toBe(10)
    expect(p1.inventory.sticks).toBe(10)
  })

  it('#3 offer: not allied, decline — stays un-allied, no cost', () => {
    let s = setupGame(['A', 'B'])
    s = pinCards(s, ALL_DOLLARS)
    s = { ...s, players: s.players.map((p) => (p.id === 'p1' ? { ...p, position: 1, inventory: { ...p.inventory, bricks: 20, sticks: 20 } } : p)) }
    s = reducer(s, { type: 'turn/rollDieWithValue', value: 2 })
    s = reducer(s, { type: 'turn/declineAlliance' })
    expect(playerById(s, 'p1').inventory.allied).toBe(false)
    expect(playerById(s, 'p1').inventory.bricks).toBe(20)
  })

  it('#3 offer: already allied RECEIVES 10b + 10s for free', () => {
    let s = setupGame(['A', 'B'])
    s = pinCards(s, ALL_DOLLARS)
    s = { ...s, players: s.players.map((p) => (p.id === 'p1' ? { ...p, position: 1, inventory: { ...p.inventory, allied: true, bricks: 0, sticks: 0 } } : p)) }
    s = reducer(s, { type: 'turn/rollDieWithValue', value: 2 })
    expect(playerById(s, 'p1').inventory.bricks).toBe(10)
    expect(playerById(s, 'p1').inventory.sticks).toBe(10)
    expect(s.turn.phase).not.toBe('square-effect') // auto-advanced
  })

  it('#20 offer: already allied RECEIVES 20b + 20s for free', () => {
    let s = setupGame(['A', 'B'])
    s = pinCards(s, ALL_DOLLARS)
    s = { ...s, players: s.players.map((p) => (p.id === 'p1' ? { ...p, position: 19, inventory: { ...p.inventory, allied: true, bricks: 0, sticks: 0 } } : p)) }
    s = reducer(s, { type: 'turn/rollDieWithValue', value: 1 })
    expect(playerById(s, 'p1').inventory.bricks).toBe(20)
    expect(playerById(s, 'p1').inventory.sticks).toBe(20)
  })
})

// ==================== Bailiff ====================

describe('Bailiff', () => {
  it('steal from a target with sufficient inventory (bricks)', () => {
    let s = setupGame(['A', 'B'])
    s = {
      ...s,
      bailiff: { kind: 'held', by: 'p1' },
      players: s.players.map((p) => (p.id === 'p2' ? { ...p, inventory: { ...p.inventory, bricks: 10 } } : p)),
    }
    s = reducer(s, { type: 'turn/bailiffStealPreRoll', targetId: 'p2', item: 'bricks' })
    expect(playerById(s, 'p1').inventory.bricks).toBe(5)
    expect(playerById(s, 'p2').inventory.bricks).toBe(5)
    expect(s.turn.bailiffStealUsedThisTurnSequence).toBe(true)
  })

  it('steal silently fails (and consumes the turn) when target has nothing', () => {
    let s = setupGame(['A', 'B'])
    s = { ...s, bailiff: { kind: 'held', by: 'p1' } }
    // p2 has 0 bricks.
    s = reducer(s, { type: 'turn/bailiffStealPreRoll', targetId: 'p2', item: 'bricks' })
    expect(playerById(s, 'p1').inventory.bricks).toBe(0)
    expect(s.turn.bailiffStealUsedThisTurnSequence).toBe(true) // still spent
  })

  it('Queen no longer grants Bailiff immunity (revised 2026-04-19)', () => {
    let s = setupGame(['A', 'B'])
    s = {
      ...s,
      bailiff: { kind: 'held', by: 'p1' },
      players: s.players.map((p) =>
        p.id === 'p2'
          ? { ...p, inventory: { ...p.inventory, bricks: 100, queen: true } }
          : p,
      ),
    }
    s = reducer(s, { type: 'turn/bailiffStealPreRoll', targetId: 'p2', item: 'bricks' })
    expect(playerById(s, 'p1').inventory.bricks).toBe(5) // steal succeeded
    expect(playerById(s, 'p2').inventory.bricks).toBe(95)
    expect(s.turn.bailiffStealUsedThisTurnSequence).toBe(true)
  })

  it('Knight immunity: steal action is blocked if target owns a Knight', () => {
    let s = setupGame(['A', 'B'])
    s = {
      ...s,
      bailiff: { kind: 'held', by: 'p1' },
      players: s.players.map((p) =>
        p.id === 'p2'
          ? { ...p, inventory: { ...p.inventory, bricks: 100, knight: true } }
          : p,
      ),
    }
    s = reducer(s, { type: 'turn/bailiffStealPreRoll', targetId: 'p2', item: 'bricks' })
    expect(playerById(s, 'p1').inventory.bricks).toBe(0)
    expect(playerById(s, 'p2').inventory.bricks).toBe(100) // unchanged
    expect(s.turn.bailiffStealUsedThisTurnSequence).toBe(false) // silent no-op, flag not consumed
  })

  it('once-per-turn-sequence cap: pre-roll steal blocks a second attempt in the same sequence', () => {
    let s = setupGame(['A', 'B'])
    s = {
      ...s,
      bailiff: { kind: 'held', by: 'p1' },
      players: s.players.map((p) => (p.id === 'p2' ? { ...p, inventory: { ...p.inventory, bricks: 100 } } : p)),
    }
    s = reducer(s, { type: 'turn/bailiffStealPreRoll', targetId: 'p2', item: 'bricks' })
    expect(playerById(s, 'p1').inventory.bricks).toBe(5)
    // Second attempt in the same turn sequence → no-op.
    s = reducer(s, { type: 'turn/bailiffStealPreRoll', targetId: 'p2', item: 'bricks' })
    expect(playerById(s, 'p1').inventory.bricks).toBe(5)
  })

  it('Bailiff is lost when sent to the dungeon', () => {
    let s = setupGame(['A', 'B'])
    s = {
      ...s,
      bailiff: { kind: 'held', by: 'p1' },
      players: s.players.map((p) => (p.id === 'p1' ? { ...p, position: 7 } : p)),
    }
    s = reducer(s, { type: 'turn/rollDieWithValue', value: 3 }) // #10
    expect(s.bailiff).toEqual({ kind: 'middle' })
  })

  it('transfers the Bailiff when a new player lands on a Bailiff square', () => {
    let s = setupGame(['A', 'B'])
    s = { ...s, bailiff: { kind: 'held', by: 'p2' } }
    s = reducer(s, { type: 'turn/rollDieWithValue', value: 4 }) // p1 → #5
    expect(s.bailiff).toEqual({ kind: 'held', by: 'p1' })
  })

  it('landing on a Bailiff square while already the holder is a silent no-op', () => {
    let s = setupGame(['A', 'B'])
    // p1 already holds the Bailiff. p1 rolls to #5 (also a Bailiff square).
    s = { ...s, bailiff: { kind: 'held', by: 'p1' } }
    s = reducer(s, { type: 'turn/rollDieWithValue', value: 4 }) // p1 → #5
    // No re-transfer, no "acquisition turn" flag — so no post-roll-steal UI.
    expect(s.bailiff).toEqual({ kind: 'held', by: 'p1' })
    expect(s.turn.acquiredBailiffThisTurn).toBe(false)
    expect(s.turn.phase).toBe('optional-actions') // straight to optional actions
  })

  it('post-roll steal is blocked if the pre-roll steal already fired this sequence', () => {
    let s = setupGame(['A', 'B'])
    // Simulate: p1 pre-roll-stole earlier in the turn sequence, then somehow
    // reached post-roll-bailiff (an illegal scenario before this fix). Reject.
    s = {
      ...s,
      bailiff: { kind: 'held', by: 'p1' },
      turn: {
        ...s.turn,
        bailiffStealUsedThisTurnSequence: true,
        acquiredBailiffThisTurn: true,
        phase: 'post-roll-bailiff',
      },
      players: s.players.map((p) =>
        p.id === 'p2'
          ? { ...p, inventory: { ...p.inventory, bricks: 100 } }
          : p,
      ),
    }
    s = reducer(s, { type: 'turn/bailiffStealPostRoll', targetId: 'p2', item: 'bricks' })
    // No steal happened, and phase did NOT advance (reducer returned state unchanged).
    expect(playerById(s, 'p1').inventory.bricks).toBe(0)
    expect(playerById(s, 'p2').inventory.bricks).toBe(100)
  })

  it('post-roll Bailiff skip advances to optional-actions (no sticky phase)', () => {
    let s = setupGame(['A', 'B'])
    s = reducer(s, { type: 'turn/rollDieWithValue', value: 4 }) // p1 → #5, acquires Bailiff
    expect(s.turn.phase).toBe('post-roll-bailiff')
    s = reducer(s, { type: 'turn/bailiffStealPostRollSkip' })
    expect(s.turn.phase).toBe('optional-actions')
  })
})

// ==================== Dungeon ====================

describe('Dungeon', () => {
  it('roll a 1 while imprisoned releases the player', () => {
    let s = setupGame(['A', 'B'])
    s = {
      ...s,
      players: s.players.map((p) =>
        p.id === 'p1' ? { ...p, position: 25, dungeon: { inDungeon: true, turnsServed: 0 } } : p,
      ),
    }
    s = reducer(s, { type: 'turn/rollDieWithValue', value: 1 })
    expect(playerById(s, 'p1').dungeon.inDungeon).toBe(false)
    expect(playerById(s, 'p1').position).toBe(25)
  })

  it('auto-releases on the 3rd dungeon turn regardless of roll', () => {
    let s = setupGame(['A', 'B'])
    s = {
      ...s,
      players: s.players.map((p) =>
        p.id === 'p1' ? { ...p, position: 25, dungeon: { inDungeon: true, turnsServed: 2 } } : p,
      ),
    }
    s = reducer(s, { type: 'turn/rollDieWithValue', value: 6 })
    expect(playerById(s, 'p1').dungeon.inDungeon).toBe(false)
  })

  it('does not release if still under the 3-turn limit on a non-1 roll', () => {
    let s = setupGame(['A', 'B'])
    s = {
      ...s,
      players: s.players.map((p) =>
        p.id === 'p1' ? { ...p, position: 25, dungeon: { inDungeon: true, turnsServed: 0 } } : p,
      ),
    }
    s = reducer(s, { type: 'turn/rollDieWithValue', value: 4 })
    expect(playerById(s, 'p1').dungeon.inDungeon).toBe(true)
    expect(playerById(s, 'p1').dungeon.turnsServed).toBe(1)
  })

  it('Royal Pardon redemption gives a full normal turn', () => {
    let s = setupGame(['A', 'B'])
    s = {
      ...s,
      players: s.players.map((p) =>
        p.id === 'p1'
          ? {
              ...p,
              position: 25,
              dungeon: { inDungeon: true, turnsServed: 1 },
              inventory: { ...p.inventory, pardonCards: 1 },
            }
          : p,
      ),
    }
    s = reducer(s, { type: 'dungeon/redeemPardon' })
    const p1 = playerById(s, 'p1')
    expect(p1.dungeon.inDungeon).toBe(false)
    expect(p1.inventory.pardonCards).toBe(0)
    expect(s.turn.phase).toBe('turn-start')
    expect(s.discard).toContain(17)
  })

  it('passives are suspended while imprisoned (Worker + WHC)', () => {
    let s = setupGame(['A', 'B'])
    s = pinCards(s, ALL_STICKS_5) // avoid dollars/walls/roofs from distribution
    s = {
      ...s,
      players: s.players.map((p) =>
        p.id === 'p1'
          ? {
              ...p,
              position: 25,
              dungeon: { inDungeon: true, turnsServed: 0 },
              inventory: { ...p.inventory, workers: 1, wholeHouseCleaners: 2 },
            }
          : p,
      ),
    }
    s = reducer(s, { type: 'turn/rollDieWithValue', value: 4 })
    const p1 = playerById(s, 'p1')
    expect(p1.inventory.walls).toBe(0) // Worker suspended
    expect(p1.inventory.roofs).toBe(0)
    expect(p1.inventory.dollars).toBe(0) // WHC suspended
  })

  it('dungeon entry mid-turn does NOT block the rest of the turn (buy/trade/build allowed)', () => {
    let s = setupGame(['A', 'B'])
    s = pinCards(s, ALL_STICKS_5) // rolls give sticks, not bricks/dollars
    s = {
      ...s,
      players: s.players.map((p) =>
        p.id === 'p1' ? { ...p, position: 7, inventory: { ...p.inventory, dollars: 50 } } : p,
      ),
    }
    s = reducer(s, { type: 'turn/rollDieWithValue', value: 3 }) // #10 → dungeon
    expect(playerById(s, 'p1').dungeon.inDungeon).toBe(true)
    expect(s.turn.enteredDungeonThisTurn).toBe(true)
    expect(s.turn.phase).toBe('optional-actions')
    // Still able to buy.
    s = reducer(s, { type: 'turn/buy', item: 'brick', quantity: 5 })
    expect(playerById(s, 'p1').inventory.bricks).toBe(5)
    expect(playerById(s, 'p1').inventory.dollars).toBe(45)
  })
})

// ==================== Duel ====================

describe('Same-square duel', () => {
  it('triggers when two players share a destination square', () => {
    let s = setupGame(['A', 'B'])
    // Put p2 on #2 already. p1 rolls 1 → lands on #2.
    s = { ...s, players: s.players.map((p) => (p.id === 'p2' ? { ...p, position: 2 } : p)) }
    s = reducer(s, { type: 'turn/rollDieWithValue', value: 1 })
    expect(s.turn.phase).toBe('duel')
    expect(s.duel?.participants).toEqual(['p1', 'p2'])
    expect(s.duel?.contenders).toEqual(['p1', 'p2'])
  })

  it('set-stake subtracts from every participant', () => {
    let s = setupGame(['A', 'B'])
    s = {
      ...s,
      players: s.players.map((p) =>
        p.id === 'p2'
          ? { ...p, position: 2, inventory: { ...p.inventory, dollars: 50 } }
          : { ...p, inventory: { ...p.inventory, dollars: 50 } },
      ),
    }
    s = reducer(s, { type: 'turn/rollDieWithValue', value: 1 })
    s = reducer(s, {
      type: 'turn/duelSetStake',
      stake: { dollars: 10, bricks: 0, sticks: 0, walls: 0, roofs: 0, rooms: 0 },
    })
    expect(playerById(s, 'p1').inventory.dollars).toBe(40)
    expect(playerById(s, 'p2').inventory.dollars).toBe(40)
  })

  it('resolves: winner takes pot (stake × participants)', () => {
    let s = setupGame(['A', 'B'])
    s = {
      ...s,
      players: s.players.map((p) =>
        p.id === 'p2'
          ? { ...p, position: 2, inventory: { ...p.inventory, dollars: 50 } }
          : { ...p, inventory: { ...p.inventory, dollars: 50 } },
      ),
    }
    s = reducer(s, { type: 'turn/rollDieWithValue', value: 1 })
    s = reducer(s, {
      type: 'turn/duelSetStake',
      stake: { dollars: 10, bricks: 0, sticks: 0, walls: 0, roofs: 0, rooms: 0 },
    })
    s = reducer(s, { type: 'turn/duelRollForPlayer', id: 'p1', value: 5 })
    s = reducer(s, { type: 'turn/duelRollForPlayer', id: 'p2', value: 3 })
    s = reducer(s, { type: 'turn/duelResolve' })
    expect(s.duel).toBeUndefined()
    expect(playerById(s, 'p1').inventory.dollars).toBe(60) // 40 + 20 (pot)
    expect(playerById(s, 'p2').inventory.dollars).toBe(40) // lost stake
  })

  it('ties: only tied contenders re-roll; non-tied are eliminated', () => {
    let s = setupGame(['A', 'B', 'C'])
    s = {
      ...s,
      players: s.players.map((p) =>
        p.id === 'p2' || p.id === 'p3'
          ? { ...p, position: 2, inventory: { ...p.inventory, dollars: 50 } }
          : { ...p, inventory: { ...p.inventory, dollars: 50 } },
      ),
    }
    s = reducer(s, { type: 'turn/rollDieWithValue', value: 1 })
    s = reducer(s, {
      type: 'turn/duelSetStake',
      stake: { dollars: 5, bricks: 0, sticks: 0, walls: 0, roofs: 0, rooms: 0 },
    })
    s = reducer(s, { type: 'turn/duelRollForPlayer', id: 'p1', value: 6 })
    s = reducer(s, { type: 'turn/duelRollForPlayer', id: 'p2', value: 6 })
    s = reducer(s, { type: 'turn/duelRollForPlayer', id: 'p3', value: 3 })
    s = reducer(s, { type: 'turn/duelResolve' })
    // Tie between p1 and p2 → contenders shrinks to [p1, p2]; rolls cleared; p3 eliminated.
    expect(s.duel?.contenders).toEqual(['p1', 'p2'])
    expect(s.duel?.rolls).toEqual({})
    // p3's roll of 3 can't win even if p1 and p2 re-roll lower.
    s = reducer(s, { type: 'turn/duelRollForPlayer', id: 'p1', value: 1 })
    s = reducer(s, { type: 'turn/duelRollForPlayer', id: 'p2', value: 2 })
    s = reducer(s, { type: 'turn/duelResolve' })
    expect(playerById(s, 'p2').inventory.dollars).toBe(45 + 15) // 45 left + full pot 15
    expect(playerById(s, 'p3').inventory.dollars).toBe(45) // lost stake but couldn't win
  })
})

// ==================== Shop / Build / Trade ====================

describe('Shop, Build, Trade', () => {
  it('buys bricks in bundles of 5', () => {
    let s = setupGame(['A', 'B'])
    s = { ...s, players: s.players.map((p) => (p.id === 'p1' ? { ...p, inventory: { ...p.inventory, dollars: 10 } } : p)) }
    s = reducer(s, { type: 'turn/buy', item: 'brick', quantity: 5 })
    expect(playerById(s, 'p1').inventory.bricks).toBe(5)
    expect(playerById(s, 'p1').inventory.dollars).toBe(5)
  })

  it('buys bricks in multiples of 5 in one action (no click-spam)', () => {
    let s = setupGame(['A', 'B'])
    s = { ...s, players: s.players.map((p) => (p.id === 'p1' ? { ...p, inventory: { ...p.inventory, dollars: 25 } } : p)) }
    s = reducer(s, { type: 'turn/buy', item: 'brick', quantity: 20 })
    expect(playerById(s, 'p1').inventory.bricks).toBe(20)
    expect(playerById(s, 'p1').inventory.dollars).toBe(5)
  })

  it('rejects non-multiple-of-5 brick purchases', () => {
    let s = setupGame(['A', 'B'])
    s = { ...s, players: s.players.map((p) => (p.id === 'p1' ? { ...p, inventory: { ...p.inventory, dollars: 100 } } : p)) }
    // 6 bricks — not a multiple of 5 → reject entirely (don't round).
    s = reducer(s, { type: 'turn/buy', item: 'brick', quantity: 6 })
    expect(playerById(s, 'p1').inventory.bricks).toBe(0)
    expect(playerById(s, 'p1').inventory.dollars).toBe(100)
    // 3 bricks — below the 5-minimum → reject.
    s = reducer(s, { type: 'turn/buy', item: 'brick', quantity: 3 })
    expect(playerById(s, 'p1').inventory.bricks).toBe(0)
    expect(playerById(s, 'p1').inventory.dollars).toBe(100)
  })

  it('rejects non-multiple-of-5 stick purchases', () => {
    let s = setupGame(['A', 'B'])
    s = { ...s, players: s.players.map((p) => (p.id === 'p1' ? { ...p, inventory: { ...p.inventory, dollars: 100 } } : p)) }
    s = reducer(s, { type: 'turn/buy', item: 'stick', quantity: 7 })
    expect(playerById(s, 'p1').inventory.sticks).toBe(0)
    expect(playerById(s, 'p1').inventory.dollars).toBe(100)
  })

  it('builds multiple walls in one action', () => {
    let s = setupGame(['A', 'B'])
    s = { ...s, players: s.players.map((p) => (p.id === 'p1' ? { ...p, inventory: { ...p.inventory, bricks: 20 } } : p)) }
    s = reducer(s, { type: 'turn/build', item: 'wall', count: 4 })
    const p1 = playerById(s, 'p1')
    expect(p1.inventory.walls).toBe(4)
    expect(p1.inventory.bricks).toBe(0)
  })

  it('building N walls stops at whatever resources allow', () => {
    let s = setupGame(['A', 'B'])
    s = { ...s, players: s.players.map((p) => (p.id === 'p1' ? { ...p, inventory: { ...p.inventory, bricks: 12 } } : p)) }
    // Ask for 5 walls (needs 25 bricks) — only 2 walls possible (10 bricks), 2 bricks left.
    s = reducer(s, { type: 'turn/build', item: 'wall', count: 5 })
    const p1 = playerById(s, 'p1')
    expect(p1.inventory.walls).toBe(2)
    expect(p1.inventory.bricks).toBe(2)
  })

  it('Server requires at least 1 Room', () => {
    let s = setupGame(['A', 'B'])
    s = { ...s, players: s.players.map((p) => (p.id === 'p1' ? { ...p, inventory: { ...p.inventory, dollars: 50 } } : p)) }
    s = reducer(s, { type: 'turn/buy', item: 'server', quantity: 1 })
    expect(playerById(s, 'p1').inventory.servers).toBe(0)
    // Add a room then try again.
    s = { ...s, players: s.players.map((p) => (p.id === 'p1' ? { ...p, inventory: { ...p.inventory, rooms: 1 } } : p)) }
    s = reducer(s, { type: 'turn/buy', item: 'server', quantity: 1 })
    expect(playerById(s, 'p1').inventory.servers).toBe(1)
  })

  it('Bug 5: Server prereq satisfied by a Building alone (no raw rooms)', () => {
    let s = setupGame(['A', 'B'])
    s = {
      ...s,
      players: s.players.map((p) =>
        p.id === 'p1' ? { ...p, inventory: { ...p.inventory, dollars: 50, buildings: 1 } } : p,
      ),
    }
    s = reducer(s, { type: 'turn/buy', item: 'server', quantity: 1 })
    expect(playerById(s, 'p1').inventory.servers).toBe(1)
  })

  it('Bug 5: Chef prereq satisfied by a 3-Story Building alone', () => {
    let s = setupGame(['A', 'B'])
    s = {
      ...s,
      players: s.players.map((p) =>
        p.id === 'p1'
          ? { ...p, inventory: { ...p.inventory, dollars: 50, threeStoryBuildings: 1 } }
          : p,
      ),
    }
    s = reducer(s, { type: 'turn/buy', item: 'chef', quantity: 1 })
    expect(playerById(s, 'p1').inventory.chefs).toBe(1)
  })

  it('Bug 5: Cleaner prereq satisfied by a Palace alone', () => {
    let s = setupGame(['A', 'B'])
    s = {
      ...s,
      players: s.players.map((p) =>
        p.id === 'p1' ? { ...p, inventory: { ...p.inventory, dollars: 50, palaces: 1 } } : p,
      ),
    }
    s = reducer(s, { type: 'turn/buy', item: 'cleaner', quantity: 1 })
    expect(playerById(s, 'p1').inventory.cleaners).toBe(1)
  })

  it('Bug 7: Building construction prereq is satisfied by a WHC (no raw Cleaners)', () => {
    let s = setupGame(['A', 'B'])
    s = {
      ...s,
      players: s.players.map((p) =>
        p.id === 'p1'
          ? {
              ...p,
              inventory: {
                ...p.inventory,
                rooms: 3,
                wholeHouseCleaners: 1,
                servers: 0,
                chefs: 0,
                cleaners: 0,
              },
            }
          : p,
      ),
    }
    s = reducer(s, { type: 'turn/build', item: 'building', count: 1 })
    expect(playerById(s, 'p1').inventory.buildings).toBe(1)
  })

  it('Bug 7: 3-Story construction prereq is satisfied by WHC + Server + Chef (no raw Cleaner)', () => {
    let s = setupGame(['A', 'B'])
    s = {
      ...s,
      players: s.players.map((p) =>
        p.id === 'p1'
          ? {
              ...p,
              inventory: {
                ...p.inventory,
                buildings: 3,
                servers: 1,
                chefs: 1,
                cleaners: 0,
                wholeHouseCleaners: 1,
              },
            }
          : p,
      ),
    }
    s = reducer(s, { type: 'turn/build', item: 'threeStoryBuilding', count: 1 })
    expect(playerById(s, 'p1').inventory.threeStoryBuildings).toBe(1)
  })

  it('Queen is capped at 1 per player', () => {
    let s = setupGame(['A', 'B'])
    s = { ...s, players: s.players.map((p) => (p.id === 'p1' ? { ...p, inventory: { ...p.inventory, dollars: 700 } } : p)) }
    s = reducer(s, { type: 'turn/buy', item: 'queen', quantity: 1 })
    expect(playerById(s, 'p1').inventory.queen).toBe(true)
    expect(playerById(s, 'p1').inventory.dollars).toBe(400)
    s = reducer(s, { type: 'turn/buy', item: 'queen', quantity: 1 })
    expect(playerById(s, 'p1').inventory.dollars).toBe(400) // no second queen
  })

  it('Knight costs $75 and scores 5 pts', () => {
    let s = setupGame(['A', 'B'])
    s = { ...s, players: s.players.map((p) => (p.id === 'p1' ? { ...p, inventory: { ...p.inventory, dollars: 75 } } : p)) }
    s = reducer(s, { type: 'turn/buy', item: 'knight', quantity: 1 })
    const p1 = playerById(s, 'p1')
    expect(p1.inventory.knight).toBe(true)
    expect(p1.inventory.dollars).toBe(0)
    expect(totalPoints(p1.inventory)).toBe(5)
  })

  it('Knight is capped at 1 per player', () => {
    let s = setupGame(['A', 'B'])
    s = { ...s, players: s.players.map((p) => (p.id === 'p1' ? { ...p, inventory: { ...p.inventory, dollars: 200, knight: true } } : p)) }
    s = reducer(s, { type: 'turn/buy', item: 'knight', quantity: 1 })
    expect(playerById(s, 'p1').inventory.dollars).toBe(200) // unchanged — second knight rejected
    expect(playerById(s, 'p1').inventory.knight).toBe(true)
  })

  it('builds a Room (4 walls + 1 roof)', () => {
    let s = setupGame(['A', 'B'])
    s = { ...s, players: s.players.map((p) => (p.id === 'p1' ? { ...p, inventory: { ...p.inventory, walls: 4, roofs: 1 } } : p)) }
    s = reducer(s, { type: 'turn/build', item: 'room', count: 1 })
    const p1 = playerById(s, 'p1')
    expect(p1.inventory.rooms).toBe(1)
    expect(p1.inventory.walls).toBe(0)
    expect(p1.inventory.roofs).toBe(0)
  })

  it('building a Palace requires 3 three-story buildings', () => {
    let s = setupGame(['A', 'B'])
    s = { ...s, players: s.players.map((p) => (p.id === 'p1' ? { ...p, inventory: { ...p.inventory, threeStoryBuildings: 3 } } : p)) }
    s = reducer(s, { type: 'turn/build', item: 'palace', count: 1 })
    expect(playerById(s, 'p1').inventory.palaces).toBe(1)
    expect(s.palaceBuiltBy).toBe('p1')
  })

  it('trades bricks → sticks in batches of 10 at 2:1', () => {
    let s = setupGame(['A', 'B'])
    s = { ...s, players: s.players.map((p) => (p.id === 'p1' ? { ...p, inventory: { ...p.inventory, bricks: 20 } } : p)) }
    s = reducer(s, { type: 'turn/trade', from: 'bricks', amount: 10 })
    let p1 = playerById(s, 'p1')
    expect(p1.inventory.bricks).toBe(10)
    expect(p1.inventory.sticks).toBe(5)
    // A second 10-batch trade works too.
    s = reducer(s, { type: 'turn/trade', from: 'bricks', amount: 10 })
    p1 = playerById(s, 'p1')
    expect(p1.inventory.bricks).toBe(0)
    expect(p1.inventory.sticks).toBe(10)
  })

  it('rejects trade amounts below 10 or not a multiple of 10', () => {
    let s = setupGame(['A', 'B'])
    s = { ...s, players: s.players.map((p) => (p.id === 'p1' ? { ...p, inventory: { ...p.inventory, bricks: 40 } } : p)) }
    // Legacy 2-batch (below new 10-minimum) → rejected.
    s = reducer(s, { type: 'turn/trade', from: 'bricks', amount: 4 })
    expect(playerById(s, 'p1').inventory.bricks).toBe(40)
    // Old step-of-2 above the minimum (e.g. 12) → rejected.
    s = reducer(s, { type: 'turn/trade', from: 'bricks', amount: 12 })
    expect(playerById(s, 'p1').inventory.bricks).toBe(40)
    // 10 is valid.
    s = reducer(s, { type: 'turn/trade', from: 'bricks', amount: 10 })
    expect(playerById(s, 'p1').inventory.bricks).toBe(30)
    expect(playerById(s, 'p1').inventory.sticks).toBe(5)
  })

  it('#29 Brick Trader converts 10 bricks → $15 while on the square', () => {
    let s = setupGame(['A', 'B'])
    s = { ...s, players: s.players.map((p) => (p.id === 'p1' ? { ...p, position: 29, inventory: { ...p.inventory, bricks: 30 } } : p)) }
    s = reducer(s, { type: 'turn/traderBricksSell', batches: 2 })
    const p1 = playerById(s, 'p1')
    expect(p1.inventory.bricks).toBe(10)
    expect(p1.inventory.dollars).toBe(30)
  })

  it('#29 only fires when the player is ON #29', () => {
    let s = setupGame(['A', 'B'])
    s = { ...s, players: s.players.map((p) => (p.id === 'p1' ? { ...p, inventory: { ...p.inventory, bricks: 30 } } : p)) }
    s = reducer(s, { type: 'turn/traderBricksSell', batches: 1 })
    expect(playerById(s, 'p1').inventory.bricks).toBe(30) // no change
  })

  it('#8 Walls Trader: $10 for 3 walls, multi-batch in one action', () => {
    let s = setupGame(['A', 'B'])
    s = { ...s, players: s.players.map((p) => (p.id === 'p1' ? { ...p, position: 8, inventory: { ...p.inventory, dollars: 30 } } : p)) }
    s = reducer(s, { type: 'turn/traderWallsBuy', batches: 3 })
    const p1 = playerById(s, 'p1')
    expect(p1.inventory.walls).toBe(9)
    expect(p1.inventory.dollars).toBe(0)
  })

  it('Bug 6: #29 Brick Trader blocks a second use in the same turn', () => {
    let s = setupGame(['A', 'B'])
    s = { ...s, players: s.players.map((p) => (p.id === 'p1' ? { ...p, position: 29, inventory: { ...p.inventory, bricks: 30 } } : p)) }
    s = reducer(s, { type: 'turn/traderBricksSell', batches: 1 })
    expect(playerById(s, 'p1').inventory.bricks).toBe(20)
    expect(playerById(s, 'p1').inventory.dollars).toBe(15)
    expect(s.turn.traderUsedThisTurn).toBe(true)
    // Second attempt rejected.
    s = reducer(s, { type: 'turn/traderBricksSell', batches: 1 })
    expect(playerById(s, 'p1').inventory.bricks).toBe(20) // unchanged
    expect(playerById(s, 'p1').inventory.dollars).toBe(15) // unchanged
  })

  it('Bug 6: #8 Walls Trader blocks a second use in the same turn', () => {
    let s = setupGame(['A', 'B'])
    s = { ...s, players: s.players.map((p) => (p.id === 'p1' ? { ...p, position: 8, inventory: { ...p.inventory, dollars: 30 } } : p)) }
    s = reducer(s, { type: 'turn/traderWallsBuy', batches: 1 })
    expect(playerById(s, 'p1').inventory.walls).toBe(3)
    expect(s.turn.traderUsedThisTurn).toBe(true)
    // Second attempt rejected.
    s = reducer(s, { type: 'turn/traderWallsBuy', batches: 1 })
    expect(playerById(s, 'p1').inventory.walls).toBe(3) // unchanged
  })

  it('Bug 6: trader flag resets on next turn', () => {
    let s = setupGame(['A', 'B'])
    s = { ...s, players: s.players.map((p) => (p.id === 'p1' ? { ...p, position: 29, inventory: { ...p.inventory, bricks: 30 } } : p)) }
    s = reducer(s, { type: 'turn/traderBricksSell', batches: 1 })
    expect(s.turn.traderUsedThisTurn).toBe(true)
    s = reducer(s, { type: 'turn/endTurn' }) // p1 → p2
    expect(s.turn.traderUsedThisTurn).toBe(false)
    s = reducer(s, { type: 'turn/endTurn' }) // p2 → p1
    expect(s.turn.traderUsedThisTurn).toBe(false)
  })

  it('#14 Half-price Cleaner waives room prereq', () => {
    let s = setupGame(['A', 'B'])
    s = { ...s, players: s.players.map((p) => (p.id === 'p1' ? { ...p, position: 14, inventory: { ...p.inventory, dollars: 30 } } : p)) }
    s = reducer(s, { type: 'turn/halfPriceCleanerBuy', count: 3 })
    const p1 = playerById(s, 'p1')
    expect(p1.inventory.cleaners).toBe(3)
    expect(p1.inventory.dollars).toBe(0)
    expect(p1.inventory.rooms).toBe(0) // no room prereq needed
  })
})

// ==================== Card effects ====================

describe('Cards', () => {
  function forceNextCard(s: GameState, cardId: number): GameState {
    // Move the desired cardId to the top of the deck.
    const idx = s.deck.indexOf(cardId)
    if (idx === -1) {
      // It might already be in discard or in hand; pull it to the front of the deck.
      const allPlaces = [...s.deck, ...s.discard]
      if (!allPlaces.includes(cardId)) throw new Error(`card ${cardId} not in deck/discard`)
      return {
        ...s,
        deck: [cardId, ...s.deck.filter((id) => id !== cardId), ...s.discard.filter((id) => id !== cardId)],
        discard: [],
      }
    }
    const newDeck = [cardId, ...s.deck.slice(0, idx), ...s.deck.slice(idx + 1)]
    return { ...s, deck: newDeck }
  }

  it('Card #17 Royal Pardon is held (not discarded) on draw', () => {
    let s = setupGame(['A', 'B'])
    s = withResourceCard(s, 'p1', ALL_DRAWS)
    s = reducer(s, { type: 'mapping/revealAll' })
    s = forceNextCard(s, 17)
    const discardBefore = s.discard.length
    s = reducer(s, { type: 'turn/rollDieWithValue', value: 1 })
    expect(playerById(s, 'p1').inventory.pardonCards).toBe(1)
    // Card #17 is NOT added to discard (stays in hand).
    expect(s.discard.length).toBe(discardBefore)
    expect(s.discard).not.toContain(17)
  })

  it('Card #18 Get the Bailiff transfers to the drawer', () => {
    let s = setupGame(['A', 'B'])
    s = withResourceCard(s, 'p1', ALL_DRAWS)
    s = reducer(s, { type: 'mapping/revealAll' })
    s = forceNextCard(s, 18)
    s = reducer(s, { type: 'turn/rollDieWithValue', value: 1 })
    expect(s.bailiff).toEqual({ kind: 'held', by: 'p1' })
  })

  it('Card #14 Alliance: not allied → becomes allied', () => {
    let s = setupGame(['A', 'B'])
    s = withResourceCard(s, 'p1', ALL_DRAWS)
    s = reducer(s, { type: 'mapping/revealAll' })
    s = forceNextCard(s, 14)
    s = reducer(s, { type: 'turn/rollDieWithValue', value: 1 })
    expect(playerById(s, 'p1').inventory.allied).toBe(true)
  })

  it('Card #14 Alliance: already allied → +$50 bonus', () => {
    let s = setupGame(['A', 'B'])
    s = withResourceCard(s, 'p1', ALL_DRAWS)
    s = reducer(s, { type: 'mapping/revealAll' })
    s = { ...s, players: s.players.map((p) => (p.id === 'p1' ? { ...p, inventory: { ...p.inventory, allied: true } } : p)) }
    s = forceNextCard(s, 14)
    s = reducer(s, { type: 'turn/rollDieWithValue', value: 1 })
    expect(playerById(s, 'p1').inventory.dollars).toBeGreaterThanOrEqual(50)
  })

  it('Card #16 Draw Another chains into another card', () => {
    let s = setupGame(['A', 'B'])
    s = withResourceCard(s, 'p1', ALL_DRAWS)
    s = reducer(s, { type: 'mapping/revealAll' })
    // Stack: #16 on top, then #3 ($20) next.
    s = { ...s, deck: [16, 3, ...s.deck.filter((id) => id !== 16 && id !== 3)] }
    s = reducer(s, { type: 'turn/rollDieWithValue', value: 1 })
    expect(playerById(s, 'p1').inventory.dollars).toBeGreaterThanOrEqual(20) // drew #3 after #16
    expect(s.discard).toContain(16)
    expect(s.discard).toContain(3)
  })

  it('Card #2 "Get a Building" waives all prereqs and counts toward palace', () => {
    let s = setupGame(['A', 'B'])
    s = withResourceCard(s, 'p1', ALL_DRAWS)
    s = reducer(s, { type: 'mapping/revealAll' })
    s = forceNextCard(s, 2)
    s = reducer(s, { type: 'turn/rollDieWithValue', value: 1 })
    expect(playerById(s, 'p1').inventory.buildings).toBe(1)
  })
})

// ==================== Bug 1: pre-move Bailiff steal from drawn card ====================

describe('Bug 1: Pre-move Bailiff steal (card-acquired)', () => {
  function forceNextCard(s: GameState, cardId: number): GameState {
    const idx = s.deck.indexOf(cardId)
    if (idx === -1) {
      const allPlaces = [...s.deck, ...s.discard]
      if (!allPlaces.includes(cardId)) throw new Error(`card ${cardId} not in deck/discard`)
      return {
        ...s,
        deck: [cardId, ...s.deck.filter((id) => id !== cardId), ...s.discard.filter((id) => id !== cardId)],
        discard: [],
      }
    }
    return { ...s, deck: [cardId, ...s.deck.slice(0, idx), ...s.deck.slice(idx + 1)] }
  }

  function setupForPreMove(initialPosition = 1): GameState {
    // p1 draws card on every face; p2 gains dollars (no bricks/sticks/walls/roofs
    // from the roll, which would skew steal-target expectations).
    let s = setupGame(['A', 'B'])
    s = withResourceCard(s, 'p1', ALL_DRAWS)
    s = withResourceCard(s, 'p2', ALL_DOLLARS)
    s = reducer(s, { type: 'mapping/revealAll' })
    if (initialPosition !== 1) {
      s = {
        ...s,
        players: s.players.map((p) =>
          p.id === 'p1' ? { ...p, position: initialPosition } : p,
        ),
      }
    }
    return s
  }

  it('Drawing card #18 via a draw-card mapping pauses at pre-move-bailiff BEFORE movement', () => {
    let s = setupForPreMove()
    s = forceNextCard(s, 18)
    s = reducer(s, { type: 'turn/rollDieWithValue', value: 1 })
    expect(s.turn.phase).toBe('pre-move-bailiff')
    expect(playerById(s, 'p1').position).toBe(1)
    expect(s.bailiff).toEqual({ kind: 'held', by: 'p1' })
  })

  it('Pre-move steal fires BEFORE a #10 landing would strip the Bailiff', () => {
    let s = setupForPreMove(7)
    // Give p2 bricks to steal (not from the roll — they'd get $5 from ALL_DOLLARS).
    s = {
      ...s,
      players: s.players.map((p) =>
        p.id === 'p2'
          ? { ...p, inventory: { ...p.inventory, bricks: 20 } }
          : p,
      ),
    }
    s = forceNextCard(s, 18)
    s = reducer(s, { type: 'turn/rollDieWithValue', value: 3 })
    expect(s.turn.phase).toBe('pre-move-bailiff')
    s = reducer(s, { type: 'turn/bailiffStealPreMove', targetId: 'p2', item: 'bricks' })
    // Steal recorded: 5 bricks moved p2 → p1.
    expect(playerById(s, 'p1').inventory.bricks).toBe(5)
    expect(playerById(s, 'p2').inventory.bricks).toBe(15)
    expect(s.turn.bailiffStealUsedThisTurnSequence).toBe(true)
    // Movement completed: now at #10, in dungeon, Bailiff stripped by dungeon entry.
    expect(playerById(s, 'p1').position).toBe(25)
    expect(playerById(s, 'p1').dungeon.inDungeon).toBe(true)
    expect(s.bailiff).toEqual({ kind: 'middle' })
  })

  it('Pre-move skip clears acquiredBailiffThisTurn and continues with movement', () => {
    let s = setupForPreMove()
    s = forceNextCard(s, 18)
    s = reducer(s, { type: 'turn/rollDieWithValue', value: 1 })
    expect(s.turn.phase).toBe('pre-move-bailiff')
    s = reducer(s, { type: 'turn/bailiffStealPreMoveSkip' })
    expect(playerById(s, 'p1').position).toBe(2)
    expect(s.turn.acquiredBailiffThisTurn).toBe(false)
    expect(s.turn.phase).toBe('optional-actions')
  })

  it('Pre-move-stealing then landing on a Bailiff square is a no-op (once per sequence)', () => {
    let s = setupForPreMove(4)
    s = {
      ...s,
      players: s.players.map((p) =>
        p.id === 'p2'
          ? { ...p, inventory: { ...p.inventory, bricks: 20 } }
          : p,
      ),
    }
    s = forceNextCard(s, 18)
    s = reducer(s, { type: 'turn/rollDieWithValue', value: 1 })
    expect(s.turn.phase).toBe('pre-move-bailiff')
    s = reducer(s, { type: 'turn/bailiffStealPreMove', targetId: 'p2', item: 'bricks' })
    expect(playerById(s, 'p1').position).toBe(5)
    expect(s.bailiff).toEqual({ kind: 'held', by: 'p1' })
    expect(s.turn.acquiredBailiffThisTurn).toBe(false)
    expect(s.turn.phase).toBe('optional-actions')
  })

  it('endTurn is gated during pre-move-bailiff phase', () => {
    let s = setupForPreMove()
    s = forceNextCard(s, 18)
    s = reducer(s, { type: 'turn/rollDieWithValue', value: 1 })
    expect(s.turn.phase).toBe('pre-move-bailiff')
    const beforeId = s.currentPlayerId
    s = reducer(s, { type: 'turn/endTurn' })
    expect(s.currentPlayerId).toBe(beforeId)
    expect(s.turn.phase).toBe('pre-move-bailiff')
  })
})

// ==================== Multi-player draw order ====================

describe('Multi-player "draw a card" clockwise from current player', () => {
  it('draws in clockwise order starting with the current player', () => {
    let s = setupGame(['A', 'B', 'C'])
    s = withResourceCard(s, 'p1', ALL_DRAWS)
    s = withResourceCard(s, 'p2', ALL_DRAWS)
    s = withResourceCard(s, 'p3', ALL_DRAWS)
    s = reducer(s, { type: 'mapping/revealAll' })
    // Stack deck so first draw gets card 1 ($50), second gets 3 ($20), third gets 6 ($75).
    s = { ...s, deck: [1, 3, 6, ...s.deck.filter((id) => ![1, 3, 6].includes(id))] }
    s = reducer(s, { type: 'turn/rollDieWithValue', value: 1 })
    // p1's mapping maps to draw → p1 drew first (got $50). Then p2 drew ($20). Then p3 drew ($75).
    expect(playerById(s, 'p1').inventory.dollars).toBeGreaterThanOrEqual(50)
    expect(playerById(s, 'p2').inventory.dollars).toBe(20)
    expect(playerById(s, 'p3').inventory.dollars).toBe(75)
  })
})

// ==================== Workers, WHC, passives ====================

describe('Passives', () => {
  it("Worker output fires at the owner's next turn-start, not on the acquisition turn", () => {
    let s = setupGame(['A', 'B'])
    // Give p1 cash for a Worker.
    s = {
      ...s,
      players: s.players.map((p) =>
        p.id === 'p1' ? { ...p, inventory: { ...p.inventory, dollars: 60 } } : p,
      ),
    }
    // Buy the Worker during p1's turn.
    s = reducer(s, { type: 'turn/buy', item: 'worker', quantity: 1 })
    let p1 = playerById(s, 'p1')
    expect(p1.inventory.workers).toBe(1)
    // Acquisition turn: no passive benefit.
    expect(p1.inventory.walls).toBe(0)
    expect(p1.inventory.roofs).toBe(0)
    // End p1's turn — passives no longer fire at endTurn.
    s = reducer(s, { type: 'turn/endTurn' })
    expect(s.currentPlayerId).toBe('p2')
    p1 = playerById(s, 'p1')
    expect(p1.inventory.walls).toBe(0) // still 0
    expect(p1.inventory.roofs).toBe(0)
    // End p2's turn → back to p1's turn-start. NOW the passive fires.
    s = reducer(s, { type: 'turn/endTurn' })
    expect(s.currentPlayerId).toBe('p1')
    p1 = playerById(s, 'p1')
    expect(p1.inventory.walls).toBe(1) // default wall-roof: 1 wall + 1 roof per worker
    expect(p1.inventory.roofs).toBe(1)
  })

  it('Worker respects the wall-wall preference at turn-start', () => {
    let s = setupGame(['A', 'B'])
    s = {
      ...s,
      players: s.players.map((p) =>
        p.id === 'p1'
          ? { ...p, inventory: { ...p.inventory, workers: 2 }, workerPreference: 'wall-wall' }
          : p,
      ),
    }
    // Workers were injected mid-turn (after p1's turn-start passive already fired with 0 workers).
    // Cycle back to p1's turn-start.
    s = reducer(s, { type: 'turn/endTurn' })
    s = reducer(s, { type: 'turn/endTurn' })
    expect(s.currentPlayerId).toBe('p1')
    const p1 = playerById(s, 'p1')
    expect(p1.inventory.walls).toBe(4) // 2 workers × 2 walls each
    expect(p1.inventory.roofs).toBe(0)
  })

  it("WHC pays +$15 at the owner's next turn-start, not on the conversion turn", () => {
    let s = setupGame(['A', 'B'])
    // 4 Cleaners + 1 Building + 1 Room + $20 → buying the 5th Cleaner auto-converts into 1 WHC.
    s = {
      ...s,
      players: s.players.map((p) =>
        p.id === 'p1'
          ? {
              ...p,
              inventory: {
                ...p.inventory,
                buildings: 1,
                rooms: 1,
                cleaners: 4,
                dollars: 20,
              },
            }
          : p,
      ),
    }
    s = reducer(s, { type: 'turn/buy', item: 'cleaner', quantity: 1 })
    let p1 = playerById(s, 'p1')
    expect(p1.inventory.wholeHouseCleaners).toBe(1)
    expect(p1.inventory.cleaners).toBe(0)
    // Conversion turn: $20 spent on the cleaner, no +$15 yet.
    expect(p1.inventory.dollars).toBe(0)
    // End p1's turn — no late-firing income.
    s = reducer(s, { type: 'turn/endTurn' })
    p1 = playerById(s, 'p1')
    expect(p1.inventory.dollars).toBe(0)
    // End p2's turn → back to p1's turn-start. +$15 fires.
    s = reducer(s, { type: 'turn/endTurn' })
    expect(s.currentPlayerId).toBe('p1')
    expect(playerById(s, 'p1').inventory.dollars).toBe(15)
  })

  it("Passives do not fire on other players' turns", () => {
    let s = setupGame(['A', 'B'])
    // Give p1 workers + WHCs *after* p1's initial turn-start passive has already fired.
    s = {
      ...s,
      players: s.players.map((p) =>
        p.id === 'p1'
          ? {
              ...p,
              inventory: { ...p.inventory, workers: 2, wholeHouseCleaners: 1 },
            }
          : p,
      ),
    }
    const wallsBefore = playerById(s, 'p1').inventory.walls
    const roofsBefore = playerById(s, 'p1').inventory.roofs
    const dollarsBefore = playerById(s, 'p1').inventory.dollars
    // End p1's turn → p2's turn-start. p1's passives must not fire on p2's turn.
    s = reducer(s, { type: 'turn/endTurn' })
    expect(s.currentPlayerId).toBe('p2')
    const p1 = playerById(s, 'p1')
    expect(p1.inventory.walls).toBe(wallsBefore)
    expect(p1.inventory.roofs).toBe(roofsBefore)
    expect(p1.inventory.dollars).toBe(dollarsBefore)
    // p2 has no passives either.
    const p2 = playerById(s, 'p2')
    expect(p2.inventory.walls).toBe(0)
    expect(p2.inventory.dollars).toBe(0)
  })

  it('Imprisoned player skips passives at their own turn-start', () => {
    let s = setupGame(['A', 'B'])
    s = {
      ...s,
      players: s.players.map((p) =>
        p.id === 'p1'
          ? {
              ...p,
              position: 25,
              dungeon: { inDungeon: true, turnsServed: 1 },
              inventory: { ...p.inventory, workers: 1, wholeHouseCleaners: 2 },
            }
          : p,
      ),
    }
    // Cycle p1 → p2 → p1. p1's turn-start fires firePlayerStartPassives,
    // which must skip because p1 is still in the dungeon.
    s = reducer(s, { type: 'turn/endTurn' })
    expect(s.currentPlayerId).toBe('p2')
    s = reducer(s, { type: 'turn/endTurn' })
    expect(s.currentPlayerId).toBe('p1')
    const p1 = playerById(s, 'p1')
    expect(p1.dungeon.inDungeon).toBe(true)
    expect(p1.inventory.walls).toBe(0) // Worker suspended
    expect(p1.inventory.roofs).toBe(0)
    expect(p1.inventory.dollars).toBe(0) // WHC suspended
  })

  it('5 Cleaners + Building auto-convert into 1 WHC (consumes the 5)', () => {
    let s = setupGame(['A', 'B'])
    s = {
      ...s,
      players: s.players.map((p) =>
        p.id === 'p1'
          ? {
              ...p,
              inventory: {
                ...p.inventory,
                rooms: 1,
                dollars: 1000,
                buildings: 1,
                cleaners: 4,
              },
            }
          : p,
      ),
    }
    s = reducer(s, { type: 'turn/buy', item: 'cleaner', quantity: 1 })
    const p1 = playerById(s, 'p1')
    expect(p1.inventory.cleaners).toBe(0)
    expect(p1.inventory.wholeHouseCleaners).toBe(1)
  })

  it('10 Cleaners + Building → 2 WHCs (+ 0 cleaners remaining)', () => {
    let s = setupGame(['A', 'B'])
    s = {
      ...s,
      players: s.players.map((p) =>
        p.id === 'p1'
          ? {
              ...p,
              inventory: { ...p.inventory, buildings: 1, cleaners: 10 },
            }
          : p,
      ),
    }
    // Trigger convert by building a Building (requires 3 rooms + staff). Simpler: buy a Cleaner and convert check fires.
    s = {
      ...s,
      players: s.players.map((p) =>
        p.id === 'p1' ? { ...p, inventory: { ...p.inventory, dollars: 50, rooms: 1 } } : p,
      ),
    }
    // Buying one more cleaner (=11) triggers convert. Round down: 11 / 5 = 2 groups → 2 WHCs, 1 cleaner left.
    s = reducer(s, { type: 'turn/buy', item: 'cleaner', quantity: 1 })
    const p1 = playerById(s, 'p1')
    expect(p1.inventory.wholeHouseCleaners).toBe(2)
    expect(p1.inventory.cleaners).toBe(1)
  })

  it('conversion requires at least 1 Building', () => {
    let s = setupGame(['A', 'B'])
    s = {
      ...s,
      players: s.players.map((p) =>
        p.id === 'p1'
          ? { ...p, inventory: { ...p.inventory, rooms: 1, dollars: 100, cleaners: 4 } }
          : p,
      ),
    }
    s = reducer(s, { type: 'turn/buy', item: 'cleaner', quantity: 1 })
    const p1 = playerById(s, 'p1')
    expect(p1.inventory.cleaners).toBe(5) // no conversion
    expect(p1.inventory.wholeHouseCleaners).toBe(0)
  })
})

// ==================== End-game turn counting (Bug 2 hardening) ====================

describe('End-game turn counting (Bug 2 hardening)', () => {
  function givePalaceMaterials(s: GameState, playerId: string): GameState {
    return {
      ...s,
      players: s.players.map((p) =>
        p.id === playerId
          ? { ...p, inventory: { ...p.inventory, threeStoryBuildings: 3 } }
          : p,
      ),
    }
  }

  function bumpTurnsTaken(s: GameState, playerId: string, by: number): GameState {
    return {
      ...s,
      players: s.players.map((p) =>
        p.id === playerId ? { ...p, baseTurnsTaken: p.baseTurnsTaken + by } : p,
      ),
    }
  }

  it('2-player: p1 builds palace on turn 3 → game ends exactly after p2 turn 3', () => {
    let s = setupGame(['A', 'B'])
    s = bumpTurnsTaken(s, 'p1', 2) // p1 has 2 base turns done; this is their 3rd
    s = bumpTurnsTaken(s, 'p2', 2)
    s = givePalaceMaterials(s, 'p1')
    s = reducer(s, { type: 'turn/build', item: 'palace', count: 1 })
    expect(s.palaceBuiltBy).toBe('p1')
    s = reducer(s, { type: 'turn/endTurn' })
    expect(s.phase).not.toBe('game-over')
    expect(s.currentPlayerId).toBe('p2')
    s = reducer(s, { type: 'turn/endTurn' })
    expect(s.phase).toBe('game-over')
    expect(playerById(s, 'p1').baseTurnsTaken).toBe(3)
    expect(playerById(s, 'p2').baseTurnsTaken).toBe(3)
  })

  it('2-player: p2 builds palace on turn 3 → game ends immediately after p2 endTurn', () => {
    let s = setupGame(['A', 'B'])
    s = bumpTurnsTaken(s, 'p1', 3) // p1 finished 3 turns
    s = bumpTurnsTaken(s, 'p2', 2) // p2 has 2; this is their 3rd
    s = { ...s, currentPlayerId: 'p2' } // swap to p2's turn
    s = givePalaceMaterials(s, 'p2')
    s = reducer(s, { type: 'turn/build', item: 'palace', count: 1 })
    expect(s.palaceBuiltBy).toBe('p2')
    s = reducer(s, { type: 'turn/endTurn' })
    expect(s.phase).toBe('game-over')
    expect(playerById(s, 'p1').baseTurnsTaken).toBe(3)
    expect(playerById(s, 'p2').baseTurnsTaken).toBe(3)
  })

  it('2-player: p1 builds palace on turn 1 → game ends after p2 turn 1', () => {
    let s = setupGame(['A', 'B'])
    s = givePalaceMaterials(s, 'p1')
    s = reducer(s, { type: 'turn/build', item: 'palace', count: 1 })
    s = reducer(s, { type: 'turn/endTurn' })
    expect(s.phase).not.toBe('game-over')
    s = reducer(s, { type: 'turn/endTurn' })
    expect(s.phase).toBe('game-over')
    expect(playerById(s, 'p1').baseTurnsTaken).toBe(1)
    expect(playerById(s, 'p2').baseTurnsTaken).toBe(1)
  })

  it('2-player: #24 sequence during palace-build round counts as exactly one base turn', () => {
    // Regression test for the user-reported "too many turns" bug (pre-9048e5c,
    // #24 extra turns double-incremented baseTurnsTaken, inflating the trigger).
    let s = setupGame(['A', 'B'])
    s = bumpTurnsTaken(s, 'p1', 1)
    s = bumpTurnsTaken(s, 'p2', 1)
    // Put p1 on #23 so roll 1 lands on #24, then re-roll lands in #25–#30.
    s = {
      ...s,
      players: s.players.map((p) =>
        p.id === 'p1' ? { ...p, position: 23, inventory: { ...p.inventory, threeStoryBuildings: 3 } } : p,
      ),
    }
    s = reducer(s, { type: 'turn/rollDieWithValue', value: 1 }) // → #24, auto-end
    expect(s.turn.phase).toBe('turn-start') // bounced back for the re-roll
    expect(playerById(s, 'p1').baseTurnsTaken).toBe(1) // NOT incremented yet
    s = reducer(s, { type: 'turn/rollDieWithValue', value: 3 }) // → #27 (Bailiff square)
    // Any post-roll bailiff/duel paths handled gracefully.
    if (s.turn.phase === 'post-roll-bailiff') {
      s = reducer(s, { type: 'turn/bailiffStealPostRollSkip' })
    }
    expect(s.turn.phase).toBe('optional-actions')
    // Now build the palace during optional-actions.
    s = reducer(s, { type: 'turn/build', item: 'palace', count: 1 })
    expect(s.palaceBuiltBy).toBe('p1')
    // p1.baseTurnsTaken at build is STILL 1 (not 2) → palaceTriggerTurnIndex=1 → triggerCount=2.
    expect(s.palaceTriggerTurnIndex).toBe(1)
    s = reducer(s, { type: 'turn/endTurn' })
    expect(playerById(s, 'p1').baseTurnsTaken).toBe(2) // single increment for whole sequence
    expect(s.phase).not.toBe('game-over')
    s = reducer(s, { type: 'turn/endTurn' }) // p2's final turn
    expect(s.phase).toBe('game-over')
    expect(playerById(s, 'p2').baseTurnsTaken).toBe(2)
  })
})

// ==================== Win condition + tiebreaker ====================

describe('Win condition + tiebreaker', () => {
  it('palace triggers end-game after equal turns', () => {
    let s = setupGame(['A', 'B', 'C'])
    s = {
      ...s,
      players: s.players.map((p) =>
        p.id === 'p1'
          ? { ...p, inventory: { ...p.inventory, threeStoryBuildings: 3 } }
          : p,
      ),
    }
    s = reducer(s, { type: 'turn/build', item: 'palace', count: 1 })
    expect(s.palaceBuiltBy).toBe('p1')
    s = reducer(s, { type: 'turn/endTurn' })
    expect(s.phase).not.toBe('game-over') // B and C still owe a turn
    s = reducer(s, { type: 'turn/endTurn' })
    s = reducer(s, { type: 'turn/endTurn' })
    expect(s.phase).toBe('game-over')
  })

  it('tiebreaker ranks by points → staff → cash', () => {
    const a = { id: 'A', name: 'Amy', points: 100, staff: 2, cash: 5 }
    const b = { id: 'B', name: 'Ben', points: 100, staff: 2, cash: 10 } // more cash
    const c = { id: 'C', name: 'Cam', points: 100, staff: 5, cash: 0 } // more staff
    const d = { id: 'D', name: 'Dan', points: 200, staff: 0, cash: 0 } // highest points
    const ranked = rankPlayers([a, b, c, d])
    expect(ranked[0]!.id).toBe('D')
    expect(ranked[1]!.id).toBe('C')
    expect(ranked[2]!.id).toBe('B')
    expect(ranked[3]!.id).toBe('A')
  })

  it('totalPoints sums scoring items correctly', () => {
    const inv = {
      bricks: 0, sticks: 0, dollars: 0,
      walls: 0, roofs: 0, rooms: 2, buildings: 1, threeStoryBuildings: 1, palaces: 1,
      workers: 3, servers: 2, chefs: 1, cleaners: 4, wholeHouseCleaners: 1, queen: true, knight: false,
      allied: false, pardonCards: 0,
    }
    // 2*5 + 1*20 + 1*75 + 1*300 + 3*5 + 2*5 + 1*10 + 4*5 + 1*50 + 200 = 10+20+75+300+15+10+10+20+50+200 = 710
    expect(totalPoints(inv)).toBe(710)
  })

  it('staffWeight uses Queen=10, WHC=5, others=1', () => {
    const inv = {
      bricks: 0, sticks: 0, dollars: 0,
      walls: 0, roofs: 0, rooms: 0, buildings: 0, threeStoryBuildings: 0, palaces: 0,
      workers: 1, servers: 1, chefs: 1, cleaners: 1, wholeHouseCleaners: 1, queen: true, knight: false,
      allied: false, pardonCards: 0,
    }
    expect(staffWeight(inv)).toBe(1 + 1 + 1 + 1 + 5 + 10)
  })

  it('Worker now scores 5 pts (revised 2026-04-19)', () => {
    const inv = {
      bricks: 0, sticks: 0, dollars: 0,
      walls: 0, roofs: 0, rooms: 0, buildings: 0, threeStoryBuildings: 0, palaces: 0,
      workers: 2, servers: 0, chefs: 0, cleaners: 0, wholeHouseCleaners: 0, queen: false, knight: false,
      allied: false, pardonCards: 0,
    }
    expect(totalPoints(inv)).toBe(10)
  })

  it('Building now scores 20 pts (revised 2026-04-19)', () => {
    const inv = {
      bricks: 0, sticks: 0, dollars: 0,
      walls: 0, roofs: 0, rooms: 0, buildings: 3, threeStoryBuildings: 0, palaces: 0,
      workers: 0, servers: 0, chefs: 0, cleaners: 0, wholeHouseCleaners: 0, queen: false, knight: false,
      allied: false, pardonCards: 0,
    }
    expect(totalPoints(inv)).toBe(60)
  })

  it('3-Story now scores 75 pts (revised 2026-04-19)', () => {
    const inv = {
      bricks: 0, sticks: 0, dollars: 0,
      walls: 0, roofs: 0, rooms: 0, buildings: 0, threeStoryBuildings: 2, palaces: 0,
      workers: 0, servers: 0, chefs: 0, cleaners: 0, wholeHouseCleaners: 0, queen: false, knight: false,
      allied: false, pardonCards: 0,
    }
    expect(totalPoints(inv)).toBe(150)
  })

  it('Palace now scores 300 pts (revised 2026-04-19)', () => {
    const inv = {
      bricks: 0, sticks: 0, dollars: 0,
      walls: 0, roofs: 0, rooms: 0, buildings: 0, threeStoryBuildings: 0, palaces: 1,
      workers: 0, servers: 0, chefs: 0, cleaners: 0, wholeHouseCleaners: 0, queen: false, knight: false,
      allied: false, pardonCards: 0,
    }
    expect(totalPoints(inv)).toBe(300)
  })
})

// ==================== Removal + system ====================

describe('System', () => {
  it('reset returns to initial state', () => {
    let s = setupGame(['A', 'B'])
    s = reducer(s, { type: 'system/reset' })
    expect(s.phase).toBe('setup')
    expect(s.players.length).toBe(0)
  })

  it('removePlayer mid-game returns the Bailiff to the middle', () => {
    let s = setupGame(['A', 'B', 'C'])
    s = { ...s, bailiff: { kind: 'held', by: 'p2' } }
    s = reducer(s, { type: 'system/removePlayer', id: 'p2' })
    expect(s.bailiff).toEqual({ kind: 'middle' })
    expect(playerById(s, 'p2').removed).toBe(true)
  })

  it('removing the active player advances the turn to the next non-removed player', () => {
    let s = setupGame(['A', 'B', 'C'])
    // p1 is active after setupGame.
    expect(s.currentPlayerId).toBe('p1')
    s = reducer(s, { type: 'system/removePlayer', id: 'p1' })
    expect(playerById(s, 'p1').removed).toBe(true)
    expect(s.currentPlayerId).toBe('p2')
  })

  it('removing down to 1 non-removed player auto-triggers game-over', () => {
    let s = setupGame(['A', 'B', 'C'])
    s = reducer(s, { type: 'system/removePlayer', id: 'p2' })
    expect(s.phase).not.toBe('game-over') // 2 left
    s = reducer(s, { type: 'system/removePlayer', id: 'p3' })
    expect(s.phase).toBe('game-over') // only p1 remains
  })

  it('removing down to 0 players also triggers game-over', () => {
    let s = setupGame(['A', 'B'])
    s = reducer(s, { type: 'system/removePlayer', id: 'p1' })
    // p1 removed → only p2 left → game-over (1 remaining).
    expect(s.phase).toBe('game-over')
    // Further removal doesn't crash.
    s = reducer(s, { type: 'system/removePlayer', id: 'p2' })
    expect(s.phase).toBe('game-over')
  })
})

// ==================== Server-owned PRNG + createReadyState ====================
// New coverage for the multiplayer port: all randomness is seeded and lives on
// GameState.rngState, so games are reproducible and survive save/resume; and the
// createReadyState bootstrap parks a roster at the hidden initial-mapping pick.

describe('Server-owned PRNG (rngState)', () => {
  const { rollDieFrom, tryReduce } = PerfectPalaceEngine;

  it('same seed → identical deck and rngState; different seed → different deck', () => {
    const a = initialState(12345)
    const b = initialState(12345)
    const c = initialState(67890)
    expect(a.deck).toEqual(b.deck)
    expect(a.rngState).toBe(b.rngState)
    // Overwhelmingly likely to differ; assert as a guard against a stuck PRNG.
    expect(JSON.stringify(a.deck)).not.toBe(JSON.stringify(c.deck))
  })

  it('rollDieFrom is deterministic for a seed and stays in 1..6', () => {
    let s = initialState(42)
    const rolls: number[] = []
    for (let i = 0; i < 20; i++) {
      const { value, rngState } = rollDieFrom(s)
      expect(value >= 1 && value <= 6).toBe(true)
      rolls.push(value)
      s = { ...s, rngState }
    }
    // Replaying from the same seed reproduces the exact sequence.
    let s2 = initialState(42)
    const rolls2: number[] = []
    for (let i = 0; i < 20; i++) {
      const { value, rngState } = rollDieFrom(s2)
      rolls2.push(value)
      s2 = { ...s2, rngState }
    }
    expect(rolls).toEqual(rolls2)
  })

  it('turn/rollDie draws from the seeded state (deterministic, no client value)', () => {
    const play = () => {
      let s = setupGame(['A', 'B'])
      s = reducer(s, { type: 'turn/rollDie' })
      return s.turn.lastRoll
    }
    // setupGame uses a fixed seed, so the server roll is reproducible.
    expect(play()).toBe(play())
    expect((play() ?? 0) >= 1 && (play() ?? 0) <= 6).toBe(true)
  })

  it('mid-game reshuffle uses the state PRNG (deterministic order)', () => {
    // Empty the deck so the next draw must reshuffle the discard, and pin the
    // active player to always draw. Two states with the same rngState + discard
    // must reshuffle to the same order.
    const build = () => {
      let s = setupGame(['A', 'B'])
      s = withResourceCard(s, 'p1', ALL_DRAWS)
      s = { ...s, deck: [], discard: [3, 1, 5, 11, 6], rngState: 0xabc123 }
      return reducer(s, { type: 'turn/rollDieWithValue', value: 1 })
    }
    const r1 = build()
    const r2 = build()
    expect(r1.deck).toEqual(r2.deck)
    expect(r1.discard).toEqual(r2.discard)
  })

  it('tryReduce reports ok:true on accepted actions and ok:false (no throw) on bad input', () => {
    const s = setupGame(['A', 'B'])
    const good = tryReduce(s, { type: 'turn/rollDie' })
    expect(good.ok).toBe(true)
    // Unknown player id would THROW in the raw reducer; tryReduce catches it.
    const forged = tryReduce(s, { type: 'system/removePlayer', id: 'p99' })
    expect(forged.ok).toBe(false)
    // A legal-shape but no-op action: declining a Bailiff steal returns the same
    // state reference, which tryReduce reports as ok:false (not applied).
    const noop = tryReduce(s, { type: 'turn/bailiffStealSkip' })
    expect(noop.ok).toBe(false)
  })
})

describe('createReadyState bootstrap', () => {
  const { createReadyState } = PerfectPalaceEngine;

  it('parks a roster at the hidden initial-mapping pick with p1..pN in seat order', () => {
    const s = createReadyState([{ name: 'Alice' }, { name: 'Bob' }, { name: 'Cara' }], 777)
    expect(s.phase).toBe('initial-mapping')
    expect(s.players.length).toBe(3)
    expect(s.players.map((p) => p.id)).toEqual(['p1', 'p2', 'p3'])
    expect(s.players.map((p) => p.name)).toEqual(['Alice', 'Bob', 'Cara'])
    // colorIndex assigned 0..N-1 in seat order.
    expect(s.players.map((p) => p.colorIndex)).toEqual([0, 1, 2])
    // turn order is a permutation of all ids with a single, unambiguous leader.
    expect([...s.turnOrder].sort()).toEqual(['p1', 'p2', 'p3'])
    expect(s.currentPlayerId).toBe(s.turnOrder[0])
    // No initial-roll residue and the deck is intact (18 cards).
    expect(s.players.every((p) => p.initialRoll === undefined)).toBe(true)
    expect(s.deck.length).toBe(18)
  })

  it('is deterministic for a given seed (turn order reproducible)', () => {
    const a = createReadyState([{ name: 'A' }, { name: 'B' }, { name: 'C' }, { name: 'D' }], 2024)
    const b = createReadyState([{ name: 'A' }, { name: 'B' }, { name: 'C' }, { name: 'D' }], 2024)
    expect(a.turnOrder).toEqual(b.turnOrder)
    expect(a.deck).toEqual(b.deck)
  })

  it('always resolves a unique first seat (no top tie) across many seeds', () => {
    for (let seed = 1; seed <= 200; seed++) {
      const s = createReadyState([{ name: 'A' }, { name: 'B' }, { name: 'C' }], seed)
      expect(s.phase).toBe('initial-mapping')
      expect(s.turnOrder.length).toBe(3)
    }
  })
})

// ==================== Bot policy ====================
// Validates the pure "plays a real game" policy under the same conditions the
// room provides: the policy emits one action per call, the harness injects the
// seeded duel die and auto-reveals / auto-resolves exactly like the room.

describe('Bot policy', () => {
  const { chooseAction, createReadyState, tryReduce, rollDieFrom } = PerfectPalaceEngine;

  function awaiting(s: GameState): string[] {
    if (s.phase === 'game-over') return [];
    if (s.phase === 'initial-mapping') return s.players.filter((p) => !p.removed && !p.mappingLocked).map((p) => p.id);
    if (s.turn.phase === 'duel' && s.duel) return s.duel.contenders.filter((id) => s.duel!.rolls[id] == null);
    return s.currentPlayerId ? [s.currentPlayerId] : [];
  }

  // Mirror the room's autoAdvance: reveal when all locked, resolve a duel when
  // every contender has rolled (tie re-rounds clear rolls and re-await).
  function autoAdvance(s: GameState): GameState {
    for (let g = 0; g < 1000; g++) {
      if (s.phase === 'initial-mapping') {
        const active = s.players.filter((p) => !p.removed);
        if (active.length && active.every((p) => p.mappingLocked)) {
          const o = tryReduce(s, { type: 'mapping/revealAll' });
          if (o.ok) { s = o.state; continue; }
        }
        return s;
      }
      if (s.turn.phase === 'duel' && s.duel && s.duel.contenders.length &&
          s.duel.contenders.every((id) => s.duel!.rolls[id] != null)) {
        const o = tryReduce(s, { type: 'turn/duelResolve' });
        if (o.ok) { s = o.state; continue; }
      }
      return s;
    }
    return s;
  }

  // One policy action for the first awaiting seat, with the room's dice
  // injection + safety net (a rejected action falls back to ending the turn).
  function step(s: GameState): { state: GameState; rejected: boolean; stalled: boolean } {
    const seats = awaiting(s);
    if (!seats.length) return { state: s, rejected: false, stalled: true };
    const id = seats[0]!;
    let action = chooseAction(s, id);
    if (action.type === 'turn/duelRollForPlayer') {
      const r = rollDieFrom(s);
      s = { ...s, rngState: r.rngState };
      action = { ...action, value: r.value };
    }
    const out = tryReduce(s, action);
    if (out.ok) return { state: autoAdvance(out.state), rejected: false, stalled: false };
    const fb = tryReduce(s, { type: 'turn/endTurn' });
    return { state: fb.ok ? autoAdvance(fb.state) : s, rejected: true, stalled: !fb.ok };
  }

  function playBotGame(seed: number, players: number) {
    let s = createReadyState(Array.from({ length: players }, (_, i) => ({ name: `Bot${i + 1}` })), seed);
    let rejects = 0;
    let i = 0;
    for (; i < 25000 && s.phase !== 'game-over'; i++) {
      const r = step(s);
      assert.ok(!r.stalled, `policy stalled at action ${i} (${s.phase}/${s.turn.phase})`);
      if (r.rejected) rejects++;
      s = r.state;
    }
    return { state: s, rejects, actions: i };
  }

  it('drives a bot-only game to a palace win, emitting only legal actions', () => {
    for (const seed of [12345, 42, 7]) {
      const { state, rejects } = playBotGame(seed, 3);
      expect(state.phase).toBe('game-over'); // the bots play a complete game
      expect(state.palaceBuiltBy !== undefined).toBe(true);
      expect(rejects).toBe(0); // the policy never emits an illegal action
    }
  });

  it('finishes 2- and 6-player bot games without stalling', () => {
    expect(playBotGame(99, 2).state.phase).toBe('game-over');
    expect(playBotGame(2024, 6).state.phase).toBe('game-over');
  });

  it('builds the ladder greedily when flush with resources', () => {
    let s = createReadyState([{ name: 'A' }, { name: 'B' }], 3);
    while (s.phase === 'initial-mapping') s = step(s).state;
    // Drop the active player into optional-actions with plenty to build a wall.
    const cur = s.currentPlayerId!;
    s = {
      ...s,
      turn: { ...s.turn, phase: 'optional-actions' },
      players: s.players.map((p) => (p.id === cur ? { ...p, inventory: { ...p.inventory, bricks: 5, sticks: 5 } } : p)),
    };
    expect(chooseAction(s, cur).type).toBe('turn/build'); // builds rather than ending the turn
  });
});
