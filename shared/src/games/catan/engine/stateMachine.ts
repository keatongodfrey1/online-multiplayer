/**
 * stateMachine.ts — Turn flow for the Catan engine.
 *
 * Ported from catan-clone/catan-engine/src/stateMachine.ts (see ./index.ts for
 * the port notes). Functional additions for this repo, both opt-in:
 *   - numbers: "spiral" lays the official A-R token sequence in a ring spiral
 *     from a seeded-random coastal corner (the rulebook's variable setup).
 *   - startingPlayer rotates the setup snake + first turn to a chosen seat
 *     (the room rolls it randomly, standing in for "highest roll starts").
 *
 * Pattern: a pure reducer  reduce(geo, state, action, opts?) -> newState.
 * It clones the incoming state, validates the action against the current
 * phase, applies it, and returns the new state. Centralizing every mutation
 * keeps the bank, piece supply, and award holders consistent and makes the
 * action log a complete, replayable history.
 *
 * Implemented: setup snake-draft; roll + production (bank-scarcity aware); the
 * full 7/Knight robber sub-flow (discard -> move -> steal), including the
 * "Knight before the roll returns to preRoll" nuance; building; all five dev
 * cards; maritime trade; full domestic (player-to-player) trade; Longest Road
 * & Largest Army; victory checking; 3-6 players with the special building
 * phase; per-player redacted views; serialization and deterministic replay.
 */

import {
  type DevCardType,
  type GameState,
  type Phase,
  type PlayerId,
  type PlayerState,
  type Port,
  type Resource,
  type ResourceBag,
  type DevCard,
  type Terrain,
  COSTS,
  HAND_LIMIT_BEFORE_DISCARD,
  LARGEST_ARMY_MIN,
  PIECE_LIMITS,
  RESOURCES,
  TERRAIN_RESOURCE,
  WINNING_VP,
  emptyBag,
} from "./types.js";
import type { BoardState, PendingTrade } from "./types.js";
import {
  type BoardGeometry,
  type CubeCoord,
  type EdgeId,
  type HexId,
  type VertexId,
  NUMBER_MULTISET,
  SPIRAL_NUMBER_SEQUENCE,
  TERRAIN_BAG,
  STANDARD_HEX_COORDS,
  bestTradeRatio,
  coastalEdgesOrdered,
  computeLongestRoadLength,
  getValidCities,
  getValidInitialSettlements,
  getValidRoads,
  getValidSettlements,
  portAccess,
  spiralHexOrder,
} from "./geometry.js";

// ----------------------------------------------------------------------------
// Deterministic PRNG (mulberry32) so games/tests are reproducible from a seed.
// ----------------------------------------------------------------------------

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
function shuffle<T>(arr: T[], rng: () => number): T[] {
  const a = arr.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    const tmp = a[i]!;
    a[i] = a[j]!;
    a[j] = tmp;
  }
  return a;
}

// ----------------------------------------------------------------------------
// Board content generation (terrain + numbers + ports + robber)
// ----------------------------------------------------------------------------

/**
 * Harbour layout. Ports sit on coastal edges with a clean repeating 2-2-3
 * empty-edge gap rhythm, which guarantees no two harbours touch and spreads
 * them evenly (four 3:1 generic + one 2:1 of each resource). This is a fair,
 * fixed layout; it is NOT claimed to reproduce a specific retail board's exact
 * per-edge harbour positions (those are printed on the physical frame).
 * `variablePorts` shuffles the nine chips while keeping the positions fixed.
 */
const PORT_GAP_STEPS = [3, 3, 4]; // step sizes -> empty-edge gaps of 2,2,3
const CANONICAL_PORT_TYPES: Port["type"][] = [
  "generic", "grain", "ore", "generic", "wool", "generic", "brick", "lumber", "generic",
];

const PLAYER_COLORS = ["red", "blue", "white", "orange", "green", "brown"];

const STANDARD_DEV_DECK: Record<DevCardType, number> = {
  knight: 14,
  victoryPoint: 5,
  roadBuilding: 2,
  yearOfPlenty: 2,
  monopoly: 2,
};

function buildDevDeck(comp: Record<DevCardType, number>, rng: () => number): DevCardType[] {
  const deck: DevCardType[] = [];
  (Object.keys(comp) as DevCardType[]).forEach((type) => {
    for (let i = 0; i < comp[type]; i++) deck.push(type);
  });
  return shuffle(deck, rng);
}

