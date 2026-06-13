/**
 * Space Chase room integration tests (the thin adapter over the pure engine).
 * The full ruleset is covered by spacechaseEngine.test.ts; this suite covers
 * the room's job: turn ownership, schema mirroring, the private Satellite peek,
 * save/resume, the turn clock (auto-action + freeze on disconnect), reconnection
 * restoring an open prompt, and a leaver being removed.
 *
 * Scripting: the engine is the truth and is public, so tests plant the next
 * draw with `room.engine.deck.push(id)` and dice with `room.engine.forcedRolls`,
 * and set up positions by writing `room.engine.players[i].position` between turns.
 */
import assert from "node:assert/strict";
import { boot, type ColyseusTestServer } from "@colyseus/testing";
import { defineRoom, defineServer } from "colyseus";
import {
  EndReason,
  LobbyMsg,
  Phase,
  ScAwait,
  ServerMsg,
  SPACE_CHASE,
  SpaceChaseMsg,
} from "@backbone/shared";
import { SpaceChaseRoom } from "../src/games/spacechase/SpaceChaseRoom.js";
import { sleep, until } from "./StubRoom.js";

const BLASTER = 17;
const SATELLITE = 40;

function makeConfig() {
  return defineServer({ rooms: { [SPACE_CHASE]: defineRoom(SpaceChaseRoom) } });
}

