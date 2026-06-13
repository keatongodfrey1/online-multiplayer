import assert from "node:assert/strict";
import { boot, type ColyseusTestServer } from "@colyseus/testing";
import { defineRoom, defineServer } from "colyseus";
import { EndReason, LobbyMsg, PERFECT_PALACE, PerfectPalaceMsg, Phase } from "@backbone/shared";
import { PerfectPalaceRoom } from "../src/games/perfectpalace/PerfectPalaceRoom.js";
import { sleep, until } from "./StubRoom.js";

function makeConfig() {
  return defineServer({
    rooms: { [PERFECT_PALACE]: defineRoom(PerfectPalaceRoom) },
  });
}

/** A valid one-to-one resource card (the six RESOURCE_OPTIONS, default order). */
function validCard() {
  return [
    { kind: "sticks", amount: 5 },
    { kind: "bricks", amount: 5 },
    { kind: "bricks", amount: 10 },
    { kind: "dollars", amount: 5 },
    { kind: "dollars", amount: 10 },
    { kind: "draw-card", amount: 0 },
  ];
}

describe("perfect palace", () => {
  let colyseus: ColyseusTestServer<ReturnType<typeof makeConfig>>;

  before(async () => {
    colyseus = await boot(makeConfig());
  });
  after(async () => colyseus.shutdown());
  beforeEach(async () => await colyseus.cleanup());

  async function startedGame(seed = 42, playerCount = 2) {
    const room = (await colyseus.createRoom(PERFECT_PALACE, { seed })) as unknown as PerfectPalaceRoom;
    const clients = [];
    for (let i = 0; i < playerCount; i++) {
      clients.push(await colyseus.connectTo(room, { nickname: `Player${i}` }));
    }
    clients[0]!.send(LobbyMsg.START, {});
    await until(() => room.state.phase === Phase.PLAYING);
    return { room, clients };
  }

  /** The connected client owning a given engine seat. */
  function clientFor(room: PerfectPalaceRoom, clients: any[], engineSeat: number): any {
    const sessionId = room.seatOrder[engineSeat];
    return clients.find((c) => c.sessionId === sessionId);
  }

  function clientForId(room: PerfectPalaceRoom, clients: any[], engineId: string): any {
    const idx = room.engine.players.findIndex((p) => p.id === engineId);
    return idx >= 0 ? clientFor(room, clients, idx) : undefined;
  }

  /** Lock every player's mapping; the room auto-reveals when all are in. */
  async function completeMapping(room: PerfectPalaceRoom, clients: any[]): Promise<void> {
    for (let i = 0; i < room.engine.players.length; i++) {
      const c = clientFor(room, clients, i);
      if (!c) continue;
      const prev = room.engine;
      c.send(PerfectPalaceMsg.ACTION, { type: "mapping/setInitial", card: validCard() });
      await until(() => room.engine !== prev);
    }
    await until(() => room.engine.phase !== "initial-mapping");
  }

  // ---- setup / redaction ---------------------------------------------------

  it("starts at the hidden initial mapping with seats built and the deck redacted", async () => {
    const { room } = await startedGame(42, 3);
    assert.equal(room.engine.phase, "initial-mapping");
    assert.equal(room.state.seats.length, 3);
    assert.deepEqual(
      [...room.state.seats].map((s) => s.engineId),
      ["p1", "p2", "p3"],
    );
    // deck/discard are COUNTS only — no card array on the schema.
    assert.equal(room.state.deckCount, 18);
    assert.equal(room.state.discardCount, 0);
    assert.equal((room.state as any).deck, undefined);
    assert.equal((room.state as any).discard, undefined);
    // resource cards are hidden until reveal.
    assert.ok([...room.state.seats].every((s) => s.resourceCard.length === 0));
  });

  // ---- forge-proofing ------------------------------------------------------

  it("binds an action to its sender and rejects out-of-turn / injected dice", async () => {
    const { room, clients } = await startedGame(7, 2);
    await completeMapping(room, clients);
    // p1 goes first.
    assert.equal(room.engine.currentPlayerId, room.engine.turnOrder[0]);
    const current = room.engine.currentPlayerId!;
    const other = room.engine.players.find((p) => p.id !== current)!.id;

    // out-of-turn: the non-current player cannot roll.
    let prev = room.engine;
    clientForId(room, clients, other)!.send(PerfectPalaceMsg.ACTION, { type: "turn/rollDie" });
    await sleep(60);
    assert.equal(room.engine, prev, "out-of-turn roll ignored");

    // a client cannot inject a die value via the test-only seam (not whitelisted).
    clientForId(room, clients, current)!.send(PerfectPalaceMsg.ACTION, { type: "turn/rollDieWithValue", value: 6 });
    await sleep(60);
    assert.equal(room.engine, prev, "client dice-injection ignored");

    // the legal roll lands, server-generated and in range.
    clientForId(room, clients, current)!.send(PerfectPalaceMsg.ACTION, { type: "turn/rollDie", value: 6 });
    await until(() => room.engine !== prev);
    assert.ok(room.state.lastRoll >= 1 && room.state.lastRoll <= 6, "server rolled a real d6");
  });

  // ---- simultaneous mapping ------------------------------------------------

  it("keeps initial picks hidden until everyone locks, and binds the lock to the sender", async () => {
    const { room, clients } = await startedGame(9, 2);
    // p2 tries to lock p1's mapping; sanitize forces the id to the sender.
    let prev = room.engine;
    clientFor(room, clients, 1)!.send(PerfectPalaceMsg.ACTION, { type: "mapping/setInitial", id: "p1", card: validCard() });
    await until(() => room.engine !== prev);
    assert.equal(room.engine.players.find((p) => p.id === "p1")!.mappingLocked ?? false, false, "p1 not locked by p2");
    assert.equal(room.engine.players.find((p) => p.id === "p2")!.mappingLocked, true, "p2 locked themselves");
    // still hidden, still in the mapping phase (p1 hasn't locked).
    assert.equal(room.engine.phase, "initial-mapping");
    assert.ok([...room.state.seats].every((s) => s.resourceCard.length === 0));

    // p1 locks -> auto-reveal publishes every card.
    prev = room.engine;
    clientFor(room, clients, 0)!.send(PerfectPalaceMsg.ACTION, { type: "mapping/setInitial", card: validCard() });
    await until(() => room.engine.phase !== "initial-mapping");
    assert.ok([...room.state.seats].every((s) => s.resourceCard.length === 6), "all cards published at reveal");
  });

  // ---- duel ----------------------------------------------------------------

  it("runs a same-square duel: bystanders can't roll, contenders resolve it, the winner takes the pot", async () => {
    const { room, clients } = await startedGame(11, 3);
    await completeMapping(room, clients);
    // White-box a duel between p1 and p2 (p3 is a bystander), both flush with cash.
    const e = room.engine;
    room.engine = {
      ...e,
      turn: { ...e.turn, phase: "duel" },
      currentPlayerId: "p1",
      players: e.players.map((p) =>
        p.id === "p1" || p.id === "p2" ? { ...p, position: 7, inventory: { ...p.inventory, dollars: 100 } } : p,
      ),
      duel: {
        squareNumber: 7,
        participants: ["p1", "p2"],
        contenders: ["p1", "p2"],
        stake: { dollars: 5, bricks: 0, sticks: 0, walls: 0, roofs: 0, rooms: 0 },
        rolls: {},
      },
    };
    (room as any).syncFromEngine();
    assert.equal(room.state.duelActive, true);

    // bystander p3 cannot roll.
    let prev = room.engine;
    clientForId(room, clients, "p3")!.send(PerfectPalaceMsg.ACTION, { type: "turn/duelRollForPlayer" });
    await sleep(60);
    assert.equal(room.engine, prev, "bystander duel roll ignored");

    // contenders roll (server dice); ties re-roll automatically until resolved.
    let guard = 0;
    while (room.engine.duel && room.engine.turn.phase === "duel" && guard++ < 50) {
      const d = room.engine.duel;
      const next = d.contenders.find((id) => d.rolls[id] == null);
      if (next === undefined) break;
      prev = room.engine;
      clientForId(room, clients, next)!.send(PerfectPalaceMsg.ACTION, { type: "turn/duelRollForPlayer" });
      await until(() => room.engine !== prev);
    }
    assert.equal(room.engine.duel, undefined, "duel resolved and cleared");
    assert.equal(room.state.duelActive, false);
    const dollars = room.engine.players.filter((p) => p.id === "p1" || p.id === "p2").map((p) => p.inventory.dollars);
    assert.ok(dollars.includes(110), "the winner took the $10 pot");
  });

  // ---- a full game to a palace win, mapped through framework seats ----------

  it("ends on a palace win and maps the winner through the framework seat", async () => {
    const { room, clients } = await startedGame(13, 2);
    await completeMapping(room, clients);
    const e = room.engine;
    // p1 has built a palace and taken their catch-up turn; p2 ends to finish.
    room.engine = {
      ...e,
      phase: "optional-actions",
      currentPlayerId: "p2",
      turn: { ...e.turn, phase: "optional-actions", activePlayerIndex: 1, skipOptionalActions: false },
      palaceBuiltBy: "p1",
      palaceTriggerTurnIndex: 0,
      players: e.players.map((p) => {
        if (p.id === "p1") return { ...p, baseTurnsTaken: 1, inventory: { ...p.inventory, palaces: 1 } };
        if (p.id === "p2") return { ...p, baseTurnsTaken: 0 };
        return p;
      }),
    };
    (room as any).syncFromEngine();

    clientForId(room, clients, "p2")!.send(PerfectPalaceMsg.ACTION, { type: "turn/endTurn" });
    await until(() => room.state.phase === Phase.ENDED);
    // p1 is engine seat 0 -> framework seat 0.
    assert.equal(room.state.endReason, "win:0");
    assert.equal(room.engine.phase, "game-over");
    assert.equal(room.state.currentTurn, "");
  });

  // ---- save / resume -------------------------------------------------------

  it("saves a game and resumes it exactly in a fresh room, then play continues", async () => {
    const { room, clients } = await startedGame(70, 3);
    await completeMapping(room, clients);
    // advance one real turn so the resume isn't trivially at the opening.
    const cur = room.engine.currentPlayerId!;
    let prev = room.engine;
    clientForId(room, clients, cur)!.send(PerfectPalaceMsg.ACTION, { type: "turn/rollDie" });
    await until(() => room.engine !== prev);

    const snapshot = JSON.parse(JSON.stringify(room.buildSave()));
    const before = room.engine;

    const room2 = (await colyseus.createRoom(PERFECT_PALACE, { seed: 999 })) as unknown as PerfectPalaceRoom;
    const c2 = [];
    for (let i = 0; i < 3; i++) c2.push(await colyseus.connectTo(room2, { nickname: `Player${i}` }));
    c2[0]!.send(LobbyMsg.LOAD, snapshot);
    await until(() => room2.state.loadedSave !== "");
    c2[0]!.send(LobbyMsg.START, {});
    await until(() => room2.state.phase === Phase.PLAYING);

    assert.equal(room2.engine.phase, before.phase);
    assert.equal(room2.engine.currentPlayerId, before.currentPlayerId);
    assert.equal(room2.engine.rngState, before.rngState, "seeded PRNG resumed exactly");
    assert.deepEqual(room2.engine.deck, before.deck, "deck order resumed exactly");
    assert.deepEqual(
      room2.engine.players.map((p) => p.inventory),
      before.players.map((p) => p.inventory),
    );
  });

  it("gates the start until the saved lineup returns", async () => {
    const { room, clients } = await startedGame(71, 3);
    await completeMapping(room, clients);
    const snapshot = JSON.parse(JSON.stringify(room.buildSave()));

    const room2 = (await colyseus.createRoom(PERFECT_PALACE, { seed: 998 })) as unknown as PerfectPalaceRoom;
    const host = await colyseus.connectTo(room2, { nickname: "Player0" });
    host.send(LobbyMsg.LOAD, snapshot);
    await until(() => room2.state.loadedSave !== "");

    // only 1 of 3 saved humans present -> start is vetoed.
    host.send(LobbyMsg.START, {});
    await sleep(120);
    assert.equal(room2.state.phase, Phase.LOBBY, "start blocked until the lineup is back");

    await colyseus.connectTo(room2, { nickname: "Player1" });
    await colyseus.connectTo(room2, { nickname: "Player2" });
    host.send(LobbyMsg.START, {});
    await until(() => room2.state.phase === Phase.PLAYING);
    assert.notEqual(room2.engine.phase, "initial-roll", "resumed where it was saved");
  });

  it("ignores corrupt or tampered saves", async () => {
    const { room, clients } = await startedGame(72, 3);
    await completeMapping(room, clients);
    const good = JSON.parse(JSON.stringify(room.buildSave())) as any;

    const room2 = (await colyseus.createRoom(PERFECT_PALACE, { seed: 997 })) as unknown as PerfectPalaceRoom;
    const host = await colyseus.connectTo(room2, { nickname: "Player0" });
    await colyseus.connectTo(room2, { nickname: "Player1" });
    await colyseus.connectTo(room2, { nickname: "Player2" });

    const tampered: any[] = [
      null,
      "garbage",
      { ...good, v: 2 },
      { ...good, game: "splendor" },
      (() => { const b = structuredClone(good); b.engine.deck.push(99); return b; })(), // card id out of range
      (() => { const b = structuredClone(good); b.engine.deck.push(b.engine.discard[0] ?? 1); return b; })(), // dup card / wrong count
      (() => { const b = structuredClone(good); b.engine.players[0].inventory.bricks = -5; return b; })(), // negative inventory
      (() => { const b = structuredClone(good); delete b.engine.rngState; return b; })(), // missing PRNG state
      (() => { const b = structuredClone(good); b.engine.phase = "game-over"; return b; })(), // finished game
      (() => { const b = structuredClone(good); b.engine.players[0].resourceCard[0] = { kind: "dollars", amount: 999 }; return b; })(), // bad card
    ];
    for (const bad of tampered) {
      host.send(LobbyMsg.LOAD, bad);
      await sleep(40);
      assert.equal(room2.state.loadedSave, "", `rejected: ${JSON.stringify(bad).slice(0, 40)}`);
    }
    host.send(LobbyMsg.LOAD, good);
    await until(() => room2.state.loadedSave !== "");
  });

  // ---- departures ----------------------------------------------------------

  it("ends a 2p game as abandoned when a player quits", async () => {
    const { room, clients } = await startedGame(20, 2);
    await completeMapping(room, clients);
    await clients[1]!.leave(true);
    await until(() => room.state.phase === Phase.ENDED);
    assert.equal(room.state.endReason, EndReason.ABANDONED);
    assert.equal(room.state.currentTurn, "");
  });

  it("removes a departing player from a 3p game and plays on", async () => {
    const { room, clients } = await startedGame(21, 3);
    await completeMapping(room, clients);
    const leaver = room.engine.players[1]!.id; // p2 (not the current player)
    await clients[1]!.leave(true);
    await until(() => room.engine.players.find((p) => p.id === leaver)?.removed === true);
    assert.equal(room.state.phase, Phase.PLAYING, "game continues with 2 players");
    assert.equal(room.state.seats[1]!.gone, true);
    // the Bailiff is never left in a removed player's hands.
    assert.ok(room.state.bailiffBy !== leaver);
  });
});
