// Scheduler abstraction so disconnect/turn-timeout logic is testable without
// real wall-clock timers. Production uses RealScheduler; tests use ManualScheduler.

export type TimerHandle = number;

export interface Scheduler {
  schedule(ms: number, fn: () => void): TimerHandle;
  cancel(handle: TimerHandle): void;
  now(): number;
}

export class RealScheduler implements Scheduler {
  private handles = new Map<number, ReturnType<typeof setTimeout>>();
  private next = 1;
  schedule(ms: number, fn: () => void): TimerHandle {
    const id = this.next++;
    this.handles.set(
      id,
      setTimeout(() => {
        this.handles.delete(id);
        fn();
      }, ms),
    );
    return id;
  }
  cancel(handle: TimerHandle): void {
    const t = this.handles.get(handle);
    if (t) {
      clearTimeout(t);
      this.handles.delete(handle);
    }
  }
  now(): number {
    return Date.now();
  }
}

/** Deterministic scheduler: timers fire only when advance()/flush() is called. */
export class ManualScheduler implements Scheduler {
  private clock = 0;
  private next = 1;
  private timers = new Map<TimerHandle, { at: number; fn: () => void }>();
  schedule(ms: number, fn: () => void): TimerHandle {
    const id = this.next++;
    this.timers.set(id, { at: this.clock + ms, fn });
    return id;
  }
  cancel(handle: TimerHandle): void {
    this.timers.delete(handle);
  }
  now(): number {
    return this.clock;
  }
  /** Advance the clock by ms, firing any timers due (in order). */
  advance(ms: number): void {
    this.clock += ms;
    for (;;) {
      const due = [...this.timers.entries()]
        .filter(([, t]) => t.at <= this.clock)
        .sort((a, b) => a[1].at - b[1].at);
      if (due.length === 0) break;
      const [id, t] = due[0];
      this.timers.delete(id);
      t.fn();
    }
  }
  /** Fire all pending timers regardless of time. */
  flush(): void {
    this.advance(Number.MAX_SAFE_INTEGER - this.clock);
  }
}
