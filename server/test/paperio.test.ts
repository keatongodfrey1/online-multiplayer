import assert from "node:assert";
import { boot, type ColyseusTestServer } from "@colyseus/testing";
import { defineRoom, defineServer } from "colyseus";
import { BOARD_SIZES, LobbyMsg, PAPERIO, PaperIoMsg, type PaperIoPlayer, Phase } from "@backbone/shared";
import { PaperIoRoom } from "../src/games/paperio/PaperIoRoom.js";
import { sleep, until } from "./StubRoom.js";

function makeConfig() {
  return defineServer({
    rooms: { [PAPERIO]: defineRoom(PaperIoRoom) },
  });
}

describe("paper.io room", () => {
  let colyseus: ColyseusTestServer<ReturnType<typeof makeConfig>>;

  before(async () => {
    colyseus = await boot(makeConfig());
  });
  after(async () => colyseus.shutdown());
  beforeEach(async () => await colyseus.cleanup());

  function playerOf(room: PaperIoRoom, sessionId: string): PaperIoPlayer {
    const p = room.state.players.get(sessionId);
    assert.ok(p, `player ${sessionId} should exist`);
    return p as PaperIoPlayer;
  }

  /** Two humans; host applies config (default no bots for determinism), then starts. */
  async function startedGame(config: Record<string, unknown> = {}) {
    const room = (await colyseus.createRoom(PAPERIO, { seed: 7 })) as unknown as PaperIoRoom;
    const a = await colyseus.connectTo(room, { nickname: "Ann" });
    const b = await colyseus.connectTo(room, { nickname: "Ben" });
    a.send(PaperIoMsg.CONFIG, { botCount: 0, ...config });
    await room.waitForNextPatch();
    a.send(LobbyMsg.START, {});
    await until(() => room.state.phase === Phase.PLAYING);
    return { room, a, b };
  }

  it("starts a round: grid sized to the board, humans placed on home territory", async () => {
    const { room } = await startedGame({ boardSize: "small", lives: 4 });
    const board = BOARD_SIZES.small;
    assert.strictEqual(room.state.cols, board.cols);
    assert.strictEqual(room.state.grid.length, board.cols * board.rows);
    for (const player of room.state.players.values()) {
      const p = player as PaperIoPlayer;
      assert.ok(p.alive, "alive at start");
      assert.strictEqual(p.lives, 4, "human lives set from the lobby");
      assert.ok(p.cellsOwned > 0 && p.cellsOwned <= 25, "owns a home block");
    }
  });

  it("steers a player server-authoritatively and ignores malformed input", async () => {
    const { room, a } = await startedGame();
    const me = playerOf(room, a.sessionId);
    const startX = me.x;
    a.send(PaperIoMsg.STEER, { heading: 0 }); // head +x
    await sleep(350);
    assert.ok(me.x - startX > 1, `should have moved right (moved ${(me.x - startX).toFixed(2)})`);

    a.send(PaperIoMsg.STEER, { heading: "evil" });
    a.send(PaperIoMsg.STEER, {});
    await sleep(100);
    assert.strictEqual(room.state.phase, Phase.PLAYING, "still running after bad input");
  });

  it("spawns the configured bots into the simulation (no lobby roster entries)", async () => {
    const { room } = await startedGame({ botCount: 4, botDifficulty: "hard" });
    assert.strictEqual(room.state.players.size, 2, "bots are NOT roster players");
    assert.strictEqual(room.state.bots.size, 4, "four bots in the sim");
    assert.strictEqual(room.world?.bots.length, 4);
    for (const bot of room.state.bots.values()) assert.ok(bot.id >= 9, "bot ids sit above the human range");
    await sleep(400); // they move + claim without crashing
    assert.strictEqual(room.state.phase, Phase.PLAYING);
  });

  it("lets a single human start a solo game against bots", async () => {
    const room = (await colyseus.createRoom(PAPERIO, { seed: 7 })) as unknown as PaperIoRoom;
    const a = await colyseus.connectTo(room, { nickname: "Solo" });
    a.send(PaperIoMsg.CONFIG, { botCount: 3 });
    await room.waitForNextPatch();
    a.send(LobbyMsg.START, {});
    await until(() => room.state.phase === Phase.PLAYING);
    assert.strictEqual(room.state.players.size, 1, "solo human");
    assert.strictEqual(room.state.bots.size, 3, "bots fill the board");
  });

  it("a human reaching the target share ends the game with the right winner", async () => {
    const { room, a } = await startedGame({ winMode: "target", targetPercent: 60 });
    const me = playerOf(room, a.sessionId);
    const w = room.world!;
    // White-box cheat: hand the player the whole board, then trigger the check.
    w.fillRect(me.seat + 1, 0, 0, w.cols - 1, w.rows - 1);
    w.checkEnd(w.actorBySeat(me.seat)!);
    await until(() => room.state.phase === Phase.ENDED, 3000);
    assert.strictEqual(room.state.endReason, `win:${me.seat}`);
    assert.strictEqual(room.state.outcome, "target");
  });

  it("rematch fully resets the game", async () => {
    const { room, a, b } = await startedGame({ lives: 2, botCount: 2 });
    const me = playerOf(room, a.sessionId);
    const w = room.world!;
    w.fillRect(me.seat + 1, 0, 0, w.cols - 1, w.rows - 1);
    w.checkEnd(w.actorBySeat(me.seat)!);
    await until(() => room.state.phase === Phase.ENDED, 3000);

    a.send(LobbyMsg.REMATCH, {});
    b.send(LobbyMsg.REMATCH, {});
    await until(() => room.state.phase === Phase.PLAYING, 3000);
    assert.strictEqual(room.state.bots.size, 2, "bots re-seeded on rematch");
    for (const player of room.state.players.values()) {
      const p = player as PaperIoPlayer;
      assert.ok(p.alive && !p.eliminated, "everyone alive again");
      assert.strictEqual(p.lives, 2, "lives reset");
      assert.ok(p.cellsOwned > 0 && p.cellsOwned <= 25, "back to a home block");
      assert.strictEqual(p.trail.length, 0, "trail cleared on rematch");
    }
  });

  it("freezes a disconnected player; the game keeps running", async () => {
    const { room, a, b } = await startedGame();
    const pb = playerOf(room, b.sessionId);
    b.send(PaperIoMsg.STEER, { heading: 0 });
    await sleep(200);
    await b.leave(false); // abnormal drop -> seat held during grace
    await until(() => pb.connected === false);
    const frozenX = pb.x;
    await sleep(300);
    assert.ok(Math.abs(pb.x - frozenX) < 0.001, "no movement while away");
    assert.strictEqual(room.state.phase, Phase.PLAYING, "game continues");
    void a;
  });

  it("ends the round when the last human leaves (wipeout)", async () => {
    const room = (await colyseus.createRoom(PAPERIO, { seed: 7 })) as unknown as PaperIoRoom;
    const a = await colyseus.connectTo(room, { nickname: "Ann" });
    a.send(PaperIoMsg.CONFIG, { botCount: 2 });
    await room.waitForNextPatch();
    a.send(LobbyMsg.START, {});
    await until(() => room.state.phase === Phase.PLAYING);

    await a.leave(true); // consented quit -> removed for good
    await until(() => room.state.phase === Phase.ENDED, 3000);
    assert.strictEqual(room.state.outcome, "wipeout", "no humans left = wipeout");
  });
});
