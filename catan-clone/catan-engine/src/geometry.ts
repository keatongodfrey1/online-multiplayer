/**
 * geometry.ts — Catan board topology, positions, adjacency, and the pure
 * graph queries the rules depend on (placement validity + longest road).
 *
 * PURE STRUCTURE: no game state lives here. The static graph is generated once
 * via buildBoardGeometry() and reused for the life of a board. Placement
 * validators and the longest-road search read a BoardState (buildings/roads)
 * but never mutate it.
 *
 * COORDINATES & ORIENTATION (the rendering contract — a UI MUST match this):
 *   - Hexes use CUBE coords (x + y + z === 0).
 *   - Layout is POINTY-TOP. For a hex, axial q = cube.x, r = cube.z, and the
 *     centre is  ( SQRT3 * (q + r/2),  1.5 * r )  in unit-size space.
 *   - A hex's 6 corners are at angles (60*k - 30) degrees, k = 0..5, measured
 *     counter-clockwise from the +x axis with +y pointing DOWN-screen is the
 *     caller's choice; positions are returned in `Hex.center` / `Vertex.point`
 *     and are internally consistent. Flip the y-axis at render time if your
 *     canvas has +y up.
 *   - Edge k joins corner k -> corner (k+1)%6.
 *
 * VERTEX IDENTITY IS EXACT (no floating point): a corner is the meeting point
 * of up to three hexes, so we key each corner by the *set of the three cube
 * coordinates* that meet there (including off-board cubes, which keep distinct
 * tips distinct). Shared corners therefore collapse exactly, with no rounding
 * tolerance. Cartesian points are still produced for rendering only.
 *
 * Standard base-game invariant: 19 hexes, 54 vertices, 72 edges. The builder
 * asserts this for the standard board and checks structural consistency for
 * any custom board.
 */

import type { BoardState, PlayerId, PortType } from "./types.ts";

// ----------------------------------------------------------------------------
// Static geometry types
// ----------------------------------------------------------------------------

export type CubeCoord = { x: number; y: number; z: number };
export type Point = { x: number; y: number };
export type HexId = number;
export type VertexId = number;
export type EdgeId = number;

export interface Hex {
  id: HexId;
  cube: CubeCoord;
  center: Point;
  vertices: VertexId[]; // 6, corner order (corner k at angle 60k-30)
  edges: EdgeId[]; // 6; edge k joins vertices[k] -> vertices[(k+1)%6]
  neighbors: HexId[]; // 0..6 adjacent hexes (share an edge)
}
export interface Vertex {
  id: VertexId;
  point: Point;
  hexes: HexId[]; // 1..3 hexes meeting here (drives production)
  edges: EdgeId[]; // 2..3 incident edges
  neighbors: VertexId[]; // 2..3 vertices one edge away (the distance rule)
}
export interface Edge {
  id: EdgeId;
  vertices: [VertexId, VertexId];
  hexes: HexId[]; // 1..2 flanking hexes (1 === coastal)
  neighbors: EdgeId[]; // edges sharing a vertex
}
export interface BoardGeometry {
  hexes: Hex[];
  vertices: Vertex[];
  edges: Edge[];
}

// ----------------------------------------------------------------------------
// Constant distributions (counts; assignment to specific hexes is in setup)
// ----------------------------------------------------------------------------

/** 4 forest, 4 pasture, 4 fields, 3 hills, 3 mountains, 1 desert = 19. */
export const TERRAIN_BAG = [
  "forest", "forest", "forest", "forest",
  "pasture", "pasture", "pasture", "pasture",
  "fields", "fields", "fields", "fields",
  "hills", "hills", "hills",
  "mountains", "mountains", "mountains",
  "desert",
] as const;

/** 18 number tokens: one 2, one 12, two each of 3..6 and 8..11. */
export const NUMBER_MULTISET = [
  2, 3, 3, 4, 4, 5, 5, 6, 6, 8, 8, 9, 9, 10, 10, 11, 11, 12,
] as const;

/** Canonical alphabetical (A..R) spiral sequence, for spiral placement mode. */
export const SPIRAL_NUMBER_SEQUENCE = [
  5, 2, 6, 3, 8, 10, 9, 12, 11, 4, 8, 10, 9, 5, 6, 3, 11, 4,
] as const;

export const HEX_DIRECTIONS: CubeCoord[] = [
  { x: 1, y: -1, z: 0 }, // idx0  -> angle   0
  { x: 1, y: 0, z: -1 }, // idx1  -> angle 300
  { x: 0, y: 1, z: -1 }, // idx2  -> angle 240
  { x: -1, y: 1, z: 0 }, // idx3  -> angle 180
  { x: -1, y: 0, z: 1 }, // idx4  -> angle 120
  { x: 0, y: -1, z: 1 }, // idx5  -> angle  60
];

