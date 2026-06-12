import { test } from "node:test";
import assert from "node:assert/strict";
import { connect, makeServer, send, tokenOf } from "./_harness";

test("host disconnect migrates host to the next connected human", () => {
  const { server, code, a, b } = (() => {
    const { server } = makeServer();
    const a = connect(server);
    send(server, a, { type: "CREATE_ROOM", displayName: "A" });
    const code = a.last("ROOM_UPDATE")!.room.code;
    const b = connect(server);
    send(server, b, { type: "JOIN_ROOM", roomCode: code, displayName: "B" });
    return { server, code, a, b };
  })();

  const room = server.getRoom(code)!;
  assert.equal(room.roomView().hostSeat, 0);
  b.clear();
  server.onDisconnect(a.id);

  assert.equal(room.roomView().hostSeat, 1, "host migrated to seat 1");
  assert.equal(room.roomView().seats[0].connected, false);
  assert.equal(room.roomView().seats[1].connected, true);
  assert.ok(b.all("PLAYER_CONNECTION").some((m) => m.seat === 0 && m.connected === false));
  assert.equal(b.last("ROOM_UPDATE")!.room.hostSeat, 1);
});

test("a disconnected player can reconnect with their session token", () => {
  const { server } = makeServer();
  const a = connect(server);
  send(server, a, { type: "CREATE_ROOM", displayName: "A" });
  const code = a.last("ROOM_UPDATE")!.room.code;
  const b = connect(server);
  send(server, b, { type: "JOIN_ROOM", roomCode: code, displayName: "B" });
  const tokenA = tokenOf(a);

  server.onDisconnect(a.id);
  const room = server.getRoom(code)!;
  assert.equal(room.roomView().hostSeat, 1); // migrated away while A was gone

  const c = connect(server);
  send(server, c, { type: "RECONNECT", sessionToken: tokenA });
  assert.equal(c.last("SESSION")!.seat, 0, "reclaimed seat 0");
  assert.equal(room.roomView().seats[0].connected, true);
  assert.equal(room.roomView().hostSeat, 1, "reconnect does not steal host back");
});

test("reconnecting with an unknown token is rejected", () => {
  const { server } = makeServer();
  const c = connect(server);
  send(server, c, { type: "RECONNECT", sessionToken: "deadbeef" });
  assert.ok(c.all("ERROR").some((e) => e.code === "UNKNOWN_SESSION"));
});

test("a disconnected human is taken over by AI on timeout, and the game still completes", () => {
  const { server, scheduler } = makeServer({ turnTimeoutMs: 1000 });
  const a = connect(server);
  send(server, a, { type: "CREATE_ROOM", displayName: "Human" });
  const code = a.last("ROOM_UPDATE")!.room.code;
  send(server, a, { type: "ADD_AI", difficulty: "medium" });
  send(server, a, { type: "SET_OPTIONS", options: { turnCap: 1500 } });
  send(server, a, { type: "START_GAME" });
  const room = server.getRoom(code)!;

  assert.equal(room.currentGame()!.awaiting.seat, 0);
  const before = room.currentGame()!.turnCount;

  // The human drops on their own turn; no real timer fires until we advance.
  server.onDisconnect(a.id);
  scheduler.advance(1001);
  assert.ok(room.currentGame()!.turnCount > before, "AI took over the disconnected seat and advanced play");

  // Keep firing the recurring takeover timer until the game ends.
  for (let i = 0; i < 8000 && !room.currentGame()!.over; i++) scheduler.advance(1001);
  assert.equal(room.currentGame()!.over, true, "game completed under full AI takeover");
});
