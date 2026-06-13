// The Perfect Palace — shared schema + messages.
//
// The rules live in the ported engine (./engine/, server-only authority). This
// schema is the PUBLIC mirror the room rewrites from the engine after every
// accepted action (see PerfectPalaceRoom.syncFromEngine). Engine players are
// array indices here: PerfectPalaceState.seats[i] is engine player i, whose
// engine id is `p${i+1}`.
//
// Hidden information is minimal. The ONLY secret is the simultaneous initial
// resource-card pick: during the 'initial-mapping' phase each seat's
// `resourceCard` is left EMPTY in the mirror (the real picks are staged
// server-side in the engine and never synced), and `mappingLocked` shows who is
// ready. At mapping/revealAll every card is published to everyone. The DECK is
// never synced — only deck/discard COUNTS. The held Royal Pardon is public
// (a count on the seat inventory).
import { ArraySchema, Schema, type } from "@colyseus/schema";
import { BasePlayer, BaseState } from "../../state.js";

export * as PerfectPalaceEngine from "./engine/index.js";

/** Lobby/registry gameType id. */
export const PERFECT_PALACE = "perfectpalace";

/**
 * Client -> server messages. One message type; the payload is a tagged engine
 * action ({ type: "...", ... }), whitelist-sanitized server-side. Dice are
 * never accepted from clients, and `id`/`targetId` fields are bound to the
 * sender. SAVE / SAVE_DATA / LOAD are framework messages (LobbyMsg / ServerMsg).
 */
export const PerfectPalaceMsg = {
  ACTION: "perfectpalace/action",
  /** Any player, lobby-only. Payload: { color: number } — a palette index 0-5,
   *  or -1 to clear. Rejected if another player already chose that color. */
  PICK_COLOR: "perfectpalace/pickColor",
} as const;

/** Per-player palette (indexed by seat order). Kid-friendly, distinct hues. */
export const PERFECT_PALACE_COLORS = [
  "#c0392b", // ruby
  "#2980b9", // sapphire
  "#27ae60", // emerald
  "#f39c12", // gold
  "#8e44ad", // amethyst
  "#16a085", // teal
] as const;

/** A player's full inventory (raw resources, built items, staff, specials). */
export class PPInventory extends Schema {
  // Raw resources — cards dump 50-75 at a time and they accumulate, so uint32.
  @type("uint32") bricks = 0;
  @type("uint32") sticks = 0;
  @type("uint32") dollars = 0;
  // Built items.
  @type("uint16") walls = 0;
  @type("uint16") roofs = 0;
  @type("uint16") rooms = 0;
  @type("uint16") buildings = 0;
  @type("uint16") threeStoryBuildings = 0;
  @type("uint16") palaces = 0;
  // Staff.
  @type("uint16") workers = 0;
  @type("uint16") servers = 0;
  @type("uint16") chefs = 0;
  @type("uint16") cleaners = 0;
  @type("uint16") wholeHouseCleaners = 0;
  // Specials.
  @type("boolean") queen = false;
  @type("boolean") knight = false;
  @type("boolean") allied = false;
  /** Held Royal Pardon cards (public — fine to show). */
  @type("uint8") pardonCards = 0;
}

/** One face of a resource card: the outcome for rolling (slot index + 1). */
export class PPResourceSlot extends Schema {
  /** "sticks" | "bricks" | "dollars" | "draw-card". */
  @type("string") kind = "";
  /** Amount for sticks/bricks/dollars; 0 for "draw-card". */
  @type("uint8") amount = 0;
}

/** A duel pot's per-player stake (each contender matches it). */
export class PPDuelStake extends Schema {
  @type("uint16") dollars = 0;
  @type("uint16") bricks = 0;
  @type("uint16") sticks = 0;
  @type("uint16") walls = 0;
  @type("uint16") roofs = 0;
  @type("uint16") rooms = 0;
}

/** Same-square duel state (present only while turnPhase === 'duel'). */
export class PPDuel extends Schema {
  @type("uint8") squareNumber = 0;
  /** Original pot contributors (fixed at duel start), by engine id. */
  @type(["string"]) participants = new ArraySchema<string>();
  /** Players still in the running (shrinks on ties), by engine id. */
  @type(["string"]) contenders = new ArraySchema<string>();
  /** Per-contender stake (the pot is stake × participants; winner takes all). */
  @type(PPDuelStake) stake = new PPDuelStake();
  /** Parallel arrays: rollPlayers[i] (engine id) rolled rollValues[i] (0 = not yet). */
  @type(["string"]) rollPlayers = new ArraySchema<string>();
  @type(["uint8"]) rollValues = new ArraySchema<number>();
  /** Engine id of the resolved winner, or "" while unresolved. */
  @type("string") winner = "";
}

