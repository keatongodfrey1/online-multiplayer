/**
 * Save-game snapshots. The blob lives in the host's BROWSER (localStorage
 * save slots), so nothing here is trusted on the way back in:
 *
 *  - cards and nobles are stored as ids only and rebuilt from the engine's
 *    canonical GAME_DATA (a tampered cost can't come along);
 *  - bonuses are recomputed from built cards;
 *  - every id must appear exactly once across decks/market/hands (all 90
 *    cards, players+1 nobles), counts are range-checked, and the restored
 *    state must pass the engine's own assertInvariants before it is used.
 *
 * A save knowingly contains hidden information (deck order, reserved
 * cards) - the host could read it. That is the family-game trade-off for
 * keeping the server stateless; it is no worse than hosting the box.
 */
import { SplendorEngine, isValidSplendorTurnSeconds } from "@backbone/shared";

const { COLORS, ENGINE_VERSION, GAME_DATA, assertInvariants, totalTokens } = SplendorEngine;
type Card = SplendorEngine.Card;
type Noble = SplendorEngine.Noble;
type ColorMap = SplendorEngine.ColorMap;
type GameState = SplendorEngine.GameState;
type Tier = SplendorEngine.Tier;
type InputType = SplendorEngine.InputType;

const CARD_BY_ID = new Map<number, Card>(GAME_DATA.cards.map((c) => [c.id, c]));
const NOBLE_BY_ID = new Map<number, Noble>(GAME_DATA.nobles.map((n) => [n.id, n]));
const TIERS: Tier[] = [1, 2, 3];

export interface SaveSeat {
  nickname: string;
  isBot: boolean;
  /** Seat had left for good when the game was saved; stays ghost-played. */
  gone: boolean;
  difficulty?: "easy" | "hard";
}

export interface ParsedSave {
  engine: GameState;
  seats: SaveSeat[];
  turnSeconds: number;
}

interface SaveInput {
  engine: GameState;
  seats: SaveSeat[];
  turnSeconds: number;
}

/** Engine + lineup -> plain JSON blob (ids only) for the client to store. */
export function serializeSave({ engine, seats, turnSeconds }: SaveInput): object {
  const ids = (cards: Card[]) => cards.map((c) => c.id);
  return {
    v: 1,
    game: "splendor",
    savedAt: Date.now(),
    turnSeconds,
    seats: seats.map((s) => ({
      nickname: s.nickname,
      isBot: s.isBot,
      gone: s.gone,
      ...(s.difficulty ? { difficulty: s.difficulty } : {}),
    })),
    engine: {
      options: { ...engine.options },
      supplyGems: { ...engine.supplyGems },
      supplyGold: engine.supplyGold,
      decks: { 1: ids(engine.decks[1]), 2: ids(engine.decks[2]), 3: ids(engine.decks[3]) },
      market: {
        1: engine.market[1].map((c) => c?.id ?? 0),
        2: engine.market[2].map((c) => c?.id ?? 0),
        3: engine.market[3].map((c) => c?.id ?? 0),
      },
      nobles: engine.nobles.map((n) => n.id),
      players: engine.players.map((p) => ({
        gems: { ...p.gems },
        gold: p.gold,
        reserved: ids(p.reserved),
        built: ids(p.built),
        nobles: p.nobles.map((n) => n.id),
      })),
      startSeat: engine.startSeat,
      awaiting: { ...engine.awaiting },
      endFlag: engine.endFlag,
      forcedPassStreak: engine.forcedPassStreak,
      turnCount: engine.turnCount,
    },
  };
}

function isInt(v: unknown, min: number, max: number): v is number {
  return typeof v === "number" && Number.isInteger(v) && v >= min && v <= max;
}

function parseColorMap(raw: unknown, maxEach: number): ColorMap | null {
  const m = raw as Record<string, unknown> | null;
  if (typeof m !== "object" || m === null) return null;
  const out = { white: 0, blue: 0, green: 0, red: 0, black: 0 };
  for (const c of COLORS) {
    const v = m[c];
    if (!isInt(v, 0, maxEach)) return null;
    out[c] = v;
  }
  return out;
}

