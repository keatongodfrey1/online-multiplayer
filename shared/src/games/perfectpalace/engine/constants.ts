// Economic constants: shop prices, construction recipes, point values, etc.
// Source of truth: DESIGN.md Sections 6-8.

// ---------- Shop prices ----------
export const PRICE = {
  brick: 1,
  stick: 1,
  worker: 50,
  server: 15,
  chef: 30,
  cleaner: 20,
  queen: 300,
  knight: 75,
} as const

// ---------- Construction recipes ----------
export const RECIPE = {
  wall: { bricks: 5 },
  roof: { sticks: 5 },
  room: { walls: 4, roofs: 1 },
  building: { rooms: 3 },
  threeStoryBuilding: { buildings: 3 },
  palace: { threeStoryBuildings: 3 },
} as const

// ---------- Point values ----------
export const POINTS = {
  room: 5,
  building: 20,
  threeStoryBuilding: 75,
  palace: 300,
  server: 5,
  chef: 10,
  cleaner: 5,
  wholeHouseCleaner: 50,
  queen: 200,
  worker: 5,
  knight: 5,
} as const

// ---------- Tiebreaker: staff weights ----------
export const STAFF_WEIGHT = {
  worker: 1,
  server: 1,
  chef: 1,
  cleaner: 1,
  wholeHouseCleaner: 5,
  queen: 10,
  knight: 1,
} as const

// ---------- Bailiff steal targets ----------
export const BAILIFF_STEAL_AMOUNTS = {
  wall: 1,
  roof: 1,
  bricks: 5,
  sticks: 5,
  dollars: 5,
} as const

// ---------- Duel ----------
export const DUEL_MIN_STAKE = {
  dollars: 5,
  bricks: 5,
  sticks: 5,
} as const

// Item stake equivalents: value in both bricks/sticks and dollars (flexible).
export const DUEL_ITEM_EQUIVALENT = {
  wall: { bricks: 5, dollars: 5 },
  roof: { sticks: 5, dollars: 5 },
  room: { bricks: 20, sticks: 5, dollars: 25 },
} as const

// ---------- Special squares ----------
export const TRADER_WALLS_DEAL = { cost: 10, walls: 3 } // $10 per 3 walls on #8
export const TRADER_BRICKS_DEAL = { bricks: 10, dollars: 15 } // 10 bricks → $15 on #29 (batch)
export const HALF_PRICE_CLEANER_COST = 10 // $10/Cleaner on #14

// ---------- Kingdom Alliance ----------
export const KINGDOM_CARD_BONUS = 50 // $50 for already-allied players who draw Card #14

// ---------- Bricks↔Sticks trade ----------
export const BRICK_STICK_TRADE_RATIO = 2 // 2:1 — e.g., 10 bricks → 5 sticks
export const BRICK_STICK_TRADE_MIN_BATCH = 10 // minimum + step: only trade in batches of 10

// ---------- Jail/Dungeon ----------
export const DUNGEON_MAX_TURNS = 3 // release on 3rd turn

// ---------- Player ----------
export const MIN_PLAYERS = 2
export const MAX_PLAYERS = 6
