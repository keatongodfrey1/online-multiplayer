/**
 * Save-game snapshots. The blob lives in the host's BROWSER (localStorage
 * save slots), so nothing here is trusted on the way back in: parseSave
 * validates every field, checks the conservation invariants (resources, dev
 * cards, pieces, trade tokens), confirms the board matches the deterministic
 * geometry, and then rebuilds a fresh GameState from the validated values -
 * the raw object is never used directly. Returns null on ANY violation, and
 * the caller just ignores the message.
 *
 * A save knowingly contains hidden information (the dev-deck order and the
 * RNG state) - the host could read it. That is the family-game trade-off for
 * keeping the server stateless; it is no worse than hosting the box. The
 * engine's event log is stripped from the blob (so saves stay small); the
 * room's turnCount is carried separately for the slot label.
 */
import { CatanEngine } from "@backbone/shared";

const { buildBoardGeometry, RESOURCES, TERRAIN_BAG } = CatanEngine;
type GameState = CatanEngine.GameState;
type PlayerState = CatanEngine.PlayerState;
type BoardState = CatanEngine.BoardState;
type Resource = CatanEngine.Resource;
type Terrain = CatanEngine.Terrain;
type Phase = CatanEngine.Phase;
type DevCardType = CatanEngine.DevCard["type"];
type PendingTrade = CatanEngine.PendingTrade;

const geo = buildBoardGeometry();
const TERRAINS = new Set<string>(["forest", "hills", "pasture", "fields", "mountains", "desert"]);
const TERRAIN_RES: Record<string, Resource | null> = {
  forest: "lumber", hills: "brick", pasture: "wool", fields: "grain", mountains: "ore", desert: null,
};
const DEV_TYPES = new Set<string>(["knight", "victoryPoint", "roadBuilding", "yearOfPlenty", "monopoly"]);
/** Full deck composition; knights may be fewer (the 2p variant discards them). */
const DEV_COMPOSITION: Record<DevCardType, number> = {
  knight: 14, victoryPoint: 5, roadBuilding: 2, yearOfPlenty: 2, monopoly: 2,
};
const PHASES = new Set<string>([
  "rollForOrder", "setupSettlement", "setupRoad", "preRoll", "discard", "moveRobber", "steal",
  "main", "specialBuild", "neutralBuild", "forcedTradeGive", "gameOver",
]);
const PALETTE = new Set<string>(["red", "blue", "white", "orange", "green", "brown"]);
const RESUMABLE_PHASES = new Set<string>([
  "setupSettlement", "setupRoad", "preRoll", "discard", "moveRobber", "steal", "main", "neutralBuild", "forcedTradeGive",
]);
const TERRAIN_MULTISET = countBy([...TERRAIN_BAG]);

export interface SaveSeat {
  nickname: string;
  isBot: boolean;
  /** Seat had left for good when the game was saved; stays ghost-played. */
  gone: boolean;
}

export interface SaveConfig {
  useTwoPlayerVariant: boolean;
  robberBounty: boolean;
}

export interface ParsedSave {
  engine: GameState;
  seats: SaveSeat[];
  config: SaveConfig;
  turnCount: number;
}

interface SaveInput {
  engine: GameState;
  seats: SaveSeat[];
  config: SaveConfig;
  turnCount: number;
}

/** Engine + lineup -> plain JSON blob for the client to store. */
export function serializeSave({ engine, seats, config, turnCount }: SaveInput): object {
  const clone = CatanEngine.cloneGameState(engine);
  clone.log = []; // saves don't carry the event feed
  return {
    v: 1,
    game: "catan",
    savedAt: Date.now(),
    turnCount,
    config: { useTwoPlayerVariant: config.useTwoPlayerVariant, robberBounty: config.robberBounty },
    seats: seats.map((s) => ({ nickname: s.nickname, isBot: s.isBot, gone: s.gone })),
    engine: clone,
  };
}

// ---- small validators --------------------------------------------------------

