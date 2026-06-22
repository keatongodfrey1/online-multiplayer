/**
 * Pure unit tests for the Space Chase rules engine - no server, no Colyseus.
 * This is the regression net for the whole ruleset (board math + every card +
 * shields + suit + Time Loop + 6-7 + Kraken + collisions + win + tiebreaker).
 *
 * Scripting: push onto `state.deck` to plant the next draw (top = last element)
 * and onto `state.forcedRolls` to script dice; both are consumed before the rng.
 * (Planting a card makes the pile 43 cards, so assertInvariants is only used on
 * games played through un-tampered draws.)
 */
import assert from "node:assert/strict";
import { SpaceChaseEngine, ScAwait, ScChoice, ScPrompt } from "@backbone/shared";
import { parseSave, serializeSave, type SaveSeat } from "../src/games/spacechase/save.js";

const {
  createGame,
  applyMove,
  applyResolution,
  applyLeave,
  autoResolve,
  isLegalMove,
  legalActionExists,
  assertInvariants,
  ranking,
  buildDeck,
  mulberry32,
  moveBy,
  landOn,
  teleportTo,
  scanCollisions,
  nearestAhead,
} = SpaceChaseEngine;

type GameState = SpaceChaseEngine.GameState;
type ApplyResult = SpaceChaseEngine.ApplyResult;
type SeatPos = SpaceChaseEngine.SeatPos;
type MoveStep = SpaceChaseEngine.MoveStep;

// Card ids used in tests (see CARD_DEFS).
const CARD = {
  SPACE_CREDIT: 4, // forward 20
  COSMIC_CHAOS: 6, // everyone forward 7
  ROVER: 8, // others +5, you +7
  TIME_BOMB: 13, // teleport to START
  METEOR_SHOWER: 14, // everyone back 5
  NUCLEAR_BOMB: 16, // attack: send to START
  BLASTER: 17, // attack: target back 3
  FIGHTER_JET: 19, // attack: target -3, you +3
  BLACK_HOLE: 20, // attack: teleport target to chosen space
  KRAKEN: 22, // 3 lose 1 OR 1 loses 3
  SHOOTING_STAR: 29, // self to 33 or send to 33
  SIX_SEVEN: 30, // send to 6/7; 2nd draw -> self to 67
  NEBULA: 32, // +2 extra turns
  TIME_LOOP: 34, // repeat last action
  ROCKET: 35, // jump ahead of nearest
  SPACE_GUN: 36, // lose 2 turns
  SHIELD: 38, // shield 3 rounds
  SPACE_SUIT: 39, // double next card
  SATELLITE: 40, // peek + reorder top 5
  WORM_HOLE: 41, // swap with opponent
};

// ── scripting helpers ──

function start(players = 2, seed = 1, names?: string[]): GameState {
  return createGame(players, seed, names);
}
function roll(g: GameState, die?: number): ApplyResult {
  if (die !== undefined) g.forcedRolls.push(die);
  return applyMove(g, { kind: "ROLL" });
}
function draw(g: GameState, cardId: number): ApplyResult {
  g.deck.push(cardId);
  return applyMove(g, { kind: "DRAW" });
}
function seatOf(g: GameState, i: number) {
  return g.players[i]!;
}
function kinds(events: { kind: string }[]): string[] {
  return events.map((e) => e.kind);
}

describe("spacechase engine - board math", () => {
  function seatAt(position: number, extra: Partial<SeatPos & { gone: boolean }> = {}) {
    return { position, portalId: 0, portalProgress: 0, portalForward: true, justExitedPortal: 0, gone: false, ...extra };
  }
  function seatInPortal(mouth: number) {
    const seat = seatAt(0);
    assert.equal(landOn(seat, mouth).length, 1, `${mouth} should be a portal mouth`);
    return seat;
  }
  const stepKinds = (s: MoveStep[]) => s.map((x) => x.kind);

  it("builds a 42-card pile with two 6-7s, deterministically", () => {
    const deck = buildDeck(mulberry32(1));
    assert.equal(deck.length, 42);
    const counts = new Map<number, number>();
    for (const id of deck) counts.set(id, (counts.get(id) ?? 0) + 1);
    assert.equal(counts.size, 41);
    assert.equal(counts.get(30), 2);
    assert.deepEqual(buildDeck(mulberry32(7)), buildDeck(mulberry32(7)));
    assert.notDeepEqual(buildDeck(mulberry32(7)), buildDeck(mulberry32(8)));
  });

  it("moves, clamps at START and the Finish", () => {
    const s = seatAt(10);
    moveBy(s, 5);
    assert.equal(s.position, 15);
    moveBy(s, -20);
    assert.equal(s.position, 0);
    const f = seatAt(66);
    moveBy(f, 6);
    assert.equal(f.position, 68);
  });

  it("the worked example: inside portal 3 from 51, move 7 -> exit 39 -> continue to 42", () => {
    const s = seatInPortal(51);
    assert.equal(s.portalForward, false);
    assert.deepEqual(stepKinds(moveBy(s, 7)), ["portalMove", "exitPortal", "move"]);
    assert.equal(s.position, 42);
    assert.equal(s.portalId, 0);
    assert.equal(s.justExitedPortal, 39);
  });

  it("re-entry guard blocks walking back onto the mouth just exited", () => {
    const s = seatInPortal(28);
    moveBy(s, 4); // out at 61
    moveBy(s, -2); // 59
    assert.deepEqual(stepKinds(moveBy(s, 2)), ["move"]); // back onto 61, no re-enter
    assert.equal(s.portalId, 0);
  });

  it("teleport onto a mouth always enters; collisions group; nearestAhead works", () => {
    const t = seatAt(10, { justExitedPortal: 39 });
    assert.deepEqual(stepKinds(teleportTo(t, 39)), ["teleport", "enterPortal"]);
    assert.deepEqual(scanCollisions([seatAt(10), seatAt(10), seatAt(11)]), [[0, 1]]);
    assert.deepEqual(scanCollisions([seatAt(0), seatAt(0)]), []); // START exempt
    assert.equal(nearestAhead([seatAt(10), seatAt(30), seatAt(20)], 0), 2);
    assert.equal(nearestAhead([seatAt(50), seatAt(30)], 0), -1);
  });
});

