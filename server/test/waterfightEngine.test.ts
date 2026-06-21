// Water Fight engine — Phase A test suite (pure engine, no Colyseus).
// Mirrors splendorEngine.test.ts: rules unit tests + a fuzz suite that asserts
// every structural invariant after every reduce.
import assert from "node:assert/strict";
import { WaterFightEngine as WF } from "@backbone/shared";

const {
  createGame,
  applyMove,
  applyResolution,
  legalMoves,
  isGameOver,
  assertInvariants,
  drawMainCard,
  flipSplash,
  RandomPolicy,
  GreedyPolicy,
  MAIN_DECK_SIZE,
} = WF;
type GameState = WF.GameState;
type CardKind = WF.CardKind;
type SplashCard = WF.SplashCard;
type Policy = WF.Policy;

// --- helpers (combat unit tests inject hands + force the splash; they do not
//     assert full card conservation, like Splendor's injected-card tests) ---
function setHand(g: GameState, seat: number, kinds: CardKind[]): void {
  g.players[seat]!.hand = kinds.map((kind, i) => ({ id: 10000 + seat * 100 + i, kind }));
}
/** Force the NEXT splash flip (flipSplash pops the end of the array). */
function forceSplash(g: GameState, verdict: SplashCard): void {
  if (g.splashPile.length === 0) g.splashPile.push(verdict);
  else g.splashPile[g.splashPile.length - 1] = verdict;
}

describe("water fight engine: setup", () => {
  it("createGame is deterministic for a given seed", () => {
    assert.deepEqual(createGame(3, 12345), createGame(3, 12345));
  });

  it("setup: lives, splash pile, opening hand, decks", () => {
    const g = createGame(4, 7);
    assert.equal(g.players.length, 4);
    for (const p of g.players) assert.equal(p.lives, 3);
    assert.equal(g.options.splashHit + g.options.splashMiss, 20);
    assert.equal(g.splashPile.length, 20);
    assert.equal(g.players[0]!.hand.length, 2, "seat 0 drew its opening hand");
    assert.equal(g.players[1]!.hand.length, 0, "later seats draw on their turn");
    assert.equal(g.turnSeat, 0);
    assert.equal(g.awaiting.kind, "MOVE");
    assertInvariants(g);
  });

  it("rejects bad player counts and an empty splash pile", () => {
    assert.throws(() => createGame(1, 1));
    assert.throws(() => createGame(6, 1));
    assert.throws(() => createGame(2, 1, { splashHit: 0, splashMiss: 0 }));
  });
});

describe("water fight engine: combat", () => {
  it("splash MISS ends the attack with no damage; turn advances", () => {
    const g = createGame(2, 5);
    setHand(g, 0, ["balloon"]);
    forceSplash(g, "miss");
    const r = applyMove(g, { kind: "THROW", target: 1 });
    assert.equal(r.state.players[1]!.lives, 3, "no damage on a miss");
    assert.equal(r.awaiting.kind, "MOVE", "no ladder — turn advanced");
    assert.equal(r.state.turnSeat, 1);
  });

  it("splash HIT, defender passes -> lands for 1", () => {
    const g = createGame(2, 5);
    setHand(g, 0, ["balloon"]);
    setHand(g, 1, []);
    forceSplash(g, "hit");
    let r = applyMove(g, { kind: "THROW", target: 1 });
    assert.equal(r.awaiting.kind, "DEFEND");
    assert.equal(r.awaiting.seats[0], 1);
    r = applyResolution(r.state, { kind: "DEFEND", defense: "pass" });
    assert.equal(r.state.players[1]!.lives, 2);
  });

  it("HIT, Miss, attacker passes -> the block holds (miss)", () => {
    const g = createGame(2, 5);
    setHand(g, 0, ["balloon"]);
    setHand(g, 1, ["miss"]);
    forceSplash(g, "hit");
    let r = applyMove(g, { kind: "THROW", target: 1 });
    r = applyResolution(r.state, { kind: "DEFEND", defense: "miss" });
    assert.equal(r.awaiting.kind, "ATTACKER_RESPOND");
    assert.equal(r.awaiting.seats[0], 0);
    r = applyResolution(r.state, { kind: "ATTACKER_RESPOND", respond: "pass" });
    assert.equal(r.state.players[1]!.lives, 3, "Miss stood -> no damage");
  });

  it("HIT, Miss, Hit cancels it, defender passes -> lands (the ladder alternates)", () => {
    const g = createGame(2, 5);
    setHand(g, 0, ["balloon", "hit"]);
    setHand(g, 1, ["miss"]);
    forceSplash(g, "hit");
    let r = applyMove(g, { kind: "THROW", target: 1 });
    r = applyResolution(r.state, { kind: "DEFEND", defense: "miss" });
    r = applyResolution(r.state, { kind: "ATTACKER_RESPOND", respond: "hit" });
    assert.equal(r.awaiting.kind, "DEFEND", "Hit cancelled the Miss -> back to the defender");
    r = applyResolution(r.state, { kind: "DEFEND", defense: "pass" });
    assert.equal(r.state.players[1]!.lives, 2);
  });

  it("Umbrella is an uncancelable full block on a basic throw (R1)", () => {
    const g = createGame(2, 5);
    setHand(g, 0, ["balloon", "hit"]); // attacker holds a Hit but cannot use it
    setHand(g, 1, ["umbrella"]);
    forceSplash(g, "hit");
    let r = applyMove(g, { kind: "THROW", target: 1 });
    r = applyResolution(r.state, { kind: "DEFEND", defense: "umbrella" });
    assert.equal(r.state.players[1]!.lives, 3, "Umbrella blocked, no ATTACKER_RESPOND offered");
    assert.equal(r.state.awaiting.kind, "MOVE", "attack resolved, turn advanced");
  });

  it("Wild-as-miss and Wild-as-hit are unblockable (R4)", () => {
    // Wild as miss
    let g = createGame(2, 5);
    setHand(g, 0, ["balloon", "hit"]);
    setHand(g, 1, ["wild"]);
    forceSplash(g, "hit");
    let r = applyMove(g, { kind: "THROW", target: 1 });
    r = applyResolution(r.state, { kind: "DEFEND", defense: "wild_miss" });
    assert.equal(r.state.players[1]!.lives, 3, "Wild-as-miss blocked");

    // Wild as hit
    g = createGame(2, 5);
    setHand(g, 0, ["balloon", "wild"]);
    setHand(g, 1, ["miss"]);
    forceSplash(g, "hit");
    r = applyMove(g, { kind: "THROW", target: 1 });
    r = applyResolution(r.state, { kind: "DEFEND", defense: "miss" });
    r = applyResolution(r.state, { kind: "ATTACKER_RESPOND", respond: "wild_hit" });
    assert.equal(r.state.players[1]!.lives, 2, "Wild-as-hit drove it through");
  });

  it("soaking the last opponent ends the game (last-standing)", () => {
    const g = createGame(2, 9);
    g.players[1]!.lives = 1;
    setHand(g, 0, ["balloon"]);
    setHand(g, 1, []);
    forceSplash(g, "hit");
    let r = applyMove(g, { kind: "THROW", target: 1 });
    r = applyResolution(r.state, { kind: "DEFEND", defense: "pass" });
    assert.equal(r.state.over, true);
    assert.equal(r.state.winner, 0);
    assert.equal(r.state.endReason, "last-standing");
    assert.equal(r.state.players[1]!.out, true);
  });
});

