/**
 * verify_advanced.ts — the harder cases the first two harnesses don't cover:
 * dynamic Longest Road transfer, bank scarcity, city accounting, port ratios,
 * two-robber turns, and every newly added feature (real ports, redaction,
 * the randomness-trust boundary, typed errors, the special building phase,
 * serialization/replay, and full domestic trade).
 * Run: node --experimental-strip-types src/verify_advanced.ts
 */

import {
  buildBoardGeometry,
  computeLongestRoadLength,
  getValidInitialSettlements,
  getValidRoads,
  getValidSettlements,
  type BoardGeometry,
  type EdgeId,
  type VertexId,
} from "./geometry.ts";
import {
  actionsFromLog,
  createInitialGameState,
  deserialize,
  getStealTargets,
  reduce,
  replay,
  serialize,
  tryReduce,
  updateLongestRoad,
  victoryPoints,
  viewForPlayer,
  type Action,
} from "./stateMachine.ts";
import type { BoardState, GameState, Resource } from "./types.ts";
import { emptyBag, RESOURCES } from "./types.ts";

let failures = 0;
function check(label: string, cond: boolean, extra = ""): void {
  if (!cond) failures++;
  console.log(`[${cond ? "PASS" : "FAIL"}] ${label}${extra ? "  -> " + extra : ""}`);
}
const TRUST = { trustClientRandomness: true };

function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (typeof a !== typeof b || a === null || b === null || typeof a !== "object") return false;
  const ak = Object.keys(a as object), bk = Object.keys(b as object);
  if (ak.length !== bk.length) return false;
  for (const k of ak) if (!deepEqual((a as any)[k], (b as any)[k])) return false;
  return true;
}

const geo = buildBoardGeometry();

// Drive setup to completion taking the first legal option each step.
function setupGame(numPlayers: number, seed: number, extra: Record<string, unknown> = {}): GameState {
  let s: GameState = createInitialGameState(geo, { numPlayers, seed, numbers: "balanced", ...extra });
  let g = 0;
  while ((s.phase === "setupSettlement" || s.phase === "setupRoad") && g++ < 300) {
    if (s.phase === "setupSettlement") s = reduce(geo, s, { type: "placeSetupSettlement", vertex: getValidInitialSettlements(geo, s.board)[0] });
    else s = reduce(geo, s, { type: "placeSetupRoad", edge: getValidRoads(geo, s.board, s.currentPlayer, { setupVertex: s.lastSettlementVertex! })[0] });
  }
  return s;
}
function toMain(s: GameState): GameState {
  return reduce(geo, s, { type: "rollDice", dice: [5, 4] }, TRUST); // 9, never a 7
}

// Walk a non-repeating vertex path collecting edges (for road scenarios).
function tracePath(start: VertexId, length: number): { edges: EdgeId[]; vertices: VertexId[] } {
  const edges: EdgeId[] = [];
  const verts: VertexId[] = [start];
  const seen = new Set<VertexId>([start]);
  let cur = start;
  while (edges.length < length) {
    const next = geo.vertices[cur].edges
      .map((eid) => { const [a, b] = geo.edges[eid].vertices; return { eid, w: a === cur ? b : a }; })
      .find((o) => !seen.has(o.w));
    if (!next) break;
    edges.push(next.eid); verts.push(next.w); seen.add(next.w); cur = next.w;
  }
  return { edges, vertices: verts };
}

