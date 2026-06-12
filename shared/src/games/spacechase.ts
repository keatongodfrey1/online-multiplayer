/**
 * Space Chase - shared constants, schema + messages.
 *
 * Rules authority: "Space Chase/GAME_RULES.md" corrected by
 * "Space Chase/MECHANICS_AND_RULINGS.md" (this rebuild implements the
 * INTENDED rules, not the old standalone code's known bugs).
 *
 * Board model: position 0 = START (shared, collision-exempt), 1..67 =
 * board spaces, 68 = Finish. While a rocket is inside a portal its
 * `position` stays at the entry mouth and portalId/portalProgress/
 * portalForward describe where it is along the tunnel.
 */
import { ArraySchema, entity, Schema, type, view } from "@colyseus/schema";
import { BasePlayer, BaseState } from "../state.js";

export const SPACE_CHASE = "spacechase";

// ── Board ──

export const SC_COLS = 10;
export const SC_ROWS = 7;
export const SC_START = 0;
export const SC_FINISH = 68; // board spaces are 1..67; >= 68 means finished

/** Named landmark spaces (visually distinct + labeled on the board). */
export const SC_LANDMARKS: Readonly<Record<number, string>> = {
  20: "The Space Permit",
  33: "The Star",
  46: "The Dice",
  50: "The Spear",
  52: "White Hole Dest.",
  58: "The Moon",
  64: "5:20",
};

/**
 * Portals are traversable shortcuts, NOT instant teleports: landing on
 * either end (by any means) puts the rocket inside at progress 0; later
 * movement crosses the `internal` spaces and exiting the far end costs
 * one extra move; leftover movement continues on the board.
 */
export interface PortalDef {
  id: 1 | 2 | 3;
  a: number;
  b: number;
  internal: number;
  color: string;
}

export const SC_PORTALS: readonly PortalDef[] = [
  { id: 1, a: 4, b: 36, internal: 7, color: "#ff44ff" },
  { id: 2, a: 28, b: 61, internal: 3, color: "#44ffff" },
  { id: 3, a: 39, b: 51, internal: 3, color: "#ffaa00" },
];

/** The portal with `space` as one of its mouths, if any. */
export function portalAt(space: number): PortalDef | undefined {
  return SC_PORTALS.find((p) => p.a === space || p.b === space);
}

/** Rocket colors by seat index (red, blue, green, yellow, purple). */
export const SC_PLAYER_COLORS: readonly string[] = [
  "#ff4444",
  "#4488ff",
  "#44dd44",
  "#ffdd00",
  "#cc44ff",
];

// ── Cards ──

export type CardType =
  | "moveForward"
  | "moveBack"
  | "moveAll"
  | "moveAllBack"
  | "rover"
  | "teleport"
  | "attack"
  | "spaceKraken"
  | "shootingStar"
  | "sixSeven"
  | "extraTurns"
  | "loseTurns"
  | "timeLoop"
  | "rocketJump"
  | "shield"
  | "spaceSuit"
  | "satellite";

export type AttackAction =
  | "sendToStart"
  | "moveBack"
  | "fighterJet"
  | "blackHole"
  | "loseTurns"
  | "wormHole";

export interface CardDef {
  id: number;
  name: string;
  /** Bare filename inside the client's card-art folder. */
  image: string;
  desc: string;
  type: CardType;
  amount?: number;
  destination?: number;
  action?: AttackAction;
}

/**
 * The 41 unique cards, data ported verbatim from the original
 * "Space Chase/js/cards.js" (which is authoritative for card DATA;
 * its resolution LOGIC had known bugs and is reimplemented server-side).
 */
