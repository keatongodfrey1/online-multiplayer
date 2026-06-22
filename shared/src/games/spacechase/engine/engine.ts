/**
 * Space Chase - the pure rules engine. No @colyseus/schema, no Colyseus, no
 * I/O: createGame + applyMove/applyResolution are deterministic pure functions
 * that clone the state, mutate the clone, and return it with the events that
 * occurred. The room is a thin adapter that sanitizes input, calls these, and
 * mirrors the result into the synced schema.
 *
 * Implements the INTENDED rules from GAME_RULES.md / MECHANICS_AND_RULINGS.md
 * (round-based Shield, wearer-only Space-Suit doubling on "everyone" cards,
 * centralized portal entry, Time Loop replay, 6-7 second-draw, etc.).
 *
 * Turn flow:
 *   beginTurn  -> (skip while lostTurns) -> awaiting ACTION
 *   applyMove ROLL/DRAW -> resolveCard -> finishAction | open a prompt
 *   applyResolution (prompt answer) -> ... -> finishAction
 *   finishAction -> collisions -> win / tiebreaker -> advanceTurn
 *   advanceTurn -> extra turn (same seat) | next live seat (roundNumber++ on wrap)
 */
import {
  type CardDef,
  getCard,
  SC_FINISH,
  SC_SATELLITE_PEEK,
  SC_SHIELD_ROUNDS,
  SC_START,
  ScAwait,
  ScChoice,
  ScEvent,
  ScPrompt,
} from "../constants.js";
import {
  buildDeck,
  moveBy,
  nearestAhead,
  scanCollisions,
  teleportTo,
  type MoveStep,
} from "./board.js";
import { nextRandom, shuffle } from "./rng.js";
import type {
  ApplyResult,
  Awaiting,
  EngineSeat,
  GameEvent,
  GameState,
  Move,
  RankEntry,
  Resolution,
} from "./types.js";

export const ENGINE_VERSION = "sc-1";

/** Rover (#8): everyone else forward 5, the drawer forward 7. */
const ROVER_OTHERS = 5;
const ROVER_SELF = 7;
/** Shooting Star / Rocket landmark + the "6-7" second-draw destination. */
const STAR_SPACE = 33;
const SIX_SEVEN_SECOND = 67;

// ── small helpers ────────────────────────────────────────────────────────

/** Deep clone via JSON: GameState is pure JSON (numbers/strings/bools/arrays). */
function clone(state: GameState): GameState {
  return JSON.parse(JSON.stringify(state)) as GameState;
}

function ev(kind: string, seat: number, a: number, b: number, text: string): GameEvent {
  return { kind, seat, a, b, text };
}

function actionAwaiting(seat: number): Awaiting {
  return { seat, inputType: ScAwait.ACTION, context: "", cardId: 0, mult: 1, count: 0, targetSeat: -1, peek: [] };
}

function spaceName(space: number): string {
  if (space <= SC_START) return "START";
  if (space >= SC_FINISH) return "the Finish";
  return `space ${space}`;
}

function rollDie(state: GameState): number {
  if (state.forcedRolls.length > 0) return state.forcedRolls.shift()!;
  return 1 + Math.floor(nextRandom(state) * 6);
}

function drawTop(state: GameState, events: GameEvent[]): CardDef {
  if (state.deck.length === 0) {
    state.deck = shuffle(state.discard, () => nextRandom(state));
    state.discard = [];
    events.push(ev(ScEvent.RESHUFFLE, -1, 0, 0, "The deck runs out and is reshuffled!"));
  }
  const id = state.deck.pop()!;
  state.discard.push(id);
  return getCard(id)!;
}

function isShielded(state: GameState, seat: EngineSeat): boolean {
  return seat.shieldExpiresRound > 0 && state.roundNumber < seat.shieldExpiresRound;
}

/** The Space Suit is consumed by the very next card or roll, no matter what. */
function consumeSuit(seat: EngineSeat): number {
  if (!seat.spaceSuit) return 1;
  seat.spaceSuit = false;
  return 2;
}

function shieldBlock(state: GameState, i: number, card: CardDef, events: GameEvent[]): void {
  events.push(ev(ScEvent.SHIELD_BLOCK, i, 0, card.id, `${state.players[i]!.name}'s Shield blocks ${card.name}!`));
}

