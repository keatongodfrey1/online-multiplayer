// Pure, deterministic Splendor rules engine (SPEC §1–§12).
// All functions are pure: they never mutate their inputs (we structuredClone the
// state at each transition) and perform no I/O or wall-clock/Math.random calls.

import {
  CARDS,
  ENGINE_VERSION,
  GOLD_TOKENS,
  MARKET_SLOTS,
  MAX_RESERVED,
  MAX_TOKENS_HELD,
  NOBLES,
  TAKE_TWO_MIN_PILE,
  TARGET_PRESTIGE,
  TOKENS_PER_GEM_BY_PLAYERS,
} from "./data.js";
import { mulberry32, shuffle } from "./rng.js";
import {
  ApplyResult,
  Awaiting,
  Card,
  Color,
  COLORS,
  ColorMap,
  GameEvent,
  GameOptions,
  GameState,
  Move,
  Noble,
  PlayerState,
  RankEntry,
  RedactedPlayer,
  RedactedState,
  Resolution,
  Tier,
  DEFAULT_OPTIONS,
  buyFromIsMarket,
  reserveFromIsMarket,
} from "./types.js";

const TIERS: Tier[] = [1, 2, 3];

function zeroMap(): ColorMap {
  return { white: 0, blue: 0, green: 0, red: 0, black: 0 };
}
function clone<T>(x: T): T {
  return structuredClone(x);
}

export function playerPoints(p: PlayerState): number {
  let s = 0;
  for (const c of p.built) s += c.points;
  return s + 3 * p.nobles.length;
}
export function cardsBought(p: PlayerState): number {
  return p.built.length;
}
export function totalTokens(p: PlayerState): number {
  let s = p.gold;
  for (const c of COLORS) s += p.gems[c];
  return s;
}
function currentSeat(s: GameState): number {
  return s.awaiting.seat;
}

// ---- setup ------------------------------------------------------------------
export function createGame(
  playerCount: number,
  seed: number,
  options?: Partial<GameOptions>,
): GameState {
  if (![2, 3, 4].includes(playerCount)) throw new Error("playerCount must be 2, 3, or 4");
  const rng = mulberry32(seed);
  const gem = TOKENS_PER_GEM_BY_PLAYERS[playerCount]!;

  const players: PlayerState[] = [];
  for (let i = 0; i < playerCount; i++) {
    players.push({
      seat: i,
      name: `Player ${i + 1}`,
      kind: "human",
      connected: true,
      gems: zeroMap(),
      gold: 0,
      bonuses: zeroMap(),
      reserved: [],
      built: [],
      nobles: [],
    });
  }

  // Pinned shuffle order: tier1, tier2, tier3, then nobles (one rng stream).
  const decks = {} as Record<Tier, Card[]>;
  for (const t of TIERS) {
    decks[t] = shuffle(
      CARDS.filter((c) => c.tier === t),
      rng,
    );
  }
  const market = {} as Record<Tier, (Card | null)[]>;
  for (const t of TIERS) {
    market[t] = [];
    for (let i = 0; i < MARKET_SLOTS; i++) market[t].push(decks[t].pop() ?? null);
  }
  const nobles = shuffle(NOBLES, rng).slice(0, playerCount + 1);

  return {
    engineVersion: ENGINE_VERSION,
    seed,
    options: { ...DEFAULT_OPTIONS, ...(options ?? {}) },
    players,
    supplyGems: { white: gem, blue: gem, green: gem, red: gem, black: gem },
    supplyGold: GOLD_TOKENS,
    decks,
    market,
    nobles,
    startSeat: 0,
    awaiting: { seat: 0, inputType: "MOVE" },
    endFlag: false,
    forcedPassStreak: 0,
    turnCount: 0,
    over: false,
    endReason: null,
  };
}

// ---- pure helpers -----------------------------------------------------------
export function requiredCost(card: Card, p: PlayerState): ColorMap {
  const r = zeroMap();
  for (const c of COLORS) r[c] = Math.max(0, card.cost[c] - p.bonuses[c]);
  return r;
}
export function goldNeeded(card: Card, p: PlayerState): number {
  const r = requiredCost(card, p);
  let g = 0;
  for (const c of COLORS) g += Math.max(0, r[c] - p.gems[c]);
  return g;
}
export function affordable(card: Card, p: PlayerState): boolean {
  return goldNeeded(card, p) <= p.gold;
}

