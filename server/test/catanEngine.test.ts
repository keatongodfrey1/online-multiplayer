// The Catan engine's own test suite, ported from
// catan-clone/catan-engine/src/verify*.ts (PASS/FAIL harnesses -> mocha).
// Assertions are kept verbatim so any behavior drift introduced by the port
// fails loudly. New coverage for this repo's functional additions: spiral
// number placement (the official A-R variable setup) and startingPlayer.
import assert from "node:assert/strict";
import { CatanEngine } from "@backbone/shared";

const {
  buildBoardGeometry,
  coastalEdges,
  coastalVertices,
  computeLongestRoadLength,
  getValidInitialSettlements,
  getValidRoads,
  getValidSettlements,
  getValidCities,
  spiralHexOrder,
  defaultNeutralSetupVertices,
  createInitialGameState,
  reduce,
  tryReduce,
  getStealTargets,
  victoryPoints,
  viewForPlayer,
  serialize,
  deserialize,
  replay,
  actionsFromLog,
  updateLongestRoad,
  actingId,
  emptyBag,
  RESOURCES,
  WINNING_VP,
  SPIRAL_NUMBER_SEQUENCE,
  TWO_PLAYER_TOKEN_SUPPLY,
  GreedyPolicy,
  RandomPolicy,
} = CatanEngine;
type GameState = CatanEngine.GameState;
type BoardState = CatanEngine.BoardState;
type Resource = CatanEngine.Resource;
type DevCard = CatanEngine.DevCard;
type VertexId = CatanEngine.VertexId;
type EdgeId = CatanEngine.EdgeId;

const TRUST = { trustClientRandomness: true }; // tests force specific dice
const geo = buildBoardGeometry();

// ---- shared scenario helpers (ported from the verify harnesses) -------------

/** Blank board state over the standard geometry (for graph-only scenarios). */
function blankBoard(): BoardState {
  return {
    hexes: geo.hexes.map(() => ({ terrain: "desert", numberToken: null })),
    vertices: geo.vertices.map(() => ({ building: null, portId: null })),
    edges: geo.edges.map(() => ({ road: null })),
    ports: [],
    robberHex: 0,
  };
}

