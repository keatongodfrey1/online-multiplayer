// Pure, deterministic Water Fight rules engine (Phase A: basic combat).
// All functions are pure: clone-then-mutate, no I/O, no wall clock, no
// Math.random (the RNG state lives in GameState). The attack ladder lives in
// attack.ts; this module owns the turn flow, draws, damage/soak/win, and the
// legal-move surface that policies (bots/fuzz) read.

import { advanceAttack, startAttack, startBigAttack, type AttackOutcome } from "./attack.js";
import { DRAW_PER_TURN } from "./data.js";
import { discardCard, drawMainCard } from "./deck.js";
import { rand } from "./rng.js";
import {
  ApplyResult,
  Awaiting,
  CardKind,
  GameEvent,
  GameState,
  Move,
  PlayerState,
  Resolution,
  StackId,
  SupportKind,
} from "./types.js";

const STACK_IDS: readonly StackId[] = ["defense", "mischief", "attack"];

function clone<T>(x: T): T {
  return structuredClone(x);
}

/** Support cards whose effect is implemented (grows each Phase B slice). Only
 *  these are offered by legalMoves, so a bot/fuzz never plays an unimplemented one.
 *  Deferred (need a peek/choose sub-decision): goggles, sneakypeek. */
const SUPPORT_IMPLEMENTED: SupportKind[] = [
  "firstaid", "backpack", "hiddenstash",
  "needle", "pickpocket", "sabotage", "cardswap", "freezeout", "lemonadespill", "switcheroo",
];
/** Supports that require an opponent target. */
const TARGETED_SUPPORTS = new Set<SupportKind>([
  "needle", "pickpocket", "sabotage", "cardswap", "freezeout", "lemonadespill", "switcheroo",
]);

export function livingSeats(s: GameState): number[] {
  return s.players.filter((p) => !p.out).map((p) => p.seat);
}

function handHas(p: PlayerState, kind: CardKind): boolean {
  return p.hand.some((c) => c.kind === kind);
}

function handCount(p: PlayerState, kind: CardKind): number {
  return p.hand.reduce((n, c) => n + (c.kind === kind ? 1 : 0), 0);
}

/** A minimal sell (preferring Treasure/balloons, preserving the Wild) reaching
 *  `cost` coins; null if unaffordable. Balloon=1, Treasure=2, Wild=5 coins. */
