// Pure, deterministic Water Fight rules engine (Phase A: basic combat).
// All functions are pure: clone-then-mutate, no I/O, no wall clock, no
// Math.random (the RNG state lives in GameState). The attack ladder lives in
// attack.ts; this module owns the turn flow, draws, damage/soak/win, and the
// legal-move surface that policies (bots/fuzz) read.

import { advanceAttack, startAttack, type AttackOutcome } from "./attack.js";
import { DRAW_PER_TURN } from "./data.js";
import { drawMainCard } from "./deck.js";
import {
  ApplyResult,
  Awaiting,
  CardKind,
  GameEvent,
  GameState,
  Move,
  PlayerState,
  Resolution,
} from "./types.js";

function clone<T>(x: T): T {
  return structuredClone(x);
}

export function livingSeats(s: GameState): number[] {
  return s.players.filter((p) => !p.out).map((p) => p.seat);
}

function handHas(p: PlayerState, kind: CardKind): boolean {
  return p.hand.some((c) => c.kind === kind);
}

function actingSeat(s: GameState): number {
  return s.awaiting.seats[0] ?? -1;
}

// ---- turn flow --------------------------------------------------------------

/** Draw `n` cards from the main deck into a seat's hand. */
function drawCards(s: GameState, seat: number, n: number): void {
  const p = s.players[seat]!;
  for (let i = 0; i < n; i++) {
    const card = drawMainCard(s);
    if (card) p.hand.push(card);
  }
}

/** Begin a seat's turn: draw, then await their Main Action. */
export function startTurn(s: GameState, seat: number): void {
  s.turnSeat = seat;
  drawCards(s, seat, DRAW_PER_TURN);
  s.awaiting = { seats: [seat], kind: "MOVE" };
}

function leaderByLives(s: GameState): number | null {
  let best: PlayerState | null = null;
  for (const p of s.players) {
    if (p.out) continue;
    if (!best || p.lives > best.lives || (p.lives === best.lives && p.seat < best.seat)) best = p;
  }
  return best ? best.seat : null;
}

function endGame(s: GameState, winner: number | null, reason: GameState["endReason"]): void {
  s.over = true;
  s.winner = winner;
  s.endReason = reason;
  s.awaiting = { seats: [], kind: "GAME_OVER" };
  s.log.push(`game over: ${reason}, winner seat ${winner}`);
}

/** End the active player's turn and pass to the next living seat. */
function advanceTurn(s: GameState): void {
  if (s.over) return;
  s.turnCount += 1;
  if (s.turnCount > s.options.turnCap) {
    endGame(s, leaderByLives(s), "cap");
    return;
  }
  const N = s.players.length;
  let next = (s.turnSeat + 1) % N;
  for (let i = 0; i < N; i++) {
    if (!s.players[next]!.out) break;
    next = (next + 1) % N;
  }
  startTurn(s, next);
}

/** Apply the resolved attack's consequence, then end the attacker's turn. */
function finishAttack(s: GameState, hit: boolean): void {
  const atk = s.awaiting.attack!;
  if (hit) {
    const target = s.players[atk.targetSeat]!;
    target.lives = Math.max(0, target.lives - atk.damage);
    s.log.push(`seat ${atk.targetSeat} hit for ${atk.damage} -> ${target.lives} lives`);
    if (target.lives <= 0) {
      target.out = true;
      s.log.push(`seat ${atk.targetSeat} is SOAKED`);
    }
  } else {
    s.log.push(`attack on seat ${atk.targetSeat} missed`);
  }
  s.awaiting = { seats: [], kind: "GAME_OVER" }; // cleared; reset by advanceTurn unless over
  const living = livingSeats(s);
  if (living.length <= 1) {
    endGame(s, living[0] ?? null, "last-standing");
    return;
  }
  advanceTurn(s);
}

// ---- legal surface ----------------------------------------------------------

export function legalMoves(s: GameState): Move[] {
  if (s.over || s.awaiting.kind !== "MOVE") return [];
  const seat = s.turnSeat;
  const p = s.players[seat]!;
  const moves: Move[] = [{ kind: "END_TURN" }];
  if (handHas(p, "balloon")) {
    for (const t of livingSeats(s)) if (t !== seat) moves.push({ kind: "THROW", target: t });
  }
  return moves;
}

