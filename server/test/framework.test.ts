import assert from "node:assert";
import { boot, type ColyseusTestServer } from "@colyseus/testing";
import { LobbyMsg, Phase, ROOM_CODE_REGEX } from "@backbone/shared";
import { makeTestAppConfig, sleep, until, type StubRoom } from "./StubRoom.js";

describe("BaseGameRoom framework", () => {
  let colyseus: ColyseusTestServer<ReturnType<typeof makeTestAppConfig>>;

  before(async () => {
    colyseus = await boot(makeTestAppConfig());
  });
  after(async () => colyseus.shutdown());
  beforeEach(async () => await colyseus.cleanup());

  async function createWithHost(nickname = "Alice") {
    const room = (await colyseus.createRoom("stub", {})) as unknown as StubRoom;
    const host = await colyseus.connectTo(room, { nickname });
    return { room, host };
  }

  it("uses a 4-letter room code as roomId and mirrors it in state", async () => {
    const { room } = await createWithHost();
    assert.match(room.roomId, ROOM_CODE_REGEX);
    assert.strictEqual(room.state.roomCode, room.roomId);
  });

  it("syncs inherited schema fields to the client (schema inheritance smoke test)", async () => {
    const { room, host } = await createWithHost();
    await room.waitForNextPatch();
    const me = host.state.players.get(host.sessionId);
    assert.ok(me, "player should exist in synced state");
    assert.strictEqual(me.nickname, "Alice");
    assert.strictEqual(me.isHost, true);
    assert.strictEqual(me.seat, 0);
    // Subclass-added fields must sync too.
    assert.strictEqual((me as any).score, 0);
    assert.strictEqual((host.state as any).startCount, 0);
  });

  it("lets a second player join by code", async () => {
    const { room } = await createWithHost();
    const guest = await colyseus.sdk.joinById(room.roomId, { nickname: "Bob" });
    await room.waitForNextPatch();
    assert.strictEqual(room.state.players.size, 2);
    assert.strictEqual(room.state.players.get(guest.sessionId)?.seat, 1);
    assert.strictEqual(room.state.players.get(guest.sessionId)?.isHost, false);
  });

  it("rejects a wrong room code", async () => {
    await createWithHost();
    await assert.rejects(
      colyseus.sdk.joinById("ZZZZ", { nickname: "Bob" })
    );
  });

  it("rejects duplicate nicknames (case-insensitive)", async () => {
    const { room } = await createWithHost("Alice");
    await assert.rejects(
      colyseus.sdk.joinById(room.roomId, { nickname: "alice" }),
      /already called/
    );
  });

  it("rejects invalid nicknames", async () => {
    const { room } = await createWithHost();
    await assert.rejects(
      colyseus.sdk.joinById(room.roomId, { nickname: "   " }),
      /Nicknames must be/
    );
    await assert.rejects(
      colyseus.sdk.joinById(room.roomId, { nickname: "x".repeat(40) }),
      /Nicknames must be/
    );
  });

  it("rejects joining a full room", async () => {
    const { room } = await createWithHost();
    await colyseus.sdk.joinById(room.roomId, { nickname: "Bob" });
    await colyseus.sdk.joinById(room.roomId, { nickname: "Cara" });
    await assert.rejects(
      colyseus.sdk.joinById(room.roomId, { nickname: "Dave" })
    );
  });

  it("only the host can start, and only with enough players", async () => {
    const { room, host } = await createWithHost();

    // Not enough players yet - the start request must be ignored.
    host.send(LobbyMsg.START, {});
    await sleep(80);
    assert.strictEqual(room.state.phase, Phase.LOBBY);

    const guest = await colyseus.sdk.joinById(room.roomId, { nickname: "Bob" });

    // Non-host cannot start.
    guest.send(LobbyMsg.START, {});
    await sleep(80);
    assert.strictEqual(room.state.phase, Phase.LOBBY);

    // Host can.
    host.send(LobbyMsg.START, {});
    await until(() => room.state.phase === Phase.PLAYING);
    assert.strictEqual(room.state.startCount, 1);
  });

  it("rejects joining once the game has started (allowLateJoin=false)", async () => {
    const { room, host } = await createWithHost();
    await colyseus.sdk.joinById(room.roomId, { nickname: "Bob" });
    host.send(LobbyMsg.START, {});
    await until(() => room.state.phase === Phase.PLAYING);

    await assert.rejects(
      colyseus.sdk.joinById(room.roomId, { nickname: "Cara" })
    );
  });

  it("migrates the host when the host leaves the lobby", async () => {
    const { room, host } = await createWithHost();
    const guest = await colyseus.sdk.joinById(room.roomId, { nickname: "Bob" });

    await host.leave(true); // consented leave
    await room.waitForNextPatch();

    assert.strictEqual(room.state.players.size, 1);
    const bob = room.state.players.get(guest.sessionId);
    assert.ok(bob);
    assert.strictEqual(bob.isHost, true);
    assert.strictEqual(room.state.hostSessionId, guest.sessionId);
  });

  it("lets the host kick a player in the lobby", async () => {
    const { room, host } = await createWithHost();
    const guest = await colyseus.sdk.joinById(room.roomId, { nickname: "Bob" });

    let guestLeft = false;
    guest.onLeave(() => {
      guestLeft = true;
    });

    host.send(LobbyMsg.KICK, { sessionId: guest.sessionId });
    await room.waitForNextPatch();

    assert.strictEqual(room.state.players.size, 1);
    assert.ok(!room.state.players.has(guest.sessionId));
    // Give the close a moment to propagate to the kicked client.
    await new Promise((r) => setTimeout(r, 100));
    assert.strictEqual(guestLeft, true);
  });

  it("ignores kick attempts from non-hosts", async () => {
    const { room, host } = await createWithHost();
    const guest = await colyseus.sdk.joinById(room.roomId, { nickname: "Bob" });

    guest.send(LobbyMsg.KICK, { sessionId: host.sessionId });
    await sleep(80);
    assert.strictEqual(room.state.players.size, 2);
  });

  it("frees the room code when the room disposes", async () => {
    const { room, host } = await createWithHost();
    const code = room.roomId;
    await host.leave(true);
    // Room auto-disposes once empty; wait for it.
    await new Promise((r) => setTimeout(r, 200));
    // The code can be claimed again - smembers no longer contains it.
    const taken = await room.presence.smembers("backbone:roomcodes");
    assert.ok(!taken.includes(code));
  });
});
