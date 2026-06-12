/**
 * Pure unit tests for the Space Chase movement engine - no server, no
 * Colyseus. The portal traversal math is the most bug-prone part of the
 * game (see MECHANICS_AND_RULINGS.md §1), so it is locked down here
 * before any room logic builds on it.
 */
import assert from "node:assert/strict";
import { SC_SIX_SEVEN_ID } from "@backbone/shared";
import {
  buildDeck,
  landOn,
  moveBy,
  mulberry32,
  nearestAhead,
  scanCollisions,
  teleportTo,
  type MoveStep,
  type SeatPos,
} from "../src/games/spacechase/engine.js";

type TestSeat = SeatPos & { gone: boolean };

function seatAt(position: number, extra: Partial<TestSeat> = {}): TestSeat {
  return {
    position,
    portalId: 0,
    portalProgress: 0,
    portalForward: true,
    justExitedPortal: 0,
    gone: false,
    ...extra,
  };
}

/** A seat that has just entered the given portal mouth. */
function seatInPortal(mouth: number): TestSeat {
  const seat = seatAt(0);
  const steps = landOn(seat, mouth);
  assert.equal(steps.length, 1, `expected ${mouth} to be a portal mouth`);
  return seat;
}

function kinds(steps: MoveStep[]): string[] {
  return steps.map((s) => s.kind);
}