export const CARD_DEFS: readonly CardDef[] = [
  // Movement forward
  { id: 1, name: "The Moon", image: "the_moon.png", desc: "Go forward 5 spaces (zero gravity)", type: "moveForward", amount: 5 },
  { id: 2, name: "Robotic Planet", image: "robotic_planet.png", desc: "Go forward 5 spaces", type: "moveForward", amount: 5 },
  { id: 3, name: "Space Dragon", image: "space_dragon.png", desc: "Go forward 5 spaces", type: "moveForward", amount: 5 },
  { id: 4, name: "Space Credit", image: "space_credit.png", desc: "Go forward 20 spaces", type: "moveForward", amount: 20 },
  { id: 5, name: "Earth", image: "earth.png", desc: "Go forward 10 spaces", type: "moveForward", amount: 10 },
  { id: 6, name: "Cosmic Chaos", image: "cosmic_chaos.png", desc: "Everyone goes forward 7 spaces", type: "moveAll", amount: 7 },
  { id: 7, name: "Tidal Wave of Cosmic Dust", image: "tidal_wave_of_cosmic_dust.png", desc: "All players go forward 3 spaces", type: "moveAll", amount: 3 },
  { id: 8, name: "Rover", image: "rover.png", desc: "Others go forward 5; you go forward 7", type: "rover" },
  // Movement backward
  { id: 9, name: "Cosmic Thunder", image: "cosmic_thunder.png", desc: "Go back 3 spaces", type: "moveBack", amount: 3 },
  { id: 10, name: "Asteroid", image: "asteroid.png", desc: "Go back 3 spaces", type: "moveBack", amount: 3 },
  { id: 11, name: "Alien Fireball", image: "alien_fireball.png", desc: "Go back 7 spaces", type: "moveBack", amount: 7 },
  { id: 12, name: "Alien Space Craft", image: "alien_space_craft.png", desc: "You explode! Go back 20 spaces", type: "moveBack", amount: 20 },
  { id: 13, name: "Time Bomb", image: "time_bomb.png", desc: "Back in time! Go back to Start", type: "teleport", destination: 0 },
  { id: 14, name: "Meteor Shower", image: "meteor_shower.png", desc: "Everyone goes back 5 spaces", type: "moveAllBack", amount: 5 },
  { id: 15, name: "Solar Flare", image: "solar_flare.png", desc: "Each person goes back 5 spaces", type: "moveAllBack", amount: 5 },
  // Attacks
  { id: 16, name: "Nuclear Bomb", image: "nuclear_bomb.png", desc: "Send someone back to Start", type: "attack", action: "sendToStart" },
  { id: 17, name: "Blaster", image: "blaster.png", desc: "Make 1 person go back 3 spaces", type: "attack", action: "moveBack", amount: 3 },
  { id: 18, name: "Alien Pirate", image: "alien_pirate.png", desc: "Choose 1 person to go back 10 spaces", type: "attack", action: "moveBack", amount: 10 },
  { id: 19, name: "Fighter Jet", image: "fighter_jet.png", desc: "Make one player go back 3 AND you go forward 3", type: "attack", action: "fighterJet" },
  { id: 20, name: "Black Hole", image: "black_hole.png", desc: "Teleport one player to any space (not you)", type: "attack", action: "blackHole" },
  { id: 21, name: "Ion Space Bomb", image: "ion_space_bomb.png", desc: "Make one person lose a turn", type: "attack", action: "loseTurns", amount: 1 },
  { id: 22, name: "Space Kraken", image: "space_kraken.png", desc: "3 people lose 1 turn OR 1 person loses 3 turns", type: "spaceKraken" },
  // Teleports
  { id: 23, name: "White Hole", image: "white_hole.png", desc: "Go to Space 52", type: "teleport", destination: 52 },
  { id: 24, name: "Cosmic Space Spear", image: "cosmic_space_spear.png", desc: "Go to The Spear (Space 50)", type: "teleport", destination: 50 },
  { id: 25, name: "Space Dice", image: "space_dice.png", desc: "Go to The Dice (Space 46)", type: "teleport", destination: 46 },
  { id: 26, name: "Space Permit", image: "space_permit.png", desc: "Go to The Space Permit (Space 20)", type: "teleport", destination: 20 },
  { id: 27, name: "Apollo 11 Spaceship", image: "apollo_11_spaceship.png", desc: "Go to The Moon (Space 58)", type: "teleport", destination: 58 },
  { id: 28, name: "Time Travel", image: "time_travel.png", desc: "Confusion! Teleport to 5:20 (Space 64)", type: "teleport", destination: 64 },
  { id: 29, name: "Shooting Star", image: "shooting_star.png", desc: "Send any player to The Star (33) OR go there yourself", type: "shootingStar" },
  { id: 30, name: "6-7", image: "6_7.png", desc: "Send someone to Space 6 or 7. 2nd draw: you go to 67!", type: "sixSeven" },
  // Extra turns / turn manipulation
  { id: 31, name: "Light Speed", image: "light_speed.png", desc: "Take 3 turns in a row!", type: "extraTurns", amount: 3 },
  { id: 32, name: "Nebula", image: "nebula.png", desc: "Take 2 more turns!", type: "extraTurns", amount: 2 },
  { id: 33, name: "U.F.O.", image: "ufo.png", desc: "Take 5 turns in a row!", type: "extraTurns", amount: 5 },
  { id: 34, name: "Time Loop", image: "time_loop.png", desc: "Repeat your last turn (same action and result)", type: "timeLoop" },
  { id: 35, name: "Rocket", image: "rocket.png", desc: "Go in front of the nearest person ahead of you", type: "rocketJump" },
  // Penalties
  { id: 36, name: "Space Gun", image: "space_gun.png", desc: "Your ship is down! Lose 2 turns", type: "loseTurns", amount: 2 },
  { id: 37, name: "Alien Space Army", image: "alien_space_army.png", desc: "Taken to jail! Lose 5 turns", type: "loseTurns", amount: 5 },
  // Special
  { id: 38, name: "Shield Generator", image: "shield_generator.png", desc: "Block anything for the next 3 rounds!", type: "shield" },
  { id: 39, name: "Space Suit", image: "space_suit.png", desc: "Double the effect of your next card!", type: "spaceSuit" },
  { id: 40, name: "Satellite", image: "satellite.png", desc: "Peek at next 5 cards and rearrange them", type: "satellite" },
  { id: 41, name: "Worm Hole", image: "worm_hole.png", desc: "Teleport! Swap positions with any opponent", type: "attack", action: "wormHole" },
];

