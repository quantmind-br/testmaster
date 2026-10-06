import { type Static, Type } from "@sinclair/typebox";
import { Enum, Nonnegative, Obj, Timestamp } from "./primitives.js";

export const RatioMetric = Obj({
  numerator: Nonnegative,
  denominator: Type.Union([Nonnegative, Type.Null()]),
  denominatorState: Enum(["known", "unknown"]),
  state: Enum(["available", "notApplicable", "insufficientData"]),
  value: Type.Union([Type.Number({ minimum: 0, maximum: 1 }), Type.Null()]),
  definition: Type.String(),
  scope: Type.String(),
});
export const CoverageMetrics = Obj({
  requirement: RatioMetric,
  route: RatioMetric,
  operation: RatioMetric,
  code: RatioMetric,
  execution: RatioMetric,
});
export const ExecutionMetrics = Obj({
  counts: Type.Record(Type.String(), Nonnegative),
  rates: Type.Record(Type.String(), RatioMetric),
  exclusions: Type.Record(Type.String(), Nonnegative),
  blockedReasons: Type.Record(Type.String(), Nonnegative),
  retryPolicy: Type.String(),
});
const Duration = Type.Union([Type.Number({ minimum: 0 }), Type.Null()]);
export const RuntimeTiming = Obj({
  source: Type.Literal("monotonic"),
  clockDomain: Type.String(),
  boundaries: Type.Array(
    Obj({
      phase: Enum(["queued", "preparing", "running", "collecting", "analyzing", "completed"]),
      occurredAt: Timestamp,
      monotonicMs: Type.Number({ minimum: 0 }),
    }),
  ),
  queueDuration: Duration,
  preparationDuration: Duration,
  executionDuration: Duration,
  collectionDuration: Duration,
  analysisDuration: Duration,
  wallClockDuration: Duration,
  analysisStatus: Enum(["not_requested", "measured", "insufficientData"]),
});
export type RatioMetric = Static<typeof RatioMetric>;
export type CoverageMetrics = Static<typeof CoverageMetrics>;
export type ExecutionMetrics = Static<typeof ExecutionMetrics>;
export type RuntimeTiming = Static<typeof RuntimeTiming>;