function emitSteps(state: GameState, i: number, steps: MoveStep[], events: GameEvent[]): void {
  const name = state.players[i]!.name;
  for (const step of steps) {
    switch (step.kind) {
      case "move":
        events.push(ev(ScEvent.MOVE, i, step.from, step.to,
          `${name} ${step.to > step.from ? "moves forward" : "goes back"} to ${spaceName(step.to)}`));
        break;
      case "teleport":
        events.push(ev(ScEvent.TELEPORT, i, step.from, step.to,
          step.to === SC_START ? `${name} is sent back to START!` : `${name} teleports to ${spaceName(step.to)}!`));
        break;
      case "enterPortal":
        events.push(ev(ScEvent.ENTER_PORTAL, i, step.portalId, step.mouth,
          `${name} is pulled into the portal at space ${step.mouth}!`));
        break;
      case "portalMove":
        events.push(ev(ScEvent.PORTAL_MOVE, i, step.from, step.to, `${name} travels through the portal`));
        break;
      case "exitPortal":
        events.push(ev(ScEvent.EXIT_PORTAL, i, step.portalId, step.mouth, `${name} exits the portal at space ${step.mouth}`));
        break;
    }
  }
}

function liveCount(state: GameState): number {
  return state.players.filter((p) => !p.gone).length;
}

function nextLiveIndex(state: GameState, from: number): number {
  const n = state.players.length;
  for (let k = 1; k <= n; k++) {
    const idx = (from + k) % n;
    if (!state.players[idx]!.gone) return idx;
  }
  return from;
}

// ── turn machine ───────────────────────────────────────────────────────────

/** Start (and, while lost turns remain, skip past) a turn for seat `i`. */
function beginTurn(state: GameState, i: number, events: GameEvent[]): void {
  if (state.over) return;
  let cur = i;
  let guard = 0;
  while (++guard < 100000) {
    const seat = state.players[cur]!;
    seat.justExitedPortal = 0; // the re-entry guard lifts at the owner's turn start
    state.awaiting = actionAwaiting(cur);
    state.turnCount++;
    if (seat.lostTurns > 0) {
      seat.lostTurns--;
      events.push(ev(ScEvent.SKIP_TURN, cur, seat.lostTurns, 0,
        `${seat.name} loses a turn${seat.lostTurns > 0 ? ` (${seat.lostTurns} more to go)` : ""}`));
      const n = nextLiveIndex(state, cur);
      if (n <= cur) state.roundNumber++; // wrapped to (or past) the front = one go-around
      cur = n;
      continue;
    }
    return; // an actionable ACTION turn is set
  }
}

/** After a completed action: extra turn (same seat) or pass to the next live seat. */
function advanceTurn(state: GameState, events: GameEvent[]): void {
  if (state.over) return;
  const i = state.awaiting.seat;
  const cur = state.players[i]!;
  if (!cur.gone && cur.extraTurns > 0) {
    cur.extraTurns--;
    events.push(ev(ScEvent.EXTRA_TURNS, i, cur.extraTurns, 0, `${cur.name} goes again!`));
    beginTurn(state, i, events);
    return;
  }
  const n = nextLiveIndex(state, i);
  if (n <= i) state.roundNumber++;
  beginTurn(state, n, events);
}

/** Collisions, then win / tiebreaker, then hand off the turn. */
function finishAction(state: GameState, events: GameEvent[]): void {
  if (state.over) return;

  // 2+ rockets sharing a board space -> ALL back to START. One scan after the
  // movement fully resolves (so an "everyone" card collides once, not mid-step).
  for (const group of scanCollisions(state.players)) {
    const space = state.players[group[0]!]!.position;
    const names = group.map((j) => state.players[j]!.name).join(" and ");
    for (const j of group) {
      const s = state.players[j]!;
      s.position = SC_START;
      s.portalId = 0;
      s.portalProgress = 0;
      s.portalForward = true;
      s.justExitedPortal = 0;
    }
    events.push(ev(ScEvent.COLLISION, -1, space, 0, `${names} collide on space ${space} - everyone back to START!`));
  }

  // Finishers: on or past the Finish, and NOT inside a portal (you can't win
  // from a tunnel - your position is frozen at the entry mouth).
  const finishers = state.players.filter((p) => !p.gone && p.portalId === 0 && p.position >= SC_FINISH).map((p) => p.seat);
  if (finishers.length === 1) {
    win(state, finishers[0]!, events);
    return;
  }
  if (finishers.length > 1) {
    tiebreaker(state, finishers, events);
    return;
  }
  advanceTurn(state, events);
}

function win(state: GameState, seat: number, events: GameEvent[]): void {
  events.push(ev(ScEvent.WIN, seat, state.players[seat]!.position, 0, `${state.players[seat]!.name} reaches the Finish and WINS!`));
  state.over = true;
  state.winner = seat;
  state.awaiting = { seat, inputType: "", context: "", cardId: 0, mult: 1, count: 0, targetSeat: -1, peek: [] };
}