function assignNumbers(
  geo: BoardGeometry,
  desertHexes: Set<HexId>,
  rng: () => number,
  mode: "balanced" | "random" | "spiral",
  numberBag?: number[],
): Map<HexId, number> {
  const targets = geo.hexes.map((h) => h.id).filter((id) => !desertHexes.has(id));

  if (mode === "spiral") {
    // The official variable setup: lay the canonical A-R sequence in a ring
    // spiral from a random corner, skipping the desert. Never places 6 next to
    // 8 (the sequence is constructed that way).
    const seq = numberBag ?? [...SPIRAL_NUMBER_SEQUENCE];
    const order = spiralHexOrder(geo, Math.floor(rng() * 6));
    const map = new Map<HexId, number>();
    let i = 0;
    for (const hid of order) {
      if (desertHexes.has(hid)) continue;
      map.set(hid, seq[i % seq.length]!);
      i++;
    }
    return map;
  }

  // Scale the token multiset to the number of numbered hexes (standard = 18).
  const baseTokens = numberBag ?? [...NUMBER_MULTISET];
  const tokens: number[] = [];
  for (let i = 0; i < targets.length; i++) tokens.push(baseTokens[i % baseTokens.length]!);
  const isRed = (n: number) => n === 6 || n === 8;

  for (let attempt = 0; attempt < 1000; attempt++) {
    const nums = shuffle(tokens, rng);
    const map = new Map<HexId, number>();
    targets.forEach((hid, i) => map.set(hid, nums[i]!));
    if (mode === "random") return map;
    let ok = true;
    for (const h of geo.hexes) {
      const n = map.get(h.id);
      if (n === undefined || !isRed(n)) continue;
      if (h.neighbors.some((nb) => { const m = map.get(nb); return m !== undefined && isRed(m); })) { ok = false; break; }
    }
    if (ok) return map;
  }
  const nums = shuffle(tokens, rng);
  const map = new Map<HexId, number>();
  targets.forEach((hid, i) => map.set(hid, nums[i]!));
  return map;
}

function canonicalPortEdgeIndices(coastCount: number, count: number): number[] {
  const idx: number[] = [];
  let pos = 0;
  for (let i = 0; i < count && i < coastCount; i++) {
    idx.push(pos % coastCount);
    pos += PORT_GAP_STEPS[i % PORT_GAP_STEPS.length]!;
  }
  return idx;
}

function assignPorts(geo: BoardGeometry, rng: () => number, variable: boolean): Port[] {
  const ordered = coastalEdgesOrdered(geo);
  const typeCount = CANONICAL_PORT_TYPES.length;
  const edgeIdxs = canonicalPortEdgeIndices(ordered.length, typeCount);
  const types = variable ? shuffle(CANONICAL_PORT_TYPES, rng) : CANONICAL_PORT_TYPES.slice();
  return edgeIdxs.map((ei, i) => ({ type: types[i]!, vertices: [...geo.edges[ordered[ei]!]!.vertices] }));
}

export interface NewGameOptions {
  numPlayers: number; // 3-6
  seed?: number;
  /** Number-token placement: "spiral" = the official A-R sequence laid in a
   *  ring spiral from a random corner; "balanced" = random with no two red
   *  (6/8) tokens adjacent; "random" = fully random. Default "balanced". */
  numbers?: "balanced" | "random" | "spiral";
  /** Which seat takes the first turn (and leads the setup snake). Defaults to
   *  seat 0; the caller should roll this randomly to honour the official
   *  "highest roll starts" rule. */
  startingPlayer?: PlayerId;
  colors?: string[];
  variablePorts?: boolean; // shuffle the 9 harbour chips (positions stay fixed)
  /** default: true when numPlayers >= 5 (the 5-6 player extension rule). */
  specialBuildPhase?: boolean;
  /** custom board hex coordinates (defaults to the standard 19-hex board). */
  hexCoords?: CubeCoord[];
  /** terrain distribution. Defaults to the standard 19-hex bag. For a custom
   *  board you should supply one sized to your hex count; otherwise the default
   *  is cycled to fit, which is only correct for the standard board (e.g. a
   *  30-hex board cycled from the 19-bag would contain two deserts). */
  terrainBag?: Terrain[];
  /** number-token multiset, same caveat as terrainBag. */
  numberBag?: number[];
  bankPerResource?: number; // default 19
  devDeck?: Record<DevCardType, number>; // default standard 25-card deck
}