describe("spacechase engine", () => {
  describe("deck", () => {
    it("builds a 42-card pile with two copies of 6-7 and one of everything else", () => {
      const deck = buildDeck(mulberry32(1));
      assert.equal(deck.length, 42);
      const counts = new Map<number, number>();
      for (const id of deck) counts.set(id, (counts.get(id) ?? 0) + 1);
      assert.equal(counts.size, 41);
      assert.equal(counts.get(SC_SIX_SEVEN_ID), 2);
      for (const [id, n] of counts) {
        if (id !== SC_SIX_SEVEN_ID) assert.equal(n, 1, `card ${id} duplicated`);
      }
    });

    it("is deterministic for a given seed", () => {
      assert.deepEqual(buildDeck(mulberry32(7)), buildDeck(mulberry32(7)));
      assert.notDeepEqual(buildDeck(mulberry32(7)), buildDeck(mulberry32(8)));
    });
  });

  describe("board movement", () => {
    it("moves forward and backward on the board", () => {
      const seat = seatAt(10);
      moveBy(seat, 5);
      assert.equal(seat.position, 15);
      moveBy(seat, -3);
      assert.equal(seat.position, 12);
    });

    it("moving forward from START: n spaces lands on space n", () => {
      const seat = seatAt(0);
      moveBy(seat, 6);
      assert.equal(seat.position, 6);
    });

    it("backward movement stops at START and is a no-op from START", () => {
      const seat = seatAt(2);
      moveBy(seat, -10);
      assert.equal(seat.position, 0);
      assert.deepEqual(moveBy(seat, -3), []);
      assert.equal(seat.position, 0);
    });

    it("passing the Finish caps at 68", () => {
      const seat = seatAt(66);
      moveBy(seat, 6);
      assert.equal(seat.position, 68);
    });
  });

  describe("portal traversal", () => {
    it("landing on a mouth enters the portal (both directions)", () => {
      const atA = seatAt(0);
      const stepsA = moveBy(atA, 4); // land on space 4 = portal 1's `a` mouth
      assert.deepEqual(kinds(stepsA), ["move", "enterPortal"]);
      assert.equal(atA.portalId, 1);
      assert.equal(atA.portalProgress, 0);
      assert.equal(atA.portalForward, true);
      assert.equal(atA.position, 4, "position holds the entry mouth while inside");

      const atB = seatAt(35);
      moveBy(atB, 1); // land on 36 = portal 1's `b` mouth
      assert.equal(atB.portalId, 1);
      assert.equal(atB.portalForward, false);
    });

    it("moves through internal spaces without exiting", () => {
      const seat = seatInPortal(28); // portal 2, internal 3
      const steps = moveBy(seat, 2);
      assert.deepEqual(steps, [{ kind: "portalMove", portalId: 2, from: 0, to: 2 }]);
      assert.equal(seat.portalId, 2);
      assert.equal(seat.portalProgress, 2);
    });

    it("reaching the last internal space leaves you inside at the lip", () => {
      const seat = seatInPortal(28);
      moveBy(seat, 3); // progress 3 of 3 - at the lip, NOT out
      assert.equal(seat.portalId, 2);
      assert.equal(seat.portalProgress, 3);
    });

    it("exiting costs one extra move (internal+1 exits exactly onto the far mouth)", () => {
      const seat = seatInPortal(28); // entered the `a` end; far mouth = 61
      const steps = moveBy(seat, 4);
      assert.deepEqual(kinds(steps), ["portalMove", "exitPortal"]);
      assert.equal(seat.portalId, 0);
      assert.equal(seat.position, 61);
      assert.equal(seat.justExitedPortal, 61, "guard set so we don't re-enter the mouth we exited");
    });

    it("the worked example: inside portal 3 from 51, move 7 -> exit at 39, continue to 42", () => {
      const seat = seatInPortal(51); // portal 3 entered at `b`: heading b->a, exit = 39
      assert.equal(seat.portalForward, false);
      const steps = moveBy(seat, 7);
      assert.deepEqual(kinds(steps), ["portalMove", "exitPortal", "move"]);
      assert.equal(seat.portalId, 0);
      assert.equal(seat.position, 42);
      assert.equal(seat.justExitedPortal, 39);
    });

    it("backing out exits at the entry mouth and continues backward", () => {
      const seat = seatInPortal(51);
      moveBy(seat, 1); // progress 1
      const steps = moveBy(seat, -3); // 1 back to 0... below 0 -> exit at 51 (1 move), 1 left -> 50
      assert.deepEqual(kinds(steps), ["portalMove", "exitPortal", "move"]);
      assert.equal(seat.portalId, 0);
      assert.equal(seat.position, 50);
      assert.equal(seat.justExitedPortal, 51);
    });

    it("the re-entry guard blocks walking back onto the mouth just exited", () => {
      const seat = seatInPortal(28);
      moveBy(seat, 4); // out at 61, guard = 61
      moveBy(seat, -2); // 59
      const steps = moveBy(seat, 2); // back onto 61 - must NOT re-enter
      assert.deepEqual(kinds(steps), ["move"]);
      assert.equal(seat.portalId, 0);
      assert.equal(seat.position, 61);
    });

    it("the guard does NOT block the portal's other mouth or other portals", () => {
      const seat = seatInPortal(28);
      moveBy(seat, 4); // out at 61, guard = 61
      teleportTo(seat, 10);
      // walking onto 28 (the other mouth of the same portal) re-enters
      const fresh = seatAt(27, { justExitedPortal: 61 });
      moveBy(fresh, 1);
      assert.equal(fresh.portalId, 2);
    });

    it("overflow after exiting can chain into another portal mouth", () => {
      // Exit portal 3 at 39 with overflow that lands exactly on 51's twin?
      // Simpler real case: exit portal 2 at 61 with overflow 3 -> 64 (no
      // portal), then a separate move onto 36 enters portal 1.
      const seat = seatInPortal(28);
      moveBy(seat, 7); // 3 internal + 1 exit at 61 + 3 -> 64
      assert.equal(seat.position, 64);
      assert.equal(seat.portalId, 0);
      const walker = seatAt(35);
      moveBy(walker, 1);
      assert.equal(walker.portalId, 1);
    });
  });

  describe("teleports", () => {
    it("teleporting onto a mouth ALWAYS enters the portal (guard cleared)", () => {
      const seat = seatAt(10, { justExitedPortal: 39 });
      const steps = teleportTo(seat, 39);
      assert.deepEqual(kinds(steps), ["teleport", "enterPortal"]);
      assert.equal(seat.portalId, 3);
      assert.equal(seat.portalForward, true);
    });

    it("teleporting exits any portal for free", () => {
      const seat = seatInPortal(4);
      moveBy(seat, 2);
      teleportTo(seat, 20);
      assert.equal(seat.portalId, 0);
      assert.equal(seat.position, 20);
    });

    it("teleport to START works (Time Bomb / Nuclear Bomb -> 0, never space 1)", () => {
      const seat = seatInPortal(4);
      teleportTo(seat, 0);
      assert.equal(seat.position, 0);
      assert.equal(seat.portalId, 0);
    });
  });

  describe("collisions", () => {
    it("groups rockets sharing a board space", () => {
      const seats = [seatAt(10), seatAt(10), seatAt(11), seatAt(10)];
      assert.deepEqual(scanCollisions(seats), [[0, 1, 3]]);
    });

    it("exempts START, Finish, in-portal and gone seats", () => {
      const inPortal = seatInPortal(4);
      const onMouth = seatAt(4); // standing ON the mouth space, not inside
      assert.deepEqual(scanCollisions([inPortal, onMouth]), [], "portal occupant exempt");
      assert.deepEqual(scanCollisions([seatAt(0), seatAt(0)]), [], "START exempt");
      assert.deepEqual(scanCollisions([seatAt(68), seatAt(68)]), [], "Finish exempt");
      assert.deepEqual(
        scanCollisions([seatAt(9), seatAt(9, { gone: true })]),
        [],
        "gone seats exempt"
      );
    });

    it("reports multiple separate collisions", () => {
      const seats = [seatAt(5), seatAt(5), seatAt(30), seatAt(30)];
      assert.deepEqual(scanCollisions(seats), [
        [0, 1],
        [2, 3],
      ]);
    });
  });

  describe("nearestAhead (Rocket #35)", () => {
    it("finds the nearest live player strictly ahead", () => {
      const seats = [seatAt(10), seatAt(30), seatAt(20), seatAt(5)];
      assert.equal(nearestAhead(seats, 0), 2);
    });

    it("returns -1 when nobody is ahead", () => {
      const seats = [seatAt(50), seatAt(30), seatAt(50)];
      assert.equal(nearestAhead(seats, 0), -1, "ties don't count as ahead");
    });

    it("ignores gone seats and counts in-portal players at their mouth", () => {
      const inPortal = seatInPortal(28); // position reads 28
      const seats = [seatAt(10), seatAt(60, { gone: true }), inPortal];
      assert.equal(nearestAhead(seats, 0), 2);
    });
  });
});
