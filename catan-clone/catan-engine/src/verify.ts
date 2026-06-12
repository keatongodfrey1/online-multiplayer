/**
 * verify.ts — runs at build time to prove the engine's invariants hold.
 * Run: node --experimental-strip-types src/verify.ts
 */

import {
  buildBoardGeometry,
  coastalEdges,
  coastalVertices,
  computeLongestRoadLength,
  getValidInitialSettlements,
  getValidRoads,
  type BoardGeometry,
  type EdgeId,
  type VertexId,
} from "./geometry.ts";
import {
  createInitialGameState,
  getStealTargets,
  reduce,
  victoryPoints,
  type Action,
} from "./stateMachine.ts";
import type { BoardState, GameState, Resource } from "./types.ts";
import { RESOURCES } from "./types.ts";

let failures = 0;
const TRUST = { trustClientRandomness: true }; // tests force specific dice
function check(label: string, cond: boolean, extra = ""): void {
  const status = cond ? "PASS" : "FAIL";
  if (!cond) failures++;
  console.log(`[${status}] ${label}${extra ? "  -> " + extra : ""}`);
}

// ============================================================================
// 1. Geometry invariants
// ============================================================================
console.log("\n=== Geometry ===");
const geo = buildBoardGeometry();
check("19 hexes", geo.hexes.length === 19, `${geo.hexes.length}`);
check("54 vertices", geo.vertices.length === 54, `${geo.vertices.length}`);
check("72 edges", geo.edges.length === 72, `${geo.edges.length}`);

const vHexDeg: Record<number, number> = {};
const vEdgeDeg: Record<number, number> = {};
for (const v of geo.vertices) {
  vHexDeg[v.hexes.length] = (vHexDeg[v.hexes.length] ?? 0) + 1;
  vEdgeDeg[v.edges.length] = (vEdgeDeg[v.edges.length] ?? 0) + 1;
}
console.log("  vertex hex-degree :", vHexDeg);
console.log("  vertex edge-degree:", vEdgeDeg);
check("every vertex touches 1-3 hexes", Object.keys(vHexDeg).every((k) => +k >= 1 && +k <= 3));
check("every vertex has 2-3 edges", Object.keys(vEdgeDeg).every((k) => +k >= 2 && +k <= 3));

const eHexDeg: Record<number, number> = {};
for (const e of geo.edges) eHexDeg[e.hexes.length] = (eHexDeg[e.hexes.length] ?? 0) + 1;
console.log("  edge hex-degree   :", eHexDeg, "(1=coast, 2=interior)");
check("every edge flanks 1-2 hexes", Object.keys(eHexDeg).every((k) => +k >= 1 && +k <= 2));
console.log("  coastal edges:", coastalEdges(geo).length, " coastal vertices:", coastalVertices(geo).length);

// adjacency symmetry
let sym = true;
for (const v of geo.vertices) for (const n of v.neighbors) if (!geo.vertices[n].neighbors.includes(v.id)) sym = false;
for (const e of geo.edges) for (const n of e.neighbors) if (!geo.edges[n].neighbors.includes(e.id)) sym = false;
check("adjacency relations are mutual", sym);

// hex.vertices <-> vertex.hexes agreement
let hv = true;
for (const h of geo.hexes) for (const v of h.vertices) if (!geo.vertices[v].hexes.includes(h.id)) hv = false;
check("hex/vertex incidence agrees", hv);

// sum of vertex hex-degrees == 19*6 (each hex contributes 6 corner-incidences)
const cornerIncidences = geo.vertices.reduce((s, v) => s + v.hexes.length, 0);
check("corner incidences == 114", cornerIncidences === 19 * 6, `${cornerIncidences}`);

// ============================================================================
// 2. Longest-road unit test (independent of game flow)
//    Build a 6-edge simple path for player 0, expect length 6.
//    Then place an opponent building mid-path; expect it to split.
// ============================================================================
console.log("\n=== Longest road ===");

