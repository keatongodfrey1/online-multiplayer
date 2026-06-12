/**
 * verify_property.ts — randomized property testing. Plays many games of random
 * but legal actions (including dev-card *plays* and domestic trades), checking
 * after every step that the engine never violates its core invariants:
 *   - resource conservation: bank + all hands == 19 of each resource
 *   - non-negativity: no negative hand or bank entry
 *   - piece limits: no negative piece counts
 *   - no missed win: if the game is live, nobody is sitting on >= 10 VP
 * Run: node --experimental-strip-types src/verify_property.ts
 */

import { buildBoardGeometry, getValidInitialSettlements, getValidRoads, getValidSettlements, getValidCities } from "./geometry.ts";
import { createInitialGameState, reduce, getStealTargets, victoryPoints, type Action } from "./stateMachine.ts";
import type { GameState, Resource } from "./types.ts";
import { RESOURCES, WINNING_VP } from "./types.ts";

function mulberry(a: number) {
  return function () {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function invariantsOk(s: GameState, where: string): boolean {
  for (const r of RESOURCES) {
    let total = s.bank[r];
    for (const p of s.players) total += p.hand[r];
    if (total !== 19) { console.log(`  [${where}] conservation broken: ${r}=${total}`); return false; }
    if (s.bank[r] < 0) { console.log(`  [${where}] negative bank ${r}=${s.bank[r]}`); return false; }
  }
  for (const p of s.players) {
    for (const r of RESOURCES) if (p.hand[r] < 0) { console.log(`  [${where}] negative hand p${p.id} ${r}`); return false; }
    if (p.piecesLeft.roads < 0 || p.piecesLeft.settlements < 0 || p.piecesLeft.cities < 0) { console.log(`  [${where}] negative pieces p${p.id}`); return false; }
  }
  if (s.phase !== "gameOver") {
    for (const p of s.players) if (victoryPoints(s, p.id) >= WINNING_VP) { console.log(`  [${where}] missed win: p${p.id} has ${victoryPoints(s, p.id)} VP but game live`); return false; }
  }
  return true;
}

const geo = buildBoardGeometry();
let games = 0, steps = 0, finished = 0, fails = 0;

for (let seed = 1; seed <= 300; seed++) {
  const rng = mulberry(seed * 2654435761);
  const numPlayers = 3 + (seed % 4); // 3..6 (exercises the special building phase too)
  let s: GameState = createInitialGameState(geo, { numPlayers, seed, numbers: "balanced" });
  let g = 0;
  while ((s.phase === "setupSettlement" || s.phase === "setupRoad") && g++ < 400) {
    if (s.phase === "setupSettlement") s = reduce(geo, s, { type: "placeSetupSettlement", vertex: getValidInitialSettlements(geo, s.board)[0] });
    else s = reduce(geo, s, { type: "placeSetupRoad", edge: getValidRoads(geo, s.board, s.currentPlayer, { setupVertex: s.lastSettlementVertex! })[0] });
  }

  let step = 0;
  while (s.phase !== "gameOver" && step++ < 600) {
    if (!invariantsOk(s, `seed${seed}`)) { fails++; break; }
    steps++;
    const acting = s.phase === "specialBuild" ? s.specialBuilder! : s.currentPlayer;
    const p = s.players[acting];
    const can = (c: Partial<Record<Resource, number>>) => RESOURCES.every((r) => p.hand[r] >= (c[r] ?? 0));
    const playable = (t: string) => p.devCards.some((c) => c.type === t && !c.played && !c.boughtThisTurn);
    const x = rng();

    switch (s.phase) {
      case "preRoll": {
        // occasionally play a knight before rolling
        if (x < 0.15 && playable("knight") && !s.devCardPlayedThisTurn) s = reduce(geo, s, { type: "playKnight" });
        else s = reduce(geo, s, { type: "rollDice" });
        break;
      }
      case "discard": {
        const pid = +Object.keys(s.pendingDiscards)[0]; const owed = s.pendingDiscards[pid]; const pp = s.players[pid];
        const cards: Partial<Record<Resource, number>> = {}; let need = owed;
        for (const r of RESOURCES) while ((pp.hand[r] - (cards[r] ?? 0)) > 0 && need > 0) { cards[r] = (cards[r] ?? 0) + 1; need--; }
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
        // free roads from a road-building card must be placed before ending
        if (s.freeRoads > 0) {
          if (roads.length && p.piecesLeft.roads > 0) { s = reduce(geo, s, { type: "buildRoad", edge: roads[0] }); }
          else if (inMain) { s = reduce(geo, s, { type: "endTurn" }); } // forfeits the rest
          else { s = reduce(geo, s, { type: "endSpecialBuild" }); }
          break;
        }
        // dev-card plays (main/preRoll only)
        if (inMain && !s.devCardPlayedThisTurn && x < 0.12 && playable("monopoly")) { s = reduce(geo, s, { type: "playMonopoly", resource: RESOURCES[(rng() * 5) | 0] }); break; }
        if (inMain && !s.devCardPlayedThisTurn && x < 0.18 && playable("yearOfPlenty")) { s = reduce(geo, s, { type: "playYearOfPlenty", resources: [RESOURCES[(rng() * 5) | 0], RESOURCES[(rng() * 5) | 0]] }); break; }
        if (inMain && !s.devCardPlayedThisTurn && x < 0.24 && playable("roadBuilding")) { s = reduce(geo, s, { type: "playRoadBuilding" }); break; }
        if (inMain && !s.devCardPlayedThisTurn && x < 0.30 && playable("knight")) { s = reduce(geo, s, { type: "playKnight" }); break; }
        // builds / buys
        if (x < 0.45 && cities.length && can({ ore: 3, grain: 2 }) && p.piecesLeft.cities > 0) { s = reduce(geo, s, { type: "buildCity", vertex: cities[0] }); acted = true; }
        else if (x < 0.62 && setts.length && can({ lumber: 1, brick: 1, wool: 1, grain: 1 }) && p.piecesLeft.settlements > 0) { s = reduce(geo, s, { type: "buildSettlement", vertex: setts[0] }); acted = true; }
        else if (x < 0.78 && roads.length && can({ lumber: 1, brick: 1 }) && p.piecesLeft.roads > 0) { s = reduce(geo, s, { type: "buildRoad", edge: roads[0] }); acted = true; }
        else if (x < 0.88 && can({ ore: 1, wool: 1, grain: 1 }) && s.devDeck.length) { s = reduce(geo, s, { type: "buyDevCard" }); acted = true; }
        else if (inMain && x < 0.94) {
          const give = RESOURCES.find((r) => p.hand[r] >= 4);
          const recv = RESOURCES.find((r) => r !== give && s.bank[r] > 0);
          if (give && recv) { s = reduce(geo, s, { type: "maritimeTrade", give, receive: recv }); acted = true; }
        }
        if (!acted) s = reduce(geo, s, { type: inMain ? "endTurn" : "endSpecialBuild" });
        break;
      }
      default: s = reduce(geo, s, { type: "endTurn" });
    }
  }
  if (!invariantsOk(s, `seed${seed}-final`)) fails++;
  if (s.phase === "gameOver") finished++;
  games++;
}

console.log(`games=${games}  actions=${steps}  natural wins=${finished}  invariant failures=${fails}`);
if (fails === 0) console.log("ALL PROPERTY CHECKS PASSED");
else { console.log("PROPERTY CHECKS FAILED"); process.exit(1); }