export function getCard(id: number): CardDef | undefined {
  return CARD_DEFS.find((c) => c.id === id);
}

/** The pile holds the 41 uniques plus a SECOND copy of #30 "6-7". */
export const SC_DECK_SIZE = 42;
export const SC_SIX_SEVEN_ID = 30;
export const SC_CARD_BACK = "space_chase_back.png";
/** How many rounds (full table go-arounds) a Shield Generator lasts. */
export const SC_SHIELD_ROUNDS = 3;
/** How many deck cards a Satellite peeks at (fewer if the pile is short). */
export const SC_SATELLITE_PEEK = 5;

// ── Turn timer (lobby setting, host-only; 0 = off, the default) ──

export const SC_TURN_STEP_SECONDS = 15;
export const SC_TURN_MAX_SECONDS = 300;
export const SC_TURN_DEFAULT_SECONDS = 0;

export function isValidSpaceChaseTurnSeconds(v: unknown): v is number {
  return (
    typeof v === "number" &&
    Number.isInteger(v) &&
    v >= 0 &&
    v <= SC_TURN_MAX_SECONDS &&
    v % SC_TURN_STEP_SECONDS === 0
  );
}

// ── Prompt machine vocabulary ──

/**
 * What the room is waiting for. Synced, so a refreshed client re-opens
 * the right modal. "" only while the game is not running.
 */
export const ScAwait = {
  /** Current player chooses Roll or Draw. */
  ACTION: "ACTION",
  /** Pick exactly one seat (promptContext says which card step). */
  TARGET: "TARGET",
  /** Pick exactly `promptCount` distinct seats (Kraken "3 players"). */
  MULTI_TARGET: "MULTI_TARGET",
  /** Pick one of a small set of options (see ScChoice). */
  CHOICE: "CHOICE",
  /** Pick a board space 1..67 (Black Hole step 2). */
  SPACE: "SPACE",
  /** Reorder the private 5-card peek (drawer only). */
  SATELLITE: "SATELLITE",
} as const;
export type ScAwaitType = (typeof ScAwait)[keyof typeof ScAwait] | "";

