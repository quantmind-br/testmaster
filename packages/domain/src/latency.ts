/** Nearest-rank percentile of an ascending list; null for an empty list. */
export function percentile(sortedAscending: readonly number[], q: number): number | null {
  if (sortedAscending.length === 0) return null;
  if (!(q > 0 && q <= 100)) throw new RangeError("Percentile must be in (0, 100]");
  const rank = Math.ceil((q / 100) * sortedAscending.length);
  return sortedAscending[Math.min(sortedAscending.length, Math.max(1, rank)) - 1] ?? null;
}

export interface LatencySummary {
  readonly count: number;
  readonly minMs: number | null;
  readonly meanMs: number | null;
  readonly p50Ms: number | null;
  readonly p95Ms: number | null;
  readonly p99Ms: number | null;
  readonly maxMs: number | null;
}

/** Rounds to microsecond precision so recorded measurements stay stable and compact. */
export const roundMillis = (value: number | null): number | null =>
  value === null ? null : Math.round(value * 1000) / 1000;

/** Count, mean, extremes and the nearest-rank p50, p95 and p99 of unsorted samples. */
export function summarizeLatencies(values: readonly number[]): LatencySummary {
  const sorted = [...values].sort((a, b) => a - b);
  const mean = sorted.length ? sorted.reduce((sum, value) => sum + value, 0) / sorted.length : null;
  return {
    count: sorted.length,
    minMs: roundMillis(sorted[0] ?? null),
    meanMs: roundMillis(mean),
    p50Ms: roundMillis(percentile(sorted, 50)),
    p95Ms: roundMillis(percentile(sorted, 95)),
    p99Ms: roundMillis(percentile(sorted, 99)),
    maxMs: roundMillis(sorted.at(-1) ?? null),
  };
}

/**
 * Smallest sample count at which the tool reports a percentile as a measurement: the tail beyond
 * the percentile must hold at least five samples (p95 needs 100, p99 needs 500). The specification
 * only says that 20 samples do not support a robust percentile; this is the tool's own rule and is
 * written into every result.
 */
export function minimumSamples(q: number): number {
  if (!(q > 0 && q < 100)) throw new RangeError("Percentile must be in (0, 100)");
  return Math.ceil(5 / (1 - q / 100));
}