function combinations3(arr: Color[]): Color[][] {
  const out: Color[][] = [];
  for (let i = 0; i < arr.length; i++)
    for (let j = i + 1; j < arr.length; j++)
      for (let k = j + 1; k < arr.length; k++) out.push([arr[i]!, arr[j]!, arr[k]!]);
  return out;
}

export function legalMoves(s: GameState): Move[] {
  if (s.over || s.awaiting.inputType !== "MOVE") return [];
  const p = s.players[currentSeat(s)]!;
  const moves: Move[] = [];
  const avail = COLORS.filter((c) => s.supplyGems[c] > 0);

  // A: take 3 different (or all available if fewer than 3 colors remain)
  if (avail.length >= 3) {
    for (const combo of combinations3([...avail])) moves.push({ kind: "TAKE_THREE", colors: combo });
    if (s.options.allowTakeFewerThanThree) {
      for (let n = 1; n <= 2; n++) {
        // (optional) also allow taking fewer; enumerate distinct subsets of size n
        for (let i = 0; i < avail.length; i++) {
          if (n === 1) moves.push({ kind: "TAKE_THREE", colors: [avail[i]!] });
          else for (let j = i + 1; j < avail.length; j++) moves.push({ kind: "TAKE_THREE", colors: [avail[i]!, avail[j]!] });
        }
      }
    }
  } else if (avail.length > 0) {
    moves.push({ kind: "TAKE_THREE", colors: [...avail] });
  }

  // B: take 2 same (pile >= 4 before taking)
  for (const c of COLORS) if (s.supplyGems[c] >= TAKE_TWO_MIN_PILE) moves.push({ kind: "TAKE_TWO", color: c });

  // C: reserve (market or blind deck top) if holding < 3
  if (p.reserved.length < MAX_RESERVED) {
    for (const t of TIERS) {
      s.market[t].forEach((card, index) => {
        if (card) moves.push({ kind: "RESERVE", from: { market: { tier: t, index } } });
      });
      if (s.decks[t].length > 0) moves.push({ kind: "RESERVE", from: { deck: { tier: t } } });
    }
  }

  // D: buy (market or own reserved) if affordable
  for (const t of TIERS) {
    s.market[t].forEach((card, index) => {
      if (card && affordable(card, p)) moves.push({ kind: "BUY", from: { market: { tier: t, index } } });
    });
  }
  for (const card of p.reserved) if (affordable(card, p)) moves.push({ kind: "BUY", from: { reserve: { cardId: card.id } } });

  return moves;
}

export function isLegalMove(s: GameState, move: Move): boolean {
  try {
    validateMove(s, move);
    return true;
  } catch {
    return false;
  }
}

function validateMove(s: GameState, move: Move): void {
  if (s.over) throw new Error("game over");
  if (s.awaiting.inputType !== "MOVE") throw new Error("not awaiting a move");
  const p = s.players[currentSeat(s)]!;
  switch (move.kind) {
    case "TAKE_THREE": {
      const cols = move.colors;
      if (new Set(cols).size !== cols.length) throw new Error("colors must be distinct");
      for (const c of cols) if (s.supplyGems[c] <= 0) throw new Error("pile empty");
      const avail = COLORS.filter((c) => s.supplyGems[c] > 0).length;
      if (s.options.allowTakeFewerThanThree) {
        if (cols.length < 1 || cols.length > 3) throw new Error("take 1..3");
      } else {
        const expected = Math.min(3, avail);
        if (cols.length !== expected) throw new Error(`must take ${expected} different`);
      }
      return;
    }
    case "TAKE_TWO":
      if (s.supplyGems[move.color] < TAKE_TWO_MIN_PILE) throw new Error("need >=4 to take two");
      return;
    case "RESERVE": {
      if (p.reserved.length >= MAX_RESERVED) throw new Error("3 reserved max");
      if (reserveFromIsMarket(move.from)) {
        const { tier, index } = move.from.market;
        if (!s.market[tier][index]) throw new Error("no card in that market slot");
      } else {
        const { tier } = move.from.deck;
        if (s.decks[tier].length === 0) throw new Error("deck empty");
      }
      return;
    }
    case "BUY": {
      const card = resolveBuyTarget(s, p, move);
      if (!card) throw new Error("buy target not found");
      if (!affordable(card, p)) throw new Error("not affordable");
      return;
    }
  }
}

function resolveBuyTarget(s: GameState, p: PlayerState, move: Extract<Move, { kind: "BUY" }>): Card | null {
  if (buyFromIsMarket(move.from)) {
    const { tier, index } = move.from.market;
    return s.market[tier][index] ?? null;
  }
  const { cardId } = move.from.reserve;
  return p.reserved.find((c) => c.id === cardId) ?? null;
}