function isInt(v: unknown, min: number, max: number): v is number {
  return typeof v === "number" && Number.isInteger(v) && v >= min && v <= max;
}
function isBool(v: unknown): v is boolean {
  return typeof v === "boolean";
}
function countBy<T extends string>(items: T[]): Record<string, number> {
  const out: Record<string, number> = {};
  for (const i of items) out[i] = (out[i] ?? 0) + 1;
  return out;
}
function parseBag(raw: unknown): Record<Resource, number> | null {
  if (typeof raw !== "object" || raw === null) return null;
  const m = raw as Record<string, unknown>;
  const out = { lumber: 0, brick: 0, wool: 0, grain: 0, ore: 0 };
  for (const r of RESOURCES) {
    if (!isInt(m[r], 0, 19)) return null;
    out[r] = m[r] as number;
  }
  return out;
}
function parsePartialBag(raw: unknown): Partial<Record<Resource, number>> | null {
  if (typeof raw !== "object" || raw === null) return null;
  const m = raw as Record<string, unknown>;
  const out: Partial<Record<Resource, number>> = {};
  for (const k of Object.keys(m)) {
    if (!RESOURCES.includes(k as Resource) || !isInt(m[k], 0, 19)) return null;
    if ((m[k] as number) > 0) out[k as Resource] = m[k] as number;
  }
  return out;
}

/**
 * Validate an untrusted save blob and rebuild a live GameState from it.
 * Returns null on ANY violation.
 */
