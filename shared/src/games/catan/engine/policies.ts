/**
 * policies.ts — decision policies for AI seats (new for this repo, not part of
 * the ported engine).
 *
 * A Policy maps (geometry, state, seat) -> one legal Action for that seat. It
 * must return an action for EVERY phase in which the seat can be required to
 * act: setup placements, preRoll, discard, moveRobber, steal, main,
 * specialBuild (dormant), and the 2-player variant's neutralBuild and
 * forcedTradeGive. Policies never propose domestic trades and never accept
 * them (the room declines on their behalf) — deterministic and un-exploitable.
 *
 * FAIRNESS: policies read only information a human in that seat could see —
 * their own hand plus public state (board, counts, badges). They never peek at
 * opponents' hand contents or the dev deck order.
 *
 * - RandomPolicy: the "ghost" that keeps a vacated seat alive — rolls, makes
 *   forced choices randomly, builds nothing, ends its turn.
 * - GreedyPolicy: a casual opponent — pip-weighted setup, city > settlement >
 *   road expansion, simple dev-card and robber heuristics.
 */

import {
  type DevCardType,
  type GameState,
  type PlayerId,
  type PlayerState,
  type Resource,
  type ResourceBag,
  COSTS,
  RESOURCES,
  emptyBag,
} from "./types.js";
import {
  type BoardGeometry,
  type EdgeId,
  type VertexId,
  bestTradeRatio,
  edgeMidpoint,
  getValidCities,
  getValidInitialSettlements,
  getValidRoads,
  getValidSettlements,
  portAccess,
} from "./geometry.js";
import {
  type Action,
  getStealTargets,
  handCount,
  isNeutral,
  mulberry32,
  robberBountyResource,
  tokenActionCost,
} from "./stateMachine.js";

export interface Policy {
  act(geo: BoardGeometry, state: GameState, seat: PlayerId): Action;
}

// ---- shared helpers ---------------------------------------------------------

/** Dice-odds weight of a number token (6/8 = 5 pips ... 2/12 = 1 pip). */
const PIPS: Record<number, number> = { 2: 1, 3: 2, 4: 3, 5: 4, 6: 5, 8: 5, 9: 4, 10: 3, 11: 2, 12: 1 };

function hexPips(state: GameState, hexId: number): number {
  const t = state.board.hexes[hexId]!.numberToken;
  return t === null ? 0 : PIPS[t] ?? 0;
}

/** Production weight of a vertex = pip sum of its (non-robber-ignored) hexes. */
function vertexPips(geo: BoardGeometry, state: GameState, v: VertexId): number {
  return geo.vertices[v]!.hexes.reduce((s, h) => s + hexPips(state, h), 0);
}

/** Distinct resources a vertex would produce (diversity bonus for setup). */
function vertexResourceKinds(geo: BoardGeometry, state: GameState, v: VertexId): number {
  const kinds = new Set<string>();
  for (const h of geo.vertices[v]!.hexes) {
    const hex = state.board.hexes[h]!;
    if (hex.terrain !== "desert" && hex.numberToken !== null) kinds.add(hex.terrain);
  }
  return kinds.size;
}

/** Take `owed` cards from the hand, repeatedly from the largest pile. */
function discardLargestFirst(p: PlayerState, owed: number): Partial<ResourceBag> {
  const left = { ...p.hand };
  const cards: ResourceBag = emptyBag();
  for (let i = 0; i < owed; i++) {
    let best: Resource = RESOURCES[0]!;
    for (const r of RESOURCES) if (left[r] > left[best]) best = r;
    if (left[best] <= 0) break;
    left[best]--;
    cards[best]++;
  }
  return cards;
}

/** Does the robber currently sit on a hex where `seat` has a building that
 *  would otherwise produce? (Public information.) */
function robberBlocksMe(geo: BoardGeometry, state: GameState, seat: PlayerId): boolean {
  const hex = geo.hexes[state.board.robberHex]!;
  if (state.board.hexes[hex.id]!.numberToken === null) return false;
  return hex.vertices.some((v) => state.board.vertices[v]!.building?.owner === seat);
}

/** All legal neutral-build options right now (2p variant neutralBuild phase). */
function neutralBuildOptions(
  geo: BoardGeometry,
  state: GameState,
): Array<{ neutralId: 0 | 1; kind: "road" | "settlement"; id: number }> {
  const out: Array<{ neutralId: 0 | 1; kind: "road" | "settlement"; id: number }> = [];
  state.neutralPlayerIds.forEach((nid, i) => {
    const p = state.players[nid]!;
    if (p.piecesLeft.roads > 0)
      for (const e of getValidRoads(geo, state.board, nid)) out.push({ neutralId: i as 0 | 1, kind: "road", id: e });
    if (p.piecesLeft.settlements > 0)
      for (const v of getValidSettlements(geo, state.board, nid))
        out.push({ neutralId: i as 0 | 1, kind: "settlement", id: v });
  });
  return out;
}

