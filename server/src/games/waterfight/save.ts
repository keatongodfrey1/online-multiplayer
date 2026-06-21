/**
 * Save-game snapshots. The blob lives in the host's BROWSER (localStorage), so
 * nothing here is trusted on the way back in: every field is type-checked and
 * rebuilt into a fresh GameState, and the result must pass the engine's own
 * assertInvariants (and produce legal moves without throwing) before it is used.
 * A save knowingly contains hidden info (deck order, hands) — the host could read
 * it; that is the family-game trade-off for a stateless server (no worse than
 * hosting the physical box).
 */
import { WaterFightEngine as WF } from "@backbone/shared";

const { ENGINE_VERSION, assertInvariants, legalMoves, mainDeckSize } = WF;
type GameState = WF.GameState;

export interface SaveSeat {
  nickname: string;
  isBot: boolean;
  /** Seat had left for good when saved; stays ghost-played on resume. */
  gone: boolean;
}

export interface ParsedSave {
  engine: GameState;
  seats: SaveSeat[];
  /** The lobby dials in force, restored to the room state on stage. */
  options: {
    startingLives: number;
    splashHit: number;
    splashMiss: number;
    mainHit: number;
    mainMiss: number;
    handLimit: number;
    shopCost: number;
    eventDensity: number;
    stormDraw: number;
    stormThrows: number;
    maxReactions: number;
    turnSeconds: number;
    reactionSeconds: number;
  };
}

// ---- primitive validators ----
const isObj = (x: unknown): x is Record<string, unknown> => typeof x === "object" && x !== null;
const isInt = (x: unknown): x is number => typeof x === "number" && Number.isInteger(x);
const isNum = (x: unknown): x is number => typeof x === "number" && Number.isFinite(x);
const isStr = (x: unknown): x is string => typeof x === "string";
const isBool = (x: unknown): x is boolean => typeof x === "boolean";
const intIn = (x: unknown, lo: number, hi: number): x is number => isInt(x) && x >= lo && x <= hi;

const ATTACK_KINDS = new Set(["basic", "mega", "giant", "golden"]);
const AWAIT_KINDS = new Set(["MOVE", "REACT", "DEFEND", "ATTACKER_RESPOND", "DISCARD", "EXTRA_THROW", "GAME_OVER"]);
const PENDING_KINDS = new Set(["THROW", "PLAY_BIG", "SUPPORT"]);
const BIG_KINDS = new Set(["mega", "giant", "golden"]);
const SPREAD_MODS = new Set(["triplesplash", "splashzone"]);
const SUPPORT_KINDS_SET = new Set<string>(WF.SUPPORT_KINDS);
/** Every legal CardKind, derived from engine data so it can't drift. */
const CARD_KINDS = new Set<string>([
  ...Object.keys(WF.MAIN_DECK_COMPOSITION),
  ...Object.keys(WF.STACK_COMPOSITIONS.defense),
  ...Object.keys(WF.STACK_COMPOSITIONS.mischief),
  ...Object.keys(WF.STACK_COMPOSITIONS.attack),
  "event",
]);

class RejectSave extends Error {}
function need(cond: unknown, why = "bad save"): asserts cond {
  if (!cond) throw new RejectSave(why);
}

function rebuildCard(c: unknown): { id: number; kind: string; event?: string } {
  // Whitelist the kind (closes a stored-XSS source in the view + junk-card states).
  need(isObj(c) && isInt(c.id) && c.id >= 0 && isStr(c.kind) && CARD_KINDS.has(c.kind), "card");
  const card: { id: number; kind: string; event?: string } = { id: c.id as number, kind: c.kind as string };
  if (c.kind === "event") {
    need(isStr(c.event) && c.event.length > 0, "event card needs an event name");
    card.event = c.event as string;
  }
  return card;
}
function rebuildCards(a: unknown): { id: number; kind: string; event?: string }[] {
  need(Array.isArray(a), "card array");
  return (a as unknown[]).map(rebuildCard);
}
function rebuildSplash(a: unknown): ("hit" | "miss")[] {
  need(Array.isArray(a), "splash array");
  return (a as unknown[]).map((v) => {
    need(v === "hit" || v === "miss", "splash card");
    return v as "hit" | "miss";
  });
}
function intArray(a: unknown): number[] {
  need(Array.isArray(a), "int array");
  return (a as unknown[]).map((v) => {
    need(intIn(v, 0, 7), "seat index");
    return v as number;
  });
}

