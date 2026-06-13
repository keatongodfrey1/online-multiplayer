// Game action types (discriminated union) — the reducer dispatches these.

import type { PlayerId, ResourceCard, DuelStake } from './types'

export type SetupAction =
  | { type: 'setup/addPlayer'; name: string }
  | { type: 'setup/removePlayer'; id: PlayerId }
  | { type: 'setup/renamePlayer'; id: PlayerId; name: string }
  | { type: 'setup/startInitialRoll' }

export type InitialRollAction =
  | { type: 'initialRoll/rollForPlayer'; id: PlayerId; value: number }
  | { type: 'initialRoll/finalize' } // once all players have rolled + order decided

export type MappingAction =
  | { type: 'mapping/setInitial'; id: PlayerId; card: ResourceCard }
  | { type: 'mapping/revealAll' } // transition to turn 1
  | { type: 'mapping/changeOneSlot'; id: PlayerId; slotIndex: number; option: number } // option = index into RESOURCE_OPTIONS

export type TurnAction =
  // Pre-roll Bailiff steal (optional) — step 1 of the turn sequence.
  | { type: 'turn/bailiffStealPreRoll'; targetId: PlayerId; item: 'wall' | 'roof' | 'bricks' | 'sticks' | 'dollars' }
  | { type: 'turn/bailiffStealSkip' }
  // Rolling.
  | { type: 'turn/rollDie' } // committed internally with a rng-produced value
  | { type: 'turn/rollDieWithValue'; value: number } // for testing
  // Movement and square effect are auto after distribute.
  // Square-effect branching decisions:
  | { type: 'turn/acceptAlliance' } // at #3 or #20 when not allied
  | { type: 'turn/declineAlliance' }
  | { type: 'turn/gift10Bricks' } // at #16
  | { type: 'turn/gift1Wall' } // at #16
  // Duel
  | { type: 'turn/duelSetStake'; stake: DuelStake }
  | { type: 'turn/duelRollForPlayer'; id: PlayerId; value: number }
  | { type: 'turn/duelResolve' } // settle pot
  // Pre-move Bailiff steal (only when the active player just acquired the Bailiff
  // via a card drawn during the roll's distribution, before movement).
  | { type: 'turn/bailiffStealPreMove'; targetId: PlayerId; item: 'wall' | 'roof' | 'bricks' | 'sticks' | 'dollars' }
  | { type: 'turn/bailiffStealPreMoveSkip' }
  // Post-roll Bailiff steal (only on acquisition-via-Bailiff-square turns).
  | { type: 'turn/bailiffStealPostRoll'; targetId: PlayerId; item: 'wall' | 'roof' | 'bricks' | 'sticks' | 'dollars' }
  | { type: 'turn/bailiffStealPostRollSkip' }
  // Fine payment (#7/#11/#28 insolvency dialog).
  | { type: 'turn/payFine'; bricks: number; sticks: number; walls: number; roofs: number }
  // Optional actions.
  | { type: 'turn/buy'; item: ShopItem; quantity?: number }
  | { type: 'turn/trade'; from: 'bricks' | 'sticks'; amount: number } // 2:1
  | { type: 'turn/traderWallsBuy'; batches: number } // at #8
  | { type: 'turn/traderBricksSell'; batches: number } // at #29
  | { type: 'turn/halfPriceCleanerBuy'; count: number } // at #14
  | { type: 'turn/build'; item: BuildItem; count: number }
  | { type: 'turn/setWorkerPreference'; preference: 'wall-roof' | 'wall-wall' }
  | { type: 'turn/endTurn' }
  | { type: 'turn/advancePhase' } // nudge phase from square-effect → duel/bailiff/optional-actions

export type DungeonAction =
  | { type: 'dungeon/redeemPardon' } // before rolling on a dungeon turn

export type SystemAction =
  | { type: 'system/removePlayer'; id: PlayerId }
  | { type: 'system/loadState'; state: unknown }
  | { type: 'system/reset' }

export type ShopItem = 'brick' | 'stick' | 'worker' | 'server' | 'chef' | 'cleaner' | 'queen' | 'knight'
export type BuildItem = 'wall' | 'roof' | 'room' | 'building' | 'threeStoryBuilding' | 'palace'

export type GameAction =
  | SetupAction
  | InitialRollAction
  | MappingAction
  | TurnAction
  | DungeonAction
  | SystemAction