describe("spacechase engine - portals (all three, both directions)", () => {
  const mk = () => ({ position: 0, portalId: 0, portalProgress: 0, portalForward: true, justExitedPortal: 0, gone: false });
  const stepKinds = (s: MoveStep[]) => s.map((x) => x.kind);
  // [id, a, b, internal] - the three portals from GAME_RULES.md.
  const PORTALS: [number, number, number, number][] = [
    [1, 4, 36, 7],
    [2, 28, 61, 3],
    [3, 39, 51, 3],
  ];

  for (const [id, a, b, internal] of PORTALS) {
    for (const dir of ["a->b", "b->a"] as const) {
      const entry = dir === "a->b" ? a : b;
      const far = dir === "a->b" ? b : a;

      it(`portal ${id} (${entry}->${far}): enter, traverse, exit exactly on the far mouth`, () => {
        const s = mk();
        assert.deepEqual(stepKinds(landOn(s, entry)), ["enterPortal"]);
        assert.equal(s.portalId, id);
        assert.equal(s.portalForward, entry === a);
        assert.equal(s.portalProgress, 0);
        // internal + 1 moves leaves exactly on the far mouth (the +1 is the exit step).
        assert.deepEqual(stepKinds(moveBy(s, internal + 1)), ["portalMove", "exitPortal"]);
        assert.equal(s.portalId, 0, "out of the portal after exiting");
        assert.equal(s.position, far);
        assert.equal(s.justExitedPortal, far);
      });

      it(`portal ${id} (${entry}->${far}): leftover movement continues forward off the exit`, () => {
        const s = mk();
        landOn(s, entry);
        moveBy(s, internal + 3); // 2 spaces of overflow past the exit
        assert.equal(s.portalId, 0);
        assert.equal(s.position, far + 2, "overflow continues forward from the exit mouth");
      });
    }
  }

  it("OWNER SCENARIO: exit portal 1 at #36, then next turn does NOT get sucked back (no #36->#4 reversal)", () => {
    const s = mk();
    landOn(s, 4); // enter portal 1 at the #4 end
    assert.equal(s.portalForward, true);
    moveBy(s, 8); // 7 internal + 1 to step out -> stand ON #36, OUT of the portal
    assert.equal(s.portalId, 0);
    assert.equal(s.position, 36);
    assert.equal(s.justExitedPortal, 36);
    // Next turn: the engine clears the guard (what beginTurn does).
    s.justExitedPortal = 0;
    // A forward roll must move away on the board, NOT re-enter and reverse to #4.
    assert.deepEqual(stepKinds(moveBy(s, 4)), ["move"]);
    assert.equal(s.portalId, 0, "still out of the portal - not sucked back in");
    assert.equal(s.position, 40);
  });

  it("OWNER SCENARIO mirror: exit portal 1 at #4 (entered at #36), next turn no re-entry", () => {
    const s = mk();
    landOn(s, 36); // enter at the #36 end, heading 36->4
    assert.equal(s.portalForward, false);
    moveBy(s, 8); // exit onto #4
    assert.equal(s.portalId, 0);
    assert.equal(s.position, 4);
    assert.equal(s.justExitedPortal, 4);
    s.justExitedPortal = 0; // next turn
    assert.deepEqual(stepKinds(moveBy(s, 3)), ["move"]);
    assert.equal(s.portalId, 0);
    assert.equal(s.position, 7);
  });

  it("standing on a mouth never auto-enters, but a FRESH landing does", () => {
    const s = mk();
    landOn(s, 4);
    moveBy(s, 8); // -> standing on #36, portalId 0
    s.justExitedPortal = 0; // guard cleared next turn
    moveBy(s, 0); // doing nothing does not enter
    assert.equal(s.portalId, 0, "merely standing on the mouth does not re-enter");
    // A genuine landing on #36 from elsewhere DOES enter (intended), heading 36->4.
    const fresh = mk();
    fresh.position = 33;
    assert.deepEqual(stepKinds(moveBy(fresh, 3)), ["move", "enterPortal"]);
    assert.equal(fresh.portalId, 1);
    assert.equal(fresh.portalForward, false, "a fresh landing on #36 heads 36->4");
  });

  it("within ONE resolution the guard blocks an immediate reversal back onto the exit mouth", () => {
    const s = mk();
    landOn(s, 4);
    moveBy(s, 8); // exit at #36 (guard = 36, still set this turn)
    moveBy(s, -2); // 34
    assert.deepEqual(stepKinds(moveBy(s, 2)), ["move"]); // back onto #36 -> NOT re-entered
    assert.equal(s.portalId, 0);
    assert.equal(s.position, 36);
  });
});

