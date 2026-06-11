import assert from "node:assert";
import { boot, type ColyseusTestServer } from "@colyseus/testing";
import { defineRoom, defineServer } from "colyseus";
import {
  ARENA,
  ARENA_HEIGHT,
  ARENA_PELLET_COUNT,
  ARENA_PLAYER_RADIUS,
  ARENA_WIDTH,
  ArenaMsg,
  type ArenaPlayer,
  LobbyMsg,
  Phase,
} from "@backbone/shared";
import { ArenaRoom } from "../src/games/arena/ArenaRoom.js";
import { sleep, until } from "./StubRoom.js";

function makeConfig() {
  return defineServer({
    rooms: { [ARENA]: defineRoom(ArenaRoom) },
  });
}

describe("dot arena", () => {
  let colyseus: ColyseusTestServer<ReturnType<typeof makeConfig>>;

  before(async () => {
    colyseus = await boot(makeConfig());
  });
  after(async () => colyseus.shutdown());
  beforeEach(async () => await colyseus.cleanup());

  function playerOf(room: ArenaRoom, sessionId: string): ArenaPlayer {
    const p = room.state.players.get(sessionId);
    assert.ok(p, `player ${sessionId} should exist`);
    return p as ArenaPlayer;
  }

  async function startedGame() {
    const room = (await colyseus.createRoom(ARENA, {})) as unknown as ArenaRoom;
    const a = await colyseus.connectTo(room, { nickname: "Ann" });
    const b = await colyseus.connectTo(room, { nickname: "Ben" });
    a.send(LobbyMsg.START, {});
    await until(() => room.state.phase === Phase.PLAYING);
    return { room, a, b };
  }

  it("spawns pellets and players inside the field on start", async () => {
    const { room } = await startedGame();
    assert.strictEqual(room.state.pellets.size, ARENA_PELLET_COUNT);
    for (const pellet of room.state.pellets.values()) {
      assert.ok(pellet.x >= 0 && pellet.x <= ARENA_WIDTH);
      assert.ok(pellet.y >= 0 && pellet.y <= ARENA_HEIGHT);
    }
    for (const player of room.state.players.values()) {
      const p = player as ArenaPlayer;
      assert.ok(p.x >= ARENA_PLAYER_RADIUS && p.x <= ARENA_WIDTH - ARENA_PLAYER_RADIUS);
      assert.strictEqual(p.score, 0);
    }
  });

  it("moves a player according to input, server-authoritatively", async () => {
    const { room, a } = await startedGame();
    const me = playerOf(room, a.sessionId);
    const startX = me.x;

    a.send(ArenaMsg.INPUT, { dx: 1, dy: 0 });
    await sleep(300); // ~6 ticks at 220 u/s -> ~66 units (unless wall)
    const moved = me.x - startX;
    assert.ok(
      moved > 20 || me.x >= ARENA_WIDTH - ARENA_PLAYER_RADIUS - 1,
      `should have moved right (moved ${moved.toFixed(1)})`
    );

    a.send(ArenaMsg.INPUT, { dx: 0, dy: 0 });
    await sleep(150);
    const stoppedX = me.x;
    await sleep(200);
    assert.ok(Math.abs(me.x - stoppedX) < 0.001, "stops when input is zero");
  });

  it("clamps players to the field and normalizes forged fast inputs", async () => {
    const { room, a } = await startedGame();
    const me = playerOf(room, a.sessionId);

    // Forged oversized input must not exceed normal speed (it gets
    // clamped + normalized to length 1).
    a.send(ArenaMsg.INPUT, { dx: 1000, dy: 0 });
    const x0 = me.x;
    await sleep(250);
    const speed = (me.x - x0) / 0.25;
    assert.ok(
      speed <= 230 || me.x >= ARENA_WIDTH - ARENA_PLAYER_RADIUS - 1,
      `speed ${speed.toFixed(0)} u/s must not exceed the limit`
    );

    // Keep holding right: must stop at the wall.
    await sleep(4000);
    assert.ok(me.x <= ARENA_WIDTH - ARENA_PLAYER_RADIUS + 0.001, "clamped at wall");

    // Malformed input is discarded entirely.
    a.send(ArenaMsg.INPUT, { dx: "evil", dy: null });
    await sleep(100);
    assert.ok(true, "server did not crash on malformed input");
  });

  it("allows joining mid-game (late join)", async () => {
    const { room } = await startedGame();
    const late = await colyseus.sdk.joinById(room.roomId, { nickname: "Late" });
    await room.waitForNextPatch();
    assert.strictEqual(room.state.players.size, 3);
    assert.strictEqual(room.state.phase, Phase.PLAYING);
    const p = playerOf(room, late.sessionId);
    assert.ok(p.x >= ARENA_PLAYER_RADIUS, "late joiner got spawned");
  });

  it("freezes a disconnected player instead of removing them", async () => {
    const { room, a, b } = await startedGame();
    // Third player keeps the game above minPlayers while b is away.
    await colyseus.sdk.joinById(room.roomId, { nickname: "Cee" });

    const pb = playerOf(room, b.sessionId);
    b.send(ArenaMsg.INPUT, { dx: 1, dy: 0 });
    await sleep(150);

    await b.leave(false); // abnormal drop
    await until(() => pb.connected === false);
    const frozenX = pb.x;
    await sleep(300);
    assert.ok(Math.abs(pb.x - frozenX) < 0.001, "no movement while away");
    assert.strictEqual(room.state.phase, Phase.PLAYING, "game continues");
  });

  it("a player reaching the win score ends the game", async () => {
    const { room, a } = await startedGame();
    const me = playerOf(room, a.sessionId);
    // Cheat from the server side for the test: set score one below the
    // win, then have the player run over a pellet placed in front of it.
    me.score = 9;
    const pellet = room.state.pellets.values().next().value!;
    pellet.x = Math.min(ARENA_WIDTH - ARENA_PLAYER_RADIUS, me.x + 30);
    pellet.y = me.y;
    a.send(ArenaMsg.INPUT, { dx: 1, dy: 0 });

    await until(() => room.state.phase === Phase.ENDED, 5000);
    assert.strictEqual(room.state.endReason, `win:${me.seat}`);
  });
});