export function parseSave(raw: unknown): ParsedSave | null {
  if (typeof raw !== "object" || raw === null) return null;
  const top = raw as Record<string, unknown>;
  if (top.v !== 1 || top.game !== "catan") return null;
  if (!isInt(top.turnCount, 0, 100000)) return null;

  const cfg = top.config as Record<string, unknown> | null;
  if (typeof cfg !== "object" || cfg === null) return null;
  if (!isBool(cfg.useTwoPlayerVariant) || !isBool(cfg.robberBounty)) return null;
  const config: SaveConfig = { useTwoPlayerVariant: cfg.useTwoPlayerVariant, robberBounty: cfg.robberBounty };

  // ---- seats ---------------------------------------------------------------
  if (!Array.isArray(top.seats) || top.seats.length < 2 || top.seats.length > 4) return null;
  const seats: SaveSeat[] = [];
  const names = new Set<string>();
  for (const s of top.seats as Record<string, unknown>[]) {
    if (typeof s !== "object" || s === null) return null;
    const nickname = typeof s.nickname === "string" ? s.nickname.trim() : "";
    if (nickname.length < 1 || nickname.length > 24 || names.has(nickname.toLowerCase())) return null;
    names.add(nickname.toLowerCase());
    if (!isBool(s.isBot) || !isBool(s.gone)) return null;
    seats.push({ nickname, isBot: s.isBot, gone: s.gone });
  }
  if (!seats.some((s) => !s.isBot && !s.gone)) return null; // somebody must actually play
  const numHumans = seats.length;

  const e = top.engine as Record<string, unknown> | null;
  if (typeof e !== "object" || e === null) return null;

  // ---- variant consistency -------------------------------------------------
  const twoPlayerVariant = e.twoPlayerVariant === true;
  if (twoPlayerVariant && numHumans !== 2) return null;
  const totalSeats = twoPlayerVariant ? 4 : numHumans;
  const neutralIds = twoPlayerVariant ? [2, 3] : [];
  if (!Array.isArray(e.neutralPlayerIds) || e.neutralPlayerIds.length !== neutralIds.length) return null;
  if (!neutralIds.every((id, i) => (e.neutralPlayerIds as unknown[])[i] === id)) return null;
  const isNeutral = (id: number) => neutralIds.includes(id);

  // ---- board ---------------------------------------------------------------
  const board = parseBoard(e.board, totalSeats);
  if (!board) return null;

  // ---- players -------------------------------------------------------------
  if (!Array.isArray(e.players) || e.players.length !== totalSeats) return null;
  const players: PlayerState[] = [];
  // tally board pieces per owner for the piece-supply arithmetic
  const builtSettlements = new Array(totalSeats).fill(0);
  const builtCities = new Array(totalSeats).fill(0);
  const builtRoads = new Array(totalSeats).fill(0);
  for (const v of board.vertices) {
    if (v.building) {
      if (v.building.type === "city") builtCities[v.building.owner]!++;
      else builtSettlements[v.building.owner]!++;
    }
  }
  for (const ed of board.edges) if (ed.road) builtRoads[ed.road.owner]!++;

  const bankFromSave = parseBag(e.bank);
  if (!bankFromSave) return null;
  const resourceTotals: Record<Resource, number> = { ...bankFromSave };
  const devTally: Record<string, number> = {};
  let tokenTotal = 0;

  for (let i = 0; i < totalSeats; i++) {
    const p = (e.players as Record<string, unknown>[])[i];
    if (typeof p !== "object" || p === null) return null;
    if (p.id !== i) return null;
    if (typeof p.color !== "string" || !PALETTE.has(p.color)) return null;
    const hand = parseBag(p.hand);
    if (!hand) return null;
    if (!isInt(p.knightsPlayed, 0, 14)) return null;
    const pl = p.piecesLeft as Record<string, unknown> | null;
    if (typeof pl !== "object" || pl === null) return null;
    // current piece counts are exact (city upgrades return the settlement)
    if (pl.roads !== 15 - builtRoads[i]!) return null;
    if (pl.settlements !== 5 - builtSettlements[i]!) return null;
    if (pl.cities !== 4 - builtCities[i]!) return null;
    if (!Array.isArray(p.devCards)) return null;
    const devCards: CatanEngine.DevCard[] = [];
    let playedKnights = 0;
    for (const c of p.devCards as Record<string, unknown>[]) {
      if (typeof c !== "object" || c === null) return null;
      if (typeof c.type !== "string" || !DEV_TYPES.has(c.type)) return null;
      if (!isBool(c.boughtThisTurn) || !isBool(c.played)) return null;
      devTally[c.type] = (devTally[c.type] ?? 0) + 1;
      if (c.type === "knight" && c.played) playedKnights++;
      devCards.push({ type: c.type as DevCardType, boughtThisTurn: c.boughtThisTurn, played: c.played });
    }
    if (playedKnights !== p.knightsPlayed) return null; // knightsPlayed = held played knights
    if (isNeutral(i)) {
      // neutrals never hold resources, dev cards, or tokens
      if (RESOURCES.some((r) => hand[r] !== 0) || devCards.length !== 0) return null;
    }
    const tradeTokens = p.tradeTokens;
    if (!isInt(tradeTokens, 0, 20)) return null;
    if (isNeutral(i) && tradeTokens !== 0) return null;
    tokenTotal += tradeTokens;
    for (const r of RESOURCES) resourceTotals[r] += hand[r];
    players.push({ id: i, color: p.color, hand, devCards, knightsPlayed: p.knightsPlayed, piecesLeft: { roads: pl.roads as number, settlements: pl.settlements as number, cities: pl.cities as number }, tradeTokens });
  }

  // ---- conservation --------------------------------------------------------
  if (RESOURCES.some((r) => resourceTotals[r] !== 19)) return null; // 19 of each, always
  // dev composition: each non-knight exact; knights <= 14, deficit only in the variant
  const devDeck = parseDevDeck(e.devDeck);
  if (!devDeck) return null;
  for (const t of devDeck) devTally[t] = (devTally[t] ?? 0) + 1;
  for (const t of Object.keys(DEV_COMPOSITION) as DevCardType[]) {
    const have = devTally[t] ?? 0;
    if (t === "knight") {
      if (have > 14 || (have < 14 && !twoPlayerVariant)) return null;
    } else if (have !== DEV_COMPOSITION[t]) return null;
  }
  if (Object.keys(devTally).some((t) => !DEV_TYPES.has(t))) return null;
  const expectedTokens = twoPlayerVariant ? 20 : 0;
  if (tokenTotal + (isInt(e.tokenSupply, 0, 20) ? (e.tokenSupply as number) : -1) !== expectedTokens) return null;

  // ---- flow fields ---------------------------------------------------------
  if (typeof e.phase !== "string" || !RESUMABLE_PHASES.has(e.phase)) return null; // not gameOver
  if (e.winner !== null) return null;
  if (!isInt(e.currentPlayer, 0, totalSeats - 1) || isNeutral(e.currentPlayer as number)) return null;
  if (!isInt(e.setupStep, 0, 8)) return null;
  if (!Array.isArray(e.setupSequence)) return null;
  for (const id of e.setupSequence) if (!isInt(id, 0, numHumans - 1)) return null;
  if (e.lastSettlementVertex !== null && !isInt(e.lastSettlementVertex, 0, 53)) return null;
  if (!isInt(e.freeRoads, 0, 2) || !isBool(e.devCardPlayedThisTurn)) return null;
  if (!isInt(e.rollsThisTurn, 0, 2) || !isBool(e.knightDiscardedThisTurn)) return null;
  if (!isInt(e.pendingNeutralBuilds, 0, 8)) return null;
  if (e.robberBounty !== config.robberBounty) return null;
  if (!parseDice(e.dice) || !parseDice(e.firstDice)) return null;
  if (!PHASES.has(e.robberReturnPhase as string) || !PHASES.has(e.neutralBuildReturnPhase as string)) return null;
  if (!isInt(e.rngState, 0, 0xffffffff)) return null;
  const pendingDiscards = parsePendingDiscards(e.pendingDiscards, totalSeats, players, isNeutral);
  if (!pendingDiscards) return null;
  const pendingTrade = parsePendingTrade(e.pendingTrade, totalSeats, isNeutral);
  if (pendingTrade === undefined) return null;
  const orderRolls = parseOrderRolls(e.orderRolls, totalSeats);
  if (!orderRolls) return null;
  if (!Array.isArray(e.orderContenders)) return null;
  for (const id of e.orderContenders) if (!isInt(id, 0, numHumans - 1)) return null;

  // award holders: null or a valid id (full recompute is impossible with the
  // holder-keeps-ties rule, so just bound the reference).
  if (e.longestRoadHolder !== null && !isInt(e.longestRoadHolder, 0, totalSeats - 1)) return null;
  if (e.largestArmyHolder !== null && !isInt(e.largestArmyHolder, 0, totalSeats - 1)) return null;

  // ---- rebuild a clean GameState -------------------------------------------
  const engine: GameState = {
    phase: e.phase as Phase,
    players,
    currentPlayer: e.currentPlayer as number,
    board,
    bank: bankFromSave,
    devDeck,
    dice: e.dice === null ? null : [...(e.dice as [number, number])],
    longestRoadHolder: e.longestRoadHolder as number | null,
    largestArmyHolder: e.largestArmyHolder as number | null,
    winner: null,
    setupSequence: [...(e.setupSequence as number[])],
    setupStep: e.setupStep as number,
    lastSettlementVertex: e.lastSettlementVertex as number | null,
    orderRolls,
    orderContenders: [...(e.orderContenders as number[])],
    freeRoads: e.freeRoads as number,
    devCardPlayedThisTurn: e.devCardPlayedThisTurn,
    pendingDiscards,
    robberReturnPhase: e.robberReturnPhase as Phase,
    pendingTrade,
    rngState: e.rngState as number,
    specialBuildEnabled: e.specialBuildEnabled === true,
    specialBuildQueue: [],
    specialBuilder: null,
    robberBounty: config.robberBounty,
    twoPlayerVariant,
    neutralPlayerIds: [...neutralIds],
    tokenSupply: e.tokenSupply as number,
    rollsThisTurn: e.rollsThisTurn as number,
    firstDice: e.firstDice === null ? null : [...(e.firstDice as [number, number])],
    pendingNeutralBuilds: e.pendingNeutralBuilds as number,
    neutralBuildReturnPhase: e.neutralBuildReturnPhase as Phase,
    knightDiscardedThisTurn: e.knightDiscardedThisTurn,
    log: [],
  };
  return { engine, seats, config, turnCount: top.turnCount };
}