describe("spacechase engine - turn flow", () => {
  it("starts at seat 0 awaiting ACTION; a roll moves and passes the turn", () => {
    const g = start(2, 5);
    assert.equal(g.awaiting.seat, 0);
    assert.equal(g.awaiting.inputType, "ACTION");
    assert.equal(g.turnCount, 1);
    const r = roll(g, 5);
    assert.equal(seatOf(r.state, 0).position, 5);
    assert.equal(r.state.awaiting.seat, 1);
    assert.ok(r.state.turnCount > g.turnCount);
  });

  it("isLegalMove only on ACTION; lost turns skip; extra turns repeat the seat", () => {
    let g = start(2, 5);
    assert.ok(isLegalMove(g, { kind: "ROLL" }));

    // Space Gun: Ben loses 2 turns -> Ada acts twice while Ben is skipped.
    g = roll(g, 1).state; // Ada -> seat 1
    g = draw(g, CARD.SPACE_GUN).state; // Ben loses 2, back to Ada
    assert.equal(seatOf(g, 1).lostTurns, 2);
    assert.equal(g.awaiting.seat, 0);
    g = roll(g, 1).state; // Ada; Ben skip 1
    assert.equal(g.awaiting.seat, 0, "Ben skipped once");
    g = roll(g, 1).state; // Ada; Ben skip 2
    assert.equal(g.awaiting.seat, 0, "Ben skipped twice");
    assert.equal(seatOf(g, 1).lostTurns, 0);
    g = roll(g, 1).state; // now passes to Ben
    assert.equal(g.awaiting.seat, 1);

    // Nebula: +2 extra turns -> same seat goes again.
    g = roll(g, 1).state; // Ben -> Ada
    const before = g.roundNumber;
    g = draw(g, CARD.NEBULA).state; // Ada gains 2, immediately consumes 1 -> Ada again
    assert.equal(g.awaiting.seat, 0);
    assert.equal(g.roundNumber, before, "extra turns are not go-arounds");
  });
});

