import assert from "node:assert/strict";
import { boot, type ColyseusTestServer } from "@colyseus/testing";
import { defineRoom, defineServer } from "colyseus";
import { EndReason, LobbyMsg, PERFECT_PALACE, PerfectPalaceEngine, PerfectPalaceMsg, Phase } from "@backbone/shared";
import { PerfectPalaceRoom } from "../src/games/perfectpalace/PerfectPalaceRoom.js";
import { sleep, until } from "./StubRoom.js";

const { chooseAction } = PerfectPalaceEngine;

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

  async function startedGame(seed = 42, playerCount = 2, beforeStart?: (room: PerfectPalaceRoom) => void) {
    const room = (await colyseus.createRoom(PERFECT_PALACE, { seed })) as unknown as PerfectPalaceRoom;
    const clients = [];
    for (let i = 0; i < playerCount; i++) {
      clients.push(await colyseus.connectTo(room, { nickname: `Player${i}` }));
    }
    beforeStart?.(room);
    clients[0]!.send(LobbyMsg.START, {});
    await until(() => room.state.phase === Phase.PLAYING);
    return { room, clients };
  }

  /** Engine seats that must act now (mirrors the room's awaiting logic). */
  function awaitingSeats(room: PerfectPalaceRoom): number[] {
    const e = room.engine;
    if (e.phase === "game-over") return [];
    if (e.phase === "initial-mapping")
      return e.players.map((_, i) => i).filter((i) => !e.players[i]!.mappingLocked);
    if (e.turn.phase === "duel" && e.duel)
      return e.duel.contenders.filter((id) => e.duel!.rolls[id] == null).map((id) => e.players.findIndex((p) => p.id === id));
    const idx = e.players.findIndex((p) => p.id === e.currentPlayerId);
    return idx >= 0 ? [idx] : [];
  }

  /** Drive every connected human seat with the bot policy (over the wire) while
   *  the room auto-plays bot/vacated seats, until the game ends or a cap. */
  async function driveToEnd(room: PerfectPalaceRoom, clients: any[], cap = 4000): Promise<void> {
    const bySession = new Map(clients.map((c) => [c.sessionId, c]));
    for (let i = 0; i < cap && room.state.phase === Phase.PLAYING; i++) {
      const seat = awaitingSeats(room).find((idx) => {
        const sid = room.seatOrder[idx];
        return sid && bySession.has(sid);
      });
      if (seat === undefined) {
        await sleep(8); // only bot/vacated seats are awaiting — let the room play them
        continue;
      }
      const prev = room.engine;
      bySession.get(room.seatOrder[seat])!.send(PerfectPalaceMsg.ACTION, chooseAction(room.engine, room.engine.players[seat]!.id));
      await until(() => room.engine !== prev, 2000).catch(() => {});
    }
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

  it("bumps the dice-animation feed on each server roll", async () => {
    const { room, clients } = await startedGame(8, 2);
    await completeMapping(room, clients);
    const current = room.engine.currentPlayerId!;
    const seq0 = room.state.lastRollSeq;
    clientForId(room, clients, current)!.send(PerfectPalaceMsg.ACTION, { type: "turn/rollDie" });
    await until(() => room.state.lastRollSeq > seq0);
    assert.ok(room.state.lastRollValue >= 1 && room.state.lastRollValue <= 6, "die value is 1-6");
    assert.equal(room.state.lastRollBy, current, "feed records who rolled");
  });

  it("honors lobby colour picks and rejects a taken colour", async () => {
    const room = (await colyseus.createRoom(PERFECT_PALACE, { seed: 30 })) as unknown as PerfectPalaceRoom;
    const a = await colyseus.connectTo(room, { nickname: "Player0" });
    const b = await colyseus.connectTo(room, { nickname: "Player1" });
    await until(() => room.state.players.size === 2);
    const choiceOf = (sid: string) => (room.state.players.get(sid) as any).colorChoice as number;

    a.send(PerfectPalaceMsg.PICK_COLOR, { color: 3 });
    await until(() => choiceOf(a.sessionId) === 3);
    b.send(PerfectPalaceMsg.PICK_COLOR, { color: 3 }); // already taken → ignored
    await sleep(60);
    assert.equal(choiceOf(b.sessionId), -1, "taken colour rejected");
    b.send(PerfectPalaceMsg.PICK_COLOR, { color: 1 });
    await until(() => choiceOf(b.sessionId) === 1);

    a.send(LobbyMsg.START, {});
    await until(() => room.state.phase === Phase.PLAYING);
    const seatA = [...room.state.seats].find((s) => s.sessionId === a.sessionId)!;
    const seatB = [...room.state.seats].find((s) => s.sessionId === b.sessionId)!;
    assert.equal(seatA.colorIndex, 3, "Player0's chosen colour lands on their seat");
    assert.equal(seatB.colorIndex, 1, "Player1's chosen colour lands on their seat");
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

  it("holds a departed seat as bot-played and lets a newcomer reclaim it", async () => {
    const { room, clients } = await startedGame(21, 3, (r) => (r.botDelayMs = 1));
    await completeMapping(room, clients);

    // The current player leaves for good → their seat is HELD (not removed) and
    // immediately auto-played by the bot policy.
    const goneSeat = room.engine.players.findIndex((p) => p.id === room.engine.currentPlayerId);
    await clientFor(room, clients, goneSeat)!.leave(true);
    await until(() => room.state.seats[goneSeat]!.gone === true);
    assert.equal(room.state.phase, Phase.PLAYING, "the game keeps going");
    assert.equal(room.seatOrder[goneSeat], "", "the seat is vacated");
    assert.equal(room.engine.players[goneSeat]!.removed, false, "the seat is kept, not removed");
    // it plays on autopilot: the held seat takes turns on its own
    const before = room.engine.players[goneSeat]!.baseTurnsTaken;
    await until(() => room.engine.players[goneSeat]!.baseTurnsTaken > before, 4000);

    // A brand-new client joins mid-game and takes over the seat.
    const newcomer = await colyseus.connectTo(room, { nickname: "Latecomer" });
    await until(() => room.state.seats[goneSeat]!.gone === false, 3000);
    assert.equal(room.seatOrder[goneSeat], newcomer.sessionId, "seatOrder rebound to the newcomer");
    assert.equal(room.state.seats[goneSeat]!.nickname, "Latecomer");
    assert.ok([...room.state.log].some((l) => l.includes("takes over")));
  });

  it("rejects a mid-game joiner when no seat is open", async () => {
    const { room } = await startedGame(22, 3);
    let rejected = false;
    try {
      await colyseus.connectTo(room, { nickname: "Crasher" });
    } catch {
      rejected = true;
    }
    assert.ok(rejected, "the join was refused (no vacated seat)");
    assert.equal(room.state.players.size, 3, "roster unchanged");
    assert.equal(room.state.phase, Phase.PLAYING);
  });

  it("ends a bot game as abandoned when the last human leaves", async () => {
    const room = (await colyseus.createRoom(PERFECT_PALACE, { seed: 23 })) as unknown as PerfectPalaceRoom;
    room.botDelayMs = 1;
    const host = await colyseus.connectTo(room, { nickname: "Solo" });
    host.send(LobbyMsg.ADD_BOT, {});
    host.send(LobbyMsg.ADD_BOT, {});
    await until(() => room.state.players.size === 3);
    host.send(LobbyMsg.START, {});
    await until(() => room.state.phase === Phase.PLAYING);
    await host.leave(true); // only bots remain
    await until(() => room.state.phase === Phase.ENDED);
    assert.equal(room.state.endReason, EndReason.ABANDONED);
  });

  // ---- bots ----------------------------------------------------------------

  it("auto-plays AI players and drives a 1-human + 2-bot game to a win", async () => {
    const room = (await colyseus.createRoom(PERFECT_PALACE, { seed: 24 })) as unknown as PerfectPalaceRoom;
    room.botDelayMs = 1;
    const host = await colyseus.connectTo(room, { nickname: "Human" });
    host.send(LobbyMsg.ADD_BOT, {});
    host.send(LobbyMsg.ADD_BOT, {});
    await until(() => room.state.players.size === 3);
    assert.ok([...room.state.players.values()].filter((p) => p.isBot).length === 2, "two bots seated");
    host.send(LobbyMsg.START, {});
    await until(() => room.state.phase === Phase.PLAYING);

    // The human locks their card; the bots auto-lock → the reveal fires on its own.
    host.send(PerfectPalaceMsg.ACTION, { type: "mapping/setInitial", card: validCard() });
    await until(() => room.engine.phase !== "initial-mapping", 4000);

    // Put everyone one build from a palace so the game finishes quickly, then let
    // the human (policy-driven) and the auto-played bots play it out to a win.
    room.engine = {
      ...room.engine,
      players: room.engine.players.map((p) => ({ ...p, inventory: { ...p.inventory, threeStoryBuildings: 3 } })),
    };
    (room as any).syncFromEngine();
    await driveToEnd(room, [host]);
    await until(() => room.state.phase === Phase.ENDED, 5000);
    assert.ok(room.state.endReason.startsWith("win:"), `a winner emerged (${room.state.endReason})`);
  });

  it("saves and resumes a game that includes a bot", async () => {
    const room = (await colyseus.createRoom(PERFECT_PALACE, { seed: 25 })) as unknown as PerfectPalaceRoom;
    room.botDelayMs = 1;
    const host = await colyseus.connectTo(room, { nickname: "Host" });
    host.send(LobbyMsg.ADD_BOT, {});
    await until(() => room.state.players.size === 2);
    host.send(LobbyMsg.START, {});
    await until(() => room.state.phase === Phase.PLAYING);
    host.send(PerfectPalaceMsg.ACTION, { type: "mapping/setInitial", card: validCard() });
    await until(() => room.engine.phase !== "initial-mapping", 4000);
    const snapshot = JSON.parse(JSON.stringify(room.buildSave()));

    const room2 = (await colyseus.createRoom(PERFECT_PALACE, { seed: 991 })) as unknown as PerfectPalaceRoom;
    room2.botDelayMs = 1;
    const host2 = await colyseus.connectTo(room2, { nickname: "Host" });
    host2.send(LobbyMsg.LOAD, snapshot);
    await until(() => room2.state.loadedSave !== "");
    assert.ok([...room2.state.players.values()].some((p) => p.isBot), "the saved bot was re-seated");
    host2.send(LobbyMsg.START, {});
    await until(() => room2.state.phase === Phase.PLAYING, 4000);
    // Resumed past the opening, not a fresh game. (Don't compare live engine
    // fields — both rooms' bots keep playing and would race the assertion.)
    assert.notEqual(room2.engine.phase, "initial-mapping", "resumed an in-progress game, not a fresh one");
    assert.equal(room2.engine.players.length, snapshot.engine.players.length, "the full roster resumed");
  });

  it("seats AI players at a chosen difficulty and keeps it across save/resume", async () => {
    const room = (await colyseus.createRoom(PERFECT_PALACE, { seed: 40 })) as unknown as PerfectPalaceRoom;
    room.botDelayMs = 1;
    const host = await colyseus.connectTo(room, { nickname: "Host" });
    host.send(LobbyMsg.ADD_BOT, { difficulty: "hard" });
    await until(() => room.state.players.size === 2);
    const bot = [...room.state.players.values()].find((p) => p.isBot)!;
    assert.ok(bot.nickname.includes("(hard)"), `bot named by difficulty: ${bot.nickname}`);

    host.send(LobbyMsg.START, {});
    await until(() => room.state.phase === Phase.PLAYING);
    host.send(PerfectPalaceMsg.ACTION, { type: "mapping/setInitial", card: validCard() });
    await until(() => room.engine.phase !== "initial-mapping", 4000);
    const snapshot = JSON.parse(JSON.stringify(room.buildSave()));
    assert.equal(snapshot.seats.find((s: any) => s.isBot).difficulty, "hard", "difficulty saved in the blob");

    const room2 = (await colyseus.createRoom(PERFECT_PALACE, { seed: 992 })) as unknown as PerfectPalaceRoom;
    room2.botDelayMs = 1;
    const h2 = await colyseus.connectTo(room2, { nickname: "Host" });
    h2.send(LobbyMsg.LOAD, snapshot);
    await until(() => room2.state.loadedSave !== "");
    h2.send(LobbyMsg.START, {});
    await until(() => room2.state.phase === Phase.PLAYING, 4000);
    assert.equal(
      JSON.parse(JSON.stringify(room2.buildSave())).seats.find((s: any) => s.isBot).difficulty,
      "hard",
      "difficulty restored on resume",
    );
  });

  // ---- turn timer ----------------------------------------------------------

  it("arms a turn deadline for a human turn and the AI finishes a timed-out turn", async () => {
    const room = (await colyseus.createRoom(PERFECT_PALACE, { seed: 50 })) as unknown as PerfectPalaceRoom;
    room.botDelayMs = 1;
    const a = await colyseus.connectTo(room, { nickname: "P0" });
    const b = await colyseus.connectTo(room, { nickname: "P1" });
    await until(() => room.state.players.size === 2);
    a.send(PerfectPalaceMsg.CONFIG, { turnSeconds: 30 });
    await until(() => room.state.turnSeconds === 30);
    a.send(LobbyMsg.START, {});
    await until(() => room.state.phase === Phase.PLAYING);
    await completeMapping(room, [a, b]);

    // A connected human's single-actor turn → a deadline is armed.
    assert.ok(room.state.turnDeadline > 0, "deadline armed for the human turn");
    const before = room.engine.currentPlayerId;
    // Simulate the clock running out: the AI finishes the turn and it advances.
    (room as any).onTurnTimeout();
    await until(() => room.engine.currentPlayerId !== before, 4000);
    assert.notEqual(room.engine.currentPlayerId, before, "the timed-out turn was auto-finished and advanced");
  });

  it("does not arm a turn timer when it is off (default)", async () => {
    const { room, clients } = await startedGame(51, 2);
    await completeMapping(room, clients);
    assert.equal(room.state.turnSeconds, 0);
    assert.equal(room.state.turnDeadline, 0, "no deadline when the timer is off");
  });
});