/**
 * promptContext values - the sub-step of a multi-step card:
 *  "attack-target"     single-target attacks (Nuclear Bomb, Blaster, Alien
 *                      Pirate, Fighter Jet, Ion Space Bomb, Worm Hole)
 *  "blackhole-target"  -> "blackhole-space"
 *  "kraken-choice"     -> "kraken-one" (TARGET) | "kraken-three" (MULTI_TARGET)
 *  "star-choice"       -> "star-target"
 *  "sixseven-target"   -> "sixseven-space" (CHOICE between "6" and "7")
 */
export const ScPrompt = {
  ATTACK_TARGET: "attack-target",
  BLACKHOLE_TARGET: "blackhole-target",
  BLACKHOLE_SPACE: "blackhole-space",
  KRAKEN_CHOICE: "kraken-choice",
  KRAKEN_ONE: "kraken-one",
  KRAKEN_THREE: "kraken-three",
  STAR_CHOICE: "star-choice",
  STAR_TARGET: "star-target",
  SIXSEVEN_TARGET: "sixseven-target",
  SIXSEVEN_SPACE: "sixseven-space",
  SATELLITE: "satellite",
} as const;

/** CHOICE payload values, by promptContext. */
export const ScChoice = {
  KRAKEN_ONE: "one", // 1 person loses 3 turns
  KRAKEN_THREE: "three", // 3 people lose 1 turn
  STAR_SELF: "self", // go to The Star yourself
  STAR_SEND: "send", // send a player to The Star
  SIX: "6",
  SEVEN: "7",
} as const;

// ── Messages (client -> server; every payload is validated server-side) ──

export const SpaceChaseMsg = {
  /** Roll the die. Payload: {} */
  ROLL: "spacechase/roll",
  /** Draw the top card. Payload: {} */
  DRAW: "spacechase/draw",
  /** Answer a TARGET prompt. Payload: { seat: number } (seats[] index). */
  TARGET: "spacechase/target",
  /** Answer a MULTI_TARGET prompt. Payload: { seats: number[] } - exactly promptCount distinct live seats. */
  TARGETS: "spacechase/targets",
  /** Answer a CHOICE prompt. Payload: { choice: string } (an ScChoice value). */
  CHOICE: "spacechase/choice",
  /** Answer a SPACE prompt. Payload: { space: number } (integer 1..67). */
  SPACE: "spacechase/space",
  /** Answer the SATELLITE prompt. Payload: { order: number[] } - a permutation of indices 0..peek.length-1 (indices, not card ids: #30 is duplicated). order[0] = next card drawn. */
  SATELLITE: "spacechase/satellite",
  /** Lobby setting (host + lobby phase only). Payload: { turnSeconds: number }. */
  CONFIG: "spacechase/config",
} as const;

export interface ScTargetPayload {
  seat: number;
}
export interface ScTargetsPayload {
  seats: number[];
}
export interface ScChoicePayload {
  choice: string;
}
export interface ScSpacePayload {
  space: number;
}
export interface ScSatellitePayload {
  order: number[];
}
export interface ScConfigPayload {
  turnSeconds: number;
}

// ── Schema ──

/** Cap on the synced event log (old entries are dropped from the front). */
export const SC_EVENT_LOG_MAX = 60;

/**
 * One game event: drives the on-screen log and client animations.
 * `seq` is monotonically increasing for the whole game, so clients track
 * the last seq they animated and never replay after a refresh.
 * `a`/`b` are kind-specific details (e.g. move: from/to; roll: die value;
 * draw: card id; tiebreakRoll: seat's roll).
 */
export class SpaceChaseEvent extends Schema {
  @type("uint32") seq = 0;
  @type("string") kind = "";
  @type("int8") seat = -1;
  @type("int16") a = 0;
  @type("int16") b = 0;
  @type("string") text = "";
}

/** Event kinds (informal contract between room and view/tests). */
export const ScEvent = {
  ROLL: "roll",
  DRAW: "draw",
  RESHUFFLE: "reshuffle",
  MOVE: "move",
  TELEPORT: "teleport",
  ENTER_PORTAL: "enterPortal",
  EXIT_PORTAL: "exitPortal",
  COLLISION: "collision",
  SHIELD_BLOCK: "shieldBlock",
  SHIELD_ON: "shieldOn",
  SUIT_ON: "suitOn",
  LOSE_TURNS: "loseTurns",
  SKIP_TURN: "skipTurn",
  EXTRA_TURNS: "extraTurns",
  SWAP: "swap",
  SATELLITE: "satellite",
  NOOP: "noop",
  TIEBREAK_START: "tiebreakStart",
  TIEBREAK_ROLL: "tiebreakRoll",
  WIN: "win",
} as const;

