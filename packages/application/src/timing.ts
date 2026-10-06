import { readFileSync } from "node:fs";
import type { RuntimeTiming } from "@testmaster/contracts";
import type { Clock } from "@testmaster/domain";

// hrtime is process-independent on this Linux host; boot identity forbids subtraction across reboot.
export const runtimeClock: Clock = {
  utcNow: () => new Date().toISOString(),
  monotonicMs: () => Number(process.hrtime.bigint()) / 1_000_000,
};
export const clockDomain = readFileSync("/proc/sys/kernel/random/boot_id", "utf8").trim();
type Boundary = RuntimeTiming["boundaries"][number];
export function timingBoundary(phase: Boundary["phase"], clock: Clock = runtimeClock): Boundary {
  return { phase, occurredAt: clock.utcNow(), monotonicMs: clock.monotonicMs() };
}
export class RuntimeTimer {
  readonly boundaries: Boundary[] = [];
  constructor(
    readonly clock: Clock = runtimeClock,
    readonly domain = clockDomain,
    queued?: { clockDomain: string; boundary: Boundary },
  ) {
    if (queued?.clockDomain === domain) this.boundaries.push(queued.boundary);
    this.mark("preparing");
  }
  mark(phase: Boundary["phase"]): void {
    if (this.boundaries.at(-1)?.phase === phase) return;
    const boundary = timingBoundary(phase, this.clock);
    if (boundary.monotonicMs < (this.boundaries.at(-1)?.monotonicMs ?? 0))
      throw new Error("Monotonic clock regressed");
    this.boundaries.push(boundary);
  }
  snapshot(): RuntimeTiming {
    const duration = (phase: Boundary["phase"]) => {
      const index = this.boundaries.findIndex((value) => value.phase === phase);
      if (index < 0) return null;
      const current = this.boundaries[index];
      const next = this.boundaries[index + 1];
      return next && current ? next.monotonicMs - current.monotonicMs : null;
    };
    const first = this.boundaries[0],
      last = this.boundaries.at(-1);
    return {
      source: "monotonic",
      clockDomain: this.domain,
      boundaries: [...this.boundaries],
      queueDuration: duration("queued"),
      preparationDuration: duration("preparing"),
      executionDuration: duration("running"),
      collectionDuration: duration("collecting"),
      analysisDuration: duration("analyzing"),
      wallClockDuration:
        first?.phase === "queued" && last?.phase === "completed"
          ? last.monotonicMs - first.monotonicMs
          : null,
      analysisStatus: this.boundaries.some((value) => value.phase === "analyzing")
        ? "measured"
        : "not_requested",
    };
  }
}
export function sumTimings(timings: readonly RuntimeTiming[]): Omit<
  RuntimeTiming,
  "boundaries" | "clockDomain"
> & {
  boundaries: Boundary[];
  clockDomain: string;
} {
  const sum = (
    key:
      | "queueDuration"
      | "preparationDuration"
      | "executionDuration"
      | "collectionDuration"
      | "analysisDuration"
      | "wallClockDuration",
  ) => {
    if (!timings.length) return null;
    const applicable =
      key === "queueDuration" || key === "wallClockDuration" ? timings.slice(0, 1) : timings;
    return applicable.every((value) => value[key] !== null)
      ? applicable.reduce((n, value) => n + (value[key] ?? 0), 0)
      : null;
  };
  const first = timings[0]?.boundaries[0];
  const last = timings.at(-1)?.boundaries.at(-1);
  const domain = timings[0]?.clockDomain;
  return {
    source: "monotonic",
    clockDomain: [...new Set(timings.map((value) => value.clockDomain))].join(","),
    boundaries: timings.flatMap((value) => value.boundaries),
    queueDuration: sum("queueDuration"),
    preparationDuration: sum("preparationDuration"),
    executionDuration: sum("executionDuration"),
    collectionDuration: sum("collectionDuration"),
    analysisDuration: sum("analysisDuration"),
    wallClockDuration:
      first?.phase === "queued" &&
      last?.phase === "completed" &&
      timings.every((value) => value.clockDomain === domain)
        ? last.monotonicMs - first.monotonicMs
        : null,
    analysisStatus: timings.some((value) => value.analysisStatus === "measured")
      ? "measured"
      : "not_requested",
  };
}