export function createInitialGameState(geo: BoardGeometry, opts: NewGameOptions): GameState {
  const numPlayers = opts.numPlayers;
  if (numPlayers < 3 || numPlayers > 6) throw new Error("supported player counts are 3-6");
  const start = opts.startingPlayer ?? 0;
  if (!Number.isInteger(start) || start < 0 || start >= numPlayers) throw new Error("startingPlayer out of range");
  const seed = opts.seed ?? ((Math.random() * 2 ** 31) >>> 0);
  const rng = mulberry32(seed);

  // Terrain: scale the bag to the number of hexes (standard board = 19).
  const baseTerrain = opts.terrainBag ?? [...TERRAIN_BAG];
  const terrainPool: Terrain[] = [];
  for (let i = 0; i < geo.hexes.length; i++) terrainPool.push(baseTerrain[i % baseTerrain.length]!);
  const terrain = shuffle(terrainPool, rng);
  const hexes = geo.hexes.map((_, i) => ({ terrain: terrain[i]!, numberToken: null as number | null }));
  const desertHexes = new Set<HexId>(hexes.map((h, i) => (h.terrain === "desert" ? i : -1)).filter((i) => i >= 0));
  const firstDesert = [...desertHexes][0] ?? 0;

  const numbers = assignNumbers(geo, desertHexes, rng, opts.numbers ?? "balanced", opts.numberBag);
  hexes.forEach((h, id) => { h.numberToken = desertHexes.has(id) ? null : numbers.get(id) ?? null; });

  const ports = assignPorts(geo, rng, opts.variablePorts ?? false);
  const vertices = geo.vertices.map(() => ({ building: null, portId: null as number | null }));
  ports.forEach((port, pid) => port.vertices.forEach((v) => (vertices[v]!.portId = pid)));

  const board: BoardState = {
    hexes,
    vertices,
    edges: geo.edges.map(() => ({ road: null })),
    ports,
    robberHex: firstDesert,
  };

  const colors = opts.colors ?? PLAYER_COLORS;
  const players: PlayerState[] = Array.from({ length: numPlayers }, (_, id) => ({
    id,
    color: colors[id % colors.length]!,
    hand: emptyBag(),
    devCards: [],
    knightsPlayed: 0,
    piecesLeft: { ...PIECE_LIMITS },
  }));

  // Seat `start` leads; the snake runs start, start+1, ... then back.
  const forward: PlayerId[] = [];
  for (let i = 0; i < numPlayers; i++) forward.push((start + i) % numPlayers);
  const setupSequence = [...forward, ...forward.slice().reverse()];
  const bankAmt = opts.bankPerResource ?? 19;

  return {
    phase: "setupSettlement",
    players,
    currentPlayer: setupSequence[0]!,
    board,
    bank: { lumber: bankAmt, brick: bankAmt, wool: bankAmt, grain: bankAmt, ore: bankAmt },
    devDeck: buildDevDeck(opts.devDeck ?? STANDARD_DEV_DECK, rng),
    dice: null,
    longestRoadHolder: null,
    largestArmyHolder: null,
    winner: null,
    setupSequence,
    setupStep: 0,
    lastSettlementVertex: null,
    freeRoads: 0,
    devCardPlayedThisTurn: false,
    pendingDiscards: {},
    robberReturnPhase: "main",
    pendingTrade: null,
    rngState: (rng() * 2 ** 31) >>> 0,
    specialBuildEnabled: opts.specialBuildPhase ?? numPlayers >= 5,
    specialBuildQueue: [],
    specialBuilder: null,
    log: [],
  };
}

// ----------------------------------------------------------------------------
// Actions
// ----------------------------------------------------------------------------

export type Action =
  | { type: "placeSetupSettlement"; vertex: VertexId }
  | { type: "placeSetupRoad"; edge: EdgeId }
  | { type: "rollDice"; dice?: [number, number] }
  | { type: "discard"; player: PlayerId; cards: Partial<ResourceBag> }
  | { type: "moveRobber"; hex: HexId }
  | { type: "steal"; target: PlayerId | null }
  | { type: "buildRoad"; edge: EdgeId }
  | { type: "buildSettlement"; vertex: VertexId }
  | { type: "buildCity"; vertex: VertexId }
  | { type: "buyDevCard" }
  | { type: "playKnight" }
  | { type: "playRoadBuilding" }
  | { type: "playYearOfPlenty"; resources: [Resource, Resource] }
  | { type: "playMonopoly"; resource: Resource }
  | { type: "maritimeTrade"; give: Resource; receive: Resource }
  | { type: "proposeDomesticTrade"; give: Partial<ResourceBag>; receive: Partial<ResourceBag>; to?: PlayerId[] }
  | { type: "respondDomesticTrade"; player: PlayerId; accept: boolean }
  | { type: "confirmDomesticTrade"; partner: PlayerId }
  | { type: "cancelDomesticTrade" }
  | { type: "endSpecialBuild" }
  | { type: "endTurn" };

export interface ReduceOptions {
  /** When true, a client-supplied `dice` value on rollDice is honoured (used by
   *  tests). In production leave this false so dice come only from the seeded
   *  server-side RNG and cannot be injected by a client. */
  trustClientRandomness?: boolean;
}

// ----------------------------------------------------------------------------
// Fast deep clone (purpose-built; ~an order of magnitude faster than
// structuredClone on this shape, which matters for bot search / replay).
// ----------------------------------------------------------------------------

function cloneBag(b: ResourceBag): ResourceBag {
  return { lumber: b.lumber, brick: b.brick, wool: b.wool, grain: b.grain, ore: b.ore };
}

export function cloneGameState(s: GameState): GameState {
  return {
    phase: s.phase,
    currentPlayer: s.currentPlayer,
    winner: s.winner,
    longestRoadHolder: s.longestRoadHolder,
    largestArmyHolder: s.largestArmyHolder,
    dice: s.dice ? [s.dice[0], s.dice[1]] : null,
    bank: cloneBag(s.bank),
    devDeck: s.devDeck.slice(),
    players: s.players.map((p) => ({
      id: p.id,
      color: p.color,
      knightsPlayed: p.knightsPlayed,
      hand: cloneBag(p.hand),
      devCards: p.devCards.map((c) => ({ type: c.type, boughtThisTurn: c.boughtThisTurn, played: c.played })),
      piecesLeft: { roads: p.piecesLeft.roads, settlements: p.piecesLeft.settlements, cities: p.piecesLeft.cities },
    })),
    board: {
      robberHex: s.board.robberHex,
      hexes: s.board.hexes.map((h) => ({ terrain: h.terrain, numberToken: h.numberToken })),
      vertices: s.board.vertices.map((v) => ({
        building: v.building ? { owner: v.building.owner, type: v.building.type } : null,
        portId: v.portId,
      })),
      edges: s.board.edges.map((e) => ({ road: e.road ? { owner: e.road.owner } : null })),
      ports: s.board.ports.map((pt) => ({ type: pt.type, vertices: pt.vertices.slice() })),
    },
    setupSequence: s.setupSequence.slice(),
    setupStep: s.setupStep,
    lastSettlementVertex: s.lastSettlementVertex,
    freeRoads: s.freeRoads,
    devCardPlayedThisTurn: s.devCardPlayedThisTurn,
    pendingDiscards: { ...s.pendingDiscards },
    robberReturnPhase: s.robberReturnPhase,
    pendingTrade: s.pendingTrade
      ? {
          proposer: s.pendingTrade.proposer,
          give: { ...s.pendingTrade.give },
          receive: { ...s.pendingTrade.receive },
          candidates: s.pendingTrade.candidates.slice(),
          acceptances: s.pendingTrade.acceptances.slice(),
        }
      : null,
    rngState: s.rngState,
    specialBuildEnabled: s.specialBuildEnabled,
    specialBuildQueue: s.specialBuildQueue.slice(),
    specialBuilder: s.specialBuilder,
    log: s.log.slice(), // events are append-only and never mutated -> shallow copy is safe
  };
}

