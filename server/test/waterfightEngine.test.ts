// Water Fight engine — Phase A test suite (pure engine, no Colyseus).
// Mirrors splendorEngine.test.ts: rules unit tests + a fuzz suite that asserts
// every structural invariant after every reduce.
import assert from "node:assert/strict";
import { WaterFightEngine as WF, CARD_INFO, EVENT_DESCRIPTIONS, EVENT_NAMES } from "@backbone/shared";

const {
  createGame,
  applyMove: applyMoveRaw,
  applyResolution: applyResolutionRaw,
  legalMoves,
  legalResolutions,
  isGameOver,
  assertInvariants,
  drawMainCard,
  flipSplash,
  RandomPolicy,
  GreedyPolicy,
  MAIN_DECK_SIZE,
  validateWaterFightData,
} = WF;
type GameState = WF.GameState;
type CardKind = WF.CardKind;
type SplashCard = WF.SplashCard;
type Policy = WF.Policy;

// Throwing is now a TWO-step action: the throw commits, then the attacker flips the
// Splash Pile via DRAW_SPLASH. These thin wrappers auto-advance that trivial draw step
// so the combat unit tests below read the same post-flip ladder/miss outcome they did
// when the flip was automatic. (The fuzz harness uses the RAW engine so it still asserts
// invariants on the intermediate SPLASH_DRAW state. New tests that want to observe the
// draw explicitly call WF.applyMove / WF.applyResolution.)
function autoFlip(r: WF.ApplyResult): WF.ApplyResult {
  return r.awaiting.kind === "SPLASH_DRAW"
    ? applyResolutionRaw(r.state, { kind: "DRAW_SPLASH" })
    : r;
}
function applyMove(g: GameState, move: WF.Move): WF.ApplyResult {
  return autoFlip(applyMoveRaw(g, move));
}
function applyResolution(g: GameState, res: WF.Resolution): WF.ApplyResult {
  return autoFlip(applyResolutionRaw(g, res));
}

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

  it("the card pools are internally consistent (validateWaterFightData)", () => {
    // default deck, both dial extremes, and the max dial — every pool must stay
    // self-consistent and the main/shop/event id ranges must never collide.
    for (const [hit, miss] of [[20, 20], [0, 0], [0, 50], [50, 0], [50, 50]] as const) {
      assert.deepEqual(validateWaterFightData(hit, miss), [], `dials ${hit}/${miss} valid`);
    }
    // teeth: an absurd beyond-clamp dial overflows the main-deck ids into the
    // shop range (1000+) — the validator must catch it, not return clean.
    const overflow = validateWaterFightData(979, 0); // size = 41 + 979 = 1020 >= 1000
    assert.ok(overflow.some((m) => m.includes("shop range")), "overflowing the shop id range is flagged");
  });
});

describe("water fight engine: finalBlow (end-of-game reveal)", () => {
  it("a basic-throw kill records { attacker, victim, means:'basic' }", () => {
    const g = game(2, 5);
    g.players[1]!.lives = 1;
    setHand(g, 0, ["balloon"]);
    setHand(g, 1, []);
    forceSplash(g, "hit");
    let r = applyMove(g, { kind: "THROW", target: 1 });
    r = applyResolution(r.state, { kind: "DEFEND", defense: "pass" });
    assert.ok(r.state.over, "the soak ended the game");
    assert.deepEqual(r.state.finalBlow, { attacker: 0, victim: 1, means: "basic" });
  });

  it("a Lifeguard save records NO finalBlow (the `out` flag never flipped)", () => {
    const g = game(2, 5);
    g.players[1]!.lives = 1;
    setHand(g, 0, ["balloon"]);
    setHand(g, 1, ["lifeguard"]);
    forceSplash(g, "hit");
    let r = applyMove(g, { kind: "THROW", target: 1 });
    r = applyResolution(r.state, { kind: "DEFEND", defense: "pass" });
    assert.equal(r.state.finalBlow, null, "a save is not a soak");
    assert.equal(r.state.players[1]!.lives, 1, "bounced to 1 life");
    assert.ok(!r.state.over, "the game continues");
  });

  it("an Event kill records the event kind with attacker null (no thrower)", () => {
    const g = game(2, 5);
    g.players[0]!.lives = 1;
    g.players[1]!.lives = 1;
    setHand(g, 1, []);
    injectTopEvent(g, "lightning"); // seat 1's opening draw soaks the life-leader
    const r = applyMove(g, { kind: "END_TURN" }); // seat 0 ends -> seat 1 draws it
    assert.ok(r.state.over, "lightning soaked the last finalist");
    assert.equal(r.state.finalBlow?.attacker, null, "an Event has no attacker");
    assert.equal(r.state.finalBlow?.means, "lightning");
  });
});

