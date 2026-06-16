/**
 * Paper.io engine types. Pure data - no Colyseus, no DOM. The engine is the
 * server-only source of truth; the room mirrors it into the synced schema.
 */

export type BotDifficulty = "easy" | "normal" | "hard" | "extreme";
export type WinMode = "target" | "timed";
export type BoardSizeKey = "small" | "medium" | "large";
export type SpeedKey = "slow" | "normal" | "fast";

/** How a round ended (the client summary turns this into a headline). */
export type Outcome =
  | "target" // a human reached the target share
  | "timed" // time ran out; the top human is the winner
  | "last_human" // every other human was eliminated
  | "bot_takeover" // a bot reached the target share (humans lose)
  | "wipeout" // every human was eliminated
  | "draw"; // a genuine tie

/**
 * One actor in the simulation. Humans occupy framework seats 0..7 (grid id =
 * seat + 1); bots are engine-owned, have seat = -1, an engine-assigned id from
 * a pool, a single life, and a colour seed for a fresh hue each spawn.
 */
export interface Actor {
  seat: number; // human framework seat, or -1 for a bot
  /** Grid owner value for this actor's cells (0 = empty). */
  id: number;
  isBot: boolean;
  difficulty: BotDifficulty;
  /** Hue source for rendering (bots get an ever-incrementing seed). */
  colorSeed: number;
  alive: boolean;
  dead: boolean;
  eliminated: boolean;
  deadUntilMs: number;
  lives: number;
  /** Disconnected human: do not move this tick (seat held by the framework). */
  frozen: boolean;
  x: number;
  y: number;
  fx: number;
  fy: number;
  heading: number;
  targetHeading: number;
  moving: boolean;
  dx: number;
  dy: number;
  botBudget: number;
  homeCx: number;
  homeCy: number;
  /** Current trail, as packed cell indices (y * cols + x). */
  trail: number[];
  trailSet: Set<number>;
  recent: number[];
  ai: BotAI;
}

export interface BotAI {
  mode: "rest" | "out" | "across" | "home";
  outDir?: [number, number];
  sideDir?: [number, number];
  legSide?: number;
  stepsLeft?: number;
  hunting?: boolean;
}

export type GameEventType = "claim" | "death" | "respawn" | "spawn" | "eliminated" | "endgame";

export interface GameEvent {
  type: GameEventType;
  /** Actor id involved (or -1). */
  id: number;
}

export interface EndResult {
  /** Winning human's framework seat, or null when no human won (draw/wipeout/takeover). */
  winnerSeat: number | null;
  outcome: Outcome;
}

/** A human player at the start of a round. */
export interface HumanConfig {
  seat: number;
}

export interface WorldOptions {
  cols: number;
  rows: number;
  /** Cells per second every actor moves at (the shared "speed" setting). */
  speedCellsPerSec: number;
  winMode: WinMode;
  /** Fraction of the board (0..1) to win in target mode. */
  targetThreshold: number;
  timedLimitMs: number;
  /** Starting lives for HUMAN players (bots always have 1). */
  humanLives: number;
  humans: HumanConfig[];
  /** Target bot population the engine maintains throughout the round. */
  botCount: number;
  botDifficulty: BotDifficulty;
  /** Hard cap on simultaneous bots (sizes the id pool). */
  maxBots: number;
}