// ----------------------------------------------------------------------------
// Helpers operating on a (cloned) GameState
// ----------------------------------------------------------------------------

function advanceRng(state: GameState): number {
  const r = mulberry32(state.rngState);
  const v = r();
  state.rngState = (r() * 2 ** 31) >>> 0;
  return v;
}
function handCount(p: PlayerState): number {
  return RESOURCES.reduce((s, r) => s + p.hand[r], 0);
}
function bagTotal(b: Partial<ResourceBag>): number {
  return RESOURCES.reduce((s, r) => s + (b[r] ?? 0), 0);
}
function canAfford(p: PlayerState, cost: Partial<ResourceBag>): boolean {
  return (Object.keys(cost) as Resource[]).every((r) => p.hand[r] >= (cost[r] ?? 0));
}
function pay(state: GameState, p: PlayerState, cost: Partial<ResourceBag>): void {
  (Object.keys(cost) as Resource[]).forEach((r) => {
    const amt = cost[r] ?? 0;
    p.hand[r] -= amt;
    state.bank[r] += amt;
  });
}
function moveBag(from: PlayerState, to: PlayerState, bag: Partial<ResourceBag>): void {
  RESOURCES.forEach((r) => {
    const a = bag[r] ?? 0;
    from.hand[r] -= a;
    to.hand[r] += a;
  });
}
/** The player whose action this is: the special builder during a special build
 *  window, otherwise the current player. */
function actingId(state: GameState): PlayerId {
  return state.phase === "specialBuild" && state.specialBuilder !== null
    ? state.specialBuilder
    : state.currentPlayer;
}
function require(cond: boolean, msg: string): asserts cond {
  if (!cond) throw new Error(msg);
}
function requireBuildPhase(state: GameState): void {
  require(state.phase === "main" || state.phase === "specialBuild", "you can only build now during your build phase");
}

// ---- Production with bank-scarcity resolution ------------------------------

function produceResources(state: GameState, geo: BoardGeometry, roll: number): void {
  const demand: Record<Resource, Map<PlayerId, number>> = {
    lumber: new Map(), brick: new Map(), wool: new Map(), grain: new Map(), ore: new Map(),
  };
  for (const hex of geo.hexes) {
    const hs = state.board.hexes[hex.id]!;
    if (hs.numberToken !== roll) continue;
    if (state.board.robberHex === hex.id) continue;
    const res = TERRAIN_RESOURCE[hs.terrain];
    if (!res) continue;
    for (const v of hex.vertices) {
      const b = state.board.vertices[v]!.building;
      if (!b) continue;
      const gain = b.type === "city" ? 2 : 1;
      demand[res].set(b.owner, (demand[res].get(b.owner) ?? 0) + gain);
    }
  }
  for (const res of RESOURCES) {
    const map = demand[res];
    if (map.size === 0) continue;
    const total = [...map.values()].reduce((a, b) => a + b, 0);
    if (total <= state.bank[res]) {
      map.forEach((amt, pid) => { state.players[pid]!.hand[res] += amt; state.bank[res] -= amt; });
    } else if (map.size === 1) {
      const [pid, amt] = [...map.entries()][0]!;
      const give = Math.min(amt, state.bank[res]);
      state.players[pid]!.hand[res] += give;
      state.bank[res] -= give;
    }
    // else: 2+ claimants and not enough for all -> nobody gets this resource.
  }
}

// ---- Achievement bookkeeping -----------------------------------------------

/**
 * Longest Road, per the official rule:
 *  - Needs a road (trail) of >= 5. Awarded to the first to reach it.
 *  - Transfers only when another player is STRICTLY longer than the holder.
 *  - If a break leaves the holder tied for longest, the holder keeps it
 *    (no one is strictly longer).
 *  - If a break drops the holder below the max and the max is tied among
 *    others (or the holder falls below 5), the card is set aside (null).
 * Because transfer requires *strictly* exceeding and ties are set aside, this
 * needs no build-event ordering: the only inputs are the current lengths and
 * who currently holds the card.
 */
