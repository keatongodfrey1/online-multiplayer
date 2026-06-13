/**
 * Save-game snapshots. The blob lives in the host's BROWSER (localStorage save
 * slots), so NOTHING here is trusted on the way back in: parseSave validates
 * every field, checks the conservation invariants (the 18-card deck is a
 * permutation across deck+discard; inventories are non-negative ints; each
 * resource card is a valid one-to-one mapping), confirms the seeded rngState is
 * present, and rebuilds a fresh GameState from the validated values — the raw
 * object is never adopted. Returns null on ANY violation and the caller ignores
 * the message.
 *
 * A save knowingly contains hidden information (the deck order + the RNG state)
 * — the host could read it. That's the family-game trade-off for a stateless
 * server; it's no worse than hosting the box. The engine's event log is stripped
 * (saves stay small); the room's turnCount is carried for the slot label.
 */
import { PerfectPalaceEngine } from "@backbone/shared";

const { isValidResourceCard, TOTAL_CARDS } = PerfectPalaceEngine;
type GameState = PerfectPalaceEngine.GameState;
type Player = PerfectPalaceEngine.Player;
type PlayerInventory = PerfectPalaceEngine.PlayerInventory;
type ResourceCard = PerfectPalaceEngine.ResourceCard;
type ResourceOutcome = PerfectPalaceEngine.ResourceOutcome;

/** Phases a saved game may resume into (not 'setup', not 'game-over'). */
const RESUMABLE_PHASES = new Set<string>([
  "initial-roll", "initial-mapping", "mapping-reveal", "turn-start", "rolling",
  "distributing", "moving", "pre-move-bailiff", "square-effect", "duel",
  "post-roll-bailiff", "optional-actions",
]);
const WORKER_PREFS = new Set<string>(["wall-roof", "wall-wall"]);
const FINE_SOURCES = new Set<string>(["invasion", "lose-money"]);
/** Numeric inventory fields (all must be non-negative integers). */
const INV_NUM_FIELDS = [
  "bricks", "sticks", "dollars", "walls", "roofs", "rooms", "buildings",
  "threeStoryBuildings", "palaces", "workers", "servers", "chefs", "cleaners",
  "wholeHouseCleaners", "pardonCards",
] as const;

export interface SaveSeat {
  nickname: string;
  isBot: boolean;
  /** Seat had left for good when the game was saved. */
  gone: boolean;
  /** AI difficulty for a bot seat (restored on resume). */
  difficulty?: "easy" | "normal" | "hard";
}

export interface ParsedSave {
  engine: GameState;
  seats: SaveSeat[];
  turnCount: number;
}

interface SaveInput {
  engine: GameState;
  seats: SaveSeat[];
  turnCount: number;
}

/** Engine + lineup -> plain JSON blob for the client to store. */
export function serializeSave({ engine, seats, turnCount }: SaveInput): object {
  const clone = structuredClone(engine) as GameState;
  clone.log = []; // saves don't carry the event feed
  return {
    v: 1,
    game: "perfectpalace",
    savedAt: Date.now(),
    turnCount,
    seats: seats.map((s) => ({
      nickname: s.nickname,
      isBot: s.isBot,
      gone: s.gone,
      ...(s.difficulty ? { difficulty: s.difficulty } : {}),
    })),
    engine: clone,
  };
}

// ---- small validators --------------------------------------------------------

function isObj(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null;
}
function isInt(v: unknown, min: number, max: number): v is number {
  return typeof v === "number" && Number.isInteger(v) && v >= min && v <= max;
}
function isNonNegInt(v: unknown): v is number {
  return typeof v === "number" && Number.isInteger(v) && v >= 0;
}
function isBool(v: unknown): v is boolean {
  return typeof v === "boolean";
}
function isStr(v: unknown): v is string {
  return typeof v === "string";
}

function parseOutcome(v: unknown): ResourceOutcome | null {
  if (!isObj(v)) return null;
  if (v.kind === "draw-card") return { kind: "draw-card" };
  if ((v.kind === "sticks" || v.kind === "bricks" || v.kind === "dollars") && isNonNegInt(v.amount)) {
    return { kind: v.kind, amount: v.amount };
  }
  return null;
}

function parseInventory(v: unknown): PlayerInventory | null {
  if (!isObj(v)) return null;
  const inv: Record<string, unknown> = {};
  for (const f of INV_NUM_FIELDS) {
    if (!isNonNegInt(v[f])) return null;
    inv[f] = v[f];
  }
  if (!isBool(v.queen) || !isBool(v.knight) || !isBool(v.allied)) return null;
  inv.queen = v.queen;
  inv.knight = v.knight;
  inv.allied = v.allied;
  return inv as unknown as PlayerInventory;
}

