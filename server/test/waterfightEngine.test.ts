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
  legalResolutions,
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
/** A pristine game with Events OFF — keeps the injected-hand unit tests
 *  deterministic (a seeded Event resolving on the opening draw would perturb
 *  lives/hands). The fuzz + the dedicated Events block opt back into Events. */
function game(pc: number, seed: number, opts?: Partial<WF.GameOptions>): GameState {
  return createGame(pc, seed, { eventDensity: 0, ...(opts ?? {}) });
}
function setHand(g: GameState, seat: number, kinds: CardKind[]): void {
  // Return any displaced REAL cards (e.g. the opening cushion) to the deck so
  // conservation still holds for the few tests that assert it after setHand.
  for (const c of g.players[seat]!.hand) {
    if (c.id >= 1 && c.id <= g.mainIdMax) g.mainDeck.push(c);
  }
  g.players[seat]!.hand = kinds.map((kind, i) => ({ id: 10000 + seat * 100 + i, kind }));
}
/** Force the NEXT splash flip (flipSplash pops the end of the array). */
function forceSplash(g: GameState, verdict: SplashCard): void {
  if (g.splashPile.length === 0) g.splashPile.push(verdict);
  else g.splashPile[g.splashPile.length - 1] = verdict;
}
/** Put an Event card on top of the main deck (drawn next). The next seat's
 *  opening draw resolves it. */
function injectTopEvent(g: GameState, event: WF.EventKind): void {
  g.mainDeck.push({ id: 3000, kind: "event", event });
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
    assert.deepEqual(game(3, 12345), game(3, 12345));
  });

  it("setup: lives, splash pile, opening hand, decks", () => {
    const g = game(4, 7);
    assert.equal(g.players.length, 4);
    for (const p of g.players) assert.equal(p.lives, 3);
    assert.equal(g.options.splashHit + g.options.splashMiss, 20);
    assert.equal(g.splashPile.length, 20);
    assert.equal(g.players[0]!.hand.length, 2, "the first player draws its normal 2");
    assert.equal(g.players[1]!.hand.length, 1, "later seats start with a 1-card cushion (#6)");
    assert.equal(g.players[3]!.hand.length, 1, "every non-first seat gets the cushion");
    assert.ok(g.players[1]!.hand.every((c) => c.kind !== "event"), "the cushion is never an Event");
    assert.equal(g.turnSeat, 0);
    assert.equal(g.awaiting.kind, "MOVE");
    assertInvariants(g);
  });

  it("rejects bad player counts and an empty splash pile", () => {
    assert.throws(() => game(1, 1));
    assert.throws(() => game(6, 1));
    assert.throws(() => game(2, 1, { splashHit: 0, splashMiss: 0 }));
  });
});

