/**
 * TurnManager - opt-in turn handling for turn-based games.
 *
 * The game owns it: create one in onGameStart(), call start() with the
 * seat order, advance with next(), and guard move handlers with isTurn().
 * The manager only calls back - the game writes "whose turn it is" into
 * its own synced state inside onTurnChange.
 *
 * Disconnect handling: wire the BaseGameRoom hooks -
 *   onPlayerDropped(p)     -> turns.pause()  (if p is the current player)
 *   onPlayerReconnected(p) -> turns.resume()
 *   onPlayerLeftForGood(p) -> turns.remove(p.sessionId)
 * so a reconnecting player doesn't lose their turn to the clock.
 */
import type { Room } from "colyseus";
import type { Delayed } from "@colyseus/timer";

export interface TurnManagerOptions {
  /** Per-turn time limit in seconds. Omit for untimed turns. */
  turnSeconds?: number;
  /** Called whenever the turn changes (including the first turn). */
  onTurnChange: (sessionId: string) => void;
  /** Called when the current player's clock runs out. Default: next(). */
  onTimeout?: (sessionId: string) => void;
}

export class TurnManager {
  private order: string[] = [];
  private index = 0;
  private timer?: Delayed;
  /** Milliseconds left on the paused clock, or undefined if not paused. */
  private pausedRemainingMs?: number;
  private timerStartedAt = 0;
  private active = false;

  constructor(
    private room: Room,
    private opts: TurnManagerOptions
  ) {}

  /** Begin turn-taking. order = sessionIds, first entry goes first. */
  start(order: string[]): void {
    if (order.length === 0) return;
    this.order = [...order];
    this.index = 0;
    this.active = true;
    this.beginTurn();
  }

  /** The sessionId whose turn it is (undefined before start/after stop). */
  current(): string | undefined {
    return this.active ? this.order[this.index] : undefined;
  }

  /** Guard helper for move handlers. */
  isTurn(sessionId: string): boolean {
    return this.active && this.current() === sessionId;
  }

  /** Advance to the next player in order. */
  next(): void {
    if (!this.active || this.order.length === 0) return;
    this.index = (this.index + 1) % this.order.length;
    this.beginTurn();
  }

  /**
   * Remove a player (left for good). If it was their turn, play passes to
   * the next player immediately.
   */
  remove(sessionId: string): void {
    const i = this.order.indexOf(sessionId);
    if (i === -1) return;
    const wasCurrent = this.active && i === this.index;
    this.order.splice(i, 1);
    if (this.order.length === 0) {
      this.stop();
      return;
    }
    if (i < this.index || this.index >= this.order.length) {
      this.index = this.index === 0 ? this.order.length - 1 : this.index - 1;
    }
    if (wasCurrent) {
      this.index = (this.index + 1) % this.order.length;
      this.beginTurn();
    }
  }

  /** Freeze the turn clock (current player disconnected). */
  pause(): void {
    if (!this.timer || this.pausedRemainingMs !== undefined) return;
    const elapsed = this.room.clock.currentTime - this.timerStartedAt;
    const total = (this.opts.turnSeconds ?? 0) * 1000;
    this.pausedRemainingMs = Math.max(0, total - elapsed);
    this.clearTimer();
  }

  /** Resume a paused turn clock with the time that was left. */
  resume(): void {
    if (this.pausedRemainingMs === undefined || !this.active) return;
    const remaining = this.pausedRemainingMs;
    this.pausedRemainingMs = undefined;
    this.scheduleTimeout(remaining);
  }

  /** Stop turn-taking entirely (game over). */
  stop(): void {
    this.active = false;
    this.pausedRemainingMs = undefined;
    this.clearTimer();
  }

  private beginTurn(): void {
    this.pausedRemainingMs = undefined;
    this.clearTimer();
    const sessionId = this.order[this.index]!;
    this.opts.onTurnChange(sessionId);
    if (this.opts.turnSeconds) {
      this.scheduleTimeout(this.opts.turnSeconds * 1000);
    }
  }

  private scheduleTimeout(ms: number): void {
    this.clearTimer();
    this.timerStartedAt = this.room.clock.currentTime;
    this.timer = this.room.clock.setTimeout(() => {
      const sessionId = this.current();
      if (sessionId === undefined) return;
      if (this.opts.onTimeout) {
        this.opts.onTimeout(sessionId);
      } else {
        this.next();
      }
    }, ms);
  }

  private clearTimer(): void {
    this.timer?.clear();
    this.timer = undefined;
  }
}
