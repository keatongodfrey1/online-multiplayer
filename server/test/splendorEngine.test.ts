// The Splendor engine's own test suite, ported from
// splendor/packages/engine/test/ (node:test -> mocha). Assertions are kept
// verbatim so any behavior drift introduced by the port fails loudly.
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { SplendorEngine } from "@backbone/shared";

const {
  GAME_DATA,
  validateGameData,
  createGame,
  legalMoves,
  isLegalMove,
  applyMove,
  applyPass,
  applyResolution,
  affordable,
  playerPoints,
  totalTokens,
  redact,
  ranking,
  isGameOver,
  GreedyPolicy,
  RandomPolicy,
  assertInvariants,
} = SplendorEngine;
type Card = SplendorEngine.Card;
type GameState = SplendorEngine.GameState;
type Policy = SplendorEngine.Policy;

describe("splendor engine: data", () => {
  it("embedded GAME_DATA passes all code-level checks", () => {
    const failures = validateGameData(GAME_DATA);
    assert.deepEqual(failures, [], `data validation failures:\n${failures.join("\n")}`);
  });

  it("embedded GAME_DATA matches the canonical data/splendor_data.json (no drift)", () => {
    const here = dirname(fileURLToPath(import.meta.url));
    const path = join(here, "..", "..", "splendor", "packages", "engine", "data", "splendor_data.json");
    if (!existsSync(path)) {
      console.warn("canonical JSON not found; skipping drift check");
      return;
    }
    const onDisk = JSON.parse(readFileSync(path, "utf8"));
    // Compare the parts the engine relies on.
    assert.deepEqual(JSON.parse(JSON.stringify(GAME_DATA.cards)), onDisk.cards, "cards drifted from JSON — run npm run gen:data");
    assert.deepEqual(JSON.parse(JSON.stringify(GAME_DATA.nobles)), onDisk.nobles, "nobles drifted from JSON — run npm run gen:data");
  });
});

