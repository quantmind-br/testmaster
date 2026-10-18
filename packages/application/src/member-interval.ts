/**
 * Suite pacing (`memberIntervalMs`): a member run of an admitted batch may start (be claimed) only
 * once its predecessor in batch order started at least `intervalMs` earlier. The predecessor is
 * frozen on the run at admission; chaining each member to its predecessor makes
 * `start(N+1) >= start(N) + interval` hold for the whole batch. The interval protects a stateful
 * target from bursts (login rate limits) and keeps ordered members ordered.
 */
export interface MemberIntervalState {
  /** The frozen interval; absent or 0 means no pacing. */
  intervalMs: number | undefined;
  /** Start of the predecessor's first attempt (ISO), null while it has none. */
  predecessorStartedAt: string | null;
  /** The predecessor reached a terminal phase. */
  predecessorCompleted: boolean;
  /** Epoch milliseconds, injected so the rule is deterministic under test. */
  now: number;
}

/**
 * A predecessor that ended without ever starting an attempt (blocked or cancelled while queued)
 * releases the chain, so one refused member never stalls the rest of the batch.
 */
export function memberIntervalReady(state: MemberIntervalState): boolean {
  if (!state.intervalMs || state.intervalMs <= 0) return true;
  if (state.predecessorStartedAt === null) return state.predecessorCompleted;
  const started = Date.parse(state.predecessorStartedAt);
  return !Number.isFinite(started) || state.now >= started + state.intervalMs;
}