/**
 * For corner k (angle 60k-30), the two HEX_DIRECTIONS indices of the hexes that
 * share that corner. Derived from the pointy-top angle convention so that a
 * corner's cube-set key is identical from every hex that touches it. (See the
 * file header on exact identity.)
 */
const CORNER_DIR_INDICES: [number, number][] = [
  [1, 0], [0, 5], [5, 4], [4, 3], [3, 2], [2, 1],
];

/** The standard base-game board: a radius-2 hexagon of 19 hexes. */
export const STANDARD_HEX_COORDS: CubeCoord[] = hexRadius(2);

/** All cube coords within `radius` of the centre (a hexagon of 3r^2+3r+1 hexes). */
export function hexRadius(radius: number): CubeCoord[] {
  const out: CubeCoord[] = [];
  for (let x = -radius; x <= radius; x++) {
    for (let y = -radius; y <= radius; y++) {
      const z = -x - y;
      if (Math.abs(z) <= radius) out.push({ x, y, z });
    }
  }
  return out;
}

// ----------------------------------------------------------------------------
// Construction
// ----------------------------------------------------------------------------

const SIZE = 1;

function cubeKey(c: CubeCoord): string {
  return `${c.x},${c.y},${c.z}`;
}
function addCube(a: CubeCoord, b: CubeCoord): CubeCoord {
  return { x: a.x + b.x, y: a.y + b.y, z: a.z + b.z };
}
function hexToPixel(c: CubeCoord): Point {
  const q = c.x;
  const r = c.z;
  return { x: SIZE * Math.sqrt(3) * (q + r / 2), y: SIZE * 1.5 * r };
}
function cornerPoint(c: CubeCoord, k: number): Point {
  const center = hexToPixel(c);
  const angle = (Math.PI / 180) * (60 * k - 30);
  return { x: center.x + SIZE * Math.cos(angle), y: center.y + SIZE * Math.sin(angle) };
}
/** Exact identity key for corner k of hex c: the sorted set of the three cube
 *  coords meeting at that corner (off-board cubes included). */
function cornerKey(c: CubeCoord, k: number): string {
  const [i, j] = CORNER_DIR_INDICES[k];
  const trio = [c, addCube(c, HEX_DIRECTIONS[i]), addCube(c, HEX_DIRECTIONS[j])];
  return trio.map(cubeKey).sort().join("|");
}