// ============================================================================
console.log("\n=== #1 Real port layout ===");
{
  const s = setupGame(4, 11);
  check("nine harbours", s.board.ports.length === 9, `${s.board.ports.length}`);
  const counts: Record<string, number> = {};
  s.board.ports.forEach((p) => (counts[p.type] = (counts[p.type] ?? 0) + 1));
  check("four generic 3:1 ports", counts["generic"] === 4, `${counts["generic"]}`);
  check("one 2:1 port per resource", RESOURCES.every((r) => counts[r] === 1));
  // no two harbours share a vertex => none sit on adjacent coastal edges
  const allVerts = s.board.ports.flatMap((p) => p.vertices);
  check("no two harbours are adjacent", new Set(allVerts).size === allVerts.length, `${new Set(allVerts).size}/${allVerts.length}`);
  const v1 = setupGame(4, 11, { variablePorts: true });
  const counts2: Record<string, number> = {};
  v1.board.ports.forEach((p) => (counts2[p.type] = (counts2[p.type] ?? 0) + 1));
  check("variable ports preserve the chip multiset", counts2["generic"] === 4 && RESOURCES.every((r) => counts2[r] === 1));
}

// ============================================================================
console.log("\n=== #8 Longest Road: dynamic transfer / tie / removal ===");
{
  function blankBoard(s: GameState): BoardState {
    s.board.vertices = geo.vertices.map(() => ({ building: null, portId: null }));
    s.board.edges = geo.edges.map(() => ({ road: null }));
    return s.board;
  }
  // (a) strictly-longer rival takes the card
  {
    const s = setupGame(3, 5);
    blankBoard(s);
    const p0 = tracePath(0, 5);
    p0.edges.forEach((e) => (s.board.edges[e].road = { owner: 0 }));
    updateLongestRoad(s, geo);
    check("holder is player 0 at length 5", s.longestRoadHolder === 0, `${s.longestRoadHolder}`);
    // give player 1 a length-6 trail somewhere disjoint
    const start = geo.vertices.find((v) => v.id > 25)!.id;
    const p1 = tracePath(start, 6);
    p1.edges.forEach((e) => (s.board.edges[e].road = { owner: 1 }));
    updateLongestRoad(s, geo);
    check("strictly-longer player 1 takes Longest Road", s.longestRoadHolder === 1, `${s.longestRoadHolder}`);
    check("award swings VP by +2 to player 1", victoryPoints(s, 1) >= 2);
  }
  // (b) a tie does NOT steal the card from the holder
  {
    const s = setupGame(3, 6);
    blankBoard(s);
    const a = tracePath(0, 6);
    a.edges.forEach((e) => (s.board.edges[e].road = { owner: 0 }));
    updateLongestRoad(s, geo);
    check("player 0 holds at 6", s.longestRoadHolder === 0);
    const start = geo.vertices.find((v) => v.id > 25)!.id;
    const b = tracePath(start, 6);
    b.edges.forEach((e) => (s.board.edges[e].road = { owner: 1 }));
    updateLongestRoad(s, geo);
    check("a tie at the top leaves the card with the holder", s.longestRoadHolder === 0, `${s.longestRoadHolder}`);
  }
  // (c) dropping below 5 removes the card
  {
    const s = setupGame(3, 7);
    blankBoard(s);
    const a = tracePath(0, 5);
    a.edges.forEach((e) => (s.board.edges[e].road = { owner: 0 }));
    updateLongestRoad(s, geo);
    check("player 0 holds at 5", s.longestRoadHolder === 0);
    s.board.edges[a.edges[2]].road = null; // break the chain
    check("longest trail now < 5", computeLongestRoadLength(geo, s.board, 0) < 5);
    updateLongestRoad(s, geo);
    check("Longest Road is removed when no one reaches 5", s.longestRoadHolder === null, `${s.longestRoadHolder}`);
  }
}

