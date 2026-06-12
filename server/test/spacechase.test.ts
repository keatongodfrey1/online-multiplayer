/**
 * Space Chase room integration tests (Stage 2 scope: rotation, dice,
 * promptless cards, collisions, win + tiebreaker, rematch).
 *
 * Determinism: rooms take a { seed } option; `room.deck.push(id)` plants
 * the next draw (top of pile = last element) and `room.forcedRolls`
 * scripts die rolls - both consumed before the seeded RNG.
 */
import assert from "node:assert/strict";
import { boot, type ColyseusTestServer } from "@colyseus/testing";
import { defineRoom, defineServer } from "colyseus";
import {
  EndReason,
  LobbyMsg,
  Phase,
  ScAwait,
  ScEvent,
  SPACE_CHASE,
  SpaceChaseMsg,
} from "@backbone/shared";
import { SpaceChaseRoom } from "../src/games/spacechase/SpaceChaseRoom.js";
import { sleep, until } from "./StubRoom.js";

function makeConfig() {
  return defineServer({
    rooms: { [SPACE_CHASE]: defineRoom(SpaceChaseRoom) },
  });
}

describe("space chase", () => {
  let colyseus: ColyseusTestServer<ReturnType<typeof makeConfig>>;

  before(async () => {
    colyseus = await boot(makeConfig());
  });
  after(async () => colyseus.shutdown());
  beforeEach(async () => await colyseus.cleanup());

  async function startedGame(seed = 42, playerCount = 2) {
    const room = (await colyseus.createRoom(SPACE_CHASE, { seed })) as unknown as SpaceChaseRoom;
    const names = ["Ada", "Ben", "Cleo", "Dan", "Eve"];
    const clients = [];
    for (let i = 0; i < playerCount; i++) {
      clients.push(await colyseus.connectTo(room, { nickname: names[i] }));
    }
    clients[0]!.send(LobbyMsg.START, {});
    await until(() => room.state.phase === Phase.PLAYING);
    return { room, clients, a: clients[0]!, b: clients[1]! };
  }

  const seatPos = (room: SpaceChaseRoom, i: number) => room.state.seats[i]!.position;

  it("plays a full 2p game to a win on dice alone", async function () {
    this.timeout(15000);
    const { room, a, b } = await startedGame();
    assert.strictEqual(room.state.currentTurn, a.sessionId, "seat 0 goes first");
    assert.strictEqual(room.state.awaitingType, ScAwait.ACTION);

    // Ada rolls 5s (5,10,...,65 - never a portal mouth), Ben rolls 3s.
    // Ada caps onto the Finish on her 14th roll, before their paths can
    // ever share a space on the same tick.
    for (let i = 0; i < 27; i++) room.forcedRolls.push(i % 2 === 0 ? 5 : 3);
    let guard = 0;
    while (room.state.phase === Phase.PLAYING) {
      assert.ok(++guard < 40, "game did not terminate");
      const actor = room.state.currentTurn === a.sessionId ? a : b;
      const before = room.state.events.length;
      actor.send(SpaceChaseMsg.ROLL, {});
      await until(() => room.state.events.length > before || room.state.phase !== Phase.PLAYING);
    }

    assert.strictEqual(room.state.phase, Phase.ENDED);
    assert.strictEqual(room.state.endReason, `${EndReason.WIN_PREFIX}0`);
    assert.strictEqual(seatPos(room, 0), 68);
    assert.strictEqual(room.state.currentTurn, "", "turn cleared after game end");
    assert.strictEqual(room.state.awaitingType, "");
  });

  it("ignores out-of-turn actions and invalid config", async () => {
    const room = (await colyseus.createRoom(SPACE_CHASE, { seed: 1 })) as unknown as SpaceChaseRoom;
    const a = await colyseus.connectTo(room, { nickname: "Ada" });
    const b = await colyseus.connectTo(room, { nickname: "Ben" });

    // Lobby config: host-only, 15s steps only.
    b.send(SpaceChaseMsg.CONFIG, { turnSeconds: 60 }); // not the host
    a.send(SpaceChaseMsg.CONFIG, { turnSeconds: 7 }); // not a step
    a.send(SpaceChaseMsg.CONFIG, { turnSeconds: -15 });
    a.send(SpaceChaseMsg.CONFIG, { turnSeconds: "60" });
    await sleep(80);
    assert.strictEqual(room.state.turnSeconds, 0, "bad config ignored");
    a.send(SpaceChaseMsg.CONFIG, { turnSeconds: 60 });
    await until(() => room.state.turnSeconds === 60);

    a.send(LobbyMsg.START, {});
    await until(() => room.state.phase === Phase.PLAYING);
    a.send(SpaceChaseMsg.CONFIG, { turnSeconds: 0 }); // config is lobby-only
    b.send(SpaceChaseMsg.ROLL, {}); // not Ben's turn
    b.send(SpaceChaseMsg.DRAW, {});
    await sleep(80);
    assert.strictEqual(room.state.turnSeconds, 60);
    assert.strictEqual(seatPos(room, 0), 0);
    assert.strictEqual(seatPos(room, 1), 0);
    assert.strictEqual(room.state.currentTurn, a.sessionId, "still Ada's turn");

    // Junk payloads on valid actions don't matter (payloads are empty).
    room.forcedRolls.push(5);
    a.send(SpaceChaseMsg.ROLL, { evil: true });
    await until(() => seatPos(room, 0) === 5);
    // A second roll out of the ACTION phase window is ignored... it is
    // now Ben's turn, so Ada rolling again must do nothing.
    a.send(SpaceChaseMsg.ROLL, {});
    await sleep(80);
    assert.strictEqual(seatPos(room, 0), 5);
  });

  it("rematch fully resets the game (fresh deck, positions, rounds)", async () => {
    const { room, a, b } = await startedGame(9);
    room.state.seats[0]!.position = 67;
    room.forcedRolls.push(1);
    a.send(SpaceChaseMsg.ROLL, {});
    await until(() => room.state.phase === Phase.ENDED);
    assert.strictEqual(room.state.endReason, `${EndReason.WIN_PREFIX}0`);

    a.send(LobbyMsg.REMATCH, {});
    b.send(LobbyMsg.REMATCH, {});
    await until(() => room.state.phase === Phase.PLAYING);
    assert.strictEqual(seatPos(room, 0), 0);
    assert.strictEqual(seatPos(room, 1), 0);
    assert.strictEqual(room.state.roundNumber, 0);
    assert.strictEqual(room.state.deckCount, 42);
    assert.strictEqual(room.state.discardCount, 0);
    assert.strictEqual(room.state.lastCardId, 0);
    assert.strictEqual(room.state.events.length, 0);
    assert.strictEqual(room.state.currentTurn, a.sessionId, "seat 0 starts the rematch");
    assert.strictEqual(room.state.awaitingType, ScAwait.ACTION);
    assert.strictEqual(room.deck.length, 42, "server pile rebuilt");
  });

  it("resolves movement, penalty and extra-turn cards with the right turn economy", async () => {
    const { room, a, b } = await startedGame(7);

    // Ada draws Space Credit (#4): forward 20.
    room.deck.push(4);
    a.send(SpaceChaseMsg.DRAW, {});
    await until(() => seatPos(room, 0) === 20);
    assert.strictEqual(room.state.lastCardId, 4);
    assert.strictEqual(room.state.deckCount, 42, "planted card replaced the count"); // 42 planted +1 -1
    assert.strictEqual(room.state.discardCount, 1);

    // Ben draws Space Gun (#36): loses 2 turns. His next two turns skip.
    room.deck.push(36);
    b.send(SpaceChaseMsg.DRAW, {});
    await until(() => room.state.seats[1]!.lostTurns === 2);
    await until(() => room.state.currentTurn === a.sessionId);

    // Ada rolls; Ben's turn is skipped; Ada again - twice over.
    room.forcedRolls.push(1);
    a.send(SpaceChaseMsg.ROLL, {});
    await until(() => seatPos(room, 0) === 21);
    assert.strictEqual(room.state.currentTurn, a.sessionId, "Ben skipped (1st lost turn)");
    room.forcedRolls.push(1);
    a.send(SpaceChaseMsg.ROLL, {});
    await until(() => seatPos(room, 0) === 22);
    assert.strictEqual(room.state.currentTurn, a.sessionId, "Ben skipped (2nd lost turn)");
    assert.strictEqual(room.state.seats[1]!.lostTurns, 0);

    // Lost turns burned: now Ada's roll passes to Ben normally.
    room.forcedRolls.push(1);
    a.send(SpaceChaseMsg.ROLL, {});
    await until(() => seatPos(room, 0) === 23);
    await until(() => room.state.currentTurn === b.sessionId);
    room.forcedRolls.push(2);
    b.send(SpaceChaseMsg.ROLL, {});
    await until(() => seatPos(room, 1) === 2);
    await until(() => room.state.currentTurn === a.sessionId);
    // 4 full go-arounds happened (Ben's two skips still wrap the table).
    assert.strictEqual(room.state.roundNumber, 4);

    // Ada draws Nebula (#32): 2 extra turns - she acts 3 times in a row.
    room.deck.push(32);
    a.send(SpaceChaseMsg.DRAW, {});
    await until(() => room.state.seats[0]!.extraTurns === 1, 2000); // first extra consumed immediately
    assert.strictEqual(room.state.currentTurn, a.sessionId);
    room.forcedRolls.push(1);
    a.send(SpaceChaseMsg.ROLL, {});
    await until(() => seatPos(room, 0) === 24);
    assert.strictEqual(room.state.currentTurn, a.sessionId, "still Ada (2nd extra turn)");
    room.forcedRolls.push(1);
    a.send(SpaceChaseMsg.ROLL, {});
    await until(() => seatPos(room, 0) === 25);
    await until(() => room.state.currentTurn === b.sessionId);
    assert.strictEqual(room.state.roundNumber, 4, "extra turns are not go-arounds");
  });

  it("collides rockets sharing a space - all back to START (move-all collides once at the end)", async () => {
    const { room, a, b } = await startedGame(11);

    // Ada rolls onto Ben's space: both to START.
    room.state.seats[0]!.position = 7;
    room.state.seats[1]!.position = 10;
    room.forcedRolls.push(3);
    a.send(SpaceChaseMsg.ROLL, {});
    await until(() => seatPos(room, 0) === 0 && seatPos(room, 1) === 0);
    assert.ok(
      [...room.state.events].some((e) => e.kind === ScEvent.COLLISION),
      "collision event logged"
    );

    // Meteor Shower (#14): everyone back 5; landing on START is exempt.
    await until(() => room.state.currentTurn === b.sessionId);
    room.state.seats[0]!.position = 10;
    room.state.seats[1]!.position = 5;
    room.deck.push(14);
    b.send(SpaceChaseMsg.DRAW, {});
    await until(() => seatPos(room, 0) === 5);
    assert.strictEqual(seatPos(room, 1), 0, "Ben pushed back to START");
    assert.strictEqual(seatPos(room, 0), 5, "Ada alone on 5 - no collision with START");
  });

  it("dice movement traverses portals (enter, ride, exit with overflow)", async () => {
    const { room, a, b } = await startedGame(13);

    room.forcedRolls.push(4); // Ada lands on 4 - portal 1's mouth
    a.send(SpaceChaseMsg.ROLL, {});
    await until(() => room.state.seats[0]!.portalId === 1);
    assert.strictEqual(seatPos(room, 0), 4, "position holds the entry mouth");
    assert.strictEqual(room.state.seats[0]!.portalProgress, 0);

    room.forcedRolls.push(1);
    b.send(SpaceChaseMsg.ROLL, {});
    await until(() => room.state.currentTurn === a.sessionId);

    room.forcedRolls.push(6); // 6 of 7 internal spaces - still inside
    a.send(SpaceChaseMsg.ROLL, {});
    await until(() => room.state.seats[0]!.portalProgress === 6);
    assert.strictEqual(room.state.seats[0]!.portalId, 1);

    room.forcedRolls.push(1);
    b.send(SpaceChaseMsg.ROLL, {});
    await until(() => room.state.currentTurn === a.sessionId);

    // 1 to the lip, 1 to exit at 36, 4 left over -> space 40.
    room.forcedRolls.push(6);
    a.send(SpaceChaseMsg.ROLL, {});
    await until(() => seatPos(room, 0) === 40);
    assert.strictEqual(room.state.seats[0]!.portalId, 0);
  });

  it("simultaneous finishers trigger a dice roll-off, re-rolling ties", async () => {
    const { room, a } = await startedGame(17);
    room.state.seats[0]!.position = 65;
    room.state.seats[1]!.position = 64;
    // Cosmic Chaos (#6) pushes both past the Finish; roll-off 4-4 then 6-2.
    room.deck.push(6);
    room.forcedRolls.push(4, 4, 6, 2);
    a.send(SpaceChaseMsg.DRAW, {});
    await until(() => room.state.phase === Phase.ENDED);
    assert.strictEqual(room.state.endReason, `${EndReason.WIN_PREFIX}0`);
    const rolls = [...room.state.events].filter((e) => e.kind === ScEvent.TIEBREAK_ROLL);
    assert.strictEqual(rolls.length, 4, "two tied rounds of rolls");
    assert.deepEqual(
      rolls.map((e) => e.a),
      [4, 4, 6, 2]
    );
  });
});
