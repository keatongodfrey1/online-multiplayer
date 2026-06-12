import assert from "node:assert";
import { boot, type ColyseusTestServer } from "@colyseus/testing";
import { defineRoom, defineServer } from "colyseus";
import {
  EndReason,
  LobbyMsg,
  Phase,
  TICTACTOE,
  TicTacToeMsg,
} from "@backbone/shared";
import { TicTacToeRoom } from "../src/games/tictactoe/TicTacToeRoom.js";
import { sleep, until } from "./StubRoom.js";

function makeConfig() {
  return defineServer({
    rooms: { [TICTACTOE]: defineRoom(TicTacToeRoom) },
  });
}

describe("tic-tac-toe", () => {
  let colyseus: ColyseusTestServer<ReturnType<typeof makeConfig>>;

  before(async () => {
    colyseus = await boot(makeConfig());
  });
  after(async () => colyseus.shutdown());
  beforeEach(async () => await colyseus.cleanup());

  async function startedGame() {
    const room = (await colyseus.createRoom(TICTACTOE, {})) as unknown as TicTacToeRoom;
    const x = await colyseus.connectTo(room, { nickname: "Xena" }); // seat 0 = X
    const o = await colyseus.connectTo(room, { nickname: "Omar" }); // seat 1 = O
    x.send(LobbyMsg.START, {});
    await until(() => room.state.phase === Phase.PLAYING);
    return { room, x, o };
  }

  it("plays a full game to a win", async () => {
    const { room, x, o } = await startedGame();
    assert.strictEqual(room.state.currentTurn, x.sessionId, "seat 0 goes first");

    // X: 0, O: 3, X: 1, O: 4, X: 2 -> X wins the top row.
    const script: Array<[typeof x, number]> = [
      [x, 0],
      [o, 3],
      [x, 1],
      [o, 4],
      [x, 2],
    ];
    for (const [player, cell] of script) {
      player.send(TicTacToeMsg.MOVE, { cell });
      await until(() => room.state.board[cell] !== 0);
    }

    await until(() => room.state.phase === Phase.ENDED);
    assert.strictEqual(room.state.endReason, `${EndReason.WIN_PREFIX}0`);
  });

  it("detects a draw", async () => {
    const { room, x, o } = await startedGame();
    // X O X / X O O / O X X is a known draw line-up; play in turn order:
    // X:0 O:1 X:2 O:4 X:3 O:5 X:7 O:6 X:8
    const script: Array<[typeof x, number]> = [
      [x, 0],
      [o, 1],
      [x, 2],
      [o, 4],
      [x, 3],
      [o, 5],
      [x, 7],
      [o, 6],
      [x, 8],
    ];
    for (const [player, cell] of script) {
      player.send(TicTacToeMsg.MOVE, { cell });
      await until(() => room.state.board[cell] !== 0);
    }
    await until(() => room.state.phase === Phase.ENDED);
    assert.strictEqual(room.state.endReason, EndReason.DRAW);
  });

  it("ignores out-of-turn and invalid moves", async () => {
    const { room, x, o } = await startedGame();

    o.send(TicTacToeMsg.MOVE, { cell: 0 }); // not O's turn
    x.send(TicTacToeMsg.MOVE, { cell: 99 }); // out of range
    x.send(TicTacToeMsg.MOVE, { cell: -1 }); // out of range
    x.send(TicTacToeMsg.MOVE, { cell: 1.5 }); // not an integer
    x.send(TicTacToeMsg.MOVE, {} as never); // malformed
    await sleep(100);
    assert.ok([...room.state.board].every((v) => v === 0), "board untouched");
    assert.strictEqual(room.state.currentTurn, x.sessionId);

    x.send(TicTacToeMsg.MOVE, { cell: 4 });
    await until(() => room.state.board[4] === 1);

    o.send(TicTacToeMsg.MOVE, { cell: 4 }); // occupied
    await sleep(100);
    assert.strictEqual(room.state.board[4], 1);
    assert.strictEqual(room.state.currentTurn, o.sessionId, "O still to move");
  });

  it("resets the board on rematch once both players agree", async () => {
    const { room, x, o } = await startedGame();
    const moves: Array<[typeof x, number]> = [
      [x, 0],
      [o, 3],
      [x, 1],
      [o, 4],
      [x, 2],
    ];
    for (const [player, cell] of moves) {
      player.send(TicTacToeMsg.MOVE, { cell });
      await until(() => room.state.board[cell] !== 0);
    }
    await until(() => room.state.phase === Phase.ENDED);

    x.send(LobbyMsg.REMATCH, {});
    await sleep(80);
    assert.strictEqual(room.state.phase, Phase.ENDED, "one vote is not enough");

    o.send(LobbyMsg.REMATCH, {});
    await until(() => room.state.phase === Phase.PLAYING);
    assert.ok([...room.state.board].every((v) => v === 0), "fresh board");
    assert.strictEqual(room.state.currentTurn, x.sessionId, "seat 0 starts again");
    for (const p of room.state.players.values()) {
      assert.strictEqual(p.wantsRematch, false, "votes cleared");
    }
  });

  it("passes the turn to the remaining player flow when someone quits mid-game", async () => {
    const { room, o } = await startedGame();
    await o.leave(true); // consented quit
    await until(() => room.state.phase === Phase.ENDED);
    assert.strictEqual(room.state.endReason, EndReason.ABANDONED);
    assert.strictEqual(room.state.currentTurn, "", "turn cleared after game end");
  });

  it("ignores add-bot requests (bots not supported here)", async () => {
    const room = (await colyseus.createRoom(TICTACTOE, {})) as unknown as TicTacToeRoom;
    const host = await colyseus.connectTo(room, { nickname: "Xena" });
    host.send(LobbyMsg.ADD_BOT, {});
    await sleep(100);
    assert.strictEqual(room.state.players.size, 1, "no bot was seated");
  });
});