function updateLongestRoad(state: GameState, geo: BoardGeometry): void {
  const lengths = state.players.map((p) => computeLongestRoadLength(geo, state.board, p.id));
  const max = Math.max(0, ...lengths);
  if (max < 5) { state.longestRoadHolder = null; return; }
  const leaders = state.players.filter((p) => lengths[p.id] === max).map((p) => p.id);
  if (leaders.length === 1) {
    state.longestRoadHolder = leaders[0]!;
  } else if (state.longestRoadHolder !== null && lengths[state.longestRoadHolder] === max) {
    // tie at the top including the holder -> holder keeps it
  } else {
    state.longestRoadHolder = null; // tie among non-holders -> set aside
  }
}

function updateLargestArmyAfterKnight(state: GameState, actor: PlayerId): void {
  const k = state.players[actor]!.knightsPlayed;
  if (k < LARGEST_ARMY_MIN) return;
  const holder = state.largestArmyHolder;
  if (holder === null || k > state.players[holder]!.knightsPlayed) state.largestArmyHolder = actor;
}

// ---- Victory ---------------------------------------------------------------

export function victoryPoints(state: GameState, player: PlayerId): number {
  let vp = 0;
  for (const vs of state.board.vertices) {
    if (vs.building?.owner === player) vp += vs.building.type === "city" ? 2 : 1;
  }
  if (state.longestRoadHolder === player) vp += 2;
  if (state.largestArmyHolder === player) vp += 2;
  vp += state.players[player]!.devCards.filter((c) => c.type === "victoryPoint").length;
  return vp;
}

function checkWin(state: GameState): void {
  const actor = actingId(state);
  if (victoryPoints(state, actor) >= WINNING_VP) {
    state.winner = actor;
    state.phase = "gameOver";
  }
}

// ---- Robber sub-flow -------------------------------------------------------

export function getStealTargets(state: GameState, geo: BoardGeometry): PlayerId[] {
  const hex = geo.hexes[state.board.robberHex]!;
  const targets = new Set<PlayerId>();
  for (const v of hex.vertices) {
    const b = state.board.vertices[v]!.building;
    if (b && b.owner !== state.currentPlayer && handCount(state.players[b.owner]!) > 0) targets.add(b.owner);
  }
  return [...targets];
}

function finishRobber(state: GameState): void {
  state.phase = state.robberReturnPhase;
}

// ---- Turn boundaries -------------------------------------------------------

function startTurn(state: GameState, player: PlayerId): void {
  state.currentPlayer = player;
  state.phase = "preRoll";
  state.dice = null;
  state.freeRoads = 0;
  state.devCardPlayedThisTurn = false;
  state.pendingTrade = null;
  state.specialBuilder = null;
  state.specialBuildQueue = [];
  state.players[player]!.devCards.forEach((c) => (c.boughtThisTurn = false));
  // A player can cross 10 VP on an opponent's turn (Longest Road being
  // transferred when the previous holder's road is cut). They win at the
  // start of their own turn — only here, never on someone else's turn.
  checkWin(state);
}

function endOfTurnTransition(state: GameState): void {
  state.pendingTrade = null;
  const n = state.players.length;
  if (state.specialBuildEnabled) {
    const ender = state.currentPlayer;
    const queue: PlayerId[] = [];
    for (let i = 1; i < n; i++) queue.push((ender + i) % n);
    state.specialBuildQueue = queue;
    state.specialBuilder = queue[0]!;
    state.phase = "specialBuild";
    state.dice = null;
    state.freeRoads = 0;
    state.devCardPlayedThisTurn = false;
  } else {
    startTurn(state, (state.currentPlayer + 1) % n);
  }
}

// ----------------------------------------------------------------------------
// The reducer
// ----------------------------------------------------------------------------

