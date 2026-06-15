/**
 * Paper.io engine types. Pure data - no Colyseus, no DOM. The engine is the
 * server-only source of truth; the room mirrors it into the synced schema.
 */

export type BotDifficulty = "easy" | "normal" | "hard" | "extreme";
export type WinMode = "target" | "timed";
export type BoardSizeKey = "small" | "medium" | "large";
export type SpeedKey = "slow" | "normal" | "fast";

/** One player or bot in the simulation. Seat === framework seat (0..7). */
export interface Actor {
  seat: number;
  /** Grid owner value for this actor's cells (seat + 1; 0 = empty). */
  id: number;
  isBot: boolean;
  difficulty: BotDifficulty;
  /** On the board and playable. */
  alive: boolean;
  /** In the short death pause before respawn/elimination. */
  dead: boolean;
  /** Out for good (ran out of lives). */
  eliminated: boolean;
  /** Engine-clock ms at which the death pause ends. */
  deadUntilMs: number;
  lives: number;
  /** Disconnected human: do not move this tick (seat held by the framework). */
  frozen: boolean;
  /** Integer cell the head occupies. */
  x: number;
  y: number;
  /** Float position (cells) for smooth continuous movement / rendering. */
  fx: number;
  fy: number;
  heading: number;
  targetHeading: number;
  moving: boolean;
  /** Cardinal step for bots. */
  dx: number;
  dy: number;
  /** Accumulated movement budget so bots step at the shared cell speed. */
  botBudget: number;
  homeCx: number;
  homeCy: number;
  /** Current trail, as packed cell indices (y * cols + x). */
  trail: number[];
  trailSet: Set<number>;
  /** Most recently laid trail cells (SELF_GRACE window) that don't kill you. */
  recent: number[];
  ai: BotAI;
}

export interface BotAI {
  mode: "rest" | "out" | "across" | "home";
  outDir?: [number, number];
  sideDir?: [number, number];
  legSide?: number;
  stepsLeft?: number;
  /** This excursion is an aggressive push toward a rival. */
  hunting?: boolean;
}

export type GameEventType = "claim" | "death" | "respawn" | "eliminated" | "endgame";

export interface GameEvent {
  type: GameEventType;
  seat: number;
  /** death: who caused it (or null for self/squeeze). */
  killerSeat?: number | null;
  /** endgame: why + winner. */
  reason?: EndReasonKind;
  winnerSeat?: number | null;
}

export type EndReasonKind = "target" | "timed" | "survivor" | "allout";

export interface EndResult {
  reason: EndReasonKind;
  /** null = draw (a tie in timed mode). */
  winnerSeat: number | null;
}

export interface SeatConfig {
  seat: number;
  isBot: boolean;
  difficulty: BotDifficulty;
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
  /** Starting lives for every actor. */
  lives: number;
  seats: SeatConfig[];
}