function rebuildEngine(e: unknown): GameState {
  need(isObj(e), "engine");
  need(e.engineVersion === ENGINE_VERSION, "engine version mismatch");
  need(isInt(e.seed) && isInt(e.rngState), "rng");

  const o = e.options;
  need(isObj(o), "options");
  const options = {
    startingLives: clampInt(o.startingLives, 1, 50),
    splashHit: clampInt(o.splashHit, 0, 200),
    splashMiss: clampInt(o.splashMiss, 0, 200),
    mainHit: clampInt(o.mainHit, 0, 200),
    mainMiss: clampInt(o.mainMiss, 0, 200),
    handLimit: clampInt(o.handLimit, 1, 100),
    shopCost: clampInt(o.shopCost, 0, 100),
    eventDensity: clampInt(o.eventDensity, 0, 19),
    stormDraw: clampInt(o.stormDraw, 0, 20),
    stormThrows: clampInt(o.stormThrows, 0, 20),
    maxReactions: clampInt(o.maxReactions, 0, 100_000),
    turnCap: clampInt(o.turnCap, 1, 1_000_000),
  };
  need(options.splashHit + options.splashMiss >= 1, "empty splash pile");

  need(Array.isArray(e.players) && e.players.length >= 2 && e.players.length <= 5, "players");
  const players = (e.players as unknown[]).map((p, i) => {
    need(isObj(p), "player");
    need(isInt(p.seat) && p.seat === i, "player seat");
    need(intIn(p.lives, 0, options.startingLives), "player lives");
    need(isBool(p.out) && isBool(p.stormCloud), "player flags");
    need(p.out === (p.lives <= 0), "out/lives mismatch");
    const st = p.statuses;
    need(isObj(st) && isBool(st.freezeOut) && isBool(st.noShop), "statuses");
    return {
      seat: i,
      name: isStr(p.name) ? p.name : `Player ${i + 1}`,
      lives: p.lives as number,
      hand: rebuildCards(p.hand),
      out: p.out as boolean,
      stormCloud: p.stormCloud as boolean,
      statuses: { freezeOut: st.freezeOut as boolean, noShop: st.noShop as boolean },
    };
  });

  const stacks = e.stacks;
  need(isObj(stacks), "stacks");
  const rebuiltStacks = {
    defense: rebuildCards(stacks.defense),
    mischief: rebuildCards(stacks.mischief),
    attack: rebuildCards(stacks.attack),
  };

  need(intIn(e.turnSeat, 0, players.length - 1), "turnSeat");
  need(isBool(e.supportUsed), "supportUsed");
  need(e.phase === "playing" || e.phase === "sudden-death", "phase");

  const awaiting = rebuildAwaiting(e.awaiting, players.length);
  const pending = rebuildPending(e.pending, players.length);

  need(isInt(e.turnCount) && e.turnCount >= 0, "turnCount");
  need(isBool(e.over), "over");
  need(e.winner === null || intIn(e.winner, 0, players.length - 1), "winner");
  need(e.endReason === null || isStr(e.endReason), "endReason");
  need(Array.isArray(e.log), "log");

  // --- awaiting/turn consistency (assertInvariants does NOT cross-check these,
  //     so a structurally-valid blob could still throw or soft-lock on resume) ---
  const alive = (seat: number | undefined): boolean =>
    seat !== undefined && seat >= 0 && seat < players.length && !players[seat]!.out;
  const head = awaiting.seats[0];
  if (!(e.over as boolean)) {
    need(awaiting.kind !== "GAME_OVER" && awaiting.seats.length >= 1, "a live game must await a seat");
  }
  if (awaiting.kind === "MOVE") {
    need(head === (e.turnSeat as number), "a MOVE await must head the turn seat");
  }
  // DEFEND/ATTACKER_RESPOND always have an attack; REACT may (mid-attack per-target
  // reaction) or may not (pre-flip pending); other kinds never do.
  if (awaiting.kind === "DEFEND" || awaiting.kind === "ATTACKER_RESPOND") {
    need(awaiting.attack, "a ladder await needs an attack");
  } else if (awaiting.kind !== "REACT") {
    need(!awaiting.attack, "an attack is present without a ladder await");
  }
  if (awaiting.attack) {
    need(alive(awaiting.attack.attackerSeat), "the attacker is soaked");
    need(alive(awaiting.attack.targets[awaiting.attack.targetIdx]), "the ladder/reaction target is soaked");
  }
  if (awaiting.kind === "REACT") {
    need(pending || awaiting.attack, "a REACT await needs a pending action or an attack");
  } else {
    need(!pending, "a pending action is present without a REACT await");
  }
  if (awaiting.kind === "DISCARD") {
    need(head !== undefined && players[head]!.hand.length > options.handLimit, "a DISCARD await with nothing to discard");
  }

  const state = {
    engineVersion: ENGINE_VERSION,
    seed: e.seed as number,
    rngState: e.rngState as number,
    options,
    mainIdMax: mainDeckSize(options.mainHit, options.mainMiss), // recomputed, not trusted
    players,
    mainDeck: rebuildCards(e.mainDeck),
    mainDiscard: rebuildCards(e.mainDiscard),
    usedPile: rebuildCards(e.usedPile),
    stacks: rebuiltStacks,
    splashPile: rebuildSplash(e.splashPile),
    splashDiscard: rebuildSplash(e.splashDiscard),
    turnSeat: e.turnSeat as number,
    supportUsed: e.supportUsed as boolean,
    stormThrowsUsed: clampInt(e.stormThrowsUsed ?? 0, 0, options.stormThrows),
    pending,
    phase: e.phase as "playing" | "sudden-death",
    awaiting,
    turnCount: e.turnCount as number,
    over: e.over as boolean,
    winner: (e.winner ?? null) as number | null,
    endReason: (e.endReason ?? null) as GameState["endReason"],
    log: (e.log as unknown[]).filter(isStr).slice(-200) as string[],
    reveals: [], // peeks are ephemeral; never resumed from a save
  } as unknown as GameState;
  return state;
}