// ---- board ------------------------------------------------------------------

function parseBoard(raw: unknown, totalSeats: number): BoardState | null {
  if (typeof raw !== "object" || raw === null) return null;
  const b = raw as Record<string, unknown>;
  if (!Array.isArray(b.hexes) || b.hexes.length !== geo.hexes.length) return null;
  if (!Array.isArray(b.vertices) || b.vertices.length !== geo.vertices.length) return null;
  if (!Array.isArray(b.edges) || b.edges.length !== geo.edges.length) return null;
  if (!Array.isArray(b.ports)) return null;
  if (!isInt(b.robberHex, 0, geo.hexes.length - 1)) return null;

  // hexes: terrain multiset must match the standard bag; numberToken null iff desert
  const hexes: BoardState["hexes"] = [];
  const terrainCount: Record<string, number> = {};
  for (const h of b.hexes as Record<string, unknown>[]) {
    if (typeof h !== "object" || h === null) return null;
    if (typeof h.terrain !== "string" || !TERRAINS.has(h.terrain)) return null;
    terrainCount[h.terrain] = (terrainCount[h.terrain] ?? 0) + 1;
    const isDesert = h.terrain === "desert";
    if (isDesert) {
      if (h.numberToken !== null) return null;
    } else if (!isInt(h.numberToken, 2, 12) || h.numberToken === 7) {
      return null;
    }
    hexes.push({ terrain: h.terrain as Terrain, numberToken: isDesert ? null : (h.numberToken as number) });
  }
  for (const t of Object.keys(TERRAIN_MULTISET)) if (terrainCount[t] !== TERRAIN_MULTISET[t]) return null;
  if (hexes[b.robberHex as number] === undefined) return null;

  // ports (validated first so vertex.portId can be rebuilt from them)
  const ports: BoardState["ports"] = [];
  const portIdByVertex = new Map<number, number>();
  (b.ports as Record<string, unknown>[]).forEach((p, pid) => {
    ports.push({ type: "generic", vertices: [] }); // placeholder, overwritten below
  });
  for (let pid = 0; pid < (b.ports as unknown[]).length; pid++) {
    const p = (b.ports as Record<string, unknown>[])[pid]!;
    if (typeof p !== "object" || p === null) return null;
    if (p.type !== "generic" && !RESOURCES.includes(p.type as Resource)) return null;
    if (!Array.isArray(p.vertices)) return null;
    const vs: number[] = [];
    for (const v of p.vertices) {
      if (!isInt(v, 0, geo.vertices.length - 1)) return null;
      vs.push(v);
      portIdByVertex.set(v, pid);
    }
    ports[pid] = { type: p.type as CatanEngine.PortType, vertices: vs };
  }

  // vertices: buildings owned by a real seat; portId rebuilt from ports
  const vertices: BoardState["vertices"] = [];
  (b.vertices as Record<string, unknown>[]).forEach((v, id) => {
    vertices.push({ building: null, portId: portIdByVertex.get(id) ?? null });
  });
  for (let id = 0; id < (b.vertices as unknown[]).length; id++) {
    const v = (b.vertices as Record<string, unknown>[])[id]!;
    if (typeof v !== "object" || v === null) return null;
    if (v.building !== null) {
      const bu = v.building as Record<string, unknown>;
      if (typeof bu !== "object" || bu === null) return null;
      if (!isInt(bu.owner, 0, totalSeats - 1)) return null;
      if (bu.type !== "settlement" && bu.type !== "city") return null;
      vertices[id]!.building = { owner: bu.owner as number, type: bu.type as "settlement" | "city" };
    }
  }
  // distance rule: no two buildings on adjacent vertices
  for (let id = 0; id < vertices.length; id++) {
    if (!vertices[id]!.building) continue;
    for (const n of geo.vertices[id]!.neighbors) if (vertices[n]!.building) return null;
  }

  // edges
  const edges: BoardState["edges"] = [];
  for (const ed of b.edges as Record<string, unknown>[]) {
    if (typeof ed !== "object" || ed === null) return null;
    if (ed.road === null) {
      edges.push({ road: null });
    } else {
      const ro = ed.road as Record<string, unknown>;
      if (typeof ro !== "object" || ro === null || !isInt(ro.owner, 0, totalSeats - 1)) return null;
      edges.push({ road: { owner: ro.owner as number } });
    }
  }

  return { hexes, vertices, edges, ports, robberHex: b.robberHex as number };
}

