import assert from "node:assert/strict";
import { boot, type ColyseusTestServer } from "@colyseus/testing";
import { defineRoom, defineServer } from "colyseus";
import {
  EndReason,
  LobbyMsg,
  Phase,
  SPLENDOR,
  SplendorEngine,
  SplendorMsg,
} from "@backbone/shared";
import { SplendorRoom } from "../src/games/splendor/SplendorRoom.js";
import { sleep, until } from "./StubRoom.js";

const { GreedyPolicy, assertInvariants, ranking } = SplendorEngine;

function makeConfig() {
  return defineServer({
    rooms: { [SPLENDOR]: defineRoom(SplendorRoom) },
  });
}

describe("splendor", () => {
  let colyseus: ColyseusTestServer<ReturnType<typeof makeConfig>>;

  before(async () => {
    colyseus = await boot(makeConfig());
  });
  after(async () => colyseus.shutdown());
  beforeEach(async () => await colyseus.cleanup());

  async function startedGame(seed = 42, playerCount = 2) {
    const room = (await colyseus.createRoom(SPLENDOR, { seed })) as unknown as SplendorRoom;
    const clients = [];
    for (let i = 0; i < playerCount; i++) {
      clients.push(await colyseus.connectTo(room, { nickname: `Player${i}` }));
    }
    clients[0]!.send(LobbyMsg.START, {});
    await until(() => room.state.phase === Phase.PLAYING);
    return { room, clients };
  }

  it("plays a full 2p game to completion (greedy)", async function () {
    this.timeout(60000);
    const { room, clients } = await startedGame(7);
    const policy = new GreedyPolicy(1);
    const bySession = new Map(clients.map((c) => [c.sessionId, c]));

    let guard = 0;
    while (room.state.phase === Phase.PLAYING) {
      assert.ok(++guard < 2000, "game did not terminate");
      const prev = room.engine; // applyMove clones: identity changes on every accepted input
      const actor = bySession.get(room.seatOrder[prev.awaiting.seat]!)!;
      if (prev.awaiting.inputType === "MOVE") {
        const move = policy.move(prev);
        assert.ok(move, "server should have auto-passed a no-move seat");
        actor.send(SplendorMsg.MOVE, move);
      } else if (prev.awaiting.inputType === "PICK_NOBLE") {
        actor.send(SplendorMsg.RESOLVE, policy.pickNoble(prev));
      } else {
        actor.send(SplendorMsg.RESOLVE, policy.discard(prev));
      }
      await until(() => room.engine !== prev || room.state.phase !== Phase.PLAYING, 5000);
      assertInvariants(room.engine); // every accepted input preserves engine invariants
    }

    assert.strictEqual(room.state.phase, Phase.ENDED);
    // endReason must agree with the engine ranking via the framework-seat snapshot.
    const winners = ranking(room.engine).filter((r) => r.rank === 1);
    if (winners.length === 1) {
      const frameworkSeat = room.frameworkSeatByEngineSeat[winners[0]!.seat]!;
      assert.strictEqual(room.state.endReason, `${EndReason.WIN_PREFIX}${frameworkSeat}`);
    } else {
      assert.strictEqual(room.state.endReason, EndReason.DRAW);
    }
    assert.strictEqual(room.state.currentTurn, "", "turn cleared after game end");
  });

  it("hides reserved cards from opponents, including across a refresh", async () => {
    const { room, clients } = await startedGame(11);
    const a = clients[0]!;
    const b = clients[1]!;
    const aState = () => a.state as any;
    const bState = () => b.state as any;
    // Harness sanity first, so a decode problem fails here and not as a
    // bogus redaction result.
    await until(() => aState()?.phase === Phase.PLAYING);

    a.send(SplendorMsg.MOVE, { kind: "RESERVE", from: { deck: { tier: 1 } } });
    await until(() => room.engine.players[0]!.reserved.length === 1);

    await until(() => aState().seats?.at(0)?.reserved?.length === 1);
    assert.ok(aState().seats.at(0).reserved.at(0).id >= 1, "owner sees the card identity");
    await until(() => bState().seats?.at(0)?.reservedCount === 1);
    assert.strictEqual(
      bState().seats.at(0).reserved?.length ?? 0,
      0,
      "opponent sees no reserved cards"
    );

    // A refresh-style drop + resume must keep the private view.
    const token = a.reconnectionToken;
    const aSessionId = a.sessionId;
    await a.leave(false);
    await until(() => room.state.players.get(aSessionId)?.connected === false);
    const a2 = await colyseus.sdk.reconnect(token);
    const a2State = () => a2.state as any;
    await until(() => a2State()?.seats?.at(0)?.reserved?.length === 1, 5000);
    assert.ok(a2State().seats.at(0).reserved.at(0).id >= 1, "owner still sees it after refresh");
    assert.strictEqual(
      bState().seats.at(0).reserved?.length ?? 0,
      0,
      "opponent still blind after the refresh"
    );
  });

  it("ignores illegal and malformed inputs", async () => {
    const { room, clients } = await startedGame(5);
    const a = clients[0]!;
    const b = clients[1]!;
    const before = room.engine;

    b.send(SplendorMsg.MOVE, { kind: "TAKE_TWO", color: "white" }); // not their turn
    a.send(SplendorMsg.MOVE, {});
    a.send(SplendorMsg.MOVE, { kind: "NOPE" });
    a.send(SplendorMsg.MOVE, { kind: "TAKE_THREE", colors: ["white", "white", "blue"] }); // dupes
    a.send(SplendorMsg.MOVE, { kind: "TAKE_THREE", colors: ["white"] }); // must take 3 while 5 piles live
    a.send(SplendorMsg.MOVE, { kind: "TAKE_THREE", colors: [] });
    a.send(SplendorMsg.MOVE, { kind: "BUY", from: { market: { tier: 9, index: 0 } } });
    a.send(SplendorMsg.MOVE, { kind: "BUY", from: { market: { tier: 1, index: 1.5 } } });
    a.send(SplendorMsg.MOVE, { kind: "BUY", from: { market: { tier: 1, index: 0 } } }); // unaffordable at start
    a.send(SplendorMsg.MOVE, { kind: "RESERVE", from: {} });
    a.send(SplendorMsg.RESOLVE, { kind: "DISCARD", gems: { white: 1 } }); // awaiting MOVE, not DISCARD
    a.send(SplendorMsg.RESOLVE, { kind: "PICK_NOBLE", nobleId: 1 });
    await sleep(100);
    assert.strictEqual(room.engine, before, "engine untouched by garbage");
    assert.strictEqual(room.state.currentTurn, a.sessionId, "still seat 0's turn");

    // TAKE_TWO needs a pile of 4: shrink the white pile, watch the same
    // message get rejected, restore, watch it succeed.
    room.engine.supplyGems.white = 3;
    a.send(SplendorMsg.MOVE, { kind: "TAKE_TWO", color: "white" });
    await sleep(100);
    assert.strictEqual(room.engine, before, "take-two from a pile of 3 rejected");

    room.engine.supplyGems.white = 4;
    a.send(SplendorMsg.MOVE, { kind: "TAKE_TWO", color: "white" });
    await until(() => room.engine !== before);
    assert.strictEqual(room.engine.players[0]!.gems.white, 2, "take-two applied");
    await until(() => room.state.currentTurn === b.sessionId);
  });

  it("runs the discard flow, including discarding gold", async () => {
    const { room, clients } = await startedGame(23);
    const a = clients[0]!;
    const b = clients[1]!;
    // 8 tokens injected; taking 3 more puts seat 0 one over the limit of 10.
    const me = room.engine.players[0]!;
    me.gems.white = 4;
    me.gems.blue = 3;
    me.gold = 1;

    a.send(SplendorMsg.MOVE, { kind: "TAKE_THREE", colors: ["green", "red", "black"] });
    await until(() => room.engine.awaiting.inputType === "DISCARD");
    assert.strictEqual(room.engine.awaiting.discardCount, 1);
    await until(() => room.state.awaitingType === "DISCARD");
    assert.strictEqual(room.state.discardCount, 1);
    assert.strictEqual(room.state.awaitingSeat, 0);
    assert.strictEqual(room.state.currentTurn, a.sessionId, "same seat keeps the turn mid-decision");

    const pending = room.engine;
    b.send(SplendorMsg.RESOLVE, { kind: "DISCARD", gems: { white: 1 } }); // not their decision
    a.send(SplendorMsg.RESOLVE, { kind: "DISCARD", gems: { white: 2 } }); // wrong count
    a.send(SplendorMsg.RESOLVE, { kind: "DISCARD", gems: {}, gold: 2 }); // wrong count via gold
    a.send(SplendorMsg.RESOLVE, { kind: "DISCARD", gems: { white: -1 }, gold: 2 }); // negative
    await sleep(100);
    assert.strictEqual(room.engine, pending, "bad discards ignored");

    a.send(SplendorMsg.RESOLVE, { kind: "DISCARD", gems: {}, gold: 1 }); // give up the gold
    await until(() => room.engine !== pending);
    assert.strictEqual(room.engine.players[0]!.gold, 0, "gold discarded");
    assert.strictEqual(room.engine.awaiting.inputType, "MOVE");
    assert.strictEqual(room.engine.awaiting.seat, 1);
    await until(() => room.state.currentTurn === b.sessionId);
    assert.strictEqual(room.state.awaitingType, "MOVE");
    assert.strictEqual(room.state.seats[0]!.gold, 0, "schema mirrors the spent gold");
  });

  it("runs the pick-noble flow when two nobles qualify at once", async () => {
    const { room, clients } = await startedGame(29);
    const a = clients[0]!;
    const b = clients[1]!;
    // Meet two nobles' requirements at once. Trigger end-of-turn with a token
    // take: a BUY would recompute bonuses from built cards and wipe these.
    const me = room.engine.players[0]!;
    const n1 = room.engine.nobles[0]!;
    const n2 = room.engine.nobles[1]!;
    for (const c of ["white", "blue", "green", "red", "black"] as const) {
      me.bonuses[c] = Math.max(n1.requirement[c], n2.requirement[c]);
    }

    a.send(SplendorMsg.MOVE, { kind: "TAKE_TWO", color: "white" });
    await until(() => room.engine.awaiting.inputType === "PICK_NOBLE");
    const choices = room.engine.awaiting.nobleChoices ?? [];
    assert.ok(choices.length >= 2, "both nobles offered");
    await until(() => room.state.awaitingType === "PICK_NOBLE");
    assert.deepEqual([...room.state.nobleChoices], choices, "choices mirrored to clients");
    assert.strictEqual(room.state.currentTurn, a.sessionId);

    const pending = room.engine;
    b.send(SplendorMsg.RESOLVE, { kind: "PICK_NOBLE", nobleId: choices[0] }); // not their decision
    a.send(SplendorMsg.RESOLVE, { kind: "PICK_NOBLE", nobleId: 99 }); // out of range
    a.send(SplendorMsg.RESOLVE, { kind: "PICK_NOBLE", nobleId: 0 });
    a.send(SplendorMsg.RESOLVE, { kind: "PICK_NOBLE", nobleId: String(choices[0]) }); // wrong type
    await sleep(100);
    assert.strictEqual(room.engine, pending, "bad picks ignored");

    const picked = Math.min(...choices);
    a.send(SplendorMsg.RESOLVE, { kind: "PICK_NOBLE", nobleId: picked });
    await until(() => room.engine !== pending);
    assert.strictEqual(room.engine.players[0]!.nobles.length, 1, "exactly one noble awarded");
    assert.strictEqual(room.engine.players[0]!.nobles[0]!.id, picked);
    await until(() => room.state.seats[0]!.nobles.length === 1);
    assert.ok(
      [...room.state.nobles].every((n) => n.id !== picked),
      "awarded noble removed from the board"
    );
    assert.strictEqual(room.state.seats[0]!.points, 3);
    await until(() => room.state.currentTurn === b.sessionId);
  });

  it("lets the ghost play out a quitter's seat in a 3p game", async () => {
    const { room, clients } = await startedGame(13, 3);
    const [a, , c] = clients;
    const quitter = clients[1]!;
    const quitterSessionId = quitter.sessionId;

    // The quitter leaves while owing a discard - the ghost must resolve the
    // pending decision, not just their future turns.
    room.engine.awaiting = { seat: 1, inputType: "DISCARD", discardCount: 2 };
    room.engine.players[1]!.gems.white = 12;

    await quitter.leave(true);
    await until(() => room.engine.awaiting.seat !== 1 || room.engine.over);
    assert.strictEqual(room.state.phase, Phase.PLAYING, "game continues with 2 of 3 players");
    assert.strictEqual(room.engine.players[1]!.gems.white, 10, "ghost discarded down to 10");
    await until(() => room.state.seats[1]!.gone === true);
    assert.strictEqual(room.state.seats[1]!.sessionId, "");
    assert.ok(!room.state.players.has(quitterSessionId));
    assert.strictEqual(room.engine.awaiting.seat, 2, "play moved on past the quitter");
    await until(() => room.state.currentTurn === c!.sessionId);

    // A full rotation: seat 2 moves, seat 0 moves, and the ghost takes seat
    // 1's turn in between without the game ever waiting on it.
    const policy = new GreedyPolicy(2);
    let prev = room.engine;
    c!.send(SplendorMsg.MOVE, policy.move(prev)!);
    await until(() => room.engine !== prev);
    assert.strictEqual(room.engine.awaiting.seat, 0);
    await until(() => room.state.currentTurn === a!.sessionId);

    prev = room.engine;
    const turnsBefore = prev.turnCount;
    a!.send(SplendorMsg.MOVE, policy.move(prev)!);
    await until(() => room.engine !== prev);
    assert.strictEqual(room.engine.awaiting.seat, 2, "ghost played seat 1 in the same beat");
    assert.strictEqual(room.engine.turnCount, turnsBefore + 2, "seat 0's turn plus the ghost's");
    await until(() => room.state.currentTurn === c!.sessionId);
  });

  it("rematch fully resets the game and re-grants private views", async () => {
    const { room, clients } = await startedGame(17);
    const a = clients[0]!;
    const b = clients[1]!;
    const zero = { white: 0, blue: 0, green: 0, red: 0, black: 0 };
    // Hand seat 0 a 15-point finish: 14 built points plus a free 1-point
    // reserve buy. Ids stay <= 90 so the uint8 schema fields can mirror them.
    const me = room.engine.players[0]!;
    me.built.push({ id: 88, tier: 3, bonus: "white", points: 14, cost: { ...zero } });
    me.reserved.push({ id: 89, tier: 1, bonus: "white", points: 1, cost: { ...zero } });

    a.send(SplendorMsg.MOVE, { kind: "BUY", from: { reserve: { cardId: 89 } } });
    await until(() => room.state.lastRound === true);
    assert.strictEqual(room.state.phase, Phase.PLAYING, "finishRound: the round completes first");

    b.send(SplendorMsg.MOVE, { kind: "TAKE_THREE", colors: ["white", "blue", "green"] });
    await until(() => room.state.phase === Phase.ENDED);
    assert.strictEqual(room.state.endReason, `${EndReason.WIN_PREFIX}0`);

    const oldEngine = room.engine;
    a.send(LobbyMsg.REMATCH, {});
    b.send(LobbyMsg.REMATCH, {});
    await until(() => room.state.phase === Phase.PLAYING);

    assert.notStrictEqual(room.engine, oldEngine, "fresh engine");
    assert.deepEqual([...room.state.deckCounts], [36, 26, 16]);
    assert.strictEqual(room.state.bank.white, 4, "2p bank resets to 4 per gem");
    assert.strictEqual(room.state.bankGold, 5);
    assert.strictEqual(room.state.nobles.length, 3, "players + 1 nobles");
    assert.ok([...room.state.market].every((card) => card.id >= 1), "12 market cards dealt");
    for (const seat of room.state.seats) {
      assert.strictEqual(seat.points, 0);
      assert.strictEqual(seat.built.length, 0);
      assert.strictEqual(seat.nobles.length, 0);
      assert.strictEqual(seat.reservedCount, 0);
      assert.strictEqual(seat.gone, false);
      assert.ok(seat.sessionId !== "");
    }
    assert.strictEqual(room.state.turnCount, 0);
    assert.strictEqual(room.state.lastRound, false);
    assert.strictEqual(room.state.currentTurn, a.sessionId, "seat 0 starts again");

    // The rematch built new reserved arrays - the re-grant must follow them.
    a.send(SplendorMsg.MOVE, { kind: "RESERVE", from: { deck: { tier: 1 } } });
    await until(() => room.engine.players[0]!.reserved.length === 1);
    const aState = () => a.state as any;
    await until(() => aState().seats?.at(0)?.reserved?.length === 1);
    assert.ok(aState().seats.at(0).reserved.at(0).id >= 1, "owner sees the new game's card");
    const bState = () => b.state as any;
    assert.strictEqual(bState().seats.at(0).reserved?.length ?? 0, 0, "opponent still blind");
  });

  it("ends a 2p game as abandoned when a player quits (no ghost completion)", async () => {
    const { room, clients } = await startedGame(31);
    await clients[1]!.leave(true);
    await until(() => room.state.phase === Phase.ENDED);
    assert.strictEqual(room.state.endReason, EndReason.ABANDONED);
    assert.strictEqual(room.state.currentTurn, "", "turn cleared after game end");
  });
});