describe("water fight engine: illegal input", () => {
  it("rejects targeting yourself, throwing without a balloon, and illegal blocks", () => {
    const g = createGame(2, 1);
    assert.throws(() => applyMove(g, { kind: "THROW", target: 0 }), /yourself/);
    setHand(g, 0, ["miss", "hit"]);
    assert.throws(() => applyMove(g, { kind: "THROW", target: 1 }), /no Water Balloon/);

    // open a ladder, then try to Miss with an empty hand
    setHand(g, 0, ["balloon"]);
    setHand(g, 1, []);
    forceSplash(g, "hit");
    const r = applyMove(g, { kind: "THROW", target: 1 });
    assert.throws(() => applyResolution(r.state, { kind: "DEFEND", defense: "miss" }), /illegal resolution/);
  });

  it("END_TURN is always a legal move; THROW needs a balloon", () => {
    const g = createGame(2, 1);
    setHand(g, 0, ["treasure"]);
    const moves = legalMoves(g);
    assert.ok(moves.some((m) => m.kind === "END_TURN"));
    assert.ok(!moves.some((m) => m.kind === "THROW"), "no balloon -> no throw");
  });
});

describe("water fight engine: decks", () => {
  it("drawMainCard reshuffles the discard when the deck is empty", () => {
    const g = createGame(2, 1);
    g.mainDeck = [];
    g.mainDiscard = [{ id: 9999, kind: "balloon" }];
    const drawn = drawMainCard(g);
    assert.equal(drawn?.id, 9999);
    assert.equal(g.mainDeck.length, 0);
    assert.equal(g.mainDiscard.length, 0);
  });

  it("flipSplash reshuffles its own discard when the pile is empty", () => {
    const g = createGame(2, 1);
    g.splashPile = [];
    g.splashDiscard = ["hit"];
    assert.equal(flipSplash(g), "hit");
  });
});

describe("water fight engine: fuzz", () => {
  function playGame(pc: number, seed: number, policy: Policy, turnCap: number): GameState {
    let g = createGame(pc, seed, { turnCap });
    assertInvariants(g);
    let guard = 0;
    while (!isGameOver(g)) {
      // Each attack's ladder is bounded by the players' hand cards; a generous
      // guard catches a real non-termination bug without false positives.
      if (++guard > turnCap * 200) throw new Error("engine failed to terminate");
      g = g.awaiting.kind === "MOVE" ? applyMove(g, policy.move(g)).state : applyResolution(g, policy.resolve(g)).state;
      assertInvariants(g);
    }
    return g;
  }

  it("random playouts: invariants hold every step; always terminate", function () {
    this.timeout(120000);
    const N = 30;
    for (const pc of [2, 3, 4, 5]) {
      for (let k = 0; k < N; k++) {
        const g = playGame(pc, 1000 * pc + k, new RandomPolicy(k + 1), 1500);
        assert.ok(["last-standing", "cap"].includes(g.endReason as string), `bad reason ${g.endReason}`);
        if (g.endReason === "last-standing") {
          assert.notEqual(g.winner, null);
          assert.equal(g.players[g.winner!]!.out, false, "winner is alive");
          assert.equal(g.players.filter((p) => !p.out).length, 1, "exactly one survivor");
        }
      }
    }
  });

  it("greedy playouts converge to a last-standing winner", function () {
    this.timeout(120000);
    const N = 30;
    for (const pc of [2, 3, 4, 5]) {
      let lastStanding = 0;
      for (let k = 0; k < N; k++) {
        const g = playGame(pc, 50000 * pc + k, new GreedyPolicy(k + 1), 1500);
        if (g.endReason === "last-standing") lastStanding++;
      }
      assert.ok(lastStanding >= N * 0.8, `${pc}p: only ${lastStanding}/${N} greedy games ended by soaking`);
    }
  });
});