// ---- applying a move --------------------------------------------------------
export function applyMove(state: GameState, move: Move): ApplyResult {
  validateMove(state, move);
  const s = clone(state);
  const p = s.players[currentSeat(s)]!;
  const events: GameEvent[] = [{ type: move.kind, seat: p.seat, detail: move }];
  s.forcedPassStreak = 0;

  switch (move.kind) {
    case "TAKE_THREE":
      for (const c of move.colors) {
        s.supplyGems[c] -= 1;
        p.gems[c] += 1;
      }
      break;
    case "TAKE_TWO":
      s.supplyGems[move.color] -= 2;
      p.gems[move.color] += 2;
      break;
    case "RESERVE": {
      let card: Card;
      if (reserveFromIsMarket(move.from)) {
        const { tier, index } = move.from.market;
        card = s.market[tier][index] as Card;
        s.market[tier][index] = s.decks[tier].pop() ?? null;
      } else {
        const { tier } = move.from.deck;
        card = s.decks[tier].pop() as Card;
      }
      p.reserved.push(card);
      if (s.supplyGold > 0) {
        s.supplyGold -= 1;
        p.gold += 1;
      }
      break;
    }
    case "BUY": {
      const card = resolveBuyTarget(s, p, move) as Card;
      // IMPORTANT (SPEC §7): compute goldNeeded from PRE-SPEND tokens.
      const gn = goldNeeded(card, p);
      const req = requiredCost(card, p);
      for (const c of COLORS) {
        const spend = Math.min(req[c], p.gems[c]);
        p.gems[c] -= spend;
        s.supplyGems[c] += spend;
      }
      p.gold -= gn;
      s.supplyGold += gn;
      if (buyFromIsMarket(move.from)) {
        const { tier, index } = move.from.market;
        s.market[tier][index] = s.decks[tier].pop() ?? null;
      } else {
        p.reserved = p.reserved.filter((c) => c.id !== card.id);
      }
      p.built.push(card);
      for (const c of COLORS) p.bonuses[c] = p.built.filter((b) => b.bonus === c).length;
      break;
    }
  }

  runEndOfTurn(s, "NOBLE", events);
  return { state: s, awaiting: s.awaiting, events };
}

/** Forced pass: only legal when the current player has no legal move. */
export function applyPass(state: GameState): ApplyResult {
  if (state.over || state.awaiting.inputType !== "MOVE") throw new Error("cannot pass now");
  if (legalMoves(state).length > 0) throw new Error("pass illegal: legal moves exist");
  const s = clone(state);
  const seat = currentSeat(s);
  const events: GameEvent[] = [{ type: "PASS", seat }];
  s.forcedPassStreak += 1;
  advanceTurn(s);
  return { state: s, awaiting: s.awaiting, events };
}

export function applyResolution(state: GameState, res: Resolution): ApplyResult {
  if (state.over) throw new Error("game over");
  const s = clone(state);
  const p = s.players[currentSeat(s)]!;
  const events: GameEvent[] = [{ type: res.kind, seat: p.seat, detail: res }];

  if (res.kind === "PICK_NOBLE") {
    if (s.awaiting.inputType !== "PICK_NOBLE") throw new Error("not awaiting a noble choice");
    if (!s.awaiting.nobleChoices?.includes(res.nobleId)) throw new Error("noble not among choices");
    awardNoble(s, p, res.nobleId);
    runEndOfTurn(s, "DISCARD", events);
    return { state: s, awaiting: s.awaiting, events };
  }

  // DISCARD
  if (s.awaiting.inputType !== "DISCARD") throw new Error("not awaiting a discard");
  const need = s.awaiting.discardCount ?? 0;
  const gems = res.gems ?? {};
  const goldDrop = res.gold ?? 0;
  let removed = goldDrop;
  for (const c of COLORS) removed += gems[c] ?? 0;
  if (removed !== need) throw new Error(`must discard exactly ${need}`);
  if (goldDrop < 0 || goldDrop > p.gold) throw new Error("invalid gold discard");
  for (const c of COLORS) {
    const d = gems[c] ?? 0;
    if (d < 0 || d > p.gems[c]) throw new Error(`invalid discard of ${c}`);
  }
  for (const c of COLORS) {
    const d = gems[c] ?? 0;
    p.gems[c] -= d;
    s.supplyGems[c] += d;
  }
  p.gold -= goldDrop;
  s.supplyGold += goldDrop;
  runEndOfTurn(s, "WIN", events);
  return { state: s, awaiting: s.awaiting, events };
}