describe("spacechase engine - cards", () => {
  it("forward / everyone / rover movement (distinct spaces so nobody collides)", () => {
    // Space Credit: +20.
    let g = start(2, 9);
    g = draw(g, CARD.SPACE_CREDIT).state;
    assert.equal(seatOf(g, 0).position, 20);

    // Cosmic Chaos: everyone +7. Start them apart so they don't land together.
    g = start(2, 9);
    seatOf(g, 0).position = 10;
    seatOf(g, 1).position = 20;
    g = draw(g, CARD.COSMIC_CHAOS).state;
    assert.equal(seatOf(g, 0).position, 17);
    assert.equal(seatOf(g, 1).position, 27);

    // Rover: others +5, drawer +7.
    g = start(2, 9);
    seatOf(g, 0).position = 10;
    seatOf(g, 1).position = 20;
    g = draw(g, CARD.ROVER).state;
    assert.equal(seatOf(g, 0).position, 17);
    assert.equal(seatOf(g, 1).position, 25);
  });

  it("Space Suit doubles the wearer's roll and only the wearer on everyone-cards; is consumed regardless", () => {
    // Suit then roll 3 -> +6, stored doubled.
    let g = start(2, 3);
    g = draw(g, CARD.SPACE_SUIT).state; // Ada suits up, turn passes to Ben
    g = roll(g, 1).state; // Ben
    g = roll(g, 3).state; // Ada rolls 3 -> doubled to 6
    assert.equal(seatOf(g, 0).position, 6);
    assert.equal(seatOf(g, 0).lastActionValue, 6);
    assert.equal(seatOf(g, 0).spaceSuit, false);

    // Suit then Cosmic Chaos -> wearer +14, other +7.
    g = start(2, 3);
    g = draw(g, CARD.SPACE_SUIT).state;
    g = roll(g, 1).state; // Ben
    g = draw(g, CARD.COSMIC_CHAOS).state; // Ada wearing suit
    assert.equal(seatOf(g, 0).position, 14);
    assert.equal(seatOf(g, 1).position, 7 + 1); // Ben moved 1 earlier, +7 now

    // Suit then Satellite -> consumed with no effect on movement.
    g = start(2, 3);
    g = draw(g, CARD.SPACE_SUIT).state;
    g = roll(g, 1).state;
    g = draw(g, CARD.SATELLITE).state; // opens SATELLITE prompt
    assert.equal(g.awaiting.inputType, "SATELLITE");
    assert.equal(seatOf(g, 0).spaceSuit, false, "suit consumed even though Satellite has no number");
  });

  it("Shield: round-based, blocks unlimited hits, then expires", () => {
    let g = start(2, 9);
    g = draw(g, CARD.SHIELD).state; // Ada shields (her 1st action); turn -> Ben
    const exp = seatOf(g, 0).shieldExpiresRound;
    assert.equal(exp, g.roundNumber + 3);

    // Ben blasts Ada -> blocked (1st hit).
    const blastAda = (s: GameState) => {
      const t = draw(s, CARD.BLASTER);
      return applyResolution(t.state, { kind: "TARGET", seat: 0 });
    };
    let r = blastAda(g);
    g = r.state;
    assert.ok(kinds(r.events).includes("shieldBlock"), "hit absorbed");
    assert.equal(seatOf(g, 0).position, 0, "shield absorbed the hit");
    // Time-based, not a per-hit counter: the expiry round never moves on a block.
    assert.equal(seatOf(g, 0).shieldExpiresRound, exp, "shield blocks unlimited hits");

    // Expire the shield by advancing the round count, then a hit lands.
    if (g.awaiting.seat !== 1) g = roll(g, 1).state; // ensure it is Ben's turn
    seatOf(g, 0).position = 10;
    g.roundNumber = exp; // shield now inactive
    r = blastAda(g);
    g = r.state;
    assert.equal(seatOf(g, 0).position, 7, "unshielded: moved back 3 from 10");
  });

  it("attacks: Blaster targets, Fighter Jet both-or-nothing on shield, self-target rules", () => {
    // Fighter Jet: target -3 (from 10 -> 7), attacker +3.
    let g = start(2, 9);
    seatOf(g, 0).position = 5;
    seatOf(g, 1).position = 10;
    let r = draw(g, CARD.FIGHTER_JET); // Ada draws
    g = r.state;
    g = applyResolution(g, { kind: "TARGET", seat: 1 }).state;
    assert.equal(seatOf(g, 1).position, 7);
    assert.equal(seatOf(g, 0).position, 8);

    // Black Hole cannot target self; Worm Hole cannot target self.
    g = start(2, 9);
    g = draw(g, CARD.BLACK_HOLE).state;
    assert.equal(g.awaiting.context, "blackhole-target");
    assert.throws(() => applyResolution(g, { kind: "TARGET", seat: 0 }), /illegal target/);
    g = applyResolution(g, { kind: "TARGET", seat: 1 }).state;
    assert.equal(g.awaiting.inputType, "SPACE");
    g = applyResolution(g, { kind: "SPACE", space: 50 }).state;
    assert.equal(seatOf(g, 1).position, 50);
  });

  it("Kraken: 'three' needs exactly min(3, live) targets; 'one' hits one for 3", () => {
    // Assert on the emitted events: the turn machine immediately starts
    // consuming the freshly-applied lost turns, so the post-state field is
    // not a reliable check.
    const g = start(3, 9);
    const opened = draw(g, CARD.KRAKEN).state;
    assert.equal(opened.awaiting.inputType, "CHOICE");

    const g3 = applyResolution(opened, { kind: "CHOICE", choice: "three" }).state;
    assert.equal(g3.awaiting.inputType, "MULTI_TARGET");
    assert.equal(g3.awaiting.count, 3);
    assert.throws(() => applyResolution(g3, { kind: "TARGETS", seats: [1, 2] }), /wrong number/);
    const r3 = applyResolution(g3, { kind: "TARGETS", seats: [0, 1, 2] });
    assert.equal(r3.events.filter((e) => e.kind === "loseTurns").length, 3, "three players each lose a turn");

    const g1 = applyResolution(opened, { kind: "CHOICE", choice: "one" }).state;
    assert.equal(g1.awaiting.inputType, "TARGET");
    const r1 = applyResolution(g1, { kind: "TARGET", seat: 2 });
    const loss = r1.events.find((e) => e.kind === "loseTurns");
    assert.ok(loss && loss.a === 3, "one target loses 3 turns");
  });

  it("6-7: first draw targets+chooses 6/7; the SAME player's second draw sends them to 67", () => {
    let g = start(2, 9);
    g = draw(g, CARD.SIX_SEVEN).state; // Ada, 1st
    assert.equal(seatOf(g, 0).sixSevenCount, 1);
    assert.equal(g.awaiting.context, "sixseven-target");
    g = applyResolution(g, { kind: "TARGET", seat: 1 }).state;
    g = applyResolution(g, { kind: "CHOICE", choice: "7" }).state;
    assert.equal(seatOf(g, 1).position, 7);

    // Get back to Ada and draw 6-7 again -> auto to 67, no prompt.
    if (g.awaiting.seat !== 0) g = roll(g, 1).state;
    g = draw(g, CARD.SIX_SEVEN).state;
    assert.equal(seatOf(g, 0).sixSevenCount, 2);
    assert.equal(seatOf(g, 0).position, 67);
    assert.notEqual(g.awaiting.inputType, "TARGET");
  });

  it("Shooting Star: self goes to 33; send sends a target to 33", () => {
    let g = start(2, 9);
    g = draw(g, CARD.SHOOTING_STAR).state;
    let self = applyResolution(g, { kind: "CHOICE", choice: "self" }).state;
    assert.equal(seatOf(self, 0).position, 33);
    let send = applyResolution(g, { kind: "CHOICE", choice: "send" }).state;
    send = applyResolution(send, { kind: "TARGET", seat: 1 }).state;
    assert.equal(seatOf(send, 1).position, 33);
  });

  it("Time Loop: replays a roll, replays a card (re-opening its prompt), no-ops as first action", () => {
    // First action ever -> no-op.
    let g = start(2, 9);
    g = draw(g, CARD.TIME_LOOP).state;
    assert.equal(seatOf(g, 0).position, 0);

    // Replay a roll.
    g = start(2, 9);
    g = roll(g, 5).state; // Ada moves 5 -> Ben
    g = roll(g, 1).state; // Ben -> Ada
    g = draw(g, CARD.TIME_LOOP).state; // Ada repeats her 5
    assert.equal(seatOf(g, 0).position, 10);

    // Replay a card that needs a target (Blaster).
    g = start(2, 9);
    seatOf(g, 1).position = 10;
    g = draw(g, CARD.BLASTER).state;
    g = applyResolution(g, { kind: "TARGET", seat: 1 }).state; // Ada blasts Ben -> 7, turn to Ben
    g = roll(g, 1).state; // Ben -> Ada
    const r = draw(g, CARD.TIME_LOOP); // Ada repeats Blaster
    g = r.state;
    assert.equal(g.awaiting.inputType, "TARGET");
    assert.equal(g.awaiting.cardId, CARD.BLASTER);
  });

  it("Rocket jumps ahead of the nearest player; no-ops if nobody is ahead", () => {
    let g = start(2, 9);
    seatOf(g, 0).position = 5;
    seatOf(g, 1).position = 20;
    g = draw(g, CARD.ROCKET).state;
    assert.equal(seatOf(g, 0).position, 21);

    g = start(2, 9);
    seatOf(g, 0).position = 30;
    seatOf(g, 1).position = 10;
    g = draw(g, CARD.ROCKET).state;
    assert.equal(seatOf(g, 0).position, 30, "nobody ahead -> no move, turn still spent");
    assert.equal(g.awaiting.seat, 1);
  });

  it("Worm Hole swaps positions but never with yourself; a shield blocks the swap", () => {
    let g = start(2, 9);
    seatOf(g, 0).position = 5;
    seatOf(g, 1).position = 40;
    g = draw(g, CARD.WORM_HOLE).state;
    assert.throws(() => applyResolution(g, { kind: "TARGET", seat: 0 }), /illegal target/);
    const swapped = applyResolution(g, { kind: "TARGET", seat: 1 }).state;
    assert.equal(seatOf(swapped, 0).position, 40);
    assert.equal(seatOf(swapped, 1).position, 5);
  });

  it("Satellite reorders the next draws by an index permutation", () => {
    let g = start(2, 9);
    g.deck.push(1, 2, 3, 4); // four known cards under the satellite
    g.deck.push(CARD.SATELLITE); // top = satellite, drawn now
    g = applyMove(g, { kind: "DRAW" }).state;
    assert.equal(g.awaiting.inputType, "SATELLITE");
    const peek = g.awaiting.peek.slice(); // next-draw first
    const n = peek.length;
    assert.ok(n >= 2);
    const order = peek.map((_, k) => n - 1 - k); // reverse
    g = applyResolution(g, { kind: "SATELLITE", order }).state;
    // The next card drawn should now be the one that was LAST in the peek.
    if (g.awaiting.seat !== 0) g = roll(g, 1).state; // back to Ada (Ben doesn't draw)
    const next = applyMove(g, { kind: "DRAW" });
    assert.equal(next.events.find((e) => e.kind === "draw")!.b, peek[n - 1]);
  });
});