function toNeutralAction(opt: { neutralId: 0 | 1; kind: "road" | "settlement"; id: number }): Action {
  return opt.kind === "road"
    ? { type: "buildNeutral", neutralId: opt.neutralId, kind: "road", edge: opt.id }
    : { type: "buildNeutral", neutralId: opt.neutralId, kind: "settlement", vertex: opt.id };
}

/** Give back exactly two cards after a Forced Trade: from the largest piles. */
function giveBackTwo(p: PlayerState): Action {
  return { type: "forcedTradeGiveBack", cards: discardLargestFirst(p, 2) };
}

// ---- RandomPolicy (the ghost) -----------------------------------------------

export class RandomPolicy implements Policy {
  private rng: () => number;

  constructor(seed: number) {
    this.rng = mulberry32(seed >>> 0);
  }

  private pick<T>(arr: T[]): T {
    return arr[Math.floor(this.rng() * arr.length)]!;
  }

  act(geo: BoardGeometry, state: GameState, seat: PlayerId): Action {
    const me = state.players[seat]!;
    switch (state.phase) {
      case "rollForOrder":
        return { type: "rollForOrder", player: seat };
      case "setupSettlement":
        return { type: "placeSetupSettlement", vertex: this.pick(getValidInitialSettlements(geo, state.board)) };
      case "setupRoad":
        return {
          type: "placeSetupRoad",
          edge: this.pick(getValidRoads(geo, state.board, seat, { setupVertex: state.lastSettlementVertex! })),
        };
      case "preRoll":
        return { type: "rollDice" };
      case "discard":
        return { type: "discard", player: seat, cards: discardLargestFirst(me, state.pendingDiscards[seat] ?? 0) };
      case "moveRobber": {
        const hexes = geo.hexes.filter((h) => h.id !== state.board.robberHex).map((h) => h.id);
        return { type: "moveRobber", hex: this.pick(hexes) };
      }
      case "steal": {
        const targets = getStealTargets(state, geo);
        if (targets.length) return { type: "steal", target: this.pick(targets) };
        // robberBounty house rule: with no one to rob, take the tile's resource
        return robberBountyResource(state) !== null ? { type: "robberTake" } : { type: "steal", target: null };
      }
      case "neutralBuild": {
        const opts = neutralBuildOptions(geo, state);
        return toNeutralAction(this.pick(opts));
      }
      case "forcedTradeGive":
        return giveBackTwo(me);
      case "main": {
        // keep the seat alive without playing its hand: place any owed free
        // roads (Road Building), then pass.
        if (state.freeRoads > 0 && me.piecesLeft.roads > 0) {
          const roads = getValidRoads(geo, state.board, seat);
          if (roads.length) return { type: "buildRoad", edge: this.pick(roads) };
        }
        return { type: "endTurn" };
      }
      case "specialBuild":
        return { type: "endSpecialBuild" };
      default:
        throw new Error(`RandomPolicy: no action for phase ${state.phase}`);
    }
  }
}

// ---- GreedyPolicy (the seated bot) -------------------------------------------

export class GreedyPolicy implements Policy {
  private rng: () => number;

  constructor(seed: number) {
    this.rng = mulberry32(seed >>> 0);
  }

