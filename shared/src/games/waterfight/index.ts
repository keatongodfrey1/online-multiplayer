/**
 * Water Fight — shared engine namespace + Colyseus schema mirror.
 *
 * The rules live in the pure, server-only engine (./engine/). The schema classes
 * + message constants below are the PUBLIC projection synced to clients: deck
 * COUNTS (never the hidden order), each seat's public status, and the active
 * player's OWN hand via `@view()` (StateView-gated, owner-only). Mirrors
 * shared/src/games/splendor/index.ts.
 */
import { ArraySchema, entity, Schema, type, view } from "@colyseus/schema";
import { BasePlayer, BaseState } from "../../state.js";

export * as WaterFightEngine from "./engine/index.js";
export * from "./constants.js";

export const WATER_FIGHT = "waterfight";

export const WaterFightMsg = {
  /** A Main Action / Support (the active player). Payload: an engine Move. */
  MOVE: "waterfight/move",
  /** An out-of-turn reaction / chained sub-decision. Payload: an engine Resolution. */
  RESOLVE: "waterfight/resolve",
  /** Host-only, lobby-only. Payload: { key: string, value: number } (see WF_SETTINGS). */
  CONFIG: "waterfight/config",
  /** Server -> ONE client: a private peek (Goggles / Sneaky Peek). Payload:
   *  { kind: "deck-top" | "hand", ofSeat: number, cards: {id,kind}[] }. */
  REVEAL: "waterfight/reveal",
  /** Any seated player, during the end-of-game reveal beat: advance to the standings
   *  screen now (otherwise a server timer auto-advances). No payload. */
  CONTINUE: "waterfight/continue",
} as const;

/**
 * The lobby dials (eng-review decision 2A): ONE descriptor table drives both the
 * server-side CONFIG validation and the client lobby UI. Adding a dial is one row
 * here plus a schema field below — not three files. `seconds` dials accept 0 = off.
 */
export interface WFSetting {
  key: string;
  label: string;
  min: number;
  max: number;
  step: number;
  default: number;
  /** Short helper text for the lobby. */
  hint: string;
}

export const WF_SETTINGS: readonly WFSetting[] = [
  { key: "startingLives", label: "Starting lives", min: 1, max: 5, step: 1, default: 3, hint: "Lives each player starts with." },
  { key: "splashHit", label: "Splash Hit cards", min: 1, max: 30, step: 1, default: 13, hint: "Hit cards in the Splash Pile (higher = throws land more)." },
  { key: "splashMiss", label: "Splash Miss cards", min: 0, max: 30, step: 1, default: 7, hint: "Miss cards in the Splash Pile." },
  { key: "mainHit", label: "Deck Hit cards", min: 0, max: 50, step: 1, default: 20, hint: "Hit hand-cards in the main deck (the counter-block layer)." },
  { key: "mainMiss", label: "Deck Miss cards", min: 0, max: 50, step: 1, default: 20, hint: "Miss hand-cards in the main deck (the block layer)." },
  { key: "handLimit", label: "Hand limit", min: 3, max: 20, step: 1, default: 8, hint: "Discard down to this at end of turn." },
  { key: "shopCost", label: "Shop cost", min: 1, max: 10, step: 1, default: 4, hint: "Coins to buy one shop card." },
  { key: "eventDensity", label: "Event density", min: 0, max: 19, step: 1, default: 8, hint: "How many of the 19 Events are seeded." },
  { key: "stormDraw", label: "Storm Cloud draw", min: 0, max: 5, step: 1, default: 1, hint: "Cards a soaked Storm Cloud draws per turn." },
  { key: "stormThrows", label: "Storm Cloud throws", min: 0, max: 5, step: 1, default: 1, hint: "Balloons a Storm Cloud may splash per turn." },
  { key: "maxReactions", label: "Max reactions", min: 0, max: 50, step: 1, default: 0, hint: "Cap on a defense ladder's back-and-forth (0 = unlimited)." },
  { key: "turnSeconds", label: "Turn timer (s)", min: 0, max: 300, step: 5, default: 0, hint: "Auto-pass an idle player's turn (0 = off)." },
  { key: "reactionSeconds", label: "Reaction timer (s)", min: 0, max: 60, step: 1, default: 12, hint: "Auto-pass an idle reaction (0 = off)." },
] as const;