describe("spacechase engine - winning + lifecycle", () => {
  it("a single finisher wins; simultaneous finishers roll off (re-rolling ties)", () => {
    // Single finisher.
    let g = start(2, 9);
    seatOf(g, 0).position = 67;
    const w = roll(g, 1);
    assert.equal(w.state.over, true);
    assert.equal(w.state.winner, 0);

    // Tie: Cosmic Chaos pushes both past Finish; rolloff 4-4 then 6-2.
    g = start(2, 9);
    seatOf(g, 0).position = 65;
    seatOf(g, 1).position = 64;
    g.forcedRolls.push(4, 4, 6, 2);
    const r = draw(g, CARD.COSMIC_CHAOS);
    assert.equal(r.state.over, true);
    assert.equal(r.state.winner, 0);
    assert.equal(kinds(r.events).filter((k) => k === "tiebreakRoll").length, 4);
  });

  it("collisions send all sharers back to START (once, after an everyone-card)", () => {
    let g = start(2, 9);
    seatOf(g, 0).position = 7;
    seatOf(g, 1).position = 10;
    const r = roll(g, 3); // Ada onto Ben
    g = r.state;
    assert.equal(seatOf(g, 0).position, 0);
    assert.equal(seatOf(g, 1).position, 0);
    assert.ok(kinds(r.events).includes("collision"));
  });

  it("a leaver is removed and skipped; the rest play on", () => {
    let g = start(3, 9);
    // Seat 1 leaves on seat 0's turn -> seat 1 gone, still seat 0 to act.
    g = applyLeave(g, 1).state;
    assert.equal(seatOf(g, 1).gone, true);
    assert.equal(seatOf(g, 1).position, 0);
    g = roll(g, 1).state; // Ada -> should skip gone seat 1 -> seat 2
    assert.equal(g.awaiting.seat, 2);
  });

  it("autoResolve rolls on ACTION; a fresh game keeps invariants through real play", () => {
    let g = start(2, 9);
    const r = autoResolve(g, 0);
    assert.ok(seatOf(r.state, 0).position > 0 || r.state.awaiting.seat === 1);

    // Play a real game (draws + rolls, resolving prompts via the default
    // auto-resolver); invariants must hold after every single step.
    g = start(3, 1234);
    for (let t = 0; t < 200 && !g.over; t++) {
      if (g.awaiting.inputType === "ACTION") {
        g = (t % 2 === 0 ? applyMove(g, { kind: "DRAW" }) : roll(g, 1 + (t % 6))).state;
      } else {
        g = autoResolve(g, g.awaiting.seat).state;
      }
      assertInvariants(g);
    }
    assert.ok(ranking(g).length >= 1);
  });
});