/** Simultaneous finishers: dice roll-off, highest wins, re-roll ties. */
function tiebreaker(state: GameState, finishers: number[], events: GameEvent[]): void {
  events.push(ev(ScEvent.TIEBREAK_START, -1, 0, 0, "Photo finish! The tied players roll off - highest roll wins!"));
  let contenders = finishers.slice();
  for (let round = 0; round < 100; round++) {
    const rolls = contenders.map(() => rollDie(state));
    contenders.forEach((j, k) => events.push(ev(ScEvent.TIEBREAK_ROLL, j, rolls[k]!, 0, `${state.players[j]!.name} rolls a ${rolls[k]}`)));
    const top = Math.max(...rolls);
    const winners = contenders.filter((_, k) => rolls[k] === top);
    if (winners.length === 1) {
      win(state, winners[0]!, events);
      return;
    }
    events.push(ev(ScEvent.TIEBREAK_START, -1, 0, 0, "Still tied - roll again!"));
    contenders = winners;
  }
  win(state, contenders[0]!, events); // unreachable safety stop
}

// ── createGame ──────────────────────────────────────────────────────────────

export function createGame(playerCount: number, seed: number, names: string[] = []): GameState {
  const state: GameState = {
    engineVersion: ENGINE_VERSION,
    seed: seed >>> 0,
    rngState: seed >>> 0,
    forcedRolls: [],
    players: [],
    deck: [],
    discard: [],
    roundNumber: 0,
    turnCount: 0,
    awaiting: actionAwaiting(0),
    over: false,
    winner: null,
  };
  for (let i = 0; i < playerCount; i++) {
    state.players.push({
      seat: i,
      name: names[i] ?? `Player ${i + 1}`,
      gone: false,
      position: SC_START,
      portalId: 0,
      portalProgress: 0,
      portalForward: true,
      justExitedPortal: 0,
      lostTurns: 0,
      extraTurns: 0,
      shieldExpiresRound: 0,
      spaceSuit: false,
      sixSevenCount: 0,
      lastActionType: "",
      lastActionValue: 0,
    });
  }
  state.deck = buildDeck(() => nextRandom(state));
  beginTurn(state, 0, []); // seat 0 goes first (no lost turns at the start)
  return state;
}

// ── applyMove (ROLL / DRAW) ──────────────────────────────────────────────────

export function isLegalMove(state: GameState, move: Move): boolean {
  return !state.over && state.awaiting.inputType === ScAwait.ACTION && (move.kind === "ROLL" || move.kind === "DRAW");
}

export function applyMove(state: GameState, move: Move): ApplyResult {
  const s = clone(state);
  const events: GameEvent[] = [];
  if (s.over || s.awaiting.inputType !== ScAwait.ACTION) return { state: s, events };
  const i = s.awaiting.seat;
  const seat = s.players[i]!;

  if (move.kind === "ROLL") {
    const mult = consumeSuit(seat);
    const die = rollDie(s);
    const amount = die * mult;
    seat.lastActionType = "dice";
    seat.lastActionValue = amount; // stored ALREADY doubled (Time Loop replays this)
    events.push(ev(ScEvent.ROLL, i, die, amount,
      `${seat.name} rolls a ${die}${mult > 1 ? ` - doubled to ${amount} by the Space Suit!` : ""}`));
    emitSteps(s, i, moveBy(seat, amount), events);
    finishAction(s, events);
  } else {
    const card = drawTop(s, events);
    const mult = consumeSuit(seat);
    // Time Loop must read the action BEFORE it, so drawing it never overwrites.
    if (card.type !== "timeLoop") {
      seat.lastActionType = "card";
      seat.lastActionValue = card.id;
    }
    events.push(ev(ScEvent.DRAW, i, 0, card.id, `${seat.name} draws ${card.name}`));
    resolveCard(s, i, card, mult, events);
  }
  return { state: s, events };
}

// ── card resolution ──────────────────────────────────────────────────────────

/**
 * Apply a drawn card. Either resolves fully and calls finishAction, or opens a
 * prompt (sets awaiting and returns - the answer arrives via applyResolution).
 * A card with no useful effect still spends the turn.
 */
