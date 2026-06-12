/**
 * verify_actions.ts — exercises the dev-card, trade, award and victory paths
 * that the main turn-flow harness (verify.ts) does not touch.
 * Run: node --experimental-strip-types src/verify_actions.ts
 */

import {
  buildBoardGeometry,
  getValidInitialSettlements,
  getValidRoads,
  getValidSettlements,
} from "./geometry.ts";
import { createInitialGameState, getStealTargets, reduce, victoryPoints } from "./stateMachine.ts";
import type { DevCard, GameState, Resource } from "./types.ts";
import { emptyBag } from "./types.ts";

let failures = 0;
function check(label: string, cond: boolean, extra = ""): void {
  if (!cond) failures++;
  console.log(`[${cond ? "PASS" : "FAIL"}] ${label}${extra ? "  -> " + extra : ""}`);
}
function expectThrow(label: string, fn: () => void): void {
  let threw = false;
  try {
    fn();
  } catch {
    threw = true;
  }
  check(label, threw);
}

const geo = buildBoardGeometry();

// Build a game and drive it to player 0's main phase, taking first legal options.
function freshMain(): GameState {
  let s: GameState = createInitialGameState(geo, { numPlayers: 4, seed: 7, numbers: "balanced" });
  let guard = 0;
  while ((s.phase === "setupSettlement" || s.phase === "setupRoad") && guard++ < 50) {
    if (s.phase === "setupSettlement") {
      const v = getValidInitialSettlements(geo, s.board)[0];
      s = reduce(geo, s, { type: "placeSetupSettlement", vertex: v });
    } else {
      const e = getValidRoads(geo, s.board, s.currentPlayer, { setupVertex: s.lastSettlementVertex! })[0];
      s = reduce(geo, s, { type: "placeSetupRoad", edge: e });
    }
  }
  // player 0 leads; roll a non-7 to reach main
  s = reduce(geo, s, { type: "rollDice", dice: [2, 3] }, { trustClientRandomness: true }); // = 5
  if (s.phase !== "main") throw new Error("freshMain: expected main, got " + s.phase);
  if (s.currentPlayer !== 0) throw new Error("freshMain: expected player 0");
  return s;
}

const devCard = (type: DevCard["type"]): DevCard => ({ type, boughtThisTurn: false, played: false });

// ============================================================================
console.log("\n=== Maritime trade (4:1, no ports) ===");
{
  const s = freshMain();
  s.board.ports = []; // strip every port so the only available ratio is 4:1
  s.players[0].hand = { ...emptyBag(), brick: 5 };
  const bankBrick = s.bank.brick;
  const bankOre = s.bank.ore;
  const out = reduce(geo, s, { type: "maritimeTrade", give: "brick", receive: "ore" });
  check("4 brick spent, 1 left", out.players[0].hand.brick === 1, `${out.players[0].hand.brick}`);
  check("1 ore received", out.players[0].hand.ore === 1, `${out.players[0].hand.ore}`);
  check("bank gained 4 brick", out.bank.brick === bankBrick + 4);
  check("bank lost 1 ore", out.bank.ore === bankOre - 1);
  expectThrow("3 brick is not enough at 4:1", () => {
    const t = freshMain();
    t.board.ports = [];
    t.players[0].hand = { ...emptyBag(), brick: 3 };
    reduce(geo, t, { type: "maritimeTrade", give: "brick", receive: "ore" });
  });
}

// ============================================================================
console.log("\n=== Monopoly ===");
{
  const s = freshMain();
  s.players[0].devCards.push(devCard("monopoly"));
  s.players[0].hand = { ...emptyBag(), ore: 0 };
  s.players[1].hand = { ...emptyBag(), ore: 2 };
  s.players[2].hand = { ...emptyBag(), ore: 3 };
  s.players[3].hand = { ...emptyBag(), ore: 1 };
  const bankOre = s.bank.ore;
  const out = reduce(geo, s, { type: "playMonopoly", resource: "ore" });
  check("active player collects all 6 ore", out.players[0].hand.ore === 6, `${out.players[0].hand.ore}`);
  check("opponents are emptied of ore", [1, 2, 3].every((i) => out.players[i].hand.ore === 0));
  check("monopoly moves cards between players, not the bank", out.bank.ore === bankOre);
}

// ============================================================================
console.log("\n=== Year of Plenty ===");
{
  const s = freshMain();
  s.players[0].devCards.push(devCard("yearOfPlenty"));
  s.players[0].hand = emptyBag();
  const bL = s.bank.lumber;
  const bB = s.bank.brick;
  const out = reduce(geo, s, { type: "playYearOfPlenty", resources: ["lumber", "brick"] });
  check("two resources drawn to hand", out.players[0].hand.lumber === 1 && out.players[0].hand.brick === 1);
  check("bank decremented for both", out.bank.lumber === bL - 1 && out.bank.brick === bB - 1);
  // New rule (#3): take what the bank can supply, skip what it lacks (no throw).
  {
    const t = freshMain();
    t.players[0].devCards.push(devCard("yearOfPlenty"));
    t.players[0].hand = emptyBag();
    t.bank.ore = 1; // only one ore left, but two requested
    const out = reduce(geo, t, { type: "playYearOfPlenty", resources: ["ore", "ore"] });
    check("YoP takes only what the bank has (1 of 2 ore)", out.players[0].hand.ore === 1, `${out.players[0].hand.ore}`);
    check("YoP empties the bank of that resource", out.bank.ore === 0);
  }
  {
    const t = freshMain();
    t.players[0].devCards.push(devCard("yearOfPlenty"));
    t.players[0].hand = emptyBag();
    t.bank.ore = 0; // none available -> skip ore, still take wool
    const out = reduce(geo, t, { type: "playYearOfPlenty", resources: ["ore", "wool"] });
    check("YoP skips an empty pile but still takes the available one", out.players[0].hand.wool === 1 && out.players[0].hand.ore === 0);
  }
}