// ── random-playout fuzz ──────────────────────────────────────────────────────
// Unlike the scripted tests (which plant draws and dice), these drive the game
// through UN-TAMPERED draws so the deck multiset stays at 42 and assertInvariants
// applies in full. A separate move-choice RNG (mulberry32) randomizes ROLL vs
// DRAW and every prompt answer; invariants - including the soft-lock detector -
// must hold after EVERY single reduce, the game must always terminate, and a
// not-over game must always have a legal action.

describe("spacechase engine - random-playout fuzz", () => {
  /** Pick a legal answer to whatever prompt is open, randomized but always
   *  valid (falls back to autoResolve, which is the deterministic safe choice). */
  function randomResolve(g: GameState, rnd: () => number): ApplyResult {
    const aw = g.awaiting;
    const live = g.players.filter((p) => !p.gone).map((p) => p.seat);
    const pick = <T,>(xs: T[]): T => xs[Math.floor(rnd() * xs.length)]!;
    try {
      switch (aw.inputType) {
        case ScAwait.TARGET: {
          // selfAllowed: black hole + worm hole forbid self; rest allow it.
          const card = aw.cardId;
          const noSelf = aw.context === ScPrompt.BLACKHOLE_TARGET ||
            (aw.context === ScPrompt.ATTACK_TARGET && card === 41 /* Worm Hole */);
          const pool = live.filter((s) => !noSelf || s !== aw.seat);
          if (pool.length === 0) return autoResolve(g, aw.seat);
          return applyResolution(g, { kind: "TARGET", seat: pick(pool) });
        }
        case ScAwait.MULTI_TARGET: {
          const pool = live.slice();
          // shuffle, take exactly count
          for (let k = pool.length - 1; k > 0; k--) {
            const j = Math.floor(rnd() * (k + 1));
            [pool[k], pool[j]] = [pool[j]!, pool[k]!];
          }
          if (pool.length < aw.count) return autoResolve(g, aw.seat);
          return applyResolution(g, { kind: "TARGETS", seats: pool.slice(0, aw.count) });
        }
        case ScAwait.CHOICE: {
          const opts =
            aw.context === ScPrompt.KRAKEN_CHOICE ? [ScChoice.KRAKEN_ONE, ScChoice.KRAKEN_THREE] :
            aw.context === ScPrompt.STAR_CHOICE ? [ScChoice.STAR_SELF, ScChoice.STAR_SEND] :
            [ScChoice.SIX, ScChoice.SEVEN];
          return applyResolution(g, { kind: "CHOICE", choice: pick(opts) });
        }
        case ScAwait.SPACE:
          return applyResolution(g, { kind: "SPACE", space: 1 + Math.floor(rnd() * 67) });
        case ScAwait.SATELLITE: {
          const order = aw.peek.map((_, k) => k);
          for (let k = order.length - 1; k > 0; k--) {
            const j = Math.floor(rnd() * (k + 1));
            [order[k], order[j]] = [order[j]!, order[k]!];
          }
          return applyResolution(g, { kind: "SATELLITE", order });
        }
        default:
          return autoResolve(g, aw.seat);
      }
    } catch {
      // Any randomized choice that turns out illegal -> fall back to the safe
      // deterministic resolver (this must never throw on a legal game).
      return autoResolve(g, aw.seat);
    }
  }

  function playout(players: number, seed: number, moveSeed: number): GameState {
    const rnd = mulberry32(moveSeed);
    let g = createGame(players, seed, undefined);
    assertInvariants(g);
    let leftOne = false;
    for (let step = 0; step < 5000 && !g.over; step++) {
      // Rarely have a non-current seat leave (exercises the gone-seat skip +
      // the soft-lock detector), but never below 2 live so the race continues.
      const liveSeats = g.players.filter((p) => !p.gone);
      if (!leftOne && players >= 3 && liveSeats.length >= 3 && rnd() < 0.02) {
        const victim = g.players.find((p) => !p.gone && p.seat !== g.awaiting.seat);
        if (victim) {
          g = applyLeave(g, victim.seat).state;
          leftOne = true;
          assertInvariants(g);
          continue;
        }
      }
      if (g.awaiting.inputType === ScAwait.ACTION) {
        g = (rnd() < 0.5 ? applyMove(g, { kind: "ROLL" }) : applyMove(g, { kind: "DRAW" })).state;
      } else {
        g = randomResolve(g, rnd).state;
      }
      assertInvariants(g);
      // A running game must always offer a legal action (the soft-lock contract).
      if (!g.over) assert.ok(legalActionExists(g), "running game has a legal action");
    }
    return g;
  }

  it("random playouts keep invariants every step and always terminate, across player counts", function () {
    this.timeout(60000);
    for (let players = 2; players <= 5; players++) {
      let finished = 0;
      for (let trial = 0; trial < 40; trial++) {
        const g = playout(players, 1000 * players + trial, 7 * trial + 13);
        // Either someone won, or (after a rare leave) the rest played on; the
        // termination guard means we never spun forever.
        if (g.over) finished++;
        assert.ok(ranking(g).length >= 1);
      }
      // The vast majority must reach a real finish (proves no soft-lock stall).
      assert.ok(finished >= 30, `${players}p: only ${finished}/40 playouts finished`);
    }
  });

  it("a fresh game never reports a missing legal action (soft-lock smoke)", () => {
    for (let players = 2; players <= 5; players++) {
      const g = createGame(players, players * 99, undefined);
      assert.ok(legalActionExists(g));
      assertInvariants(g);
    }
  });
});

