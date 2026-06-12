import { test } from "node:test";
import assert from "node:assert/strict";
import { GreedyPolicy } from "@splendor/engine";
import { connect, makeServer, send } from "./_harness";

function start2Humans() {
  const { server, scheduler } = makeServer();
  const a = connect(server);
  send(server, a, { type: "CREATE_ROOM", displayName: "A" });
  const code = a.last("ROOM_UPDATE")!.room.code;
  const b = connect(server);
  send(server, b, { type: "JOIN_ROOM", roomCode: code, displayName: "B" });
  send(server, a, { type: "SET_OPTIONS", options: { turnCap: 1500 } });
  send(server, a, { type: "START_GAME" });
  return { server, scheduler, code, a, b };
}

test("the server enforces turn order and rejects out-of-turn and illegal moves", () => {
  const { server, code, a, b } = start2Humans();
  const room = server.getRoom(code)!;
  // It is seat 0's turn.
  assert.equal(room.currentGame()!.awaiting.seat, 0);

  // seat 1 tries to move out of turn
  b.clear();
  send(server, b, { type: "MOVE", reqId: "b-early", move: { kind: "TAKE_THREE", colors: ["white", "blue", "green"] } });
  assert.ok(b.all("REJECTED").some((r) => r.code === "OUT_OF_TURN"));

  // seat 0 tries an unaffordable buy
  a.clear();
  send(server, a, { type: "MOVE", reqId: "a-bad", move: { kind: "BUY", from: { market: { tier: 1, index: 0 } } } });
  assert.ok(a.all("REJECTED").some((r) => r.code === "ILLEGAL_MOVE"));

  // seat 0 plays a legal take-three
  send(server, a, { type: "MOVE", reqId: "a1", move: { kind: "TAKE_THREE", colors: ["white", "blue", "green"] } });
  assert.equal(room.currentGame()!.turnCount, 1);
  assert.equal(room.currentGame()!.awaiting.seat, 1);
});

test("duplicate reqId is idempotent (no double-apply)", () => {
  const { server, code, a, b } = start2Humans();
  const room = server.getRoom(code)!;
  send(server, a, { type: "MOVE", reqId: "a1", move: { kind: "TAKE_THREE", colors: ["white", "blue", "green"] } });
  // seat 1 plays, then re-sends the SAME reqId
  send(server, b, { type: "MOVE", reqId: "dup", move: { kind: "TAKE_THREE", colors: ["white", "blue", "green"] } });
  assert.equal(room.currentGame()!.turnCount, 2);
  b.clear();
  send(server, b, { type: "MOVE", reqId: "dup", move: { kind: "TAKE_THREE", colors: ["red", "black", "white"] } });
  assert.equal(room.currentGame()!.turnCount, 2, "duplicate reqId must not advance the game again");
  assert.equal(b.all("REJECTED").length, 0, "a duplicate is re-synced, not rejected");
  assert.ok(b.last("GAME_STATE"), "duplicate triggers a state re-send");
});

test("a full game runs to completion: human (via policy) + AI, server auto-plays AI and forced passes", () => {
  const { server } = makeServer();
  const a = connect(server);
  send(server, a, { type: "CREATE_ROOM", displayName: "Human" });
  const code = a.last("ROOM_UPDATE")!.room.code;
  send(server, a, { type: "ADD_AI", difficulty: "medium" });
  send(server, a, { type: "SET_OPTIONS", options: { turnCap: 1500 } });
  send(server, a, { type: "START_GAME" });
  const room = server.getRoom(code)!;

  const pol = new GreedyPolicy(123);
  for (let i = 0; i < 8000; i++) {
    const g = room.currentGame();
    if (!g || g.over) break;
    const aw = g.awaiting;
    if (aw.seat !== 0) break; // server should auto-play the AI seat; we only act for seat 0
    if (aw.inputType === "MOVE") {
      const mv = pol.move(g);
      assert.ok(mv !== null, "if seat 0 is asked to move, a legal move exists (server auto-passes otherwise)");
      send(server, a, { type: "MOVE", reqId: `m${i}`, move: mv! });
    } else {
      const res = aw.inputType === "PICK_NOBLE" ? pol.pickNoble(g) : pol.discard(g);
      send(server, a, { type: "RESOLVE", reqId: `r${i}`, resolution: res });
    }
  }

  const g = room.currentGame()!;
  assert.equal(g.over, true, "game reached a terminal state");
  const over = a.last("GAME_OVER")!;
  assert.ok(over, "host received GAME_OVER");
  assert.equal(over.ranking.length, 2);
  assert.ok(over.winnerSeat === 0 || over.winnerSeat === 1);
  assert.equal(server.getRoom(code)!.roomView().phase, "over");
});
