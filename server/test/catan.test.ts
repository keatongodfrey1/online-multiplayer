import assert from "node:assert/strict";
import { boot, type ColyseusTestServer } from "@colyseus/testing";
import { defineRoom, defineServer } from "colyseus";
import { CATAN, CatanEngine, CatanMsg, EndReason, LobbyMsg, Phase } from "@backbone/shared";
import { CatanRoom } from "../src/games/catan/CatanRoom.js";
import { sanitizeAction } from "../src/games/catan/sanitize.js";
import { sleep, until } from "./StubRoom.js";

const {
  buildBoardGeometry,
  getValidInitialSettlements,
  getValidRoads,
  getStealTargets,
  victoryPoints,
  GreedyPolicy,
} = CatanEngine;
type GameState = CatanEngine.GameState;

const geo = buildBoardGeometry();

function makeConfig() {
  return defineServer({
    rooms: { [CATAN]: defineRoom(CatanRoom) },
  });
}

/** Vertices that are pairwise non-adjacent (for white-box board staging). */
function spacedVertices(count: number, exclude: Set<number> = new Set()): number[] {
  const picked: number[] = [];
  const blocked = new Set<number>(exclude);
  for (const v of geo.vertices) {
    if (blocked.has(v.id)) continue;
    picked.push(v.id);
    blocked.add(v.id);
    for (const n of v.neighbors) blocked.add(n);
    if (picked.length === count) break;
  }
  if (picked.length !== count) throw new Error("not enough spaced vertices");
  return picked;
}