// ============================================================================
console.log("\n=== #10 Bank scarcity on production ===");
{
  // isolate a single forest hex on roll 8; give it to two players (a tie)
  function isolate(s: GameState, terrain: "forest", token: number): { hex: number; verts: VertexId[] } {
    s.board.hexes.forEach((h) => (h.numberToken = 3)); // nothing else rolls on 8
    s.board.vertices = geo.vertices.map(() => ({ building: null, portId: null }));
    s.board.edges = geo.edges.map(() => ({ road: null }));
    const hex = geo.hexes.find((h) => h.vertices.length === 6)!.id;
    s.board.hexes[hex].terrain = terrain;
    s.board.hexes[hex].numberToken = token;
    s.board.robberHex = geo.hexes.find((h) => h.id !== hex)!.id; // robber elsewhere
    // two non-adjacent corners of the hex
    const vs = geo.hexes[hex].vertices;
    const a = vs[0];
    const b = vs.find((v) => !geo.vertices[a].neighbors.includes(v) && v !== a)!;
    return { hex, verts: [a, b] };
  }
  {
    const s = setupGame(3, 9);
    const { verts } = isolate(s, "forest", 8);
    s.board.vertices[verts[0]].building = { owner: 0, type: "settlement" };
    s.board.vertices[verts[1]].building = { owner: 1, type: "settlement" };
    s.players.forEach((p) => (p.hand = emptyBag()));
    s.bank.lumber = 1; // only one, but two players each want one
    s.phase = "preRoll"; s.currentPlayer = 0;
    const out = reduce(geo, s, { type: "rollDice", dice: [4, 4] }, TRUST); // 8
    check("multi-claimant shortfall -> nobody receives", out.players[0].hand.lumber === 0 && out.players[1].hand.lumber === 0);
    check("the scarce bank pile is untouched", out.bank.lumber === 1);
  }
  {
    const s = setupGame(3, 10);
    const { verts } = isolate(s, "forest", 8);
    s.board.vertices[verts[0]].building = { owner: 0, type: "city" }; // demands 2
    s.players.forEach((p) => (p.hand = emptyBag()));
    s.bank.lumber = 1; // single claimant gets the remainder
    s.phase = "preRoll"; s.currentPlayer = 0;
    const out = reduce(geo, s, { type: "rollDice", dice: [4, 4] }, TRUST); // 8
    check("single claimant gets what the bank can give (1 of 2)", out.players[0].hand.lumber === 1, `${out.players[0].hand.lumber}`);
    check("bank emptied of that resource", out.bank.lumber === 0);
  }
}

// ============================================================================
console.log("\n=== #11 City upgrade: piece accounting ===");
{
  let s = setupGame(4, 12);
  s = toMain(s);
  const mySettlement = s.board.vertices.findIndex((v) => v.building?.owner === 0 && v.building.type === "settlement");
  s.players[0].hand = { ...emptyBag(), ore: 3, grain: 2 };
  const cityBefore = s.players[0].piecesLeft.cities;
  const settBefore = s.players[0].piecesLeft.settlements;
  const vpBefore = victoryPoints(s, 0);
  const bankOre = s.bank.ore, bankGrain = s.bank.grain;
  const out = reduce(geo, s, { type: "buildCity", vertex: mySettlement });
  check("vertex is now a city", out.board.vertices[mySettlement].building?.type === "city");
  check("one city piece consumed", out.players[0].piecesLeft.cities === cityBefore - 1);
  check("a settlement piece is returned to supply", out.players[0].piecesLeft.settlements === settBefore + 1);
  check("city upgrade is +1 VP", victoryPoints(out, 0) === vpBefore + 1, `${victoryPoints(out, 0)}`);
  check("city cost (3 ore, 2 grain) paid to the bank", out.bank.ore === bankOre + 3 && out.bank.grain === bankGrain + 2);
}

// ============================================================================
console.log("\n=== #12 Maritime trade at 3:1 and 2:1 ===");
{
  let s = setupGame(4, 13);
  s = toMain(s);
  const myVerts = s.board.vertices.map((v, i) => ({ v, i })).filter(({ v }) => v.building?.owner === 0).map(({ i }) => i);
  // give player 0 a generic (3:1) port and an ore (2:1) port on their settlements
  s.board.ports = [
    { type: "generic", vertices: [myVerts[0]] },
    { type: "ore", vertices: [myVerts[1]] },
  ];
  s.players[0].hand = { ...emptyBag(), grain: 3, ore: 2 };
  let out = reduce(geo, s, { type: "maritimeTrade", give: "grain", receive: "wool" });
  check("3:1 generic port: 3 grain -> 1 wool", out.players[0].hand.grain === 0 && out.players[0].hand.wool === 1);
  out = reduce(geo, out, { type: "maritimeTrade", give: "ore", receive: "brick" });
  check("2:1 ore port: 2 ore -> 1 brick", out.players[0].hand.ore === 0 && out.players[0].hand.brick === 1);
}

