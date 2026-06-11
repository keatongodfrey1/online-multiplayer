import assert from "node:assert";
import { boot, type ColyseusTestServer } from "@colyseus/testing";
import { LobbyMsg, Phase } from "@backbone/shared";
import { makeTestAppConfig, sleep, until, type StubRoom } from "./StubRoom.js";

describe("reconnection", () => {
  let colyseus: ColyseusTestServer<ReturnType<typeof makeTestAppConfig>>;

  before(async () => {
    colyseus = await boot(makeTestAppConfig());
  });
  after(async () => colyseus.shutdown());
  beforeEach(async () => await colyseus.cleanup());

  async function startedGame() {
    const room = (await colyseus.createRoom("stub", {})) as unknown as StubRoom;
    const host = await colyseus.connectTo(room, { nickname: "Alice" });
    const guest = await colyseus.connectTo(room, { nickname: "Bob" });
    host.send(LobbyMsg.START, {});
    await until(() => room.state.phase === Phase.PLAYING);
    return { room, host, guest };
  }

  it("marks a dropped player disconnected and restores the seat on reconnect", async () => {
    const { room, guest } = await startedGame();
    const token = guest.reconnectionToken;
    const guestSessionId = guest.sessionId;
    const guestSeat = room.state.players.get(guestSessionId)?.seat;

    await guest.leave(false); // abnormal/non-consented leave
    await room.waitForNextPatch();
    assert.strictEqual(
      room.state.players.get(guestSessionId)?.connected,
      false,
      "player should be marked disconnected during the grace period"
    );
    assert.strictEqual(room.state.players.size, 2, "seat must be held");

    const rejoined = await colyseus.sdk.reconnect(token);
    await room.waitForNextPatch();
    assert.strictEqual(rejoined.sessionId, guestSessionId, "same session");
    const player = room.state.players.get(guestSessionId);
    assert.strictEqual(player?.connected, true);
    assert.strictEqual(player?.seat, guestSeat, "same seat after reconnect");
    assert.strictEqual(room.state.phase, Phase.PLAYING, "game still running");
  });

  it("removes the player for good when the grace period expires", async () => {
    const { room, guest } = await startedGame();
    const guestSessionId = guest.sessionId;

    await guest.leave(false);
    await room.waitForNextPatch();
    assert.strictEqual(room.state.players.get(guestSessionId)?.connected, false);

    // StubRoom grace is 1 second; wait past it.
    await new Promise((r) => setTimeout(r, 1600));

    assert.ok(!room.state.players.has(guestSessionId), "seat freed after grace");
    // 2-player minimum no longer met -> game ends as abandoned.
    assert.strictEqual(room.state.phase, Phase.ENDED);
    assert.strictEqual(room.state.endReason, "abandoned");
  });

  it("rejects reconnection after the grace period expired", async () => {
    const { room, guest } = await startedGame();
    const token = guest.reconnectionToken;

    await guest.leave(false);
    await new Promise((r) => setTimeout(r, 1600));

    await assert.rejects(colyseus.sdk.reconnect(token));
    assert.strictEqual(room.state.phase, Phase.ENDED);
  });

  it("kicking a disconnected player cancels their pending reconnection", async () => {
    const room = (await colyseus.createRoom("stub", {})) as unknown as StubRoom;
    const host = await colyseus.connectTo(room, { nickname: "Alice" });
    const guest = await colyseus.connectTo(room, { nickname: "Bob" });
    const token = guest.reconnectionToken;
    const guestSessionId = guest.sessionId;

    await guest.leave(false); // drops into lobby grace period
    await room.waitForNextPatch();
    assert.strictEqual(room.state.players.get(guestSessionId)?.connected, false);

    host.send(LobbyMsg.KICK, { sessionId: guestSessionId });
    await until(() => !room.state.players.has(guestSessionId));
    await assert.rejects(colyseus.sdk.reconnect(token));
  });

  it("a consented leave does not hold the seat", async () => {
    const { room, guest } = await startedGame();
    const guestSessionId = guest.sessionId;

    await guest.leave(true);
    await room.waitForNextPatch();

    assert.ok(!room.state.players.has(guestSessionId));
    assert.strictEqual(room.state.phase, Phase.ENDED, "abandoned below minPlayers");
  });
});
