/**
 * Space Chase save/resume serialization.
 *
 * The save blob lives in the HOST's browser and is fully untrusted on the way
 * back in: parseSave rebuilds a clean, typed GameState field by field (never
 * trusting the input shape) and runs the engine's invariants before the room
 * will touch it. A tampered or version-mismatched blob returns null and is
 * ignored. serializeSave is the inverse - a plain JSON snapshot.
 */
import { SpaceChaseEngine, isValidSpaceChaseTurnSeconds, ScAwait, ScPrompt, SC_SATELLITE_PEEK } from "@backbone/shared";

type GameState = SpaceChaseEngine.GameState;
type EngineSeat = SpaceChaseEngine.EngineSeat;

const { ENGINE_VERSION, assertInvariants, legalActionExists, isLegalMove, autoResolve } = SpaceChaseEngine;

const SAVE_VERSION = 1;

/** One seat in the saved lineup (FrameworkSaveSeat-compatible; no bots here). */
export interface SaveSeat {
  nickname: string;
  isBot: boolean;
  gone: boolean;
}

export interface ParsedSave {
  engine: GameState;
  seats: SaveSeat[];
  turnSeconds: number;
}

export function serializeSave(input: { engine: GameState; seats: SaveSeat[]; turnSeconds: number }): object {
  return {
    v: SAVE_VERSION,
    game: "spacechase",
    savedAt: Date.now(),
    turnSeconds: input.turnSeconds,
    seats: input.seats.map((s) => ({ nickname: s.nickname, isBot: false, gone: !!s.gone })),
    // The engine state is already plain JSON; deep-copy so the live game and
    // the stored blob never alias.
    engine: JSON.parse(JSON.stringify(input.engine)),
  };
}

// ── validation helpers (reject anything off; rebuild rather than trust) ──

function asObject(v: unknown): Record<string, unknown> | null {
  return typeof v === "object" && v !== null && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
}
function asInt(v: unknown, min: number, max: number): number | null {
  return typeof v === "number" && Number.isInteger(v) && v >= min && v <= max ? v : null;
}
function asBool(v: unknown): boolean {
  return v === true;
}
function asString(v: unknown): string {
  return typeof v === "string" ? v : "";
}
function asCardId(v: unknown): number | null {
  return asInt(v, 1, 41);
}

function parseSeat(raw: unknown, index: number): EngineSeat | null {
  const o = asObject(raw);
  if (!o) return null;
  const position = asInt(o.position, 0, 68);
  if (position === null) return null;
  const portalId = asInt(o.portalId, 0, 3);
  if (portalId === null) return null;
  const portalProgress = asInt(o.portalProgress, 0, 7);
  if (portalProgress === null) return null;
  const justExitedPortal = asInt(o.justExitedPortal, 0, 67);
  if (justExitedPortal === null) return null;
  const lostTurns = asInt(o.lostTurns, 0, 255);
  const extraTurns = asInt(o.extraTurns, 0, 255);
  const shieldExpiresRound = asInt(o.shieldExpiresRound, 0, 65535);
  const sixSevenCount = asInt(o.sixSevenCount, 0, 255);
  const lastActionValue = asInt(o.lastActionValue, 0, 255);
  if (
    lostTurns === null || extraTurns === null || shieldExpiresRound === null ||
    sixSevenCount === null || lastActionValue === null
  ) return null;
  const lastActionType = asString(o.lastActionType);
  if (lastActionType !== "" && lastActionType !== "dice" && lastActionType !== "card") return null;
  return {
    seat: index,
    name: asString(o.name) || `Player ${index + 1}`,
    gone: asBool(o.gone),
    position,
    portalId,
    portalProgress,
    portalForward: o.portalForward !== false,
    justExitedPortal,
    lostTurns,
    extraTurns,
    shieldExpiresRound,
    spaceSuit: asBool(o.spaceSuit),
    sixSevenCount,
    lastActionType: lastActionType as EngineSeat["lastActionType"],
    lastActionValue,
  };
}

const AWAIT_TYPES: ReadonlySet<string> = new Set<string>([
  "", ScAwait.ACTION, ScAwait.TARGET, ScAwait.MULTI_TARGET, ScAwait.CHOICE, ScAwait.SPACE, ScAwait.SATELLITE,
]);

/**
 * Is the restored `awaiting` block one the engine could actually have produced?
 * The per-field parse only range-checks the numbers; this proves the
 * inputType / context / count / peek / cardId combination is internally
 * consistent (a state machine reachable from a real draw), so a hand-forged
 * blob describing an impossible prompt is rejected before the room loads it.
 * Only meaningful for a running (not-over) game.
 */