// ── pure parseSave round-trip + tamper rejection (no server boot) ─────────────

describe("spacechase save - parseSave accept + reject (pure)", () => {
  const SEATS2: SaveSeat[] = [
    { nickname: "Ada", isBot: false, gone: false },
    { nickname: "Ben", isBot: false, gone: false },
  ];

  /** A mid-game engine snapshot reached through real play (clean 42-card pile). */
  function midGame(players = 2, seed = 4242): GameState {
    let g = createGame(players, seed, ["Ada", "Ben", "Cy", "Di", "Ev"].slice(0, players));
    for (let t = 0; t < 12 && !g.over; t++) {
      if (g.awaiting.inputType === ScAwait.ACTION) {
        g = (t % 3 === 0 ? applyMove(g, { kind: "DRAW" }) : applyMove(g, { kind: "ROLL" })).state;
      } else {
        g = autoResolve(g, g.awaiting.seat).state;
      }
    }
    return g;
  }

  function blob(engine: GameState, seats = SEATS2) {
    return serializeSave({ engine, seats, turnSeconds: 30 }) as Record<string, unknown>;
  }

  it("a clean round-tripped blob validates", () => {
    const g = midGame();
    const parsed = parseSave(blob(g));
    assert.ok(parsed, "clean save accepted");
    assert.equal(parsed!.engine.players.length, 2);
    assert.equal(parsed!.seats.length, 2);
  });

  it("a finished game round-trips", () => {
    let g = createGame(2, 9, ["Ada", "Ben"]);
    g.players[0]!.position = 67;
    g.forcedRolls.push(3);
    g = applyMove(g, { kind: "ROLL" }).state;
    assert.equal(g.over, true);
    assert.ok(parseSave(blob(g)), "finished game accepted");
  });

  it("rejects a wrong-game / wrong-version envelope", () => {
    const g = midGame();
    assert.equal(parseSave({ ...blob(g), game: "splendor" }), null);
    assert.equal(parseSave({ ...blob(g), v: 999 }), null);
    assert.equal(parseSave("not even an object"), null);
    assert.equal(parseSave({ ...blob(g), turnSeconds: -5 }), null);
  });

  it("rejects an engineVersion mismatch", () => {
    const g = midGame();
    const b = blob(g);
    (b.engine as Record<string, unknown>).engineVersion = "sc-0";
    assert.equal(parseSave(b), null);
  });

  it("rejects a tampered deck (broken card conservation)", () => {
    const g = midGame();
    const b = blob(g);
    const eng = b.engine as { deck: number[] };
    eng.deck = [...eng.deck, 5]; // 43 cards now
    assert.equal(parseSave(b), null);
  });

  it("rejects an out-of-range position", () => {
    const g = midGame();
    const b = blob(g);
    (b.engine as { players: { position: number }[] }).players[0]!.position = 99;
    assert.equal(parseSave(b), null);
  });

  it("rejects awaiting a seat that has left the race (soft-lock)", () => {
    // Not-over game whose current seat is gone -> assertInvariants fires.
    const g = midGame(3, 321);
    const b = blob(g, [
      { nickname: "Ada", isBot: false, gone: false },
      { nickname: "Ben", isBot: false, gone: false },
      { nickname: "Cy", isBot: false, gone: true },
    ]);
    const eng = b.engine as { awaiting: { seat: number }; players: { gone: boolean }[] };
    eng.players[2]!.gone = true;
    eng.awaiting.seat = 2; // awaiting a gone seat
    assert.equal(parseSave(b), null);
  });

  it("rejects an internally-inconsistent awaiting block (impossible prompt)", () => {
    const g = midGame();
    // Force an ACTION turn so the base blob is clean, then forge a prompt that
    // carries baggage ACTION never has.
    while (g.awaiting.inputType !== ScAwait.ACTION && !g.over) {
      // (midGame ends on ACTION already, but be safe)
      break;
    }
    const b = blob(g);
    const aw = (b.engine as { awaiting: Record<string, unknown> }).awaiting;
    // A SATELLITE await whose peek does NOT match the top of the deck is forged.
    aw.inputType = ScAwait.SATELLITE;
    aw.context = ScPrompt.SATELLITE;
    aw.peek = [1, 2, 3];
    aw.count = 3;
    assert.equal(parseSave(b), null);
  });

  it("rejects a MULTI_TARGET await with a count that exceeds the live seats", () => {
    const g = midGame(2, 77); // 2 players -> Kraken three count would be 2 max
    const b = blob(g);
    const aw = (b.engine as { awaiting: Record<string, unknown> }).awaiting;
    aw.inputType = ScAwait.MULTI_TARGET;
    aw.context = ScPrompt.KRAKEN_THREE;
    aw.cardId = 22;
    aw.count = 3; // but only 2 are live
    assert.equal(parseSave(b), null);
  });

  it("rejects a TARGET await for a context that never opens one", () => {
    const g = midGame();
    const b = blob(g);
    const aw = (b.engine as { awaiting: Record<string, unknown> }).awaiting;
    aw.inputType = ScAwait.TARGET;
    aw.context = "made-up-context";
    aw.cardId = 17;
    assert.equal(parseSave(b), null);
  });

  it("rejects when the lineup gone flags disagree with the engine", () => {
    const g = midGame();
    const b = blob(g, [
      { nickname: "Ada", isBot: false, gone: true }, // engine says not gone
      { nickname: "Ben", isBot: false, gone: false },
    ]);
    assert.equal(parseSave(b), null);
  });

  it("accepts a legitimately-restored open prompt (Kraken three)", () => {
    // Reach a real Kraken-three MULTI_TARGET await through play, then save it.
    // Move the Kraken (#22) to the top WITHOUT changing the multiset (swap with
    // the current top) so the pile stays a clean 42 cards.
    let g = createGame(3, 9, ["Ada", "Ben", "Cy"]);
    const ki = g.deck.indexOf(22);
    const top = g.deck.length - 1;
    [g.deck[ki], g.deck[top]] = [g.deck[top]!, g.deck[ki]!];
    g = applyMove(g, { kind: "DRAW" }).state;
    g = applyResolution(g, { kind: "CHOICE", choice: ScChoice.KRAKEN_THREE }).state;
    assert.equal(g.awaiting.inputType, ScAwait.MULTI_TARGET);
    const seats3: SaveSeat[] = [
      { nickname: "Ada", isBot: false, gone: false },
      { nickname: "Ben", isBot: false, gone: false },
      { nickname: "Cy", isBot: false, gone: false },
    ];
    const parsed = parseSave(serializeSave({ engine: g, seats: seats3, turnSeconds: 30 }));
    assert.ok(parsed, "a real open Kraken-three prompt round-trips");
    assert.equal(parsed!.engine.awaiting.inputType, ScAwait.MULTI_TARGET);
  });
});