describe("water fight engine: event stream + two-tier secrecy", () => {
  const mentions = (text: string, kind: string): boolean => new RegExp(`\\b${kind}\\b`, "i").test(text);

  it("a throw emits a public attack event, and the soak a public soak event", () => {
    const g = game(2, 5);
    g.players[1]!.lives = 1;
    setHand(g, 0, ["balloon"]);
    setHand(g, 1, []);
    forceSplash(g, "hit");
    // Use RAW applies so each reduce's events are observed (the auto-flip wrapper
    // would clear the throw's events with the next reduce).
    let r = applyMoveRaw(g, { kind: "THROW", target: 1 });
    assert.ok(r.state.events.some((e) => e.kind === "attack"), "throw emits an attack event");
    r = applyResolutionRaw(r.state, { kind: "DRAW_SPLASH" }); // flip → HIT → opens DEFEND
    r = applyResolutionRaw(r.state, { kind: "DEFEND", defense: "pass" });
    assert.ok(r.state.events.some((e) => e.kind === "soak"), "the soak emits a soak event");
  });

  it("Sabotage: the PUBLIC event never names the victim's hidden lost cards; the victim learns them privately", () => {
    const g = game(2, 5);
    setHand(g, 0, ["sabotage"]);
    setHand(g, 1, ["mega", "giant", "golden"]); // no towel → resolves immediately
    const r = applyMove(g, { kind: "PLAY_SUPPORT", support: "sabotage", target: 1 });
    const pub = r.state.events.find((e) => e.kind === "support");
    assert.ok(pub, "a public support event fired (naming Sabotage is fine — that's public)");
    // The SECRET part — which of the victim's cards were lost — must NOT be public.
    for (const secret of ["mega", "giant", "golden"]) {
      assert.ok(!mentions(pub!.text, secret), `public support event leaked the secret card "${secret}"`);
    }
    const lost = r.state.reveals.find((rv) => rv.kind === "lost" && rv.seat === 1);
    assert.ok(lost, "the victim gets a private 'lost' reveal");
    assert.strictEqual(lost!.cards.length, 2, "the 2 discarded cards are named privately to the victim");
  });

  it("Golden draw: the PUBLIC event never names the 2 drawn cards; the drawer learns them privately", () => {
    const g = game(3, 5); // 3p so a soak does not end the game
    g.players[0]!.hand.push({ id: 10000, kind: "golden" });
    setHand(g, 1, ["umbrella"]);
    // Stack the deck so the 2 Golden draws are KNOWN kinds (drawMainCard pops the tail).
    g.mainDeck.push({ id: 20001, kind: "mega" }, { id: 20002, kind: "giant" });
    let r = applyMove(g, { kind: "PLAY_BIG", big: "golden", target: 1 });
    r = applyResolution(r.state, { kind: "DEFEND", defense: "umbrella" }); // afterAttack draws 2
    const pub = r.state.events.find((e) => e.kind === "draw" && e.seat === 0);
    assert.ok(pub, "a public draw event fired (the COUNT is public)");
    for (const drawn of ["mega", "giant"]) {
      assert.ok(!r.state.events.some((e) => mentions(e.text, drawn)), `public events leaked the drawn card "${drawn}"`);
    }
    const drew = r.state.reveals.find((rv) => rv.kind === "drew" && rv.seat === 0);
    assert.ok(drew, "the drawer gets a private 'drew' reveal");
    assert.ok(
      drew!.cards.some((c) => c.kind === "mega") && drew!.cards.some((c) => c.kind === "giant"),
      "the 2 drawn cards are named privately to the drawer only",
    );
  });

  it("cardSwap and switcheroo emit NO lost/drew reveal (2-way swaps are excluded)", () => {
    for (const support of ["cardswap", "switcheroo"] as const) {
      const g = game(2, 5);
      setHand(g, 0, [support, "balloon"]);
      setHand(g, 1, ["mega", "giant"]);
      const r = applyMove(g, { kind: "PLAY_SUPPORT", support, target: 1 });
      assert.ok(!r.state.reveals.some((rv) => rv.kind === "lost" || rv.kind === "drew"), `${support} must not emit lost/drew`);
      assert.ok(r.state.events.some((e) => e.kind === "support"), `${support} still emits a public toast`);
    }
  });

  it("events are a fresh array each reduce (no growth)", () => {
    const g = game(2, 5);
    const r1 = applyMove(g, { kind: "END_TURN" });
    assert.ok(Array.isArray(r1.state.events), "events is an array");
    const r2 = applyMove(r1.state, { kind: "END_TURN" });
    assert.ok(Array.isArray(r2.state.events) && r2.state.events.every((e) => typeof e.kind === "string"), "fresh events only");
  });

  it("Shop: the PUBLIC buy event never names the bought card; the buyer learns it privately", () => {
    const g = game(2, 5, { shopCost: 4 });
    moveFromDeck(g, 0, "treasure", 2); // 2 Treasure = 4 coins
    g.stacks.defense.push({ id: 30001, kind: "umbrella" }); // SHOP pops the end → buys this
    const r = applyMove(g, { kind: "SHOP", sell: { balloons: 0, treasures: 2, wild: 0 }, buy: ["defense"] });
    const pub = r.state.events.find((e) => e.kind === "shop");
    assert.ok(pub, "a public shop event fired (the COUNT + stack is public)");
    assert.ok(!mentions(pub!.text, "umbrella"), "the public shop event never names the bought card");
    assert.strictEqual(pub!.detailKind, "", "shop carries no detailKind (the card is secret)");
    const bought = r.state.reveals.find((rv) => rv.kind === "bought" && rv.seat === 0);
    assert.ok(bought, "the buyer gets a private 'bought' reveal");
    assert.ok(bought!.cards.some((c) => c.kind === "umbrella"), "the specific bought card is named privately to the buyer");
  });

  it("a defensive Umbrella block emits a 'defend' event (detailKind=umbrella)", () => {
    const g = game(2, 5);
    setHand(g, 0, ["balloon"]);
    setHand(g, 1, ["umbrella"]);
    forceSplash(g, "hit");
    let r = applyMoveRaw(g, { kind: "THROW", target: 1 });
    r = applyResolutionRaw(r.state, { kind: "DRAW_SPLASH" }); // HIT → opens DEFEND
    r = applyResolutionRaw(r.state, { kind: "DEFEND", defense: "umbrella" });
    const def = r.state.events.find((e) => e.kind === "defend");
    assert.ok(def, "a block emits a defend event");
    assert.strictEqual(def!.detailKind, "umbrella", "and names the umbrella so the flourish can explain it");
  });

  it("a Wild-as-Miss block ALSO emits a 'defend' event (show-don't-hide, generic)", () => {
    const g = game(2, 5);
    setHand(g, 0, ["balloon"]);
    setHand(g, 1, ["wild"]);
    forceSplash(g, "hit");
    let r = applyMoveRaw(g, { kind: "THROW", target: 1 });
    r = applyResolutionRaw(r.state, { kind: "DRAW_SPLASH" }); // HIT → opens DEFEND
    r = applyResolutionRaw(r.state, { kind: "DEFEND", defense: "wild_miss" });
    const def = r.state.events.find((e) => e.kind === "defend");
    assert.ok(def, "a Wild block is surfaced, not silent (it sets neither umbrella nor missBlocks)");
    assert.strictEqual(def!.detailKind, "", "generic block — only an Umbrella gets a named detailKind");
  });

  it("a plain miss (splash-flip whiff) emits NO defend event", () => {
    const g = game(2, 5);
    setHand(g, 0, ["balloon"]);
    setHand(g, 1, []); // no defense card
    forceSplash(g, "miss"); // the throw whiffs on the flip — routes via afterAttack, not resolveTarget
    let r = applyMoveRaw(g, { kind: "THROW", target: 1 });
    r = applyResolutionRaw(r.state, { kind: "DRAW_SPLASH" }); // MISS
    assert.ok(!r.state.events.some((e) => e.kind === "defend"), "no defend on a whiff (the splash-MISS reveal shows it)");
  });

  it("a Sudden-Death AoE suppression emits NO defend event (the distinct `!suppressed` branch)", () => {
    // A suppressed multi-target hit reaches resolveTarget's `else` with suppressed=true —
    // separate from the plain-whiff case above. The `!suppressed` guard must drop the defend.
    const g = game(3, 5);
    g.phase = "sudden-death";
    g.players[0]!.lives = 1;
    g.players[1]!.lives = 1;
    g.players[2]!.lives = 1;
    setHand(g, 0, ["flashflood"]);
    setHand(g, 1, []);
    setHand(g, 2, []);
    const kinds: string[] = [];
    let r = applyMoveRaw(g, { kind: "FLASH_FLOOD" }); // 3p → targets [1,2] → suppressed
    kinds.push(...r.state.events.map((e) => e.kind));
    for (let i = 0; i < 4 && r.awaiting.kind === "DEFEND"; i++) {
      r = applyResolutionRaw(r.state, { kind: "DEFEND", defense: "pass" });
      kinds.push(...r.state.events.map((e) => e.kind));
    }
    assert.ok(!kinds.includes("defend"), "a Sudden-Death AoE suppression never emits a defend");
    assert.ok(!kinds.includes("damage"), "and deals no damage (E9)");
  });

  it("the greedy bot never shops — so there is no bot→shop event path to test", () => {
    // The `shop` event's funnel coverage rests on afterApply (shared by human + bot applies),
    // and the human-shop wire test proves it. A bot can never trigger it: GreedyPolicy.move()
    // only ever THROWs or ENDs the turn. This pins that, so "cover bot-shop" isn't a real gap.
    const g = game(2, 5, { shopCost: 1 });
    moveFromDeck(g, 0, "treasure", 6); // 12 coins → SHOP is affordable and a legal move
    assert.ok(legalMoves(g).some((m) => m.kind === "SHOP"), "SHOP is a legal option in this state");
    const policy = new GreedyPolicy(1);
    for (let i = 0; i < 25; i++) {
      assert.notEqual(policy.move(g).kind, "SHOP", "GreedyPolicy only THROWs or ENDs — never SHOP");
    }
  });

  it("events carry the specific PUBLIC detailKind (support/attack/event)", () => {
    const gs = game(2, 5);
    setHand(gs, 0, ["sabotage"]);
    setHand(gs, 1, ["mega"]);
    const rs = applyMove(gs, { kind: "PLAY_SUPPORT", support: "sabotage", target: 1 });
    assert.strictEqual(rs.state.events.find((e) => e.kind === "support")?.detailKind, "sabotage");

    const ga = game(2, 5);
    setHand(ga, 0, ["balloon"]);
    forceSplash(ga, "hit");
    const ra = applyMoveRaw(ga, { kind: "THROW", target: 1 });
    assert.strictEqual(ra.state.events.find((e) => e.kind === "attack")?.detailKind, "balloon");

    const ge = game(2, 5);
    injectTopEvent(ge, "mudslide");
    const re = applyMove(ge, { kind: "END_TURN" }); // next seat draws + resolves the event
    assert.strictEqual(re.state.events.find((e) => e.kind === "event")?.detailKind, "mudslide");

    // react names the defense card played (public)
    const gr = game(2, 5);
    setHand(gr, 0, ["balloon"]);
    setHand(gr, 1, ["towel"]);
    let rr = applyMoveRaw(gr, { kind: "THROW", target: 1 }); // opens a REACT window (towel available)
    rr = applyResolutionRaw(rr.state, { kind: "REACT", action: "towel" });
    assert.strictEqual(rr.state.events.find((e) => e.kind === "react")?.detailKind, "towel");

    // a post-hit CONSEQUENCE (damage) carries NO detailKind — damageSeat doesn't know the attack kind
    const gd = game(2, 5);
    gd.players[1]!.lives = 3;
    setHand(gd, 0, ["balloon"]);
    setHand(gd, 1, []);
    forceSplash(gd, "hit");
    let rd = applyMoveRaw(gd, { kind: "THROW", target: 1 });
    rd = applyResolutionRaw(rd.state, { kind: "DRAW_SPLASH" });
    rd = applyResolutionRaw(rd.state, { kind: "DEFEND", defense: "pass" });
    assert.strictEqual(rd.state.events.find((e) => e.kind === "damage")?.detailKind, "");
  });
});