/** Walk a non-repeating vertex path of a given length, collecting the edges. */
function tracePath(start: VertexId, length: number): { edges: EdgeId[]; vertices: VertexId[] } {
  const edges: EdgeId[] = [];
  const verts: VertexId[] = [start];
  const seenV = new Set<VertexId>([start]);
  let cur = start;
  while (edges.length < length) {
    const next = geo.vertices[cur]!.edges
      .map((eid) => {
        const [a, b] = geo.edges[eid]!.vertices;
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

/** Drive the snake-draft setup to completion taking the first legal option. */
function setupGame(numPlayers: number, seed: number, extra: Partial<CatanEngine.NewGameOptions> = {}): GameState {
  let s: GameState = createInitialGameState(geo, { numPlayers, seed, numbers: "balanced", ...extra });
  let guard = 0;
  while ((s.phase === "setupSettlement" || s.phase === "setupRoad") && guard++ < 300) {
    if (s.phase === "setupSettlement") {
      s = reduce(geo, s, { type: "placeSetupSettlement", vertex: getValidInitialSettlements(geo, s.board)[0]! });
    } else {
      s = reduce(geo, s, {
        type: "placeSetupRoad",
        edge: getValidRoads(geo, s.board, s.currentPlayer, { setupVertex: s.lastSettlementVertex! })[0]!,
      });
    }
  }
  return s;
}
function toMain(s: GameState): GameState {
  return reduce(geo, s, { type: "rollDice", dice: [5, 4] }, TRUST); // 9, never a 7
}
const devCard = (type: DevCard["type"]): DevCard => ({ type, boughtThisTurn: false, played: false });

/** Resolve a pending discard/robber/steal sequence taking first legal options. */
function resolveRobberIfNeeded(s: GameState): GameState {
  while (s.phase === "discard") {
    const pid = +Object.keys(s.pendingDiscards)[0]!;
    const owed = s.pendingDiscards[pid]!;
    const p = s.players[pid]!;
    const cards: Partial<Record<Resource, number>> = {};
    let need = owed;
    for (const r of RESOURCES) {
      while (p.hand[r] - (cards[r] ?? 0) > 0 && need > 0) {
        cards[r] = (cards[r] ?? 0) + 1;
        need--;
      }
    }
    s = reduce(geo, s, { type: "discard", player: pid, cards });
  }
  if (s.phase === "moveRobber") {
    const target =
      geo.hexes.find(
        (h) =>
          h.id !== s.board.robberHex &&
          h.vertices.some((v) => {
            const b = s.board.vertices[v]!.building;
            return b && b.owner !== s.currentPlayer;
          }),
      ) ?? geo.hexes.find((h) => h.id !== s.board.robberHex)!;
    s = reduce(geo, s, { type: "moveRobber", hex: target.id });
  }
  if (s.phase === "steal") {
    s = reduce(geo, s, { type: "steal", target: getStealTargets(s, geo)[0] ?? null });
  }
  return s;
}

// =============================================================================
describe("catan engine: geometry", () => {
  it("standard board is exactly 19 hexes / 54 vertices / 72 edges", () => {
    assert.equal(geo.hexes.length, 19);
    assert.equal(geo.vertices.length, 54);
    assert.equal(geo.edges.length, 72);
  });

  it("every vertex touches 1-3 hexes and has 2-3 edges", () => {
    for (const v of geo.vertices) {
      assert.ok(v.hexes.length >= 1 && v.hexes.length <= 3, `vertex ${v.id} hexes`);
      assert.ok(v.edges.length >= 2 && v.edges.length <= 3, `vertex ${v.id} edges`);
    }
  });

  it("every edge flanks 1-2 hexes; the coast is 30 edges / 30 vertices", () => {
    for (const e of geo.edges) assert.ok(e.hexes.length >= 1 && e.hexes.length <= 2, `edge ${e.id}`);
    assert.equal(coastalEdges(geo).length, 30);
    assert.equal(coastalVertices(geo).length, 30);
  });

  it("adjacency relations are mutual", () => {
    for (const v of geo.vertices)
      for (const n of v.neighbors) assert.ok(geo.vertices[n]!.neighbors.includes(v.id));
    for (const e of geo.edges)
      for (const n of e.neighbors) assert.ok(geo.edges[n]!.neighbors.includes(e.id));
  });

  it("hex/vertex incidence agrees and corner incidences sum to 114", () => {
    for (const h of geo.hexes)
      for (const v of h.vertices) assert.ok(geo.vertices[v]!.hexes.includes(h.id));
    const cornerIncidences = geo.vertices.reduce((s, v) => s + v.hexes.length, 0);
    assert.equal(cornerIncidences, 19 * 6);
  });

  it("spiralHexOrder visits all 19 hexes outside-in, each ring connected", () => {
    for (let corner = 0; corner < 6; corner++) {
      const order = spiralHexOrder(geo, corner);
      assert.equal(order.length, 19, "covers the whole board");
      assert.equal(new Set(order).size, 19, "no repeats");
      const dist = (id: number) => {
        const c = geo.hexes[id]!.cube;
        return Math.max(Math.abs(c.x), Math.abs(c.y), Math.abs(c.z));
      };
      const dists = order.map(dist);
      assert.deepEqual(dists, [...Array(12).fill(2), ...Array(6).fill(1), 0], "outer ring, middle ring, centre");
      // consecutive hexes within a ring are board neighbors (a real walk)
      for (let i = 1; i < order.length; i++) {
        if (dists[i] !== dists[i - 1]) continue; // ring transition
        assert.ok(geo.hexes[order[i - 1]!]!.neighbors.includes(order[i]!), `walk breaks at ${i} (corner ${corner})`);
      }
    }
  });
});

// =============================================================================
describe("catan engine: longest road (unit)", () => {
  it("a 6-chain measures 6 and an opponent building severs it to 3", () => {
    const board = blankBoard();
    const path = tracePath(0, 6);
    assert.equal(path.edges.length, 6, "traced a 6-edge path");
    for (const eid of path.edges) board.edges[eid]!.road = { owner: 0 };
    assert.equal(computeLongestRoadLength(geo, board, 0), 6);

    board.vertices[path.vertices[3]!]!.building = { owner: 1, type: "settlement" };
    const split = computeLongestRoadLength(geo, board, 0);
    assert.ok(split < 6, "opponent building severs the road");
    assert.equal(split, 3, "severed length is the longer remaining segment");
  });
});

// =============================================================================
describe("catan engine: setup", () => {
  it("createInitialGameState is deterministic for a given seed", () => {
    const a = createInitialGameState(geo, { numPlayers: 4, seed: 12345 });
    const b = createInitialGameState(geo, { numPlayers: 4, seed: 12345 });
    assert.deepEqual(a, b);
  });

  it("rejects player counts outside 2-6 (2 = plain house rules)", () => {
    assert.throws(() => createInitialGameState(geo, { numPlayers: 1 }));
    assert.throws(() => createInitialGameState(geo, { numPlayers: 7 }));
    const plain = createInitialGameState(geo, { numPlayers: 2, seed: 5 });
    assert.equal(plain.players.length, 2, "plain 2p: just the two humans");
    assert.deepEqual(plain.neutralPlayerIds, []);
    assert.equal(plain.twoPlayerVariant, false);
  });

  it("plain 2-player games use the standard flow (no variant mechanics)", () => {
    let s = createInitialGameState(geo, { numPlayers: 2, seed: 6 });
    assert.deepEqual(s.setupSequence, [0, 1, 1, 0]);
    assert.equal(s.players[0]!.tradeTokens, 0, "no trade tokens");
    assert.equal(s.board.vertices.filter((v) => v.building).length, 0, "no pre-placed settlements");
    let guard = 0;
    while ((s.phase === "setupSettlement" || s.phase === "setupRoad") && guard++ < 60) {
      if (s.phase === "setupSettlement")
        s = reduce(geo, s, { type: "placeSetupSettlement", vertex: getValidInitialSettlements(geo, s.board)[0]! });
      else
        s = reduce(geo, s, {
          type: "placeSetupRoad",
          edge: getValidRoads(geo, s.board, s.currentPlayer, { setupVertex: s.lastSettlementVertex! })[0]!,
        });
    }
    assert.equal(s.phase, "preRoll");
    s = reduce(geo, s, { type: "rollDice", dice: [2, 3] }, TRUST); // 5
    assert.equal(s.phase, "main", "ONE roll per turn — straight to main");
    // a road build owes nothing to anyone
    s.players[0]!.hand = { ...emptyBag(), lumber: 1, brick: 1 };
    s = reduce(geo, s, { type: "buildRoad", edge: getValidRoads(geo, s.board, 0)[0]! });
    assert.equal(s.phase, "main", "no neutral-build obligation");
    s = reduce(geo, s, { type: "endTurn" });
    assert.equal(s.currentPlayer, 1, "plain rotation between the two humans");
    assert.equal(tryReduce(geo, s, { type: "playForcedTrade" }).ok, false, "no token actions");
  });

  it("terrain, numbers, robber and ports are dealt correctly", () => {
    const state = createInitialGameState(geo, { numPlayers: 4, seed: 42, numbers: "balanced" });
    const terrainCounts: Record<string, number> = {};
    state.board.hexes.forEach((h) => (terrainCounts[h.terrain] = (terrainCounts[h.terrain] ?? 0) + 1));
    assert.equal(Object.values(terrainCounts).reduce((a, b) => a + b, 0), 19);
    assert.equal(terrainCounts["desert"], 1);
    assert.equal(state.board.hexes.filter((h) => h.numberToken !== null).length, 18);
    assert.equal(state.board.hexes[state.board.robberHex]!.terrain, "desert");
    assert.equal(state.board.ports.length, 9);

    // balanced mode: no two red numbers adjacent
    for (const h of geo.hexes) {
      const n = state.board.hexes[h.id]!.numberToken;
      if (n !== 6 && n !== 8) continue;
      for (const nb of h.neighbors) {
        const m = state.board.hexes[nb]!.numberToken;
        assert.ok(m !== 6 && m !== 8, `red ${n} on hex ${h.id} adjacent to red ${m} on hex ${nb}`);
      }
    }
  });

  it("port layout: 4 generic + one 2:1 per resource, never adjacent; variablePorts keeps the multiset", () => {
    const s = setupGame(4, 11);
    const counts: Record<string, number> = {};
    s.board.ports.forEach((p) => (counts[p.type] = (counts[p.type] ?? 0) + 1));
    assert.equal(counts["generic"], 4);
    for (const r of RESOURCES) assert.equal(counts[r], 1);
    const allVerts = s.board.ports.flatMap((p) => p.vertices);
    assert.equal(new Set(allVerts).size, allVerts.length, "no two harbours share a vertex");

    const v1 = setupGame(4, 11, { variablePorts: true });
    const counts2: Record<string, number> = {};
    v1.board.ports.forEach((p) => (counts2[p.type] = (counts2[p.type] ?? 0) + 1));
    assert.equal(counts2["generic"], 4);
    for (const r of RESOURCES) assert.equal(counts2[r], 1);
  });

  it("snake draft completes: 8 settlements/roads for 4 players, starting resources from the 2nd settlement", () => {
    const state = setupGame(4, 42);
    assert.equal(state.setupSequence.length, 0);
    assert.equal(state.phase, "preRoll");
    assert.equal(state.board.vertices.filter((v) => v.building?.type === "settlement").length, 8);
    assert.equal(state.board.edges.filter((e) => e.road).length, 8);
    assert.ok(state.players.some((p) => RESOURCES.some((r) => p.hand[r] > 0)), "someone got starting resources");
    assert.ok(state.players.map((p) => victoryPoints(state, p.id)).every((v) => v === 2), "each player has 2 VP");
  });

  it("spiral mode lays the exact A-R sequence in a ring spiral, skipping the desert", () => {
    const state = createInitialGameState(geo, { numPlayers: 4, seed: 7, numbers: "spiral" });
    const laid = state.board.hexes
      .map((h) => h.numberToken)
      .filter((n): n is number => n !== null);
    assert.equal(laid.length, 18);
    assert.deepEqual([...laid].sort((a, b) => a - b), [...SPIRAL_NUMBER_SEQUENCE].sort((a, b) => a - b), "token multiset");

    // the board must equal the sequence laid along the spiral from SOME corner
    const matchesCorner = (corner: number): boolean => {
      let i = 0;
      for (const hid of spiralHexOrder(geo, corner)) {
        const hex = state.board.hexes[hid]!;
        if (hex.terrain === "desert") {
          if (hex.numberToken !== null) return false;
          continue;
        }
        if (hex.numberToken !== SPIRAL_NUMBER_SEQUENCE[i % SPIRAL_NUMBER_SEQUENCE.length]) return false;
        i++;
      }
      return i === 18;
    };
    assert.ok([0, 1, 2, 3, 4, 5].some(matchesCorner), "board is an A-R spiral from one of the six corners");

    // the canonical sequence never puts 6 next to 8
    for (const h of geo.hexes) {
      const n = state.board.hexes[h.id]!.numberToken;
      if (n !== 6 && n !== 8) continue;
      for (const nb of h.neighbors) {
        const m = state.board.hexes[nb]!.numberToken;
        assert.ok(m !== 6 && m !== 8, "spiral placed adjacent reds");
      }
    }

    // deterministic per seed
    const again = createInitialGameState(geo, { numPlayers: 4, seed: 7, numbers: "spiral" });
    assert.deepEqual(again.board.hexes, state.board.hexes);
  });

  it("startingPlayer leads the snake and takes the first turn; rotation continues in seat order", () => {
    const s0 = createInitialGameState(geo, { numPlayers: 4, seed: 3, startingPlayer: 2 });
    assert.deepEqual(s0.setupSequence, [2, 3, 0, 1, 1, 0, 3, 2]);
    assert.equal(s0.currentPlayer, 2);

    let s = setupGame(4, 3, { startingPlayer: 2 });
    assert.equal(s.currentPlayer, 2, "snake leader rolls first");
    const seen: number[] = [s.currentPlayer];
    for (let i = 0; i < 3; i++) {
      s = reduce(geo, s, { type: "rollDice", dice: [5, 4] }, TRUST);
      s = reduce(geo, s, { type: "endTurn" });
      seen.push(s.currentPlayer);
    }
    assert.deepEqual(seen, [2, 3, 0, 1], "rotation follows seat order from the starting player");

    assert.throws(() => createInitialGameState(geo, { numPlayers: 4, startingPlayer: 4 }));
    assert.throws(() => createInitialGameState(geo, { numPlayers: 4, startingPlayer: -1 }));
  });
});

// =============================================================================
describe("catan engine: turn flow", () => {
  it("plays through rolls, a 7, and a clean rotation", () => {
    let state = setupGame(4, 42);

    // Turn A: non-7 -> main, endTurn advances
    state = reduce(geo, state, { type: "rollDice", dice: [3, 2] }, TRUST); // 5
    assert.equal(state.phase, "main");
    state = reduce(geo, state, { type: "endTurn" });
    assert.equal(state.currentPlayer, 1);

    // Turn B: a 7 walks the robber sub-flow
    state = reduce(geo, state, { type: "rollDice", dice: [3, 4] }, TRUST); // 7
    assert.ok(state.phase === "discard" || state.phase === "moveRobber");
    state = resolveRobberIfNeeded(state);
    assert.equal(state.phase, "main");
    state = reduce(geo, state, { type: "endTurn" });

    // rotation wraps after a full cycle
    const rotationStart = state.currentPlayer;
    for (let i = 0; i < 4; i++) {
      state = reduce(geo, state, { type: "rollDice", dice: [2, 2] }, TRUST); // 4
      if (state.phase !== "main") state = resolveRobberIfNeeded(state);
      state = reduce(geo, state, { type: "endTurn" });
    }
    assert.equal(state.currentPlayer, rotationStart);
    assert.equal(state.winner, null);

    // rolling outside preRoll is rejected
    state = reduce(geo, state, { type: "rollDice", dice: [2, 3] }, TRUST); // -> main
    assert.throws(() => reduce(geo, state, { type: "rollDice", dice: [1, 1] }));
  });

  it("knight before the roll returns to preRoll; a 7 then runs a second robber the same turn", () => {
    let s = setupGame(4, 14);
    assert.equal(s.phase, "preRoll");
    s.players[0]!.devCards.push(devCard("knight"));
    s = reduce(geo, s, { type: "playKnight" });
    assert.equal(s.phase, "moveRobber", "knight before the roll opens the robber");
    const robber1 = s.board.robberHex;
    s = reduce(geo, s, { type: "moveRobber", hex: geo.hexes.find((h) => h.id !== robber1)!.id });
    if (s.phase === "steal") s = reduce(geo, s, { type: "steal", target: getStealTargets(s, geo)[0] ?? null });
    assert.equal(s.phase, "preRoll", "after the knight robber, play returns to preRoll");
    assert.equal(s.players[0]!.knightsPlayed, 1);

    s = reduce(geo, s, { type: "rollDice", dice: [3, 4] }, TRUST); // 7
    assert.ok(s.phase === "discard" || s.phase === "moveRobber", "the 7 opens the robber again");
    s = resolveRobberIfNeeded(s);
    assert.equal(s.phase, "main", "second robber resolves back to main");
  });
});

// =============================================================================
describe("catan engine: actions", () => {
  function freshMain(): GameState {
    const s = setupGame(4, 7);
    const out = reduce(geo, s, { type: "rollDice", dice: [2, 3] }, TRUST); // 5
    assert.equal(out.phase, "main");
    assert.equal(out.currentPlayer, 0);
    return out;
  }

  it("maritime trade at 4:1 with no ports", () => {
    const s = freshMain();
    s.board.ports = [];
    s.players[0]!.hand = { ...emptyBag(), brick: 5 };
    const bankBrick = s.bank.brick;
    const bankOre = s.bank.ore;
    const out = reduce(geo, s, { type: "maritimeTrade", give: "brick", receive: "ore" });
    assert.equal(out.players[0]!.hand.brick, 1);
    assert.equal(out.players[0]!.hand.ore, 1);
    assert.equal(out.bank.brick, bankBrick + 4);
    assert.equal(out.bank.ore, bankOre - 1);

    const t = freshMain();
    t.board.ports = [];
    t.players[0]!.hand = { ...emptyBag(), brick: 3 };
    assert.throws(() => reduce(geo, t, { type: "maritimeTrade", give: "brick", receive: "ore" }));
  });

  it("maritime trade honours 3:1 and 2:1 ports", () => {
    const s = freshMain();
    const myVerts = s.board.vertices
      .map((v, i) => ({ v, i }))
      .filter(({ v }) => v.building?.owner === 0)
      .map(({ i }) => i);
    s.board.ports = [
      { type: "generic", vertices: [myVerts[0]!] },
      { type: "ore", vertices: [myVerts[1]!] },
    ];
    s.players[0]!.hand = { ...emptyBag(), grain: 3, ore: 2 };
    let out = reduce(geo, s, { type: "maritimeTrade", give: "grain", receive: "wool" });
    assert.ok(out.players[0]!.hand.grain === 0 && out.players[0]!.hand.wool === 1, "3:1 generic");
    out = reduce(geo, out, { type: "maritimeTrade", give: "ore", receive: "brick" });
    assert.ok(out.players[0]!.hand.ore === 0 && out.players[0]!.hand.brick === 1, "2:1 ore");
  });

  it("monopoly drains every opponent, not the bank", () => {
    const s = freshMain();
    s.players[0]!.devCards.push(devCard("monopoly"));
    s.players[0]!.hand = emptyBag();
    s.players[1]!.hand = { ...emptyBag(), ore: 2 };
    s.players[2]!.hand = { ...emptyBag(), ore: 3 };
    s.players[3]!.hand = { ...emptyBag(), ore: 1 };
    const bankOre = s.bank.ore;
    const out = reduce(geo, s, { type: "playMonopoly", resource: "ore" });
    assert.equal(out.players[0]!.hand.ore, 6);
    assert.ok([1, 2, 3].every((i) => out.players[i]!.hand.ore === 0));
    assert.equal(out.bank.ore, bankOre);
  });

  it("year of plenty takes what the bank can supply", () => {
    const s = freshMain();
    s.players[0]!.devCards.push(devCard("yearOfPlenty"));
    s.players[0]!.hand = emptyBag();
    const bL = s.bank.lumber;
    const bB = s.bank.brick;
    const out = reduce(geo, s, { type: "playYearOfPlenty", resources: ["lumber", "brick"] });
    assert.ok(out.players[0]!.hand.lumber === 1 && out.players[0]!.hand.brick === 1);
    assert.ok(out.bank.lumber === bL - 1 && out.bank.brick === bB - 1);

    const t = freshMain();
    t.players[0]!.devCards.push(devCard("yearOfPlenty"));
    t.players[0]!.hand = emptyBag();
    t.bank.ore = 1;
    const out2 = reduce(geo, t, { type: "playYearOfPlenty", resources: ["ore", "ore"] });
    assert.equal(out2.players[0]!.hand.ore, 1, "takes only what the bank has");
    assert.equal(out2.bank.ore, 0);

    const u = freshMain();
    u.players[0]!.devCards.push(devCard("yearOfPlenty"));
    u.players[0]!.hand = emptyBag();
    u.bank.ore = 0;
    const out3 = reduce(geo, u, { type: "playYearOfPlenty", resources: ["ore", "wool"] });
    assert.ok(out3.players[0]!.hand.wool === 1 && out3.players[0]!.hand.ore === 0, "skips the empty pile");
  });

  it("road building grants two free roads and spends nothing", () => {
    const s = freshMain();
    s.players[0]!.devCards.push(devCard("roadBuilding"));
    const handBefore = { ...s.players[0]!.hand };
    let out = reduce(geo, s, { type: "playRoadBuilding" });
    assert.equal(out.freeRoads, 2);
    out = reduce(geo, out, { type: "buildRoad", edge: getValidRoads(geo, out.board, 0)[0]! });
    assert.equal(out.freeRoads, 1);
    out = reduce(geo, out, { type: "buildRoad", edge: getValidRoads(geo, out.board, 0)[0]! });
    assert.equal(out.freeRoads, 0);
    assert.ok(RESOURCES.every((k) => out.players[0]!.hand[k] === handBefore[k]), "free roads cost nothing");
  });

  it("the third knight claims Largest Army (+2 VP)", () => {
    const s = freshMain();
    s.players[0]!.knightsPlayed = 2;
    s.players[0]!.devCards.push(devCard("knight"));
    const vpBefore = victoryPoints(s, 0);
    const out = reduce(geo, s, { type: "playKnight" });
    assert.equal(out.phase, "moveRobber");
    assert.equal(out.players[0]!.knightsPlayed, 3);
    assert.equal(out.largestArmyHolder, 0);
    assert.equal(victoryPoints(out, 0), vpBefore + 2);
  });

  it("dev cards: not the turn they were bought, and only one per turn", () => {
    const s = freshMain();
    s.players[0]!.devCards.push({ type: "knight", boughtThisTurn: true, played: false });
    assert.throws(() => reduce(geo, s, { type: "playKnight" }), /bought this turn/);

    const t = freshMain();
    t.players[0]!.devCards.push(devCard("knight"), devCard("knight"));
    let out = reduce(geo, t, { type: "playKnight" });
    out = reduce(geo, out, { type: "moveRobber", hex: geo.hexes.find((h) => h.id !== out.board.robberHex)!.id });
    if (out.phase === "steal") out = reduce(geo, out, { type: "steal", target: getStealTargets(out, geo)[0] ?? null });
    assert.equal(out.phase, "main");
    assert.throws(() => reduce(geo, out, { type: "playKnight" }), /one development card/);
  });

  it("city upgrade: piece accounting, +1 VP, cost to the bank", () => {
    const s = toMain(setupGame(4, 12));
    const mySettlement = s.board.vertices.findIndex((v) => v.building?.owner === 0 && v.building.type === "settlement");
    s.players[0]!.hand = { ...emptyBag(), ore: 3, grain: 2 };
    const cityBefore = s.players[0]!.piecesLeft.cities;
    const settBefore = s.players[0]!.piecesLeft.settlements;
    const vpBefore = victoryPoints(s, 0);
    const bankOre = s.bank.ore;
    const bankGrain = s.bank.grain;
    const out = reduce(geo, s, { type: "buildCity", vertex: mySettlement });
    assert.equal(out.board.vertices[mySettlement]!.building?.type, "city");
    assert.equal(out.players[0]!.piecesLeft.cities, cityBefore - 1);
    assert.equal(out.players[0]!.piecesLeft.settlements, settBefore + 1);
    assert.equal(victoryPoints(out, 0), vpBefore + 1);
    assert.ok(out.bank.ore === bankOre + 3 && out.bank.grain === bankGrain + 2);
  });

  it("reaching 10 VP on your own action ends the game at once", () => {
    const s = freshMain();
    s.longestRoadHolder = 0;
    s.largestArmyHolder = 0;
    s.players[0]!.knightsPlayed = 3;
    for (let i = 0; i < 4; i++) s.players[0]!.devCards.push(devCard("victoryPoint"));
    s.players[0]!.devCards.push(devCard("knight"));
    assert.equal(victoryPoints(s, 0), 10);
    const out = reduce(geo, s, { type: "playKnight" });
    assert.equal(out.phase, "gameOver");
    assert.equal(out.winner, 0);
  });

  it("buying the 10th-point VP card wins on the purchase turn", () => {
    const s = freshMain();
    s.longestRoadHolder = 0;
    s.largestArmyHolder = 0;
    s.players[0]!.knightsPlayed = 3;
    for (let i = 0; i < 3; i++) s.players[0]!.devCards.push(devCard("victoryPoint"));
    s.devDeck = ["victoryPoint", ...s.devDeck];
    s.players[0]!.hand = { ...emptyBag(), ore: 1, wool: 1, grain: 1 };
    assert.equal(victoryPoints(s, 0), 9);
    const out = reduce(geo, s, { type: "buyDevCard" });
    assert.ok(out.winner === 0 && out.phase === "gameOver");
  });
});

// =============================================================================
describe("catan engine: longest road transfer / tie / removal", () => {
  function withBlankBoard(s: GameState): GameState {
    s.board.vertices = geo.vertices.map(() => ({ building: null, portId: null }));
    s.board.edges = geo.edges.map(() => ({ road: null }));
    return s;
  }

  it("a strictly-longer rival takes the card", () => {
    const s = withBlankBoard(setupGame(3, 5));
    const p0 = tracePath(0, 5);
    p0.edges.forEach((e) => (s.board.edges[e]!.road = { owner: 0 }));
    updateLongestRoad(s, geo);
    assert.equal(s.longestRoadHolder, 0);
    const start = geo.vertices.find((v) => v.id > 25)!.id;
    const p1 = tracePath(start, 6);
    p1.edges.forEach((e) => (s.board.edges[e]!.road = { owner: 1 }));
    updateLongestRoad(s, geo);
    assert.equal(s.longestRoadHolder, 1);
    assert.ok(victoryPoints(s, 1) >= 2);
  });

  it("a tie does NOT steal the card from the holder", () => {
    const s = withBlankBoard(setupGame(3, 6));
    const a = tracePath(0, 6);
    a.edges.forEach((e) => (s.board.edges[e]!.road = { owner: 0 }));
    updateLongestRoad(s, geo);
    assert.equal(s.longestRoadHolder, 0);
    const start = geo.vertices.find((v) => v.id > 25)!.id;
    const b = tracePath(start, 6);
    b.edges.forEach((e) => (s.board.edges[e]!.road = { owner: 1 }));
    updateLongestRoad(s, geo);
    assert.equal(s.longestRoadHolder, 0, "holder keeps the card on a tie");
  });

  it("dropping below 5 sets the card aside", () => {
    const s = withBlankBoard(setupGame(3, 7));
    const a = tracePath(0, 5);
    a.edges.forEach((e) => (s.board.edges[e]!.road = { owner: 0 }));
    updateLongestRoad(s, geo);
    assert.equal(s.longestRoadHolder, 0);
    s.board.edges[a.edges[2]!]!.road = null;
    assert.ok(computeLongestRoadLength(geo, s.board, 0) < 5);
    updateLongestRoad(s, geo);
    assert.equal(s.longestRoadHolder, null);
  });
});

// =============================================================================
describe("catan engine: bank scarcity", () => {
  function isolate(s: GameState, token: number): { hex: number; verts: VertexId[] } {
    s.board.hexes.forEach((h) => (h.numberToken = 3));
    s.board.vertices = geo.vertices.map(() => ({ building: null, portId: null }));
    s.board.edges = geo.edges.map(() => ({ road: null }));
    const hex = geo.hexes.find((h) => h.vertices.length === 6)!.id;
    s.board.hexes[hex]!.terrain = "forest";
    s.board.hexes[hex]!.numberToken = token;
    s.board.robberHex = geo.hexes.find((h) => h.id !== hex)!.id;
    const vs = geo.hexes[hex]!.vertices;
    const a = vs[0]!;
    const b = vs.find((v) => !geo.vertices[a]!.neighbors.includes(v) && v !== a)!;
    return { hex, verts: [a, b] };
  }

  it("two claimants and not enough for all -> nobody receives", () => {
    const s = setupGame(3, 9);
    const { verts } = isolate(s, 8);
    s.board.vertices[verts[0]!]!.building = { owner: 0, type: "settlement" };
    s.board.vertices[verts[1]!]!.building = { owner: 1, type: "settlement" };
    s.players.forEach((p) => (p.hand = emptyBag()));
    s.bank.lumber = 1;
    s.phase = "preRoll";
    s.currentPlayer = 0;
    const out = reduce(geo, s, { type: "rollDice", dice: [4, 4] }, TRUST); // 8
    assert.ok(out.players[0]!.hand.lumber === 0 && out.players[1]!.hand.lumber === 0);
    assert.equal(out.bank.lumber, 1, "the scarce pile is untouched");
  });

  it("a single claimant takes what remains", () => {
    const s = setupGame(3, 10);
    const { verts } = isolate(s, 8);
    s.board.vertices[verts[0]!]!.building = { owner: 0, type: "city" }; // demands 2
    s.players.forEach((p) => (p.hand = emptyBag()));
    s.bank.lumber = 1;
    s.phase = "preRoll";
    s.currentPlayer = 0;
    const out = reduce(geo, s, { type: "rollDice", dice: [4, 4] }, TRUST); // 8
    assert.equal(out.players[0]!.hand.lumber, 1);
    assert.equal(out.bank.lumber, 0);
  });
});

// =============================================================================
describe("catan engine: trust boundary, typed errors, redaction, replay", () => {
  it("untrusted rolls ignore client-supplied dice", () => {
    const base = setupGame(4, 15);
    const trusted = reduce(geo, base, { type: "rollDice", dice: [5, 4] }, TRUST);
    assert.ok(trusted.dice![0] === 5 && trusted.dice![1] === 4);
    const a = reduce(geo, base, { type: "rollDice", dice: [1, 1] });
    const b = reduce(geo, base, { type: "rollDice", dice: [6, 6] });
    assert.deepEqual(a.dice, b.dice, "RNG-driven, identical from identical state");
    assert.ok(!(a.dice![0] === 1 && a.dice![1] === 1) || !(b.dice![0] === 6 && b.dice![1] === 6));
  });

  it("tryReduce returns typed errors instead of throwing", () => {
    const s = setupGame(4, 16);
    const bad = tryReduce(geo, s, { type: "buildCity", vertex: 0 });
    assert.equal(bad.ok, false);
    assert.ok(bad.ok === false && typeof bad.error === "string" && bad.error.length > 0);
    const good = tryReduce(geo, s, { type: "rollDice", dice: [5, 4] }, TRUST);
    assert.ok(good.ok === true && good.state.phase === "main");
  });

  it("viewForPlayer redacts opponents and the deck", () => {
    const s = toMain(setupGame(4, 17));
    s.players[1]!.hand = { ...emptyBag(), ore: 3, wool: 1 };
    s.players[1]!.devCards.push(devCard("knight"));
    const view = viewForPlayer(s, 0);
    assert.ok(view.players[0]!.hand !== undefined, "viewer sees their own hand");
    assert.equal(view.players[1]!.hand, undefined, "opponent hand hidden");
    assert.equal(view.players[1]!.handSize, 4, "hand size still public");
    assert.ok(view.players[1]!.devCards === undefined && view.players[1]!.devCardCount === 1);
    assert.ok(view.devDeckCount === s.devDeck.length && !("devDeck" in view));
    assert.ok(!("rngState" in view));
    assert.equal(view.board.hexes.length, s.board.hexes.length, "board is public");
  });

  it("serialize/deserialize round-trips and the action log replays exactly", () => {
    let s = createInitialGameState(geo, { numPlayers: 4, seed: 21, numbers: "balanced" });
    const initial = serialize(s);
    let g = 0;
    while ((s.phase === "setupSettlement" || s.phase === "setupRoad") && g++ < 300) {
      if (s.phase === "setupSettlement")
        s = reduce(geo, s, { type: "placeSetupSettlement", vertex: getValidInitialSettlements(geo, s.board)[0]! });
      else
        s = reduce(geo, s, {
          type: "placeSetupRoad",
          edge: getValidRoads(geo, s.board, s.currentPlayer, { setupVertex: s.lastSettlementVertex! })[0]!,
        });
    }
    for (let i = 0; i < 12; i++) {
      s = reduce(geo, s, { type: "rollDice" }); // untrusted -> RNG
      s = resolveRobberIfNeeded(s);
      if (s.phase === "main") s = reduce(geo, s, { type: "endTurn" });
    }
    const roundtrip = deserialize(serialize(s));
    assert.deepEqual(roundtrip, s);

    const replayed = replay(geo, deserialize(initial), actionsFromLog(s));
    assert.deepEqual(replayed, s);
  });
});

// =============================================================================
describe("catan engine: domestic trade", () => {
  it("propose -> accept -> confirm swaps the resources", () => {
    let s = toMain(setupGame(4, 22));
    s.players[0]!.hand = { ...emptyBag(), ore: 2 };
    s.players[2]!.hand = { ...emptyBag(), wool: 3 };
    s = reduce(geo, s, { type: "proposeDomesticTrade", give: { ore: 2 }, receive: { wool: 2 } });
    assert.ok(s.pendingTrade !== null && s.pendingTrade.proposer === 0);
    s = reduce(geo, s, { type: "respondDomesticTrade", player: 2, accept: true });
    assert.ok(s.pendingTrade!.acceptances.includes(2));
    s = reduce(geo, s, { type: "confirmDomesticTrade", partner: 2 });
    assert.ok(s.players[0]!.hand.ore === 0 && s.players[0]!.hand.wool === 2);
    assert.ok(s.players[2]!.hand.wool === 1 && s.players[2]!.hand.ore === 2);
    assert.equal(s.pendingTrade, null);
  });

  it("tracks declines symmetrically and lets candidates change their answer", () => {
    let s = toMain(setupGame(4, 26));
    s.players[0]!.hand = { ...emptyBag(), ore: 1 };
    s.players[1]!.hand = { ...emptyBag(), wool: 1 };
    s = reduce(geo, s, { type: "proposeDomesticTrade", give: { ore: 1 }, receive: { wool: 1 } });
    assert.deepEqual(s.pendingTrade!.declines, [], "a fresh offer has no declines");

    // decline without ever accepting (the playtest bug path)
    s = reduce(geo, s, { type: "respondDomesticTrade", player: 1, accept: false });
    assert.deepEqual(s.pendingTrade!.declines, [1]);
    assert.deepEqual(s.pendingTrade!.acceptances, []);

    // idempotent re-decline
    s = reduce(geo, s, { type: "respondDomesticTrade", player: 1, accept: false });
    assert.deepEqual(s.pendingTrade!.declines, [1], "no duplicates");

    // change of mind: decline -> accept moves between the lists
    s = reduce(geo, s, { type: "respondDomesticTrade", player: 1, accept: true });
    assert.deepEqual(s.pendingTrade!.declines, []);
    assert.deepEqual(s.pendingTrade!.acceptances, [1]);

    // ...and back again
    s = reduce(geo, s, { type: "respondDomesticTrade", player: 1, accept: false });
    assert.deepEqual(s.pendingTrade!.declines, [1]);
    assert.deepEqual(s.pendingTrade!.acceptances, []);

    // a declined candidate has NOT accepted: confirm is still rejected
    assert.equal(tryReduce(geo, s, { type: "confirmDomesticTrade", partner: 1 }).ok, false);

    // declines survive the per-action clone (a second candidate responds)
    s = reduce(geo, s, { type: "respondDomesticTrade", player: 2, accept: true });
    assert.deepEqual(s.pendingTrade!.declines, [1], "clone preserved the declines list");
  });

  it("guards: no unaccepted confirm, no gifts, partner must cover", () => {
    let s2 = toMain(setupGame(4, 23));
    s2.players[0]!.hand = { ...emptyBag(), ore: 1 };
    s2.players[1]!.hand = { ...emptyBag(), wool: 1 };
    s2 = reduce(geo, s2, { type: "proposeDomesticTrade", give: { ore: 1 }, receive: { wool: 1 } });
    assert.equal(tryReduce(geo, s2, { type: "confirmDomesticTrade", partner: 1 }).ok, false);

    const s3 = toMain(setupGame(4, 24));
    s3.players[0]!.hand = { ...emptyBag(), ore: 1 };
    assert.equal(tryReduce(geo, s3, { type: "proposeDomesticTrade", give: { ore: 1 }, receive: {} }).ok, false);

    let s4 = toMain(setupGame(4, 25));
    s4.players[0]!.hand = { ...emptyBag(), ore: 1 };
    s4.players[1]!.hand = emptyBag();
    s4 = reduce(geo, s4, { type: "proposeDomesticTrade", give: { ore: 1 }, receive: { wool: 1 } });
    s4 = reduce(geo, s4, { type: "respondDomesticTrade", player: 1, accept: true });
    assert.equal(tryReduce(geo, s4, { type: "confirmDomesticTrade", partner: 1 }).ok, false);
  });
});

// =============================================================================
describe("catan engine: special building phase (dormant 5-6p support)", () => {
  it("3-4 player games have no special build phase", () => {
    let s4 = toMain(setupGame(4, 18));
    s4 = reduce(geo, s4, { type: "endTurn" });
    assert.ok(s4.phase === "preRoll" && s4.specialBuilder === null);
    assert.equal(s4.currentPlayer, 1);
  });

  it("5-player games run a build round between turns", () => {
    let s5 = toMain(setupGame(5, 19));
    s5 = reduce(geo, s5, { type: "endTurn" });
    assert.equal(s5.phase, "specialBuild");
    assert.ok(s5.currentPlayer === 0 && s5.specialBuilder === 1);
    assert.deepEqual(s5.specialBuildQueue, [1, 2, 3, 4]);
    s5.players[1]!.hand = { ...emptyBag(), lumber: 1, brick: 1 };
    const road = getValidRoads(geo, s5.board, 1)[0]!;
    s5 = reduce(geo, s5, { type: "buildRoad", edge: road });
    assert.equal(s5.board.edges[road]!.road?.owner, 1);
    s5 = reduce(geo, s5, { type: "endSpecialBuild" });
    assert.equal(s5.specialBuilder, 2);
    s5 = reduce(geo, s5, { type: "endSpecialBuild" });
    s5 = reduce(geo, s5, { type: "endSpecialBuild" });
    s5 = reduce(geo, s5, { type: "endSpecialBuild" });
    assert.ok(s5.phase === "preRoll" && s5.currentPlayer === 1 && s5.specialBuilder === null);
  });

  it("a player can win during their special building window", () => {
    let w = toMain(setupGame(5, 20));
    w = reduce(geo, w, { type: "endTurn" });
    w.longestRoadHolder = 1;
    w.largestArmyHolder = 1;
    w.players[1]!.knightsPlayed = 3;
    for (let i = 0; i < 3; i++) w.players[1]!.devCards.push(devCard("victoryPoint"));
    w.devDeck = ["victoryPoint", ...w.devDeck];
    w.players[1]!.hand = { ...emptyBag(), ore: 1, wool: 1, grain: 1 };
    assert.equal(victoryPoints(w, 1), 9);
    const out = reduce(geo, w, { type: "buyDevCard" });
    assert.ok(out.winner === 1 && out.phase === "gameOver");
  });
});

// =============================================================================
describe("catan engine: cross-turn win via Longest Road transfer", () => {
  it("registers only at the start of the beneficiary's own turn", () => {
    let s = toMain(setupGame(4, 31));
    s.board.vertices = geo.vertices.map(() => ({ building: null, portId: null }));
    for (const v of [0, 2, 4, 6]) s.board.vertices[v]!.building = { owner: 0, type: "city" }; // 8 VP
    s.longestRoadHolder = 0; // transfer that just happened on player 2's turn
    s.currentPlayer = 2;
    s.phase = "main";
    s.winner = null;
    assert.equal(victoryPoints(s, 0), 10);
    assert.ok(s.winner === null && s.phase === "main", "no win on an opponent's turn");
    s = reduce(geo, s, { type: "endTurn" }); // -> player 3
    s = reduce(geo, s, { type: "rollDice", dice: [5, 4] }, TRUST);
    s = reduce(geo, s, { type: "endTurn" }); // -> startTurn(0) detects the win
    assert.ok(s.winner === 0 && s.phase === "gameOver");
  });
});

// =============================================================================
describe("catan engine: property test (random legal playouts)", function () {
  this.timeout(120000);

  function invariantsOk(s: GameState, where: string): void {
    for (const r of RESOURCES) {
      let total = s.bank[r];
      for (const p of s.players) total += p.hand[r];
      assert.equal(total, 19, `[${where}] conservation broken for ${r}`);
      assert.ok(s.bank[r] >= 0, `[${where}] negative bank ${r}`);
    }
    for (const p of s.players) {
      for (const r of RESOURCES) assert.ok(p.hand[r] >= 0, `[${where}] negative hand p${p.id} ${r}`);
      assert.ok(
        p.piecesLeft.roads >= 0 && p.piecesLeft.settlements >= 0 && p.piecesLeft.cities >= 0,
        `[${where}] negative pieces p${p.id}`,
      );
    }
    if (s.phase !== "gameOver") {
      for (const p of s.players)
        assert.ok(victoryPoints(s, p.id) < WINNING_VP, `[${where}] missed win: p${p.id} at ${victoryPoints(s, p.id)} VP`);
    }
  }

  it("80 randomized games (3-6 players) never break conservation, limits, or win detection", () => {
    const mulberry = (a: number) => () => {
      a |= 0;
      a = (a + 0x6d2b79f5) | 0;
      let t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };

    let finished = 0;
    for (let seed = 1; seed <= 80; seed++) {
      const rng = mulberry(seed * 2654435761);
      const numPlayers = 3 + (seed % 4); // 3..6 (exercises the special building phase too)
      let s: GameState = createInitialGameState(geo, { numPlayers, seed, numbers: "balanced" });
      let g = 0;
      while ((s.phase === "setupSettlement" || s.phase === "setupRoad") && g++ < 400) {
        if (s.phase === "setupSettlement")
          s = reduce(geo, s, { type: "placeSetupSettlement", vertex: getValidInitialSettlements(geo, s.board)[0]! });
        else
          s = reduce(geo, s, {
            type: "placeSetupRoad",
            edge: getValidRoads(geo, s.board, s.currentPlayer, { setupVertex: s.lastSettlementVertex! })[0]!,
          });
      }

      let step = 0;
      while (s.phase !== "gameOver" && step++ < 600) {
        invariantsOk(s, `seed${seed}`);
        const acting = s.phase === "specialBuild" ? s.specialBuilder! : s.currentPlayer;
        const p = s.players[acting]!;
        const can = (c: Partial<Record<Resource, number>>) => RESOURCES.every((r) => p.hand[r] >= (c[r] ?? 0));
        const playable = (t: string) => p.devCards.some((c) => c.type === t && !c.played && !c.boughtThisTurn);
        const x = rng();

        switch (s.phase) {
          case "preRoll": {
            if (x < 0.15 && playable("knight") && !s.devCardPlayedThisTurn) s = reduce(geo, s, { type: "playKnight" });
            else s = reduce(geo, s, { type: "rollDice" });
            break;
          }
          case "discard": {
            const pid = +Object.keys(s.pendingDiscards)[0]!;
            const owed = s.pendingDiscards[pid]!;
            const pp = s.players[pid]!;
            const cards: Partial<Record<Resource, number>> = {};
            let need = owed;
            for (const r of RESOURCES)
              while (pp.hand[r] - (cards[r] ?? 0) > 0 && need > 0) {
                cards[r] = (cards[r] ?? 0) + 1;
                need--;
              }
            s = reduce(geo, s, { type: "discard", player: pid, cards });
            break;
          }
          case "moveRobber": {
            s = reduce(geo, s, { type: "moveRobber", hex: geo.hexes.find((h) => h.id !== s.board.robberHex)!.id });
            break;
          }
          case "steal": {
            s = reduce(geo, s, { type: "steal", target: getStealTargets(s, geo)[0] ?? null });
            break;
          }
          case "main":
          case "specialBuild": {
            const cities = getValidCities(s.board, acting);
            const setts = getValidSettlements(geo, s.board, acting);
            const roads = getValidRoads(geo, s.board, acting);
            const inMain = s.phase === "main";
            let acted = false;
            if (s.freeRoads > 0) {
              if (roads.length && p.piecesLeft.roads > 0) s = reduce(geo, s, { type: "buildRoad", edge: roads[0]! });
              else if (inMain) s = reduce(geo, s, { type: "endTurn" });
              else s = reduce(geo, s, { type: "endSpecialBuild" });
              break;
            }
            if (inMain && !s.devCardPlayedThisTurn && x < 0.12 && playable("monopoly")) {
              s = reduce(geo, s, { type: "playMonopoly", resource: RESOURCES[(rng() * 5) | 0]! });
              break;
            }
            if (inMain && !s.devCardPlayedThisTurn && x < 0.18 && playable("yearOfPlenty")) {
              s = reduce(geo, s, { type: "playYearOfPlenty", resources: [RESOURCES[(rng() * 5) | 0]!, RESOURCES[(rng() * 5) | 0]!] });
              break;
            }
            if (inMain && !s.devCardPlayedThisTurn && x < 0.24 && playable("roadBuilding")) {
              s = reduce(geo, s, { type: "playRoadBuilding" });
              break;
            }
            if (inMain && !s.devCardPlayedThisTurn && x < 0.3 && playable("knight")) {
              s = reduce(geo, s, { type: "playKnight" });
              break;
            }
            if (x < 0.45 && cities.length && can({ ore: 3, grain: 2 }) && p.piecesLeft.cities > 0) {
              s = reduce(geo, s, { type: "buildCity", vertex: cities[0]! });
              acted = true;
            } else if (x < 0.62 && setts.length && can({ lumber: 1, brick: 1, wool: 1, grain: 1 }) && p.piecesLeft.settlements > 0) {
              s = reduce(geo, s, { type: "buildSettlement", vertex: setts[0]! });
              acted = true;
            } else if (x < 0.78 && roads.length && can({ lumber: 1, brick: 1 }) && p.piecesLeft.roads > 0) {
              s = reduce(geo, s, { type: "buildRoad", edge: roads[0]! });
              acted = true;
            } else if (x < 0.88 && can({ ore: 1, wool: 1, grain: 1 }) && s.devDeck.length) {
              s = reduce(geo, s, { type: "buyDevCard" });
              acted = true;
            } else if (inMain && x < 0.94) {
              const give = RESOURCES.find((r) => p.hand[r] >= 4);
              const recv = RESOURCES.find((r) => r !== give && s.bank[r] > 0);
              if (give && recv) {
                s = reduce(geo, s, { type: "maritimeTrade", give, receive: recv });
                acted = true;
              }
            }
            if (!acted) s = reduce(geo, s, { type: inMain ? "endTurn" : "endSpecialBuild" });
            break;
          }
          default:
            s = reduce(geo, s, { type: "endTurn" });
        }
      }
      invariantsOk(s, `seed${seed}-final`);
      if (s.phase === "gameOver") finished++;
    }
    assert.ok(finished > 0, "at least some random games reach a natural win");
  });
});

// =============================================================================
// "CATAN for Two" — the official 2-player variant
// =============================================================================

/** Variant game with setup driven to completion (first legal options). */
function setup2p(seed: number, extra: Partial<CatanEngine.NewGameOptions> = {}): GameState {
  let s: GameState = createInitialGameState(geo, {
    numPlayers: 2,
    seed,
    numbers: "balanced",
    twoPlayerVariant: true,
    ...extra,
  });
  let guard = 0;
  while ((s.phase === "setupSettlement" || s.phase === "setupRoad") && guard++ < 60) {
    if (s.phase === "setupSettlement") {
      s = reduce(geo, s, { type: "placeSetupSettlement", vertex: getValidInitialSettlements(geo, s.board)[0]! });
    } else {
      s = reduce(geo, s, {
        type: "placeSetupRoad",
        edge: getValidRoads(geo, s.board, s.currentPlayer, { setupVertex: s.lastSettlementVertex! })[0]!,
      });
    }
  }
  return s;
}

/** Complete the variant's double roll with two non-7, different sums. */
function to2pMain(s: GameState): GameState {
  s = reduce(geo, s, { type: "rollDice", dice: [2, 3] }, TRUST); // 5 -> back to preRoll
  return reduce(geo, s, { type: "rollDice", dice: [3, 3] }, TRUST); // 6 -> main
}

describe("catan engine: CATAN for Two — setup & neutrals", () => {
  it("gates the player counts: the variant needs exactly 2 players", () => {
    assert.throws(() => createInitialGameState(geo, { numPlayers: 3, twoPlayerVariant: true }));
    assert.throws(() => createInitialGameState(geo, { numPlayers: 4, twoPlayerVariant: true }));
    const s = createInitialGameState(geo, { numPlayers: 2, twoPlayerVariant: true, seed: 1 });
    assert.equal(s.players.length, 4, "2 humans + 2 neutral piece sets");
    assert.deepEqual(s.neutralPlayerIds, [2, 3]);
  });

  it("neutrals start with 1 settlement each (no road) on the symmetric default vertices", () => {
    const s = createInitialGameState(geo, { numPlayers: 2, twoPlayerVariant: true, seed: 2 });
    const [vA, vB] = defaultNeutralSetupVertices(geo);
    assert.equal(s.board.vertices[vA]!.building?.owner, 2);
    assert.equal(s.board.vertices[vB]!.building?.owner, 3);
    assert.equal(s.board.vertices[vA]!.building?.type, "settlement");
    assert.equal(s.players[2]!.piecesLeft.settlements, 4);
    assert.equal(s.players[3]!.piecesLeft.settlements, 4);
    assert.equal(s.board.edges.filter((e) => e.road).length, 0, "no neutral roads");
    // the default spots are interior, point-symmetric, and mutually distant
    const a = geo.vertices[vA]!;
    const b = geo.vertices[vB]!;
    assert.equal(a.hexes.length, 3);
    assert.equal(b.hexes.length, 3);
    assert.ok(Math.abs(a.point.x + b.point.x) < 1e-6 && Math.abs(a.point.y + b.point.y) < 1e-6);
  });

  it("neutral settlements block the distance rule for humans", () => {
    const s = createInitialGameState(geo, { numPlayers: 2, twoPlayerVariant: true, seed: 3 });
    const [vA] = defaultNeutralSetupVertices(geo);
    const valid = getValidInitialSettlements(geo, s.board);
    assert.ok(!valid.includes(vA), "occupied vertex is invalid");
    for (const n of geo.vertices[vA]!.neighbors) assert.ok(!valid.includes(n), `neighbor ${n} must be blocked`);
  });

  it("humans start with 5 trade tokens each; the supply holds the other 10", () => {
    const s = createInitialGameState(geo, { numPlayers: 2, twoPlayerVariant: true, seed: 4 });
    assert.equal(s.players[0]!.tradeTokens, 5);
    assert.equal(s.players[1]!.tradeTokens, 5);
    assert.equal(s.players[2]!.tradeTokens, 0);
    assert.equal(s.tokenSupply, TWO_PLAYER_TOKEN_SUPPLY - 10);
  });

  it("setup settlements earn tokens: coast +1, desert +2, both +3 (supply-capped)", () => {
    // white-box the terrain so the awards are deterministic, then drive setup
    const base = createInitialGameState(geo, { numPlayers: 2, twoPlayerVariant: true, seed: 5 });
    base.board.hexes.forEach((h) => {
      h.terrain = "fields";
      h.numberToken = 5;
    });
    const tip = (cube: { x: number; y: number; z: number }) => {
      const hex = geo.hexes.find((h) => h.cube.x === cube.x && h.cube.y === cube.y && h.cube.z === cube.z)!;
      return { hex, vertex: hex.vertices.find((v) => geo.vertices[v]!.hexes.length === 1)! };
    };
    // a desert tip hex -> its lone-corner vertex is coastal AND desert-adjacent
    const desertTip = tip({ x: 2, y: -2, z: 0 });
    base.board.hexes[desertTip.hex.id]!.terrain = "desert";
    base.board.hexes[desertTip.hex.id]!.numberToken = null;
    // a plain tip on the far side stays "fields" -> coastal only
    const plainTip = tip({ x: -2, y: 2, z: 0 });

    // P0 settles the desert+coast tip: +3
    let s = reduce(geo, base, { type: "placeSetupSettlement", vertex: desertTip.vertex });
    assert.equal(s.players[0]!.tradeTokens, 8);
    assert.equal(s.tokenSupply, 7);
    s = reduce(geo, s, {
      type: "placeSetupRoad",
      edge: getValidRoads(geo, s.board, 0, { setupVertex: desertTip.vertex })[0]!,
    });
    // P1 settles the plain coastal tip: +1
    s = reduce(geo, s, { type: "placeSetupSettlement", vertex: plainTip.vertex });
    assert.equal(s.players[1]!.tradeTokens, 6);
    // P1 again (snake): an interior, non-desert vertex: +0
    s = reduce(geo, s, {
      type: "placeSetupRoad",
      edge: getValidRoads(geo, s.board, 1, { setupVertex: plainTip.vertex })[0]!,
    });
    const interior = getValidInitialSettlements(geo, s.board).find(
      (v) => geo.vertices[v]!.hexes.length === 3 && geo.vertices[v]!.hexes.every((h) => s.board.hexes[h]!.terrain !== "desert"),
    )!;
    s = reduce(geo, s, { type: "placeSetupSettlement", vertex: interior });
    assert.equal(s.players[1]!.tradeTokens, 6, "interior non-desert vertex earns nothing");

    // supply cap: drain the supply, then settle another desert+coast tip
    s = reduce(geo, s, { type: "placeSetupRoad", edge: getValidRoads(geo, s.board, 1, { setupVertex: interior })[0]! });
    s.tokenSupply = 1;
    const desertTip2 = tip({ x: 0, y: -2, z: 2 });
    s.board.hexes[desertTip2.hex.id]!.terrain = "desert";
    s.board.hexes[desertTip2.hex.id]!.numberToken = null;
    s = reduce(geo, s, { type: "placeSetupSettlement", vertex: desertTip2.vertex });
    assert.equal(s.players[0]!.tradeTokens, 8 + 1, "+3 owed but only 1 token left in the supply");
    assert.equal(s.tokenSupply, 0);
  });
});

describe("catan engine: CATAN for Two — double roll", () => {
  it("rolls twice per turn; the second result must differ; production resolves each roll", () => {
    let s = setup2p(6);
    assert.equal(s.phase, "preRoll");
    s = reduce(geo, s, { type: "rollDice", dice: [2, 3] }, TRUST); // 5
    assert.equal(s.phase, "preRoll", "back for the second roll");
    assert.equal(s.rollsThisTurn, 1);
    assert.deepEqual(s.firstDice, [2, 3]);
    assert.throws(() => reduce(geo, s, { type: "rollDice", dice: [4, 1] }, TRUST), /differ/, "same sum (5) rejected");
    s = reduce(geo, s, { type: "rollDice", dice: [3, 3] }, TRUST); // 6
    assert.equal(s.phase, "main");
    assert.equal(s.rollsThisTurn, 2);
    assert.throws(() => reduce(geo, s, { type: "rollDice", dice: [2, 2] }, TRUST), /start of your turn/, "no third roll");
    // turn rotation skips the neutral seats entirely
    s = reduce(geo, s, { type: "endTurn" });
    assert.equal(s.currentPlayer, 1);
    s = to2pMain(s);
    s = reduce(geo, s, { type: "endTurn" });
    assert.equal(s.currentPlayer, 0);
  });

  it("a 7 on the first roll resolves the whole robber flow, then returns for roll #2", () => {
    let s = setup2p(7);
    s.players[0]!.hand = { ...emptyBag(), wool: 4, grain: 4 }; // 8 cards -> owes 4 on a 7
    s = reduce(geo, s, { type: "rollDice", dice: [3, 4] }, TRUST); // 7 on roll #1
    assert.equal(s.phase, "discard");
    s = reduce(geo, s, { type: "discard", player: 0, cards: { wool: 2, grain: 2 } });
    assert.equal(s.phase, "moveRobber");
    s = reduce(geo, s, { type: "moveRobber", hex: geo.hexes.find((h) => h.id !== s.board.robberHex)!.id });
    if (s.phase === "steal") s = reduce(geo, s, { type: "steal", target: getStealTargets(s, geo)[0] ?? null });
    assert.equal(s.phase, "preRoll", "after the robber, the SECOND roll is still owed");
    assert.equal(s.rollsThisTurn, 1);
    s = reduce(geo, s, { type: "rollDice", dice: [2, 2] }, TRUST); // differs from 7
    assert.equal(s.phase, "main");
  });

  it("a knight may be played between the two rolls", () => {
    let s = setup2p(8);
    s.players[0]!.devCards.push({ type: "knight", boughtThisTurn: false, played: false });
    s = reduce(geo, s, { type: "rollDice", dice: [2, 3] }, TRUST); // roll #1
    s = reduce(geo, s, { type: "playKnight" });
    assert.equal(s.phase, "moveRobber");
    s = reduce(geo, s, { type: "moveRobber", hex: geo.hexes.find((h) => h.id !== s.board.robberHex)!.id });
    if (s.phase === "steal") s = reduce(geo, s, { type: "steal", target: getStealTargets(s, geo)[0] ?? null });
    assert.equal(s.phase, "preRoll", "knight resolved between the rolls");
    s = reduce(geo, s, { type: "rollDice", dice: [3, 3] }, TRUST);
    assert.equal(s.phase, "main");
  });

  it("untrusted second rolls re-roll until the sum differs", () => {
    for (let seed = 50; seed < 70; seed++) {
      let s = setup2p(seed);
      s = reduce(geo, s, { type: "rollDice" });
      // resolve a possible 7 (hands are tiny after setup; no discards possible)
      if (s.phase === "moveRobber") {
        s = reduce(geo, s, { type: "moveRobber", hex: geo.hexes.find((h) => h.id !== s.board.robberHex)!.id });
        if (s.phase === "steal") s = reduce(geo, s, { type: "steal", target: getStealTargets(s, geo)[0] ?? null });
      }
      const first = s.firstDice![0] + s.firstDice![1];
      s = reduce(geo, s, { type: "rollDice" });
      if (s.phase === "moveRobber") {
        s = reduce(geo, s, { type: "moveRobber", hex: geo.hexes.find((h) => h.id !== s.board.robberHex)!.id });
        if (s.phase === "steal") s = reduce(geo, s, { type: "steal", target: getStealTargets(s, geo)[0] ?? null });
      }
      const second = s.dice![0] + s.dice![1];
      assert.notEqual(second, first, `seed ${seed}: second roll repeated the first`);
    }
  });
});

describe("catan engine: CATAN for Two — neutral build obligation", () => {
  it("a human road owes a neutral build; human actions wait until it is placed", () => {
    let s = to2pMain(setup2p(9));
    s.players[0]!.hand = { ...emptyBag(), lumber: 2, brick: 2 };
    const myRoad = getValidRoads(geo, s.board, 0)[0]!;
    s = reduce(geo, s, { type: "buildRoad", edge: myRoad });
    assert.equal(s.phase, "neutralBuild");
    assert.equal(s.pendingNeutralBuilds, 1);
    assert.throws(() => reduce(geo, s, { type: "buildRoad", edge: getValidRoads(geo, s.board, 0)[0]! }), /neutral piece first/);
    assert.throws(() => reduce(geo, s, { type: "endTurn" }));
    // a fresh neutral has no roads -> no legal neutral settlement anywhere
    assert.equal(getValidSettlements(geo, s.board, 2).length, 0);
    assert.equal(
      tryReduce(geo, s, { type: "buildNeutral", neutralId: 0, kind: "settlement", vertex: 10 }).ok,
      false,
      "settlement with no neutral road network is illegal",
    );
    const nRoad = getValidRoads(geo, s.board, 2)[0]!;
    s = reduce(geo, s, { type: "buildNeutral", neutralId: 0, kind: "road", edge: nRoad });
    assert.equal(s.board.edges[nRoad]!.road?.owner, 2);
    assert.equal(s.players[2]!.piecesLeft.roads, 14);
    assert.equal(s.phase, "main");
    assert.equal(s.pendingNeutralBuilds, 0);
  });

  it("a human settlement owes a neutral build too; cities and dev cards do not", () => {
    let s = to2pMain(setup2p(10));
    // city: no obligation
    const myCity = getValidCities(s.board, 0)[0]!;
    s.players[0]!.hand = { ...emptyBag(), ore: 3, grain: 2 };
    s = reduce(geo, s, { type: "buildCity", vertex: myCity });
    assert.equal(s.phase, "main", "a city build owes nothing");
    // dev card: no obligation
    s.players[0]!.hand = { ...emptyBag(), ore: 1, wool: 1, grain: 1 };
    s = reduce(geo, s, { type: "buyDevCard" });
    assert.equal(s.phase, "main", "a dev-card buy owes nothing");
    // settlement: obligation
    s.players[0]!.hand = { ...emptyBag(), lumber: 2, brick: 2, wool: 1, grain: 1 };
    let road = getValidRoads(geo, s.board, 0)[0]!;
    s = reduce(geo, s, { type: "buildRoad", edge: road });
    s = reduce(geo, s, { type: "buildNeutral", neutralId: 1, kind: "road", edge: getValidRoads(geo, s.board, 3)[0]! });
    const spot = getValidSettlements(geo, s.board, 0)[0];
    if (spot !== undefined) {
      s = reduce(geo, s, { type: "buildSettlement", vertex: spot });
      assert.equal(s.phase, "neutralBuild", "a settlement build owes a neutral build");
    }
  });

  it("Road Building's two free roads owe two neutral builds, resolved one at a time", () => {
    let s = to2pMain(setup2p(11));
    s.players[0]!.devCards.push({ type: "roadBuilding", boughtThisTurn: false, played: false });
    s = reduce(geo, s, { type: "playRoadBuilding" });
    assert.equal(s.freeRoads, 2);
    s = reduce(geo, s, { type: "buildRoad", edge: getValidRoads(geo, s.board, 0)[0]! });
    assert.equal(s.phase, "neutralBuild");
    s = reduce(geo, s, { type: "buildNeutral", neutralId: 0, kind: "road", edge: getValidRoads(geo, s.board, 2)[0]! });
    assert.equal(s.phase, "main");
    assert.equal(s.freeRoads, 1);
    s = reduce(geo, s, { type: "buildRoad", edge: getValidRoads(geo, s.board, 0)[0]! });
    assert.equal(s.phase, "neutralBuild");
    s = reduce(geo, s, { type: "buildNeutral", neutralId: 1, kind: "road", edge: getValidRoads(geo, s.board, 3)[0]! });
    assert.equal(s.phase, "main");
    assert.equal(s.freeRoads, 0);
  });

  it("the obligation lapses when neither neutral has any legal placement", () => {
    let s = to2pMain(setup2p(12));
    s.players[2]!.piecesLeft = { roads: 0, settlements: 0, cities: 0 };
    s.players[3]!.piecesLeft = { roads: 0, settlements: 0, cities: 0 };
    s.players[0]!.hand = { ...emptyBag(), lumber: 1, brick: 1 };
    s = reduce(geo, s, { type: "buildRoad", edge: getValidRoads(geo, s.board, 0)[0]! });
    assert.equal(s.phase, "main", "no neutral options -> play continues");
    assert.equal(s.pendingNeutralBuilds, 0);
  });

  it("a neutral can take Longest Road (denying the humans)", () => {
    const s = to2pMain(setup2p(13));
    // hand neutral 2 a 5-chain by the white-box route
    const start = geo.vertices.find((v) => s.board.vertices[v.id]!.building?.owner === 2)!.id;
    let cur = start;
    const seen = new Set([cur]);
    for (let i = 0; i < 5; i++) {
      const step = geo.vertices[cur]!.edges
        .map((eid) => {
          const [a, b] = geo.edges[eid]!.vertices;
          return { eid, w: a === cur ? b : a };
        })
        .find((o) => !seen.has(o.w) && !s.board.edges[o.eid]!.road && !s.board.vertices[o.w]!.building);
      if (!step) break;
      s.board.edges[step.eid]!.road = { owner: 2 };
      seen.add(step.w);
      cur = step.w;
    }
    updateLongestRoad(s, geo);
    if (computeLongestRoadLength(geo, s.board, 2) >= 5) {
      assert.equal(s.longestRoadHolder, 2, "the neutral holds Longest Road");
      assert.ok(victoryPoints(s, 0) < 10 && s.winner === null);
    }
  });

  it("neutrals never receive resources from production", () => {
    let s = setup2p(14);
    // give neutral 2's settlement hex a known token and roll it
    const nVertex = s.board.vertices.findIndex((v) => v.building?.owner === 2);
    const hex = geo.vertices[nVertex]!.hexes[0]!;
    s.board.hexes[hex]!.terrain = "forest";
    s.board.hexes[hex]!.numberToken = 4;
    if (s.board.robberHex === hex) s.board.robberHex = geo.hexes.find((h) => h.id !== hex)!.id;
    s = reduce(geo, s, { type: "rollDice", dice: [2, 2] }, TRUST); // 4
    assert.ok(RESOURCES.every((r) => s.players[2]!.hand[r] === 0), "neutral hand stays empty");
    assert.ok(RESOURCES.every((r) => s.players[3]!.hand[r] === 0));
  });
});

describe("catan engine: CATAN for Two — trade tokens", () => {
  it("forced trade: pay 1 when not ahead, draw 2 random cards, give exactly 2 back", () => {
    let s = to2pMain(setup2p(15));
    s.players[0]!.tradeTokens = 5; // setup coast/desert earnings vary by seed; normalize
    s.players[1]!.tradeTokens = 5;
    s.players[0]!.hand = { ...emptyBag(), wool: 2 };
    s.players[1]!.hand = { ...emptyBag(), ore: 3 };
    const supply = s.tokenSupply;
    s = reduce(geo, s, { type: "playForcedTrade" });
    assert.equal(s.players[0]!.tradeTokens, 4, "equal public VP -> costs 1");
    assert.equal(s.tokenSupply, supply + 1);
    assert.equal(s.phase, "forcedTradeGive");
    assert.equal(s.players[0]!.hand.ore, 2, "drew 2 of the opponent's only resource");
    assert.equal(s.players[1]!.hand.ore, 1);
    assert.throws(() => reduce(geo, s, { type: "forcedTradeGiveBack", cards: { wool: 1 } }), /exactly 2/);
    assert.throws(() => reduce(geo, s, { type: "endTurn" }), /main phase/);
    s = reduce(geo, s, { type: "forcedTradeGiveBack", cards: { wool: 2 } });
    assert.equal(s.phase, "main");
    assert.equal(s.players[1]!.hand.wool, 2);
    assert.equal(CatanEngine.handCount(s.players[0]!), 2, "net hand size unchanged (took 2, gave 2)");
  });

  it("forced trade edges: 1-card opponent still costs you 2 back; 0-card opponent is illegal", () => {
    let s = to2pMain(setup2p(16));
    s.players[0]!.hand = { ...emptyBag(), wool: 3 };
    s.players[1]!.hand = { ...emptyBag(), brick: 1 };
    s = reduce(geo, s, { type: "playForcedTrade" });
    assert.equal(s.players[0]!.hand.brick, 1, "took the single card");
    s = reduce(geo, s, { type: "forcedTradeGiveBack", cards: { wool: 2 } });
    assert.equal(CatanEngine.handCount(s.players[1]!), 2);

    s.players[1]!.hand = emptyBag();
    assert.equal(tryReduce(geo, s, { type: "playForcedTrade" }).ok, false, "no cards to take");

    // 1 own card + the 1 taken = exactly 2 to give back -> still legal
    s.players[0]!.hand = { ...emptyBag(), wool: 1 };
    s.players[1]!.hand = { ...emptyBag(), ore: 1 };
    s.players[0]!.tradeTokens = 5;
    assert.equal(tryReduce(geo, s, { type: "playForcedTrade" }).ok, true);

    // but with NO cards of your own against a 1-card opponent you cannot give 2
    s.players[0]!.hand = emptyBag();
    assert.equal(tryReduce(geo, s, { type: "playForcedTrade" }).ok, false);
  });

  it("token actions cost 2 once you lead on public VP; hidden VP cards do not count", () => {
    let s = to2pMain(setup2p(17));
    s.players[0]!.tradeTokens = 5; // normalize away seed-dependent setup earnings
    s.players[1]!.tradeTokens = 5;
    // P0 leads publicly (extra settlement white-boxed in)
    const spot = getValidInitialSettlements(geo, s.board)[0]!;
    s.board.vertices[spot]!.building = { owner: 0, type: "settlement" };
    s.players[0]!.hand = { ...emptyBag(), wool: 2 };
    s.players[1]!.hand = { ...emptyBag(), ore: 2 };
    // hidden VP cards for P1 do NOT change the comparison
    s.players[1]!.devCards.push({ type: "victoryPoint", boughtThisTurn: false, played: false });
    s.players[1]!.devCards.push({ type: "victoryPoint", boughtThisTurn: false, played: false });
    s = reduce(geo, s, { type: "playForcedTrade" });
    assert.equal(s.players[0]!.tradeTokens, 3, "ahead on public VP -> costs 2");
    s = reduce(geo, s, { type: "forcedTradeGiveBack", cards: { wool: 2 } });

    // tokens run out -> the action is rejected
    s.players[0]!.tradeTokens = 1;
    assert.equal(tryReduce(geo, s, { type: "playForcedTrade" }).ok, false, "cannot afford the 2-token price");
  });

  it("the token robber goes to the desert only, with no steal", () => {
    let s = to2pMain(setup2p(18));
    s.players[0]!.tradeTokens = 5; // normalize away seed-dependent setup earnings
    s.players[1]!.tradeTokens = 5;
    const desert = s.board.hexes.findIndex((h) => h.terrain === "desert");
    assert.equal(s.board.robberHex, desert, "robber starts on the desert");
    assert.equal(tryReduce(geo, s, { type: "playTokenRobber" }).ok, false, "already there -> useless, rejected");
    s.board.robberHex = geo.hexes.find((h) => h.id !== desert)!.id;
    s.players[1]!.hand = { ...emptyBag(), ore: 2 };
    const before = { ...s.players[0]!.hand };
    s = reduce(geo, s, { type: "playTokenRobber" });
    assert.equal(s.board.robberHex, desert);
    assert.equal(s.players[0]!.tradeTokens, 4);
    assert.deepEqual(s.players[0]!.hand, before, "no steal happened");
    assert.equal(s.phase, "main");
  });

  it("discarding a face-up knight pays 2 tokens, once per turn, and can set Largest Army aside", () => {
    let s = to2pMain(setup2p(19));
    s.players[0]!.tradeTokens = 5; // normalize away seed-dependent setup earnings
    s.players[1]!.tradeTokens = 5;
    const knight = () => ({ type: "knight" as const, boughtThisTurn: false, played: true });
    s.players[0]!.devCards.push(knight(), knight(), knight());
    s.players[0]!.knightsPlayed = 3;
    s.largestArmyHolder = 0;
    const supply = s.tokenSupply;

    s = reduce(geo, s, { type: "discardKnightForTokens" });
    assert.equal(s.players[0]!.knightsPlayed, 2);
    assert.equal(s.players[0]!.tradeTokens, 7);
    assert.equal(s.tokenSupply, supply - 2);
    assert.equal(s.largestArmyHolder, null, "dropping below 3 sets Largest Army aside");
    assert.equal(tryReduce(geo, s, { type: "discardKnightForTokens" }).ok, false, "once per turn");

    // opponent reaches 3 knights afterwards and claims the set-aside card
    s.players[1]!.devCards.push({ type: "knight", boughtThisTurn: false, played: false });
    s.players[1]!.knightsPlayed = 2;
    s = reduce(geo, s, { type: "endTurn" });
    s = to2pMain(s);
    s = reduce(geo, s, { type: "playKnight" });
    assert.equal(s.players[1]!.knightsPlayed, 3);
    assert.equal(s.largestArmyHolder, 1, "the set-aside card is claimed by the new most-knights player");
  });

  it("knight discard with a higher-army opponent hands Largest Army straight over; ties keep it aside", () => {
    let s = to2pMain(setup2p(20));
    const played = () => ({ type: "knight" as const, boughtThisTurn: false, played: true });
    // me 4 knights (holder), opp 3: discard -> tie at 3 -> I am among leaders -> I KEEP it
    s.players[0]!.devCards.push(played(), played(), played(), played());
    s.players[0]!.knightsPlayed = 4;
    s.players[1]!.knightsPlayed = 3;
    s.largestArmyHolder = 0;
    s = reduce(geo, s, { type: "discardKnightForTokens" });
    assert.equal(s.largestArmyHolder, 0, "holder keeps the card on a tie");
    // next turn: discard again -> 2 vs 3 -> opponent is strictly most with >= 3
    s = reduce(geo, s, { type: "endTurn" });
    s = to2pMain(s);
    s = reduce(geo, s, { type: "endTurn" });
    s = to2pMain(s);
    s = reduce(geo, s, { type: "discardKnightForTokens" });
    assert.equal(s.players[0]!.knightsPlayed, 2);
    assert.equal(s.largestArmyHolder, 1, "opponent with 3 takes the card immediately");
  });
});

// =============================================================================
// robberBounty house rule: steal OR take the tile's resource from the bank
// =============================================================================

describe("catan engine: robberBounty house rule", () => {
  /** A 3p game with the rule on, white-boxed to the moveRobber decision. */
  function atRobber(seed: number, on = true): GameState {
    const s = setupGame(3, seed, { robberBounty: on });
    s.phase = "moveRobber";
    s.robberReturnPhase = "main";
    s.currentPlayer = 0;
    return s;
  }
  /** A hex with a resource, an open bank pile, and no buildings around it. */
  function lonelyResourceHex(s: GameState): number {
    return geo.hexes.find((h) => {
      const hex = s.board.hexes[h.id]!;
      const res = CatanEngine.TERRAIN_RESOURCE[hex.terrain];
      if (h.id === s.board.robberHex || res === null || s.bank[res] <= 0) return false;
      return h.vertices.every((v) => s.board.vertices[v]!.building === null);
    })!.id;
  }

  it("with no one to rob, the mover still gets the take-from-bank choice", () => {
    let s = atRobber(60);
    const hex = lonelyResourceHex(s);
    const res = CatanEngine.TERRAIN_RESOURCE[s.board.hexes[hex]!.terrain]!;
    const bankBefore = s.bank[res];
    const handBefore = s.players[0]!.hand[res];
    s = reduce(geo, s, { type: "moveRobber", hex });
    assert.equal(s.phase, "steal", "stays open for the bounty choice");
    s = reduce(geo, s, { type: "robberTake" });
    assert.equal(s.players[0]!.hand[res], handBefore + 1, "took 1 of the tile's resource");
    assert.equal(s.bank[res], bankBefore - 1, "paid by the bank");
    assert.equal(s.phase, "main");
  });

  it("with someone to rob, the mover chooses: steal or take", () => {
    let s = atRobber(61);
    const hex = lonelyResourceHex(s);
    const res = CatanEngine.TERRAIN_RESOURCE[s.board.hexes[hex]!.terrain]!;
    // park an opponent settlement with cards on the hex
    const v = geo.hexes[hex]!.vertices.find((vv) => s.board.vertices[vv]!.building === null)!;
    s.board.vertices[v]!.building = { owner: 1, type: "settlement" };
    s.players[1]!.hand = { ...emptyBag(), wool: 2 };
    const handBefore = s.players[0]!.hand[res];
    s = reduce(geo, s, { type: "moveRobber", hex });
    assert.equal(s.phase, "steal");
    assert.deepEqual(getStealTargets(s, geo), [1], "the normal steal is still on the table");
    const taken = reduce(geo, s, { type: "robberTake" });
    assert.equal(taken.players[0]!.hand[res], handBefore + 1, "…but the mover may take the tile resource instead");
    assert.equal(taken.players[1]!.hand.wool, 2, "no card was stolen");
    const stolen = reduce(geo, s, { type: "steal", target: 1 });
    assert.equal(handCountOf(stolen.players[1]!), 1, "…or steal normally");
  });

  it("no bounty from the desert or an empty bank pile; rule off rejects robberTake", () => {
    // desert: no resource -> robber resolves immediately when no targets
    let s = atRobber(62);
    s.players.forEach((p) => (p.hand = emptyBag())); // empty hands = no steal targets anywhere
    const desert = s.board.hexes.findIndex((h) => h.terrain === "desert");
    if (s.board.robberHex === desert) s.board.robberHex = geo.hexes.find((h) => h.id !== desert)!.id;
    const out = reduce(geo, s, { type: "moveRobber", hex: desert });
    assert.equal(out.phase, "main", "desert offers nothing to take");

    // empty bank pile: the take option vanishes
    let t = atRobber(63);
    const hex = lonelyResourceHex(t);
    const res = CatanEngine.TERRAIN_RESOURCE[t.board.hexes[hex]!.terrain]!;
    t.bank[res] = 0;
    const out2 = reduce(geo, t, { type: "moveRobber", hex });
    assert.equal(out2.phase, "main", "no bank cards -> nothing to take");

    // rule off: classic behavior, robberTake is illegal
    let u = atRobber(64, false);
    const hex2 = lonelyResourceHex(u);
    const out3 = reduce(geo, u, { type: "moveRobber", hex: hex2 });
    assert.equal(out3.phase, "main", "no targets and no rule -> robber just resolves");
    u = atRobber(65, false);
    const lh = lonelyResourceHex(u);
    const vtx = geo.hexes[lh]!.vertices[0]!;
    u.board.vertices[vtx]!.building = { owner: 1, type: "settlement" };
    u.players[1]!.hand = { ...emptyBag(), ore: 1 };
    u = reduce(geo, u, { type: "moveRobber", hex: lh });
    assert.equal(u.phase, "steal");
    assert.equal(tryReduce(geo, u, { type: "robberTake" }).ok, false, "robberTake needs the house rule");
  });

  it("policies handle the bounty: with no targets they take instead of stalling", () => {
    const s = atRobber(66);
    const hex = lonelyResourceHex(s);
    const inSteal = reduce(geo, s, { type: "moveRobber", hex });
    assert.equal(inSteal.phase, "steal");
    assert.deepEqual(getStealTargets(inSteal, geo), []);
    assert.deepEqual(new RandomPolicy(1).act(geo, inSteal, 0), { type: "robberTake" });
    assert.deepEqual(new GreedyPolicy(1).act(geo, inSteal, 0), { type: "robberTake" });
  });
});

function handCountOf(p: CatanEngine.PlayerState): number {
  return RESOURCES.reduce((t, r) => t + p.hand[r], 0);
}

// =============================================================================
// Policies (the bot/ghost brains the room will use)
// =============================================================================

describe("catan engine: policies", function () {
  this.timeout(120000);

  /** Whose decision is it right now (first owing seat during discards)? */
  function actingSeat(s: GameState): number {
    if (s.phase === "discard") return +Object.keys(s.pendingDiscards)[0]!;
    return actingId(s);
  }

  function checkInvariants(s: GameState, where: string): void {
    for (const r of RESOURCES) {
      let total = s.bank[r];
      for (const p of s.players) total += p.hand[r];
      assert.equal(total, 19, `[${where}] conservation broken for ${r}`);
    }
    if (s.twoPlayerVariant) {
      const tokens = s.players.reduce((t, p) => t + p.tradeTokens, 0) + s.tokenSupply;
      assert.equal(tokens, TWO_PLAYER_TOKEN_SUPPLY, `[${where}] token conservation broken`);
      for (const nid of s.neutralPlayerIds) {
        assert.ok(RESOURCES.every((r) => s.players[nid]!.hand[r] === 0), `[${where}] neutral hand not empty`);
        assert.equal(s.players[nid]!.tradeTokens, 0, `[${where}] neutral holds tokens`);
      }
    }
    if (s.phase !== "gameOver") {
      for (const p of s.players) {
        if (s.neutralPlayerIds.includes(p.id)) continue;
        assert.ok(victoryPoints(s, p.id) < WINNING_VP, `[${where}] missed win for p${p.id}`);
      }
    }
  }

  it("greedy bots finish full 3p and 4p games within bounds", () => {
    for (const [numPlayers, seed] of [[3, 101], [4, 102], [3, 103], [4, 104]] as const) {
      let s = createInitialGameState(geo, { numPlayers, seed, numbers: "spiral" });
      const bots = Array.from({ length: numPlayers }, (_, i) => new GreedyPolicy(seed ^ (i * 0x9e3779b9)));
      let steps = 0;
      while (s.phase !== "gameOver" && steps++ < 4000) {
        const seat = actingSeat(s);
        s = reduce(geo, s, bots[seat]!.act(geo, s, seat));
        if (steps % 25 === 0) checkInvariants(s, `greedy-${numPlayers}p-${seed}`);
      }
      assert.equal(s.phase, "gameOver", `greedy ${numPlayers}p game (seed ${seed}) must reach a win, took ${steps} steps`);
      assert.ok(s.winner !== null && victoryPoints(s, s.winner) >= WINNING_VP);
      checkInvariants(s, "greedy-final");
    }
  });

  it("greedy bots finish a full 2-player variant game (neutral builds, double rolls, tokens)", () => {
    for (const seed of [201, 202, 203]) {
      let s = createInitialGameState(geo, { numPlayers: 2, seed, numbers: "spiral", twoPlayerVariant: true });
      const bots = [new GreedyPolicy(seed), new GreedyPolicy(seed ^ 0x55aa55aa)];
      let steps = 0;
      while (s.phase !== "gameOver" && steps++ < 6000) {
        const seat = actingSeat(s);
        assert.ok(!s.neutralPlayerIds.includes(seat), "a neutral seat must never be asked to act");
        s = reduce(geo, s, bots[seat]!.act(geo, s, seat));
        if (steps % 25 === 0) checkInvariants(s, `greedy-2p-${seed}`);
      }
      assert.equal(s.phase, "gameOver", `greedy 2p game (seed ${seed}) must reach a win, took ${steps} steps`);
      assert.ok(s.winner === 0 || s.winner === 1, "only a human can win");
      checkInvariants(s, "greedy-2p-final");
    }
  });

  it("the random ghost keeps any seat alive without ever making an illegal move", () => {
    // one greedy seat (so the game progresses) + two random ghosts
    let s = createInitialGameState(geo, { numPlayers: 3, seed: 301, numbers: "balanced" });
    const brains: Policy[] = [new GreedyPolicy(301), new RandomPolicy(302), new RandomPolicy(303)];
    let steps = 0;
    while (s.phase !== "gameOver" && steps++ < 1500) {
      const seat = actingSeat(s);
      const out = tryReduce(geo, s, brains[seat]!.act(geo, s, seat));
      assert.ok(out.ok, `policy produced an illegal action at step ${steps}: ${out.ok === false ? out.error : ""}`);
      s = out.state;
    }
    checkInvariants(s, "ghost-mixed");

    // and in the 2p variant (ghost must handle neutralBuild + forcedTradeGive forms)
    let v = createInitialGameState(geo, { numPlayers: 2, seed: 304, numbers: "balanced", twoPlayerVariant: true });
    const vb: Policy[] = [new GreedyPolicy(305), new RandomPolicy(306)];
    steps = 0;
    while (v.phase !== "gameOver" && steps++ < 2500) {
      const seat = actingSeat(v);
      const out = tryReduce(geo, v, vb[seat]!.act(geo, v, seat));
      assert.ok(out.ok, `2p policy illegal action at step ${steps}: ${out.ok === false ? out.error : ""}`);
      v = out.state;
    }
    checkInvariants(v, "ghost-2p");
  });
});

type Policy = CatanEngine.Policy;

// =============================================================================
describe("catan engine: CATAN for Two — property test", function () {
  this.timeout(120000);

  it("40 randomized variant games keep every invariant (resources, tokens, neutrals, wins)", () => {
    const mulberry = (a: number) => () => {
      a |= 0;
      a = (a + 0x6d2b79f5) | 0;
      let t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };

    function invariants(s: GameState, where: string): void {
      for (const r of RESOURCES) {
        let total = s.bank[r];
        for (const p of s.players) total += p.hand[r];
        assert.equal(total, 19, `[${where}] conservation ${r}`);
        assert.ok(s.bank[r] >= 0, `[${where}] negative bank`);
      }
      const tokens = s.players.reduce((t, p) => t + p.tradeTokens, 0) + s.tokenSupply;
      assert.equal(tokens, TWO_PLAYER_TOKEN_SUPPLY, `[${where}] token conservation`);
      for (const p of s.players) {
        assert.ok(RESOURCES.every((r) => p.hand[r] >= 0), `[${where}] negative hand`);
        assert.ok(p.tradeTokens >= 0, `[${where}] negative tokens`);
        assert.ok(
          p.piecesLeft.roads >= 0 && p.piecesLeft.settlements >= 0 && p.piecesLeft.cities >= 0,
          `[${where}] negative pieces`,
        );
      }
      for (const nid of s.neutralPlayerIds) {
        assert.ok(RESOURCES.every((r) => s.players[nid]!.hand[r] === 0), `[${where}] neutral got resources`);
        assert.equal(s.players[nid]!.devCards.length, 0, `[${where}] neutral got dev cards`);
      }
      if (s.phase !== "gameOver") {
        for (const id of [0, 1]) assert.ok(victoryPoints(s, id) < WINNING_VP, `[${where}] missed win p${id}`);
      } else {
        assert.ok(s.winner === 0 || s.winner === 1, `[${where}] non-human winner`);
      }
    }

    for (let seed = 1; seed <= 40; seed++) {
      const rng = mulberry(seed * 0x85ebca6b);
      let s: GameState = createInitialGameState(geo, { numPlayers: 2, seed, numbers: "balanced", twoPlayerVariant: true });
      let g = 0;
      while ((s.phase === "setupSettlement" || s.phase === "setupRoad") && g++ < 60) {
        if (s.phase === "setupSettlement") {
          const opts = getValidInitialSettlements(geo, s.board);
          s = reduce(geo, s, { type: "placeSetupSettlement", vertex: opts[Math.floor(rng() * opts.length)]! });
        } else {
          const opts = getValidRoads(geo, s.board, s.currentPlayer, { setupVertex: s.lastSettlementVertex! });
          s = reduce(geo, s, { type: "placeSetupRoad", edge: opts[Math.floor(rng() * opts.length)]! });
        }
      }

      let step = 0;
      while (s.phase !== "gameOver" && step++ < 800) {
        invariants(s, `seed${seed}@${step}`);
        const seat = s.phase === "discard" ? +Object.keys(s.pendingDiscards)[0]! : actingId(s);
        const me = s.players[seat]!;
        const afford = (c: Partial<Record<Resource, number>>) => RESOURCES.every((r) => me.hand[r] >= (c[r] ?? 0));
        const playable = (t: string) => me.devCards.some((c) => c.type === t && !c.played && !c.boughtThisTurn);
        const x = rng();

        switch (s.phase) {
          case "preRoll":
            if (x < 0.1 && playable("knight") && !s.devCardPlayedThisTurn) s = reduce(geo, s, { type: "playKnight" });
            else s = reduce(geo, s, { type: "rollDice" });
            break;
          case "discard": {
            const owed = s.pendingDiscards[seat]!;
            const cards: Partial<Record<Resource, number>> = {};
            let need = owed;
            for (const r of RESOURCES)
              while (me.hand[r] - (cards[r] ?? 0) > 0 && need > 0) {
                cards[r] = (cards[r] ?? 0) + 1;
                need--;
              }
            s = reduce(geo, s, { type: "discard", player: seat, cards });
            break;
          }
          case "moveRobber": {
            const hexes = geo.hexes.filter((h) => h.id !== s.board.robberHex);
            s = reduce(geo, s, { type: "moveRobber", hex: hexes[Math.floor(rng() * hexes.length)]!.id });
            break;
          }
          case "steal": {
            const targets = getStealTargets(s, geo);
            s = reduce(geo, s, { type: "steal", target: targets[Math.floor(rng() * targets.length)] ?? null });
            break;
          }
          case "neutralBuild": {
            const options: Array<{ n: 0 | 1; kind: "road" | "settlement"; id: number }> = [];
            s.neutralPlayerIds.forEach((nid, i) => {
              const np = s.players[nid]!;
              if (np.piecesLeft.roads > 0)
                for (const e of getValidRoads(geo, s.board, nid)) options.push({ n: i as 0 | 1, kind: "road", id: e });
              if (np.piecesLeft.settlements > 0)
                for (const vtx of getValidSettlements(geo, s.board, nid))
                  options.push({ n: i as 0 | 1, kind: "settlement", id: vtx });
            });
            const o = options[Math.floor(rng() * options.length)]!;
            s = reduce(
              geo,
              s,
              o.kind === "road"
                ? { type: "buildNeutral", neutralId: o.n, kind: "road", edge: o.id }
                : { type: "buildNeutral", neutralId: o.n, kind: "settlement", vertex: o.id },
            );
            break;
          }
          case "forcedTradeGive": {
            const cards: Partial<Record<Resource, number>> = {};
            let need = 2;
            for (const r of RESOURCES)
              while (me.hand[r] - (cards[r] ?? 0) > 0 && need > 0) {
                cards[r] = (cards[r] ?? 0) + 1;
                need--;
              }
            s = reduce(geo, s, { type: "forcedTradeGiveBack", cards });
            break;
          }
          case "main": {
            const opp = s.players.find((p) => p.id !== seat && !s.neutralPlayerIds.includes(p.id))!;
            const oppHand = RESOURCES.reduce((t, r) => t + opp.hand[r], 0);
            const myHand = RESOURCES.reduce((t, r) => t + me.hand[r], 0);
            const cost = CatanEngine.tokenActionCost(s, seat);
            const cities = getValidCities(s.board, seat);
            const setts = getValidSettlements(geo, s.board, seat);
            const roads = getValidRoads(geo, s.board, seat);
            if (s.freeRoads > 0) {
              if (roads.length && me.piecesLeft.roads > 0) s = reduce(geo, s, { type: "buildRoad", edge: roads[0]! });
              else s = reduce(geo, s, { type: "endTurn" });
              break;
            }
            if (x < 0.08 && me.tradeTokens >= cost && oppHand >= 1 && myHand + Math.min(2, oppHand) >= 2) {
              s = reduce(geo, s, { type: "playForcedTrade" });
            } else if (x < 0.12 && me.tradeTokens >= cost && s.board.robberHex !== s.board.hexes.findIndex((h) => h.terrain === "desert") && s.board.hexes.some((h) => h.terrain === "desert")) {
              s = reduce(geo, s, { type: "playTokenRobber" });
            } else if (x < 0.16 && !s.knightDiscardedThisTurn && me.devCards.some((c) => c.type === "knight" && c.played)) {
              s = reduce(geo, s, { type: "discardKnightForTokens" });
            } else if (x < 0.22 && !s.devCardPlayedThisTurn && playable("knight")) {
              s = reduce(geo, s, { type: "playKnight" });
            } else if (x < 0.26 && !s.devCardPlayedThisTurn && playable("roadBuilding")) {
              s = reduce(geo, s, { type: "playRoadBuilding" });
            } else if (x < 0.45 && cities.length && afford({ ore: 3, grain: 2 }) && me.piecesLeft.cities > 0) {
              s = reduce(geo, s, { type: "buildCity", vertex: cities[0]! });
            } else if (x < 0.6 && setts.length && afford({ lumber: 1, brick: 1, wool: 1, grain: 1 }) && me.piecesLeft.settlements > 0) {
              s = reduce(geo, s, { type: "buildSettlement", vertex: setts[0]! });
            } else if (x < 0.75 && roads.length && afford({ lumber: 1, brick: 1 }) && me.piecesLeft.roads > 0) {
              s = reduce(geo, s, { type: "buildRoad", edge: roads[0]! });
            } else if (x < 0.85 && afford({ ore: 1, wool: 1, grain: 1 }) && s.devDeck.length) {
              s = reduce(geo, s, { type: "buyDevCard" });
            } else {
              s = reduce(geo, s, { type: "endTurn" });
            }
            break;
          }
          default:
            throw new Error(`unexpected phase ${s.phase}`);
        }
      }
      invariants(s, `seed${seed}-final`);
    }
  });
});