function parseDevDeck(raw: unknown): DevCardType[] | null {
  if (!Array.isArray(raw)) return null;
  const out: DevCardType[] = [];
  for (const t of raw) {
    if (typeof t !== "string" || !DEV_TYPES.has(t)) return null;
    out.push(t as DevCardType);
  }
  return out;
}

function parseDice(raw: unknown): boolean {
  if (raw === null) return true;
  return Array.isArray(raw) && raw.length === 2 && isInt(raw[0], 1, 6) && isInt(raw[1], 1, 6);
}

function parsePendingDiscards(
  raw: unknown,
  totalSeats: number,
  players: PlayerState[],
  isNeutral: (id: number) => boolean,
): Record<number, number> | null {
  if (typeof raw !== "object" || raw === null) return null;
  const m = raw as Record<string, unknown>;
  const out: Record<number, number> = {};
  for (const k of Object.keys(m)) {
    const id = Number(k);
    if (!Number.isInteger(id) || id < 0 || id >= totalSeats || isNeutral(id)) return null;
    const owed = m[k];
    const handCount = RESOURCES.reduce((t, r) => t + players[id]!.hand[r], 0);
    if (!isInt(owed, 1, Math.floor(handCount / 2))) return null;
    out[id] = owed;
  }
  return out;
}