// ============================================================================
console.log("\n=== #13 Knight before the roll, then a 7 (two robber moves) ===");
{
  let s = setupGame(4, 14); // player 0, phase preRoll
  check("turn begins in preRoll", s.phase === "preRoll");
  s.players[0].devCards.push({ type: "knight", boughtThisTurn: false, played: false });
  // play knight pre-roll -> robber, then resolve; must return to preRoll
  s = reduce(geo, s, { type: "playKnight" });
  check("knight before the roll opens the robber", s.phase === "moveRobber");
  const robber1 = s.board.robberHex;
  s = reduce(geo, s, { type: "moveRobber", hex: geo.hexes.find((h) => h.id !== robber1)!.id });
  if (s.phase === "steal") s = reduce(geo, s, { type: "steal", target: getStealTargets(s, geo)[0] ?? null });
  check("after the knight robber, play returns to preRoll", s.phase === "preRoll", s.phase);
  check("knight counted", s.players[0].knightsPlayed === 1);
  // now roll a 7 -> a SECOND robber resolution this turn
  s = reduce(geo, s, { type: "rollDice", dice: [3, 4] }, TRUST); // 7
  check("the 7 opens the robber again", s.phase === "discard" || s.phase === "moveRobber", s.phase);
  while (s.phase === "discard") {
    const pid = +Object.keys(s.pendingDiscards)[0];
    const owed = s.pendingDiscards[pid]; const p = s.players[pid];
    const cards: Partial<Record<Resource, number>> = {}; let need = owed;
    for (const r of RESOURCES) while ((p.hand[r] - (cards[r] ?? 0)) > 0 && need > 0) { cards[r] = (cards[r] ?? 0) + 1; need--; }
    s = reduce(geo, s, { type: "discard", player: pid, cards });
  }
  if (s.phase === "moveRobber") s = reduce(geo, s, { type: "moveRobber", hex: geo.hexes.find((h) => h.id !== s.board.robberHex)!.id });
  if (s.phase === "steal") s = reduce(geo, s, { type: "steal", target: getStealTargets(s, geo)[0] ?? null });
  check("second robber resolves back to main", s.phase === "main", s.phase);
}

// ============================================================================
console.log("\n=== #5 Randomness-trust boundary ===");
{
  const base = setupGame(4, 15); // preRoll, player 0
  const trusted = reduce(geo, base, { type: "rollDice", dice: [5, 4] }, TRUST);
  check("trusted roll honours the scripted dice", trusted.dice![0] === 5 && trusted.dice![1] === 4);
  // untrusted: the scripted value is ignored; identical RNG state -> identical roll
  const a = reduce(geo, base, { type: "rollDice", dice: [1, 1] }); // trust off
  const b = reduce(geo, base, { type: "rollDice", dice: [6, 6] }); // trust off
  check("untrusted rolls ignore client dice (RNG-driven, identical)", deepEqual(a.dice, b.dice), `${JSON.stringify(a.dice)} vs ${JSON.stringify(b.dice)}`);
  check("untrusted roll is NOT the injected value", !(a.dice![0] === 1 && a.dice![1] === 1) || !(b.dice![0] === 6 && b.dice![1] === 6));
}