function resolveCard(state: GameState, i: number, card: CardDef, mult: number, events: GameEvent[]): void {
  const seat = state.players[i]!;
  switch (card.type) {
    case "moveForward":
      emitSteps(state, i, moveBy(seat, card.amount! * mult), events);
      return finishAction(state, events);
    case "moveBack":
      if (isShielded(state, seat)) shieldBlock(state, i, card, events);
      else emitSteps(state, i, moveBy(seat, -card.amount! * mult), events);
      return finishAction(state, events);
    case "moveAll":
      // Space Suit doubles ONLY the wearer's movement; everyone else moves base.
      state.players.forEach((o, j) => {
        if (o.gone) return;
        emitSteps(state, j, moveBy(o, card.amount! * (j === i ? mult : 1)), events);
      });
      return finishAction(state, events);
    case "moveAllBack":
      state.players.forEach((o, j) => {
        if (o.gone) return;
        if (isShielded(state, o)) shieldBlock(state, j, card, events);
        else emitSteps(state, j, moveBy(o, -card.amount! * (j === i ? mult : 1)), events);
      });
      return finishAction(state, events);
    case "rover":
      state.players.forEach((o, j) => {
        if (o.gone || j === i) return;
        emitSteps(state, j, moveBy(o, ROVER_OTHERS), events);
      });
      emitSteps(state, i, moveBy(seat, ROVER_SELF * mult), events);
      return finishAction(state, events);
    case "teleport":
      // Time Bomb (-> START) is a negative effect a shield blocks even when
      // self-drawn; landmark "go to" teleports are never blocked.
      if (card.destination === SC_START && isShielded(state, seat)) shieldBlock(state, i, card, events);
      else emitSteps(state, i, teleportTo(seat, card.destination!), events);
      return finishAction(state, events);
    case "extraTurns":
      seat.extraTurns += card.amount! * mult;
      events.push(ev(ScEvent.EXTRA_TURNS, i, seat.extraTurns, 0, `${seat.name} will take ${card.amount! * mult} extra turn(s)!`));
      return finishAction(state, events);
    case "loseTurns":
      if (isShielded(state, seat)) shieldBlock(state, i, card, events);
      else {
        seat.lostTurns += card.amount! * mult;
        events.push(ev(ScEvent.LOSE_TURNS, i, seat.lostTurns, 0, `${seat.name} loses ${card.amount! * mult} turn(s)!`));
      }
      return finishAction(state, events);
    case "shield":
      seat.shieldExpiresRound = state.roundNumber + SC_SHIELD_ROUNDS;
      events.push(ev(ScEvent.SHIELD_ON, i, seat.shieldExpiresRound, 0, `${seat.name} raises a Shield for the next ${SC_SHIELD_ROUNDS} rounds!`));
      return finishAction(state, events);
    case "spaceSuit":
      seat.spaceSuit = true;
      events.push(ev(ScEvent.SUIT_ON, i, 0, 0, `${seat.name} puts on the Space Suit - the next card is doubled!`));
      return finishAction(state, events);
    case "attack":
      // Black Hole = target then a destination space; the rest = single target.
      state.awaiting = {
        seat: i,
        inputType: ScAwait.TARGET,
        context: card.action === "blackHole" ? ScPrompt.BLACKHOLE_TARGET : ScPrompt.ATTACK_TARGET,
        cardId: card.id,
        mult,
        count: 0,
        targetSeat: -1,
        peek: [],
      };
      return;
    case "spaceKraken":
      state.awaiting = { seat: i, inputType: ScAwait.CHOICE, context: ScPrompt.KRAKEN_CHOICE, cardId: card.id, mult, count: 0, targetSeat: -1, peek: [] };
      return;
    case "shootingStar":
      state.awaiting = { seat: i, inputType: ScAwait.CHOICE, context: ScPrompt.STAR_CHOICE, cardId: card.id, mult, count: 0, targetSeat: -1, peek: [] };
      return;
    case "sixSeven":
      seat.sixSevenCount++;
      if (seat.sixSevenCount >= 2) {
        events.push(ev(ScEvent.NOOP, i, 0, card.id, `${seat.name}'s second 6-7 sends THEM to Space ${SIX_SEVEN_SECOND}!`));
        emitSteps(state, i, teleportTo(seat, SIX_SEVEN_SECOND), events);
        return finishAction(state, events);
      }
      state.awaiting = { seat: i, inputType: ScAwait.TARGET, context: ScPrompt.SIXSEVEN_TARGET, cardId: card.id, mult, count: 0, targetSeat: -1, peek: [] };
      return;
    case "timeLoop":
      return resolveTimeLoop(state, i, events);
    case "rocketJump":
      resolveRocket(state, i, events);
      return finishAction(state, events);
    case "satellite":
      return openSatellite(state, i, events);
    default:
      events.push(ev(ScEvent.NOOP, i, 0, card.id, `${card.name} fizzles - nothing happens`));
      return finishAction(state, events);
  }
}