function parsePlayer(v: unknown): Player | null {
  if (!isObj(v)) return null;
  if (!isStr(v.id) || !/^p\d+$/.test(v.id)) return null;
  if (!isStr(v.name)) return null;
  if (!isInt(v.colorIndex, 0, 5)) return null;
  if (!isInt(v.position, 1, 30)) return null;
  const inventory = parseInventory(v.inventory);
  if (!inventory) return null;
  if (!isObj(v.dungeon) || !isBool(v.dungeon.inDungeon) || !isInt(v.dungeon.turnsServed, 0, 3)) return null;
  if (!Array.isArray(v.resourceCard) || v.resourceCard.length !== 6) return null;
  const outcomes: ResourceOutcome[] = [];
  for (const slot of v.resourceCard) {
    const o = parseOutcome(slot);
    if (!o) return null;
    outcomes.push(o);
  }
  const resourceCard = outcomes as unknown as ResourceCard;
  if (!isValidResourceCard(resourceCard)) return null;
  if (!isNonNegInt(v.baseTurnsTaken)) return null;
  if (!isBool(v.removed)) return null;
  if (!isNonNegInt(v.mappingChangesAvailable)) return null;
  if (!isStr(v.workerPreference) || !WORKER_PREFS.has(v.workerPreference)) return null;
  return {
    id: v.id,
    name: v.name,
    colorIndex: v.colorIndex,
    position: v.position,
    inventory,
    dungeon: { inDungeon: v.dungeon.inDungeon, turnsServed: v.dungeon.turnsServed },
    resourceCard,
    baseTurnsTaken: v.baseTurnsTaken,
    removed: v.removed,
    mappingChangesAvailable: v.mappingChangesAvailable,
    workerPreference: v.workerPreference as "wall-roof" | "wall-wall",
  };
}

/**
 * Validate an untrusted save blob and rebuild a clean ParsedSave, or null.
 */
