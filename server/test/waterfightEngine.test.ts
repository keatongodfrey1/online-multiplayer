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
/** Move `n` cards of a kind from the deck into a seat's hand (preserves conservation). */
function moveFromDeck(g: GameState, seat: number, kind: CardKind, n: number): void {
  for (let i = 0; i < n; i++) {
    const idx = g.mainDeck.findIndex((c) => c.kind === kind);
    g.players[seat]!.hand.push(g.mainDeck.splice(idx, 1)[0]!);
  }
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

describe("water fight engine: big attacks (auto-connect)", () => {
  it("Mega auto-connects (no Splash flip) and 1 Miss is not enough to stop it", () => {
    const g = createGame(2, 5);
    setHand(g, 0, ["mega"]);
    setHand(g, 1, ["miss"]);
    const splashBefore = g.splashPile.length;
    let r = applyMove(g, { kind: "PLAY_BIG", big: "mega", target: 1 });
    assert.equal(r.state.splashPile.length, splashBefore, "big attacks never flip the Splash Pile");
    assert.equal(r.awaiting.kind, "DEFEND");
    r = applyResolution(r.state, { kind: "DEFEND", defense: "miss" });
    assert.equal(r.awaiting.kind, "DEFEND", "Mega needs 2 blocks — still defending");
    r = applyResolution(r.state, { kind: "DEFEND", defense: "pass" });
    assert.equal(r.state.players[1]!.lives, 2, "under-blocked -> lands");
  });

  it("Mega: two Miss stop it (attacker passes -> miss)", () => {
    const g = createGame(2, 5);
    setHand(g, 0, ["mega"]);
    setHand(g, 1, ["miss", "miss"]);
    let r = applyMove(g, { kind: "PLAY_BIG", big: "mega", target: 1 });
    r = applyResolution(r.state, { kind: "DEFEND", defense: "miss" });
    r = applyResolution(r.state, { kind: "DEFEND", defense: "miss" });
    assert.equal(r.awaiting.kind, "ATTACKER_RESPOND", "2 Miss = fully blocked");
    r = applyResolution(r.state, { kind: "ATTACKER_RESPOND", respond: "pass" });
    assert.equal(r.state.players[1]!.lives, 3);
  });

  it("R1: Umbrella vs Mega is Hit-cancelable -> one Hit forces a full re-block", () => {
    const g = createGame(2, 5);
    setHand(g, 0, ["mega", "hit"]);
    setHand(g, 1, ["umbrella"]);
    let r = applyMove(g, { kind: "PLAY_BIG", big: "mega", target: 1 });
    r = applyResolution(r.state, { kind: "DEFEND", defense: "umbrella" });
    assert.equal(r.awaiting.kind, "ATTACKER_RESPOND", "vs Mega the Umbrella can be Hit");
    r = applyResolution(r.state, { kind: "ATTACKER_RESPOND", respond: "hit" });
    assert.equal(r.awaiting.kind, "DEFEND", "umbrella cancelled -> defender must re-block to full");
    r = applyResolution(r.state, { kind: "DEFEND", defense: "pass" });
    assert.equal(r.state.players[1]!.lives, 2, "no re-block available -> lands");
  });

  it("Giant deals 2 damage", () => {
    const g = createGame(2, 5);
    setHand(g, 0, ["giant"]);
    setHand(g, 1, []);
    let r = applyMove(g, { kind: "PLAY_BIG", big: "giant", target: 1 });
    r = applyResolution(r.state, { kind: "DEFEND", defense: "pass" });
    assert.equal(r.state.players[1]!.lives, 1);
  });

  it("Golden draws 2 whether it hits or misses; conservation holds", () => {
    const g = createGame(3, 5); // 3p so soaking 1 does not end the game
    g.players[0]!.hand.push({ id: 10000, kind: "golden" }); // keep seat 0's opening hand
    setHand(g, 1, ["umbrella"]); // seat 1's opening hand was empty
    const before = g.players[0]!.hand.length;
    let r = applyMove(g, { kind: "PLAY_BIG", big: "golden", target: 1 });
    r = applyResolution(r.state, { kind: "DEFEND", defense: "umbrella" });
    assert.equal(r.state.players[1]!.lives, 3, "Umbrella vs Golden (blockNumber 1) is uncancelable");
    assert.equal(r.state.players[0]!.hand.length, before - 1 + 2, "spent Golden (-1), drew 2");
    assertInvariants(r.state);
  });
});

describe("water fight engine: turn structure (Support + hand limit)", () => {
  it("First Aid heals, capped at starting lives (E8); Support does not end the turn", () => {
    const g = createGame(2, 5);
    g.players[0]!.lives = 1;
    g.players[0]!.hand.push({ id: 10001, kind: "firstaid" });
    const r = applyMove(g, { kind: "PLAY_SUPPORT", support: "firstaid" });
    assert.equal(r.state.players[0]!.lives, 2);
    assert.equal(r.state.supportUsed, true);
    assert.equal(r.awaiting.kind, "MOVE", "still the same player's turn");

    const g2 = createGame(2, 5); // full lives -> heal is a no-op (cap)
    g2.players[0]!.hand.push({ id: 10001, kind: "firstaid" });
    const r2 = applyMove(g2, { kind: "PLAY_SUPPORT", support: "firstaid" });
    assert.equal(r2.state.players[0]!.lives, 3, "cannot exceed starting lives");
  });

  it("Waterproof Backpack draws 2", () => {
    const g = createGame(2, 5);
    g.players[0]!.hand.push({ id: 10002, kind: "backpack" });
    const before = g.players[0]!.hand.length;
    const r = applyMove(g, { kind: "PLAY_SUPPORT", support: "backpack" });
    assert.equal(r.state.players[0]!.hand.length, before - 1 + 2);
  });

  it("only one Support per turn", () => {
    const g = createGame(2, 5);
    g.players[0]!.hand.push({ id: 10001, kind: "firstaid" }, { id: 10002, kind: "backpack" });
    const r = applyMove(g, { kind: "PLAY_SUPPORT", support: "firstaid" });
    assert.throws(() => applyMove(r.state, { kind: "PLAY_SUPPORT", support: "backpack" }), /already used a Support/);
  });

  it("hand limit: end of turn over the limit forces a discard, then advances", () => {
    const g = createGame(2, 5, { handLimit: 3 });
    setHand(g, 0, ["miss", "hit", "treasure", "miss", "hit"]);
    let r = applyMove(g, { kind: "END_TURN" });
    assert.equal(r.awaiting.kind, "DISCARD");
    assert.equal(r.awaiting.seats[0], 0);
    const ids = r.state.players[0]!.hand.slice(0, 2).map((c) => c.id);
    assert.throws(() => applyResolution(r.state, { kind: "DISCARD", cardIds: [ids[0]!] }), /exactly 2/);
    r = applyResolution(r.state, { kind: "DISCARD", cardIds: ids });
    assert.equal(r.state.players[0]!.hand.length, 3);
    assert.equal(r.state.turnSeat, 1, "turn advanced after the discard");
  });
});

describe("water fight engine: shop (D4)", () => {
  it("builds + shuffles the 3 stacks to the right sizes", () => {
    const g = createGame(2, 5);
    assert.equal(g.stacks.defense.length, 16);
    assert.equal(g.stacks.mischief.length, 19);
    assert.equal(g.stacks.attack.length, 18, "Attack Arsenal has Soaker x3");
    assertInvariants(g);
  });

  it("sell Treasure for coins and buy a card into hand; SHOP ends the turn", () => {
    const g = createGame(2, 5, { shopCost: 4 });
    moveFromDeck(g, 0, "treasure", 2); // 2 Treasure = 4 coins
    const handBefore = g.players[0]!.hand.length;
    const r = applyMove(g, { kind: "SHOP", sell: { balloons: 0, treasures: 2, wild: 0 }, buy: ["defense"] });
    assert.equal(r.state.players[0]!.hand.length, handBefore - 2 + 1, "sold 2, bought 1");
    assert.equal(r.state.stacks.defense.length, 15, "stack lost a card");
    assert.equal(r.state.turnSeat, 1, "SHOP is a Main Action — turn ends");
    assertInvariants(r.state);
  });

  it("rejects buying without enough coins", () => {
    const g = createGame(2, 5, { shopCost: 4 });
    assert.throws(
      () => applyMove(g, { kind: "SHOP", sell: { balloons: 0, treasures: 0, wild: 0 }, buy: ["defense"] }),
      /not enough coins/,
    );
    moveFromDeck(g, 0, "treasure", 1); // 2 coins, still short of 4
    assert.throws(
      () => applyMove(g, { kind: "SHOP", sell: { balloons: 0, treasures: 1, wild: 0 }, buy: ["attack"] }),
      /not enough coins/,
    );
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