function resolveTimeLoop(state: GameState, i: number, events: GameEvent[]): void {
  const seat = state.players[i]!;
  if (seat.lastActionType === "") {
    events.push(ev(ScEvent.NOOP, i, 0, 0, `${seat.name} plays Time Loop but has no previous turn to repeat`));
    return finishAction(state, events);
  }
  if (seat.lastActionType === "dice") {
    events.push(ev(ScEvent.NOOP, i, seat.lastActionValue, 0, `${seat.name} repeats their last roll of ${seat.lastActionValue}`));
    emitSteps(state, i, moveBy(seat, seat.lastActionValue), events);
    return finishAction(state, events);
  }
  const card = getCard(seat.lastActionValue);
  if (!card) return finishAction(state, events);
  events.push(ev(ScEvent.NOOP, i, 0, card.id, `${seat.name} repeats their last card: ${card.name}`));
  // Replay at mult 1 (any Space Suit was consumed by drawing Time Loop itself).
  // resolveCard re-resolves it - immediate cards finish; prompt cards re-open.
  resolveCard(state, i, card, 1, events);
}

function resolveRocket(state: GameState, i: number, events: GameEvent[]): void {
  const seat = state.players[i]!;
  const target = nearestAhead(state.players, i);
  if (target < 0) {
    events.push(ev(ScEvent.NOOP, i, 0, 0, `${seat.name} fires the Rocket but nobody is ahead - nothing happens`));
    return;
  }
  const dest = Math.min(state.players[target]!.position + 1, SC_FINISH);
  events.push(ev(ScEvent.NOOP, i, 0, 0, `${seat.name} rockets ahead of ${state.players[target]!.name}!`));
  emitSteps(state, i, teleportTo(seat, dest), events);
}

function openSatellite(state: GameState, i: number, events: GameEvent[]): void {
  // Top up from the discard if the draw pile is too short to peek a full hand.
  if (state.deck.length < SC_SATELLITE_PEEK && state.discard.length > 0) {
    const reshuffled = shuffle(state.discard, () => nextRandom(state));
    state.deck = [...reshuffled, ...state.deck]; // discard goes UNDER the remaining deck (top = last)
    state.discard = [];
    events.push(ev(ScEvent.RESHUFFLE, -1, 0, 0, "The Satellite tops up the deck (discard reshuffled underneath)."));
  }
  const peekCount = Math.min(SC_SATELLITE_PEEK, state.deck.length);
  const peek: number[] = [];
  for (let k = 0; k < peekCount; k++) peek.push(state.deck[state.deck.length - 1 - k]!); // next-draw first
  state.awaiting = { seat: i, inputType: ScAwait.SATELLITE, context: ScPrompt.SATELLITE, cardId: 40, mult: 1, count: peekCount, targetSeat: -1, peek };
}

// ── applyResolution (prompt answers) ─────────────────────────────────────────

export function applyResolution(state: GameState, res: Resolution): ApplyResult {
  const s = clone(state);
  const events: GameEvent[] = [];
  if (s.over) throw new Error("game over");
  const aw = s.awaiting;
  const expected: Record<Resolution["kind"], string> = {
    TARGET: ScAwait.TARGET,
    TARGETS: ScAwait.MULTI_TARGET,
    CHOICE: ScAwait.CHOICE,
    SPACE: ScAwait.SPACE,
    SATELLITE: ScAwait.SATELLITE,
  };
  if (aw.inputType !== expected[res.kind]) throw new Error("resolution does not match the open prompt");
  const i = aw.seat;
  switch (res.kind) {
    case "TARGET":
      resolveTarget(s, i, res.seat, events);
      break;
    case "TARGETS":
      resolveTargets(s, i, res.seats, events);
      break;
    case "CHOICE":
      resolveChoice(s, i, res.choice, events);
      break;
    case "SPACE":
      resolveSpace(s, i, res.space, events);
      break;
    case "SATELLITE":
      resolveSatellite(s, i, res.order, events);
      break;
  }
  return { state: s, events };
}

/** Whether a card step may target the actor themselves. */
function selfAllowed(context: string, cardId: number): boolean {
  if (context === ScPrompt.BLACKHOLE_TARGET) return false;
  if (context === ScPrompt.ATTACK_TARGET && getCard(cardId)?.action === "wormHole") return false;
  return true;
}

function validTargets(state: GameState, i: number, context: string, cardId: number): number[] {
  const allowSelf = selfAllowed(context, cardId);
  return state.players.filter((p) => !p.gone && (p.seat !== i || allowSelf)).map((p) => p.seat);
}