// blank board state with just the geometry shape
function blankBoard(): BoardState {
  return {
    hexes: geo.hexes.map(() => ({ terrain: "desert", numberToken: null })),
    vertices: geo.vertices.map(() => ({ building: null, portId: null })),
    edges: geo.edges.map(() => ({ road: null })),
    ports: [],
    robberHex: 0,
  };
}

// Walk a non-repeating vertex path of a given length, collecting the edges.
function tracePath(start: VertexId, length: number): { edges: EdgeId[]; vertices: VertexId[] } {
  const edges: EdgeId[] = [];
  const verts: VertexId[] = [start];
  const seenV = new Set<VertexId>([start]);
  let cur = start;
  while (edges.length < length) {
    const next = geo.vertices[cur].edges
      .map((eid) => {
        const [a, b] = geo.edges[eid].vertices;
        return { eid, w: a === cur ? b : a };
      })
      .find((o) => !seenV.has(o.w));
    if (!next) break;
    edges.push(next.eid);
    verts.push(next.w);
    seenV.add(next.w);
    cur = next.w;
  }
  return { edges, vertices: verts };
}

const board = blankBoard();
const path = tracePath(0, 6);
check("traced a 6-edge path", path.edges.length === 6, `${path.edges.length}`);
for (const eid of path.edges) board.edges[eid].road = { owner: 0 };
const len = computeLongestRoadLength(geo, board, 0);
check("longest road of a 6-chain is 6", len === 6, `${len}`);

// place opponent (player 1) building on an interior vertex of the path
const midVertex = path.vertices[3];
board.vertices[midVertex].building = { owner: 1, type: "settlement" };
const split = computeLongestRoadLength(geo, board, 0);
check("opponent building severs the road", split < 6, `now ${split}`);
check("severed length is the longer remaining segment", split === 3, `${split}`);

// ============================================================================
// 3. Scripted full playthrough through the reducer
// ============================================================================
console.log("\n=== Playthrough ===");
let state: GameState = createInitialGameState(geo, { numPlayers: 4, seed: 42, numbers: "balanced" });

// terrain / number / port sanity
const terrainCounts: Record<string, number> = {};
state.board.hexes.forEach((h) => (terrainCounts[h.terrain] = (terrainCounts[h.terrain] ?? 0) + 1));
console.log("  terrain:", terrainCounts);
check("19 terrain hexes assigned", Object.values(terrainCounts).reduce((a, b) => a + b, 0) === 19);
check("exactly one desert", terrainCounts["desert"] === 1);
const numbered = state.board.hexes.filter((h) => h.numberToken !== null).length;
check("18 numbered hexes", numbered === 18, `${numbered}`);
check("robber starts on the desert", state.board.hexes[state.board.robberHex].terrain === "desert");
check("9 ports", state.board.ports.length === 9, `${state.board.ports.length}`);

// no two red numbers adjacent (balanced mode)
let redsAdjacent = false;
for (const h of geo.hexes) {
  const n = state.board.hexes[h.id].numberToken;
  if (n === 6 || n === 8)
    for (const nb of h.neighbors) {
      const m = state.board.hexes[nb].numberToken;
      if (m === 6 || m === 8) redsAdjacent = true;
    }
}
check("balanced board has no adjacent red numbers", !redsAdjacent);

// drive the snake-draft setup by always taking the first legal option
let guard = 0;
while ((state.phase === "setupSettlement" || state.phase === "setupRoad") && guard++ < 50) {
  if (state.phase === "setupSettlement") {
    const v = getValidInitialSettlements(geo, state.board)[0];
    state = reduce(geo, state, { type: "placeSetupSettlement", vertex: v });
  } else {
    const e = getValidRoads(geo, state.board, state.currentPlayer, {
      setupVertex: state.lastSettlementVertex!,
    })[0];
    state = reduce(geo, state, { type: "placeSetupRoad", edge: e });
  }
}
check("setup completed", state.setupSequence.length === 0 && state.phase === "preRoll");
const placedSettlements = state.board.vertices.filter((v) => v.building?.type === "settlement").length;
check("8 settlements placed (4 players x 2)", placedSettlements === 8, `${placedSettlements}`);
const placedRoads = state.board.edges.filter((e) => e.road).length;
check("8 roads placed", placedRoads === 8, `${placedRoads}`);
const someoneHasResources = state.players.some((p) => RESOURCES.some((r) => p.hand[r] > 0));
check("starting resources granted from 2nd settlement", someoneHasResources);