/** One engine seat; PerfectPalaceState.seats index === engine player index. */
export class PPSeat extends Schema {
  /** Engine player id (`p1`..`pN`). */
  @type("string") engineId = "";
  /** Owning player's sessionId; "" once they left for good. */
  @type("string") sessionId = "";
  @type("string") nickname = "";
  /** Index into PERFECT_PALACE_COLORS. */
  @type("uint8") colorIndex = 0;
  /** Board square 1-30. */
  @type("uint8") position = 1;
  @type(PPInventory) inventory = new PPInventory();
  // Dungeon.
  @type("boolean") inDungeon = false;
  @type("uint8") dungeonTurnsServed = 0;
  /**
   * The 6-face resource card. EMPTY during 'initial-mapping' (the pick is hidden
   * and staged server-side); populated for everyone at mapping/revealAll and for
   * the rest of the game.
   */
  @type([PPResourceSlot]) resourceCard = new ArraySchema<PPResourceSlot>();
  /** True once this player has confirmed their initial pick (public readiness). */
  @type("boolean") mappingLocked = false;
  /** Base turns taken (for the end-game equal-turns tally). */
  @type("uint16") baseTurnsTaken = 0;
  /** Removed mid-game (left for good). */
  @type("boolean") removed = false;
  /** Unspent lap credits for 1-slot mapping changes. */
  @type("uint8") mappingChangesAvailable = 0;
  /** "wall-roof" | "wall-wall" — how the Worker spends its output. */
  @type("string") workerPreference = "wall-roof";
  /** Left for good (same as removed; kept for the view/save lineup). */
  @type("boolean") gone = false;
}

/**
 * Lobby color pick: a palette index 0-5, or -1 = none yet (honored at game start
 * if still free). The seat's final color lives on PPSeat.colorIndex.
 */
export class PerfectPalacePlayer extends BasePlayer {
  @type("int8") colorChoice = -1;
}

export class PerfectPalaceState extends BaseState {
  /** One per engine player, in engine player-array order (id `p${i+1}`). */
  @type([PPSeat]) seats = new ArraySchema<PPSeat>();

  // ---- flow mirror (the engine is the authority) ----
  /** Engine GameState.phase. */
  @type("string") enginePhase = "";
  /** Engine turn.phase (turn-start/rolling/.../duel/optional-actions/game-over). */
  @type("string") turnPhase = "";
  /** Engine id of the player whose turn it is ("" if none). */
  @type("string") currentPlayerId = "";
  /** sessionId of the single actor; "" during multi-actor mapping/duel phases. */
  @type("string") currentTurn = "";
  /** Turn order, by engine id. */
  @type(["string"]) turnOrder = new ArraySchema<string>();
  @type("uint8") activePlayerIndex = 0;
  /** Last die roll this turn (0 = none yet). */
  @type("uint8") lastRoll = 0;
  @type("uint8") extraTurnsQueued = 0;
  @type("boolean") bailiffStealUsed = false;
  @type("boolean") acquiredBailiffThisTurn = false;
  @type("boolean") enteredDungeonThisTurn = false;
  @type("boolean") skipOptionalActions = false;
  @type("boolean") traderUsedThisTurn = false;

  // ---- pending fine (#7/#11/#28 insolvency dialog) ----
  @type("boolean") finePending = false;
  @type("uint16") fineAmount = 0;
  /** "invasion" | "lose-money" | "". */
  @type("string") fineSource = "";

  // ---- duel ----
  @type("boolean") duelActive = false;
  @type(PPDuel) duel = new PPDuel();

  // ---- bailiff ----
  /** "middle" | "held". */
  @type("string") bailiffKind = "middle";
  /** Engine id of the holder, or "" when in the middle. */
  @type("string") bailiffBy = "";

  // ---- deck redaction: COUNTS only, never card order ----
  @type("uint8") deckCount = 0;
  @type("uint8") discardCount = 0;

  // ---- dice animation: a monotonic seq bumped on EVERY server-rolled die (turn
  // or duel) so the client can animate each roll, even when the value repeats. ----
  @type("uint32") lastRollSeq = 0;
  @type("uint8") lastRollValue = 0;
  /** Engine id of whoever rolled lastRollValue. */
  @type("string") lastRollBy = "";

  // ---- outcome ----
  /** Engine id of the winner (set at game-over), or "". */
  @type("string") winnerId = "";
  /** Engine id of the first palace builder (triggers the end-game), or "". */
  @type("string") palaceBuiltBy = "";
  /** baseTurnsTaken of the trigger (-1 = not triggered). */
  @type("int16") palaceTriggerTurnIndex = -1;

  /** Human-readable event feed (capped tail; survives refresh). */
  @type(["string"]) log = new ArraySchema<string>();
  // loadedSave lives on BaseState (framework-owned save/resume).
}