function resolveTarget(state: GameState, i: number, targetSeat: number, events: GameEvent[]): void {
  const aw = state.awaiting;
  if (!validTargets(state, i, aw.context, aw.cardId).includes(targetSeat)) throw new Error("illegal target");
  const card = getCard(aw.cardId)!;
  switch (aw.context) {
    case ScPrompt.ATTACK_TARGET:
      applyAttack(state, i, targetSeat, card, aw.mult, events);
      return finishAction(state, events);
    case ScPrompt.BLACKHOLE_TARGET:
      // Step 1 of Black Hole: remember the victim, ask for a destination space.
      state.awaiting = { ...aw, inputType: ScAwait.SPACE, context: ScPrompt.BLACKHOLE_SPACE, targetSeat };
      return;
    case ScPrompt.KRAKEN_ONE: {
      const target = state.players[targetSeat]!;
      if (isShielded(state, target)) shieldBlock(state, targetSeat, card, events);
      else {
        target.lostTurns += 3 * aw.mult;
        events.push(ev(ScEvent.LOSE_TURNS, targetSeat, target.lostTurns, 0, `${target.name} loses ${3 * aw.mult} turns to the Kraken!`));
      }
      return finishAction(state, events);
    }
    case ScPrompt.STAR_TARGET:
      emitSteps(state, targetSeat, teleportTo(state.players[targetSeat]!, STAR_SPACE), events);
      return finishAction(state, events);
    case ScPrompt.SIXSEVEN_TARGET:
      // Step 1 of 6-7: remember the victim, ask whether Space 6 or 7.
      state.awaiting = { ...aw, inputType: ScAwait.CHOICE, context: ScPrompt.SIXSEVEN_SPACE, targetSeat };
      return;
    default:
      throw new Error("unexpected target context");
  }
}

function resolveTargets(state: GameState, i: number, seats: number[], events: GameEvent[]): void {
  const aw = state.awaiting;
  if (aw.context !== ScPrompt.KRAKEN_THREE) throw new Error("unexpected multi-target context");
  if (!Array.isArray(seats) || seats.length !== aw.count) throw new Error("wrong number of targets");
  const valid = new Set(validTargets(state, i, aw.context, aw.cardId));
  const seen = new Set<number>();
  for (const t of seats) {
    if (!valid.has(t) || seen.has(t)) throw new Error("illegal multi-target");
    seen.add(t);
  }
  const card = getCard(aw.cardId)!;
  for (const t of seats) {
    const target = state.players[t]!;
    if (isShielded(state, target)) shieldBlock(state, t, card, events);
    else {
      target.lostTurns += 1 * aw.mult;
      events.push(ev(ScEvent.LOSE_TURNS, t, target.lostTurns, 0, `${target.name} loses ${1 * aw.mult} turn to the Kraken!`));
    }
  }
  return finishAction(state, events);
}

function resolveChoice(state: GameState, i: number, choice: string, events: GameEvent[]): void {
  const aw = state.awaiting;
  switch (aw.context) {
    case ScPrompt.KRAKEN_CHOICE:
      if (choice === ScChoice.KRAKEN_ONE) {
        state.awaiting = { ...aw, inputType: ScAwait.TARGET, context: ScPrompt.KRAKEN_ONE };
      } else if (choice === ScChoice.KRAKEN_THREE) {
        state.awaiting = { ...aw, inputType: ScAwait.MULTI_TARGET, context: ScPrompt.KRAKEN_THREE, count: Math.min(3, liveCount(state)) };
      } else throw new Error("illegal Kraken choice");
      return;
    case ScPrompt.STAR_CHOICE:
      if (choice === ScChoice.STAR_SELF) {
        emitSteps(state, i, teleportTo(state.players[i]!, STAR_SPACE), events);
        return finishAction(state, events);
      }
      if (choice === ScChoice.STAR_SEND) {
        state.awaiting = { ...aw, inputType: ScAwait.TARGET, context: ScPrompt.STAR_TARGET };
        return;
      }
      throw new Error("illegal Shooting Star choice");
    case ScPrompt.SIXSEVEN_SPACE: {
      if (choice !== ScChoice.SIX && choice !== ScChoice.SEVEN) throw new Error("illegal 6-7 choice");
      const dest = choice === ScChoice.SIX ? 6 : 7;
      const target = state.players[aw.targetSeat]!;
      emitSteps(state, aw.targetSeat, teleportTo(target, dest), events);
      return finishAction(state, events);
    }
    default:
      throw new Error("unexpected choice context");
  }
}