/**
 * A seat in turn order (index into SpaceChaseState.seats). Seats persist
 * for the whole game even if the player leaves (gone = true), so the
 * final-results screen can show everyone.
 */
export class SpaceChaseSeat extends Schema {
  @type("string") sessionId = "";
  @type("string") nickname = "";
  /** Left for good: rocket removed from the board, skipped in rotation. */
  @type("boolean") gone = false;
  /** 0 = START, 1..67 = board, 68 = Finish. Entry mouth while in a portal. */
  @type("uint8") position = 0;
  /** 0 = not in a portal, else PortalDef.id (1..3). */
  @type("uint8") portalId = 0;
  /** 0..internal - how far along the tunnel. */
  @type("uint8") portalProgress = 0;
  /** true = entered at the `a` end (heading a->b). */
  @type("boolean") portalForward = true;
  /** Mouth # just exited (re-entry guard); 0 = none. Cleared at own turn start. */
  @type("uint8") justExitedPortal = 0;
  @type("uint8") lostTurns = 0;
  @type("uint8") extraTurns = 0;
  /** Shield active while state.roundNumber < this. 0 = no shield. */
  @type("uint16") shieldExpiresRound = 0;
  @type("boolean") spaceSuit = false;
  /** How many "6-7" cards this seat has drawn (2nd one -> Space 67). */
  @type("uint8") sixSevenCount = 0;
  /** Time Loop source: "" | "dice" | "card". */
  @type("string") lastActionType = "";
  /** dice: amount moved (already doubled if suited); card: card id. */
  @type("uint8") lastActionValue = 0;
  /**
   * PRIVATE (owner-only via StateView): the Satellite peek, next-draw
   * first. Non-empty only while this seat's SATELLITE prompt is open.
   */
  @view() @type(["uint8"]) peek = new ArraySchema<number>();
}

/** No fields beyond BasePlayer; per-seat game data lives in SpaceChaseSeat. */
@entity
export class SpaceChasePlayer extends BasePlayer {}

export class SpaceChaseState extends BaseState {
  /** Index = turn order (seat 0 = Player 1, goes first). */
  @type([SpaceChaseSeat]) seats = new ArraySchema<SpaceChaseSeat>();
  /** sessionId of the acting player ("" between games). */
  @type("string") currentTurn = "";
  /** seats[] index of the acting player. */
  @type("uint8") currentSeat = 0;
  /** Full table go-arounds completed (drives shield expiry). */
  @type("uint16") roundNumber = 0;
  /** Cards left in the draw pile (contents are server-only). */
  @type("uint8") deckCount = 0;
  @type("uint8") discardCount = 0;
  /** Most recently drawn card id (top of discard); 0 = none yet. */
  @type("uint8") lastCardId = 0;
  // Open prompt - ground truth so a refresh restores any open modal.
  @type("string") awaitingType = "";
  /** seats[] index that must answer (always the current player). */
  @type("uint8") promptSeat = 0;
  /** Card that opened the prompt (0 while awaiting ACTION). */
  @type("uint8") promptCardId = 0;
  /** Sub-step key (an ScPrompt value). */
  @type("string") promptContext = "";
  /** Space-Suit multiplier captured when the card was drawn (1 or 2). */
  @type("uint8") promptMult = 1;
  /** Required selection count for MULTI_TARGET. */
  @type("uint8") promptCount = 0;
  /** Step-1 target carried into step 2 (Black Hole / 6-7); -1 = none. */
  @type("int8") promptTargetSeat = -1;
  // Turn timer.
  @type("uint16") turnSeconds = SC_TURN_DEFAULT_SECONDS;
  /** Epoch ms; 0 = untimed or frozen (current player disconnected). */
  @type("float64") turnDeadline = 0;
  /** Rolling event log (see SpaceChaseEvent). */
  @type([SpaceChaseEvent]) events = new ArraySchema<SpaceChaseEvent>();
}
