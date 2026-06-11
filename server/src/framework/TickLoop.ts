/**
 * TickLoop - opt-in fixed-timestep game loop for real-time games.
 *
 * Wraps Colyseus' setSimulationInterval with a fixed-step accumulator so
 * onTick always receives a constant dt (deterministic movement regardless
 * of timer jitter). Also implements the server-authoritative input
 * pattern: clients stream inputs, the server stores only the latest
 * (validated) input per player, and each tick consumes them.
 *
 * Usage (in onGameStart):
 *   this.loop = new TickLoop<ArenaInput>(this, { tickRate: 20, onTick: ... });
 *   this.loop.bindInput(ArenaMsg.INPUT, (raw) => sanitize(raw));
 *   this.loop.start();
 */
import type { Client, Room } from "colyseus";

export interface TickLoopOptions {
  /** Ticks per second (e.g. 20). */
  tickRate: number;
  /** Game logic step. dt is in SECONDS and always exactly 1/tickRate. */
  onTick: (dt: number, tick: number) => void;
}

export class TickLoop<TInput = unknown> {
  /** Latest validated input per sessionId; consumed by onTick. */
  readonly inputs = new Map<string, TInput>();

  private accumulatorMs = 0;
  private tickCount = 0;
  private running = false;

  constructor(
    private room: Room,
    private opts: TickLoopOptions
  ) {}

  start(): void {
    if (this.running) return;
    this.running = true;
    this.accumulatorMs = 0;
    const stepMs = 1000 / this.opts.tickRate;
    this.room.setSimulationInterval((deltaMs) => this.step(deltaMs), stepMs);
  }

  stop(): void {
    if (!this.running) return;
    this.running = false;
    // Calling without a callback clears the existing interval.
    this.room.setSimulationInterval(undefined);
  }

  /**
   * Register a message handler that validates and stores player input.
   * Return null from validate to discard a malformed/cheating payload.
   */
  bindInput(messageType: string, validate: (raw: unknown) => TInput | null): void {
    this.room.onMessage(messageType, (client: Client, raw: unknown) => {
      const input = validate(raw);
      if (input !== null) {
        this.inputs.set(client.sessionId, input);
      }
    });
  }

  /** Forget a player's input (call when they leave). */
  clearInput(sessionId: string): void {
    this.inputs.delete(sessionId);
  }

  private step(deltaMs: number): void {
    if (!this.running) return;
    const stepMs = 1000 / this.opts.tickRate;
    this.accumulatorMs += deltaMs;
    // Cap the backlog so a long stall doesn't cause a catch-up spiral.
    if (this.accumulatorMs > stepMs * 10) {
      this.accumulatorMs = stepMs * 10;
    }
    while (this.accumulatorMs >= stepMs) {
      this.accumulatorMs -= stepMs;
      this.tickCount += 1;
      this.opts.onTick(stepMs / 1000, this.tickCount);
    }
  }
}
