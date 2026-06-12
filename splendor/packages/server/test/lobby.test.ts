import { test } from "node:test";
import assert from "node:assert/strict";
import { connect, makeServer, send, tokenOf } from "./_harness";

test("create room: host gets a SESSION (seat 0) and a lobby ROOM_UPDATE", () => {
  const { server } = makeServer();
  const host = connect(server);
  send(server, host, { type: "CREATE_ROOM", displayName: "Keaton" });
  const session = host.last("SESSION")!;
  assert.equal(session.seat, 0);
  const ru = host.last("ROOM_UPDATE")!;
  assert.equal(ru.room.phase, "lobby");
  assert.equal(ru.room.seats.length, 1);
  assert.equal(ru.room.hostSeat, 0);
  assert.equal(ru.room.seats[0].name, "Keaton");
});

test("a second player joins their own connection and both see 2 seats", () => {
  const { server } = makeServer();
  const host = connect(server);
  send(server, host, { type: "CREATE_ROOM", displayName: "A" });
  const code = host.last("ROOM_UPDATE")!.room.code;
  const p2 = connect(server);
  send(server, p2, { type: "JOIN_ROOM", roomCode: code, displayName: "B" });
  assert.equal(p2.last("SESSION")!.seat, 1);
  assert.equal(host.last("ROOM_UPDATE")!.room.seats.length, 2);
  assert.equal(p2.last("ROOM_UPDATE")!.room.seats[1].name, "B");
});

test("non-host cannot change options or start", () => {
  const { server } = makeServer();
  const host = connect(server);
  send(server, host, { type: "CREATE_ROOM", displayName: "A" });
  const code = host.last("ROOM_UPDATE")!.room.code;
  const p2 = connect(server);
  send(server, p2, { type: "JOIN_ROOM", roomCode: code, displayName: "B" });
  p2.clear();
  send(server, p2, { type: "SET_OPTIONS", options: { endGameMode: "immediate" } });
  send(server, p2, { type: "START_GAME" });
  const rejects = p2.all("REJECTED");
  assert.ok(rejects.some((r) => r.code === "NOT_HOST"));
});

test("host adds an AI seat and sets options", () => {
  const { server } = makeServer();
  const host = connect(server);
  send(server, host, { type: "CREATE_ROOM", displayName: "A" });
  send(server, host, { type: "ADD_AI", difficulty: "medium" });
  send(server, host, { type: "SET_OPTIONS", options: { endGameMode: "immediate" } });
  const ru = host.last("ROOM_UPDATE")!;
  assert.equal(ru.room.seats.length, 2);
  assert.equal(ru.room.seats[1].kind, "ai");
  assert.equal(ru.room.options.endGameMode, "immediate");
});

test("start deals a redacted GAME_STATE to each human: own reserved visible, opponents' hidden, no seed/decks", () => {
  const { server } = makeServer();
  const host = connect(server);
  send(server, host, { type: "CREATE_ROOM", displayName: "A" });
  const code = host.last("ROOM_UPDATE")!.room.code;
  const p2 = connect(server);
  send(server, p2, { type: "JOIN_ROOM", roomCode: code, displayName: "B" });
  send(server, host, { type: "START_GAME" });

  const gs = host.last("GAME_STATE")!;
  assert.equal(gs.you, 0);
  assert.ok(gs.view.players[0].reserved, "seat 0 sees its own reserved array");
  assert.equal(gs.view.players[1].reserved, undefined, "seat 0 cannot see seat 1's reserved identities");
  const json = JSON.stringify(gs.view);
  assert.equal(json.includes('"decks"'), false);
  assert.equal(json.includes('"seed"'), false);

  // Both players were dealt a state, and someone is on the clock.
  assert.ok(p2.last("GAME_STATE"));
  assert.ok(host.last("AWAITING_INPUT"));
});

test("joining mid-game makes a spectator with no hidden info", () => {
  const { server } = makeServer();
  const host = connect(server);
  send(server, host, { type: "CREATE_ROOM", displayName: "A" });
  const code = host.last("ROOM_UPDATE")!.room.code;
  send(server, host, { type: "ADD_AI" });
  send(server, host, { type: "START_GAME" });

  const watcher = connect(server);
  send(server, watcher, { type: "JOIN_ROOM", roomCode: code, displayName: "watcher" });
  assert.equal(watcher.last("SESSION")!.seat, "spectator");
  const gs = watcher.last("GAME_STATE")!;
  assert.equal(gs.you, "spectator");
  assert.ok(gs.view.players.every((p) => p.reserved === undefined), "spectator sees no reserved identities");
});