// ============================================================================
console.log("\n=== Road Building (two free roads) ===");
{
  const s = freshMain();
  s.players[0].devCards.push(devCard("roadBuilding"));
  const handBefore = { ...s.players[0].hand };
  let out = reduce(geo, s, { type: "playRoadBuilding" });
  check("two free roads granted", out.freeRoads === 2, `${out.freeRoads}`);
  const r1 = getValidRoads(geo, out.board, 0)[0];
  out = reduce(geo, out, { type: "buildRoad", edge: r1 });
  check("one free road consumed", out.freeRoads === 1, `${out.freeRoads}`);
  const r2 = getValidRoads(geo, out.board, 0)[0];
  out = reduce(geo, out, { type: "buildRoad", edge: r2 });
  check("both free roads consumed", out.freeRoads === 0, `${out.freeRoads}`);
  const r: Resource[] = ["lumber", "wool", "grain", "brick", "ore"];
  check("no resources were spent on free roads", r.every((k) => out.players[0].hand[k] === handBefore[k]));
}

// ============================================================================
console.log("\n=== Knight -> Largest Army (+2 VP) ===");
{
  const s = freshMain();
  s.players[0].knightsPlayed = 2; // third knight should claim the army
  s.players[0].devCards.push(devCard("knight"));
  const vpBefore = victoryPoints(s, 0);
  const out = reduce(geo, s, { type: "playKnight" });
  check("knight sends play to the robber", out.phase === "moveRobber", out.phase);
  check("knights-played incremented to 3", out.players[0].knightsPlayed === 3);
  check("Largest Army awarded to player 0", out.largestArmyHolder === 0);
  check("Largest Army is worth +2 VP", victoryPoints(out, 0) === vpBefore + 2, `${victoryPoints(out, 0)}`);
}

// ============================================================================
console.log("\n=== Dev-card gating ===");
{
  // a card bought this turn cannot be played the same turn
  const s = freshMain();
  s.players[0].devCards.push({ type: "knight", boughtThisTurn: true, played: false });
  expectThrow("cannot play a knight bought this turn", () => reduce(geo, s, { type: "playKnight" }));
}
{
  // only one dev card per turn, even after the robber resolves
  const s = freshMain();
  s.players[0].knightsPlayed = 0;
  s.players[0].devCards.push(devCard("knight"), devCard("knight"));
  let out = reduce(geo, s, { type: "playKnight" }); // -> moveRobber
  const hex = geo.hexes.find((h) => h.id !== out.board.robberHex)!.id;
  out = reduce(geo, out, { type: "moveRobber", hex });
  if (out.phase === "steal") {
    const targets = getStealTargets(out, geo);
    out = reduce(geo, out, { type: "steal", target: targets[0] ?? null });
  }
  check("back in main after robber", out.phase === "main", out.phase);
  expectThrow("second dev card in one turn is rejected", () => reduce(geo, out, { type: "playKnight" }));
}

// ============================================================================
console.log("\n=== Victory at 10 VP ===");
{
  const s = freshMain();
  // 2 settlements (2) + both awards (4) + 4 victory-point cards (4) = 10
  s.longestRoadHolder = 0;
  s.largestArmyHolder = 0;
  s.players[0].knightsPlayed = 3;
  for (let i = 0; i < 4; i++) s.players[0].devCards.push(devCard("victoryPoint"));
  s.players[0].devCards.push(devCard("knight"));
  check("player 0 sits at exactly 10 VP", victoryPoints(s, 0) === 10, `${victoryPoints(s, 0)}`);
  // any action that runs the win check should end the game; playing a knight does
  const out = reduce(geo, s, { type: "playKnight" });
  check("the game is over", out.phase === "gameOver", out.phase);
  check("player 0 is the winner", out.winner === 0, `${out.winner}`);
  check("a win short-circuits the robber move", out.phase === "gameOver" && out.board.robberHex >= 0);
}

// ============================================================================
console.log("\n=== Victory by buying a development card (#9) ===");
{
  const s = freshMain(); // player 0, main phase
  s.longestRoadHolder = 0;
  s.largestArmyHolder = 0;
  s.players[0].knightsPlayed = 3;
  // 2 settlements (2) + both awards (4) + 3 VP cards (3) = 9; the bought card is the 10th
  for (let i = 0; i < 3; i++) s.players[0].devCards.push(devCard("victoryPoint"));
  s.devDeck = ["victoryPoint", ...s.devDeck]; // next draw is a VP card
  s.players[0].hand = { ...emptyBag(), ore: 1, wool: 1, grain: 1 };
  check("player 0 is at 9 VP before buying", victoryPoints(s, 0) === 9, `${victoryPoints(s, 0)}`);
  const out = reduce(geo, s, { type: "buyDevCard" });
  check("the bought VP card is the 10th point and wins immediately", out.winner === 0 && out.phase === "gameOver", `${out.winner}/${out.phase}`);
}

// ============================================================================
console.log("\n=== Summary ===");
if (failures === 0) {
  console.log("ALL ACTION CHECKS PASSED");
} else {
  console.log(`${failures} CHECK(S) FAILED`);
  process.exit(1);
}
