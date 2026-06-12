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
});
