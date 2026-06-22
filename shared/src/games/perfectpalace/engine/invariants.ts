// Structural invariants for The Perfect Palace. Throws on the first violation.
// Run after EVERY reduce in tests/fuzz and inside parseSave on resume.
//
// The load-bearing one is the SOFT-LOCK detector: a game that is NOT over must
// always have *someone able to act* — either an awaited seat (the current
// player, or, in the simultaneous mapping / duel phases, the seats still owing
// an action) or a forced auto-step the room performs without player input
// (mapping-reveal, duel-resolve). A state with nobody to act and no auto-step
// pending would stall the table forever, which is the failure mode this guards.
//
// Mirrors waterfight/engine/invariants.ts (conservation + soft-lock). Pure;
// no Colyseus imports.

import { TOTAL_CARDS } from "./cards.js";
import { MAX_PLAYERS, MIN_PLAYERS } from "./constants.js";
import { isValidResourceCard } from "./reducer.js";
import type { GameState, Player } from "./types.js";

/** Setup-only top-level phases (top-level `phase` freezes at 'turn-start' once
 *  play begins; `turn.phase` is the live phase thereafter). */
const SETUP_PHASES = new Set<string>(["setup", "initial-roll", "initial-mapping", "mapping-reveal"]);

/** Turn phases that resolve via a forced server auto-step rather than a player
 *  action: mapping-reveal fires `mapping/revealAll`; a fully-rolled duel fires
 *  `turn/duelResolve`. These are "someone can act" for soft-lock purposes. */
function autoStepPending(s: GameState): boolean {
  // All active players locked their mapping → the room fires mapping/revealAll.
  if (s.phase === "initial-mapping") {
    const active = s.players.filter((p) => !p.removed);
    if (active.length > 0 && active.every((p) => p.mappingLocked)) return true;
  }
  // Every duel contender has rolled → the room fires turn/duelResolve.
  if (s.turn.phase === "duel" && s.duel) {
    const d = s.duel;
    if (d.contenders.length > 0 && d.contenders.every((id) => d.rolls[id] != null)) return true;
  }
  return false;
}

/** The engine seats that must act now (mirrors the room's awaitingAutoSeats and
 *  the test harness's awaiting()): initial-roll → every un-rolled active seat;
 *  initial-mapping → every unlocked active seat; duel → every contender yet to
 *  roll; otherwise the current player. */
function awaitedIds(s: GameState): string[] {
  if (s.phase === "game-over" || s.turn.phase === "game-over") return [];
  if (s.phase === "initial-roll") {
    return s.players.filter((p) => !p.removed && p.initialRoll == null).map((p) => p.id);
  }
  if (s.phase === "initial-mapping") {
    return s.players.filter((p) => !p.removed && !p.mappingLocked).map((p) => p.id);
  }
  if (s.turn.phase === "duel" && s.duel) {
    return s.duel.contenders.filter((id) => s.duel!.rolls[id] == null);
  }
  return s.currentPlayerId ? [s.currentPlayerId] : [];
}