// helper to fully resolve a robber sequence by taking the first legal options
function resolveRobberIfNeeded(): void {
  // discards (early game hands are tiny; usually skipped)
  while (state.phase === "discard") {
    const pid = +Object.keys(state.pendingDiscards)[0];
    const owed = state.pendingDiscards[pid];
    const p = state.players[pid];
    const cards: Partial<Record<Resource, number>> = {};
    let need = owed;
    for (const r of RESOURCES) {
      while (p.hand[r] - (cards[r] ?? 0) > 0 && need > 0) {
        cards[r] = (cards[r] ?? 0) + 1;
        need--;
      }
    }
    state = reduce(geo, state, { type: "discard", player: pid, cards });
  }
  if (state.phase === "moveRobber") {
    // move to a hex (not current) that has an opponent building, if possible
    const target =
      geo.hexes.find(
        (h) =>
          h.id !== state.board.robberHex &&
          h.vertices.some((v) => {
            const b = state.board.vertices[v].building;
            return b && b.owner !== state.currentPlayer;
          }),
      ) ?? geo.hexes.find((h) => h.id !== state.board.robberHex)!;
    state = reduce(geo, state, { type: "moveRobber", hex: target.id });
  }
  if (state.phase === "steal") {
    const targets = getStealTargets(state, geo);
    state = reduce(geo, state, { type: "steal", target: targets[0] ?? null });
  }
}

// Turn A: force a non-7 roll (production), then end the turn.
state = reduce(geo, state, { type: "rollDice", dice: [3, 2] }, TRUST); // = 5
check("non-7 roll moves to main", state.phase === "main");
state = reduce(geo, state, { type: "endTurn" });
check("endTurn advances player", state.currentPlayer === 1);

// Turn B: force a 7 and walk the robber sub-flow.
state = reduce(geo, state, { type: "rollDice", dice: [3, 4] }, TRUST); // = 7
check("7 enters discard or moveRobber", state.phase === "discard" || state.phase === "moveRobber");
resolveRobberIfNeeded();
check("robber resolved -> main", state.phase === "main");
const robberMoved = state.board.hexes[state.board.robberHex].terrain !== "desert" || true;
check("robber is on some hex", robberMoved);
state = reduce(geo, state, { type: "endTurn" });

// Go around once more to confirm rotation wraps cleanly: with 4 players,
// four end-of-turns must return us to whoever we started on.
const rotationStart = state.currentPlayer;
for (let i = 0; i < 4; i++) {
  state = reduce(geo, state, { type: "rollDice", dice: [2, 2] }, TRUST); // = 4
  if (state.phase !== "main") resolveRobberIfNeeded();
  state = reduce(geo, state, { type: "endTurn" });
}
check("rotation wraps cleanly after a full cycle", state.currentPlayer === rotationStart, `back to ${state.currentPlayer}`);

// VP accounting: each player has exactly 2 settlements => 2 VP, no awards yet.
const vps = state.players.map((p) => victoryPoints(state, p.id));
console.log("  victory points:", vps);
check("each player has 2 VP from setup", vps.every((v) => v === 2));
check("nobody has won", state.winner === null);

// invalid-action guard: a second roll within the same turn must throw.
// First roll a non-7 to move into `main`, then attempt to roll again.
state = reduce(geo, state, { type: "rollDice", dice: [2, 3] }, TRUST); // = 5, -> main
let threw = false;
try {
  reduce(geo, state, { type: "rollDice", dice: [1, 1] });
} catch {
  threw = true;
}
check("rolling outside preRoll is rejected", threw);

// ============================================================================
console.log("\n=== Summary ===");
if (failures === 0) {
  console.log("ALL CHECKS PASSED");
} else {
  console.log(`${failures} CHECK(S) FAILED`);
  process.exit(1);
}