/** Build the static board graph. Defaults to the standard 19-hex board. */
export function buildBoardGeometry(coords: CubeCoord[] = STANDARD_HEX_COORDS): BoardGeometry {
  const cubeToHexId = new Map<string, HexId>();
  coords.forEach((c, i) => cubeToHexId.set(cubeKey(c), i));

  const hexes: Hex[] = coords.map((cube, id) => ({
    id, cube, center: hexToPixel(cube), vertices: [], edges: [], neighbors: [],
  }));

  const vKeyToId = new Map<string, VertexId>();
  const vertices: Vertex[] = [];
  const vertexHexSets: Set<HexId>[] = [];

  const eKeyToId = new Map<string, EdgeId>();
  const edges: Edge[] = [];
  const edgeHexSets: Set<HexId>[] = [];

  for (const hex of hexes) {
    const cornerVertexIds: VertexId[] = [];
    for (let k = 0; k < 6; k++) {
      const key = cornerKey(hex.cube, k);
      let vid = vKeyToId.get(key);
      if (vid === undefined) {
        vid = vertices.length;
        vKeyToId.set(key, vid);
        vertices.push({ id: vid, point: cornerPoint(hex.cube, k), hexes: [], edges: [], neighbors: [] });
        vertexHexSets.push(new Set());
      }
      vertexHexSets[vid].add(hex.id);
      cornerVertexIds.push(vid);
    }
    hex.vertices = cornerVertexIds;

    for (let k = 0; k < 6; k++) {
      const a = cornerVertexIds[k];
      const b = cornerVertexIds[(k + 1) % 6];
      const lo = Math.min(a, b), hi = Math.max(a, b);
      const ek = `${lo}_${hi}`;
      let eid = eKeyToId.get(ek);
      if (eid === undefined) {
        eid = edges.length;
        eKeyToId.set(ek, eid);
        edges.push({ id: eid, vertices: [lo, hi], hexes: [], neighbors: [] });
        edgeHexSets.push(new Set());
      }
      edgeHexSets[eid].add(hex.id);
      hex.edges[k] = eid;
    }
  }

  const vertexEdgeSets = vertices.map(() => new Set<EdgeId>());
  const vertexNeighborSets = vertices.map(() => new Set<VertexId>());
  for (const e of edges) {
    const [a, b] = e.vertices;
    vertexEdgeSets[a].add(e.id);
    vertexEdgeSets[b].add(e.id);
    vertexNeighborSets[a].add(b);
    vertexNeighborSets[b].add(a);
  }
  const edgeNeighborSets = edges.map(() => new Set<EdgeId>());
  for (const v of vertices) {
    const inc = [...vertexEdgeSets[v.id]];
    for (const e1 of inc) for (const e2 of inc) if (e1 !== e2) edgeNeighborSets[e1].add(e2);
  }
  for (const v of vertices) {
    v.hexes = [...vertexHexSets[v.id]].sort((p, q) => p - q);
    v.edges = [...vertexEdgeSets[v.id]].sort((p, q) => p - q);
    v.neighbors = [...vertexNeighborSets[v.id]].sort((p, q) => p - q);
  }
  for (const e of edges) {
    e.hexes = [...edgeHexSets[e.id]].sort((p, q) => p - q);
    e.neighbors = [...edgeNeighborSets[e.id]].sort((p, q) => p - q);
  }
  for (const hex of hexes) {
    const nbrs: HexId[] = [];
    for (const d of HEX_DIRECTIONS) {
      const nid = cubeToHexId.get(cubeKey(addCube(hex.cube, d)));
      if (nid !== undefined) nbrs.push(nid);
    }
    hex.neighbors = nbrs.sort((p, q) => p - q);
  }

  // --- Structural consistency (all boards) ---
  for (const e of edges) {
    if (e.vertices.length !== 2) throw new Error(`edge ${e.id} has != 2 endpoints`);
    if (e.hexes.length < 1 || e.hexes.length > 2) throw new Error(`edge ${e.id} flanks ${e.hexes.length} hexes`);
  }
  for (const v of vertices) {
    if (v.hexes.length < 1 || v.hexes.length > 3) throw new Error(`vertex ${v.id} touches ${v.hexes.length} hexes`);
    if (v.edges.length < 2 || v.edges.length > 3) throw new Error(`vertex ${v.id} has ${v.edges.length} edges`);
  }
  // --- Exact counts for the standard board only (identity check) ---
  if (coords === STANDARD_HEX_COORDS) {
    assertEq(hexes.length, 19, "hex count");
    assertEq(vertices.length, 54, "vertex count");
    assertEq(edges.length, 72, "edge count");
  }
  return { hexes, vertices, edges };
}

function assertEq(actual: number, expected: number, label: string): void {
  if (actual !== expected) throw new Error(`geometry invariant failed: ${label} = ${actual}, expected ${expected}`);
}

// ----------------------------------------------------------------------------
// Coastline helpers (used by setup for port placement, and by the UI)
// ----------------------------------------------------------------------------

export function coastalEdges(geo: BoardGeometry): Edge[] {
  return geo.edges.filter((e) => e.hexes.length === 1);
}
export function coastalVertices(geo: BoardGeometry): Vertex[] {
  return geo.vertices.filter((v) => v.hexes.length < 3);
}
/** Coastal edge ids ordered around the island by the angle of their midpoint. */
export function coastalEdgesOrdered(geo: BoardGeometry): EdgeId[] {
  return coastalEdges(geo)
    .map((e) => {
      const m = edgeMidpoint(geo, e.id);
      return { id: e.id, angle: Math.atan2(m.y, m.x) };
    })
    .sort((p, q) => p.angle - q.angle)
    .map((o) => o.id);
}

// ----------------------------------------------------------------------------
// Render helpers (positions only; no styling). A UI should use these so it
// stays consistent with the topology above.
// ----------------------------------------------------------------------------

export function edgeMidpoint(geo: BoardGeometry, edge: EdgeId): Point {
  const [a, b] = geo.edges[edge].vertices;
  return {
    x: (geo.vertices[a].point.x + geo.vertices[b].point.x) / 2,
    y: (geo.vertices[a].point.y + geo.vertices[b].point.y) / 2,
  };
}
/** Unit vector pointing from the island centre outward through a coastal edge's
 *  midpoint — handy for drawing a harbour marker just offshore. */
export function edgeOutwardNormal(geo: BoardGeometry, edge: EdgeId): Point {
  const m = edgeMidpoint(geo, edge);
  const len = Math.hypot(m.x, m.y) || 1;
  return { x: m.x / len, y: m.y / len };
}