function rebuildAwaiting(a: unknown, n: number): GameState["awaiting"] {
  need(isObj(a) && isStr(a.kind) && AWAIT_KINDS.has(a.kind), "awaiting kind");
  const seats = intArray(a.seats).filter((s) => s < n);
  const out: GameState["awaiting"] = { seats, kind: a.kind as GameState["awaiting"]["kind"] };
  if (a.attack != null) out.attack = rebuildAttack(a.attack, n);
  return out;
}

function rebuildAttack(a: unknown, n: number): NonNullable<GameState["awaiting"]["attack"]> {
  need(isObj(a), "attack");
  need(intIn(a.attackerSeat, 0, n - 1), "attacker");
  const targets = intArray(a.targets).filter((s) => s < n);
  need(targets.length > 0, "attack targets");
  need(intIn(a.targetIdx, 0, targets.length - 1), "targetIdx");
  need(isStr(a.kind) && ATTACK_KINDS.has(a.kind), "attack kind");
  need(isInt(a.blockNumber) && isInt(a.damage) && isInt(a.missBlocks) && isInt(a.rounds), "attack nums");
  need(isBool(a.soaker) && isBool(a.umbrellaBlock), "attack flags");
  return {
    attackerSeat: a.attackerSeat as number,
    targets,
    targetIdx: a.targetIdx as number,
    kind: a.kind as NonNullable<GameState["awaiting"]["attack"]>["kind"],
    blockNumber: a.blockNumber as number,
    damage: a.damage as number,
    soaker: a.soaker as boolean,
    perTargetReactions: a.perTargetReactions === true,
    redirectedSeats: Array.isArray(a.redirectedSeats) ? (a.redirectedSeats as unknown[]).filter((v) => intIn(v, 0, n - 1)) : [],
    missBlocks: Math.max(0, a.missBlocks as number),
    umbrellaBlock: a.umbrellaBlock as boolean,
    rounds: Math.max(0, a.rounds as number),
  };
}