export function wfSettingByKey(key: string): WFSetting | undefined {
  return WF_SETTINGS.find((s) => s.key === key);
}

/** A single card (id + kind). Only ever populated inside a seat's private hand. */
export class WaterFightCard extends Schema {
  /** Engine card id. */
  @type("uint16") id = 0;
  /** Engine CardKind (e.g. "balloon", "miss", "umbrella", "event"). */
  @type("string") kind = "";
}

@entity
export class WaterFightPlayer extends BasePlayer {}

/** The end-of-game "result reveal" beat: while `pending` is true the game is over
 *  in the engine but the room holds `phase=PLAYING` for a moment so the view can show
 *  who won / why / the finishing blow before the framework standings screen takes
 *  over. All PUBLIC (the outcome is public). Nested in its own schema to keep
 *  WaterFightState under the per-structure field cap. */
export class WaterFightResult extends Schema {
  /** The beat is in progress (game over, phase still PLAYING). */
  @type("boolean") pending = false;
  /** Engine seat of the winner (meaningful only when !draw). */
  @type("uint8") winnerSeat = 0;
  /** No single winner (turn cap with no survivor edge). */
  @type("boolean") draw = false;
  /** "last-standing" | "cap" | "draw". */
  @type("string") endKind = "";
  /** The finishing blow (for the named reveal line). -1 attacker = none/Event. */
  @type("int8") blowAttacker = -1;
  @type("uint8") blowVictim = 0;
  /** The specific finishing kind: an attack kind or a damaging EventKind ("" = none). */
  @type("string") blowMeans = "";
  /** Epoch ms the beat auto-advances (cosmetic countdown; the server timer is
   *  authoritative). */
  @type("float64") deadline = 0;
}

/** One PUBLIC consequential moment, surfaced as a transient toast on every client.
 *  FLAT PRIMITIVES + a pre-built GENERIC `text` — a card identity must NEVER appear
 *  (the stream is public; secret specifics go via the private REVEAL channel). */
export class WaterFightEvent extends Schema {
  /** Room-owned monotonic id; the client toasts each `seq` once (primed on mount). */
  @type("uint32") seq = 0;
  /** Routing key ("damage"|"soak"|"save"|"heal"|"event"|"support"|"attack"|"react"
   *  |"draw"|"suddendeath"|"turn"). */
  @type("string") kind = "";
  /** Actor seat, or -1. */
  @type("int8") seat = -1;
  /** Target seat, or -1. */
  @type("int8") target = -1;
  /** Kind-specific magnitude (damage/heal/draw count); 0 when N/A. */
  @type("uint16") amount = 0;
  /** PUBLIC, GENERIC, pre-built human line. */
  @type("string") text = "";
  /** The SPECIFIC public card/event/defense kind (so the client can show its name + effect);
   *  "" when none or secret. NEVER a hidden card identity. */
  @type("string") detailKind = "";
}

/** One seat's public status, plus the owner-only hand. */
export class WaterFightSeat extends Schema {
  @type("string") sessionId = "";
  @type("string") nickname = "";
  /** Engine seat index (0-based, stable for the game). */
  @type("uint8") seat = 0;
  @type("uint8") lives = 0;
  /** Soaked: not a living player, cannot win. */
  @type("boolean") out = false;
  /** Soft-eliminated (D5): plays from the sideline. */
  @type("boolean") stormCloud = false;
  /** Public hand size (the cards themselves are private). */
  @type("uint8") handCount = 0;
  /** Pending statuses (UI hints). */
  @type("boolean") freezeOut = false;
  @type("boolean") noShop = false;
  /** Left for good and on autopilot. */
  @type("boolean") gone = false;
  /** PRIVATE: synced only to this seat's owner via StateView (grantPrivateView). */
  @view() @type([WaterFightCard]) hand = new ArraySchema<WaterFightCard>();
}