function resolveSpace(state: GameState, i: number, space: number, events: GameEvent[]): void {
  const aw = state.awaiting;
  if (aw.context !== ScPrompt.BLACKHOLE_SPACE) throw new Error("unexpected space context");
  if (!Number.isInteger(space) || space < 1 || space > 67) throw new Error("space out of range");
  const card = getCard(aw.cardId)!;
  const target = state.players[aw.targetSeat]!;
  if (isShielded(state, target)) shieldBlock(state, aw.targetSeat, card, events);
  else emitSteps(state, aw.targetSeat, teleportTo(target, space), events);
  return finishAction(state, events);
}

function resolveSatellite(state: GameState, i: number, order: number[], events: GameEvent[]): void {
  const aw = state.awaiting;
  if (aw.context !== ScPrompt.SATELLITE) throw new Error("unexpected satellite context");
  const peek = aw.peek;
  const n = peek.length;
  if (!Array.isArray(order) || order.length !== n) throw new Error("satellite order length");
  const seen = new Set<number>();
  for (const x of order) {
    if (!Number.isInteger(x) || x < 0 || x >= n || seen.has(x)) throw new Error("satellite order must be a permutation");
    seen.add(x);
  }
  // Rewrite the top n cards: deck[len-1-k] (the k-th next draw) becomes peek[order[k]].
  for (let k = 0; k < n; k++) state.deck[state.deck.length - 1 - k] = peek[order[k]!]!;
  events.push(ev(ScEvent.SATELLITE, i, 0, 0, `${state.players[i]!.name} rearranges the top of the deck.`));
  return finishAction(state, events);
}

function applyAttack(state: GameState, attacker: number, targetSeat: number, card: CardDef, mult: number, events: GameEvent[]): void {
  const target = state.players[targetSeat]!;
  switch (card.action) {
    case "sendToStart":
      if (isShielded(state, target)) shieldBlock(state, targetSeat, card, events);
      else emitSteps(state, targetSeat, teleportTo(target, SC_START), events);
      return;
    case "moveBack":
      if (isShielded(state, target)) shieldBlock(state, targetSeat, card, events);
      else emitSteps(state, targetSeat, moveBy(target, -card.amount! * mult), events);
      return;
    case "loseTurns":
      if (isShielded(state, target)) shieldBlock(state, targetSeat, card, events);
      else {
        target.lostTurns += card.amount! * mult;
        events.push(ev(ScEvent.LOSE_TURNS, targetSeat, target.lostTurns, 0, `${target.name} loses ${card.amount! * mult} turn(s)!`));
      }
      return;
    case "fighterJet":
      // A shielded target blocks the WHOLE card - the attacker gets no +3.
      if (isShielded(state, target)) {
        shieldBlock(state, targetSeat, card, events);
        return;
      }
      emitSteps(state, targetSeat, moveBy(target, -3 * mult), events);
      emitSteps(state, attacker, moveBy(state.players[attacker]!, 3 * mult), events);
      return;
    case "wormHole": {
      // Swap board positions with an opponent; both leave any portal. A shield
      // on the target (a forced position change) blocks the whole swap.
      if (isShielded(state, target)) {
        shieldBlock(state, targetSeat, card, events);
        return;
      }
      const me = state.players[attacker]!;
      const myPos = me.position;
      const theirPos = target.position;
      events.push(ev(ScEvent.SWAP, attacker, targetSeat, 0, `${me.name} swaps places with ${target.name}!`));
      emitSteps(state, attacker, teleportTo(me, theirPos), events);
      emitSteps(state, targetSeat, teleportTo(target, myPos), events);
      return;
    }
    default:
      return;
  }
}

// ── leaver + timeout helpers (used by the room) ──────────────────────────────

/** A player left for good: rocket off the board, seat skipped; if it was their
 *  turn (incl. an open prompt), the card fizzles and play moves on. */
export function applyLeave(state: GameState, seatIndex: number): ApplyResult {
  const s = clone(state);
  const events: GameEvent[] = [];
  const seat = s.players[seatIndex];
  if (!seat || seat.gone) return { state: s, events };
  seat.gone = true;
  seat.position = SC_START;
  seat.portalId = 0;
  seat.portalProgress = 0;
  seat.portalForward = true;
  seat.justExitedPortal = 0;
  events.push(ev(ScEvent.NOOP, seatIndex, 0, 0, `${seat.name} has left the race.`));
  if (!s.over && s.awaiting.seat === seatIndex) {
    advanceTurn(s, events);
  } else if (!s.over && s.awaiting.inputType === ScAwait.MULTI_TARGET) {
    // A NON-awaited participant left while a multi-target (Kraken) prompt is
    // open. resolveTargets requires EXACTLY awaiting.count targets, so if the
    // valid-target pool just shrank below count, the awaited seat could never
    // resolve and autoResolve would throw every timer — a soft-lock. Re-clamp
    // count to what remains (may reach 0 = the throw simply hits nobody).
    const aw = s.awaiting;
    const available = validTargets(s, aw.seat, aw.context, aw.cardId).length;
    if (available < aw.count) s.awaiting = { ...aw, count: available };
  }
  return { state: s, events };
}