describe("water fight engine: combat", () => {
  it("splash MISS ends the attack with no damage; turn advances", () => {
    const g = game(2, 5);
    setHand(g, 0, ["balloon"]);
    forceSplash(g, "miss");
    const r = applyMove(g, { kind: "THROW", target: 1 });
    assert.equal(r.state.players[1]!.lives, 3, "no damage on a miss");
    assert.equal(r.awaiting.kind, "MOVE", "no ladder — turn advanced");
    assert.equal(r.state.turnSeat, 1);
  });

  it("splash HIT, defender passes -> lands for 1", () => {
    const g = game(2, 5);
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
    const g = game(2, 5);
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
    const g = game(2, 5);
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
    const g = game(2, 5);
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
    let g = game(2, 5);
    setHand(g, 0, ["balloon", "hit"]);
    setHand(g, 1, ["wild"]);
    forceSplash(g, "hit");
    let r = applyMove(g, { kind: "THROW", target: 1 });
    r = applyResolution(r.state, { kind: "DEFEND", defense: "wild_miss" });
    assert.equal(r.state.players[1]!.lives, 3, "Wild-as-miss blocked");

    // Wild as hit
    g = game(2, 5);
    setHand(g, 0, ["balloon", "wild"]);
    setHand(g, 1, ["miss"]);
    forceSplash(g, "hit");
    r = applyMove(g, { kind: "THROW", target: 1 });
    r = applyResolution(r.state, { kind: "DEFEND", defense: "miss" });
    r = applyResolution(r.state, { kind: "ATTACKER_RESPOND", respond: "wild_hit" });
    assert.equal(r.state.players[1]!.lives, 2, "Wild-as-hit drove it through");
  });

  it("soaking the last opponent ends the game (last-standing)", () => {
    const g = game(2, 9);
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
    const g = game(2, 5);
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
    const g = game(2, 5);
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
    const g = game(2, 5);
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
    const g = game(2, 5);
    setHand(g, 0, ["giant"]);
    setHand(g, 1, []);
    let r = applyMove(g, { kind: "PLAY_BIG", big: "giant", target: 1 });
    r = applyResolution(r.state, { kind: "DEFEND", defense: "pass" });
    assert.equal(r.state.players[1]!.lives, 1);
  });

  it("Golden draws 2 whether it hits or misses; conservation holds", () => {
    const g = game(3, 5); // 3p so soaking 1 does not end the game
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
    const g = game(2, 5);
    g.players[0]!.lives = 1;
    g.players[0]!.hand.push({ id: 10001, kind: "firstaid" });
    const r = applyMove(g, { kind: "PLAY_SUPPORT", support: "firstaid" });
    assert.equal(r.state.players[0]!.lives, 2);
    assert.equal(r.state.supportUsed, true);
    assert.equal(r.awaiting.kind, "MOVE", "still the same player's turn");

    const g2 = game(2, 5); // full lives -> heal is a no-op (cap)
    g2.players[0]!.hand.push({ id: 10001, kind: "firstaid" });
    const r2 = applyMove(g2, { kind: "PLAY_SUPPORT", support: "firstaid" });
    assert.equal(r2.state.players[0]!.lives, 3, "cannot exceed starting lives");
  });

  it("Waterproof Backpack draws 2", () => {
    const g = game(2, 5);
    g.players[0]!.hand.push({ id: 10002, kind: "backpack" });
    const before = g.players[0]!.hand.length;
    const r = applyMove(g, { kind: "PLAY_SUPPORT", support: "backpack" });
    assert.equal(r.state.players[0]!.hand.length, before - 1 + 2);
  });

  it("only one Support per turn", () => {
    const g = game(2, 5);
    g.players[0]!.hand.push({ id: 10001, kind: "firstaid" }, { id: 10002, kind: "backpack" });
    const r = applyMove(g, { kind: "PLAY_SUPPORT", support: "firstaid" });
    assert.throws(() => applyMove(r.state, { kind: "PLAY_SUPPORT", support: "backpack" }), /already used a Support/);
  });

  it("hand limit: end of turn over the limit forces a discard, then advances", () => {
    const g = game(2, 5, { handLimit: 3 });
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
    const g = game(2, 5);
    assert.equal(g.stacks.defense.length, 16);
    assert.equal(g.stacks.mischief.length, 19);
    assert.equal(g.stacks.attack.length, 18, "Attack Arsenal has Soaker x3");
    assertInvariants(g);
  });

  it("sell Treasure for coins and buy a card into hand; SHOP ends the turn", () => {
    const g = game(2, 5, { shopCost: 4 });
    moveFromDeck(g, 0, "treasure", 2); // 2 Treasure = 4 coins
    const handBefore = g.players[0]!.hand.length;
    const r = applyMove(g, { kind: "SHOP", sell: { balloons: 0, treasures: 2, wild: 0 }, buy: ["defense"] });
    assert.equal(r.state.players[0]!.hand.length, handBefore - 2 + 1, "sold 2, bought 1");
    assert.equal(r.state.stacks.defense.length, 15, "stack lost a card");
    assert.equal(r.state.turnSeat, 1, "SHOP is a Main Action — turn ends");
    assertInvariants(r.state);
  });

  it("rejects buying without enough coins", () => {
    const g = game(2, 5, { shopCost: 4 });
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

describe("water fight engine: support/mischief effects (B.4)", () => {
  it("Pickpocket steals a Treasure; Needle discards the target's balloons", () => {
    const g = game(2, 5);
    g.players[0]!.hand.push({ id: 10001, kind: "pickpocket" });
    moveFromDeck(g, 1, "treasure", 1);
    let r = applyMove(g, { kind: "PLAY_SUPPORT", support: "pickpocket", target: 1 });
    assert.equal(r.state.players[1]!.hand.filter((c) => c.kind === "treasure").length, 0, "treasure stolen");
    assert.ok(r.state.players[0]!.hand.some((c) => c.kind === "treasure"), "thief gained it");
    assert.equal(r.awaiting.kind, "MOVE", "Support does not end the turn");

    const g2 = game(2, 5);
    g2.players[0]!.hand.push({ id: 10002, kind: "needle" });
    setHand(g2, 1, ["balloon", "balloon", "miss"]);
    const r2 = applyMove(g2, { kind: "PLAY_SUPPORT", support: "needle", target: 1 });
    assert.equal(r2.state.players[1]!.hand.filter((c) => c.kind === "balloon").length, 0);
    assert.equal(r2.state.players[1]!.hand.length, 1, "only the Miss remains");
  });

  it("Switcheroo swaps entire hands", () => {
    const g = game(2, 5);
    g.players[0]!.hand = [{ id: 10001, kind: "switcheroo" }, { id: 10002, kind: "miss" }];
    g.players[1]!.hand = [{ id: 10003, kind: "hit" }, { id: 10004, kind: "hit" }, { id: 10005, kind: "hit" }];
    const r = applyMove(g, { kind: "PLAY_SUPPORT", support: "switcheroo", target: 1 });
    assert.equal(r.state.players[0]!.hand.length, 3);
    assert.ok(r.state.players[0]!.hand.every((c) => c.kind === "hit"));
    assert.deepEqual(r.state.players[1]!.hand.map((c) => c.kind), ["miss"]);
  });

  it("Freeze Out: target draws only 1 next turn (status consumed)", () => {
    const g = game(2, 5);
    setHand(g, 1, []); // clear the opening cushion so we count just the frozen draw
    g.players[0]!.hand.push({ id: 10001, kind: "freezeout" });
    let r = applyMove(g, { kind: "PLAY_SUPPORT", support: "freezeout", target: 1 });
    assert.equal(r.state.players[1]!.statuses.freezeOut, true);
    r = applyMove(r.state, { kind: "END_TURN" });
    assert.equal(r.state.turnSeat, 1);
    assert.equal(r.state.players[1]!.hand.length, 1, "drew only 1");
    assert.equal(r.state.players[1]!.statuses.freezeOut, false, "consumed");
  });

  it("Lemonade Spill: target discards 1 and cannot Shop next turn", () => {
    const g = game(2, 5);
    g.players[0]!.hand.push({ id: 10001, kind: "lemonadespill" });
    setHand(g, 1, ["miss", "hit"]);
    let r = applyMove(g, { kind: "PLAY_SUPPORT", support: "lemonadespill", target: 1 });
    assert.equal(r.state.players[1]!.hand.length, 1, "target discarded 1");
    assert.equal(r.state.players[1]!.statuses.noShop, true);
    r = applyMove(r.state, { kind: "END_TURN" }); // -> seat 1's turn, noShop active
    moveFromDeck(r.state, 1, "treasure", 2);
    assert.throws(
      () => applyMove(r.state, { kind: "SHOP", sell: { balloons: 0, treasures: 2, wild: 0 }, buy: ["defense"] }),
      /Lemonade Spill/,
    );
  });
});

describe("water fight engine: modifiers (B.5)", () => {
  it("Soaker Cannon (R2): declared pre-flip, negates the defender's hand-Miss", () => {
    const g = game(2, 5);
    setHand(g, 0, ["balloon", "soaker"]);
    setHand(g, 1, ["miss"]);
    forceSplash(g, "hit");
    const r = applyMove(g, { kind: "THROW", target: 1, soaker: true });
    assert.equal(r.awaiting.kind, "DEFEND");
    const opts = legalResolutions(r.state);
    assert.ok(!opts.some((o) => o.kind === "DEFEND" && o.defense === "miss"), "Soaker removes the Miss option");
    assert.throws(() => applyResolution(r.state, { kind: "DEFEND", defense: "miss" }), /illegal resolution/);
    const r2 = applyResolution(r.state, { kind: "DEFEND", defense: "pass" });
    assert.equal(r2.state.players[1]!.lives, 2, "no hand-Miss could save the target");
  });

  it("Soaker is wasted on a Miss flip; a spread modifier is NOT spent on a Miss (E3)", () => {
    const g = game(3, 5);
    setHand(g, 0, ["balloon", "soaker", "triplesplash"]);
    forceSplash(g, "miss");
    const r = applyMove(g, {
      kind: "THROW",
      target: 1,
      soaker: true,
      spread: { modifier: "triplesplash", extraTargets: [2] },
    });
    assert.equal(r.awaiting.kind, "MOVE", "the Miss ended the attack");
    assert.equal(r.state.turnSeat, 1);
    const kinds = r.state.players[0]!.hand.map((c) => c.kind);
    assert.ok(!kinds.includes("balloon"), "balloon spent");
    assert.ok(!kinds.includes("soaker"), "Soaker wasted (it is declared pre-flip)");
    assert.ok(kinds.includes("triplesplash"), "spread only spends on a Hit");
  });

  it("Triple Splash spreads one Hit to multiple targets, each defending in sequence (E3)", () => {
    const g = game(3, 7);
    setHand(g, 0, ["balloon", "triplesplash"]);
    setHand(g, 1, []);
    setHand(g, 2, []);
    forceSplash(g, "hit");
    let r = applyMove(g, { kind: "THROW", target: 1, spread: { modifier: "triplesplash", extraTargets: [2] } });
    assert.equal(r.awaiting.kind, "DEFEND");
    assert.equal(r.awaiting.seats[0], 1, "the first target defends first");
    r = applyResolution(r.state, { kind: "DEFEND", defense: "pass" });
    assert.equal(r.state.players[1]!.lives, 2);
    assert.equal(r.awaiting.kind, "DEFEND");
    assert.equal(r.awaiting.seats[0], 2, "then the second target defends");
    r = applyResolution(r.state, { kind: "DEFEND", defense: "pass" });
    assert.equal(r.state.players[2]!.lives, 2);
    assert.equal(r.state.awaiting.kind, "MOVE", "both resolved -> the turn advances");
  });

  it("Splash Zone hits every living opponent", () => {
    const g = game(3, 11);
    setHand(g, 0, ["balloon", "splashzone"]);
    setHand(g, 1, []);
    setHand(g, 2, []);
    forceSplash(g, "hit");
    let r = applyMove(g, { kind: "THROW", target: 1, spread: { modifier: "splashzone", extraTargets: [] } });
    r = applyResolution(r.state, { kind: "DEFEND", defense: "pass" }); // seat 1
    r = applyResolution(r.state, { kind: "DEFEND", defense: "pass" }); // seat 2
    assert.equal(r.state.players[1]!.lives, 2);
    assert.equal(r.state.players[2]!.lives, 2);
  });

  it("Launcher grants an extra basic throw after the attack resolves (E4)", () => {
    const g = game(2, 5);
    setHand(g, 0, ["balloon", "balloon", "launcher"]);
    setHand(g, 1, []);
    g.splashPile = ["hit", "hit", "hit", "hit"];
    let r = applyMove(g, { kind: "THROW", target: 1 });
    r = applyResolution(r.state, { kind: "DEFEND", defense: "pass" });
    assert.equal(r.state.players[1]!.lives, 2);
    assert.equal(r.awaiting.kind, "EXTRA_THROW", "Launcher offers an extra throw");
    assert.equal(r.awaiting.seats[0], 0);
    r = applyResolution(r.state, { kind: "EXTRA", action: "throw", target: 1 });
    assert.equal(r.awaiting.kind, "DEFEND", "the extra throw opened its own ladder");
    r = applyResolution(r.state, { kind: "DEFEND", defense: "pass" });
    assert.equal(r.state.players[1]!.lives, 1, "the extra throw landed");
    assert.equal(r.state.awaiting.kind, "MOVE", "no balloons left -> the turn ends");
    assert.equal(r.state.turnSeat, 1);
  });

  it("declining the extra throw (EXTRA pass) ends the turn", () => {
    const g = game(2, 5);
    setHand(g, 0, ["balloon", "balloon", "rapidfire"]);
    setHand(g, 1, []);
    forceSplash(g, "hit");
    let r = applyMove(g, { kind: "THROW", target: 1 });
    r = applyResolution(r.state, { kind: "DEFEND", defense: "pass" });
    assert.equal(r.awaiting.kind, "EXTRA_THROW", "Rapid Fire also offers it");
    r = applyResolution(r.state, { kind: "EXTRA", action: "pass" });
    assert.equal(r.state.awaiting.kind, "MOVE");
    assert.equal(r.state.turnSeat, 1);
  });

  it("legalMoves enumerates Soaker and spread throw variants", () => {
    const g = game(3, 5);
    setHand(g, 0, ["balloon", "soaker", "splashzone", "triplesplash"]);
    const moves = legalMoves(g);
    assert.ok(moves.some((m) => m.kind === "THROW" && m.soaker), "a Soaker throw is offered");
    assert.ok(moves.some((m) => m.kind === "THROW" && m.spread?.modifier === "splashzone"), "a Splash Zone throw is offered");
    assert.ok(moves.some((m) => m.kind === "THROW" && m.spread?.modifier === "triplesplash"), "a Triple Splash throw is offered");
  });
});

describe("water fight engine: reactions (B.6)", () => {
  it("no reaction window opens when the target holds no reaction card", () => {
    const g = game(2, 5);
    setHand(g, 0, ["balloon"]);
    setHand(g, 1, ["miss"]); // Miss is a ladder card, not a reaction
    forceSplash(g, "hit");
    const r = applyMove(g, { kind: "THROW", target: 1 });
    assert.equal(r.awaiting.kind, "DEFEND", "went straight to the flip + ladder");
  });

  it("Towel cancels a basic throw BEFORE the flip (E10/E11)", () => {
    const g = game(2, 5);
    setHand(g, 0, ["balloon"]);
    setHand(g, 1, ["towel"]);
    forceSplash(g, "hit");
    const splashBefore = g.splashPile.length;
    let r = applyMove(g, { kind: "THROW", target: 1 });
    assert.equal(r.awaiting.kind, "REACT", "the target gets a reaction window");
    assert.equal(r.awaiting.seats[0], 1);
    r = applyResolution(r.state, { kind: "REACT", action: "towel" });
    assert.equal(r.state.players[1]!.lives, 3, "cancelled — no damage");
    assert.equal(r.state.splashPile.length, splashBefore, "Towel fired pre-flip; the Splash Pile never flipped");
    assert.equal(r.state.awaiting.kind, "MOVE");
    assert.equal(r.state.turnSeat, 1, "the attacker's turn ended");
  });

  it("Towel cancels a targeting Support too (E11)", () => {
    const g = game(2, 5);
    g.players[0]!.hand.push({ id: 10001, kind: "sabotage" });
    setHand(g, 1, ["towel", "miss", "hit"]);
    let r = applyMove(g, { kind: "PLAY_SUPPORT", support: "sabotage", target: 1 });
    assert.equal(r.awaiting.kind, "REACT");
    // Only Towel / pass on a Support reaction — Redirect/Water Trap are attack-only
    const opts = legalResolutions(r.state);
    assert.ok(!opts.some((o) => o.kind === "REACT" && (o.action === "redirect" || o.action === "watertrap")));
    r = applyResolution(r.state, { kind: "REACT", action: "towel" });
    assert.deepEqual(r.state.players[1]!.hand.map((c) => c.kind).sort(), ["hit", "miss"], "Sabotage cancelled — nothing discarded");
    assert.equal(r.state.awaiting.kind, "MOVE", "the attacker keeps their turn");
    assert.equal(r.state.turnSeat, 0);
  });

  it("Redirect shifts the hit to another player (R3/E6)", () => {
    const g = game(3, 7);
    setHand(g, 0, ["balloon"]);
    setHand(g, 1, ["redirect"]);
    setHand(g, 2, []);
    forceSplash(g, "hit");
    let r = applyMove(g, { kind: "THROW", target: 1 });
    assert.equal(r.awaiting.kind, "REACT");
    r = applyResolution(r.state, { kind: "REACT", action: "redirect", target: 2 });
    assert.equal(r.awaiting.kind, "DEFEND", "the redirected target now defends");
    assert.equal(r.awaiting.seats[0], 2);
    r = applyResolution(r.state, { kind: "DEFEND", defense: "pass" });
    assert.equal(r.state.players[1]!.lives, 3, "the original target is unharmed");
    assert.equal(r.state.players[2]!.lives, 2, "the redirected target took it");
  });

  it("Water Trap bounces the throw back at the attacker (role-flip)", () => {
    const g = game(2, 5);
    setHand(g, 0, ["balloon"]);
    setHand(g, 1, ["watertrap"]);
    forceSplash(g, "hit");
    let r = applyMove(g, { kind: "THROW", target: 1 });
    r = applyResolution(r.state, { kind: "REACT", action: "watertrap" });
    assert.equal(r.awaiting.kind, "DEFEND", "the attacker is now the defender");
    assert.equal(r.awaiting.seats[0], 0);
    r = applyResolution(r.state, { kind: "DEFEND", defense: "pass" });
    assert.equal(r.state.players[0]!.lives, 2, "the attacker took their own throw");
    assert.equal(r.state.players[1]!.lives, 3, "the Water-Trapper is unharmed");
  });

  it("a discrete reaction is capped at once per seat per attack", () => {
    const g = game(3, 7);
    setHand(g, 0, ["balloon"]);
    setHand(g, 1, ["redirect", "redirect"]);
    setHand(g, 2, ["redirect"]);
    forceSplash(g, "hit");
    let r = applyMove(g, { kind: "THROW", target: 1 });
    r = applyResolution(r.state, { kind: "REACT", action: "redirect", target: 2 }); // seat 1 -> seat 2
    r = applyResolution(r.state, { kind: "REACT", action: "redirect", target: 1 }); // seat 2 -> seat 1
    assert.equal(r.awaiting.kind, "REACT");
    assert.equal(r.awaiting.seats[0], 1, "seat 1 is the target again");
    const opts = legalResolutions(r.state);
    assert.ok(opts.some((o) => o.kind === "REACT" && o.action === "pass"));
    assert.ok(
      !opts.some((o) => o.kind === "REACT" && o.action === "redirect"),
      "seat 1 already redirected once — cannot redirect again",
    );
  });

  it("Lifeguard automatically saves a player from a soak, once (-> 1 life)", () => {
    const g = game(2, 9);
    g.players[1]!.lives = 1;
    setHand(g, 0, ["balloon"]);
    setHand(g, 1, ["lifeguard"]); // automatic, not a chosen reaction
    forceSplash(g, "hit");
    let r = applyMove(g, { kind: "THROW", target: 1 });
    assert.equal(r.awaiting.kind, "DEFEND", "Lifeguard is not a reaction-window card");
    r = applyResolution(r.state, { kind: "DEFEND", defense: "pass" });
    assert.equal(r.state.players[1]!.out, false, "not soaked");
    assert.equal(r.state.players[1]!.lives, 1, "Lifeguard kept them at 1 life");
    assert.ok(!r.state.players[1]!.hand.some((c) => c.kind === "lifeguard"), "Lifeguard consumed");
    assert.equal(r.state.over, false, "game continues");
  });
});

describe("water fight engine: events (B.7)", () => {
  it("the event-density dial seeds that many of the 19 Events into the main deck", () => {
    const countEvents = (g: GameState): number =>
      [...g.mainDeck, ...g.mainDiscard].filter((c) => c.kind === "event").length;
    assert.equal(countEvents(createGame(2, 5, { eventDensity: 5 })), 5);
    assert.equal(countEvents(createGame(3, 7, { eventDensity: 0 })), 0);
    assert.throws(() => createGame(2, 5, { eventDensity: 20 }), /eventDensity/);
  });

  it("an Event resolves on draw, counts as a draw, and goes to the main discard (D3/E5)", () => {
    const g = game(2, 5);
    setHand(g, 1, []); // clear the opening cushion so we count just the two draws
    injectTopEvent(g, "calmwaters"); // a dud — isolates the draw mechanics
    const r = applyMove(g, { kind: "END_TURN" }); // seat 1's opening draw resolves it
    assert.equal(r.state.turnSeat, 1);
    assert.equal(r.state.players[1]!.hand.length, 1, "the Event consumed one of the two draws (no replacement)");
    assert.ok(r.state.mainDiscard.some((c) => c.id === 3000), "the resolved Event went to the main discard");
  });

  it("a table-wide storm damages every living player by 1", () => {
    const g = game(2, 5); // both at 3 lives
    injectTopEvent(g, "mudslide");
    const r = applyMove(g, { kind: "END_TURN" });
    assert.equal(r.state.players[0]!.lives, 2);
    assert.equal(r.state.players[1]!.lives, 2);
  });

  it("a table-wide storm that would soak EVERYONE clamps each to 1 life (E9)", () => {
    const g = game(2, 9);
    g.players[0]!.lives = 1;
    g.players[1]!.lives = 1;
    injectTopEvent(g, "heatwave");
    const r = applyMove(g, { kind: "END_TURN" });
    assert.equal(r.state.players[0]!.lives, 1, "clamped, not soaked");
    assert.equal(r.state.players[1]!.lives, 1);
    assert.equal(r.state.players[0]!.out, false);
    assert.equal(r.state.players[1]!.out, false);
    assert.equal(r.state.over, false, "no simultaneous wipe");
  });

  it("Lightning strikes the life leader (anti-snowball)", () => {
    const g = game(2, 5);
    g.players[0]!.lives = 3;
    g.players[1]!.lives = 2;
    injectTopEvent(g, "lightning"); // drawn by seat 1, but hits the leader (seat 0)
    const r = applyMove(g, { kind: "END_TURN" });
    assert.equal(r.state.players[0]!.lives, 2, "the leader took it");
    assert.equal(r.state.players[1]!.lives, 2);
  });

  it("Water Park Pass heals the drawer, capped at starting lives (E8)", () => {
    const g = game(2, 5);
    g.players[1]!.lives = 1;
    injectTopEvent(g, "waterparkpass");
    const r = applyMove(g, { kind: "END_TURN" });
    assert.equal(r.state.players[1]!.lives, 2, "drawer healed 1");
  });
});

describe("water fight engine: Storm Cloud + Sudden-Death (B.8)", () => {
  /** Force a seat into the Storm Cloud state with a given hand. */
  function makeStormCloud(g: GameState, seat: number, hand: CardKind[] = []): void {
    g.players[seat]!.lives = 0;
    g.players[seat]!.out = true;
    g.players[seat]!.stormCloud = true;
    setHand(g, seat, hand);
  }

  it("soaking in normal play makes a Storm Cloud (soft elimination), game continues", () => {
    const g = game(3, 5);
    g.players[1]!.lives = 1;
    setHand(g, 0, ["balloon"]);
    setHand(g, 1, []);
    forceSplash(g, "hit");
    let r = applyMove(g, { kind: "THROW", target: 1 });
    r = applyResolution(r.state, { kind: "DEFEND", defense: "pass" });
    assert.equal(r.state.players[1]!.out, true);
    assert.equal(r.state.players[1]!.stormCloud, true, "soft elimination -> Storm Cloud");
    assert.equal(r.state.over, false, "seat 2 still alive");
  });

  it("a Storm Cloud may only pass or splash (no shop/support/big)", () => {
    const g = game(3, 5);
    makeStormCloud(g, 1, ["balloon", "mega", "firstaid"]);
    g.turnSeat = 1;
    g.awaiting = { seats: [1], kind: "MOVE" };
    const moves = legalMoves(g);
    assert.ok(moves.some((m) => m.kind === "STORM_THROW"), "may splash");
    assert.ok(moves.some((m) => m.kind === "END_TURN"));
    assert.ok(!moves.some((m) => m.kind === "PLAY_BIG" || m.kind === "PLAY_SUPPORT" || m.kind === "SHOP"));
  });

  it("a Storm Cloud splash hits a random living player for 1", () => {
    const g = game(3, 5);
    makeStormCloud(g, 2, ["balloon"]);
    g.turnSeat = 2;
    g.awaiting = { seats: [2], kind: "MOVE" };
    g.splashPile = ["hit", "hit", "hit"];
    const before = g.players[0]!.lives + g.players[1]!.lives;
    let r = applyMove(g, { kind: "STORM_THROW" });
    assert.equal(r.awaiting.kind, "DEFEND");
    const tSeat = r.awaiting.seats[0]!;
    assert.ok(tSeat === 0 || tSeat === 1, "splashed a living player, not itself");
    r = applyResolution(r.state, { kind: "DEFEND", defense: "pass" });
    assert.equal(r.state.players[0]!.lives + r.state.players[1]!.lives, before - 1, "dealt 1 damage");
  });

  it("a Storm Cloud cannot be targeted by a normal attack", () => {
    const g = game(3, 5);
    makeStormCloud(g, 2);
    setHand(g, 0, ["balloon"]);
    g.turnSeat = 0;
    g.awaiting = { seats: [0], kind: "MOVE" };
    assert.throws(() => applyMove(g, { kind: "THROW", target: 2 }), /not a living player/);
    assert.ok(!legalMoves(g).some((m) => m.kind === "THROW" && m.target === 2));
  });

  it("a Storm Cloud's drawn Event has no effect (D5/E5)", () => {
    const g = game(3, 5);
    makeStormCloud(g, 2);
    g.turnSeat = 1;
    g.awaiting = { seats: [1], kind: "MOVE" };
    injectTopEvent(g, "mudslide");
    const before = [g.players[0]!.lives, g.players[1]!.lives];
    const r = applyMove(g, { kind: "END_TURN" }); // seat 1 ends -> seat 2 (Storm Cloud) draws the Event
    assert.equal(r.state.turnSeat, 2);
    assert.equal(r.state.players[0]!.lives, before[0], "no table damage from a Storm Cloud's Event");
    assert.equal(r.state.players[1]!.lives, before[1]);
    assert.equal(r.state.players[2]!.hand.length, 0, "the Event was discarded, not kept");
  });

  it("win = last LIVING player; Storm Clouds do not count", () => {
    const g = game(3, 9);
    makeStormCloud(g, 2);
    g.players[1]!.lives = 1;
    setHand(g, 0, ["balloon"]);
    setHand(g, 1, []);
    g.turnSeat = 0;
    g.awaiting = { seats: [0], kind: "MOVE" };
    forceSplash(g, "hit");
    let r = applyMove(g, { kind: "THROW", target: 1 });
    r = applyResolution(r.state, { kind: "DEFEND", defense: "pass" });
    assert.equal(r.state.over, true, "only seat 0 lives -> over (Storm Clouds ignored)");
    assert.equal(r.state.winner, 0);
  });

  it("a table storm that would wipe the table triggers Sudden-Death, then a single-target soak decides it (E9)", () => {
    const g = game(2, 9);
    g.players[0]!.lives = 1;
    g.players[1]!.lives = 1;
    injectTopEvent(g, "mudslide");
    let r = applyMove(g, { kind: "END_TURN" }); // seat 1 draws it -> would soak both
    assert.equal(r.state.phase, "sudden-death");
    assert.equal(r.state.players[0]!.lives, 1, "finalists clamped to 1, not soaked");
    assert.equal(r.state.players[1]!.lives, 1);
    assert.equal(r.state.over, false);

    setHand(r.state, 1, ["balloon"]);
    forceSplash(r.state, "hit");
    let r2 = applyMove(r.state, { kind: "THROW", target: 0 });
    r2 = applyResolution(r2.state, { kind: "DEFEND", defense: "pass" });
    assert.equal(r2.state.over, true, "a single-target soak ends Sudden-Death with one winner");
    assert.equal(r2.state.winner, 1);
    assert.equal(r2.state.players[0]!.out, true);
    assert.equal(r2.state.players[0]!.stormCloud, false, "soaked in Sudden-Death = fully out, not a Storm Cloud");
  });

  it("Sudden-Death suppresses further table damage", () => {
    const g = game(2, 9);
    g.players[0]!.lives = 1;
    g.players[1]!.lives = 1;
    injectTopEvent(g, "mudslide");
    let r = applyMove(g, { kind: "END_TURN" });
    assert.equal(r.state.phase, "sudden-death");
    injectTopEvent(r.state, "heatwave");
    const r2 = applyMove(r.state, { kind: "END_TURN" }); // seat 0 draws heatwave
    assert.equal(r2.state.players[0]!.lives, 1, "table damage is suppressed");
    assert.equal(r2.state.players[1]!.lives, 1);
  });
});

describe("water fight engine: regression gaps (review)", () => {
  it("MAX_ATTACK_ROUNDS backstops a runaway Miss/Hit ladder (no infinite loop)", () => {
    const g = game(2, 5);
    setHand(g, 0, ["balloon", ...Array(600).fill("hit")] as CardKind[]);
    setHand(g, 1, Array(600).fill("miss") as CardKind[]);
    forceSplash(g, "hit");
    let r = applyMove(g, { kind: "THROW", target: 1 });
    let guard = 0;
    // Stay in the ladder only; the cap must eject us before cards (or the guard) run out.
    while ((r.awaiting.kind === "DEFEND" || r.awaiting.kind === "ATTACKER_RESPOND") && ++guard < 2000) {
      r =
        r.awaiting.kind === "DEFEND"
          ? applyResolution(r.state, { kind: "DEFEND", defense: "miss" })
          : applyResolution(r.state, { kind: "ATTACKER_RESPOND", respond: "hit" });
    }
    assert.ok(guard < 2000, "the MAX_ATTACK_ROUNDS cap ended the ladder (no infinite loop)");
    assert.ok(["MOVE", "DISCARD", "GAME_OVER"].includes(r.awaiting.kind) || r.state.over, "left the ladder in a terminal state");
  });

  it("a bounced Water Trap can soak the turn player; the turn still ends cleanly", () => {
    const g = game(3, 7);
    g.players[0]!.lives = 1;
    setHand(g, 0, ["balloon"]);
    setHand(g, 1, ["watertrap"]);
    setHand(g, 2, []);
    forceSplash(g, "hit");
    let r = applyMove(g, { kind: "THROW", target: 1 });
    r = applyResolution(r.state, { kind: "REACT", action: "watertrap" }); // bounce to seat 0
    r = applyResolution(r.state, { kind: "DEFEND", defense: "pass" }); // seat 0 takes its own throw
    assert.equal(r.state.players[0]!.out, true, "the attacker soaked themselves");
    assert.equal(r.state.players[0]!.stormCloud, true, "soft-eliminated, not in Sudden-Death");
    assert.notEqual(r.state.awaiting.kind, "DISCARD", "no discard opened for the out turn player");
    assert.notEqual(r.state.turnSeat, 0, "the turn advanced off the soaked player");
  });

  it("a Backpack-drawn Event that soaks the drawer ends the turn (mid-turn soak)", () => {
    const g = game(3, 5);
    g.players[0]!.lives = 1;
    g.players[0]!.hand.push({ id: 10002, kind: "backpack" });
    injectTopEvent(g, "mudslide"); // table -1; seat 0 is at 1 life
    const r = applyMove(g, { kind: "PLAY_SUPPORT", support: "backpack" });
    assert.equal(r.state.players[0]!.out, true, "the drawer soaked mid-turn");
    assert.notEqual(r.state.turnSeat, 0, "the turn advanced");
  });

  it("Golden's draw over the hand limit forces a post-attack discard by the ATTACKER", () => {
    const g = game(2, 5, { handLimit: 3 });
    setHand(g, 0, ["golden", "miss", "hit"]); // 3 cards; Golden draws 2 -> 4 > limit
    setHand(g, 1, []);
    let r = applyMove(g, { kind: "PLAY_BIG", big: "golden", target: 1 });
    r = applyResolution(r.state, { kind: "DEFEND", defense: "pass" });
    assert.equal(r.awaiting.kind, "DISCARD", "the over-limit hand must discard");
    assert.equal(r.awaiting.seats[0], 0, "the attacker discards, not the target");
  });
});

describe("water fight engine: effects + edges (review)", () => {
  it("Storm Cloud splash distributes across living targets, and needs a balloon", () => {
    const seen = new Set<number>();
    for (let seed = 0; seed < 40; seed++) {
      const g = game(3, seed);
      g.players[1]!.lives = 0;
      g.players[1]!.out = true;
      g.players[1]!.stormCloud = true;
      setHand(g, 1, ["balloon"]);
      g.turnSeat = 1;
      g.awaiting = { seats: [1], kind: "MOVE" };
      g.splashPile = ["hit", "hit", "hit"];
      const r = applyMove(g, { kind: "STORM_THROW" });
      seen.add(r.awaiting.seats[0]!);
    }
    assert.ok(seen.size > 1, "the random splash reaches more than one distinct living seat");

    const g2 = game(3, 5);
    g2.players[1]!.lives = 0;
    g2.players[1]!.out = true;
    g2.players[1]!.stormCloud = true;
    setHand(g2, 1, ["miss"]); // no balloon
    g2.turnSeat = 1;
    g2.awaiting = { seats: [1], kind: "MOVE" };
    const moves = legalMoves(g2);
    assert.ok(!moves.some((m) => m.kind === "STORM_THROW"), "no balloon -> no splash offered");
    assert.ok(moves.some((m) => m.kind === "END_TURN"));
  });

  it("Lost and Found takes one card from each living opponent (E7)", () => {
    const g = game(3, 5);
    setHand(g, 0, ["miss", "miss"]);
    setHand(g, 1, []);
    setHand(g, 2, ["hit", "hit"]);
    injectTopEvent(g, "lostandfound");
    const r = applyMove(g, { kind: "END_TURN" }); // seat 1 draws it
    assert.equal(r.state.turnSeat, 1, "seat 1 is the drawer");
    assert.equal(r.state.players[0]!.hand.length, 1, "seat 0 lost one card");
    assert.equal(r.state.players[2]!.hand.length, 1, "seat 2 lost one card");
    assert.ok(r.state.players[1]!.hand.length >= 2, "the drawer gained one from each opponent");
  });

  it("Card Swap exchanges up to 2 cards each way", () => {
    const g = game(2, 5);
    g.players[0]!.hand = [
      { id: 10001, kind: "cardswap" },
      { id: 10002, kind: "miss" },
      { id: 10003, kind: "miss" },
      { id: 10004, kind: "miss" },
    ];
    setHand(g, 1, ["hit", "hit", "hit"]);
    const r = applyMove(g, { kind: "PLAY_SUPPORT", support: "cardswap", target: 1 });
    // The swap is random (it can re-pick a just-moved card), so assert the
    // conservative property: hand sizes hold and no card is lost or duplicated.
    const h0 = r.state.players[0]!.hand;
    const h1 = r.state.players[1]!.hand;
    assert.equal(h0.length, 3, "seat 0 keeps 3 cards");
    assert.equal(h1.length, 3, "seat 1 keeps 3 cards");
    const hits = h0.filter((c) => c.kind === "hit").length + h1.filter((c) => c.kind === "hit").length;
    const misses = h0.filter((c) => c.kind === "miss").length + h1.filter((c) => c.kind === "miss").length;
    assert.equal(hits, 3, "all 3 hits conserved across the swap");
    assert.equal(misses, 3, "all 3 misses conserved across the swap");
  });

  it("Sabotage discards exactly 2 of the target's cards", () => {
    const g = game(2, 5);
    g.players[0]!.hand.push({ id: 10001, kind: "sabotage" });
    setHand(g, 1, ["miss", "hit", "treasure", "wild"]);
    const r = applyMove(g, { kind: "PLAY_SUPPORT", support: "sabotage", target: 1 });
    assert.equal(r.state.players[1]!.hand.length, 2, "the target lost exactly 2 cards");
  });

  it("Hidden Stash pulls up to 2 Treasure out of the discard", () => {
    const g = game(2, 5);
    g.players[0]!.hand.push({ id: 10001, kind: "hiddenstash" });
    g.mainDiscard.push({ id: 9001, kind: "treasure" }, { id: 9002, kind: "treasure" }, { id: 9003, kind: "treasure" });
    const before = g.players[0]!.hand.filter((c) => c.kind === "treasure").length;
    const r = applyMove(g, { kind: "PLAY_SUPPORT", support: "hiddenstash" });
    assert.equal(r.state.players[0]!.hand.filter((c) => c.kind === "treasure").length - before, 2, "took 2 Treasure");
    assert.equal(r.state.mainDiscard.filter((c) => c.kind === "treasure").length, 1, "one Treasure left in the discard");
  });
});

describe("water fight engine: peeks (G3)", () => {
  it("Goggles reveals the top 3 of the draw pile to the peeker (a peek, not a draw)", () => {
    const g = game(2, 5);
    g.players[0]!.hand.push({ id: 10001, kind: "goggles" });
    const deckBefore = g.mainDeck.length;
    const top3 = g.mainDeck.slice(-3).reverse().map((c) => c.kind);
    const r = applyMove(g, { kind: "PLAY_SUPPORT", support: "goggles" });
    assert.equal(r.state.mainDeck.length, deckBefore, "Goggles does not draw");
    assert.equal(r.state.reveals.length, 1);
    assert.equal(r.state.reveals[0]!.seat, 0, "only the peeker sees it");
    assert.equal(r.state.reveals[0]!.kind, "deck-top");
    assert.deepEqual(r.state.reveals[0]!.cards.map((c) => c.kind), top3, "the top 3 in draw order");
    assert.equal(r.state.awaiting.kind, "MOVE", "Support does not end the turn");
  });

  it("Sneaky Peek reveals a chosen opponent's hand", () => {
    const g = game(2, 5);
    g.players[0]!.hand.push({ id: 10001, kind: "sneakypeek" });
    setHand(g, 1, ["miss", "umbrella", "balloon"]);
    const r = applyMove(g, { kind: "PLAY_SUPPORT", support: "sneakypeek", target: 1 });
    assert.equal(r.state.reveals.length, 1);
    assert.equal(r.state.reveals[0]!.seat, 0);
    assert.equal(r.state.reveals[0]!.kind, "hand");
    assert.equal(r.state.reveals[0]!.ofSeat, 1);
    assert.deepEqual(r.state.reveals[0]!.cards.map((c) => c.kind).sort(), ["balloon", "miss", "umbrella"]);
  });

  it("Sneaky Peek can be Towelled away — no peek (E11)", () => {
    const g = game(2, 5);
    g.players[0]!.hand.push({ id: 10001, kind: "sneakypeek" });
    setHand(g, 1, ["towel"]);
    let r = applyMove(g, { kind: "PLAY_SUPPORT", support: "sneakypeek", target: 1 });
    assert.equal(r.state.awaiting.kind, "REACT", "the target gets a Towel window first");
    r = applyResolution(r.state, { kind: "REACT", action: "towel" });
    assert.equal(r.state.reveals.length, 0, "cancelled — nothing peeked");
  });
});

describe("water fight engine: new dials (G2)", () => {
  it("the main-deck Hit/Miss dial resizes the deck, conserves, and plays", () => {
    const g = createGame(3, 5, { mainHit: 5, mainMiss: 5, eventDensity: 0 });
    assert.equal(g.mainIdMax, 51, "deck = 20 balloon + 5 miss + 5 hit + 20 treasure + 1 wild");
    const count = (k: CardKind) => [...g.mainDeck, ...g.players.flatMap((p) => p.hand)].filter((c) => c.kind === k).length;
    assert.equal(count("hit"), 5);
    assert.equal(count("miss"), 5);
    assert.equal(count("balloon"), 20);
    assertInvariants(g);
    let s = g;
    const policy = new RandomPolicy(2);
    let guard = 0;
    while (!isGameOver(s) && ++guard < 1500) {
      s = s.awaiting.kind === "MOVE" ? applyMove(s, policy.move(s)).state : applyResolution(s, policy.resolve(s)).state;
      assertInvariants(s); // conservation holds against the custom mainIdMax
    }
  });

  it("Storm Cloud rate dials: draws and throws per turn", () => {
    const g = game(3, 5, { stormDraw: 2 });
    g.players[1]!.lives = 0;
    g.players[1]!.out = true;
    g.players[1]!.stormCloud = true;
    setHand(g, 1, []);
    g.turnSeat = 0;
    g.awaiting = { seats: [0], kind: "MOVE" };
    const r = applyMove(g, { kind: "END_TURN" }); // seat 1's Storm Cloud turn
    assert.equal(r.state.turnSeat, 1);
    assert.equal(r.state.players[1]!.hand.length, 2, "stormDraw = 2 drew two");

    const g2 = game(3, 7, { stormThrows: 2 });
    g2.players[1]!.lives = 0;
    g2.players[1]!.out = true;
    g2.players[1]!.stormCloud = true;
    setHand(g2, 1, ["balloon", "balloon"]);
    g2.turnSeat = 1;
    g2.awaiting = { seats: [1], kind: "MOVE" };
    g2.splashPile = ["hit", "hit", "hit", "hit"];
    let r2 = applyMove(g2, { kind: "STORM_THROW" });
    r2 = applyResolution(r2.state, { kind: "DEFEND", defense: "pass" });
    assert.equal(r2.state.awaiting.kind, "MOVE", "a Storm Cloud with 2 throws gets a second");
    assert.equal(r2.state.awaiting.seats[0], 1);
    r2 = applyMove(r2.state, { kind: "STORM_THROW" });
    r2 = applyResolution(r2.state, { kind: "DEFEND", defense: "pass" });
    assert.notEqual(r2.state.turnSeat, 1, "after two throws the Storm Cloud's turn ends");
  });

  it("the MAX_REACTIONS dial caps the defense ladder", () => {
    const g = game(2, 5, { maxReactions: 2 });
    setHand(g, 0, ["balloon", "hit", "hit"]);
    setHand(g, 1, ["miss", "miss"]);
    forceSplash(g, "hit");
    let r = applyMove(g, { kind: "THROW", target: 1 });
    r = applyResolution(r.state, { kind: "DEFEND", defense: "miss" }); // round 1
    r = applyResolution(r.state, { kind: "ATTACKER_RESPOND", respond: "hit" }); // round 2
    r = applyResolution(r.state, { kind: "DEFEND", defense: "miss" }); // round 3 > cap -> resolves
    assert.notEqual(r.state.awaiting.kind, "DEFEND", "the cap ended the ladder");
    assert.notEqual(r.state.awaiting.kind, "ATTACKER_RESPOND");
  });
});

describe("water fight engine: illegal input", () => {
  it("rejects targeting yourself, throwing without a balloon, and illegal blocks", () => {
    const g = game(2, 1);
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
    const g = game(2, 1);
    setHand(g, 0, ["treasure"]);
    const moves = legalMoves(g);
    assert.ok(moves.some((m) => m.kind === "END_TURN"));
    assert.ok(!moves.some((m) => m.kind === "THROW"), "no balloon -> no throw");
  });
});

describe("water fight engine: decks", () => {
  it("drawMainCard reshuffles the discard when the deck is empty", () => {
    const g = game(2, 1);
    g.mainDeck = [];
    g.mainDiscard = [{ id: 9999, kind: "balloon" }];
    const drawn = drawMainCard(g);
    assert.equal(drawn?.id, 9999);
    assert.equal(g.mainDeck.length, 0);
    assert.equal(g.mainDiscard.length, 0);
  });

  it("flipSplash reshuffles its own discard when the pile is empty", () => {
    const g = game(2, 1);
    g.splashPile = [];
    g.splashDiscard = ["hit"];
    assert.equal(flipSplash(g), "hit");
  });
});

describe("water fight engine: fuzz", () => {
  function playGame(pc: number, seed: number, policy: Policy, turnCap: number): GameState {
    let g = createGame(pc, seed, { turnCap }); // Events ON (default density) — fuzz exercises them
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