function rebuildPending(p: unknown, n: number): GameState["pending"] {
  if (p == null) return null;
  need(isObj(p) && isStr(p.kind) && PENDING_KINDS.has(p.kind), "pending kind");
  need(intIn(p.attacker, 0, n - 1) && intIn(p.target, 0, n - 1), "pending seats");
  const out = {
    kind: p.kind as "THROW" | "PLAY_BIG" | "SUPPORT",
    attacker: p.attacker as number,
    target: p.target as number,
    redirectedSeats: intArray(p.redirectedSeats).filter((s) => s < n),
  } as NonNullable<GameState["pending"]>;
  // Whitelist enum-ish fields so a tampered pending can't feed the engine a
  // value its switch statements don't handle (which would throw on resume).
  if (p.kind === "PLAY_BIG") {
    need(isStr(p.big) && BIG_KINDS.has(p.big), "pending big kind");
    (out as { big?: string }).big = p.big as string;
  }
  if (p.kind === "SUPPORT") {
    need(isStr(p.support) && SUPPORT_KINDS_SET.has(p.support), "pending support kind");
    (out as { support?: string }).support = p.support as string;
  }
  if (p.soaker === true) (out as { soaker?: boolean }).soaker = true;
  if (isObj(p.spread)) {
    need(isStr(p.spread.modifier) && SPREAD_MODS.has(p.spread.modifier), "pending spread modifier");
    (out as { spread?: unknown }).spread = {
      modifier: p.spread.modifier,
      extraTargets: Array.isArray(p.spread.extraTargets) ? (p.spread.extraTargets as unknown[]).filter((v) => intIn(v, 0, n - 1)) : [],
    };
  }
  return out;
}

function clampInt(x: unknown, lo: number, hi: number): number {
  need(isNum(x), "number");
  return Math.min(hi, Math.max(lo, Math.round(x as number)));
}

// ---- public API ----

export function serializeSave(input: { engine: GameState; seats: SaveSeat[]; options: ParsedSave["options"] }): object {
  return { v: 1, engine: input.engine, seats: input.seats, options: input.options };
}

export function parseSave(raw: unknown): ParsedSave | null {
  try {
    need(isObj(raw) && raw.v === 1, "version");
    need(Array.isArray(raw.seats), "seats");
    const seats: SaveSeat[] = (raw.seats as unknown[]).map((s) => {
      need(isObj(s) && isStr(s.nickname) && isBool(s.isBot) && isBool(s.gone), "seat");
      return { nickname: s.nickname as string, isBot: s.isBot as boolean, gone: s.gone as boolean };
    });
    const o = isObj(raw.options) ? raw.options : {};
    const options = {
      startingLives: clampInt(o.startingLives ?? 3, 1, 5),
      splashHit: clampInt(o.splashHit ?? 13, 1, 30),
      splashMiss: clampInt(o.splashMiss ?? 7, 0, 30),
      mainHit: clampInt(o.mainHit ?? 20, 0, 50),
      mainMiss: clampInt(o.mainMiss ?? 20, 0, 50),
      handLimit: clampInt(o.handLimit ?? 8, 3, 20),
      shopCost: clampInt(o.shopCost ?? 4, 1, 10),
      eventDensity: clampInt(o.eventDensity ?? 8, 0, 19),
      stormDraw: clampInt(o.stormDraw ?? 1, 0, 5),
      stormThrows: clampInt(o.stormThrows ?? 1, 0, 5),
      maxReactions: clampInt(o.maxReactions ?? 0, 0, 50),
      turnSeconds: clampInt(o.turnSeconds ?? 0, 0, 300),
      reactionSeconds: clampInt(o.reactionSeconds ?? 12, 0, 60),
    };
    const engine = rebuildEngine(raw.engine);
    assertInvariants(engine); // the canonical structural gate
    legalMoves(engine); // smoke: must not throw
    return { engine, seats, options };
  } catch {
    return null; // corrupt or tampered: reject silently
  }
}