export function reduce(geo: BoardGeometry, prev: GameState, action: Action, opts: ReduceOptions = {}): GameState {
  if (prev.phase === "gameOver") throw new Error("game is over");
  const state: GameState = cloneGameState(prev);
  state.log.push({ type: action.type, player: actingId(state), detail: action });
  const me = state.players[actingId(state)]!;

  switch (action.type) {
    // ---- Setup ----
    case "placeSetupSettlement": {
      require(state.phase === "setupSettlement", "not in setupSettlement phase");
      require(getValidInitialSettlements(geo, state.board).includes(action.vertex), "illegal initial settlement (distance rule)");
      state.board.vertices[action.vertex]!.building = { owner: me.id, type: "settlement" };
      me.piecesLeft.settlements--;
      state.lastSettlementVertex = action.vertex;
      const isSecondRound = state.setupStep >= state.players.length;
      if (isSecondRound) {
        for (const hid of geo.vertices[action.vertex]!.hexes) {
          const res = TERRAIN_RESOURCE[state.board.hexes[hid]!.terrain];
          if (res && state.bank[res] > 0) { me.hand[res]++; state.bank[res]--; }
        }
      }
      state.phase = "setupRoad";
      return state;
    }

    case "placeSetupRoad": {
      require(state.phase === "setupRoad", "not in setupRoad phase");
      require(state.lastSettlementVertex !== null, "no settlement to attach to");
      require(
        getValidRoads(geo, state.board, me.id, { setupVertex: state.lastSettlementVertex }).includes(action.edge),
        "setup road must touch the settlement just placed",
      );
      state.board.edges[action.edge]!.road = { owner: me.id };
      me.piecesLeft.roads--;
      state.setupStep++;
      state.lastSettlementVertex = null;
      if (state.setupStep >= state.setupSequence.length) {
        updateLongestRoad(state, geo);
        const first = state.setupSequence[0]!; // the seat that led the snake rolls first
        state.setupSequence = [];
        startTurn(state, first);
      } else {
        startTurn(state, state.setupSequence[state.setupStep]!);
        state.phase = "setupSettlement";
      }
      return state;
    }

    // ---- Roll ----
    case "rollDice": {
      require(state.phase === "preRoll", "can only roll at the start of your turn");
      const scripted = action.dice && opts.trustClientRandomness;
      const d1 = scripted ? action.dice![0] : 1 + Math.floor(advanceRng(state) * 6);
      const d2 = scripted ? action.dice![1] : 1 + Math.floor(advanceRng(state) * 6);
      state.dice = [d1, d2];
      const sum = d1 + d2;
      if (sum === 7) {
        state.robberReturnPhase = "main";
        state.pendingDiscards = {};
        for (const p of state.players) {
          const c = handCount(p);
          if (c > HAND_LIMIT_BEFORE_DISCARD) state.pendingDiscards[p.id] = Math.floor(c / 2);
        }
        state.phase = Object.keys(state.pendingDiscards).length > 0 ? "discard" : "moveRobber";
      } else {
        produceResources(state, geo, sum);
        state.phase = "main";
      }
      return state;
    }

    case "discard": {
      require(state.phase === "discard", "no discard pending");
      const owed = state.pendingDiscards[action.player];
      require(owed !== undefined && owed > 0, "this player owes no discard");
      const p = state.players[action.player]!;
      const cards = action.cards;
      require(bagTotal(cards) === owed, `must discard exactly ${owed} cards`);
      require(canAfford(p, cards), "cannot discard cards you do not have");
      (Object.keys(cards) as Resource[]).forEach((r) => { const a = cards[r] ?? 0; p.hand[r] -= a; state.bank[r] += a; });
      delete state.pendingDiscards[action.player];
      if (Object.keys(state.pendingDiscards).length === 0) state.phase = "moveRobber";
      return state;
    }

    case "moveRobber": {
      require(state.phase === "moveRobber", "not time to move the robber");
      require(action.hex !== state.board.robberHex, "robber must move to a different hex");
      require(action.hex >= 0 && action.hex < geo.hexes.length, "no such hex");
      state.board.robberHex = action.hex;
      const targets = getStealTargets(state, geo);
      if (targets.length === 0) finishRobber(state);
      else state.phase = "steal";
      return state;
    }

    case "steal": {
      require(state.phase === "steal", "not time to steal");
      const targets = getStealTargets(state, geo);
      if (targets.length === 0) { finishRobber(state); return state; }
      require(action.target !== null && targets.includes(action.target), "invalid steal target");
      const victim = state.players[action.target]!;
      const pool: Resource[] = [];
      RESOURCES.forEach((r) => { for (let i = 0; i < victim.hand[r]; i++) pool.push(r); });
      const picked = pool[Math.floor(advanceRng(state) * pool.length)]!;
      victim.hand[picked]--;
      me.hand[picked]++;
      finishRobber(state);
      return state;
    }

    // ---- Build (allowed in main and during the special building phase) ----
    case "buildRoad": {
      require(state.phase === "main" || state.phase === "specialBuild" || state.freeRoads > 0, "cannot build now");
      require(me.piecesLeft.roads > 0, "no road pieces left");
      require(getValidRoads(geo, state.board, me.id).includes(action.edge), "illegal road placement");
      if (state.freeRoads > 0) state.freeRoads--;
      else { require(canAfford(me, COSTS.road), "cannot afford a road"); pay(state, me, COSTS.road); }
      state.board.edges[action.edge]!.road = { owner: me.id };
      me.piecesLeft.roads--;
      updateLongestRoad(state, geo);
      checkWin(state);
      return state;
    }

    case "buildSettlement": {
      requireBuildPhase(state);
      require(me.piecesLeft.settlements > 0, "no settlement pieces left");
      require(canAfford(me, COSTS.settlement), "cannot afford a settlement");
      require(getValidSettlements(geo, state.board, me.id).includes(action.vertex), "illegal settlement placement");
      pay(state, me, COSTS.settlement);
      state.board.vertices[action.vertex]!.building = { owner: me.id, type: "settlement" };
      me.piecesLeft.settlements--;
      updateLongestRoad(state, geo); // may sever an opponent's road
      checkWin(state);
      return state;
    }

    case "buildCity": {
      requireBuildPhase(state);
      require(me.piecesLeft.cities > 0, "no city pieces left");
      require(canAfford(me, COSTS.city), "cannot afford a city");
      require(getValidCities(state.board, me.id).includes(action.vertex), "no settlement to upgrade here");
      pay(state, me, COSTS.city);
      state.board.vertices[action.vertex]!.building = { owner: me.id, type: "city" };
      me.piecesLeft.cities--;
      me.piecesLeft.settlements++; // returned to supply
      checkWin(state);
      return state;
    }

    case "buyDevCard": {
      requireBuildPhase(state);
      require(state.devDeck.length > 0, "the development deck is empty");
      require(canAfford(me, COSTS.devCard), "cannot afford a development card");
      pay(state, me, COSTS.devCard);
      const type = state.devDeck.shift()!;
      me.devCards.push({ type, boughtThisTurn: true, played: false });
      if (type === "victoryPoint") checkWin(state);
      return state;
    }

    // ---- Development cards (main / preRoll only; active player only) ----
    case "playKnight": {
      requirePlayableDev(state);
      const card = takeDev(me, "knight");
      card.played = true;
      state.devCardPlayedThisTurn = true;
      me.knightsPlayed++;
      updateLargestArmyAfterKnight(state, me.id);
      checkWin(state);
      if (state.phase !== "gameOver") { state.robberReturnPhase = state.phase; state.phase = "moveRobber"; }
      return state;
    }

    case "playRoadBuilding": {
      requirePlayableDev(state);
      const card = takeDev(me, "roadBuilding");
      card.played = true;
      state.devCardPlayedThisTurn = true;
      state.freeRoads += 2; // place as many as legal; any unused are forfeited at end of turn
      return state;
    }

    case "playYearOfPlenty": {
      requirePlayableDev(state);
      const card = takeDev(me, "yearOfPlenty");
      card.played = true;
      state.devCardPlayedThisTurn = true;
      // Take each requested resource the bank can supply; skip any the bank lacks.
      for (const r of action.resources) {
        if (state.bank[r] > 0) { me.hand[r]++; state.bank[r]--; }
      }
      return state;
    }

    case "playMonopoly": {
      requirePlayableDev(state);
      const card = takeDev(me, "monopoly");
      card.played = true;
      state.devCardPlayedThisTurn = true;
      let taken = 0;
      for (const p of state.players) {
        if (p.id === me.id) continue;
        taken += p.hand[action.resource];
        p.hand[action.resource] = 0;
      }
      me.hand[action.resource] += taken;
      return state;
    }

    // ---- Maritime trade ----
    case "maritimeTrade": {
      require(state.phase === "main", "can only trade during the main phase");
      require(action.give !== action.receive, "cannot trade a resource for itself");
      const ratio = bestTradeRatio(portAccess(state.board, me.id), action.give);
      require(me.hand[action.give] >= ratio, `need ${ratio} ${action.give}`);
      require(state.bank[action.receive] > 0, "bank is out of that resource");
      me.hand[action.give] -= ratio;
      state.bank[action.give] += ratio;
      me.hand[action.receive]++;
      state.bank[action.receive]--;
      return state;
    }

    // ---- Domestic (player-to-player) trade ----
    case "proposeDomesticTrade": {
      require(state.phase === "main", "you can only propose a trade on your own turn");
      require(bagTotal(action.give) > 0 && bagTotal(action.receive) > 0, "no gifts: both sides must include at least one card");
      require(canAfford(me, action.give), "you don't hold the resources you're offering");
      const candidates = (action.to && action.to.length ? action.to : state.players.map((p) => p.id)).filter((p) => p !== me.id);
      require(candidates.length > 0, "no trade partners specified");
      state.pendingTrade = { proposer: me.id, give: { ...action.give }, receive: { ...action.receive }, candidates, acceptances: [] };
      return state;
    }

    case "respondDomesticTrade": {
      require(state.phase === "main", "no active trading window");
      const t = state.pendingTrade;
      require(t !== null, "there is no open trade");
      require(action.player !== t.proposer && t.candidates.includes(action.player), "you are not a candidate for this trade");
      if (action.accept) { if (!t.acceptances.includes(action.player)) t.acceptances.push(action.player); }
      else t.acceptances = t.acceptances.filter((p) => p !== action.player);
      return state;
    }

    case "confirmDomesticTrade": {
      require(state.phase === "main", "no active trading window");
      const t = state.pendingTrade;
      require(t !== null, "there is no open trade");
      require(me.id === t.proposer, "only the proposer can confirm the trade");
      require(t.acceptances.includes(action.partner), "that player has not accepted the trade");
      const partner = state.players[action.partner]!;
      require(canAfford(me, t.give), "you no longer hold the resources you offered");
      require(canAfford(partner, t.receive), "your partner cannot cover the trade");
      moveBag(me, partner, t.give); // proposer gives `give` to partner
      moveBag(partner, me, t.receive); // partner gives `receive` to proposer
      state.pendingTrade = null;
      return state;
    }

    case "cancelDomesticTrade": {
      require(state.pendingTrade !== null, "there is no open trade to cancel");
      require(me.id === state.pendingTrade.proposer, "only the proposer can cancel the trade");
      state.pendingTrade = null;
      return state;
    }

    // ---- Phase transitions ----
    case "endSpecialBuild": {
      require(state.phase === "specialBuild", "not in a special building phase");
      state.specialBuildQueue.shift();
      if (state.specialBuildQueue.length > 0) {
        state.specialBuilder = state.specialBuildQueue[0]!;
      } else {
        startTurn(state, (state.currentPlayer + 1) % state.players.length);
      }
      return state;
    }

    case "endTurn": {
      require(state.phase === "main", "can only end turn from the main phase");
      state.freeRoads = 0; // any unused Road Building roads are forfeited
      endOfTurnTransition(state);
      return state;
    }

    default: {
      const _exhaustive: never = action;
      throw new Error(`unhandled action: ${JSON.stringify(_exhaustive)}`);
    }
  }
}