export function assertInvariants(s: GameState): void {
  // ---- player count ----
  const live = s.players.filter((p) => !p.removed);
  // During 'setup' the roster is still being assembled, so only enforce the
  // bound once the game has left setup.
  if (s.phase !== "setup") {
    if (s.players.length < MIN_PLAYERS || s.players.length > MAX_PLAYERS) {
      throw new Error(`player count out of range: ${s.players.length}`);
    }
  }

  // ---- unique player ids; ids match the p<n> shape ----
  const ids = new Set<string>();
  for (const p of s.players) {
    if (!/^p\d+$/.test(p.id)) throw new Error(`malformed player id: ${p.id}`);
    if (ids.has(p.id)) throw new Error(`duplicate player id: ${p.id}`);
    ids.add(p.id);
  }

  // ---- per-player: non-negative integer resources/pieces; valid card; range ----
  for (const p of s.players) assertPlayer(p);

  // ---- card conservation: deck + discard is a permutation of 1..TOTAL_CARDS,
  //      MINUS any persistent cards held in a hand (only the Royal Pardon, id 17,
  //      survives in a player's inventory as pardonCards). Every other drawn card
  //      resolves immediately and lands in the discard, so the only card that can
  //      be "out of the piles" is a held pardon. ----
  const heldPardons = s.players.reduce((n, p) => n + p.inventory.pardonCards, 0);
  const pile = [...s.deck, ...s.discard];
  const seen = new Set<number>();
  for (const id of pile) {
    if (!Number.isInteger(id) || id < 1 || id > TOTAL_CARDS) throw new Error(`bad card id in pile: ${id}`);
    if (seen.has(id)) throw new Error(`duplicate card id in pile: ${id}`);
    seen.add(id);
  }
  // The pardon (17) is the only card that may legitimately be absent from the
  // piles (it is held in hand). Any other missing/extra card is a conservation bug.
  const expected = TOTAL_CARDS - heldPardons;
  if (pile.length !== expected) {
    throw new Error(`card conservation: ${pile.length} in piles + ${heldPardons} held != ${TOTAL_CARDS}`);
  }
  if (heldPardons > 0 && seen.has(17)) {
    throw new Error("Royal Pardon (17) is both held and in a pile");
  }
  if (heldPardons > 1) {
    // Only one pardon card exists in the deck.
    throw new Error(`more pardons held (${heldPardons}) than exist in the deck`);
  }

  // ---- bailiff: held by a present, non-removed player or in the middle ----
  if (s.bailiff.kind === "held") {
    const by = s.bailiff.by;
    if (!ids.has(by)) throw new Error(`bailiff held by unknown player ${by}`);
    const holder = s.players.find((p) => p.id === by);
    if (holder?.removed) throw new Error("bailiff held by a removed player");
  } else if (s.bailiff.kind !== "middle") {
    throw new Error(`bad bailiff location`);
  }

  // ---- rngState is a 32-bit unsigned int ----
  if (!Number.isInteger(s.rngState) || s.rngState < 0 || s.rngState > 0xffffffff) {
    throw new Error(`rngState out of range: ${s.rngState}`);
  }

  // ---- turn order is a permutation of the live players (once order is set) ----
  // turnOrder is empty during setup/initial-roll (before finalize); once the
  // game is in play it must list exactly the non-removed players, each once.
  if (s.turnOrder.length > 0) {
    const orderSeen = new Set<string>();
    for (const id of s.turnOrder) {
      if (!ids.has(id)) throw new Error(`turnOrder references unknown player ${id}`);
      if (orderSeen.has(id)) throw new Error(`turnOrder lists ${id} twice`);
      orderSeen.add(id);
    }
    if (!SETUP_PHASES.has(s.phase) || s.phase === "mapping-reveal") {
      // In play (or about to be): every live player must be in turnOrder and
      // every turnOrder entry must be a live player.
      const liveIds = new Set(live.map((p) => p.id));
      for (const p of live) {
        if (!orderSeen.has(p.id)) throw new Error(`live player ${p.id} missing from turnOrder`);
      }
      for (const id of orderSeen) {
        if (!liveIds.has(id)) throw new Error(`turnOrder includes non-live player ${id}`);
      }
    }
  }

  // ---- current player / active index consistency (in play, not over) ----
  const inPlay = !SETUP_PHASES.has(s.phase) && s.phase !== "game-over" && s.turn.phase !== "game-over";
  if (inPlay) {
    if (s.currentPlayerId == null) throw new Error("in play but no current player");
    if (!ids.has(s.currentPlayerId)) throw new Error(`current player ${s.currentPlayerId} not present`);
    const idx = s.players.findIndex((p) => p.id === s.currentPlayerId);
    if (s.players[idx]!.removed) throw new Error("current player is removed");
    // NOTE: turn.activePlayerIndex is NOT cross-checked against the current
    // player's array index — the engine sets it only on the next-player endTurn
    // path (not on revealAll / extra-turn / pardon transitions), so it can lag
    // the current player on a legal state. The current-player fields above are
    // the reliable "whose turn is it" source; activePlayerIndex is advisory.
  }

  // ---- SOFT-LOCK detector: a not-over game must have someone able to act ----
  const over = s.phase === "game-over" || s.turn.phase === "game-over";
  if (!over) {
    const awaited = awaitedIds(s);
    if (awaited.length === 0 && !autoStepPending(s)) {
      throw new Error(`soft-lock: game not over but no seat is awaited and no auto-step is pending (phase=${s.phase}/${s.turn.phase})`);
    }
    // Every awaited id must be a present, non-removed player.
    for (const id of awaited) {
      if (!ids.has(id)) throw new Error(`awaiting unknown seat ${id}`);
      if (s.players.find((p) => p.id === id)!.removed) throw new Error(`awaiting a removed seat ${id}`);
    }
  } else {
    // Game over: a declared winner (if any) must be a present player.
    if (s.winner !== undefined && !ids.has(s.winner)) throw new Error(`winner ${s.winner} not present`);
  }
}

function assertPlayer(p: Player): void {
  if (!Number.isInteger(p.colorIndex) || p.colorIndex < 0) throw new Error(`bad colorIndex for ${p.id}`);
  if (!Number.isInteger(p.position) || p.position < 1 || p.position > 30) {
    throw new Error(`position out of range for ${p.id}: ${p.position}`);
  }
  const inv = p.inventory;
  const numFields: (keyof typeof inv)[] = [
    "bricks", "sticks", "dollars", "walls", "roofs", "rooms", "buildings",
    "threeStoryBuildings", "palaces", "workers", "servers", "chefs", "cleaners",
    "wholeHouseCleaners", "pardonCards",
  ];
  for (const f of numFields) {
    const v = inv[f] as number;
    if (!Number.isInteger(v) || v < 0) throw new Error(`negative/non-int ${String(f)} for ${p.id}: ${v}`);
  }
  if (typeof inv.queen !== "boolean") throw new Error(`bad queen flag for ${p.id}`);
  if (typeof inv.knight !== "boolean") throw new Error(`bad knight flag for ${p.id}`);
  if (typeof inv.allied !== "boolean") throw new Error(`bad allied flag for ${p.id}`);
  if (p.dungeon.turnsServed < 0 || p.dungeon.turnsServed > 3) {
    throw new Error(`dungeon turnsServed out of range for ${p.id}: ${p.dungeon.turnsServed}`);
  }
  if (!isValidResourceCard(p.resourceCard)) throw new Error(`invalid resource card for ${p.id}`);
}