  act(geo: BoardGeometry, state: GameState, seat: PlayerId): Action {
    const me = state.players[seat]!;
    switch (state.phase) {
      case "rollForOrder":
        return { type: "rollForOrder", player: seat };
      case "setupSettlement": {
        const best = this.bestBy(getValidInitialSettlements(geo, state.board), (v) =>
          vertexPips(geo, state, v) + 0.4 * vertexResourceKinds(geo, state, v),
        );
        return { type: "placeSetupSettlement", vertex: best };
      }
      case "setupRoad": {
        // point the road at the most productive far endpoint
        const edges = getValidRoads(geo, state.board, seat, { setupVertex: state.lastSettlementVertex! });
        const best = this.bestBy(edges, (e) => {
          const [a, b] = geo.edges[e]!.vertices;
          const far = a === state.lastSettlementVertex ? b : a;
          return vertexPips(geo, state, far);
        });
        return { type: "placeSetupRoad", edge: best };
      }
      case "preRoll": {
        if (!state.devCardPlayedThisTurn && this.playable(me, "knight") && robberBlocksMe(geo, state, seat)) {
          return { type: "playKnight" };
        }
        return { type: "rollDice" };
      }
      case "discard":
        return { type: "discard", player: seat, cards: discardLargestFirst(me, state.pendingDiscards[seat] ?? 0) };
      case "moveRobber":
        return { type: "moveRobber", hex: this.robberTarget(geo, state, seat) };
      case "steal": {
        const targets = getStealTargets(state, geo);
        if (!targets.length) {
          // robberBounty house rule: nothing to steal, so take the tile's resource
          return robberBountyResource(state) !== null ? { type: "robberTake" } : { type: "steal", target: null };
        }
        const best = this.bestBy(targets, (t) => handCount(state.players[t]!));
        return { type: "steal", target: best };
      }
      case "neutralBuild": {
        // place the neutral piece as far from my own network as possible
        const opts = neutralBuildOptions(geo, state);
        const roads = opts.filter((o) => o.kind === "road");
        const pool = roads.length ? roads : opts;
        const centroid = this.myCentroid(geo, state, seat);
        const best = this.bestBy(pool, (o) => {
          const p = o.kind === "road" ? edgeMidpoint(geo, o.id) : geo.vertices[o.id]!.point;
          return Math.hypot(p.x - centroid.x, p.y - centroid.y);
        });
        return toNeutralAction(best);
      }
      case "forcedTradeGive":
        return giveBackTwo(me);
      case "main":
      case "specialBuild":
        return this.mainAction(geo, state, seat);
      default:
        throw new Error(`GreedyPolicy: no action for phase ${state.phase}`);
    }
  }

  // ---- main-phase priority list ---------------------------------------------

  private mainAction(geo: BoardGeometry, state: GameState, seat: PlayerId): Action {
    const me = state.players[seat]!;
    const inMain = state.phase === "main";
    const pass: Action = inMain ? { type: "endTurn" } : { type: "endSpecialBuild" };
    const afford = (cost: Partial<ResourceBag>) => RESOURCES.every((r) => me.hand[r] >= (cost[r] ?? 0));

    // 1. owed free roads (Road Building) — place or forfeit
    if (state.freeRoads > 0) {
      const road = this.bestExpansionRoad(geo, state, seat);
      return road !== undefined ? { type: "buildRoad", edge: road } : pass;
    }

    // 2. city on the best-producing settlement
    if (me.piecesLeft.cities > 0 && afford(COSTS.city)) {
      const cities = getValidCities(state.board, seat);
      if (cities.length) return { type: "buildCity", vertex: this.bestBy(cities, (v) => vertexPips(geo, state, v)) };
    }

    // 3. settlement on the best reachable vertex
    if (me.piecesLeft.settlements > 0 && afford(COSTS.settlement)) {
      const spots = getValidSettlements(geo, state.board, seat);
      if (spots.length)
        return {
          type: "buildSettlement",
          vertex: this.bestBy(spots, (v) => vertexPips(geo, state, v) + 0.4 * vertexResourceKinds(geo, state, v)),
        };
    }

    // 4. one dev-card play per turn, when clearly useful (main phase only)
    if (inMain && !state.devCardPlayedThisTurn) {
      if (this.playable(me, "knight") && robberBlocksMe(geo, state, seat)) return { type: "playKnight" };
      if (this.playable(me, "roadBuilding") && me.piecesLeft.roads >= 2 && this.bestExpansionRoad(geo, state, seat) !== undefined) {
        return { type: "playRoadBuilding" };
      }
      const missingSett = this.missingFor(me, COSTS.settlement);
      const missingCity = this.missingFor(me, COSTS.city);
      const target = me.piecesLeft.settlements > 0 && getValidSettlements(geo, state.board, seat).length ? missingSett : missingCity;
      if (this.playable(me, "yearOfPlenty") && target.length >= 1 && target.length <= 2) {
        return { type: "playYearOfPlenty", resources: [target[0]!, target[1] ?? target[0]!] };
      }
      if (this.playable(me, "monopoly") && target.length === 1) {
        return { type: "playMonopoly", resource: target[0]! };
      }
    }

    // 5. road toward a new settlement spot
    if (me.piecesLeft.roads > 0 && afford(COSTS.road) && me.piecesLeft.settlements > 0) {
      const noSpotYet = getValidSettlements(geo, state.board, seat).length === 0;
      const road = this.bestExpansionRoad(geo, state, seat);
      if (noSpotYet && road !== undefined) return { type: "buildRoad", edge: road };
    }

    // 6. buy a dev card with spare resources
    if (inMain && state.devDeck.length > 0 && afford(COSTS.devCard) && handCount(me) >= 5) {
      return { type: "buyDevCard" };
    }

    // 7. maritime trade surplus toward the next build (main phase only)
    if (inMain) {
      const trade = this.maritimeToward(geo, state, seat);
      if (trade) return trade;
    }

    // 8. 2p variant: clear the robber off my best hex when affordable
    if (inMain && state.twoPlayerVariant && !isNeutral(state, seat) && robberBlocksMe(geo, state, seat)) {
      const desert = state.board.hexes.findIndex((h) => h.terrain === "desert");
      if (desert >= 0 && state.board.robberHex !== desert && me.tradeTokens >= tokenActionCost(state, seat)) {
        return { type: "playTokenRobber" };
      }
    }

    return pass;
  }