function minimalSell(p: PlayerState, cost: number): { balloons: number; treasures: number; wild: number } | null {
  const b = handCount(p, "balloon");
  const t = handCount(p, "treasure");
  const w = handCount(p, "wild");
  let coins = 0;
  let sb = 0;
  let st = 0;
  let sw = 0;
  while (coins < cost && st < t) {
    st += 1;
    coins += 2;
  }
  while (coins < cost && sb < b) {
    sb += 1;
    coins += 1;
  }
  if (coins < cost && w > 0) {
    sw = 1;
    coins += 5;
  }
  return coins >= cost ? { balloons: sb, treasures: st, wild: sw } : null;
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

/** Begin a seat's turn: apply pending statuses, draw, await their action. */
export function startTurn(s: GameState, seat: number): void {
  s.turnSeat = seat;
  s.supportUsed = false;
  const p = s.players[seat]!;
  const draw = p.statuses.freezeOut ? 1 : DRAW_PER_TURN; // Freeze Out
  p.statuses.freezeOut = false;
  drawCards(s, seat, draw);
  s.awaiting = { seats: [seat], kind: "MOVE" };
}

/** Discard `n` random cards from a seat's hand (uses the game RNG). */
function discardRandom(s: GameState, seat: number, n: number): void {
  const hand = s.players[seat]!.hand;
  for (let i = 0; i < n && hand.length > 0; i++) {
    discardCard(s, hand.splice(Math.floor(rand(s) * hand.length), 1)[0]!);
  }
}

/** Swap up to 2 random cards each way between two hands (Card Swap). */
function cardSwap(s: GameState, a: number, b: number): void {
  const ha = s.players[a]!.hand;
  const hb = s.players[b]!.hand;
  for (let i = 0; i < 2; i++) {
    if (ha.length === 0 || hb.length === 0) break;
    const ca = ha.splice(Math.floor(rand(s) * ha.length), 1)[0]!;
    const cb = hb.splice(Math.floor(rand(s) * hb.length), 1)[0]!;
    ha.push(cb);
    hb.push(ca);
  }
}

/** Support card effects. Targeting Mischief cards apply immediately (the Towel
 *  reaction window arrives in B.6); "their choice" discards are randomized here. */
function applySupport(s: GameState, seat: number, support: SupportKind, target?: number): void {
  const p = s.players[seat]!;
  switch (support) {
    case "firstaid":
      p.lives = Math.min(s.options.startingLives, p.lives + 1); // E8: cap at starting lives
      return;
    case "backpack":
      drawCards(s, seat, 2);
      return;
    case "hiddenstash": {
      let taken = 0; // search the discard, take up to 2 Treasure
      for (let i = s.mainDiscard.length - 1; i >= 0 && taken < 2; i--) {
        if (s.mainDiscard[i]!.kind === "treasure") {
          p.hand.push(s.mainDiscard.splice(i, 1)[0]!);
          taken += 1;
        }
      }
      return;
    }
    case "needle": {
      const t = s.players[target!]!;
      const balloons = t.hand.filter((c) => c.kind === "balloon");
      t.hand = t.hand.filter((c) => c.kind !== "balloon");
      for (const c of balloons) discardCard(s, c);
      return;
    }
    case "pickpocket": {
      const t = s.players[target!]!;
      const idx = t.hand.findIndex((c) => c.kind === "treasure");
      if (idx >= 0) p.hand.push(t.hand.splice(idx, 1)[0]!);
      return;
    }
    case "sabotage":
      discardRandom(s, target!, 2);
      return;
    case "lemonadespill":
      discardRandom(s, target!, 1);
      s.players[target!]!.statuses.noShop = true;
      return;
    case "freezeout":
      s.players[target!]!.statuses.freezeOut = true;
      return;
    case "cardswap":
      cardSwap(s, seat, target!);
      return;
    case "switcheroo": {
      const t = s.players[target!]!;
      const tmp = p.hand;
      p.hand = t.hand;
      t.hand = tmp;
      return;
    }
    default:
      throw new Error(`support ${support} not implemented yet`);
  }
}

/** End the active player's turn: discard down to the hand limit, then advance. */
function endActiveTurn(s: GameState): void {
  if (s.over) return;
  const seat = s.turnSeat;
  if (s.players[seat]!.hand.length > s.options.handLimit) {
    s.awaiting = { seats: [seat], kind: "DISCARD" };
    return;
  }
  advanceTurn(s);
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
  s.players[s.turnSeat]!.statuses.noShop = false; // the finishing player's Lemonade Spill lifts
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
  if (atk.kind === "golden") {
    drawCards(s, atk.attackerSeat, 2); // Golden draws 2 whether it hits or misses
    s.log.push(`seat ${atk.attackerSeat} draws 2 (Golden)`);
  }
  s.awaiting = { seats: [], kind: "GAME_OVER" }; // cleared; reset by advanceTurn unless over
  const living = livingSeats(s);
  if (living.length <= 1) {
    endGame(s, living[0] ?? null, "last-standing");
    return;
  }
  endActiveTurn(s);
}

// ---- legal surface ----------------------------------------------------------

export function legalMoves(s: GameState): Move[] {
  if (s.over || s.awaiting.kind !== "MOVE") return [];
  const seat = s.turnSeat;
  const p = s.players[seat]!;
  const opponents = livingSeats(s).filter((t) => t !== seat);
  const moves: Move[] = [{ kind: "END_TURN" }];
  if (!s.supportUsed) {
    for (const sup of SUPPORT_IMPLEMENTED) {
      if (!handHas(p, sup)) continue;
      if (TARGETED_SUPPORTS.has(sup)) {
        for (const t of opponents) moves.push({ kind: "PLAY_SUPPORT", support: sup, target: t });
      } else {
        moves.push({ kind: "PLAY_SUPPORT", support: sup });
      }
    }
  }
  if (handHas(p, "balloon")) for (const t of opponents) moves.push({ kind: "THROW", target: t });
  for (const big of ["mega", "giant", "golden"] as const) {
    if (handHas(p, big)) for (const t of opponents) moves.push({ kind: "PLAY_BIG", big, target: t });
  }
  const sell = minimalSell(p, s.options.shopCost);
  if (sell && !p.statuses.noShop) {
    for (const st of STACK_IDS) if (s.stacks[st].length > 0) moves.push({ kind: "SHOP", sell, buy: [st] });
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
  if (move.kind === "PLAY_SUPPORT") {
    if (s.supportUsed) throw new Error("already used a Support this turn");
    if (!SUPPORT_IMPLEMENTED.includes(move.support)) throw new Error(`support ${move.support} not available`);
    if (!handHas(p, move.support)) throw new Error(`no ${move.support} in hand`);
    if (TARGETED_SUPPORTS.has(move.support)) {
      if (move.target === undefined || move.target === seat) throw new Error("invalid Support target");
      const t = s.players[move.target];
      if (!t || t.out) throw new Error("target not a living player");
    }
    return;
  }
  if (move.kind === "SHOP") {
    if (p.statuses.noShop) throw new Error("cannot Shop this turn (Lemonade Spill)");
    const { balloons, treasures, wild } = move.sell;
    if (balloons < 0 || treasures < 0 || wild < 0 || wild > 1) throw new Error("invalid sell");
    if (handCount(p, "balloon") < balloons) throw new Error("not enough balloons to sell");
    if (handCount(p, "treasure") < treasures) throw new Error("not enough Treasure to sell");
    if (handCount(p, "wild") < wild) throw new Error("not enough Wild to sell");
    if (balloons + treasures * 2 + wild * 5 < move.buy.length * s.options.shopCost) throw new Error("not enough coins");
    const need: Record<StackId, number> = { defense: 0, mischief: 0, attack: 0 };
    for (const st of move.buy) need[st] += 1;
    for (const st of STACK_IDS) if (need[st] > s.stacks[st].length) throw new Error(`stack ${st} has too few cards`);
    return;
  }
  // THROW / PLAY_BIG (targeted)
  if (move.target === seat) throw new Error("cannot target yourself");
  const t = s.players[move.target];
  if (!t || t.out) throw new Error("target not a living player");
  if (move.kind === "THROW") {
    if (!handHas(p, "balloon")) throw new Error("no Water Balloon in hand");
  } else if (!handHas(p, move.big)) {
    throw new Error(`no ${move.big} in hand`);
  }
}

function validateResolution(s: GameState, res: Resolution): void {
  if (s.over) throw new Error("game over");
  if (s.awaiting.kind === "DISCARD") {
    if (res.kind !== "DISCARD") throw new Error("must discard");
    const seat = actingSeat(s);
    const hand = s.players[seat]!.hand;
    const need = hand.length - s.options.handLimit;
    if (res.cardIds.length !== need) throw new Error(`must discard exactly ${need}`);
    if (new Set(res.cardIds).size !== res.cardIds.length) throw new Error("duplicate discard id");
    for (const id of res.cardIds) if (!hand.some((c) => c.id === id)) throw new Error(`card ${id} not in hand`);
    return;
  }
  if (res.kind === "DISCARD") throw new Error("not awaiting a discard");
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
    endActiveTurn(s);
    return { state: s, awaiting: s.awaiting, events };
  }

  if (move.kind === "PLAY_SUPPORT") {
    const supHand = s.players[seat]!.hand;
    const supIdx = supHand.findIndex((c) => c.kind === move.support);
    const [supCard] = supHand.splice(supIdx, 1);
    discardCard(s, supCard!);
    applySupport(s, seat, move.support, move.target);
    s.supportUsed = true;
    s.awaiting = { seats: [seat], kind: "MOVE" }; // Support does NOT end the turn
    return { state: s, awaiting: s.awaiting, events };
  }

  if (move.kind === "SHOP") {
    const hand = s.players[seat]!.hand;
    const sellKind = (kind: CardKind, n: number): void => {
      for (let i = 0; i < n; i++) {
        const idx = hand.findIndex((c) => c.kind === kind);
        const [c] = hand.splice(idx, 1);
        discardCard(s, c!);
      }
    };
    sellKind("balloon", move.sell.balloons);
    sellKind("treasure", move.sell.treasures);
    sellKind("wild", move.sell.wild);
    for (const st of move.buy) {
      const card = s.stacks[st].pop();
      if (card) hand.push(card);
    }
    s.log.push(`seat ${seat} shops -> buys [${move.buy.join(", ")}]`);
    endActiveTurn(s);
    return { state: s, awaiting: s.awaiting, events };
  }

  // THROW / PLAY_BIG: spend the card, then run the attack state machine.
  const hand = s.players[seat]!.hand;
  const cardKind = move.kind === "THROW" ? "balloon" : move.big;
  const idx = hand.findIndex((c) => c.kind === cardKind);
  const [card] = hand.splice(idx, 1);
  discardCard(s, card!);
  const outcome: AttackOutcome =
    move.kind === "THROW"
      ? startAttack(s, seat, move.target)
      : startBigAttack(s, seat, move.target, move.big);
  if (outcome.resolved) finishAttack(s, outcome.hit);
  return { state: s, awaiting: s.awaiting, events };
}

export function applyResolution(state: GameState, res: Resolution): ApplyResult {
  validateResolution(state, res);
  const s = clone(state);
  const seat = actingSeat(s);
  const events: GameEvent[] = [{ type: res.kind, seat, detail: res }];
  if (res.kind === "DISCARD") {
    const hand = s.players[seat]!.hand;
    for (const id of res.cardIds) {
      const idx = hand.findIndex((c) => c.id === id);
      const [card] = hand.splice(idx, 1);
      discardCard(s, card!);
    }
    advanceTurn(s);
    return { state: s, awaiting: s.awaiting, events };
  }
  const outcome = advanceAttack(s, res);
  if (outcome.resolved) finishAttack(s, outcome.hit);
  return { state: s, awaiting: s.awaiting, events };
}

export function isGameOver(s: GameState): boolean {
  return s.over;
}