describe("splendor engine: rules", () => {
  it("createGame is deterministic for a given seed", () => {
    const a = createGame(4, 12345);
    const b = createGame(4, 12345);
    assert.deepEqual(a, b);
  });

  it("setup is correct for 4 players", () => {
    const g = createGame(4, 7);
    for (const c of ["white", "blue", "green", "red", "black"] as const) assert.equal(g.supplyGems[c], 7);
    assert.equal(g.supplyGold, 5);
    assert.equal(g.nobles.length, 5); // players + 1
    assert.equal(g.decks[1].length, 36);
    assert.equal(g.decks[2].length, 26);
    assert.equal(g.decks[3].length, 16);
    for (const t of [1, 2, 3] as const) assert.equal(g.market[t].filter(Boolean).length, 4);
    assertInvariants(g);
  });

  it("opening legal moves: 10 take-three, 5 take-two, 15 reserves, 0 buys", () => {
    const g = createGame(4, 7);
    const m = legalMoves(g);
    assert.equal(m.filter((x) => x.kind === "TAKE_THREE").length, 10);
    assert.equal(m.filter((x) => x.kind === "TAKE_TWO").length, 5);
    assert.equal(m.filter((x) => x.kind === "RESERVE").length, 15);
    assert.equal(m.filter((x) => x.kind === "BUY").length, 0);
  });

  it("purchase spends gems then gold and never goes negative (the §7 regression)", () => {
    const g = createGame(2, 7);
    const p = g.players[0]!;
    // a real 1-point tier-1 card costs 4 of a single color
    const card = g.decks[1].find((c) => c.points === 1)!;
    g.decks[1] = g.decks[1].filter((c) => c.id !== card.id); // move the card out of the deck (conservation)
    const col = (Object.keys(card.cost) as ("white" | "blue" | "green" | "red" | "black")[]).find(
      (c) => card.cost[c] === 4,
    )!;
    p.reserved.push(card);
    p.gems[col] = 3; // 3 gems + 1 gold should exactly cover a cost of 4
    g.supplyGems[col] -= 3; // take those from the bank (conservation)
    p.gold = 1;
    g.supplyGold -= 1;
    assert.ok(affordable(card, p));
    const res = applyMove(g, { kind: "BUY", from: { reserve: { cardId: card.id } } });
    const np = res.state.players[0]!;
    assert.equal(np.gems[col], 0, "gems spent");
    assert.equal(np.gold, 0, "gold spent to exactly 0, not negative");
    assert.equal(np.built.length, 1);
    assert.equal(np.bonuses[card.bonus], 1);
    assertInvariants(res.state);
  });

  it("free purchase (bonuses cover the whole cost) costs zero tokens", () => {
    const g = createGame(2, 9);
    const p = g.players[0]!;
    const free: Card = { id: 9001, tier: 1, bonus: "white", points: 1, cost: { white: 0, blue: 0, green: 0, red: 0, black: 0 } };
    p.reserved.push(free);
    const before = totalTokens(p);
    const res = applyMove(g, { kind: "BUY", from: { reserve: { cardId: 9001 } } });
    assert.equal(totalTokens(res.state.players[0]!), before, "no tokens spent on a free card");
    assert.equal(res.state.players[0]!.built.length, 1);
  });

  it("take-three with only two colors available offers exactly that pair; 3 distinct is illegal", () => {
    const g = createGame(2, 11);
    for (const c of ["green", "red", "black"] as const) g.supplyGems[c] = 0; // leave white, blue
    const m = legalMoves(g);
    const t3 = m.filter((x) => x.kind === "TAKE_THREE");
    assert.equal(t3.length, 1);
    assert.deepEqual((t3[0] as { colors: string[] }).colors.sort(), ["blue", "white"]);
    assert.equal(isLegalMove(g, { kind: "TAKE_THREE", colors: ["white", "blue", "green"] }), false);
  });

  it("end game (immediate mode): reaching 15 ends the game with reason 'points'", () => {
    const g = createGame(2, 3, { endGameMode: "immediate" });
    const p = g.players[0]!;
    p.built.push({ id: 8000, tier: 3, bonus: "white", points: 14, cost: { white: 0, blue: 0, green: 0, red: 0, black: 0 } });
    const free: Card = { id: 8001, tier: 1, bonus: "white", points: 1, cost: { white: 0, blue: 0, green: 0, red: 0, black: 0 } };
    p.reserved.push(free);
    const res = applyMove(g, { kind: "BUY", from: { reserve: { cardId: 8001 } } });
    assert.equal(playerPoints(res.state.players[0]!), 15);
    assert.equal(res.state.over, true);
    assert.equal(res.state.endReason, "points");
  });

  it("multi-noble turn pauses for PICK_NOBLE and awards exactly one", () => {
    const g = createGame(2, 5);
    const p = g.players[0]!;
    // Make the player qualify for two 4+4 nobles at once by satisfying their union.
    // Take two specific nobles from the pool and force them to be available.
    const n1 = g.nobles[0]!;
    const n2 = g.nobles[1]!;
    // set bonuses to meet both requirements
    for (const c of ["white", "blue", "green", "red", "black"] as const) {
      p.bonuses[c] = Math.max(n1.requirement[c], n2.requirement[c]);
    }
    // give a free card to trigger end-of-turn resolution
    const free: Card = { id: 7001, tier: 1, bonus: "white", points: 0, cost: { white: 0, blue: 0, green: 0, red: 0, black: 0 } };
    // ensure buying does not reduce the bonuses we set: push matching built cards is complex,
    // so instead drive end-of-turn directly via a TAKE move (no bonus recompute).
    void free;
    // Use a token take to reach end-of-turn without recomputing bonuses.
    const res = applyMove(g, { kind: "TAKE_TWO", color: "white" });
    // If both nobles qualify, engine should await PICK_NOBLE.
    if (res.awaiting.inputType === "PICK_NOBLE") {
      assert.ok((res.awaiting.nobleChoices ?? []).length >= 2);
      const chosen = res.awaiting.nobleChoices![0]!;
      const res2 = applyResolution(res.state, { kind: "PICK_NOBLE", nobleId: chosen });
      assert.equal(res2.state.players[0]!.nobles.length, 1, "exactly one noble awarded this turn");
      assertInvariants(res2.state);
    } else {
      // (Only one or zero nobles matched given the random pool; still must be valid.)
      assert.ok(res.state.players[0]!.nobles.length <= 1);
    }
  });

  it("redaction hides opponents' reserved cards, deck order, and seed", () => {
    const g = createGame(3, 21);
    for (const p of g.players) p.reserved.push(g.decks[1].pop()!);
    const view0 = redact(g, 0);
    assert.ok(view0.players[0]!.reserved, "owner sees own reserved");
    assert.equal(view0.players[1]!.reserved, undefined, "opponent reserved hidden");
    assert.equal(view0.players[1]!.reservedCount, 1, "opponent reserved count visible");
    const spec = redact(g, "spectator");
    assert.ok(spec.players.every((p) => p.reserved === undefined), "spectator sees no reserved identities");
    const json = JSON.stringify(view0);
    assert.equal(json.includes('"decks"'), false, "no deck order leaked");
    assert.equal(json.includes('"seed"'), false, "no seed leaked");
    assert.ok(typeof view0.deckCounts[1] === "number", "deck counts are public");
  });
});

