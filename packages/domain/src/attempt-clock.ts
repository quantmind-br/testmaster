/**
 * The attempt clock: wall time minus the time spent waiting for the host to answer a model
 * request. A model call runs until the provider answers and is never cut by a timer, so the
 * wait for its answer must not consume the attempt deadline that bounds browser, HTTP and
 * terminal work. Waits may overlap; the clock is paused while at least one is pending.
 */
export interface Stopwatch {
  /** Milliseconds of attempt time since the stopwatch was created, paused time excluded. */
  elapsed(): number;
}
export class AttemptClock {
  private holds = 0;
  private heldSince = 0;
  private heldTotal = 0;
  private readonly watchers = new Set<() => void>();

  private held(): number {
    return this.heldTotal + (this.holds > 0 ? performance.now() - this.heldSince : 0);
  }
  /** Pauses the clock until the returned function is called (idempotent). */
  pause(): () => void {
    if (this.holds++ === 0) {
      this.heldSince = performance.now();
      for (const watcher of [...this.watchers]) watcher();
    }
    let released = false;
    return () => {
      if (released) return;
      released = true;
      if (--this.holds === 0) {
        this.heldTotal += performance.now() - this.heldSince;
        for (const watcher of [...this.watchers]) watcher();
      }
    };
  }
  /** Pauses the clock for the duration of `wait`, however it settles. */
  async during<T>(wait: () => Promise<T>): Promise<T> {
    const resume = this.pause();
    try {
      return await wait();
    } finally {
      resume();
    }
  }
  stopwatch(): Stopwatch {
    const started = performance.now();
    const heldAtStart = this.held();
    return { elapsed: () => performance.now() - started - (this.held() - heldAtStart) };
  }
  /**
   * Calls `onExpire` once `budgetMs` of attempt time has passed since now. The timer is
   * disarmed while the clock is paused and re-armed with the remaining time on resume.
   * Returns the function that cancels it.
   */
  deadline(budgetMs: number, onExpire: () => void): () => void {
    const watch = this.stopwatch();
    let timer: NodeJS.Timeout | undefined;
    let done = false;
    const stop = () => {
      done = true;
      clearTimeout(timer);
      timer = undefined;
      this.watchers.delete(rearm);
    };
    const rearm = () => {
      clearTimeout(timer);
      timer = undefined;
      if (done || this.holds > 0) return;
      const remaining = budgetMs - watch.elapsed();
      if (remaining <= 0) {
        stop();
        onExpire();
        return;
      }
      timer = setTimeout(rearm, remaining);
      timer.unref();
    };
    this.watchers.add(rearm);
    rearm();
    return stop;
  }
}