// ---- dev-card play guards --------------------------------------------------

function requirePlayableDev(state: GameState): void {
  require(state.phase === "preRoll" || state.phase === "main", "dev cards may be played before rolling or during the main phase");
  require(!state.devCardPlayedThisTurn, "only one development card may be played per turn");
}
function takeDev(p: PlayerState, type: DevCardType): DevCard {
  const card = p.devCards.find((c) => c.type === type && !c.played && !c.boughtThisTurn);
  require(!!card, `no playable ${type} card (you cannot play a card bought this turn)`);
  return card!;
}

// ----------------------------------------------------------------------------
// Safe wrapper: typed errors instead of throwing (for a networked server that
// must not crash on a malformed/illegal client action).
// ----------------------------------------------------------------------------

export type ReduceResult =
  | { ok: true; state: GameState }
  | { ok: false; error: string };

export function tryReduce(geo: BoardGeometry, prev: GameState, action: Action, opts: ReduceOptions = {}): ReduceResult {
  try {
    return { ok: true, state: reduce(geo, prev, action, opts) };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}

// ----------------------------------------------------------------------------
// Per-player redacted view (hide other players' hands, hidden dev cards, the
// dev-deck order, and the RNG state). The board, bank, awards and any open
// trade are public.
// ----------------------------------------------------------------------------

export interface PlayerView {
  id: PlayerId;
  color: string;
  knightsPlayed: number;
  piecesLeft: { roads: number; settlements: number; cities: number };
  handSize: number;
  victoryPointsPublic: number; // VP excluding hidden VP cards
  playedDevCards: DevCard[]; // already-played dev cards are public to everyone
  hand?: ResourceBag; // viewer only
  devCards?: DevCard[]; // viewer only (full detail, incl. hidden cards)
  devCardCount: number; // total dev cards held
  playedVictoryPointCount?: number; // viewer only
}

export interface GameView {
  phase: Phase;
  currentPlayer: PlayerId;
  specialBuilder: PlayerId | null;
  viewer: PlayerId;
  players: PlayerView[];
  board: BoardState;
  bank: ResourceBag;
  devDeckCount: number;
  dice: [number, number] | null;
  longestRoadHolder: PlayerId | null;
  largestArmyHolder: PlayerId | null;
  winner: PlayerId | null;
  pendingTrade: PendingTrade | null;
  pendingDiscards: Record<PlayerId, number>;
}

/** Public VP = buildings + awards (NOT hidden VP cards), what opponents can see. */
export function publicVictoryPoints(state: GameState, player: PlayerId): number {
  let vp = 0;
  for (const vs of state.board.vertices) if (vs.building?.owner === player) vp += vs.building.type === "city" ? 2 : 1;
  if (state.longestRoadHolder === player) vp += 2;
  if (state.largestArmyHolder === player) vp += 2;
  return vp;
}

export function viewForPlayer(state: GameState, viewer: PlayerId): GameView {
  const s = cloneGameState(state);
  const players: PlayerView[] = s.players.map((p) => {
    const base: PlayerView = {
      id: p.id,
      color: p.color,
      knightsPlayed: p.knightsPlayed,
      piecesLeft: p.piecesLeft,
      handSize: RESOURCES.reduce((sum, r) => sum + p.hand[r], 0),
      victoryPointsPublic: publicVictoryPoints(s, p.id),
      playedDevCards: p.devCards.filter((c) => c.played),
      devCardCount: p.devCards.length,
    };
    if (p.id === viewer) {
      base.hand = p.hand;
      base.devCards = p.devCards;
      base.playedVictoryPointCount = p.devCards.filter((c) => c.type === "victoryPoint").length;
    }
    return base;
  });
  return {
    phase: s.phase,
    currentPlayer: s.currentPlayer,
    specialBuilder: s.specialBuilder,
    viewer,
    players,
    board: s.board,
    bank: s.bank,
    devDeckCount: s.devDeck.length,
    dice: s.dice,
    longestRoadHolder: s.longestRoadHolder,
    largestArmyHolder: s.largestArmyHolder,
    winner: s.winner,
    pendingTrade: s.pendingTrade,
    pendingDiscards: s.pendingDiscards,
  };
}

// ----------------------------------------------------------------------------
// Serialization & deterministic replay
// ----------------------------------------------------------------------------

export function serialize(state: GameState): string {
  return JSON.stringify(state);
}
export function deserialize(json: string): GameState {
  return JSON.parse(json) as GameState;
}

/** Re-apply a list of actions to an initial state. With trustClientRandomness
 *  off (default), all randomness comes from the initial state's rngState, so a
 *  given (initial, actions) pair reproduces the exact final state. */
export function replay(geo: BoardGeometry, initial: GameState, actions: Action[], opts: ReduceOptions = {}): GameState {
  let s = cloneGameState(initial);
  for (const a of actions) s = reduce(geo, s, a, opts);
  return s;
}

/** Convenience: pull the action list out of a state's event log (each event's
 *  `detail` is the action that produced it). */
export function actionsFromLog(state: GameState): Action[] {
  return state.log.map((e) => e.detail as Action);
}

// Re-exports for callers/tests (satisfiesDistanceRule, STANDARD_HEX_COORDS and
// friends come straight from geometry.js via the barrel).
export { mulberry32, shuffle, handCount, updateLongestRoad };