describe("splendor engine: fuzz", () => {
  interface Outcome {
    reason: GameState["endReason"];
    turns: number;
    maxPoints: number;
    maxTokens: number;
  }

  function playGame(playerCount: number, seed: number, policy: Policy, turnCap: number): Outcome {
    let g = createGame(playerCount, seed, { turnCap });
    assertInvariants(g);
    let guard = 0;
    while (!isGameOver(g)) {
      // Generous guard: each turn is at most one move + one sub-decision (discard or
      // noble), so iterations are bounded by ~3x the turn cap.
      if (++guard > (turnCap + 1) * 3) throw new Error("engine failed to terminate within cap");
      const a = g.awaiting;
      if (a.inputType === "MOVE") {
        const move = policy.move(g);
        g = move === null ? applyPass(g).state : applyMove(g, move).state;
      } else if (a.inputType === "PICK_NOBLE") {
        g = applyResolution(g, policy.pickNoble(g)).state;
      } else {
        g = applyResolution(g, policy.discard(g)).state;
      }
      assertInvariants(g);
    }
    const r = ranking(g);
    let maxTok = 0;
    for (const p of g.players) {
      let t = p.gold;
      for (const c of ["white", "blue", "green", "red", "black"] as const) t += p.gems[c];
      if (t > maxTok) maxTok = t;
    }
    return { reason: g.endReason, turns: g.turnCount, maxPoints: r[0]!.points, maxTokens: maxTok };
  }

  it("greedy playouts terminate by points; all invariants hold every step", function () {
    this.timeout(120000); // 360 full playouts under tsx
    const N = 120; // per player count
    for (const pc of [2, 3, 4]) {
      let pointsWins = 0;
      for (let k = 0; k < N; k++) {
        const o = playGame(pc, 1000 * pc + k, new GreedyPolicy(k + 1), 2000);
        if (o.reason === "points") pointsWins++;
        assert.ok(o.maxTokens <= 10, "no player ever exceeded 10 tokens between turns");
        if (o.reason === "points") assert.ok(o.maxPoints >= 15, "points-win implies someone reached 15");
      }
      console.error(`  ${pc}p greedy: ${pointsWins}/${N} ended by reaching 15`);
      // Greedy should reach 15 in the large majority of games.
      assert.ok(pointsWins >= N * 0.8, `${pc}p: only ${pointsWins}/${N} greedy games ended by points`);
    }
  });

  it("random playouts never violate an invariant and always terminate (points/stalemate/cap)", function () {
    this.timeout(120000);
    const N = 40; // per player count (cheap)
    for (const pc of [2, 3, 4]) {
      for (let k = 0; k < N; k++) {
        const o = playGame(pc, 90000 * pc + k, new RandomPolicy(k + 7), 1500);
        assert.ok(["points", "stalemate", "cap"].includes(o.reason as string), `bad end reason ${o.reason}`);
        assert.ok(o.maxTokens <= 10);
      }
    }
  });

  it("a forced pass is only legal when there are no legal moves", () => {
    const g = createGame(2, 1);
    assert.ok(legalMoves(g).length > 0);
    assert.throws(() => applyPass(g), /pass illegal/);
  });
});