describe("space chase room", () => {
  let colyseus: ColyseusTestServer<ReturnType<typeof makeConfig>>;

  before(async () => {
    colyseus = await boot(makeConfig());
  });
  after(async () => colyseus.shutdown());
  beforeEach(async () => await colyseus.cleanup());

  const NAMES = ["Ada", "Ben", "Cleo", "Dan", "Eve"];

  async function startedGame(seed = 42, playerCount = 2) {
    const room = (await colyseus.createRoom(SPACE_CHASE, { seed })) as unknown as SpaceChaseRoom;
    const clients = [];
    for (let i = 0; i < playerCount; i++) {
      clients.push(await colyseus.connectTo(room, { nickname: NAMES[i] }));
    }
    clients[0]!.send(LobbyMsg.START, {});
    await until(() => room.state.phase === Phase.PLAYING);
    return { room, clients, a: clients[0]!, b: clients[1]! };
  }

  /** Whoever the engine says is up. */
  const actor = (room: SpaceChaseRoom, clients: any[]) =>
    clients.find((c) => c.sessionId === room.state.currentTurn)!;

  it("plays to a win and mirrors the engine into the schema", async () => {
    const { room, a, b } = await startedGame();
    assert.equal(room.state.currentTurn, a.sessionId, "seat 0 goes first");
    assert.equal(room.state.awaitingType, ScAwait.ACTION);

    // A normal roll moves Ada and passes the turn; the schema mirrors it.
    // (Space 5 is not a portal mouth, so she just lands there.)
    room.engine.forcedRolls.push(5);
    a.send(SpaceChaseMsg.ROLL, {});
    await until(() => room.state.seats[0]!.position === 5);
    assert.equal(room.engine.players[0]!.position, 5, "engine moved");
    await until(() => room.state.currentTurn === b.sessionId);

    room.engine.forcedRolls.push(3);
    b.send(SpaceChaseMsg.ROLL, {}); // Ben rolls, back to Ada
    await until(() => room.state.currentTurn === a.sessionId);

    // Set Ada near the Finish; her next roll wins.
    room.engine.players[0]!.position = 64;
    room.engine.forcedRolls.push(4);
    a.send(SpaceChaseMsg.ROLL, {});
    await until(() => room.state.phase === Phase.ENDED);

    assert.equal(room.state.endReason, `${EndReason.WIN_PREFIX}0`);
    assert.equal(room.state.currentTurn, "");
    assert.equal(room.state.awaitingType, "");
  });

  it("ignores out-of-turn / wrong-phase / malformed input", async () => {
    const room = (await colyseus.createRoom(SPACE_CHASE, { seed: 1 })) as unknown as SpaceChaseRoom;
    const a = await colyseus.connectTo(room, { nickname: "Ada" });
    const b = await colyseus.connectTo(room, { nickname: "Ben" });

    // CONFIG: host-only, 15s steps, lobby-only.
    b.send(SpaceChaseMsg.CONFIG, { turnSeconds: 60 }); // not host
    a.send(SpaceChaseMsg.CONFIG, { turnSeconds: 7 }); // not a step
    await sleep(60);
    assert.equal(room.state.turnSeconds, 0);
    a.send(SpaceChaseMsg.CONFIG, { turnSeconds: 30 });
    await until(() => room.state.turnSeconds === 30);

    a.send(LobbyMsg.START, {});
    await until(() => room.state.phase === Phase.PLAYING);
    a.send(SpaceChaseMsg.CONFIG, { turnSeconds: 0 }); // lobby-only now
    b.send(SpaceChaseMsg.ROLL, {}); // not Ben's turn
    b.send(SpaceChaseMsg.DRAW, {});
    a.send(SpaceChaseMsg.TARGET, { seat: 1 }); // no prompt open
    await sleep(80);
    assert.equal(room.state.turnSeconds, 30);
    assert.equal(room.state.seats[0]!.position, 0);
    assert.equal(room.state.seats[1]!.position, 0);
    assert.equal(room.state.currentTurn, a.sessionId);

    // A prompt that's open: a malformed / illegal answer is ignored.
    room.engine.players[1]!.position = 10;
    room.engine.deck.push(BLASTER);
    a.send(SpaceChaseMsg.DRAW, {});
    await until(() => room.state.awaitingType === ScAwait.TARGET);
    b.send(SpaceChaseMsg.TARGET, { seat: 0 }); // not the prompt owner
    a.send(SpaceChaseMsg.TARGET, { seat: 99 }); // out of range
    a.send(SpaceChaseMsg.SPACE, { space: 5 }); // wrong resolution kind
    await sleep(80);
    assert.equal(room.state.awaitingType, ScAwait.TARGET, "still waiting for a valid target");
    a.send(SpaceChaseMsg.TARGET, { seat: 1 }); // valid -> Ben back 3
    await until(() => room.state.seats[1]!.position === 7);
  });

  it("rematch fully resets the game", async () => {
    const { room, a, b } = await startedGame(9);
    room.engine.players[0]!.position = 67;
    room.engine.forcedRolls.push(1);
    a.send(SpaceChaseMsg.ROLL, {});
    await until(() => room.state.phase === Phase.ENDED);

    a.send(LobbyMsg.REMATCH, {});
    b.send(LobbyMsg.REMATCH, {});
    await until(() => room.state.phase === Phase.PLAYING);
    assert.equal(room.state.seats[0]!.position, 0);
    assert.equal(room.state.seats[1]!.position, 0);
    assert.equal(room.state.roundNumber, 0);
    assert.equal(room.state.deckCount, 42);
    assert.equal(room.state.discardCount, 0);
    assert.equal(room.state.currentTurn, a.sessionId);
    assert.equal(room.state.awaitingType, ScAwait.ACTION);
  });

  it("keeps the Satellite peek private to the drawer, across a refresh", async () => {
    const { room, a, b } = await startedGame(11);
    const aState = () => a.state as any;
    const bState = () => b.state as any;
    await until(() => aState()?.phase === Phase.PLAYING && bState()?.phase === Phase.PLAYING);

    room.engine.deck.push(1, 2, 3, 4); // ensure a full 5-card peek
    room.engine.deck.push(SATELLITE);
    a.send(SpaceChaseMsg.DRAW, {});
    await until(() => room.state.awaitingType === ScAwait.SATELLITE);

    // The owner sees the 5 peeked cards; the opponent sees none.
    await until(() => (aState().seats?.at(0)?.peek?.length ?? 0) === 5);
    assert.ok(aState().seats.at(0).peek.at(0) >= 1, "owner sees the peeked ids");
    await sleep(80);
    assert.equal(bState().seats?.at(0)?.peek?.length ?? 0, 0, "opponent is blind to the peek");

    // A refresh (drop + resume) keeps the private peek for the owner only.
    const token = a.reconnectionToken;
    const aId = a.sessionId;
    await a.leave(false);
    await until(() => room.state.players.get(aId)?.connected === false);
    const a2 = await colyseus.sdk.reconnect(token);
    const a2State = () => a2.state as any;
    await until(() => (a2State()?.seats?.at(0)?.peek?.length ?? 0) === 5, 5000);
    assert.ok(a2State().seats.at(0).peek.at(0) >= 1, "owner still sees it after refresh");
    assert.equal(bState().seats?.at(0)?.peek?.length ?? 0, 0, "opponent still blind");
  });

  it("saves a game and resumes it in a fresh room", async function () {
    this.timeout(10000);
    const { room, a, b } = await startedGame(23);
    // Make some progress so the resume is observable.
    room.engine.players[0]!.position = 30;
    room.engine.players[1]!.position = 12;
    room.engine.forcedRolls.push(3);
    a.send(SpaceChaseMsg.ROLL, {});
    await until(() => room.state.seats[0]!.position === 33);

    let blob: any;
    a.onMessage(ServerMsg.SAVE_DATA, (b2: any) => (blob = b2));
    a.send(LobbyMsg.SAVE, {});
    await until(() => blob !== undefined);
    assert.equal(blob.game, "spacechase");

    // Resume in a brand-new room with the same humans.
    const room2 = (await colyseus.createRoom(SPACE_CHASE, {})) as unknown as SpaceChaseRoom;
    const a2 = await colyseus.connectTo(room2, { nickname: "Ada" });
    await colyseus.connectTo(room2, { nickname: "Ben" });
    a2.send(LobbyMsg.LOAD, blob);
    await until(() => room2.state.loadedSave !== "");
    a2.send(LobbyMsg.START, {});
    await until(() => room2.state.phase === Phase.PLAYING);

    assert.equal(room2.engine.players[0]!.position, 33, "Ada's position resumed");
    assert.equal(room2.engine.players[1]!.position, 12, "Ben's position resumed");
    assert.equal(room2.engine.turnCount, room.engine.turnCount);
    assert.equal(room2.state.deckCount, room.state.deckCount);
  });

  it("rejects a tampered save blob", async () => {
    const { room, a } = await startedGame(5);
    let blob: any;
    a.onMessage(ServerMsg.SAVE_DATA, (b: any) => (blob = b));
    a.send(LobbyMsg.SAVE, {});
    await until(() => blob !== undefined);

    const room2 = (await colyseus.createRoom(SPACE_CHASE, {})) as unknown as SpaceChaseRoom;
    const a2 = await colyseus.connectTo(room2, { nickname: "Ada" });
    await colyseus.connectTo(room2, { nickname: "Ben" });
    const tampered = { ...blob, engine: { ...blob.engine, deck: [999] } }; // bogus card id
    a2.send(LobbyMsg.LOAD, tampered);
    await sleep(100);
    assert.equal(room2.state.loadedSave, "", "tampered blob ignored");
  });

  it("auto-acts when the turn timer expires and freezes it on disconnect", async function () {
    this.timeout(10000);
    const room = (await colyseus.createRoom(SPACE_CHASE, { seed: 7 })) as unknown as SpaceChaseRoom;
    const a = await colyseus.connectTo(room, { nickname: "Ada" });
    const b = await colyseus.connectTo(room, { nickname: "Ben" });
    room.state.turnSeconds = 1; // white-box: 1s clock for the test
    a.send(LobbyMsg.START, {});
    await until(() => room.state.phase === Phase.PLAYING);
    assert.ok(room.state.turnDeadline > 0, "clock armed for Ada");

    // Ada does nothing; the timer auto-rolls for her and the turn advances.
    await until(() => room.state.currentTurn === b.sessionId, 4000);

    // Ben disconnects on his turn -> the clock freezes.
    await b.leave(false);
    await until(() => room.state.turnDeadline === 0, 4000);
    assert.ok(room.engine.awaiting.seat >= 0);
  });

  it("restores an open prompt after a mid-prompt refresh", async () => {
    const { room, a } = await startedGame(31);
    room.engine.players[1]!.position = 20;
    room.engine.deck.push(BLASTER);
    a.send(SpaceChaseMsg.DRAW, {});
    await until(() => room.state.awaitingType === ScAwait.TARGET);

    const token = a.reconnectionToken;
    const aId = a.sessionId;
    await a.leave(false);
    await until(() => room.state.players.get(aId)?.connected === false);
    // The open prompt survives in state (the engine never changed).
    assert.equal(room.state.awaitingType, ScAwait.TARGET);
    assert.equal(room.state.promptCardId, BLASTER);

    const a2 = await colyseus.sdk.reconnect(token);
    await until(() => (a2.state as any)?.awaitingType === ScAwait.TARGET, 5000);
    // ...and the reconnected client can still answer it.
    a2.send(SpaceChaseMsg.TARGET, { seat: 1 });
    await until(() => room.state.seats[1]!.position === 17);
  });

  it("removes a leaver from the race and plays on (3 players)", async () => {
    const { room, clients } = await startedGame(13, 3);
    const cleo = clients[2]!;
    // Ben leaves for good.
    await clients[1]!.leave(true);
    await until(() => room.engine.players[1]!.gone === true);
    assert.equal(room.state.seats[1]!.gone, true);
    assert.equal(room.state.seats[1]!.position, 0);

    // Turn order now skips Ben: Ada -> Cleo -> Ada ...
    const first = room.state.currentTurn;
    actor(room, clients).send(SpaceChaseMsg.ROLL, {});
    await until(() => room.state.currentTurn !== first);
    assert.notEqual(room.state.currentTurn, clients[1]!.sessionId, "Ben is skipped");
  });
});