/** One deterministic auto-decision for a timed-out present player. The room
 *  loops this until the seat's turn ends. ACTION -> ROLL; a prompt -> a sane
 *  default (first legal target, "one"/"self"/"6", keep the peek order). */
export function autoResolve(state: GameState, seatIndex: number): ApplyResult {
  if (state.over || state.awaiting.seat !== seatIndex) return { state: clone(state), events: [] };
  const aw = state.awaiting;
  if (aw.inputType === ScAwait.ACTION) return applyMove(state, { kind: "ROLL" });
  if (aw.inputType === ScAwait.TARGET) {
    const targets = validTargets(state, seatIndex, aw.context, aw.cardId);
    return applyResolution(state, { kind: "TARGET", seat: targets[0] ?? seatIndex });
  }
  if (aw.inputType === ScAwait.MULTI_TARGET) {
    const targets = validTargets(state, seatIndex, aw.context, aw.cardId).slice(0, aw.count);
    return applyResolution(state, { kind: "TARGETS", seats: targets });
  }
  if (aw.inputType === ScAwait.CHOICE) {
    const choice =
      aw.context === ScPrompt.KRAKEN_CHOICE ? ScChoice.KRAKEN_ONE :
      aw.context === ScPrompt.STAR_CHOICE ? ScChoice.STAR_SELF : ScChoice.SIX;
    return applyResolution(state, { kind: "CHOICE", choice });
  }
  if (aw.inputType === ScAwait.SPACE) return applyResolution(state, { kind: "SPACE", space: 1 });
  if (aw.inputType === ScAwait.SATELLITE) return applyResolution(state, { kind: "SATELLITE", order: aw.peek.map((_, k) => k) });
  return { state: clone(state), events: [] };
}

// ── queries (tests, save validation, summary) ────────────────────────────────

/**
 * Whether the seat the engine is currently awaiting has at least one legal way
 * to proceed (a move it can make, or a prompt answer that resolves without
 * throwing). The soft-lock detector in assertInvariants uses this: a running
 * game whose awaited seat can do NOTHING is a dead end. Returns true for a
 * finished game (nothing is awaited). Never mutates `state`.
 */
export function legalActionExists(state: GameState): boolean {
  if (state.over) return true;
  const aw = state.awaiting;
  const seat = state.players[aw.seat];
  if (!seat || seat.gone) return false;
  switch (aw.inputType) {
    case ScAwait.ACTION:
      // ROLL is always available (rolling a die and moving 0+ is legal), and so
      // is DRAW (the pile is never empty - it reshuffles the discard).
      return isLegalMove(state, { kind: "ROLL" }) || isLegalMove(state, { kind: "DRAW" });
    case ScAwait.TARGET:
      // At least one legal target must exist (else resolveTarget would throw).
      return validTargets(state, aw.seat, aw.context, aw.cardId).length > 0;
    case ScAwait.MULTI_TARGET:
      return validTargets(state, aw.seat, aw.context, aw.cardId).length >= aw.count;
    case ScAwait.CHOICE:
      // Every CHOICE context has at least one self-resolving option, but a
      // Kraken "three"/"one" choice that leaves no legal target is a dead end;
      // the autoResolver picks "one"/"self"/"6", all of which resolve here so
      // long as there is at least one target where the chosen branch needs one.
      if (aw.context === ScPrompt.KRAKEN_CHOICE) {
        // "one" needs >=1 target; if even that is impossible the choice is stuck.
        return validTargets(state, aw.seat, ScPrompt.KRAKEN_ONE, aw.cardId).length > 0;
      }
      return true; // star-choice (self), sixseven-space (6/7) always resolve
    case ScAwait.SPACE:
      return true; // any space 1..67 resolves (target is fixed from step 1)
    case ScAwait.SATELLITE:
      return true; // the identity reorder always resolves
    default:
      return false;
  }
}

/** Live seats ranked by board position (ties share a rank). For the summary. */
export function ranking(state: GameState): RankEntry[] {
  const sorted = state.players
    .filter((p) => !p.gone)
    .map((p) => ({ seat: p.seat, position: p.position }))
    .sort((a, b) => b.position - a.position);
  let rank = 0;
  let lastPos = -1;
  return sorted.map((e, k) => {
    if (e.position !== lastPos) {
      rank = k + 1;
      lastPos = e.position;
    }
    return { seat: e.seat, position: e.position, rank };
  });
}
