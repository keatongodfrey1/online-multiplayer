// Water Fight room — integration tests (real SDK clients via @colyseus/testing).
// Mirrors splendor.test.ts: full game to a win, illegal/out-of-turn ignored,
// rematch reset, and hidden-hand @view() survives a refresh.
import assert from "node:assert/strict";
import { boot, type ColyseusTestServer } from "@colyseus/testing";
import { defineRoom, defineServer } from "colyseus";
import { EndReason, LobbyMsg, Phase, ServerMsg, WATER_FIGHT, WaterFightEngine, WaterFightMsg } from "@backbone/shared";
import { WaterFightRoom } from "../src/games/waterfight/WaterFightRoom.js";
import { parseSave, serializeSave } from "../src/games/waterfight/save.js";
import { sleep, until } from "./StubRoom.js";

const { RandomPolicy, assertInvariants, createGame } = WaterFightEngine;

// ---- save-blob validator (pure; no Colyseus harness needed) ----
describe("water fight save validator", () => {
  function validBlob(): any {
    const engine = createGame(2, 7);
    return serializeSave({
      engine,
      seats: [
        { nickname: "A", isBot: false, gone: false },
        { nickname: "B", isBot: false, gone: false },
      ],
      options: { startingLives: 3, splashHit: 13, splashMiss: 7, mainHit: 20, mainMiss: 20, handLimit: 8, shopCost: 4, eventDensity: 8, stormDraw: 1, stormThrows: 1, maxReactions: 0, turnSeconds: 0, reactionSeconds: 12 },
    });
  }

  it("accepts a clean blob and rejects tampered/inconsistent ones", () => {
    const good = validBlob();
    assert.ok(parseSave(good), "a clean blob validates");
    const tamper = (mut: (b: any) => void): unknown => {
      const b = JSON.parse(JSON.stringify(good));
      mut(b);
      return parseSave(b);
    };
    // XSS source: a card kind that isn't a real CardKind
    assert.strictEqual(tamper((b) => (b.engine.players[0].hand = [{ id: 1, kind: "<img src=x onerror=alert(1)>" }])), null, "junk card kind rejected");
    // soft-lock: DEFEND await with no attack object
    assert.strictEqual(tamper((b) => (b.engine.awaiting = { seats: [1], kind: "DEFEND" })), null, "DEFEND without an attack rejected");
    // soft-lock: DISCARD await with nothing to discard
    assert.strictEqual(tamper((b) => (b.engine.awaiting = { seats: [0], kind: "DISCARD" })), null, "DISCARD with hand <= limit rejected");
    // desync: a MOVE await that doesn't head the turn seat
    assert.strictEqual(tamper((b) => { b.engine.turnSeat = 0; b.engine.awaiting = { seats: [1], kind: "MOVE" }; }), null, "MOVE/turn desync rejected");
    // soft-lock: a bogus pending support kind
    assert.strictEqual(tamper((b) => { b.engine.awaiting = { seats: [1], kind: "REACT" }; b.engine.pending = { kind: "SUPPORT", attacker: 0, target: 1, support: "bogus", redirectedSeats: [] }; }), null, "bogus pending support rejected");
    // soft-lock: a live game awaiting nobody
    assert.strictEqual(tamper((b) => { b.engine.over = false; b.engine.awaiting = { seats: [], kind: "GAME_OVER" }; }), null, "live game awaiting nobody rejected");
    // version mismatch
    assert.strictEqual(tamper((b) => (b.engine.engineVersion = "9.9.9")), null, "engine version mismatch rejected");
  });
});

function makeConfig() {
  return defineServer({
    rooms: { [WATER_FIGHT]: defineRoom(WaterFightRoom) },
  });
}