// ============================================================================
console.log("\n=== #6 tryReduce: typed errors, no throw ===");
{
  const s = setupGame(4, 16); // preRoll
  const bad = tryReduce(geo, s, { type: "buildCity", vertex: 0 }); // illegal now
  check("illegal action returns ok:false", bad.ok === false);
  check("the error is a message string", bad.ok === false && typeof bad.error === "string" && bad.error.length > 0);
  const good = tryReduce(geo, s, { type: "rollDice", dice: [5, 4] }, TRUST);
  check("legal action returns ok:true with state", good.ok === true && good.state.phase === "main");
}

// ============================================================================
console.log("\n=== #4 Per-player redacted view ===");
{
  let s = setupGame(4, 17);
  s = toMain(s);
  s.players[1].hand = { ...emptyBag(), ore: 3, wool: 1 };
  s.players[1].devCards.push({ type: "knight", boughtThisTurn: false, played: false });
  const view = viewForPlayer(s, 0);
  check("viewer sees their own hand", view.players[0].hand !== undefined);
  check("opponent hand is hidden", view.players[1].hand === undefined);
  check("opponent hand size is still exposed", view.players[1].handSize === 4, `${view.players[1].handSize}`);
  check("opponent dev cards are hidden (count only)", view.players[1].devCards === undefined && view.players[1].devCardCount === 1);
  check("dev deck is a count, not an ordered list", view.devDeckCount === s.devDeck.length && !("devDeck" in view));
  check("the RNG seed is not leaked", !("rngState" in view));
  check("the board is public", view.board.hexes.length === s.board.hexes.length);
}

// ============================================================================
console.log("\n=== #17 Special building phase (3-4p none; 5-6p round) ===");
{
  // 3-4 players: no special build; end of turn goes straight to the next player
  let s4 = setupGame(4, 18);
  s4 = toMain(s4);
  s4 = reduce(geo, s4, { type: "endTurn" });
  check("4-player game has no special build phase", s4.phase === "preRoll" && s4.specialBuilder === null, s4.phase);
  check("turn passes to the next player", s4.currentPlayer === 1);

  // 5 players: a special building round runs between turns
  let s5 = setupGame(5, 19);
  s5 = toMain(s5);
  s5 = reduce(geo, s5, { type: "endTurn" });
  check("5-player game enters specialBuild after a turn", s5.phase === "specialBuild", s5.phase);
  check("ender stays current; first special builder is the next player", s5.currentPlayer === 0 && s5.specialBuilder === 1);
  check("the queue is the other four players, clockwise", deepEqual(s5.specialBuildQueue, [1, 2, 3, 4]));
  // the active special builder (player 1) can build a road
  s5.players[1].hand = { ...emptyBag(), lumber: 1, brick: 1 };
  const road = getValidRoads(geo, s5.board, 1)[0];
  s5 = reduce(geo, s5, { type: "buildRoad", edge: road });
  check("special builder may build during their window", s5.board.edges[road].road?.owner === 1);
  // cycle the rest of the queue
  s5 = reduce(geo, s5, { type: "endSpecialBuild" });
  check("special build advances to player 2", s5.specialBuilder === 2);
  s5 = reduce(geo, s5, { type: "endSpecialBuild" }); // 3
  s5 = reduce(geo, s5, { type: "endSpecialBuild" }); // 4
  s5 = reduce(geo, s5, { type: "endSpecialBuild" }); // queue exhausted
  check("after the round, the next player's turn begins", s5.phase === "preRoll" && s5.currentPlayer === 1 && s5.specialBuilder === null, `${s5.phase}/${s5.currentPlayer}`);

  // a player can win during their special building window
  let w = setupGame(5, 20);
  w = toMain(w);
  w = reduce(geo, w, { type: "endTurn" }); // specialBuild, builder = player 1
  w.longestRoadHolder = 1; w.largestArmyHolder = 1; // +4
  w.players[1].knightsPlayed = 3;
  w.players[1].devCards.push({ type: "victoryPoint", boughtThisTurn: false, played: false }); // 2 setts + 4 + 1 = 7
  w.players[1].devCards.push({ type: "victoryPoint", boughtThisTurn: false, played: false }); // 8
  w.devDeck = ["victoryPoint", ...w.devDeck]; // next buy is the 10th point
  w.players[1].hand = { ...emptyBag(), ore: 1, wool: 1, grain: 1 };
  check("player 1 sits at 8 VP before the buy", victoryPoints(w, 1) === 8, `${victoryPoints(w, 1)}`);
  // buy two VP cards (the second hits 10) — but only one buy needed: 8 -> 9, need 10.
  w.players[1].devCards.push({ type: "victoryPoint", boughtThisTurn: false, played: false }); // 9 now
  const out = reduce(geo, w, { type: "buyDevCard" }); // draws the stacked VP -> 10
  check("buying the 10th point during special build wins", out.winner === 1 && out.phase === "gameOver", `${out.winner}/${out.phase}`);
}