describe("catan", () => {
  let colyseus: ColyseusTestServer<ReturnType<typeof makeConfig>>;

  before(async () => {
    colyseus = await boot(makeConfig());
  });
  after(async () => colyseus.shutdown());
  beforeEach(async () => await colyseus.cleanup());

  async function startedGame(seed = 42, playerCount = 2, beforeStart?: (room: CatanRoom) => void) {
    const room = (await colyseus.createRoom(CATAN, { seed })) as unknown as CatanRoom;
    const clients = [];
    for (let i = 0; i < playerCount; i++) {
      clients.push(await colyseus.connectTo(room, { nickname: `Player${i}` }));
    }
    beforeStart?.(room);
    clients[0]!.send(LobbyMsg.START, {});
    await until(() => room.state.phase === Phase.PLAYING);
    // Games now open with the visible turn-order roll; clear it so the rest
    // of each test starts in the setup draft exactly as before.
    if (room.engine?.phase === "rollForOrder") await driveOrderRoll(room, clients);
    return { room, clients };
  }

  /** The connected client owning a given engine seat. */
  function clientFor(room: CatanRoom, clients: any[], engineSeat: number): any {
    const sessionId = room.seatOrder[engineSeat];
    return clients.find((c) => c.sessionId === sessionId);
  }

  /** Drive the opening turn-order roll to completion. */
  async function driveOrderRoll(room: CatanRoom, clients: Array<any>): Promise<void> {
    let guard = 0;
    while (room.engine.phase === "rollForOrder" && guard++ < 30) {
      const prev = room.engine;
      const seat = prev.orderContenders.find((s) => prev.orderRolls[s] === null)!;
      clientFor(room, clients, seat)!.send(CatanMsg.ACTION, { type: "rollForOrder" });
      await until(() => room.engine !== prev);
    }
  }

  /** Drive the snake draft to completion with first-legal placements. */
  async function driveSetup(room: CatanRoom, clients: Array<any>): Promise<void> {
    let guard = 0;
    while ((room.engine.phase === "setupSettlement" || room.engine.phase === "setupRoad") && guard++ < 40) {
      const prev = room.engine;
      const actor = clientFor(room, clients, prev.currentPlayer)!;
      if (prev.phase === "setupSettlement") {
        const vertex = getValidInitialSettlements(geo, prev.board)[0]!;
        actor.send(CatanMsg.ACTION, { type: "placeSetupSettlement", vertex });
      } else {
        const edge = getValidRoads(geo, prev.board, prev.currentPlayer, {
          setupVertex: prev.lastSettlementVertex!,
        })[0]!;
        actor.send(CatanMsg.ACTION, { type: "placeSetupRoad", edge });
      }
      await until(() => room.engine !== prev);
    }
    assert.equal(room.engine.phase, "preRoll", "setup must complete");
  }

  /** Resolve any pending discard/robber/steal so play can continue. */
  async function flushRobber(room: CatanRoom, clients: Array<any>): Promise<void> {
    let guard = 0;
    while (["discard", "moveRobber", "steal"].includes(room.engine.phase) && guard++ < 30) {
      const prev = room.engine;
      if (prev.phase === "discard") {
        const seat = +Object.keys(prev.pendingDiscards)[0]!;
        const owed = prev.pendingDiscards[seat]!;
        const hand = prev.players[seat]!.hand;
        const cards: Record<string, number> = {};
        let need = owed;
        for (const r of ["lumber", "brick", "wool", "grain", "ore"] as const) {
          const take = Math.min(hand[r] - (cards[r] ?? 0), need);
          if (take > 0) {
            cards[r] = take;
            need -= take;
          }
        }
        clientFor(room, clients, seat)!.send(CatanMsg.ACTION, { type: "discard", cards });
      } else if (prev.phase === "moveRobber") {
        const hex = geo.hexes.find((h) => h.id !== prev.board.robberHex)!.id;
        clientFor(room, clients, prev.currentPlayer)!.send(CatanMsg.ACTION, { type: "moveRobber", hex });
      } else {
        const target = getStealTargets(prev, geo)[0] ?? null;
        clientFor(room, clients, prev.currentPlayer)!.send(CatanMsg.ACTION, { type: "steal", target });
      }
      await until(() => room.engine !== prev);
    }
  }

  /** Roll (twice in 2p) and resolve robbers until the main phase. */
  async function toMain(room: CatanRoom, clients: Array<any>): Promise<void> {
    let guard = 0;
    while (room.engine.phase !== "main" && guard++ < 12) {
      if (room.engine.phase === "preRoll") {
        const prev = room.engine;
        clientFor(room, clients, prev.currentPlayer)!.send(CatanMsg.ACTION, { type: "rollDice" });
        await until(() => room.engine !== prev);
      }
      await flushRobber(room, clients);
    }
    assert.equal(room.engine.phase, "main");
  }

  it("opens with a visible turn-order roll that decides the snake", async () => {
    const room = (await colyseus.createRoom(CATAN, { seed: 91 })) as unknown as CatanRoom;
    const clients = [];
    for (let i = 0; i < 3; i++) clients.push(await colyseus.connectTo(room, { nickname: `Player${i}` }));
    clients[0]!.send(LobbyMsg.START, {});
    await until(() => room.state.phase === Phase.PLAYING);

    assert.equal(room.state.phaseDetail, "rollForOrder");
    assert.deepEqual([...room.state.orderRolls], [-1, -1, -1], "no rolls yet");
    assert.deepEqual([...room.state.awaitingSeats].sort(), [0, 1, 2], "everyone owes a roll");
    assert.equal(room.state.currentTurn, "", "no single actor during the multi-roll");
    assert.ok([...room.state.log].some((l) => l.includes("Everyone rolls for turn order")));

    // each contender rolls; rolls mirror into state and the round resolves
    await driveOrderRoll(room, clients);
    assert.equal(room.engine.phase, "setupSettlement");
    assert.ok([...room.state.orderRolls].every((v) => v >= 2 && v <= 12), "all sums shown");
    assert.ok([...room.state.log].some((l) => /rolled \d\+\d = \d+ for turn order/.test(l)));
    assert.ok([...room.state.log].some((l) => l.includes("goes first")));
    // the highest roller leads the snake
    const sums = [...room.state.orderRolls];
    const winner = sums.indexOf(Math.max(...sums));
    assert.equal(room.engine.currentPlayer, winner);
  });

  it("narrates a tie and re-rolls among the tied players", async () => {
    const room = (await colyseus.createRoom(CATAN, { seed: 92 })) as unknown as CatanRoom;
    const clients = [];
    for (let i = 0; i < 3; i++) clients.push(await colyseus.connectTo(room, { nickname: `Player${i}` }));
    clients[0]!.send(LobbyMsg.START, {});
    await until(() => room.state.phase === Phase.PLAYING);

    // white-box: seats 1 and 2 already maxed; seat 0 cannot beat 12, so the
    // round resolves to a tie no matter what seat 0 rolls.
    room.engine.orderRolls[1] = [6, 6];
    room.engine.orderRolls[2] = [6, 6];
    const prev = room.engine;
    clientFor(room, clients, 0)!.send(CatanMsg.ACTION, { type: "rollForOrder" });
    await until(() => room.engine !== prev);

    assert.equal(room.engine.phase, "rollForOrder", "a tie keeps the phase open");
    assert.ok(room.engine.orderContenders.length >= 2, "tied seats re-roll");
    assert.ok([...room.state.log].some((l) => l.startsWith("Tie —")));
  });

  it("ghost-rolls for a seat that quit during the opening roll, and bots roll on their own", async () => {
    const room = (await colyseus.createRoom(CATAN, { seed: 93 })) as unknown as CatanRoom;
    const host = await colyseus.connectTo(room, { nickname: "Host" });
    const guest = await colyseus.connectTo(room, { nickname: "Guest" });
    host.send(LobbyMsg.ADD_BOT, {});
    await until(() => room.state.players.size === 3);
    room.botDelayMs = 1;
    host.send(LobbyMsg.START, {});
    await until(() => room.state.phase === Phase.PLAYING && room.engine.phase === "rollForOrder");

    // the bot rolls unprompted; the two humans still owe
    await until(() => room.engine.orderContenders.some((s) => room.engine.orderRolls[s] !== null), 3000);

    // guest quits mid-roll; the ghost must roll for them so the phase resolves.
    // Host rolls its own seat (re-rolling if a tie puts it back in contention);
    // the bot (clock) and the quitter's ghost (settleEngine) resolve themselves.
    await guest.leave(true);
    let guard = 0;
    while (room.engine.phase === "rollForOrder" && guard++ < 80) {
      if (room.engine.orderContenders.includes(0) && room.engine.orderRolls[0] === null) {
        host.send(CatanMsg.ACTION, { type: "rollForOrder" });
      }
      await sleep(40);
    }
    assert.equal(room.engine.phase, "setupSettlement", "the opening roll completed without the quitter");
    assert.equal(room.state.phase, Phase.PLAYING);
  });

  it("mirrors the board and runs the setup draft into a 3p game", async () => {
    const { room, clients } = await startedGame(7, 3);
    assert.equal(room.state.twoPlayerVariant, false);
    assert.equal(room.state.seats.length, 3);
    assert.equal(room.state.hexTerrain.length, 19);
    assert.equal(room.state.vertexOwner.length, 54);
    assert.equal(room.state.edgeOwner.length, 72);
    assert.equal(room.state.portTypes.length, 9);
    assert.equal(room.state.hexTerrain.filter((t) => t === "desert").length, 1);
    assert.equal(room.state.hexToken.filter((t) => t === 0).length, 1, "only the desert lacks a token");
    assert.equal(room.state.phaseDetail, "setupSettlement");
    assert.equal(room.state.currentTurn, room.seatOrder[room.engine.currentPlayer]);

    await driveSetup(room, clients);
    assert.equal(room.state.phaseDetail, "preRoll");
    const placed = room.state.vertexOwner.filter((o) => o >= 0).length;
    assert.equal(placed, 6, "3 players x 2 settlements mirrored");
    assert.equal(room.state.edgeOwner.filter((o) => o >= 0).length, 6);
    // starting resources from the second settlement are mirrored as counts
    const totalCards = room.state.seats.reduce((t, s) => t + s.handCount, 0);
    assert.ok(totalCards > 0, "someone has starting resources");
  });

  it("plays to a win and maps the winner through framework seats", async () => {
    const { room, clients } = await startedGame(11, 3);
    await driveSetup(room, clients);

    // White-box stage: blank the board, hand seat 0 a 9-VP position plus the
    // makings of the winning settlement, then deliver the win by message.
    const e = room.engine;
    e.board.vertices.forEach((v) => (v.building = null));
    e.board.edges.forEach((ed) => (ed.road = null));
    e.longestRoadHolder = null;
    const [c1, c2, c3, c4, sett, target] = spacedVertices(6);
    for (const v of [c1, c2, c3, c4]) e.board.vertices[v!]!.building = { owner: 0, type: "city" };
    e.board.vertices[sett!]!.building = { owner: 0, type: "settlement" };
    e.board.edges[geo.vertices[target!]!.edges[0]!]!.road = { owner: 0 };
    e.players[0]!.hand = { lumber: 1, brick: 1, wool: 1, grain: 1, ore: 0 };
    e.players[0]!.piecesLeft.settlements = 2;
    e.players[0]!.devCards.push({ type: "victoryPoint", boughtThisTurn: false, played: false }); // hidden until the end
    e.phase = "main";
    e.currentPlayer = 0;
    assert.equal(victoryPoints(e, 0), 10, "9 building VP + 1 hidden VP card");

    clientFor(room, clients, 0)!.send(CatanMsg.ACTION, { type: "buildSettlement", vertex: target });
    await until(() => room.state.phase === Phase.ENDED);
    const frameworkSeat = room.frameworkSeatByEngineSeat[0]!;
    assert.equal(room.state.endReason, `${EndReason.WIN_PREFIX}${frameworkSeat}`);
    assert.equal(room.state.currentTurn, "", "turn cleared after game end");
    assert.equal(room.state.phaseDetail, "gameOver");
    assert.ok([...room.state.log].some((l) => l.includes("wins")), "the win is narrated");
    // The final score reveals hidden VP cards: publicVP becomes the FULL total.
    assert.equal(room.state.seats[0]!.publicVP, victoryPoints(room.engine, 0));
    assert.equal(room.state.seats[0]!.publicVP, 11, "10 building VP + the revealed VP card");
  });

  it("ignores out-of-turn, malformed, and unknown actions", async () => {
    const { room, clients } = await startedGame(13, 3);
    const actorSeat = room.engine.currentPlayer;
    const bystander = clients.find((c) => c.sessionId !== room.seatOrder[actorSeat])!;
    const actor = clientFor(room, clients, actorSeat)!;
    const before = room.engine;

    const legalVertex = getValidInitialSettlements(geo, room.engine.board)[0]!;
    bystander.send(CatanMsg.ACTION, { type: "placeSetupSettlement", vertex: legalVertex }); // not their turn
    actor.send(CatanMsg.ACTION, { type: "placeSetupSettlement", vertex: 999 }); // out of range
    actor.send(CatanMsg.ACTION, { type: "placeSetupSettlement", vertex: -1 });
    actor.send(CatanMsg.ACTION, { type: "placeSetupSettlement", vertex: 1.5 });
    actor.send(CatanMsg.ACTION, { type: "placeSetupSettlement" }); // missing field
    actor.send(CatanMsg.ACTION, { type: "buildRoad", edge: 0 }); // wrong phase
    actor.send(CatanMsg.ACTION, { type: "rollDice" }); // wrong phase
    actor.send(CatanMsg.ACTION, { type: "moveRobber", hex: 3 }); // wrong phase
    actor.send(CatanMsg.ACTION, { type: "discard", cards: { wool: 1 } }); // owes nothing
    actor.send(CatanMsg.ACTION, { type: "buildNeutral", neutralId: 0, kind: "road", edge: 0 }); // not 2p
    actor.send(CatanMsg.ACTION, { type: "playForcedTrade" }); // not 2p
    actor.send(CatanMsg.ACTION, { type: "endSpecialBuild" }); // never whitelisted
    actor.send(CatanMsg.ACTION, { type: "NOPE" });
    actor.send(CatanMsg.ACTION, "garbage");
    actor.send(CatanMsg.ACTION, null);
    await sleep(120);
    assert.strictEqual(room.engine, before, "engine untouched by garbage");

    actor.send(CatanMsg.ACTION, { type: "placeSetupSettlement", vertex: legalVertex });
    await until(() => room.engine !== before);
    assert.equal(room.engine.phase, "setupRoad", "legal action still lands");
  });

  it("never trusts client dice", async () => {
    const { room, clients } = await startedGame(17, 3);
    await driveSetup(room, clients);
    const prev = room.engine;
    // a client trying to script box cars gets a server roll instead
    clientFor(room, clients, prev.currentPlayer)!.send(CatanMsg.ACTION, { type: "rollDice", dice: [6, 6] });
    await until(() => room.engine !== prev);
    const expected = CatanEngine.reduce(geo, prev, { type: "rollDice" }); // server RNG path
    assert.deepEqual(room.engine.dice, expected.dice, "roll comes from the seeded server RNG");
  });

  it("hides hands and dev cards from opponents, including across a refresh", async () => {
    const { room, clients } = await startedGame(19, 2);
    await driveSetup(room, clients);
    const a = clients.find((c) => c.sessionId === room.seatOrder[0])!;
    const b = clients.find((c) => c.sessionId === room.seatOrder[1])!;

    // white-box a hidden dev card, then reach main (production may add cards)
    room.engine.players[0]!.devCards.push({ type: "victoryPoint", boughtThisTurn: false, played: false });
    await toMain(room, clients);
    // the owner's hand is whatever the rolls produced; both sides agree on it
    const myOre = room.engine.players[0]!.hand.ore;
    const myCount = ["lumber", "brick", "wool", "grain", "ore"].reduce(
      (t, r) => t + (room.engine.players[0]!.hand as any)[r],
      0,
    );

    const aState = () => a.state as any;
    const bState = () => b.state as any;
    await until(() => aState()?.seats?.at(0)?.handCount === myCount);
    assert.equal(aState().seats.at(0).hand?.ore, myOre, "owner sees the hand detail");
    assert.equal(aState().seats.at(0).devCards?.at(0)?.kind, "victoryPoint", "owner sees the card identity");
    assert.equal(bState().seats.at(0).handCount, myCount, "opponent sees the count");
    assert.equal(bState().seats.at(0).hand?.ore ?? 0, 0, "opponent sees no hand detail");
    assert.equal(bState().seats.at(0).devCards?.length ?? 0, 0, "opponent sees no card identities");
    assert.equal(bState().seats.at(0).devCardCount, 1);

    // A refresh-style drop + resume must keep the private view.
    const token = a.reconnectionToken;
    const aSessionId = a.sessionId;
    await a.leave(false);
    await until(() => room.state.players.get(aSessionId)?.connected === false);
    const a2 = await colyseus.sdk.reconnect(token);
    const a2State = () => a2.state as any;
    await until(() => (a2State()?.seats?.at(0)?.hand?.ore ?? -1) === myOre, 5000);
    assert.equal(a2State().seats.at(0).devCards?.at(0)?.kind, "victoryPoint", "still visible after refresh");
    assert.equal(bState().seats.at(0).hand?.ore ?? 0, 0, "opponent still blind after the refresh");
  });

  it("runs a simultaneous discard after a 7, rejecting forged discards", async () => {
    const { room, clients } = await startedGame(23, 3);
    await driveSetup(room, clients);

    // White-box straight into the discard phase: seats 0 and 1 owe halves.
    const e = room.engine;
    e.players[0]!.hand = { lumber: 8, brick: 0, wool: 0, grain: 0, ore: 0 };
    e.players[1]!.hand = { lumber: 0, brick: 0, wool: 0, grain: 4, ore: 4 };
    e.players[2]!.hand = { lumber: 0, brick: 0, wool: 1, grain: 0, ore: 0 };
    e.phase = "discard";
    e.pendingDiscards = { 0: 4, 1: 4 };
    e.robberReturnPhase = "main";

    const a = clientFor(room, clients, 0)!;
    const b = clientFor(room, clients, 1)!;
    const c = clientFor(room, clients, 2)!;

    c.send(CatanMsg.ACTION, { type: "discard", cards: { wool: 1 } }); // owes nothing
    b.send(CatanMsg.ACTION, { type: "discard", cards: { grain: 4, ore: 4 } }); // wrong count
    b.send(CatanMsg.ACTION, { type: "discard", cards: { lumber: 4 } }); // cards b does not hold
    await sleep(120);
    assert.equal(room.engine, e, "bad discards ignored");

    // either owing seat may resolve first; b goes first here
    b.send(CatanMsg.ACTION, { type: "discard", cards: { grain: 2, ore: 2 } });
    await until(() => room.engine.pendingDiscards[1] === undefined);
    assert.equal(room.engine.phase, "discard", "still waiting on seat 0");
    await until(() => room.state.awaitingSeats.length === 1 && room.state.awaitingSeats[0] === 0);
    assert.equal(room.state.discardOwed[0], 4);
    assert.equal(room.state.currentTurn, a.sessionId, "single remaining discarder shown as actor");

    a.send(CatanMsg.ACTION, { type: "discard", cards: { lumber: 4 } });
    await until(() => room.engine.phase === "moveRobber");
    assert.equal(room.state.phaseDetail, "moveRobber");
  });

  it("fans out a domestic trade: respond, forge-proof seats, confirm", async () => {
    const { room, clients } = await startedGame(29, 3);
    await driveSetup(room, clients);
    await toMain(room, clients);

    const proposerSeat = room.engine.currentPlayer;
    const others = [0, 1, 2].filter((s) => s !== proposerSeat);
    const proposer = clientFor(room, clients, proposerSeat)!;
    const partner = clientFor(room, clients, others[0]!)!;
    const third = clientFor(room, clients, others[1]!)!;

    room.engine.players[proposerSeat]!.hand = { lumber: 0, brick: 0, wool: 0, grain: 0, ore: 2 };
    room.engine.players[others[0]!]!.hand = { lumber: 0, brick: 0, wool: 3, grain: 0, ore: 0 };

    proposer.send(CatanMsg.ACTION, { type: "proposeDomesticTrade", give: { ore: 2 }, receive: { wool: 2 } });
    await until(() => room.state.tradeOpen === true);
    assert.equal(room.state.tradeProposer, proposerSeat);
    assert.equal(room.state.tradeGive.ore, 2);
    assert.equal(room.state.tradeReceive.wool, 2);
    assert.deepEqual([...room.state.tradeCandidates].sort(), others);

    // a forged `player` field cannot make someone else accept
    partner.send(CatanMsg.ACTION, { type: "respondDomesticTrade", accept: true, player: others[1] });
    await until(() => room.state.tradeAcceptances.length === 1);
    assert.equal(room.state.tradeAcceptances[0], others[0], "acceptance recorded for the SENDER");

    // confirming with someone who has not accepted is rejected
    const pending = room.engine;
    proposer.send(CatanMsg.ACTION, { type: "confirmDomesticTrade", partner: others[1] });
    await sleep(120);
    assert.equal(room.engine, pending, "unaccepted partner rejected");

    third.send(CatanMsg.ACTION, { type: "respondDomesticTrade", accept: false });
    proposer.send(CatanMsg.ACTION, { type: "confirmDomesticTrade", partner: others[0] });
    await until(() => room.engine.pendingTrade === null);
    assert.equal(room.engine.players[proposerSeat]!.hand.wool, 2);
    assert.equal(room.engine.players[others[0]!]!.hand.ore, 2);
    await until(() => room.state.tradeOpen === false);
    assert.ok([...room.state.log].some((l) => l.includes("traded with")), "the trade is narrated");
  });

  it("shows declines to the proposer and lets a candidate change their mind", async () => {
    const { room, clients } = await startedGame(67, 3);
    await driveSetup(room, clients);
    await toMain(room, clients);

    const proposerSeat = room.engine.currentPlayer;
    const others = [0, 1, 2].filter((s) => s !== proposerSeat);
    const proposer = clientFor(room, clients, proposerSeat)!;
    const partner = clientFor(room, clients, others[0]!)!;

    room.engine.players[proposerSeat]!.hand = { lumber: 0, brick: 0, wool: 0, grain: 0, ore: 2 };
    proposer.send(CatanMsg.ACTION, { type: "proposeDomesticTrade", give: { ore: 1 }, receive: { wool: 1 } });
    await until(() => room.state.tradeOpen === true);

    // declining WITHOUT first accepting (the playtest bug) is now mirrored
    partner.send(CatanMsg.ACTION, { type: "respondDomesticTrade", accept: false });
    await until(() => room.state.tradeDeclines.length === 1);
    assert.equal(room.state.tradeDeclines[0], others[0], "the proposer can see the decline");
    assert.equal(room.state.tradeAcceptances.length, 0);

    // change of mind: decline -> accept moves between the mirrored lists
    partner.send(CatanMsg.ACTION, { type: "respondDomesticTrade", accept: true });
    await until(() => room.state.tradeAcceptances.length === 1);
    assert.equal(room.state.tradeDeclines.length, 0, "no longer declined");
    assert.equal(room.state.tradeAcceptances[0], others[0]);
  });

  it("a leaver's seat auto-declines an open trade so the proposer isn't stuck", async () => {
    const { room, clients } = await startedGame(68, 3);
    await driveSetup(room, clients);
    await toMain(room, clients);

    const proposerSeat = room.engine.currentPlayer;
    const others = [0, 1, 2].filter((s) => s !== proposerSeat);
    const proposer = clientFor(room, clients, proposerSeat)!;
    room.engine.players[proposerSeat]!.hand = { lumber: 0, brick: 0, wool: 0, grain: 0, ore: 2 };
    proposer.send(CatanMsg.ACTION, { type: "proposeDomesticTrade", give: { ore: 1 }, receive: { wool: 1 } });
    await until(() => room.state.tradeOpen === true);

    await clientFor(room, clients, others[0]!)!.leave(true);
    await until(() => [...room.state.tradeDeclines].includes(others[0]!), 3000);
  });

  it("lets the ghost play out a quitter's seat in a 3p game (including a pending discard)", async () => {
    const { room, clients } = await startedGame(31, 3);
    await driveSetup(room, clients);

    // The quitter leaves while owing a discard - the ghost must resolve it.
    const e = room.engine;
    e.players[1]!.hand = { lumber: 12, brick: 0, wool: 0, grain: 0, ore: 0 };
    e.phase = "discard";
    e.pendingDiscards = { 1: 6 };
    e.robberReturnPhase = "main";
    e.currentPlayer = 0;

    const quitter = clientFor(room, clients, 1)!;
    const quitterSessionId = quitter.sessionId;
    await quitter.leave(true);
    await until(() => room.engine.pendingDiscards[1] === undefined || room.state.phase !== Phase.PLAYING);
    assert.equal(room.state.phase, Phase.PLAYING, "game continues with 2 of 3 players");
    assert.equal(
      Object.values(room.engine.players[1]!.hand).reduce((a, b) => a + b, 0),
      6,
      "ghost discarded half",
    );
    await until(() => room.state.seats[1]!.gone === true);
    assert.equal(room.state.seats[1]!.sessionId, "");
    assert.ok(!room.state.players.has(quitterSessionId));
    assert.ok([...room.state.log].some((l) => l.includes("autopilot")));

    // Play on: seat 0 finishes the robber + its turn; the ghost then takes
    // seat 1's whole turn (roll + end) without the game waiting on it.
    await flushRobber(room, clients);
    await toMain(room, clients);
    const beforeEnd = room.engine;
    clientFor(room, clients, 0)!.send(CatanMsg.ACTION, { type: "endTurn" });
    await until(() => room.engine !== beforeEnd);
    await until(() => room.engine.currentPlayer === 2, 5000);
    assert.equal(room.engine.phase, "preRoll", "ghost rolled and ended seat 1's turn in the same beat");
    await until(() => room.state.currentTurn === clientFor(room, clients, 2)!.sessionId);
  });

  it("ends a 2p game as abandoned when a player quits (no ghost completion)", async () => {
    const { room, clients } = await startedGame(37, 2);
    await clients[1]!.leave(true);
    await until(() => room.state.phase === Phase.ENDED);
    assert.equal(room.state.endReason, EndReason.ABANDONED);
    assert.equal(room.state.currentTurn, "");
  });

  it("lets a newcomer reclaim an autopilot seat mid-game (rejoin from any device)", async () => {
    const { room, clients } = await startedGame(38, 3);
    await driveSetup(room, clients);

    // seat 1's human leaves for good -> the seat falls to autopilot
    const goneSeat = 1;
    const leaver = clientFor(room, clients, goneSeat)!;
    await leaver.leave(true);
    await until(() => room.state.seats[goneSeat]!.gone === true);
    assert.equal(room.state.seats[goneSeat]!.sessionId, "");

    // a brand-new client joins with the code and a fresh nickname
    const newcomer = await colyseus.connectTo(room, { nickname: "Latecomer" });
    await until(() => room.state.seats[goneSeat]!.gone === false, 3000);
    assert.equal(room.seatOrder[goneSeat], newcomer.sessionId, "seatOrder rebound");
    assert.equal(room.state.seats[goneSeat]!.sessionId, newcomer.sessionId);
    assert.equal(room.state.seats[goneSeat]!.nickname, "Latecomer");
    assert.ok([...room.state.log].some((l) => l.includes("takes over")));

    // the reclaimed seat is live: it can act and sees its private hand
    room.engine.players[goneSeat]!.hand = { lumber: 0, brick: 0, wool: 0, grain: 0, ore: 5 };
    // nudge a projection by advancing to this seat's turn is unnecessary - force one
    const prev = room.engine;
    room.engine = CatanEngine.cloneGameState(room.engine); // identity bump so project runs
    (room as any).project();
    const nState = () => newcomer.state as any;
    await until(() => nState()?.seats?.at(goneSeat)?.hand?.ore === 5, 3000);
    assert.equal(prev !== room.engine, true);
  });

  it("rejects a mid-game joiner when no seat is open", async () => {
    const { room } = await startedGame(39, 3);
    // all three humans are present -> nothing to reclaim
    let rejected = false;
    try {
      await colyseus.connectTo(room, { nickname: "Crasher" });
    } catch {
      rejected = true;
    }
    assert.ok(rejected, "the join was refused");
    assert.equal(room.state.players.size, 3, "roster unchanged");
    assert.equal(room.state.phase, Phase.PLAYING, "game undisturbed");
  });

  it("starts the official 2-player variant for two humans", async () => {
    const { room, clients } = await startedGame(41, 2);
    assert.equal(room.state.twoPlayerVariant, true);
    assert.equal(room.state.seats.length, 4, "2 humans + 2 neutral seats");
    assert.equal(room.state.seats[2]!.neutral, true);
    assert.equal(room.state.seats[3]!.neutral, true);
    assert.ok(room.state.seats[2]!.nickname.startsWith("Neutral"));
    assert.equal(room.state.vertexOwner.filter((o) => o === 2).length, 1, "neutral A settlement on the board");
    assert.equal(room.state.vertexOwner.filter((o) => o === 3).length, 1);
    assert.equal(room.state.seats[0]!.tradeTokens, 5);
    assert.equal(room.state.tokenSupply, 10);

    await driveSetup(room, clients);
    // double roll mirrored: after roll #1 we are back in preRoll with firstDice
    const prev = room.engine;
    clientFor(room, clients, prev.currentPlayer)!.send(CatanMsg.ACTION, { type: "rollDice" });
    await until(() => room.engine !== prev);
    await flushRobber(room, clients);
    if (room.engine.phase === "preRoll") {
      assert.equal(room.state.rollsThisTurn, 1);
      assert.ok(room.state.firstDice1 >= 1, "first roll mirrored");
    }
    await toMain(room, clients);
    assert.equal(room.state.rollsThisTurn, 2);

    // the neutral-build obligation flows through the schema
    const me = room.engine.currentPlayer;
    room.engine.players[me]!.hand = { lumber: 1, brick: 1, wool: 0, grain: 0, ore: 0 };
    const road = getValidRoads(geo, room.engine.board, me)[0]!;
    clientFor(room, clients, me)!.send(CatanMsg.ACTION, { type: "buildRoad", edge: road });
    await until(() => room.state.phaseDetail === "neutralBuild");
    assert.equal(room.state.pendingNeutralBuilds, 1);
    const nRoad = getValidRoads(geo, room.engine.board, 2)[0]!;
    clientFor(room, clients, me)!.send(CatanMsg.ACTION, { type: "buildNeutral", neutralId: 0, kind: "road", edge: nRoad });
    await until(() => room.state.phaseDetail === "main");
    assert.equal(room.state.edgeOwner[nRoad], 2, "neutral road mirrored");

    // a forced trade round-trip
    room.engine.players[me]!.hand = { lumber: 0, brick: 0, wool: 2, grain: 0, ore: 0 };
    const opp = me === 0 ? 1 : 0;
    room.engine.players[opp]!.hand = { lumber: 0, brick: 0, wool: 0, grain: 3, ore: 0 };
    const tokensBefore = room.engine.players[me]!.tradeTokens;
    clientFor(room, clients, me)!.send(CatanMsg.ACTION, { type: "playForcedTrade" });
    await until(() => room.state.phaseDetail === "forcedTradeGive");
    assert.equal(room.engine.players[me]!.hand.grain, 2, "took 2 random cards");
    clientFor(room, clients, me)!.send(CatanMsg.ACTION, { type: "forcedTradeGiveBack", cards: { wool: 2 } });
    await until(() => room.state.phaseDetail === "main");
    assert.equal(room.engine.players[opp]!.hand.wool, 2);
    assert.equal(room.state.seats[me]!.tradeTokens, tokensBefore - 1, "equal public VP -> 1 token spent");
  });

  it("rematch fully resets the game and re-grants private views", async () => {
    const { room, clients } = await startedGame(43, 2);
    await driveSetup(room, clients);

    // Deliver a quick white-box win for engine seat 0.
    const e = room.engine;
    e.board.vertices.forEach((v) => (v.building = null));
    e.board.edges.forEach((ed) => (ed.road = null));
    e.longestRoadHolder = null;
    const taken = new Set<number>();
    const [c1, c2, c3, c4, sett, target] = spacedVertices(6, taken);
    for (const v of [c1, c2, c3, c4]) e.board.vertices[v!]!.building = { owner: 0, type: "city" };
    e.board.vertices[sett!]!.building = { owner: 0, type: "settlement" };
    e.board.edges[geo.vertices[target!]!.edges[0]!]!.road = { owner: 0 };
    e.players[0]!.hand = { lumber: 1, brick: 1, wool: 1, grain: 1, ore: 0 };
    e.players[0]!.piecesLeft.settlements = 2;
    e.phase = "main";
    e.currentPlayer = 0;
    const a = clientFor(room, clients, 0)!;
    const b = clientFor(room, clients, 1)!;
    a.send(CatanMsg.ACTION, { type: "buildSettlement", vertex: target });
    await until(() => room.state.phase === Phase.ENDED);

    const oldEngine = room.engine;
    a.send(LobbyMsg.REMATCH, {});
    await sleep(80);
    assert.equal(room.state.phase, Phase.ENDED, "one vote is not enough");
    b.send(LobbyMsg.REMATCH, {});
    await until(() => room.state.phase === Phase.PLAYING);
    await driveOrderRoll(room, clients); // the rematch opens with a fresh turn-order roll

    assert.notStrictEqual(room.engine, oldEngine, "fresh engine");
    assert.equal(room.state.phaseDetail, "setupSettlement");
    assert.equal(room.state.vertexOwner.filter((o) => o >= 0).length, 2, "only the neutral settlements remain");
    assert.equal(room.state.edgeOwner.filter((o) => o >= 0).length, 0);
    assert.equal(room.state.turnCount, 0);
    assert.equal(room.state.longestRoadHolder, 255);
    for (const seat of room.state.seats) {
      assert.equal(seat.publicVP, seat.neutral ? 1 : 0, "human VP reset (neutral settlement is 1)");
      assert.equal(seat.handCount, 0);
      assert.equal(seat.gone, false);
    }

    // the rematch built new seat objects - the re-granted views must follow
    await driveSetup(room, clients);
    room.engine.players[0]!.devCards.push({ type: "monopoly", boughtThisTurn: false, played: false });
    await toMain(room, clients);
    const aState = () => a.state as any;
    await until(() => (aState()?.seats?.at(0)?.devCards?.length ?? 0) === 1, 5000);
    assert.equal(aState().seats.at(0).devCards.at(0).kind, "monopoly", "owner sees the new game's card");
    const bState = () => b.state as any;
    assert.equal(bState().seats.at(0).devCards?.length ?? 0, 0, "opponent still blind");
  });

  it("lets the host seat bots and a solo human finishes a full game against one", async function () {
    this.timeout(120000);
    const room = (await colyseus.createRoom(CATAN, { seed: 47 })) as unknown as CatanRoom;
    const host = await colyseus.connectTo(room, { nickname: "Solo" });
    const guestRoom = room; // alias for clarity

    host.send(LobbyMsg.ADD_BOT, {});
    await until(() => guestRoom.state.players.size === 2);
    const bot = [...guestRoom.state.players.values()].find((p) => p.isBot)!;
    assert.ok(bot.sessionId.startsWith("bot:"));

    room.botDelayMs = 1; // pacing is UX, not logic
    host.send(LobbyMsg.START, {});
    await until(() => room.state.phase === Phase.PLAYING);
    assert.equal(room.state.twoPlayerVariant, true, "1 human + 1 bot plays the official 2p variant");

    const policy = new GreedyPolicy(5);
    const hostSeat = room.seatOrder.indexOf(host.sessionId);
    let guard = 0;
    while (room.state.phase === Phase.PLAYING) {
      assert.ok(++guard < 6000, "game did not terminate");
      const prev = room.engine;
      const mustAct =
        prev.phase === "discard"
          ? Object.keys(prev.pendingDiscards).map(Number).includes(hostSeat)
          : prev.currentPlayer === hostSeat;
      if (mustAct) {
        host.send(CatanMsg.ACTION, policy.act(geo, prev, hostSeat));
      }
      // either our message lands or the bot acts unprompted
      await until(() => room.engine !== prev || room.state.phase !== Phase.PLAYING, 8000);
    }

    assert.equal(room.state.phase, Phase.ENDED);
    assert.ok(room.state.endReason.startsWith(EndReason.WIN_PREFIX), "someone won outright");
    const winnerSeat = room.engine.winner!;
    assert.equal(
      room.state.endReason,
      `${EndReason.WIN_PREFIX}${room.frameworkSeatByEngineSeat[winnerSeat]}`,
    );
  });

  it("lets each player pick a piece color; conflicts rejected; colors flow to seats", async () => {
    const room = (await colyseus.createRoom(CATAN, { seed: 54 })) as unknown as CatanRoom;
    const a = await colyseus.connectTo(room, { nickname: "Ann" });
    const b = await colyseus.connectTo(room, { nickname: "Ben" });
    const colorOf = (sid: string) => (room.state.players.get(sid) as any).colorChoice;

    a.send(CatanMsg.PICK_COLOR, { color: "orange" });
    await until(() => colorOf(a.sessionId) === "orange");
    b.send(CatanMsg.PICK_COLOR, { color: "orange" }); // taken by Ann
    b.send(CatanMsg.PICK_COLOR, { color: "lime" }); // not a playable color
    await sleep(100);
    assert.equal(colorOf(b.sessionId), "", "conflicting / invalid picks ignored");

    b.send(CatanMsg.PICK_COLOR, { color: "blue" });
    await until(() => colorOf(b.sessionId) === "blue");
    a.send(CatanMsg.PICK_COLOR, { color: "" }); // clear
    await until(() => colorOf(a.sessionId) === "");

    a.send(CatanMsg.PICK_COLOR, { color: "white" });
    await until(() => colorOf(a.sessionId) === "white");
    a.send(LobbyMsg.START, {});
    await until(() => room.state.phase === Phase.PLAYING);
    // 2 humans -> official variant -> 4 seats; humans wear their picks, neutrals the rest
    assert.equal(room.state.seats[0]!.color, "white", "Ann's pick honored");
    assert.equal(room.state.seats[1]!.color, "blue", "Ben's pick honored");
    const neutralColors = [room.state.seats[2]!.color, room.state.seats[3]!.color];
    assert.deepEqual(neutralColors.sort(), ["orange", "red"], "neutrals take the leftover palette");

    // mid-game picks are ignored
    a.send(CatanMsg.PICK_COLOR, { color: "blue" });
    await sleep(100);
    assert.equal(room.state.seats[0]!.color, "white");
  });

  it("rule toggles are host-only and lobby-only", async () => {
    const room = (await colyseus.createRoom(CATAN, { seed: 53 })) as unknown as CatanRoom;
    const host = await colyseus.connectTo(room, { nickname: "Host" });
    const guest = await colyseus.connectTo(room, { nickname: "Guest" });
    assert.equal(room.state.useTwoPlayerVariant, true, "official 2p rules by default");
    assert.equal(room.state.robberBounty, false, "house rule off by default");

    host.send(CatanMsg.CONFIG, { robberBounty: true });
    await until(() => room.state.robberBounty === true);
    host.send(CatanMsg.CONFIG, { useTwoPlayerVariant: false });
    await until(() => room.state.useTwoPlayerVariant === false);

    guest.send(CatanMsg.CONFIG, { robberBounty: false, useTwoPlayerVariant: true }); // not the host
    host.send(CatanMsg.CONFIG, { robberBounty: "yes", useTwoPlayerVariant: 1 }); // wrong types
    host.send(CatanMsg.CONFIG, {});
    await sleep(100);
    assert.equal(room.state.robberBounty, true, "junk and non-host configs ignored");
    assert.equal(room.state.useTwoPlayerVariant, false);

    host.send(LobbyMsg.START, {});
    await until(() => room.state.phase === Phase.PLAYING);
    host.send(CatanMsg.CONFIG, { robberBounty: false }); // mid-game: ignored
    await sleep(100);
    assert.equal(room.state.robberBounty, true);
    assert.equal(room.engine.robberBounty, true, "the toggle reached the engine");
  });

  it("two humans with the variant toggled off play the plain standard rules", async () => {
    const { room, clients } = await startedGame(59, 2, (r) => {
      r.state.useTwoPlayerVariant = false;
    });
    assert.equal(room.state.twoPlayerVariant, false);
    assert.equal(room.state.seats.length, 2, "no neutral seats");
    assert.ok(room.state.vertexOwner.every((o) => o === -1), "no pre-placed settlements");
    assert.ok([...room.state.log].some((l) => l.includes("plain standard rules")));

    await driveSetup(room, clients);
    const prev = room.engine;
    clientFor(room, clients, prev.currentPlayer)!.send(CatanMsg.ACTION, { type: "rollDice" });
    await until(() => room.engine !== prev);
    await flushRobber(room, clients);
    assert.equal(room.engine.phase, "main", "single roll per turn");
    assert.equal(room.state.rollsThisTurn, 1);
  });

  it("the robber-bounty house rule flows end to end", async () => {
    const { room, clients } = await startedGame(61, 3, (r) => {
      r.state.robberBounty = true;
    });
    await driveSetup(room, clients);
    assert.ok([...room.state.log].some((l) => l.includes("House rule")));

    // white-box to the robber decision, aimed at an unoccupied resource hex
    const e = room.engine;
    e.phase = "moveRobber";
    e.robberReturnPhase = "main";
    e.currentPlayer = 0;
    const hex = geo.hexes.find((h) => {
      const hs = e.board.hexes[h.id]!;
      const res = CatanEngine.TERRAIN_RESOURCE[hs.terrain];
      if (h.id === e.board.robberHex || res === null) return false;
      return h.vertices.every((v) => e.board.vertices[v]!.building === null);
    })!.id;
    const res = CatanEngine.TERRAIN_RESOURCE[e.board.hexes[hex]!.terrain]!;
    const actor = clientFor(room, clients, 0)!;

    actor.send(CatanMsg.ACTION, { type: "moveRobber", hex });
    await until(() => room.state.phaseDetail === "steal");
    assert.equal(room.state.currentTurn, actor.sessionId, "the mover owes the choice even with no targets");

    const before = room.engine.players[0]!.hand[res];
    actor.send(CatanMsg.ACTION, { type: "robberTake" });
    await until(() => room.state.phaseDetail === "main");
    assert.equal(room.engine.players[0]!.hand[res], before + 1, "took the tile's resource");
    assert.ok([...room.state.log].some((l) => l.includes("from the bank with the robber")));
  });

  it("sanitize: forges and junk shapes are rejected, player fields are forced", () => {
    const limits = { hexes: 19, vertices: 54, edges: 72, seats: 4 };
    assert.equal(sanitizeAction(null, 0, limits), null);
    assert.equal(sanitizeAction("x", 0, limits), null);
    assert.equal(sanitizeAction({ type: "endSpecialBuild" }, 0, limits), null);
    assert.equal(sanitizeAction({ type: "moveRobber", hex: 19 }, 0, limits), null);
    assert.equal(sanitizeAction({ type: "playYearOfPlenty", resources: ["ore"] }, 0, limits), null);
    assert.equal(sanitizeAction({ type: "playYearOfPlenty", resources: ["ore", "gold"] }, 0, limits), null);
    assert.equal(sanitizeAction({ type: "discard", cards: { gold: 1 } }, 0, limits), null);
    assert.equal(sanitizeAction({ type: "discard", cards: { ore: 1.5 } }, 0, limits), null);
    const forged = sanitizeAction({ type: "discard", player: 3, cards: { ore: 2 } }, 1, limits);
    assert.deepEqual(forged, { type: "discard", player: 1, cards: { ore: 2 } });
    const respond = sanitizeAction({ type: "respondDomesticTrade", player: 2, accept: true }, 0, limits);
    assert.deepEqual(respond, { type: "respondDomesticTrade", player: 0, accept: true });
    const roll = sanitizeAction({ type: "rollDice", dice: [6, 6] }, 0, limits);
    assert.deepEqual(roll, { type: "rollDice" }, "client dice stripped");
  });
});