function sameMultiset(a: number[], b: number[]): boolean {
  if (a.length !== b.length) return false;
  const counts = new Map<number, number>();
  for (const x of a) counts.set(x, (counts.get(x) ?? 0) + 1);
  for (const x of b) {
    const c = counts.get(x);
    if (!c) return false;
    counts.set(x, c - 1);
  }
  return true;
}

function awaitingIsReachable(engine: GameState): boolean {
  const aw = engine.awaiting;
  const live = engine.players.filter((p) => !p.gone).length;
  switch (aw.inputType) {
    case ScAwait.ACTION:
      // The idle turn: no card has been drawn, so no prompt baggage.
      return aw.context === "" && aw.cardId === 0 && aw.count === 0 && aw.peek.length === 0 && aw.targetSeat === -1;
    case ScAwait.TARGET:
      return (
        aw.cardId > 0 &&
        (aw.context === ScPrompt.ATTACK_TARGET ||
          aw.context === ScPrompt.BLACKHOLE_TARGET ||
          aw.context === ScPrompt.KRAKEN_ONE ||
          aw.context === ScPrompt.STAR_TARGET ||
          aw.context === ScPrompt.SIXSEVEN_TARGET) &&
        aw.peek.length === 0
      );
    case ScAwait.MULTI_TARGET:
      // Only Kraken "three"; count is clamped to min(3, live) when opened, so a
      // count of 0 or one that exceeds the live seats is forged.
      return (
        aw.context === ScPrompt.KRAKEN_THREE &&
        aw.cardId > 0 &&
        aw.count >= 1 &&
        aw.count === Math.min(3, live) &&
        aw.peek.length === 0
      );
    case ScAwait.CHOICE:
      return (
        aw.cardId > 0 &&
        (aw.context === ScPrompt.KRAKEN_CHOICE ||
          aw.context === ScPrompt.STAR_CHOICE ||
          aw.context === ScPrompt.SIXSEVEN_SPACE) &&
        // sixseven-space carries the step-1 victim; the others have none.
        (aw.context === ScPrompt.SIXSEVEN_SPACE ? aw.targetSeat >= 0 : aw.targetSeat === -1) &&
        aw.peek.length === 0
      );
    case ScAwait.SPACE:
      // Black Hole step 2: a victim was chosen in step 1.
      return aw.context === ScPrompt.BLACKHOLE_SPACE && aw.cardId > 0 && aw.targetSeat >= 0 && aw.peek.length === 0;
    case ScAwait.SATELLITE: {
      // The peek is a non-empty hand of up to SC_SATELLITE_PEEK cards drawn from
      // the top of the deck (next-draw first), and count mirrors its length. It
      // must be a multiset of the ACTUAL top cards, else the reorder it answers
      // would smuggle new card ids into the deck and break conservation.
      const n = aw.peek.length;
      if (aw.context !== ScPrompt.SATELLITE || n < 1 || n > SC_SATELLITE_PEEK || aw.count !== n) return false;
      if (n > engine.deck.length) return false;
      const top: number[] = [];
      for (let k = 0; k < n; k++) top.push(engine.deck[engine.deck.length - 1 - k]!);
      return sameMultiset(top, aw.peek);
    }
    default:
      return false;
  }
}

