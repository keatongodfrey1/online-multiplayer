// Core game types for The Perfect Palace.
// Based on ~/The Perfect Palace/DESIGN.md. Keep in sync with the design doc.

export type PlayerId = string

// ---------- Resources (raw, mapped to die faces) ----------

export type ResourceOutcome =
  | { kind: 'sticks'; amount: number }
  | { kind: 'bricks'; amount: number }
  | { kind: 'dollars'; amount: number }
  | { kind: 'draw-card' }

// The six options players can place on their resource card slots (one per die face 1-6).
export const RESOURCE_OPTIONS: readonly ResourceOutcome[] = [
  { kind: 'sticks', amount: 5 },
  { kind: 'bricks', amount: 5 },
  { kind: 'bricks', amount: 10 },
  { kind: 'dollars', amount: 5 },
  { kind: 'dollars', amount: 10 },
  { kind: 'draw-card' },
] as const

// Resource card: a 6-length tuple. Index i is the outcome for rolling (i+1).
export type ResourceCard = readonly [
  ResourceOutcome,
  ResourceOutcome,
  ResourceOutcome,
  ResourceOutcome,
  ResourceOutcome,
  ResourceOutcome,
]

// ---------- Player inventory ----------

export interface PlayerInventory {
  // Raw resources
  bricks: number
  sticks: number
  dollars: number

  // Built items (components and finished)
  walls: number
  roofs: number
  rooms: number
  buildings: number
  threeStoryBuildings: number
  palaces: number

  // Staff and special
  workers: number
  servers: number
  chefs: number
  cleaners: number
  wholeHouseCleaners: number
  queen: boolean // max 1 per player, permanent
  knight: boolean // max 1 per player, permanent — grants Bailiff immunity (revised 2026-04-19)

  // Kingdom Alliance status
  allied: boolean // permanent once acquired

  // Cards in hand (only Royal Pardon is persistent)
  pardonCards: number // each escapes the dungeon; max 1 in circulation but stored as count for safety
}

export const EMPTY_INVENTORY: PlayerInventory = {
  bricks: 0,
  sticks: 0,
  dollars: 0,
  walls: 0,
  roofs: 0,
  rooms: 0,
  buildings: 0,
  threeStoryBuildings: 0,
  palaces: 0,
  workers: 0,
  servers: 0,
  chefs: 0,
  cleaners: 0,
  wholeHouseCleaners: 0,
  queen: false,
  knight: false,
  allied: false,
  pardonCards: 0,
}

// ---------- Dungeon state ----------

export interface DungeonState {
  inDungeon: boolean
  turnsServed: number // 0, 1, 2, or 3 (released on 3)
}

export const NOT_IN_DUNGEON: DungeonState = { inDungeon: false, turnsServed: 0 }

// ---------- Player ----------

export interface Player {
  id: PlayerId
  name: string
  colorIndex: number // for UI — index into a palette
  position: number // square number 1-30
  inventory: PlayerInventory
  dungeon: DungeonState
  resourceCard: ResourceCard
  // Game flow tracking
  baseTurnsTaken: number // for end-game "equal turns" accounting
  removed: boolean // opt-in mid-game removal
  mappingChangesAvailable: number // unspent lap credits for 1-slot changes (earned by passing Start)
  workerPreference: 'wall-roof' | 'wall-wall' // how the Worker spends its output each turn
  // Setup-phase temp data
  initialRoll?: number // set during the initial-roll phase, cleared in finalize
  mappingLocked?: boolean // set during initial-mapping when player confirms their picks
}

// ---------- Bailiff ----------

// The Bailiff is always somewhere. Either held by a player or in the middle.
export type BailiffLocation = { kind: 'middle' } | { kind: 'held'; by: PlayerId }

// ---------- Cards ----------

export type CardEffect =
  | { kind: 'gain-dollars'; amount: number }
  | { kind: 'gain-bricks'; amount: number }
  | { kind: 'gain-sticks'; amount: number }
  | { kind: 'gain-bricks-and-sticks'; bricks: number; sticks: number }
  | { kind: 'get-building' } // free, waives prereqs
  | { kind: 'get-room' } // free
  | { kind: 'get-server' } // free, waives prereq
  | { kind: 'get-cleaner' } // free, waives prereq
  | { kind: 'get-chef' } // free, waives prereq
  | { kind: 'alliance-or-bonus' } // if not allied → become allied; if allied → +$50
  | { kind: 'draw-another' } // chain
  | { kind: 'royal-pardon' } // persistent; held in hand
  | { kind: 'get-bailiff' } // transfer the Bailiff

export interface CardDef {
  id: number // 1-18, for reference
  name: string
  effect: CardEffect
}

// ---------- Squares ----------