export function parseSave(raw: unknown): ParsedSave | null {
  if (!isObj(raw)) return null;
  if (raw.v !== 1 || raw.game !== "perfectpalace") return null;
  if (!isNonNegInt(raw.turnCount)) return null;

  // ---- seats / lineup ----
  if (!Array.isArray(raw.seats) || raw.seats.length < 2 || raw.seats.length > 6) return null;
  const seats: SaveSeat[] = [];
  const seenNames = new Set<string>();
  for (const s of raw.seats) {
    if (!isObj(s) || !isStr(s.nickname) || !isBool(s.isBot) || !isBool(s.gone)) return null;
    const key = s.nickname.toLowerCase();
    if (seenNames.has(key)) return null; // unique nicknames
    seenNames.add(key);
    const difficulty = s.difficulty === "easy" || s.difficulty === "hard" ? s.difficulty : "normal";
    seats.push({ nickname: s.nickname, isBot: s.isBot, gone: s.gone, difficulty });
  }
  if (seats.every((s) => s.gone)) return null; // someone must be able to resume

  // ---- engine ----
  const e = raw.engine;
  if (!isObj(e)) return null;
  if (!isStr(e.phase) || !RESUMABLE_PHASES.has(e.phase)) return null;
  if (e.winner !== undefined) return null; // a finished game is not resumable
  if (!Array.isArray(e.players) || e.players.length !== seats.length) return null;

  const players: Player[] = [];
  const ids = new Set<string>();
  for (const pv of e.players) {
    const p = parsePlayer(pv);
    if (!p) return null;
    if (ids.has(p.id)) return null;
    ids.add(p.id);
    players.push(p);
  }
  const presentIds = (id: string) => ids.has(id);

  // turnOrder: distinct known ids.
  if (!Array.isArray(e.turnOrder)) return null;
  const orderSeen = new Set<string>();
  for (const id of e.turnOrder) {
    if (!isStr(id) || !presentIds(id) || orderSeen.has(id)) return null;
    orderSeen.add(id);
  }
  if (!(e.currentPlayerId === null || (isStr(e.currentPlayerId) && presentIds(e.currentPlayerId)))) return null;

  // turn block.
  if (!isObj(e.turn)) return null;
  const t = e.turn;
  if (!isStr(t.phase) || !RESUMABLE_PHASES.has(t.phase)) return null;
  if (!isNonNegInt(t.activePlayerIndex) || t.activePlayerIndex >= players.length) return null;
  if (!isNonNegInt(t.extraTurnsQueued)) return null;
  for (const f of ["bailiffStealUsedThisTurnSequence", "acquiredBailiffThisTurn", "enteredDungeonThisTurn", "skipOptionalActions", "traderUsedThisTurn"] as const) {
    if (!isBool(t[f])) return null;
  }
  let pendingFine: GameState["turn"]["pendingFine"] = undefined;
  if (t.pendingFine !== undefined) {
    if (!isObj(t.pendingFine) || !isNonNegInt(t.pendingFine.amount) || !isStr(t.pendingFine.source) || !FINE_SOURCES.has(t.pendingFine.source)) {
      return null;
    }
    pendingFine = { amount: t.pendingFine.amount, source: t.pendingFine.source as "invasion" | "lose-money" };
  }
  if (t.lastRoll !== undefined && !isInt(t.lastRoll, 1, 6)) return null;

  // bailiff.
  if (!isObj(e.bailiff)) return null;
  let bailiff: GameState["bailiff"];
  if (e.bailiff.kind === "middle") {
    bailiff = { kind: "middle" };
  } else if (e.bailiff.kind === "held" && isStr(e.bailiff.by) && presentIds(e.bailiff.by)) {
    bailiff = { kind: "held", by: e.bailiff.by };
  } else {
    return null;
  }

  // deck + discard: union is a permutation of 1..TOTAL_CARDS.
  if (!Array.isArray(e.deck) || !Array.isArray(e.discard)) return null;
  const all = [...e.deck, ...e.discard];
  if (all.length !== TOTAL_CARDS) return null;
  const cardSeen = new Set<number>();
  for (const id of all) {
    if (!isInt(id, 1, TOTAL_CARDS) || cardSeen.has(id)) return null;
    cardSeen.add(id);
  }

  // seeded PRNG state.
  if (!isInt(e.rngState, 0, 0xffffffff)) return null;

  // optional palace-trigger fields.
  if (e.palaceBuiltBy !== undefined && !(isStr(e.palaceBuiltBy) && presentIds(e.palaceBuiltBy))) return null;
  if (e.palaceTriggerTurnIndex !== undefined && !isNonNegInt(e.palaceTriggerTurnIndex)) return null;

  // ---- rebuild a clean GameState from validated values ----
  const engine: GameState = {
    phase: e.phase as GameState["phase"],
    players,
    turnOrder: [...(e.turnOrder as string[])],
    currentPlayerId: e.currentPlayerId as string | null,
    turn: {
      phase: t.phase as GameState["phase"],
      activePlayerIndex: t.activePlayerIndex,
      lastRoll: t.lastRoll as number | undefined,
      extraTurnsQueued: t.extraTurnsQueued,
      bailiffStealUsedThisTurnSequence: t.bailiffStealUsedThisTurnSequence as boolean,
      acquiredBailiffThisTurn: t.acquiredBailiffThisTurn as boolean,
      enteredDungeonThisTurn: t.enteredDungeonThisTurn as boolean,
      skipOptionalActions: t.skipOptionalActions as boolean,
      traderUsedThisTurn: t.traderUsedThisTurn as boolean,
      pendingFine,
    },
    bailiff,
    deck: (e.deck as number[]).slice(),
    discard: (e.discard as number[]).slice(),
    rngState: e.rngState,
    log: [],
    palaceBuiltBy: e.palaceBuiltBy as string | undefined,
    palaceTriggerTurnIndex: e.palaceTriggerTurnIndex as number | undefined,
  };

  // Optional duel block (present only mid-duel).
  if (e.duel !== undefined) {
    const parsedDuel = parseDuel(e.duel, presentIds);
    if (!parsedDuel) return null;
    engine.duel = parsedDuel;
  }

  return { engine, seats, turnCount: raw.turnCount };
}

function parseDuel(v: unknown, present: (id: string) => boolean): PerfectPalaceEngine.DuelState | null {
  if (!isObj(v)) return null;
  if (!isInt(v.squareNumber, 1, 30)) return null;
  if (!Array.isArray(v.participants) || !Array.isArray(v.contenders)) return null;
  for (const id of [...v.participants, ...v.contenders]) {
    if (!isStr(id) || !present(id)) return null;
  }
  if (!isObj(v.stake)) return null;
  const stakeFields = ["dollars", "bricks", "sticks", "walls", "roofs", "rooms"] as const;
  const stake: Record<string, number> = {};
  for (const f of stakeFields) {
    if (!isNonNegInt(v.stake[f])) return null;
    stake[f] = v.stake[f] as number;
  }
  if (!isObj(v.rolls)) return null;
  const rolls: Record<string, number> = {};
  for (const [id, val] of Object.entries(v.rolls)) {
    if (!present(id) || !isInt(val, 1, 6)) return null;
    rolls[id] = val;
  }
  if (v.winner !== undefined && !(isStr(v.winner) && present(v.winner))) return null;
  return {
    squareNumber: v.squareNumber,
    participants: [...(v.participants as string[])],
    contenders: [...(v.contenders as string[])],
    stake: stake as unknown as PerfectPalaceEngine.DuelStake,
    rolls,
    winner: v.winner as string | undefined,
  };
}