describe("water fight engine: EVENT_DESCRIPTIONS (player-facing effects)", () => {
  it("has a one-line effect for EVERY Event kind (so a drawn Event explains itself)", () => {
    for (const kind of Object.keys(EVENT_NAMES) as WF.EventKind[]) {
      const desc = EVENT_DESCRIPTIONS[kind];
      assert.ok(desc && desc.trim().length > 0, `EVENT_DESCRIPTIONS is missing an effect for "${kind}"`);
    }
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

  it("a throw awaits the attacker's interactive Splash draw, then resolves on DRAW_SPLASH", () => {
    // MISS: throw -> SPLASH_DRAW on the thrower -> DRAW_SPLASH -> turn advances, no ladder.
    let g = game(2, 5);
    setHand(g, 0, ["balloon"]);
    forceSplash(g, "miss");
    let r = applyMoveRaw(g, { kind: "THROW", target: 1 });
    assert.equal(r.awaiting.kind, "SPLASH_DRAW", "the throw waits for the draw");
    assert.equal(r.awaiting.seats[0], 0, "the ATTACKER draws");
    assert.equal(r.state.lastSplash, null, "no flip recorded until the draw");
    r = applyResolutionRaw(r.state, { kind: "DRAW_SPLASH" });
    assert.equal(r.state.lastSplash?.verdict, "miss");
    assert.equal(r.state.lastSplash?.seq, 1, "seq advances on the flip");
    assert.equal(r.awaiting.kind, "MOVE", "a Miss ends the attack");
    assert.equal(r.state.players[1]!.lives, 3);

    // HIT: throw -> SPLASH_DRAW -> DRAW_SPLASH opens the defense ladder.
    g = game(2, 5);
    setHand(g, 0, ["balloon"]);
    setHand(g, 1, []);
    forceSplash(g, "hit");
    r = applyMoveRaw(g, { kind: "THROW", target: 1 });
    assert.equal(r.awaiting.kind, "SPLASH_DRAW");
    r = applyResolutionRaw(r.state, { kind: "DRAW_SPLASH" });
    assert.equal(r.state.lastSplash?.verdict, "hit");
    assert.equal(r.awaiting.kind, "DEFEND", "a Hit opens the ladder");
    assert.equal(r.awaiting.seats[0], 1, "the defender now acts");
  });

  it("DRAW_SPLASH is illegal unless the engine awaits a Splash draw", () => {
    const g = game(2, 5);
    setHand(g, 0, ["balloon"]);
    // At MOVE, DRAW_SPLASH must be rejected.
    assert.throws(() => applyResolutionRaw(g, { kind: "DRAW_SPLASH" }), /not awaiting a splash draw|must draw/);
    // During SPLASH_DRAW, only DRAW_SPLASH is legal.
    forceSplash(g, "hit");
    const r = applyMoveRaw(g, { kind: "THROW", target: 1 });
    assert.deepEqual(legalResolutions(r.state), [{ kind: "DRAW_SPLASH" }]);
    assert.throws(() => applyResolutionRaw(r.state, { kind: "DEFEND", defense: "pass" }), /must draw the splash/);
  });

  it("a Storm Cloud's STORM_THROW awaits its OWN interactive Splash draw (an out seat is legal here)", () => {
    const g = game(3, 5);
    g.players[2]!.lives = 0;
    g.players[2]!.out = true;
    g.players[2]!.stormCloud = true;
    setHand(g, 0, []);
    setHand(g, 1, []);
    setHand(g, 2, ["balloon"]);
    g.turnSeat = 2;
    g.awaiting = { seats: [2], kind: "MOVE" };
    // No splash override: STORM_THROW stops at SPLASH_DRAW before any flip, so the
    // default 20-card pile stays conserved for assertInvariants below.
    const r = applyMoveRaw(g, { kind: "STORM_THROW" });
    assert.equal(r.awaiting.kind, "SPLASH_DRAW");
    assert.equal(r.awaiting.seats[0], 2, "the soaked Storm Cloud draws its own flip");
    assertInvariants(r.state); // exercises the relaxed stormOk branch for SPLASH_DRAW
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

describe("water fight engine: Flash Flood (G5)", () => {
  it("auto-connects and soaks every opponent for 2 (each can block)", () => {
    const g = game(3, 5);
    setHand(g, 0, ["flashflood"]);
    setHand(g, 1, []); // takes it
    setHand(g, 2, ["miss"]); // blocks it
    let r = applyMove(g, { kind: "FLASH_FLOOD" });
    assert.equal(r.awaiting.kind, "DEFEND");
    assert.equal(r.awaiting.seats[0], 1, "no flip — straight to each opponent's ladder");
    r = applyResolution(r.state, { kind: "DEFEND", defense: "pass" }); // seat 1 takes 2
    assert.equal(r.awaiting.seats[0], 2);
    r = applyResolution(r.state, { kind: "DEFEND", defense: "miss" }); // one block stops a basic-block attack
    assert.equal(r.awaiting.kind, "ATTACKER_RESPOND");
    r = applyResolution(r.state, { kind: "ATTACKER_RESPOND", respond: "pass" });
    assert.equal(r.state.players[1]!.lives, 1, "seat 1 took 2");
    assert.equal(r.state.players[2]!.lives, 3, "seat 2 blocked it with a Miss");
  });

  it("a Launcher grants an extra throw after a Flash Flood (E4)", () => {
    const g = game(3, 5);
    setHand(g, 0, ["flashflood", "launcher", "balloon"]);
    setHand(g, 1, []);
    setHand(g, 2, []);
    let r = applyMove(g, { kind: "FLASH_FLOOD" });
    r = applyResolution(r.state, { kind: "DEFEND", defense: "pass" });
    r = applyResolution(r.state, { kind: "DEFEND", defense: "pass" });
    assert.equal(r.awaiting.kind, "EXTRA_THROW", "Flash Flood is an attack, so Launcher applies");
    assert.equal(r.awaiting.seats[0], 0);
  });

  it("a Flash Flood that drops an opponent to 0 soaks them into a Storm Cloud", () => {
    const g = game(3, 9);
    g.players[1]!.lives = 1; // seat 2 stays at the default starting lives
    setHand(g, 0, ["flashflood"]);
    setHand(g, 1, []);
    setHand(g, 2, []);
    let r = applyMove(g, { kind: "FLASH_FLOOD" });
    r = applyResolution(r.state, { kind: "DEFEND", defense: "pass" }); // seat 1: -2 -> soaked
    r = applyResolution(r.state, { kind: "DEFEND", defense: "pass" }); // seat 2: -2 -> 1
    assert.equal(r.state.players[1]!.out, true, "seat 1 soaked by the flood");
    assert.equal(r.state.players[1]!.stormCloud, true, "soaked in normal play -> Storm Cloud");
    assert.equal(r.state.players[2]!.lives, 1);
    assert.equal(r.state.over, false, "seat 2 survived");
  });

  it("a Water Trap during a Flash Flood bounces only that instance back at the attacker", () => {
    const g = game(3, 13);
    setHand(g, 0, ["flashflood"]);
    setHand(g, 1, []);
    setHand(g, 2, ["watertrap"]);
    let r = applyMove(g, { kind: "FLASH_FLOOD" }); // targets [1, 2], 2 damage each
    r = applyResolution(r.state, { kind: "DEFEND", defense: "pass" }); // seat 1 takes 2
    assert.equal(r.awaiting.kind, "REACT", "seat 2 (holding a Water Trap) gets a window");
    assert.equal(r.awaiting.seats[0], 2);
    r = applyResolution(r.state, { kind: "REACT", action: "watertrap" });
    assert.equal(r.awaiting.seats[0], 0, "the attacker now defends the bounced flood instance");
    r = applyResolution(r.state, { kind: "DEFEND", defense: "pass" });
    assert.equal(r.state.players[1]!.lives, 1, "seat 1 took the flood");
    assert.equal(r.state.players[2]!.lives, 3, "seat 2 bounced its instance — unharmed");
    assert.equal(r.state.players[0]!.lives, 1, "the attacker took the bounced 2");
  });

  it("deals nothing in Sudden-Death (E9 suppresses table-wide damage)", () => {
    const g = game(3, 5);
    g.phase = "sudden-death";
    g.players[0]!.lives = 1;
    g.players[1]!.lives = 1;
    g.players[2]!.lives = 1;
    setHand(g, 0, ["flashflood"]);
    setHand(g, 1, []);
    setHand(g, 2, []);
    let r = applyMove(g, { kind: "FLASH_FLOOD" });
    r = applyResolution(r.state, { kind: "DEFEND", defense: "pass" });
    r = applyResolution(r.state, { kind: "DEFEND", defense: "pass" });
    assert.equal(r.state.players[1]!.lives, 1, "suppressed");
    assert.equal(r.state.players[2]!.lives, 1, "suppressed");
    assert.equal(r.state.over, false, "no Sudden-Death wipe");
  });
});

describe("water fight engine: full-fidelity AoE (G4)", () => {
  it("each splash victim reacts to their OWN instance; one peeling doesn't spare the others (R3)", () => {
    const g = game(3, 7);
    setHand(g, 0, ["balloon", "splashzone"]);
    setHand(g, 1, ["towel"]); // seat 1 Towels its own splash
    setHand(g, 2, []); // seat 2 has nothing — gets soaked
    forceSplash(g, "hit");
    let r = applyMove(g, { kind: "THROW", target: 1, spread: { modifier: "splashzone", extraTargets: [] } });
    assert.equal(r.awaiting.kind, "REACT", "the first victim gets its own reaction window");
    assert.equal(r.awaiting.seats[0], 1);
    r = applyResolution(r.state, { kind: "REACT", action: "towel" }); // peels seat 1 only
    assert.equal(r.awaiting.kind, "DEFEND", "the next victim still has to defend");
    assert.equal(r.awaiting.seats[0], 2);
    r = applyResolution(r.state, { kind: "DEFEND", defense: "pass" });
    assert.equal(r.state.players[1]!.lives, 3, "seat 1 Towelled its splash — unharmed");
    assert.equal(r.state.players[2]!.lives, 2, "seat 2 still got soaked");
  });

  it("a victim's Redirect peels only their instance and reroutes it", () => {
    const g = game(4, 5);
    setHand(g, 0, ["balloon", "splashzone"]);
    setHand(g, 1, []);
    setHand(g, 2, ["redirect"]); // seat 2 redirects its splash to the attacker
    setHand(g, 3, []);
    forceSplash(g, "hit");
    let r = applyMove(g, { kind: "THROW", target: 1, spread: { modifier: "splashzone", extraTargets: [] } });
    r = applyResolution(r.state, { kind: "DEFEND", defense: "pass" }); // seat 1 soaked
    assert.equal(r.awaiting.seats[0], 2, "seat 2's reaction window");
    r = applyResolution(r.state, { kind: "REACT", action: "redirect", target: 0 }); // -> the attacker
    assert.equal(r.awaiting.seats[0], 0, "the attacker now defends seat 2's instance");
    r = applyResolution(r.state, { kind: "DEFEND", defense: "pass" });
    assert.equal(r.awaiting.seats[0], 3, "seat 3's own instance still lands");
    r = applyResolution(r.state, { kind: "DEFEND", defense: "pass" });
    assert.equal(r.state.players[1]!.lives, 2, "seat 1 soaked");
    assert.equal(r.state.players[2]!.lives, 3, "seat 2 peeled its own instance — unharmed");
    assert.equal(r.state.players[3]!.lives, 2, "seat 3 soaked");
    assert.equal(r.state.players[0]!.lives, 2, "the attacker took the redirected instance");
  });

  it("a redirected splash gives the NEW victim its own reaction window (review fix)", () => {
    const g = game(4, 5);
    setHand(g, 0, ["balloon", "triplesplash"]);
    setHand(g, 1, ["redirect"]);
    setHand(g, 2, []);
    setHand(g, 3, ["towel"]); // NOT an original target — gets redirected onto
    forceSplash(g, "hit");
    let r = applyMove(g, { kind: "THROW", target: 1, spread: { modifier: "triplesplash", extraTargets: [2] } });
    assert.equal(r.awaiting.seats[0], 1);
    r = applyResolution(r.state, { kind: "REACT", action: "redirect", target: 3 }); // seat 1 -> seat 3
    assert.equal(r.awaiting.kind, "REACT", "the redirected-onto victim gets its OWN window");
    assert.equal(r.awaiting.seats[0], 3);
    r = applyResolution(r.state, { kind: "REACT", action: "towel" }); // seat 3 peels the redirected instance
    assert.equal(r.awaiting.seats[0], 2, "seat 2's own instance still resolves");
    r = applyResolution(r.state, { kind: "DEFEND", defense: "pass" });
    assert.equal(r.state.players[1]!.lives, 3, "seat 1 redirected away");
    assert.equal(r.state.players[3]!.lives, 3, "seat 3 Towelled the redirected instance");
    assert.equal(r.state.players[2]!.lives, 2, "seat 2 still soaked");
  });

  it("a Redirect cannot target a seat already in the splash (no double-soak — review fix)", () => {
    const g = game(3, 7);
    setHand(g, 0, ["balloon", "splashzone"]);
    setHand(g, 1, ["redirect"]);
    setHand(g, 2, []);
    forceSplash(g, "hit");
    let r = applyMove(g, { kind: "THROW", target: 1, spread: { modifier: "splashzone", extraTargets: [] } });
    assert.equal(r.awaiting.seats[0], 1);
    const opts = legalResolutions(r.state).filter((o) => o.kind === "REACT" && o.action === "redirect") as { target: number }[];
    assert.ok(!opts.some((o) => o.target === 2), "an existing target (seat 2) is NOT offered");
    assert.ok(opts.some((o) => o.target === 0), "the attacker IS a valid redirect target");
    assert.throws(() => applyResolution(r.state, { kind: "REACT", action: "redirect", target: 2 }), /existing splash target/);
  });

  it("a victim's Water Trap bounces only their instance back at the attacker", () => {
    const g = game(3, 9);
    setHand(g, 0, ["balloon", "splashzone"]);
    setHand(g, 1, []);
    setHand(g, 2, ["watertrap"]);
    forceSplash(g, "hit");
    let r = applyMove(g, { kind: "THROW", target: 1, spread: { modifier: "splashzone", extraTargets: [] } });
    r = applyResolution(r.state, { kind: "DEFEND", defense: "pass" }); // seat 1 soaked
    assert.equal(r.awaiting.seats[0], 2);
    r = applyResolution(r.state, { kind: "REACT", action: "watertrap" });
    assert.equal(r.awaiting.seats[0], 0, "the attacker now defends the bounced instance");
    r = applyResolution(r.state, { kind: "DEFEND", defense: "pass" });
    assert.equal(r.state.players[1]!.lives, 2, "seat 1 soaked");
    assert.equal(r.state.players[2]!.lives, 3, "seat 2 bounced its own instance — unharmed");
    assert.equal(r.state.players[0]!.lives, 2, "the attacker took the bounce");
  });

  it("a Mega WITH a spread opens per-target windows and runs the 2-block ladder for each", () => {
    const g = game(3, 5);
    setHand(g, 0, ["mega", "splashzone"]);
    setHand(g, 1, ["miss", "miss"]); // two blocks fully stop a Mega
    setHand(g, 2, []);
    let r = applyMove(g, { kind: "PLAY_BIG", big: "mega", target: 1, spread: { modifier: "splashzone", extraTargets: [] } });
    assert.equal(r.awaiting.seats[0], 1);
    r = applyResolution(r.state, { kind: "DEFEND", defense: "miss" });
    assert.equal(r.awaiting.kind, "DEFEND", "Mega needs 2 blocks — still on seat 1");
    r = applyResolution(r.state, { kind: "DEFEND", defense: "miss" });
    r = applyResolution(r.state, { kind: "ATTACKER_RESPOND", respond: "pass" });
    assert.equal(r.awaiting.seats[0], 2, "the next victim's own ladder opens");
    r = applyResolution(r.state, { kind: "DEFEND", defense: "pass" });
    assert.equal(r.state.players[1]!.lives, 3, "seat 1 fully blocked the Mega");
    assert.equal(r.state.players[2]!.lives, 2, "seat 2 took 1 (Mega damage)");
  });

  it("Soaker + spread negates each victim's hand-Miss across the splash (R2)", () => {
    const g = game(3, 5);
    setHand(g, 0, ["balloon", "splashzone", "soaker"]);
    setHand(g, 1, ["miss"]); // would block, but Soaker negates it
    setHand(g, 2, []);
    forceSplash(g, "hit");
    let r = applyMove(g, { kind: "THROW", target: 1, soaker: true, spread: { modifier: "splashzone", extraTargets: [] } });
    assert.equal(r.awaiting.seats[0], 1);
    assert.ok(
      !legalResolutions(r.state).some((o) => o.kind === "DEFEND" && o.defense === "miss"),
      "Soaker removes the Miss option for a splash victim",
    );
    r = applyResolution(r.state, { kind: "DEFEND", defense: "pass" });
    r = applyResolution(r.state, { kind: "DEFEND", defense: "pass" });
    assert.equal(r.state.players[1]!.lives, 2, "Soaker negated seat 1's Miss");
    assert.equal(r.state.players[2]!.lives, 2);
  });

  it("MAX_REACTIONS caps each splash target's ladder independently (resets per target)", () => {
    const g = game(3, 5, { maxReactions: 2 });
    setHand(g, 0, ["balloon", "splashzone", "hit"]);
    setHand(g, 1, ["miss", "miss"]);
    setHand(g, 2, []);
    forceSplash(g, "hit");
    let r = applyMove(g, { kind: "THROW", target: 1, spread: { modifier: "splashzone", extraTargets: [] } });
    r = applyResolution(r.state, { kind: "DEFEND", defense: "miss" }); // round 1
    r = applyResolution(r.state, { kind: "ATTACKER_RESPOND", respond: "hit" }); // round 2
    r = applyResolution(r.state, { kind: "DEFEND", defense: "miss" }); // round 3 > cap -> seat 1 resolves
    assert.equal(r.awaiting.seats[0], 2, "seat 2's instance opens with a fresh (reset) cap");
    r = applyResolution(r.state, { kind: "DEFEND", defense: "pass" });
    assert.ok(["MOVE", "DISCARD", "GAME_OVER"].includes(r.state.awaiting.kind) || r.state.over, "the AoE finished cleanly");
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

  it("Goggles near deck-out reveals only what remains (no error)", () => {
    const g = game(2, 5);
    g.players[0]!.hand.push({ id: 10001, kind: "goggles" });
    g.mainDeck = [{ id: 5, kind: "balloon" }]; // one card left
    const r = applyMove(g, { kind: "PLAY_SUPPORT", support: "goggles" });
    assert.equal(r.state.reveals[0]!.cards.length, 1, "reveals just the remaining card");

    const g2 = game(2, 7);
    g2.players[0]!.hand.push({ id: 10001, kind: "goggles" });
    g2.mainDeck = [];
    const r2 = applyMove(g2, { kind: "PLAY_SUPPORT", support: "goggles" });
    assert.equal(r2.state.reveals[0]!.cards.length, 0, "empty deck -> empty reveal, no throw");
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

  it("a Storm Cloud's SECOND throw can end the game mid-multi-throw", () => {
    const g = game(4, 11, { stormThrows: 2 });
    g.players[3]!.lives = 0;
    g.players[3]!.out = true;
    g.players[3]!.stormCloud = true;
    setHand(g, 3, ["balloon", "balloon"]);
    for (const seat of [0, 1, 2]) {
      g.players[seat]!.lives = 1;
      setHand(g, seat, []);
    }
    g.turnSeat = 3;
    g.awaiting = { seats: [3], kind: "MOVE" };
    g.splashPile = ["hit", "hit", "hit", "hit", "hit", "hit"];
    let r = applyMove(g, { kind: "STORM_THROW" }); // soaks one of {0,1,2}
    r = applyResolution(r.state, { kind: "DEFEND", defense: "pass" });
    assert.equal(r.state.awaiting.kind, "MOVE", "two living remain -> the Storm Cloud throws again");
    assert.equal(r.state.over, false);
    r = applyMove(r.state, { kind: "STORM_THROW" }); // soaks a second -> one living left
    r = applyResolution(r.state, { kind: "DEFEND", defense: "pass" });
    assert.equal(r.state.over, true, "the second throw soaked the second-to-last -> game ends");
    assert.equal(r.state.players[r.state.winner!]!.out, false, "the winner is the lone survivor");
  });

  it("a Storm Cloud's drawn Event is voided and still consumes a draw slot", () => {
    const g = game(3, 5, { stormDraw: 2 });
    g.players[2]!.lives = 0;
    g.players[2]!.out = true;
    g.players[2]!.stormCloud = true;
    setHand(g, 2, []);
    injectTopEvent(g, "mudslide"); // drawn first; a Storm Cloud's Event has no effect
    g.turnSeat = 1;
    g.awaiting = { seats: [1], kind: "MOVE" };
    const r = applyMove(g, { kind: "END_TURN" }); // -> seat 2's Storm Cloud turn
    assert.equal(r.state.turnSeat, 2);
    assert.equal(r.state.players[0]!.lives, 3, "the voided Event dealt no table damage");
    assert.equal(r.state.players[1]!.lives, 3);
    assert.equal(r.state.players[2]!.hand.length, 1, "stormDraw 2: the Event ate a slot, only 1 real card drawn");
  });

  it("a custom-deck game reshuffles its discard against the dialed mainIdMax", () => {
    const g = createGame(2, 5, { mainHit: 5, mainMiss: 5, eventDensity: 0 });
    g.mainDiscard.push(...g.mainDeck.splice(0)); // drain the deck into the discard
    assert.equal(g.mainDeck.length, 0);
    const drawn = drawMainCard(g); // forces a reshuffle
    assert.ok(drawn, "reshuffled the dialed discard into a fresh deck");
    g.players[0]!.hand.push(drawn!); // keep conservation (the drawn card now lives in a hand)
    assertInvariants(g); // conserves against mainIdMax = 51, not the default
  });

  it("the deck dial accepts 0 Hit (or 0 Miss) hand-cards", () => {
    const g0 = createGame(3, 5, { mainHit: 0, eventDensity: 0 });
    assert.equal(g0.mainIdMax, 61, "20 balloon + 20 miss + 0 hit + 20 treasure + 1 wild");
    const hits = [...g0.mainDeck, ...g0.players.flatMap((p) => p.hand)].filter((c) => c.kind === "hit").length;
    assert.equal(hits, 0, "no Hit hand-cards exist when the dial is 0");
    assertInvariants(g0);
    const g1 = createGame(3, 7, { mainMiss: 0, eventDensity: 0 });
    assert.equal(g1.mainIdMax, 61);
    assertInvariants(g1);
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
      // Raw engine: each reduce (incl. the SPLASH_DRAW flip) is its own step so the
      // invariant check runs on the intermediate draw state too.
      g = g.awaiting.kind === "MOVE" ? applyMoveRaw(g, policy.move(g)).state : applyResolutionRaw(g, policy.resolve(g)).state;
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

describe("water fight: log shows player names", () => {
  it("a throw logs the players' names, not 'seat N'", () => {
    const g = game(2, 5);
    g.players[0]!.name = "Alice";
    g.players[1]!.name = "Bob";
    setHand(g, 0, ["balloon"]);
    forceSplash(g, "miss");
    let r = applyMoveRaw(g, { kind: "THROW", target: 1 });
    r = applyResolutionRaw(r.state, { kind: "DRAW_SPLASH" });
    const line = r.state.log.find((l) => l.includes("throws at"));
    assert.ok(line, "a throw line was logged");
    assert.ok(line!.includes("Alice") && line!.includes("Bob"), `names in the log line: ${line}`);
    assert.ok(!line!.includes("seat 0") && !line!.includes("seat 1"), `no raw seat index: ${line}`);
  });

  it("a blank name falls back to 'seat N'", () => {
    const g = game(2, 6);
    g.players[0]!.name = "  "; // blank
    setHand(g, 0, ["balloon"]);
    forceSplash(g, "miss");
    let r = applyMoveRaw(g, { kind: "THROW", target: 1 });
    r = applyResolutionRaw(r.state, { kind: "DRAW_SPLASH" });
    const line = r.state.log.find((l) => l.includes("throws at"));
    assert.ok(line && line.includes("seat 0"), `blank name → seat fallback: ${line}`);
  });
});

describe("water fight: CARD_INFO (player-facing card reference)", () => {
  // The canonical set of every card kind a player can draw or buy, derived from the
  // authoritative deck/stack data — NOT a re-typed list (so it can't drift). `event`
  // is a real CardKind that lives in no composition (seeded separately, see save.ts).
  const expectedKinds = [
    ...Object.keys(WF.MAIN_DECK_COMPOSITION),
    "event",
    ...Object.keys(WF.STACK_COMPOSITIONS.defense),
    ...Object.keys(WF.STACK_COMPOSITIONS.mischief),
    ...Object.keys(WF.STACK_COMPOSITIONS.attack),
  ];
  const info = CARD_INFO as Record<string, { label: string; desc: string; stack?: string } | undefined>;

  it("has a labelled, non-empty description for every card kind", () => {
    for (const kind of expectedKinds) {
      assert.ok(info[kind], `CARD_INFO missing entry for "${kind}"`);
      assert.ok((info[kind]!.desc ?? "").trim().length > 0, `CARD_INFO["${kind}"] has an empty desc`);
      assert.ok((info[kind]!.label ?? "").trim().length > 0, `CARD_INFO["${kind}"] has an empty label`);
    }
  });

  it("tags each shop card with the stack it actually appears in (Help groups by this)", () => {
    for (const stack of ["defense", "mischief", "attack"] as const) {
      for (const kind of Object.keys(WF.STACK_COMPOSITIONS[stack])) {
        assert.equal(info[kind]?.stack, stack, `CARD_INFO["${kind}"].stack should be "${stack}"`);
      }
    }
  });

  it("leaves main-deck cards (incl. event) without a stack", () => {
    for (const kind of [...Object.keys(WF.MAIN_DECK_COMPOSITION), "event"]) {
      assert.equal(info[kind]?.stack, undefined, `CARD_INFO["${kind}"] should have no stack`);
    }
  });
});
