import { test } from "node:test";
import assert from "node:assert/strict";
import {
  applyMove,
  applyPass,
  applyResolution,
  createGame,
  GreedyPolicy,
  isGameOver,
  legalMoves,
  Policy,
  ranking,
  RandomPolicy,
  type GameState,
} from "../src/index";
import { assertInvariants } from "../src/invariants";

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
  return { reason: g.endReason, turns: g.turnCount, maxPoints: r[0].points, maxTokens: maxTok };
}

test("greedy playouts terminate by points; all invariants hold every step", () => {
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

test("random playouts never violate an invariant and always terminate (points/stalemate/cap)", () => {
  const N = 40; // per player count (cheap)
  for (const pc of [2, 3, 4]) {
    for (let k = 0; k < N; k++) {
      const o = playGame(pc, 90000 * pc + k, new RandomPolicy(k + 7), 1500);
      assert.ok(["points", "stalemate", "cap"].includes(o.reason as string), `bad end reason ${o.reason}`);
      assert.ok(o.maxTokens <= 10);
    }
  }
});

test("a forced pass is only legal when there are no legal moves", () => {
  const g = createGame(2, 1);
  assert.ok(legalMoves(g).length > 0);
  assert.throws(() => applyPass(g), /pass illegal/);
});