describe("water fight room", () => {
  let colyseus: ColyseusTestServer<ReturnType<typeof makeConfig>>;

  before(async () => {
    colyseus = await boot(makeConfig());
  });
  after(async () => colyseus.shutdown());
  beforeEach(async () => await colyseus.cleanup());

  async function startedGame(seed = 42, playerCount = 2, beforeStart?: (room: WaterFightRoom) => void) {
    const room = (await colyseus.createRoom(WATER_FIGHT, { seed })) as unknown as WaterFightRoom;
    const clients = [];
    for (let i = 0; i < playerCount; i++) {
      clients.push(await colyseus.connectTo(room, { nickname: `Player${i}` }));
    }
    // Turn off the auto-pass timers so the test fully drives every decision.
    room.state.turnSeconds = 0;
    room.state.reactionSeconds = 0;
    beforeStart?.(room);
    clients[0]!.send(LobbyMsg.START, {});
    await until(() => room.state.phase === Phase.PLAYING);
    return { room, clients };
  }

  it("plays a full 2p game to a win (driven by a policy)", async function () {
    this.timeout(60000);
    const { room, clients } = await startedGame(7);
    const policy = new RandomPolicy(1);
    const bySession = new Map(clients.map((c) => [c.sessionId, c]));

    let guard = 0;
    while (room.state.phase === Phase.PLAYING) {
      assert.ok(++guard < 6000, "game did not terminate");
      const prev = room.engine;
      const seat = prev.awaiting.seats[0]!;
      const actor = bySession.get(room.seatOrder[seat]!)!;
      if (prev.awaiting.kind === "MOVE") {
        actor.send(WaterFightMsg.MOVE, policy.move(prev));
      } else {
        actor.send(WaterFightMsg.RESOLVE, policy.resolve(prev));
      }
      await until(() => room.engine !== prev || room.state.phase !== Phase.PLAYING, 5000);
      assertInvariants(room.engine);
    }

    assert.strictEqual(room.state.phase, Phase.ENDED);
    assert.ok(
      room.state.endReason.startsWith(EndReason.WIN_PREFIX) || room.state.endReason === EndReason.DRAW,
      `unexpected endReason ${room.state.endReason}`,
    );
    assert.strictEqual(room.state.currentTurn, "", "turn cleared after game end");
  });

  it("ignores illegal and out-of-turn messages", async () => {
    const { room, clients } = await startedGame(5);
    const a = clients[0]!;
    const b = clients[1]!;
    const before = room.engine;
    // seat 0 is the opening turn; b acting + garbage payloads must do nothing
    b.send(WaterFightMsg.MOVE, { kind: "THROW", target: 0 });
    a.send(WaterFightMsg.MOVE, {});
    a.send(WaterFightMsg.MOVE, { kind: "NOPE" });
    a.send(WaterFightMsg.MOVE, { kind: "THROW", target: 0 }); // target self
    a.send(WaterFightMsg.RESOLVE, { kind: "DEFEND", defense: "miss" }); // not awaiting a resolution
    await sleep(120);
    assert.strictEqual(room.engine, before, "engine untouched by garbage / out-of-turn input");
    assert.strictEqual(room.state.currentTurn, a.sessionId, "still seat 0's turn");

    // A legal move from the right player advances the engine.
    a.send(WaterFightMsg.MOVE, { kind: "END_TURN" });
    await until(() => room.engine !== before);
    assert.strictEqual(room.state.turnSeat, 1, "turn advanced to seat 1");
  });

  it("hides each hand from opponents, including across a refresh", async () => {
    // Events off so seat 0's opening draw is deterministically 2 cards.
    const { room, clients } = await startedGame(11, 2, (r) => {
      r.state.eventDensity = 0;
    });
    const a = clients[0]!;
    const b = clients[1]!;
    const aState = () => a.state as unknown as { seats: { hand: { length: number }; handCount: number }[] };
    const bState = () => b.state as unknown as { seats: { hand: { length: number }; handCount: number }[] };

    await until(() => room.engine.players[0]!.hand.length === 2);
    await until(() => (aState().seats?.at(0)?.hand?.length ?? 0) === 2);
    assert.strictEqual(aState().seats.at(0)!.handCount, 2, "public count visible to owner");
    await until(() => bState().seats?.at(0)?.handCount === 2);
    assert.strictEqual(bState().seats.at(0)!.hand?.length ?? 0, 0, "opponent sees no card identities");

    // Refresh-style reconnect of the owner.
    const token = a.reconnectionToken;
    const aSessionId = a.sessionId;
    await a.leave(false);
    await until(() => room.state.players.get(aSessionId)?.connected === false);
    const a2 = await colyseus.sdk.reconnect(token);
    const a2State = () => a2.state as unknown as { seats: { hand: { length: number } }[] };
    await until(() => (a2State().seats?.at(0)?.hand?.length ?? 0) === 2, 5000);
    assert.strictEqual(bState().seats.at(0)!.hand?.length ?? 0, 0, "opponent still blind after the refresh");
  });

  it("rematch fully resets the game", async () => {
    const { room, clients } = await startedGame(3);
    const a = clients[0]!;
    const b = clients[1]!;

    // Force a quick finish: seat 1 at 1 life, seat 0 throws a guaranteed hit.
    room.engine.players[1]!.lives = 1;
    room.engine.players[0]!.hand = [{ id: 10000, kind: "balloon" }];
    room.engine.players[1]!.hand = [];
    room.engine.splashPile = ["hit", "hit"];
    a.send(WaterFightMsg.MOVE, { kind: "THROW", target: 1 });
    await until(() => room.engine.awaiting.kind === "SPLASH_DRAW");
    a.send(WaterFightMsg.RESOLVE, { kind: "DRAW_SPLASH" });
    await until(() => room.engine.awaiting.kind === "DEFEND");
    b.send(WaterFightMsg.RESOLVE, { kind: "DEFEND", defense: "pass" });
    await until(() => room.state.phase === Phase.ENDED);
    assert.strictEqual(room.state.endReason, `${EndReason.WIN_PREFIX}0`);

    const oldEngine = room.engine;
    a.send(LobbyMsg.REMATCH, {});
    b.send(LobbyMsg.REMATCH, {});
    await until(() => room.state.phase === Phase.PLAYING);
    assert.notStrictEqual(room.engine, oldEngine, "fresh engine");
    assert.strictEqual(room.engine.players[0]!.lives, 3, "lives reset");
    assert.strictEqual(room.engine.players[1]!.lives, 3);
    assert.strictEqual(room.state.currentTurn, a.sessionId, "seat 0 starts again");
  });

  // ---- Phase D: the reaction sub-phase over the wire ----

  /** Drive seat 0 into a guaranteed-Hit basic throw at seat 1, opening the
   *  defender's DEFEND ladder. Returns once the engine awaits seat 1's DEFEND. */
  async function openDefendLadder(
    room: WaterFightRoom,
    a: { send: (t: string, p: unknown) => void },
    attackerHand: { id: number; kind: string }[],
    defenderHand: { id: number; kind: string }[],
  ): Promise<void> {
    room.engine.players[0]!.hand = attackerHand as never;
    room.engine.players[1]!.hand = defenderHand as never;
    room.engine.splashPile = ["hit", "hit", "hit"];
    a.send(WaterFightMsg.MOVE, { kind: "THROW", target: 1 });
    // The throw now waits for the attacker (seat 0) to flip the Splash Pile.
    await until(() => room.engine.awaiting.kind === "SPLASH_DRAW" && room.engine.awaiting.seats[0] === 0);
    a.send(WaterFightMsg.RESOLVE, { kind: "DRAW_SPLASH" });
    await until(() => room.engine.awaiting.kind === "DEFEND" && room.engine.awaiting.seats[0] === 1);
  }

  it("accepts a reaction ONLY from the awaited (non-current) seat", async () => {
    const { room, clients } = await startedGame(31, 3);
    const [a, b, c] = clients as [typeof clients[0], typeof clients[0], typeof clients[0]];
    await openDefendLadder(room, a!, [{ id: 10000, kind: "balloon" }], [{ id: 10001, kind: "miss" }]);

    const before = room.engine;
    a!.send(WaterFightMsg.RESOLVE, { kind: "DEFEND", defense: "miss" }); // attacker, not awaited
    c!.send(WaterFightMsg.RESOLVE, { kind: "DEFEND", defense: "miss" }); // bystander, not awaited
    await sleep(120);
    assert.strictEqual(room.engine, before, "only the awaited defender may resolve");

    b!.send(WaterFightMsg.RESOLVE, { kind: "DEFEND", defense: "miss" }); // the awaited defender
    await until(() => room.engine !== before);
    assert.strictEqual(room.engine.awaiting.kind, "ATTACKER_RESPOND", "the ladder advanced to the attacker");
    assert.strictEqual(room.engine.awaiting.seats[0], 0);
  });

  it("runs the full alternating ladder over the wire", async () => {
    const { room, clients } = await startedGame(33);
    const [a, b] = clients;
    await openDefendLadder(room, a!, [{ id: 10000, kind: "balloon" }, { id: 10002, kind: "hit" }], [{ id: 10001, kind: "miss" }]);

    b!.send(WaterFightMsg.RESOLVE, { kind: "DEFEND", defense: "miss" });
    await until(() => room.engine.awaiting.kind === "ATTACKER_RESPOND");
    a!.send(WaterFightMsg.RESOLVE, { kind: "ATTACKER_RESPOND", respond: "hit" });
    await until(() => room.engine.awaiting.kind === "DEFEND");
    b!.send(WaterFightMsg.RESOLVE, { kind: "DEFEND", defense: "pass" });
    await until(() => room.engine.players[1]!.lives === 2);
    assert.strictEqual(room.engine.players[1]!.lives, 2, "Hit cancelled the block -> the throw landed");
  });

  it("opens a Towel window; only the target may cancel", async () => {
    const { room, clients } = await startedGame(35, 3);
    const [a, b, c] = clients as [typeof clients[0], typeof clients[0], typeof clients[0]];
    room.engine.players[0]!.hand = [{ id: 10000, kind: "balloon" }] as never;
    room.engine.players[1]!.hand = [{ id: 10001, kind: "towel" }] as never;
    room.engine.splashPile = ["hit", "hit"];
    a!.send(WaterFightMsg.MOVE, { kind: "THROW", target: 1 });
    await until(() => room.engine.awaiting.kind === "REACT" && room.engine.awaiting.seats[0] === 1);

    const before = room.engine;
    c!.send(WaterFightMsg.RESOLVE, { kind: "REACT", action: "towel" }); // bystander cannot
    await sleep(100);
    assert.strictEqual(room.engine, before, "only the target may react");

    b!.send(WaterFightMsg.RESOLVE, { kind: "REACT", action: "towel" });
    await until(() => room.engine.awaiting.kind !== "REACT");
    assert.strictEqual(room.engine.players[1]!.lives, 3, "Towel cancelled the throw — no damage");
  });

  it("the reaction timer auto-passes an idle defender", async function () {
    this.timeout(8000);
    const { room, clients } = await startedGame(37);
    const [a] = clients;
    room.state.reactionSeconds = 1; // 1s auto-pass
    await openDefendLadder(room, a!, [{ id: 10000, kind: "balloon" }], []);
    // The defender never responds; the room auto-passes after ~1s.
    await until(() => room.engine.players[1]!.lives === 2, 5000);
    assert.strictEqual(room.engine.turnSeat, 1, "the throw landed and the turn advanced, unattended");
  });

  it("keeps the defender's hand private during a reaction", async () => {
    const { room, clients } = await startedGame(39);
    const [a, b] = clients;
    await openDefendLadder(room, a!, [{ id: 10000, kind: "balloon" }], [{ id: 10001, kind: "miss" }]);
    type SeatsView = { seats: { hand: { length: number; at(i: number): { kind: string } | undefined }; handCount: number }[] };
    const aState = () => a!.state as unknown as SeatsView;
    const bState = () => b!.state as unknown as SeatsView;
    await until(() => (bState().seats?.at(1)?.hand?.length ?? 0) === 1, 3000);
    assert.strictEqual(bState().seats.at(1)!.hand.at(0)!.kind ?? "", "miss", "the defender sees their own Miss");
    assert.strictEqual(aState().seats.at(1)!.hand?.length ?? 0, 0, "the attacker cannot see the defender's hand");
    assert.ok((aState().seats.at(1)!.handCount ?? 0) >= 1, "but knows the size");
  });

  it("saves and resumes a game (validated blob), and rejects a tampered one", async () => {
    const { room, clients } = await startedGame(45);
    const [a] = clients;
    a!.send(WaterFightMsg.MOVE, { kind: "END_TURN" });
    await until(() => room.engine.turnCount === 1);

    let saved: any = null;
    a!.onMessage(ServerMsg.SAVE_DATA, (blob: unknown) => {
      saved = blob;
    });
    a!.send(LobbyMsg.SAVE, {});
    await until(() => saved !== null);
    assert.ok(parseSave(saved), "the produced blob validates");
    assert.strictEqual(parseSave({ v: 1, seats: [], options: {}, engine: { engineVersion: "x" } }), null, "tampered blob rejected");
    const savedTurnCount = saved.engine.turnCount;

    // Resume in a fresh room with the same lineup.
    const room2 = (await colyseus.createRoom(WATER_FIGHT, {})) as unknown as WaterFightRoom;
    const c0 = await colyseus.connectTo(room2, { nickname: "Player0" });
    await colyseus.connectTo(room2, { nickname: "Player1" });
    c0.send(LobbyMsg.LOAD, saved);
    await until(() => room2.state.loadedSave !== "");
    c0.send(LobbyMsg.START, {});
    await until(() => room2.state.phase === Phase.PLAYING);
    assert.strictEqual(room2.engine.turnCount, savedTurnCount, "resumed at the saved turn");
    assertInvariants(room2.engine);
  });

  it("CONFIG is host-only, lobby-only, and clamps out-of-range values", async () => {
    const room = (await colyseus.createRoom(WATER_FIGHT, {})) as unknown as WaterFightRoom;
    const host = await colyseus.connectTo(room, { nickname: "Host" });
    const other = await colyseus.connectTo(room, { nickname: "Other" });

    other.send(WaterFightMsg.CONFIG, { key: "startingLives", value: 5 }); // not the host
    await sleep(100);
    assert.strictEqual(room.state.startingLives, 3, "a non-host CONFIG is ignored");

    host.send(WaterFightMsg.CONFIG, { key: "startingLives", value: 999 }); // out of range
    await until(() => room.state.startingLives === 5);
    assert.strictEqual(room.state.startingLives, 5, "clamped to the setting max");

    host.send(LobbyMsg.START, {});
    await until(() => room.state.phase === Phase.PLAYING);
    host.send(WaterFightMsg.CONFIG, { key: "shopCost", value: 9 }); // mid-game
    await sleep(100);
    assert.strictEqual(room.state.shopCost, 4, "CONFIG is ignored once playing");
  });

  it("a defender who disconnects mid-reaction is auto-passed (the table never stalls)", async function () {
    this.timeout(8000);
    const { room, clients } = await startedGame(51);
    const [a, b] = clients;
    await openDefendLadder(room, a!, [{ id: 10000, kind: "balloon" }], []);
    assert.strictEqual(room.engine.awaiting.kind, "DEFEND");
    await b!.leave(false); // the awaited defender drops
    await until(() => room.engine.players[1]!.lives === 2, 5000); // auto-passed -> the throw lands
    assert.notStrictEqual(room.engine.awaiting.kind, "DEFEND", "the reaction resolved without the defender");
  });

  it("saves and resumes a mid-attack (DEFEND) state", async () => {
    const { room, clients } = await startedGame(53);
    const [a] = clients;
    // Give seat 0 a REAL balloon from the deck (preserves conservation) + force a Hit,
    // so the saved blob passes the validator's assertInvariants gate.
    const idx = room.engine.mainDeck.findIndex((c) => c.kind === "balloon");
    room.engine.players[0]!.hand.push(room.engine.mainDeck.splice(idx, 1)[0]!);
    room.engine.splashPile[room.engine.splashPile.length - 1] = "hit"; // force the flip, keep the count
    a!.send(WaterFightMsg.MOVE, { kind: "THROW", target: 1 });
    await until(() => room.engine.awaiting.kind === "SPLASH_DRAW");
    a!.send(WaterFightMsg.RESOLVE, { kind: "DRAW_SPLASH" });
    await until(() => room.engine.awaiting.kind === "DEFEND" && room.engine.awaiting.seats[0] === 1);

    let saved: any = null;
    a!.onMessage(ServerMsg.SAVE_DATA, (blob: unknown) => (saved = blob));
    a!.send(LobbyMsg.SAVE, {});
    await until(() => saved !== null);
    const parsed = parseSave(saved);
    assert.ok(parsed, "the mid-attack blob validates");
    assert.strictEqual(parsed!.engine.awaiting.kind, "DEFEND");
    assert.ok(parsed!.engine.awaiting.attack, "the open attack is preserved");

    const room2 = (await colyseus.createRoom(WATER_FIGHT, {})) as unknown as WaterFightRoom;
    const c0 = await colyseus.connectTo(room2, { nickname: "Player0" });
    await colyseus.connectTo(room2, { nickname: "Player1" });
    c0.send(LobbyMsg.LOAD, saved);
    await until(() => room2.state.loadedSave !== "");
    c0.send(LobbyMsg.START, {});
    await until(() => room2.state.phase === Phase.PLAYING);
    assert.strictEqual(room2.engine.awaiting.kind, "DEFEND", "resumed mid-ladder");
    assert.strictEqual(room2.engine.awaiting.seats[0], 1, "the defender is still the awaited seat");
  });

  it("re-sends the last peek to a reconnecting peeker (syncPrivate)", async () => {
    const { room, clients } = await startedGame(64, 2, (r) => {
      r.state.eventDensity = 0;
    });
    const a = clients[0]!;
    let reveals = 0;
    a.onMessage(WaterFightMsg.REVEAL, () => (reveals += 1));
    room.engine.players[0]!.hand.push({ id: 10001, kind: "goggles" });
    a.send(WaterFightMsg.MOVE, { kind: "PLAY_SUPPORT", support: "goggles" });
    await until(() => reveals === 1);

    // Refresh-style reconnect: the peeker should re-receive its last peek.
    const token = a.reconnectionToken;
    const aSessionId = a.sessionId;
    await a.leave(false);
    await until(() => room.state.players.get(aSessionId)?.connected === false);
    const a2 = await colyseus.sdk.reconnect(token);
    let re: any = null;
    a2.onMessage(WaterFightMsg.REVEAL, (p: unknown) => (re = p));
    await until(() => re !== null, 5000);
    assert.strictEqual(re.kind, "deck-top", "the reconnecting peeker re-receives its last peek");
    assert.strictEqual(re.cards.length, 3);
  });

  it("saves and resumes a mid-AoE (per-target reaction) state", async () => {
    const { room, clients } = await startedGame(57, 3);
    const a = clients[0]!;
    // Move a real Splash Zone (shop) + balloon (deck) into seat 0 — both conservation-preserving,
    // so the saved blob passes the validator's assertInvariants gate.
    const sz = room.engine.stacks.attack.findIndex((c) => c.kind === "splashzone");
    room.engine.players[0]!.hand.push(room.engine.stacks.attack.splice(sz, 1)[0]!);
    const bi = room.engine.mainDeck.findIndex((c) => c.kind === "balloon");
    room.engine.players[0]!.hand.push(room.engine.mainDeck.splice(bi, 1)[0]!);
    room.engine.splashPile[room.engine.splashPile.length - 1] = "hit"; // force the flip, keep the count
    a.send(WaterFightMsg.MOVE, { kind: "THROW", target: 1, spread: { modifier: "splashzone", extraTargets: [] } });
    await until(() => room.engine.awaiting.kind === "SPLASH_DRAW");
    a.send(WaterFightMsg.RESOLVE, { kind: "DRAW_SPLASH" });
    await until(() => room.engine.awaiting.attack?.perTargetReactions === true);

    let saved: any = null;
    a.onMessage(ServerMsg.SAVE_DATA, (blob: unknown) => (saved = blob));
    a.send(LobbyMsg.SAVE, {});
    await until(() => saved !== null);
    const parsed = parseSave(saved);
    assert.ok(parsed, "the mid-AoE blob validates");
    assert.strictEqual(parsed!.engine.awaiting.attack!.perTargetReactions, true, "the per-target flag survives");
    assert.ok(Array.isArray(parsed!.engine.awaiting.attack!.redirectedSeats), "redirectedSeats restored");

    const room2 = (await colyseus.createRoom(WATER_FIGHT, {})) as unknown as WaterFightRoom;
    const c0 = await colyseus.connectTo(room2, { nickname: "Player0" });
    await colyseus.connectTo(room2, { nickname: "Player1" });
    await colyseus.connectTo(room2, { nickname: "Player2" });
    c0.send(LobbyMsg.LOAD, saved);
    await until(() => room2.state.loadedSave !== "");
    c0.send(LobbyMsg.START, {});
    await until(() => room2.state.phase === Phase.PLAYING);
    assert.strictEqual(room2.engine.awaiting.attack!.perTargetReactions, true, "resumed the multi-target attack");
    assert.strictEqual(room2.engine.awaiting.attack!.targets.length, 2, "both splash targets preserved");
  });

  it("the attacker's DRAW_SPLASH flips over the wire; a bystander's is ignored", async () => {
    // Regression guard for the sanitizer: a human's DRAW_SPLASH must reach the engine
    // (bots bypass the sanitizer, so a bot-only test would miss a dropped human payload).
    const { room, clients } = await startedGame(71);
    const a = clients[0]!;
    const b = clients[1]!;
    room.engine.players[0]!.hand = [{ id: 10000, kind: "balloon" }] as never;
    room.engine.players[1]!.hand = [] as never;
    room.engine.splashPile = ["hit", "hit"];
    a.send(WaterFightMsg.MOVE, { kind: "THROW", target: 1 });
    await until(() => room.engine.awaiting.kind === "SPLASH_DRAW" && room.engine.awaiting.seats[0] === 0);
    const seqBefore = room.state.lastSplashSeq;

    // A non-attacker's draw is ignored (not the awaited seat).
    b.send(WaterFightMsg.RESOLVE, { kind: "DRAW_SPLASH" });
    await sleep(120);
    assert.strictEqual(room.engine.awaiting.kind, "SPLASH_DRAW", "bystander draw did nothing");

    // The attacker's draw flips: the synced reveal advances and the ladder opens.
    a.send(WaterFightMsg.RESOLVE, { kind: "DRAW_SPLASH" });
    await until(() => room.engine.awaiting.kind === "DEFEND");
    assert.strictEqual(room.state.lastSplashVerdict, "hit", "verdict synced to clients");
    assert.ok(room.state.lastSplashSeq > seqBefore, "lastSplashSeq advanced");
    await until(() => (a.state as unknown as { lastSplashSeq: number }).lastSplashSeq > seqBefore);
  });

  it("saves and resumes a mid-SPLASH_DRAW state", async () => {
    const { room, clients } = await startedGame(73);
    const a = clients[0]!;
    // Real balloon from the deck (conservation) + forced Hit so the blob passes the validator.
    const idx = room.engine.mainDeck.findIndex((c) => c.kind === "balloon");
    room.engine.players[0]!.hand.push(room.engine.mainDeck.splice(idx, 1)[0]!);
    room.engine.splashPile[room.engine.splashPile.length - 1] = "hit";
    a.send(WaterFightMsg.MOVE, { kind: "THROW", target: 1 });
    await until(() => room.engine.awaiting.kind === "SPLASH_DRAW" && room.engine.awaiting.seats[0] === 0);

    let saved: any = null;
    a.onMessage(ServerMsg.SAVE_DATA, (blob: unknown) => (saved = blob));
    a.send(LobbyMsg.SAVE, {});
    await until(() => saved !== null);
    const parsed = parseSave(saved);
    assert.ok(parsed, "the mid-SPLASH_DRAW blob validates");
    assert.strictEqual(parsed!.engine.awaiting.kind, "SPLASH_DRAW");
    assert.ok(parsed!.engine.pendingFlip, "the committed throw (pendingFlip) is preserved");
    assert.strictEqual(parsed!.engine.pendingFlip!.attacker, 0);

    const room2 = (await colyseus.createRoom(WATER_FIGHT, {})) as unknown as WaterFightRoom;
    const c0 = await colyseus.connectTo(room2, { nickname: "Player0" });
    await colyseus.connectTo(room2, { nickname: "Player1" });
    c0.send(LobbyMsg.LOAD, saved);
    await until(() => room2.state.loadedSave !== "");
    c0.send(LobbyMsg.START, {});
    await until(() => room2.state.phase === Phase.PLAYING);
    assert.strictEqual(room2.engine.awaiting.kind, "SPLASH_DRAW", "resumed awaiting the draw");
    // And the resumed draw still works.
    c0.send(WaterFightMsg.RESOLVE, { kind: "DRAW_SPLASH" });
    await until(() => room2.engine.awaiting.kind === "DEFEND");
  });

  it("rematch clears the stale Splash reveal (seq resets so the next game's draws show)", async () => {
    const { room, clients } = await startedGame(3);
    const [a, b] = clients;
    // Quick finish: a flipped Hit soaks seat 1, which populates lastSplash*.
    room.engine.players[1]!.lives = 1;
    room.engine.players[0]!.hand = [{ id: 10000, kind: "balloon" }] as never;
    room.engine.players[1]!.hand = [] as never;
    room.engine.splashPile = ["hit", "hit"];
    a!.send(WaterFightMsg.MOVE, { kind: "THROW", target: 1 });
    await until(() => room.engine.awaiting.kind === "SPLASH_DRAW");
    a!.send(WaterFightMsg.RESOLVE, { kind: "DRAW_SPLASH" });
    await until(() => room.engine.awaiting.kind === "DEFEND");
    b!.send(WaterFightMsg.RESOLVE, { kind: "DEFEND", defense: "pass" });
    await until(() => room.state.phase === Phase.ENDED);
    assert.ok(room.state.lastSplashSeq > 0, "a flip happened in game 1");

    a!.send(LobbyMsg.REMATCH, {});
    b!.send(LobbyMsg.REMATCH, {});
    await until(() => room.state.phase === Phase.PLAYING);
    assert.strictEqual(room.state.lastSplashSeq, 0, "seq reset — the new game's first flip (seq 1) will be > what a fresh client seeds");
    assert.strictEqual(room.state.lastSplashVerdict, "", "no stale HIT/MISS verdict carried into the rematch");
  });

  it("an attacker who disconnects at SPLASH_DRAW is auto-drawn (the table never stalls)", async function () {
    this.timeout(8000);
    const { room, clients } = await startedGame(81);
    const a = clients[0]!;
    room.engine.players[0]!.hand = [{ id: 10000, kind: "balloon" }] as never;
    room.engine.players[1]!.hand = [] as never;
    room.engine.splashPile = ["hit", "hit"];
    a.send(WaterFightMsg.MOVE, { kind: "THROW", target: 1 });
    await until(() => room.engine.awaiting.kind === "SPLASH_DRAW" && room.engine.awaiting.seats[0] === 0);
    await a.leave(false); // attacker drops mid-draw -> becomes an auto seat
    await until(() => room.engine.awaiting.kind === "DEFEND", 5000); // applyGentle auto-drew -> ladder opened
    assert.strictEqual(room.engine.awaiting.seats[0], 1);
  });

  it("the synced log shows player nicknames, not 'seat N'", async () => {
    const { room, clients } = await startedGame(91);
    const a = clients[0]!;
    room.engine.players[0]!.hand = [{ id: 10000, kind: "balloon" }] as never;
    room.engine.players[1]!.hand = [] as never;
    room.engine.splashPile = ["hit", "hit"];
    a.send(WaterFightMsg.MOVE, { kind: "THROW", target: 1 });
    await until(() => room.engine.awaiting.kind === "SPLASH_DRAW");
    a.send(WaterFightMsg.RESOLVE, { kind: "DRAW_SPLASH" });
    await until(() => [...room.state.log].some((l) => l.includes("throws at")));
    const line = [...room.state.log].find((l) => l.includes("throws at"))!;
    assert.ok(line.includes("Player0") && line.includes("Player1"), `nicknames in log: ${line}`);
    assert.ok(!line.includes("seat "), `no raw seat index: ${line}`);
  });

  it("a game against a bot reaches a winner (the bot self-advances)", async function () {
    this.timeout(60000);
    const room = (await colyseus.createRoom(WATER_FIGHT, { seed: 88 })) as unknown as WaterFightRoom;
    const host = await colyseus.connectTo(room, { nickname: "Human" });
    host.send(LobbyMsg.ADD_BOT, {});
    await until(() => room.state.players.size === 2);
    room.botDelayMs = 5;
    room.state.turnSeconds = 0;
    room.state.reactionSeconds = 0;
    host.send(LobbyMsg.START, {});
    await until(() => room.state.phase === Phase.PLAYING);

    const policy = new RandomPolicy(3);
    let guard = 0;
    while (room.state.phase === Phase.PLAYING && ++guard < 6000) {
      const prev = room.engine;
      const seat = prev.awaiting.seats[0] ?? -1;
      if (seat >= 0 && room.seatOrder[seat] === host.sessionId) {
        // drive only the human's seat; the bot seat self-advances via the room timer
        if (prev.awaiting.kind === "MOVE") host.send(WaterFightMsg.MOVE, policy.move(prev));
        else host.send(WaterFightMsg.RESOLVE, policy.resolve(prev));
      }
      await until(() => room.engine !== prev || room.state.phase !== Phase.PLAYING, 4000).catch(() => {});
    }
    assert.strictEqual(room.state.phase, Phase.ENDED, "the game reached a winner with the bot self-driving");
    assert.ok(
      room.state.endReason.startsWith(EndReason.WIN_PREFIX) || room.state.endReason === EndReason.DRAW,
      `unexpected endReason ${room.state.endReason}`,
    );
  });

  it("forwards a Goggles peek to the peeker only", async () => {
    const { room, clients } = await startedGame(61, 2, (r) => {
      r.state.eventDensity = 0;
    });
    const [a, b] = clients;
    let aReveal: any = null;
    let bReveal: any = null;
    a!.onMessage(WaterFightMsg.REVEAL, (p: unknown) => (aReveal = p));
    b!.onMessage(WaterFightMsg.REVEAL, (p: unknown) => (bReveal = p));
    room.engine.players[0]!.hand.push({ id: 10001, kind: "goggles" });
    a!.send(WaterFightMsg.MOVE, { kind: "PLAY_SUPPORT", support: "goggles" });
    await until(() => aReveal !== null);
    assert.strictEqual(aReveal.kind, "deck-top");
    assert.strictEqual(aReveal.cards.length, 3, "the peeker sees the top 3");
    await sleep(80);
    assert.strictEqual(bReveal, null, "the opponent never receives the peek");
  });

  it("forwards a Sneaky Peek (opponent's hand) to the peeker only", async () => {
    const { room, clients } = await startedGame(63, 2, (r) => {
      r.state.eventDensity = 0;
    });
    const [a, b] = clients;
    let aReveal: any = null;
    let bReveal: any = null;
    a!.onMessage(WaterFightMsg.REVEAL, (p: unknown) => (aReveal = p));
    b!.onMessage(WaterFightMsg.REVEAL, (p: unknown) => (bReveal = p));
    room.engine.players[0]!.hand.push({ id: 10001, kind: "sneakypeek" });
    room.engine.players[1]!.hand = [{ id: 20001, kind: "miss" }];
    a!.send(WaterFightMsg.MOVE, { kind: "PLAY_SUPPORT", support: "sneakypeek", target: 1 });
    await until(() => aReveal !== null);
    assert.strictEqual(aReveal.kind, "hand");
    assert.strictEqual(aReveal.ofSeat, 1, "the peeker sees whose hand it is");
    await sleep(80);
    assert.strictEqual(bReveal, null, "the peeked opponent receives nothing");
  });

  it("auto-advances a bot seat without any client input", async () => {
    const room = (await colyseus.createRoom(WATER_FIGHT, { seed: 21 })) as unknown as WaterFightRoom;
    const host = await colyseus.connectTo(room, { nickname: "Human" });
    host.send(LobbyMsg.ADD_BOT, {});
    await until(() => room.state.players.size === 2);
    room.state.turnSeconds = 0;
    room.state.reactionSeconds = 0;
    host.send(LobbyMsg.START, {});
    await until(() => room.state.phase === Phase.PLAYING);
    // The human ends their turn; the bot seat must then act on its own.
    const beforeBot = room.engine;
    host.send(WaterFightMsg.MOVE, { kind: "END_TURN" });
    await until(() => room.engine !== beforeBot && room.engine.turnSeat === 0, 8000);
    assert.ok(room.engine.turnCount >= 1, "the bot took at least one turn unattended");
  });
});