  // ---- heuristics -------------------------------------------------------------

  private bestBy<T>(arr: T[], score: (x: T) => number): T {
    if (!arr.length) throw new Error("GreedyPolicy: bestBy over an empty option list");
    let best: T = arr[0]!;
    let bestScore = -Infinity;
    for (const x of arr) {
      const s = score(x);
      if (s > bestScore) {
        best = x;
        bestScore = s;
      }
    }
    return best;
  }

  private playable(p: PlayerState, type: DevCardType): boolean {
    return p.devCards.some((c) => c.type === type && !c.played && !c.boughtThisTurn);
  }

  private missingFor(p: PlayerState, cost: Partial<ResourceBag>): Resource[] {
    const out: Resource[] = [];
    for (const r of RESOURCES) {
      for (let k = p.hand[r]; k < (cost[r] ?? 0); k++) out.push(r);
    }
    return out;
  }

  /** A road whose far endpoint opens (or approaches) a legal settlement spot. */
  private bestExpansionRoad(geo: BoardGeometry, state: GameState, seat: PlayerId): EdgeId | undefined {
    const roads = getValidRoads(geo, state.board, seat);
    if (!roads.length || state.players[seat]!.piecesLeft.roads <= 0) return undefined;
    return this.bestBy(roads, (e) => {
      const [a, b] = geo.edges[e]!.vertices;
      const score = (v: VertexId) => {
        const empty = state.board.vertices[v]!.building === null;
        const distOk = empty && geo.vertices[v]!.neighbors.every((n) => state.board.vertices[n]!.building === null);
        return vertexPips(geo, state, v) + (distOk ? 3 : 0);
      };
      return Math.max(score(a), score(b));
    });
  }

  /** Robber placement: hurt the best opponent hex, never block my own. */
  private robberTarget(geo: BoardGeometry, state: GameState, seat: PlayerId): number {
    const candidates = geo.hexes.filter((h) => h.id !== state.board.robberHex);
    const scored = candidates.map((h) => {
      let mine = false;
      let oppGain = 0;
      for (const v of h.vertices) {
        const b = state.board.vertices[v]!.building;
        if (!b) continue;
        if (b.owner === seat) mine = true;
        else if (!isNeutral(state, b.owner)) oppGain += hexPips(state, h.id) * (b.type === "city" ? 2 : 1);
      }
      return { id: h.id, score: mine ? -1000 + oppGain : oppGain };
    });
    return this.bestBy(scored, (s) => s.score).id;
  }

  private maritimeToward(geo: BoardGeometry, state: GameState, seat: PlayerId): Action | undefined {
    const me = state.players[seat]!;
    const access = portAccess(state.board, seat);
    const want = (cost: Partial<ResourceBag>) => this.missingFor(me, cost);
    // aim at the cheapest missing piece first: settlement, then city, then road
    const goals: Array<Partial<ResourceBag>> = [];
    if (me.piecesLeft.settlements > 0 && getValidSettlements(geo, state.board, seat).length) goals.push(COSTS.settlement);
    if (me.piecesLeft.cities > 0 && getValidCities(state.board, seat).length) goals.push(COSTS.city);
    if (me.piecesLeft.roads > 0) goals.push(COSTS.road);
    for (const goal of goals) {
      const missing = want(goal);
      if (missing.length !== 1) continue; // trade only when one card short
      const receive = missing[0]!;
      if (state.bank[receive] <= 0) continue;
      for (const give of RESOURCES) {
        if (give === receive) continue;
        const ratio = bestTradeRatio(access, give);
        const reserved = goal[give] ?? 0; // don't trade away what the build itself needs
        if (me.hand[give] - reserved >= ratio) {
          return { type: "maritimeTrade", give, receive };
        }
      }
    }
    return undefined;
  }

  private myCentroid(geo: BoardGeometry, state: GameState, seat: PlayerId): { x: number; y: number } {
    let x = 0;
    let y = 0;
    let n = 0;
    state.board.vertices.forEach((vs, id) => {
      if (vs.building?.owner === seat) {
        x += geo.vertices[id]!.point.x;
        y += geo.vertices[id]!.point.y;
        n++;
      }
    });
    return n ? { x: x / n, y: y / n } : { x: 0, y: 0 };
  }

}