// ----------------------------------------------------------------------------
// Placement validators (pure: read BoardState, never mutate)
// ----------------------------------------------------------------------------

function ownsBuilding(board: BoardState, vertex: VertexId, player: PlayerId): boolean {
  return board.vertices[vertex].building?.owner === player;
}
function opponentBuilding(board: BoardState, vertex: VertexId, player: PlayerId): boolean {
  const b = board.vertices[vertex].building;
  return b !== null && b.owner !== player;
}

export function satisfiesDistanceRule(geo: BoardGeometry, board: BoardState, vertex: VertexId): boolean {
  if (board.vertices[vertex].building) return false;
  for (const n of geo.vertices[vertex].neighbors) if (board.vertices[n].building) return false;
  return true;
}

export function getValidInitialSettlements(geo: BoardGeometry, board: BoardState): VertexId[] {
  return geo.vertices.filter((v) => satisfiesDistanceRule(geo, board, v.id)).map((v) => v.id);
}

function vertexConnectsForPlayer(geo: BoardGeometry, board: BoardState, vertex: VertexId, player: PlayerId): boolean {
  if (ownsBuilding(board, vertex, player)) return true;
  if (opponentBuilding(board, vertex, player)) return false;
  return geo.vertices[vertex].edges.some((e) => board.edges[e].road?.owner === player);
}

export function getValidSettlements(geo: BoardGeometry, board: BoardState, player: PlayerId): VertexId[] {
  return geo.vertices
    .filter((v) => satisfiesDistanceRule(geo, board, v.id) && v.edges.some((e) => board.edges[e].road?.owner === player))
    .map((v) => v.id);
}

export function getValidCities(board: BoardState, player: PlayerId): VertexId[] {
  return board.vertices
    .map((vs, id) => ({ vs, id }))
    .filter(({ vs }) => vs.building?.owner === player && vs.building.type === "settlement")
    .map(({ id }) => id);
}

export function getValidRoads(
  geo: BoardGeometry,
  board: BoardState,
  player: PlayerId,
  opts: { setupVertex?: VertexId } = {},
): EdgeId[] {
  return geo.edges
    .filter((e) => {
      if (board.edges[e.id].road) return false;
      const [a, b] = e.vertices;
      if (opts.setupVertex !== undefined) return a === opts.setupVertex || b === opts.setupVertex;
      return vertexConnectsForPlayer(geo, board, a, player) || vertexConnectsForPlayer(geo, board, b, player);
    })
    .map((e) => e.id);
}

// ----------------------------------------------------------------------------
// Ports / maritime trade ratios
// ----------------------------------------------------------------------------

export function portAccess(board: BoardState, player: PlayerId): Set<PortType> {
  const access = new Set<PortType>();
  board.ports.forEach((port) => {
    if (port.vertices.some((v) => board.vertices[v].building?.owner === player)) access.add(port.type);
  });
  return access;
}

export function bestTradeRatio(access: Set<PortType>, give: PortType): number {
  if (access.has(give)) return 2;
  if (access.has("generic")) return 3;
  return 4;
}

// ----------------------------------------------------------------------------
// Longest road (longest TRAIL: no repeated EDGES; vertices may repeat;
// traversal cannot pass THROUGH a vertex with an opponent's building)
// ----------------------------------------------------------------------------

export function computeLongestRoadLength(geo: BoardGeometry, board: BoardState, player: PlayerId): number {
  const ownEdges = new Set<EdgeId>();
  geo.edges.forEach((e) => { if (board.edges[e.id].road?.owner === player) ownEdges.add(e.id); });
  if (ownEdges.size === 0) return 0;

  const blocked = new Set<VertexId>();
  geo.vertices.forEach((v) => { if (opponentBuilding(board, v.id, player)) blocked.add(v.id); });

  const ownIncident = (v: VertexId): EdgeId[] => geo.vertices[v].edges.filter((e) => ownEdges.has(e));

  let best = 0;
  const visited = new Set<EdgeId>();
  const explore = (v: VertexId): number => {
    let localBest = visited.size;
    if (blocked.has(v)) return localBest;
    for (const e of ownIncident(v)) {
      if (visited.has(e)) continue;
      const [a, b] = geo.edges[e].vertices;
      const w = a === v ? b : a;
      visited.add(e);
      const r = explore(w);
      if (r > localBest) localBest = r;
      visited.delete(e);
    }
    return localBest;
  };
  for (const e of ownEdges) {
    const [a, b] = geo.edges[e].vertices;
    for (const start of [a, b]) {
      const other = start === a ? b : a;
      visited.clear();
      visited.add(e);
      const r = explore(other);
      if (r > best) best = r;
    }
  }
  return best;
}
