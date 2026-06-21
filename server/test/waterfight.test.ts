// Water Fight room — integration tests (real SDK clients via @colyseus/testing).
// Mirrors splendor.test.ts: full game to a win, illegal/out-of-turn ignored,
// rematch reset, and hidden-hand @view() survives a refresh.
import assert from "node:assert/strict";
import { boot, type ColyseusTestServer } from "@colyseus/testing";
import { defineRoom, defineServer } from "colyseus";
import { EndReason, LobbyMsg, Phase, WATER_FIGHT, WaterFightEngine, WaterFightMsg } from "@backbone/shared";
import { WaterFightRoom } from "../src/games/waterfight/WaterFightRoom.js";
import { sleep, until } from "./StubRoom.js";

const { RandomPolicy, assertInvariants } = WaterFightEngine;

function makeConfig() {
  return defineServer({
    rooms: { [WATER_FIGHT]: defineRoom(WaterFightRoom) },
  });
}

describe("water fight room", () => {
  let colyseus: ColyseusTestServer<ReturnType<typeof makeConfig>>;

  before(async () => {
    colyseus = await boot(makeConfig());
  });
  after(async () => colyseus.shutdown());
  beforeEach(async () => await colyseus.cleanup());

  async function startedGame(seed = 42, playerCount = 2, beforeStart?: (room: WaterFightRoom) => void) {
    const room = (await colyseus.createRoom(WATER_FIGHT, { seed })) as unknown as WaterFightRoom;
    const clients = [];
    for (let i = 0; i < playerCount; i++) {
      clients.push(await colyseus.connectTo(room, { nickname: `Player${i}` }));
    }
    // Turn off the auto-pass timers so the test fully drives every decision.
    room.state.turnSeconds = 0;
    room.state.reactionSeconds = 0;
    beforeStart?.(room);
    clients[0]!.send(LobbyMsg.START, {});
    await until(() => room.state.phase === Phase.PLAYING);
    return { room, clients };
  }

  it("plays a full 2p game to a win (driven by a policy)", async function () {
    this.timeout(60000);
    const { room, clients } = await startedGame(7);
    const policy = new RandomPolicy(1);
    const bySession = new Map(clients.map((c) => [c.sessionId, c]));

    let guard = 0;
    while (room.state.phase === Phase.PLAYING) {
      assert.ok(++guard < 6000, "game did not terminate");
      const prev = room.engine;
      const seat = prev.awaiting.seats[0]!;
      const actor = bySession.get(room.seatOrder[seat]!)!;
      if (prev.awaiting.kind === "MOVE") {
        actor.send(WaterFightMsg.MOVE, policy.move(prev));
      } else {
        actor.send(WaterFightMsg.RESOLVE, policy.resolve(prev));
      }
      await until(() => room.engine !== prev || room.state.phase !== Phase.PLAYING, 5000);
      assertInvariants(room.engine);
    }

    assert.strictEqual(room.state.phase, Phase.ENDED);
    assert.ok(
      room.state.endReason.startsWith(EndReason.WIN_PREFIX) || room.state.endReason === EndReason.DRAW,
      `unexpected endReason ${room.state.endReason}`,
    );
    assert.strictEqual(room.state.currentTurn, "", "turn cleared after game end");
  });

  it("ignores illegal and out-of-turn messages", async () => {
    const { room, clients } = await startedGame(5);
    const a = clients[0]!;
    const b = clients[1]!;
    const before = room.engine;
    // seat 0 is the opening turn; b acting + garbage payloads must do nothing
    b.send(WaterFightMsg.MOVE, { kind: "THROW", target: 0 });
    a.send(WaterFightMsg.MOVE, {});
    a.send(WaterFightMsg.MOVE, { kind: "NOPE" });
    a.send(WaterFightMsg.MOVE, { kind: "THROW", target: 0 }); // target self
    a.send(WaterFightMsg.RESOLVE, { kind: "DEFEND", defense: "miss" }); // not awaiting a resolution
    await sleep(120);
    assert.strictEqual(room.engine, before, "engine untouched by garbage / out-of-turn input");
    assert.strictEqual(room.state.currentTurn, a.sessionId, "still seat 0's turn");

    // A legal move from the right player advances the engine.
    a.send(WaterFightMsg.MOVE, { kind: "END_TURN" });
    await until(() => room.engine !== before);
    assert.strictEqual(room.state.turnSeat, 1, "turn advanced to seat 1");
  });

  it("hides each hand from opponents, including across a refresh", async () => {
    const { room, clients } = await startedGame(11);
    const a = clients[0]!;
    const b = clients[1]!;
    const aState = () => a.state as unknown as { seats: { hand: { length: number }; handCount: number }[] };
    const bState = () => b.state as unknown as { seats: { hand: { length: number }; handCount: number }[] };

    await until(() => room.engine.players[0]!.hand.length === 2);
    await until(() => (aState().seats?.at(0)?.hand?.length ?? 0) === 2);
    assert.strictEqual(aState().seats.at(0)!.handCount, 2, "public count visible to owner");
    await until(() => bState().seats?.at(0)?.handCount === 2);
    assert.strictEqual(bState().seats.at(0)!.hand?.length ?? 0, 0, "opponent sees no card identities");

    // Refresh-style reconnect of the owner.
    const token = a.reconnectionToken;
    const aSessionId = a.sessionId;
    await a.leave(false);
    await until(() => room.state.players.get(aSessionId)?.connected === false);
    const a2 = await colyseus.sdk.reconnect(token);
    const a2State = () => a2.state as unknown as { seats: { hand: { length: number } }[] };
    await until(() => (a2State().seats?.at(0)?.hand?.length ?? 0) === 2, 5000);
    assert.strictEqual(bState().seats.at(0)!.hand?.length ?? 0, 0, "opponent still blind after the refresh");
  });

  it("rematch fully resets the game", async () => {
    const { room, clients } = await startedGame(3);
    const a = clients[0]!;
    const b = clients[1]!;

    // Force a quick finish: seat 1 at 1 life, seat 0 throws a guaranteed hit.
    room.engine.players[1]!.lives = 1;
    room.engine.players[0]!.hand = [{ id: 10000, kind: "balloon" }];
    room.engine.players[1]!.hand = [];
    room.engine.splashPile = ["hit", "hit"];
    a.send(WaterFightMsg.MOVE, { kind: "THROW", target: 1 });
    await until(() => room.engine.awaiting.kind === "DEFEND");
    b.send(WaterFightMsg.RESOLVE, { kind: "DEFEND", defense: "pass" });
    await until(() => room.state.phase === Phase.ENDED);
    assert.strictEqual(room.state.endReason, `${EndReason.WIN_PREFIX}0`);

    const oldEngine = room.engine;
    a.send(LobbyMsg.REMATCH, {});
    b.send(LobbyMsg.REMATCH, {});
    await until(() => room.state.phase === Phase.PLAYING);
    assert.notStrictEqual(room.engine, oldEngine, "fresh engine");
    assert.strictEqual(room.engine.players[0]!.lives, 3, "lives reset");
    assert.strictEqual(room.engine.players[1]!.lives, 3);
    assert.strictEqual(room.state.currentTurn, a.sessionId, "seat 0 starts again");
  });

  it("auto-advances a bot seat without any client input", async () => {
    const room = (await colyseus.createRoom(WATER_FIGHT, { seed: 21 })) as unknown as WaterFightRoom;
    const host = await colyseus.connectTo(room, { nickname: "Human" });
    host.send(LobbyMsg.ADD_BOT, {});
    await until(() => room.state.players.size === 2);
    room.state.turnSeconds = 0;
    room.state.reactionSeconds = 0;
    host.send(LobbyMsg.START, {});
    await until(() => room.state.phase === Phase.PLAYING);
    // The human ends their turn; the bot seat must then act on its own.
    const beforeBot = room.engine;
    host.send(WaterFightMsg.MOVE, { kind: "END_TURN" });
    await until(() => room.engine !== beforeBot && room.engine.turnSeat === 0, 8000);
    assert.ok(room.engine.turnCount >= 1, "the bot took at least one turn unattended");
  });
});