type Step = "NOBLE" | "DISCARD" | "WIN" | "ADVANCE";

function runEndOfTurn(s: GameState, from: Step, events: GameEvent[]): void {
  const p = s.players[currentSeat(s)]!;
  let step: Step = from;

  if (step === "NOBLE") {
    const qualifying = s.nobles.filter((n) => COLORS.every((c) => p.bonuses[c] >= n.requirement[c]));
    if (qualifying.length > 1) {
      s.awaiting = { seat: p.seat, inputType: "PICK_NOBLE", nobleChoices: qualifying.map((n) => n.id) };
      return; // wait for PICK_NOBLE
    }
    if (qualifying.length === 1) {
      awardNoble(s, p, qualifying[0]!.id);
      events.push({ type: "NOBLE_VISIT", seat: p.seat, detail: qualifying[0]!.id });
    }
    step = "DISCARD";
  }

  if (step === "DISCARD") {
    if (totalTokens(p) > MAX_TOKENS_HELD) {
      s.awaiting = { seat: p.seat, inputType: "DISCARD", discardCount: totalTokens(p) - MAX_TOKENS_HELD };
      return; // wait for DISCARD
    }
    step = "WIN";
  }

  if (step === "WIN") {
    if (playerPoints(p) >= TARGET_PRESTIGE) s.endFlag = true;
    step = "ADVANCE";
  }

  advanceTurn(s);
}

function awardNoble(s: GameState, p: PlayerState, nobleId: number): void {
  const idx = s.nobles.findIndex((n) => n.id === nobleId);
  if (idx < 0) throw new Error("noble not available");
  const [n] = s.nobles.splice(idx, 1);
  p.nobles.push(n as Noble);
}

function advanceTurn(s: GameState): void {
  const N = s.players.length;
  const seat = currentSeat(s);
  const lastInRound = (s.startSeat - 1 + N) % N;
  s.turnCount += 1;

  // End conditions (points win first), per SPEC §9.
  if (s.endFlag && (s.options.endGameMode === "immediate" || seat === lastInRound)) {
    return endGame(s, "points");
  }
  if (s.forcedPassStreak >= N) return endGame(s, "stalemate");
  if (s.turnCount > s.options.turnCap) return endGame(s, "cap");

  s.awaiting = { seat: (seat + 1) % N, inputType: "MOVE" };
}

function endGame(s: GameState, reason: GameState["endReason"]): void {
  s.over = true;
  s.endReason = reason;
}

export function isGameOver(s: GameState): boolean {
  return s.over;
}

export function ranking(s: GameState): RankEntry[] {
  const rows = s.players
    .map((p) => ({ seat: p.seat, points: playerPoints(p), cardsBought: cardsBought(p), rank: 0 }))
    .sort((a, b) => b.points - a.points || a.cardsBought - b.cardsBought);
  let rank = 0;
  let prev: { points: number; cardsBought: number } | null = null;
  rows.forEach((r, i) => {
    if (!prev || r.points !== prev.points || r.cardsBought !== prev.cardsBought) rank = i + 1;
    r.rank = rank;
    prev = r;
  });
  return rows;
}

// ---- redaction (per-recipient view) ----------------------------------------
export function redact(s: GameState, viewer: number | "spectator"): RedactedState {
  const deckCounts = {} as Record<Tier, number>;
  for (const t of TIERS) deckCounts[t] = s.decks[t].length;

  const players: RedactedPlayer[] = s.players.map((p) => {
    const rp: RedactedPlayer = {
      seat: p.seat,
      name: p.name,
      kind: p.kind,
      connected: p.connected,
      gems: clone(p.gems),
      gold: p.gold,
      bonuses: clone(p.bonuses),
      points: playerPoints(p),
      built: clone(p.built),
      nobles: clone(p.nobles),
      reservedCount: p.reserved.length,
    };
    if (viewer !== "spectator" && p.seat === viewer) rp.reserved = clone(p.reserved);
    return rp;
  });

  return {
    engineVersion: s.engineVersion,
    options: clone(s.options),
    you: viewer,
    supplyGems: clone(s.supplyGems),
    supplyGold: s.supplyGold,
    market: clone(s.market), // market cards are public
    deckCounts,
    nobles: clone(s.nobles),
    players,
    startSeat: s.startSeat,
    awaiting: clone(s.awaiting),
    turnCount: s.turnCount,
    over: s.over,
    endReason: s.endReason,
    // NOTE: decks (order) and seed are intentionally omitted.
  };
}