function parseEngine(raw: unknown): GameState | null {
  const o = asObject(raw);
  if (!o) return null;
  if (asString(o.engineVersion) !== ENGINE_VERSION) return null; // incompatible save

  if (!Array.isArray(o.players) || o.players.length < 2 || o.players.length > 5) return null;
  const players: EngineSeat[] = [];
  for (let i = 0; i < o.players.length; i++) {
    const seat = parseSeat(o.players[i], i);
    if (!seat) return null;
    players.push(seat);
  }

  if (!Array.isArray(o.deck) || !Array.isArray(o.discard)) return null;
  const deck: number[] = [];
  const discard: number[] = [];
  for (const id of o.deck) {
    const cid = asCardId(id);
    if (cid === null) return null;
    deck.push(cid);
  }
  for (const id of o.discard) {
    const cid = asCardId(id);
    if (cid === null) return null;
    discard.push(cid);
  }

  const awo = asObject(o.awaiting);
  if (!awo) return null;
  const awSeat = asInt(awo.seat, 0, players.length - 1);
  if (awSeat === null) return null;
  const inputType = asString(awo.inputType);
  if (!AWAIT_TYPES.has(inputType)) return null;
  const mult = asInt(awo.mult, 1, 2);
  const count = asInt(awo.count, 0, 5);
  const targetSeat = asInt(awo.targetSeat, -1, players.length - 1);
  if (mult === null || count === null || targetSeat === null) return null;
  const peek: number[] = [];
  if (Array.isArray(awo.peek)) {
    for (const id of awo.peek) {
      const cid = asCardId(id);
      if (cid === null) return null;
      peek.push(cid);
    }
  }

  const seed = asInt(o.seed, 0, 0xffffffff);
  const rngState = asInt(o.rngState, 0, 0xffffffff);
  const roundNumber = asInt(o.roundNumber, 0, 65535);
  const turnCount = asInt(o.turnCount, 0, 0xffffffff);
  if (seed === null || rngState === null || roundNumber === null || turnCount === null) return null;
  const winner = o.winner === null ? null : asInt(o.winner, 0, players.length - 1);
  if (o.winner !== null && winner === null) return null;

  const forcedRolls: number[] = [];
  if (Array.isArray(o.forcedRolls)) {
    for (const r of o.forcedRolls) {
      const die = asInt(r, 1, 6);
      if (die === null) return null;
      forcedRolls.push(die);
    }
  }

  const engine: GameState = {
    engineVersion: ENGINE_VERSION,
    seed,
    rngState,
    forcedRolls,
    players,
    deck,
    discard,
    roundNumber,
    turnCount,
    awaiting: {
      seat: awSeat,
      inputType: inputType as GameState["awaiting"]["inputType"],
      context: asString(awo.context),
      cardId: asInt(awo.cardId, 0, 41) ?? 0,
      mult,
      count,
      targetSeat,
      peek,
    },
    over: asBool(o.over),
    winner,
  };

  // The engine's own invariants are the final gate (deck multiset, positions,
  // portal consistency, over/winner consistency, AND the soft-lock detector -
  // a tampered blob whose awaited seat is gone or can't act dies here). A blob
  // that slips past the field checks but is internally inconsistent dies here.
  try {
    assertInvariants(engine);
  } catch {
    return null;
  }

  // Awaiting-reachability cross-check: an inconsistent awaiting block can pass
  // the per-field range checks yet describe a prompt no player could ever be
  // in (e.g. a SATELLITE await with an empty peek, a MULTI_TARGET await whose
  // count exceeds the live seats, a TARGET await for a card that does not open
  // a target prompt). assertInvariants only fires for a NOT-over game; do the
  // structural reachability check for every running blob, then prove a legal
  // action exists by both the cheap predicate AND a no-throw auto-resolve.
  if (!engine.over) {
    if (!awaitingIsReachable(engine)) return null;
    if (!legalActionExists(engine)) return null;
    if (engine.awaiting.inputType === ScAwait.ACTION) {
      // A running ACTION turn must accept the basic moves.
      if (!isLegalMove(engine, { kind: "ROLL" }) || !isLegalMove(engine, { kind: "DRAW" })) return null;
    }
    // The deterministic auto-resolver must not throw on the restored prompt -
    // the room loops it for timed-out seats, so a blob it chokes on is poison.
    try {
      autoResolve(engine, engine.awaiting.seat);
    } catch {
      return null;
    }
  }

  return engine;
}

export function parseSave(raw: unknown): ParsedSave | null {
  const o = asObject(raw);
  if (!o) return null;
  if (o.game !== "spacechase" || o.v !== SAVE_VERSION) return null;
  if (!isValidSpaceChaseTurnSeconds(o.turnSeconds)) return null;
  if (!Array.isArray(o.seats) || o.seats.length < 2 || o.seats.length > 5) return null;

  const engine = parseEngine(o.engine);
  if (!engine) return null;
  if (engine.players.length !== o.seats.length) return null;

  const seats: SaveSeat[] = [];
  for (const rawSeat of o.seats) {
    const so = asObject(rawSeat);
    if (!so) return null;
    const nickname = asString(so.nickname);
    if (nickname.length < 1) return null;
    seats.push({ nickname, isBot: false, gone: asBool(so.gone) });
  }
  // The lineup's gone flags must agree with the engine's.
  if (seats.some((s, i) => s.gone !== engine.players[i]!.gone)) return null;

  return { engine, seats, turnSeconds: o.turnSeconds };
}