export type SquareEffect =
  // Corners
  | { kind: 'start' } // $10 + change 1 resource slot (fires on pass OR land)
  | { kind: 'royal-court' } // go to dungeon (everyone)
  | { kind: 'bricks-or-wall' } // choose 10 bricks OR 1 wall
  | { kind: 'dungeon-just-passing' } // no effect when landed on normally
  // Resource gain
  | { kind: 'gain-resources'; bricks?: number; sticks?: number; dollars?: number }
  | { kind: 'gain-room' } // free room on every landing
  // Alliance offers
  | { kind: 'alliance-offer'; cost: { bricks: number; sticks: number } }
  // Tribute (war)
  | { kind: 'invasion'; cost: number } // $100 — skipped if allied; insolvency = forfeit all cash + dungeon
  // Money loss (default insolvency)
  | { kind: 'lose-money'; amount: number }
  // Bailiff
  | { kind: 'get-bailiff' }
  // Card draws
  | { kind: 'draw-cards'; count: number }
  // Trader squares
  | { kind: 'trader-walls' } // $10 for 3 walls, unlimited while on square
  | { kind: 'trader-bricks' } // 10 bricks → $15, multiples of 10, bricks only
  | { kind: 'half-price-cleaner' } // $10/Cleaner, waives room prereq while on square
  // Free staff/item
  | { kind: 'get-server' } // waives room prereq
  | { kind: 'get-building' } // waives all prereqs; full building
  // Special
  | { kind: 'roll-again' } // full extra turn (extras invisible to end-game tally)
  | { kind: 'fortune-teller'; count: number } // draw N cards

export interface SquareDef {
  number: number // 1-30
  side: 'corner' | 'long-a' | 'short-a' | 'long-b' | 'short-b'
  label: string // short display name
  flavor?: string // longer in-game flavor text
  effect: SquareEffect
}

// ---------- Turn / phase state ----------

export type Phase =
  | 'setup' // pre-game configuration
  | 'initial-roll' // each player rolls for turn order
  | 'initial-mapping' // each player secretly picks their resource card
  | 'mapping-reveal' // all mappings shown before turn 1
  | 'turn-start' // pre-roll phase: optional Bailiff steal
  | 'rolling' // rolling animation / result
  | 'distributing' // handing out resources to all players per mapping
  | 'moving' // token advancing
  | 'pre-move-bailiff' // post-distribute, pre-move: steal opportunity for a Bailiff acquired via a drawn card
  | 'square-effect' // landing square effect
  | 'duel' // same-square duel resolution
  | 'post-roll-bailiff' // post-roll steal on Bailiff-acquisition turn (via Bailiff square)
  | 'optional-actions' // buy/trade/build
  | 'game-over'

export interface TurnState {
  phase: Phase
  activePlayerIndex: number // index into state.players
  // After rolling:
  lastRoll?: number // 1-6
  // After a Roll Again (#24), queue extra full turns for the SAME player
  extraTurnsQueued: number
  // Did the Bailiff-holder already use their steal this turn sequence?
  bailiffStealUsedThisTurnSequence: boolean
  // Did the active player acquire the Bailiff THIS turn? (Enables post-roll steal.)
  acquiredBailiffThisTurn: boolean
  // Did the active player enter the dungeon during THIS turn? If so, optional actions
  // (buy/trade/build) remain allowed for the rest of this turn even though
  // `player.dungeon.inDungeon` is now true. Cleared on endTurn.
  enteredDungeonThisTurn: boolean
  // Set by the #24 "Roll Again" square effect. When true, the remaining turn-flow
  // transitions that would normally land on 'optional-actions' instead call endTurn,
  // so the roller jumps directly to their re-roll without an extra shop/build/trade
  // phase for the #24 landing. Cleared on endTurn (both next-player + extra-turn paths).
  skipOptionalActions: boolean
  // Set by #8/#29 trader use. Restricts each trader square to one use per turn
  // sequence to prevent the #29 money loop (trade bricks → cash → buy bricks → trade).
  // Cleared on endTurn.
  traderUsedThisTurn: boolean
  // Set when a money fine (#7/#28 tribute or #11 lose-money) exceeds the player's
  // cash on hand. Holds the remaining amount owed after cash has been auto-deducted;
  // player chooses items to forfeit via the FinePaymentPrompt. Cleared by payFine.
  pendingFine?: { amount: number; source: 'invasion' | 'lose-money' }
}

// ---------- Duel state ----------

export interface DuelStake {
  dollars: number
  bricks: number
  sticks: number
  walls: number
  roofs: number
  rooms: number
}

export const EMPTY_STAKE: DuelStake = {
  dollars: 0,
  bricks: 0,
  sticks: 0,
  walls: 0,
  roofs: 0,
  rooms: 0,
}

export interface DuelState {
  squareNumber: number
  participants: PlayerId[] // original list of pot contributors (fixed at duel start)
  contenders: PlayerId[] // players still in the running for the win (shrinks on ties)
  stake: DuelStake
  rolls: Partial<Record<PlayerId, number>>
  winner?: PlayerId
}

// ---------- Game state ----------

export interface GameState {
  phase: Phase
  players: Player[]
  turnOrder: PlayerId[] // established by initial-roll; clockwise thereafter
  currentPlayerId: PlayerId | null
  turn: TurnState
  duel?: DuelState
  bailiff: BailiffLocation
  deck: number[] // card ids 1-18 in draw pile order
  discard: number[] // card ids 1-18
  log: string[] // chronological human-readable log for the UI
  winner?: PlayerId // set when tallying finishes
  palaceBuiltBy?: PlayerId // first to build a palace (triggers end-game)
  palaceTriggerTurnIndex?: number // baseTurnsTaken of the trigger for equal-turns accounting
}

// ---------- Utility types ----------

export interface TooltipableAction {
  label: string
  enabled: boolean
  reason?: string // shown as tooltip when disabled
}