/** Returns the trade (or null), or undefined on a validation failure. */
function parsePendingTrade(
  raw: unknown,
  totalSeats: number,
  isNeutral: (id: number) => boolean,
): PendingTrade | null | undefined {
  if (raw === null) return null;
  if (typeof raw !== "object") return undefined;
  const t = raw as Record<string, unknown>;
  if (!isInt(t.proposer, 0, totalSeats - 1) || isNeutral(t.proposer as number)) return undefined;
  const give = parsePartialBag(t.give);
  const receive = parsePartialBag(t.receive);
  if (!give || !receive) return undefined;
  if (!Array.isArray(t.candidates) || !Array.isArray(t.acceptances) || !Array.isArray(t.declines)) return undefined;
  const candidates: number[] = [];
  for (const c of t.candidates) {
    if (!isInt(c, 0, totalSeats - 1) || isNeutral(c as number) || c === t.proposer) return undefined;
    candidates.push(c);
  }
  const within = (arr: unknown[]) => arr.every((x) => isInt(x, 0, totalSeats - 1) && candidates.includes(x as number));
  if (!within(t.acceptances) || !within(t.declines)) return undefined;
  return {
    proposer: t.proposer as number,
    give,
    receive,
    candidates,
    acceptances: [...(t.acceptances as number[])],
    declines: [...(t.declines as number[])],
  };
}

function parseOrderRolls(raw: unknown, totalSeats: number): ([number, number] | null)[] | null {
  if (!Array.isArray(raw) || raw.length !== totalSeats) return null;
  const out: ([number, number] | null)[] = [];
  for (const r of raw) {
    if (r === null) {
      out.push(null);
    } else if (Array.isArray(r) && r.length === 2 && isInt(r[0], 1, 6) && isInt(r[1], 1, 6)) {
      out.push([r[0], r[1]]);
    } else {
      return null;
    }
  }
  return out;
}