export function legalResolutions(s: GameState): Resolution[] {
  if (s.over) return [];
  const seat = actingSeat(s);
  if (seat < 0) return [];
  const p = s.players[seat]!;
  if (s.awaiting.kind === "DEFEND") {
    const out: Resolution[] = [{ kind: "DEFEND", defense: "pass" }];
    if (handHas(p, "miss")) out.push({ kind: "DEFEND", defense: "miss" });
    if (handHas(p, "umbrella")) out.push({ kind: "DEFEND", defense: "umbrella" });
    if (handHas(p, "wild")) out.push({ kind: "DEFEND", defense: "wild_miss" });
    return out;
  }
  if (s.awaiting.kind === "ATTACKER_RESPOND") {
    const out: Resolution[] = [{ kind: "ATTACKER_RESPOND", respond: "pass" }];
    if (handHas(p, "hit")) out.push({ kind: "ATTACKER_RESPOND", respond: "hit" });
    if (handHas(p, "wild")) out.push({ kind: "ATTACKER_RESPOND", respond: "wild_hit" });
    return out;
  }
  return [];
}

// ---- validation -------------------------------------------------------------

function validateMove(s: GameState, move: Move): void {
  if (s.over) throw new Error("game over");
  if (s.awaiting.kind !== "MOVE") throw new Error("not awaiting a move");
  const seat = s.turnSeat;
  const p = s.players[seat]!;
  if (move.kind === "END_TURN") return;
  // THROW
  if (move.target === seat) throw new Error("cannot target yourself");
  const t = s.players[move.target];
  if (!t || t.out) throw new Error("target not a living player");
  if (!handHas(p, "balloon")) throw new Error("no Water Balloon in hand");
}

function validateResolution(s: GameState, res: Resolution): void {
  if (s.over) throw new Error("game over");
  const allowed = legalResolutions(s);
  const ok = allowed.some((r) =>
    r.kind === res.kind &&
    (r.kind === "DEFEND"
      ? r.defense === (res as Extract<Resolution, { kind: "DEFEND" }>).defense
      : r.kind === "ATTACKER_RESPOND"
        ? r.respond === (res as Extract<Resolution, { kind: "ATTACKER_RESPOND" }>).respond
        : false),
  );
  if (!ok) throw new Error(`illegal resolution for await ${s.awaiting.kind}`);
}

export function isLegalMove(s: GameState, move: Move): boolean {
  try {
    validateMove(s, move);
    return true;
  } catch {
    return false;
  }
}

// ---- applying input ---------------------------------------------------------

export function applyMove(state: GameState, move: Move): ApplyResult {
  validateMove(state, move);
  const s = clone(state);
  const seat = s.turnSeat;
  const events: GameEvent[] = [{ type: move.kind, seat, detail: move }];

  if (move.kind === "END_TURN") {
    advanceTurn(s);
    return { state: s, awaiting: s.awaiting, events };
  }

  // THROW: spend the balloon, then run the attack state machine.
  const hand = s.players[seat]!.hand;
  const idx = hand.findIndex((c) => c.kind === "balloon");
  const [balloon] = hand.splice(idx, 1);
  s.mainDiscard.push(balloon!);
  const outcome: AttackOutcome = startAttack(s, seat, move.target);
  if (outcome.resolved) finishAttack(s, outcome.hit);
  return { state: s, awaiting: s.awaiting, events };
}

export function applyResolution(state: GameState, res: Resolution): ApplyResult {
  validateResolution(state, res);
  const s = clone(state);
  const seat = actingSeat(s);
  const events: GameEvent[] = [{ type: res.kind, seat, detail: res }];
  const outcome = advanceAttack(s, res);
  if (outcome.resolved) finishAttack(s, outcome.hit);
  return { state: s, awaiting: s.awaiting, events };
}

export function isGameOver(s: GameState): boolean {
  return s.over;
}