export class WaterFightState extends BaseState {
  @type([WaterFightSeat]) seats = new ArraySchema<WaterFightSeat>();

  // ---- deck counts (public; the order/contents are server-only) ----
  @type("uint16") mainDeckCount = 0;
  @type("uint16") mainDiscardCount = 0;
  @type("uint16") splashPileCount = 0;
  @type("uint16") splashDiscardCount = 0;
  @type("uint16") usedPileCount = 0;
  /** [defense, mischief, attack] remaining counts (blind shop). */
  @type(["uint8"]) stackCounts = new ArraySchema<number>(0, 0, 0);

  // ---- turn + awaiting ----
  /** Engine seat whose Main Action it is. */
  @type("uint8") turnSeat = 0;
  /** sessionId of the turn player (for turn alerts). */
  @type("string") currentTurn = "";
  /** MOVE | REACT | DEFEND | ATTACKER_RESPOND | DISCARD | EXTRA_THROW | SPLASH_DRAW | GAME_OVER. */
  @type("string") awaitingKind = "";
  /** Engine seats who may act right now (defenders/reactors may be non-current). */
  @type(["uint8"]) awaitingSeats = new ArraySchema<number>();
  /** How many cards the awaited DISCARD must drop (0 otherwise). */
  @type("uint8") discardCount = 0;

  // ---- attack mirror (so a defender can render the prompt) ----
  @type("boolean") attackActive = false;
  /** "basic" | "mega" | "giant" | "golden". */
  @type("string") attackKind = "";
  @type("uint8") attackerSeat = 0;
  @type("uint8") attackTarget = 0;
  @type("uint8") attackBlockNumber = 0;
  @type("uint8") attackDamage = 0;
  /** Soaker Cannon active — hand Miss is negated for this attack. */
  @type("boolean") attackSoaker = false;
  /** During a REACT window: the kind of card being reacted to ("THROW"|"PLAY_BIG"|"SUPPORT"). */
  @type("string") pendingKind = "";
  /** The SPECIFIC incoming card kind (the support/big), so the React banner can name it
   *  ("incoming 💣 Sabotage"). "" when none. The kind is public; the resulting lost card
   *  stays secret. */
  @type("string") pendingCardKind = "";

  /** PUBLIC event stream — the room appends consequential moments with a monotonic seq;
   *  the client toasts each new one. Capped; reconnection-safe (client primes on mount). */
  @type([WaterFightEvent]) events = new ArraySchema<WaterFightEvent>();

  // ---- last Splash flip (the interactive hit/miss draw reveal) ----
  /** Advances on every flip so clients can detect a NEW draw (0 = none yet). */
  @type("uint16") lastSplashSeq = 0;
  /** "hit" | "miss" | "" (none yet). */
  @type("string") lastSplashVerdict = "";
  /** The seat that was splashed (named in the reveal banner). */
  @type("uint8") lastSplashTarget = 0;

  // ---- phase / progress ----
  @type("boolean") suddenDeath = false;
  @type("uint16") turnCount = 0;

  /** End-of-game reveal beat (see WaterFightResult). */
  @type(WaterFightResult) result = new WaterFightResult();

  // ---- timers ----
  @type("uint16") turnSeconds = 0;
  @type("uint16") reactionSeconds = 12;
  /** Epoch ms the current awaited action auto-resolves (0 = no countdown). */
  @type("float64") actionDeadline = 0;

  // ---- lobby dials (also seed a fresh game's options) ----
  @type("uint8") startingLives = 3;
  @type("uint8") splashHit = 13;
  @type("uint8") splashMiss = 7;
  @type("uint8") mainHit = 20;
  @type("uint8") mainMiss = 20;
  @type("uint8") handLimit = 8;
  @type("uint8") shopCost = 4;
  @type("uint8") eventDensity = 8;
  @type("uint8") stormDraw = 1;
  @type("uint8") stormThrows = 1;
  @type("uint8") maxReactions = 0;

  // ---- capped synced log (eng-review decision 3A) ----
  @type(["string"]) log = new ArraySchema<string>();
}