/** Take card ids, ensuring each is real and never seen before. */
function takeCards(raw: unknown, claimed: Set<number>, maxLen: number): Card[] | null {
  if (!Array.isArray(raw) || raw.length > maxLen) return null;
  const out: Card[] = [];
  for (const id of raw) {
    const card = isInt(id, 1, 90) ? CARD_BY_ID.get(id) : undefined;
    if (!card || claimed.has(card.id)) return null;
    claimed.add(card.id);
    out.push(card);
  }
  return out;
}

function takeNobles(raw: unknown, claimed: Set<number>, maxLen: number): Noble[] | null {
  if (!Array.isArray(raw) || raw.length > maxLen) return null;
  const out: Noble[] = [];
  for (const id of raw) {
    const noble = isInt(id, 1, 10) ? NOBLE_BY_ID.get(id) : undefined;
    if (!noble || claimed.has(noble.id)) return null;
    claimed.add(noble.id);
    out.push(noble);
  }
  return out;
}

/**
 * Validate an untrusted save blob and rebuild a live GameState from it.
 * Returns null on ANY violation - the caller just ignores the message.
 */
export function parseSave(raw: unknown): ParsedSave | null {
  if (typeof raw !== "object" || raw === null) return null;
  const top = raw as Record<string, unknown>;
  if (top.v !== 1 || top.game !== "splendor") return null;
  if (!isValidSplendorTurnSeconds(top.turnSeconds)) return null;

  // ---- seats ---------------------------------------------------------------
  if (!Array.isArray(top.seats) || top.seats.length < 2 || top.seats.length > 4) return null;
  const seats: SaveSeat[] = [];
  const names = new Set<string>();
  for (const s of top.seats as Record<string, unknown>[]) {
    if (typeof s !== "object" || s === null) return null;
    const nickname = typeof s.nickname === "string" ? s.nickname.trim() : "";
    if (nickname.length < 1 || nickname.length > 24) return null;
    if (names.has(nickname.toLowerCase())) return null;
    names.add(nickname.toLowerCase());
    if (typeof s.isBot !== "boolean" || typeof s.gone !== "boolean") return null;
    if (s.difficulty !== undefined && s.difficulty !== "easy" && s.difficulty !== "hard") return null;
    seats.push({ nickname, isBot: s.isBot, gone: s.gone, difficulty: s.difficulty });
  }
  if (!seats.some((s) => !s.isBot && !s.gone)) return null; // somebody must actually play
  const n = seats.length;

  // ---- engine --------------------------------------------------------------
  const e = top.engine as Record<string, unknown> | null;
  if (typeof e !== "object" || e === null) return null;

  const o = e.options as Record<string, unknown> | null;
  if (typeof o !== "object" || o === null) return null;
  if (o.endGameMode !== "finishRound" && o.endGameMode !== "immediate") return null;
  if (typeof o.allowTakeFewerThanThree !== "boolean") return null;
  if (!isInt(o.turnCap, 1, 100000)) return null;

  const supplyGems = parseColorMap(e.supplyGems, 7);
  if (!supplyGems || !isInt(e.supplyGold, 0, 5)) return null;

  const claimedCards = new Set<number>();
  const decksRaw = e.decks as Record<string, unknown> | null;
  const marketRaw = e.market as Record<string, unknown> | null;
  if (typeof decksRaw !== "object" || decksRaw === null) return null;
  if (typeof marketRaw !== "object" || marketRaw === null) return null;
  const decks = {} as Record<Tier, Card[]>;
  const market = {} as Record<Tier, (Card | null)[]>;
  for (const t of TIERS) {
    const deck = takeCards(decksRaw[t], claimedCards, 40);
    if (!deck || deck.some((c) => c.tier !== t)) return null;
    decks[t] = deck;
    const row = marketRaw[t];
    if (!Array.isArray(row) || row.length !== 4) return null;
    market[t] = [];
    for (const slot of row) {
      if (slot === 0) {
        market[t].push(null);
        continue;
      }
      const cards = takeCards([slot], claimedCards, 1);
      if (!cards || cards[0]!.tier !== t) return null;
      market[t].push(cards[0]!);
    }
  }

  const claimedNobles = new Set<number>();
  const boardNobles = takeNobles(e.nobles, claimedNobles, n + 1);
  if (!boardNobles) return null;

  if (!Array.isArray(e.players) || e.players.length !== n) return null;
  const players: SplendorEngine.PlayerState[] = [];
  for (let i = 0; i < n; i++) {
    const p = (e.players as Record<string, unknown>[])[i];
    if (typeof p !== "object" || p === null) return null;
    const gems = parseColorMap(p.gems, 7);
    if (!gems || !isInt(p.gold, 0, 5)) return null;
    const reserved = takeCards(p.reserved, claimedCards, 3);
    const built = takeCards(p.built, claimedCards, 90);
    const nobles = takeNobles(p.nobles, claimedNobles, n + 1);
    if (!reserved || !built || !nobles) return null;
    const bonuses = { white: 0, blue: 0, green: 0, red: 0, black: 0 };
    for (const c of built) bonuses[c.bonus] += 1; // never trust stored bonuses
    players.push({
      seat: i,
      name: seats[i]!.nickname,
      kind: seats[i]!.isBot ? "ai" : "human",
      connected: true,
      gems,
      gold: p.gold,
      bonuses,
      reserved,
      built,
      nobles,
    });
  }
  if (claimedCards.size !== 90) return null; // every card accounted for, once
  if (claimedNobles.size !== n + 1) return null;

  if (!isInt(e.startSeat, 0, n - 1)) return null;
  if (typeof e.endFlag !== "boolean") return null;
  if (!isInt(e.forcedPassStreak, 0, n)) return null;
  if (!isInt(e.turnCount, 0, o.turnCap as number)) return null;

  const aw = e.awaiting as Record<string, unknown> | null;
  if (typeof aw !== "object" || aw === null) return null;
  if (!isInt(aw.seat, 0, n - 1)) return null;
  const inputType = aw.inputType as InputType;
  if (inputType !== "MOVE" && inputType !== "DISCARD" && inputType !== "PICK_NOBLE") return null;
  const awaiting: SplendorEngine.Awaiting = { seat: aw.seat, inputType };
  if (inputType === "PICK_NOBLE") {
    if (!Array.isArray(aw.nobleChoices) || aw.nobleChoices.length < 2) return null;
    const boardIds = new Set(boardNobles.map((b) => b.id));
    for (const id of aw.nobleChoices) if (!isInt(id, 1, 10) || !boardIds.has(id)) return null;
    awaiting.nobleChoices = [...(aw.nobleChoices as number[])];
  } else if (inputType === "DISCARD") {
    // The count is derivable - recompute it and reject a mismatch.
    const excess = totalTokens(players[awaiting.seat]!) - 10;
    if (excess < 1 || aw.discardCount !== excess) return null;
    awaiting.discardCount = excess;
  }

  const engine: GameState = {
    engineVersion: ENGINE_VERSION,
    seed: 0, // unused after setup; resumed games are not replay-reproducible
    options: {
      endGameMode: o.endGameMode,
      allowTakeFewerThanThree: o.allowTakeFewerThanThree,
      turnCap: o.turnCap as number,
    },
    players,
    supplyGems,
    supplyGold: e.supplyGold as number,
    decks,
    market,
    nobles: boardNobles,
    startSeat: e.startSeat as number,
    awaiting,
    endFlag: e.endFlag,
    forcedPassStreak: e.forcedPassStreak as number,
    turnCount: e.turnCount as number,
    over: false,
    endReason: null,
  };

  try {
    assertInvariants(engine); // token conservation, non-negativity, market shape...
  } catch {
    return null;
  }
  return { engine, seats, turnSeconds: top.turnSeconds };
}