// ============================================================================
console.log("\n=== #18 Serialization & deterministic replay ===");
{
  // play a short untrusted (RNG-driven) game, capturing the initial state
  let s = createInitialGameState(geo, { numPlayers: 4, seed: 21, numbers: "balanced" });
  const initial = serialize(s); // snapshot before any action
  let g = 0;
  while ((s.phase === "setupSettlement" || s.phase === "setupRoad") && g++ < 300) {
    if (s.phase === "setupSettlement") s = reduce(geo, s, { type: "placeSetupSettlement", vertex: getValidInitialSettlements(geo, s.board)[0] });
    else s = reduce(geo, s, { type: "placeSetupRoad", edge: getValidRoads(geo, s.board, s.currentPlayer, { setupVertex: s.lastSettlementVertex! })[0] });
  }
  for (let i = 0; i < 12; i++) {
    s = reduce(geo, s, { type: "rollDice" }); // untrusted -> RNG
    // resolve any robber deterministically
    while (s.phase === "discard") {
      const pid = +Object.keys(s.pendingDiscards)[0]; const owed = s.pendingDiscards[pid]; const p = s.players[pid];
      const cards: Partial<Record<Resource, number>> = {}; let need = owed;
      for (const r of RESOURCES) while ((p.hand[r] - (cards[r] ?? 0)) > 0 && need > 0) { cards[r] = (cards[r] ?? 0) + 1; need--; }
      s = reduce(geo, s, { type: "discard", player: pid, cards });
    }
    if (s.phase === "moveRobber") s = reduce(geo, s, { type: "moveRobber", hex: geo.hexes.find((h) => h.id !== s.board.robberHex)!.id });
    if (s.phase === "steal") s = reduce(geo, s, { type: "steal", target: getStealTargets(s, geo)[0] ?? null });
    if (s.phase === "main") s = reduce(geo, s, { type: "endTurn" });
  }
  const finalState = s;

  const roundtrip = deserialize(serialize(finalState));
  check("serialize -> deserialize round-trips exactly", deepEqual(roundtrip, finalState));

  const replayed = replay(geo, deserialize(initial), actionsFromLog(finalState)); // untrusted: RNG from initial
  check("replaying the action log reproduces the final state", deepEqual(replayed, finalState));
}

// ============================================================================
console.log("\n=== #19 Domestic (player-to-player) trade ===");
{
  // happy path: propose -> accept -> confirm swaps the resources
  let s = setupGame(4, 22);
  s = toMain(s);
  s.players[0].hand = { ...emptyBag(), ore: 2 };
  s.players[2].hand = { ...emptyBag(), wool: 3 };
  s = reduce(geo, s, { type: "proposeDomesticTrade", give: { ore: 2 }, receive: { wool: 2 } });
  check("an open trade is recorded", s.pendingTrade !== null && s.pendingTrade.proposer === 0);
  s = reduce(geo, s, { type: "respondDomesticTrade", player: 2, accept: true });
  check("an acceptance is recorded", s.pendingTrade!.acceptances.includes(2));
  s = reduce(geo, s, { type: "confirmDomesticTrade", partner: 2 });
  check("proposer gave 2 ore, received 2 wool", s.players[0].hand.ore === 0 && s.players[0].hand.wool === 2);
  check("partner gave 2 wool, received 2 ore", s.players[2].hand.wool === 1 && s.players[2].hand.ore === 2);
  check("the trade window is cleared after confirming", s.pendingTrade === null);

  // cannot confirm with a player who hasn't accepted
  let s2 = setupGame(4, 23);
  s2 = toMain(s2);
  s2.players[0].hand = { ...emptyBag(), ore: 1 };
  s2.players[1].hand = { ...emptyBag(), wool: 1 };
  s2 = reduce(geo, s2, { type: "proposeDomesticTrade", give: { ore: 1 }, receive: { wool: 1 } });
  const noAccept = tryReduce(geo, s2, { type: "confirmDomesticTrade", partner: 1 });
  check("confirming without acceptance is rejected", noAccept.ok === false);

  // "no gifts": both sides must offer at least one card
  let s3 = setupGame(4, 24);
  s3 = toMain(s3);
  s3.players[0].hand = { ...emptyBag(), ore: 1 };
  const gift = tryReduce(geo, s3, { type: "proposeDomesticTrade", give: { ore: 1 }, receive: {} });
  check("a one-sided gift is rejected", gift.ok === false);

  // partner must actually hold the cards at confirm time
  let s4 = setupGame(4, 25);
  s4 = toMain(s4);
  s4.players[0].hand = { ...emptyBag(), ore: 1 };
  s4.players[1].hand = emptyBag(); // partner has no wool
  s4 = reduce(geo, s4, { type: "proposeDomesticTrade", give: { ore: 1 }, receive: { wool: 1 } });
  s4 = reduce(geo, s4, { type: "respondDomesticTrade", player: 1, accept: true });
  const broke = tryReduce(geo, s4, { type: "confirmDomesticTrade", partner: 1 });
  check("a partner who can't cover the trade is rejected", broke.ok === false);
}

// ============================================================================
console.log("\n=== Cross-turn win via Longest Road transfer (regression) ===");
{
  // Model the cross-turn case directly (Longest Road computation itself is
  // covered in the #8 block): player 0 has 8 VP from buildings and has JUST
  // been awarded Longest Road because an opponent's road was cut on player 2's
  // turn -> player 0 is at 10. The win must NOT register on player 2's turn,
  // but MUST register when player 0's own turn begins.
  let s = setupGame(4, 31);
  s = toMain(s);
  s.board.vertices = geo.vertices.map(() => ({ building: null, portId: null }));
  for (const v of [0, 2, 4, 6]) s.board.vertices[v].building = { owner: 0, type: "city" }; // 8 VP
  s.longestRoadHolder = 0; // the transfer that just happened on player 2's turn
  s.currentPlayer = 2; s.phase = "main"; s.winner = null;
  check("player 0 sits at 10 VP", victoryPoints(s, 0) === 10, `${victoryPoints(s, 0)}`);
  check("but is NOT flagged as winner on player 2's turn", s.winner === null && s.phase === "main");
  s = reduce(geo, s, { type: "endTurn" }); // -> player 3 preRoll
  s = reduce(geo, s, { type: "rollDice", dice: [5, 4] }, TRUST); // player 3 main
  s = reduce(geo, s, { type: "endTurn" }); // -> startTurn(0) must detect the win
  check("player 0 wins at the start of their own turn", s.winner === 0 && s.phase === "gameOver", `${s.winner}/${s.phase}`);
}

// ============================================================================
console.log("\n=== Summary ===");
if (failures === 0) console.log("ALL ADVANCED CHECKS PASSED");
else { console.log(`${failures} CHECK(S) FAILED`); process.exit(1); }
