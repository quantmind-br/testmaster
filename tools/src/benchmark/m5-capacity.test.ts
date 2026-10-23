import { canonicalJson, sha256 } from "@testmaster/domain";
import { describe, expect, it } from "vitest";
import type { EvidenceReader } from "./distributed-stack.js";
import {
  type AdmissionSample,
  type AuditRow,
  absentPhase,
  aggregateTimings,
  auditEvidence,
  auditRuns,
  classifyAdmission,
  cpuCoresSeries,
  decomposeRuns,
  describeFailure,
  duplicateFirings,
  errorLogLines,
  executionBound,
  type FrozenAttempt,
  gateFailedPasses,
  growthPerRun,
  judgeBackpressure,
  judgeChecks,
  judgeFrozenAttempts,
  judgeGateFailedPasses,
  judgeP95,
  judgeSoak,
  linearSlope,
  outageSummary,
  parseArguments,
  passedAttempts,
  type ResourcePoint,
  retryableReason,
  runsPerMinute,
  summarizeAdmissions,
  summarizeDrift,
  summarizePercentiles,
  summarizeResources,
  unexpectedAnswers,
  verifyEvidenceBundle,
  wallTimes,
} from "./m5-capacity.js";
import { isSessionExpired } from "./server-load-stack.js";

const ramp = (count: number) => Array.from({ length: count }, (_, index) => index + 1);

describe("percentile gating by sample size", () => {
  it("withholds every percentile that the sample count cannot support", () => {
    const few = summarizePercentiles(ramp(30));
    expect(few.p50).not.toBeNull();
    expect(few.p90).not.toBeNull();
    expect(few.p95).toBeNull();
    expect(few.p99).toBeNull();
    expect(few.withheld.p95).toContain("100");
    expect(few.withheld.p99).toContain("500");
  });

  it("reports p95 from n=100 and p99 only from n=500, with nearest-rank values", () => {
    const hundred = summarizePercentiles(ramp(100));
    expect(hundred.p95).toBe(95);
    expect(hundred.p99).toBeNull();
    const fiveHundred = summarizePercentiles(ramp(500));
    expect(fiveHundred.p99).toBe(495);
    expect(fiveHundred.withheld).toEqual({});
  });

  it("states n and treats an empty sample as no data, not zero", () => {
    const none = summarizePercentiles([]);
    expect(none.n).toBe(0);
    expect(none.p50).toBeNull();
    expect(none.mean).toBeNull();
    expect(summarizePercentiles([5, 1, 3]).p50).toBe(3);
  });

  it("does not let a p95 withheld for lack of samples become a pass", () => {
    expect(judgeP95(summarizePercentiles(ramp(50)), 1000).verdict).toBe("not measured");
    expect(judgeP95(summarizePercentiles(ramp(100)), 1000).verdict).toBe("met");
    expect(judgeP95(summarizePercentiles(ramp(100)), 50).verdict).toBe("not met");
    expect(judgeP95(summarizePercentiles(ramp(100)), 1000, 1).verdict).toBe("not met");
  });

  it("decides not met from a handful of samples when every one already exceeds the limit", () => {
    expect(judgeP95(summarizePercentiles([900, 950, 1000, 1100, 1200]), 800).verdict).toBe(
      "not met",
    );
    expect(judgeP95(summarizePercentiles([]), 800, 6).verdict).toBe("not met");
  });
});

describe("verdict derivation", () => {
  it("is not met when any invariant failed, even if another was not observed", () => {
    const verdict = judgeChecks([
      { name: "a", ok: true, detail: "fine" },
      { name: "b", ok: null, detail: "unobserved" },
      { name: "c", ok: false, detail: "duplicate firing" },
    ]);
    expect(verdict.verdict).toBe("not met");
    expect(verdict.reason).toContain("c: duplicate firing");
    expect(verdict.reason).not.toContain("unobserved");
  });

  it("is not measured, never met, when an invariant could not be observed", () => {
    expect(
      judgeChecks([
        { name: "a", ok: true, detail: "" },
        { name: "b", ok: null, detail: "no lease held" },
      ]).verdict,
    ).toBe("not measured");
    expect(judgeChecks([{ name: "a", ok: true, detail: "" }]).verdict).toBe("met");
  });

  const soak = {
    requestedSeconds: 1800,
    actualSeconds: 1801,
    runs: 400,
    nonPassedRuns: 0,
    unresolvedRuns: 0,
    apiErrors: 0,
    violations: 0,
    containerRestarts: 0,
  };

  it("judges a clean soak met and names what broke a failed one", () => {
    expect(judgeSoak(soak).verdict).toBe("met");
    for (const [field, value] of [
      ["apiErrors", 1],
      ["nonPassedRuns", 2],
      ["unresolvedRuns", 1],
      ["violations", 1],
      ["containerRestarts", 1],
      ["actualSeconds", 900],
    ] as const)
      expect(judgeSoak({ ...soak, [field]: value }).verdict, field).toBe("not met");
  });

  it("does not call a soak without completed Runs met", () => {
    expect(judgeSoak({ ...soak, runs: 0 }).verdict).toBe("not measured");
  });
});

describe("growth and drift", () => {
  it("fits a slope per second and refuses to fit fewer than three points", () => {
    const line = ramp(10).map((n) => ({ atSeconds: n * 10, value: 100 + 2 * n * 10 }));
    expect(linearSlope(line)).toBeCloseTo(2, 9);
    expect(linearSlope(line.slice(0, 2))).toBeNull();
    expect(linearSlope(ramp(5).map((n) => ({ atSeconds: 7, value: n })))).toBeNull();
  });

  it("reports the slope per hour from after the warm-up and keeps the warm-up in the extremes", () => {
    const warmup = { atSeconds: 0, value: 1000 };
    const steady = ramp(20).map((n) => ({ atSeconds: n * 60, value: 50 + n }));
    const drift = summarizeDrift([warmup, ...steady]);
    expect(drift.max).toBe(1000);
    expect(drift.first).toBe(1000);
    expect(drift.last).toBe(70);
    // 1 unit per minute, so 60 per hour once the warm-up point is excluded.
    expect(drift.slopePerHour).toBeCloseTo(60, 6);
    expect(summarizeDrift([]).slopePerHour).toBeNull();
  });

  it("divides growth by the Runs completed in between and abstains when none completed", () => {
    expect(growthPerRun(1000, 5000, 10, 50)).toBe(100);
    expect(growthPerRun(1000, 5000, 10, 10)).toBeNull();
    expect(growthPerRun(null, 5000, 10, 50)).toBeNull();
    expect(runsPerMinute(30, 60_000)).toBe(30);
    expect(runsPerMinute(30, 0)).toBeNull();
  });

  it("turns cumulative CPU seconds into average cores per interval, skipping unreadable readings", () => {
    const series = cpuCoresSeries([
      { atSeconds: 0, cpuSeconds: 0 },
      { atSeconds: 10, cpuSeconds: 5 },
      { atSeconds: 20, cpuSeconds: null },
      { atSeconds: 30, cpuSeconds: 35 },
    ]);
    expect(series).toEqual([
      { atSeconds: 5, value: 0.5 },
      { atSeconds: 20, value: 1.5 },
    ]);
  });

  it("derives storage growth per completed Run from the first and last bucket readings", () => {
    const point = (
      atSeconds: number,
      runsCompleted: number,
      bucketBytes: number | null,
      bucketObjects: number | null,
    ): ResourcePoint => ({
      atSeconds,
      containers: { server: { cpuSeconds: atSeconds / 2, memoryBytes: 100, anonBytes: 60 } },
      postgresBytes: 1_000_000 + runsCompleted * 500,
      bucketBytes,
      bucketObjects,
      runsCompleted,
    });
    const summary = summarizeResources([
      point(0, 0, 1000, 10),
      point(15, 5, null, null),
      point(30, 20, 21_000, 110),
      point(45, 40, 41_000, 210),
    ]);
    expect(summary.storageGrowth.bytesPerCompletedRun).toBe(1000);
    expect(summary.storageGrowth.objectsPerCompletedRun).toBe(5);
    expect(summary.storageGrowth.postgresBytesPerCompletedRun).toBe(500);
    expect(summary.containers.server?.cpuCores.last).toBeCloseTo(0.5, 9);
  });
});

describe("refusal accounting", () => {
  const rateLimited = (details: Record<string, unknown>) => ({
    error: { code: "RATE_LIMITED", details },
  });

  it("tells each documented refusal apart from a crash", () => {
    expect(classifyAdmission(202, { data: { runId: "run_1" } })).toBe("accepted");
    expect(classifyAdmission(429, rateLimited({ reason: "queue_overflow", limit: 1000 }))).toBe(
      "queue_overflow",
    );
    expect(classifyAdmission(429, rateLimited({ scope: "actor" }))).toBe("actor_rate_limited");
    expect(classifyAdmission(429, rateLimited({ scope: "tenant" }))).toBe("tenant_rate_limited");
    expect(classifyAdmission(429, rateLimited({}))).toBe("rate_limited_other");
    expect(
      classifyAdmission(412, {
        error: { code: "PRECONDITION_FAILED", message: "No live worker is available" },
      }),
    ).toBe("no_live_worker");
    expect(classifyAdmission(403, { error: { code: "FORBIDDEN" } })).toBe("refused_other");
    expect(classifyAdmission(503, null)).toBe("server_error");
    expect(
      classifyAdmission(503, {
        error: { code: "UNAVAILABLE", details: { reasonCode: "storage_unavailable" } },
      }),
    ).toBe("storage_unavailable");
    expect(
      classifyAdmission(503, { error: { code: "UNAVAILABLE", details: { reasonCode: "other" } } }),
    ).toBe("server_error");
    expect(classifyAdmission(500, { error: { code: "INTERNAL" } })).toBe("server_error");
    expect(
      classifyAdmission(503, {
        error: { code: "INTERNAL", details: { reasonCode: "storage_unavailable" } },
      }),
    ).toBe("server_error");
    expect(classifyAdmission(null, null)).toBe("transport_error");
  });

  it("tells a server's own retryable envelope from a proxy error and from a crash", () => {
    const writerBusy = {
      error: {
        code: "UNAVAILABLE",
        retryable: true,
        details: { reasonCode: "writer_contention", retryable: true },
      },
    };
    expect(classifyAdmission(503, writerBusy)).toBe("retryable_refusal");
    expect(retryableReason(writerBusy)).toBe("writer_contention");
    expect(retryableReason({ error: { code: "UNAVAILABLE", retryable: true } })).toBe(
      "UNAVAILABLE",
    );
    // Not retryable, or no envelope at all (a proxy's own 502/503): still a crash symptom.
    expect(classifyAdmission(503, { error: { code: "UNAVAILABLE", retryable: false } })).toBe(
      "server_error",
    );
    expect(classifyAdmission(502, null)).toBe("server_error");
    expect(retryableReason(null)).toBeNull();
    expect(retryableReason({ error: { code: "INTERNAL" } })).toBeNull();
    // The storage outage keeps its own outcome even though its envelope is retryable too.
    expect(
      classifyAdmission(503, {
        error: {
          code: "UNAVAILABLE",
          retryable: true,
          details: { reasonCode: "storage_unavailable" },
        },
      }),
    ).toBe("storage_unavailable");
  });

  const sample = (
    outcome: AdmissionSample["outcome"],
    extra: Partial<AdmissionSample> = {},
  ): AdmissionSample => ({
    outcome,
    status:
      outcome === "accepted"
        ? 202
        : outcome === "server_error" ||
            outcome === "storage_unavailable" ||
            outcome === "retryable_refusal"
          ? 503
          : 429,
    ms: 10,
    retryAfter:
      outcome !== "accepted" &&
      outcome !== "server_error" &&
      outcome !== "storage_unavailable" &&
      outcome !== "retryable_refusal",
    queued: null,
    limit: null,
    atMs: 0,
    reasonCode: null,
    detail: null,
    ...extra,
  });

  it("counts refusals and crashes separately and records the queue depth the server reported", () => {
    const tally = summarizeAdmissions([
      sample("accepted", { queued: 999, limit: 1000 }),
      sample("queue_overflow", { queued: 1000, limit: 1000 }),
      sample("queue_overflow", { queued: 1000, limit: 1000 }),
      sample("actor_rate_limited"),
      sample("server_error"),
      sample("transport_error", { status: null }),
    ]);
    expect(tally.requests).toBe(6);
    expect(tally.refusals).toBe(3);
    expect(tally.crashes).toBe(2);
    expect(tally.byOutcome.queue_overflow).toBe(2);
    expect(tally.byStatus).toEqual({ "202": 1, "429": 3, "503": 1, error: 1 });
    expect(tally.maxQueuedReported).toBe(1000);
    expect(tally.queueLimitReported).toBe(1000);
    expect(tally.refusalsWithRetryAfter).toBe(3);
  });

  it("counts designed retryable refusals by reason and keeps them out of crashes and refusals", () => {
    const tally = summarizeAdmissions([
      sample("accepted"),
      sample("retryable_refusal", { reasonCode: "writer_contention" }),
      sample("retryable_refusal", { reasonCode: "writer_contention" }),
      sample("retryable_refusal", { reasonCode: "database_unavailable" }),
      sample("server_error"),
    ]);
    expect(tally.retryableRefusals).toBe(3);
    expect(tally.retryableReasons).toEqual({ writer_contention: 2, database_unavailable: 1 });
    expect(tally.crashes).toBe(1);
    expect(tally.refusals).toBe(0);
    const bound = [sample("accepted"), sample("queue_overflow", { limit: 1000, queued: 1000 })];
    expect(
      judgeBackpressure(
        summarizeAdmissions([
          ...bound,
          sample("retryable_refusal", { reasonCode: "writer_contention" }),
        ]),
        true,
      ).verdict,
    ).toBe("met");
  });

  it("counts the designed storage_unavailable refusal apart from refusals of capacity and from crashes", () => {
    const tally = summarizeAdmissions([
      sample("accepted"),
      sample("storage_unavailable"),
      sample("storage_unavailable"),
      sample("server_error"),
    ]);
    expect(tally.storageUnavailable).toBe(2);
    expect(tally.crashes).toBe(1);
    expect(tally.refusals).toBe(0);
    expect(tally.refusalsWithRetryAfter).toBe(0);
  });

  it("judges backpressure met only at the bound, with Retry-After and no crash", () => {
    const at = (samples: AdmissionSample[]) => summarizeAdmissions(samples);
    const bound = [sample("accepted"), sample("queue_overflow", { limit: 1000, queued: 1000 })];
    expect(judgeBackpressure(at(bound), true).verdict).toBe("met");
    expect(judgeBackpressure(at([...bound, sample("server_error")]), true).verdict).toBe("not met");
    expect(judgeBackpressure(at(bound), false).verdict).toBe("not met");
    expect(
      judgeBackpressure(at([...bound, sample("queue_overflow", { retryAfter: false })]), true)
        .verdict,
    ).toBe("not met");
    expect(
      judgeBackpressure(at([sample("accepted"), sample("actor_rate_limited")]), true).verdict,
    ).toBe("not measured");
  });
});

const row = (overrides: Partial<AuditRow>): AuditRow => ({
  runId: "run_1",
  runCreatedAt: "2026-01-01T00:00:00.000Z",
  runPhase: "completed",
  runOutcome: "passed",
  runGate: "passed",
  attemptId: "att_1",
  attemptNumber: 1,
  workerId: "wrk_1",
  attemptPhase: "completed",
  attemptOutcome: "passed",
  endedAt: "2026-01-01T00:00:01.000Z",
  ...overrides,
});

describe("run audit and duplicate detection", () => {
  it("accepts a retried Run whose last Attempt passed and counts it as retried", () => {
    const audit = auditRuns([
      row({ attemptId: "att_1", attemptNumber: 1, attemptOutcome: "infrastructure_error" }),
      row({ attemptId: "att_2", attemptNumber: 2 }),
    ]);
    expect(audit.violations).toEqual([]);
    expect(audit.retriedRuns).toBe(1);
    expect(audit.byOutcome).toEqual({ passed: 1 });
  });

  it("flags a result nothing supports and an Attempt claimed twice", () => {
    const rules = (rows: AuditRow[]) => auditRuns(rows).violations.map((v) => v.rule);
    expect(rules([row({ attemptOutcome: "failed" })])).toEqual(["passed_without_passed_attempt"]);
    expect(
      rules([
        row({ attemptId: "att_1", attemptNumber: 1 }),
        row({ attemptId: "att_2", attemptNumber: 2 }),
      ]),
    ).toEqual(["multiple_passed_attempts", "passed_attempt_superseded"]);
    expect(rules([row({ attemptPhase: "running", attemptOutcome: null })])).toEqual([
      "passed_without_passed_attempt",
      "completed_run_with_open_attempt",
    ]);
  });

  it("lists Runs that are not completed as unresolved rather than judging them", () => {
    const audit = auditRuns([row({ runId: "run_9", runPhase: "running", runOutcome: null })]);
    expect(audit.unresolved).toEqual(["run_9"]);
    expect(audit.violations).toEqual([]);
  });

  it("counts a repeated schedule firing once per extra occurrence", () => {
    const firing = (fireInstant: string, revision = 1) => ({
      scheduleId: "sch_1",
      revision,
      fireInstant,
    });
    expect(
      duplicateFirings([firing("t1"), firing("t2"), firing("t1"), firing("t1"), firing("t1", 2)]),
    ).toBe(2);
    expect(duplicateFirings([firing("t1"), firing("t2")])).toBe(0);
  });

  it("bounds the target's requests by the Attempts started", () => {
    expect(executionBound(10, 10).ok).toBe(true);
    expect(executionBound(9, 10).ok).toBe(true);
    expect(executionBound(11, 10).ok).toBe(false);
  });
});

describe("overhead separated from target time", () => {
  const timing = (runId: string, queue: number, prep: number, exec: number, collect: number) => ({
    runId,
    payload: {
      timing: {
        queueDuration: queue,
        preparationDuration: prep,
        executionDuration: exec,
        collectionDuration: collect,
      },
    },
  });

  it("keeps the first Attempt's queue time and sums the other phases across Attempts", () => {
    const timings = aggregateTimings([
      timing("run_1", 100, 20, 300, 10),
      timing("run_1", 0, 30, 200, 5),
    ]);
    expect(timings.get("run_1")).toEqual({
      queueMs: 100,
      preparationMs: 50,
      executionMs: 500,
      collectionMs: 15,
    });
  });

  it("derives wall time from admission to the last Attempt's end and skips Runs still open", () => {
    const walls = wallTimes([
      row({ runId: "a", endedAt: "2026-01-01T00:00:02.000Z" }),
      row({ runId: "b", attemptId: "b1", attemptNumber: 1, endedAt: "2026-01-01T00:00:01.000Z" }),
      row({ runId: "b", attemptId: "b2", attemptNumber: 2, endedAt: null }),
      row({ runId: "c", runPhase: "running", runOutcome: null }),
    ]);
    expect([...walls]).toEqual([["a", 2000]]);
  });

  it("attributes the remainder of the wall time to orchestration, and collection separately", () => {
    const walls = wallTimes([row({ endedAt: "2026-01-01T00:00:02.000Z" })]);
    const decomposition = decomposeRuns(
      walls,
      aggregateTimings([timing("run_1", 500, 100, 900, 200)]),
      100,
    );
    // 2000 - 500 - 100 - 900 = 500 including collection; 300 without it.
    expect(decomposition.orchestrationOverhead.p50).toBe(500);
    expect(decomposition.controllerOverhead.p50).toBe(300);
    expect(decomposition.collection.p50).toBe(200);
    expect(decomposition.runnerOverhead.p50).toBe(800);
    expect(decomposition.runnerOverhead.n).toBe(1);
  });
});

describe("availability during a fault", () => {
  it("measures the longest outage and the time to the last recovery", () => {
    const probes = [
      [0, true],
      [250, true],
      [500, false],
      [750, false],
      [1000, true],
      [1250, false],
      [1500, true],
    ] as const;
    const summary = outageSummary(
      probes.map(([atMs, ok]) => ({ atMs, ok })),
      400,
    );
    expect(summary.failures).toBe(3);
    expect(summary.longestFailureStreakMs).toBe(500);
    expect(summary.recoveryMs).toBe(1100);
    expect(summary.stillFailingAtEnd).toBe(false);
  });

  it("reports no recovery when the last probe still fails", () => {
    const summary = outageSummary(
      [
        { atMs: 0, ok: true },
        { atMs: 100, ok: false },
      ],
      0,
    );
    expect(summary.recoveryMs).toBeNull();
    expect(summary.stillFailingAtEnd).toBe(true);
  });
});

describe("partition judged per frozen Attempt", () => {
  const resumedAtMs = Date.parse("2026-01-01T00:01:00.000Z");
  const frozenAttempt = (leaseExpiresAt: string): FrozenAttempt => ({
    attemptId: "att_1",
    runId: "run_1",
    leaseExpiresAtMs: Date.parse(leaseExpiresAt),
  });
  const lapsed = frozenAttempt("2026-01-01T00:00:30.000Z");
  const valid = frozenAttempt("2026-01-01T00:01:30.000Z");

  it("lets an Attempt whose lease was still valid at resume pass, and calls that not observed", () => {
    const check = judgeFrozenAttempts([valid], resumedAtMs, [row({})]);
    expect(check.ok).toBeNull();
    expect(check.detail).toContain("0 lapsed, 1 still valid");
  });

  it("requires a lapsed Attempt's Run to move on or end non-passed", () => {
    const retried = [
      row({ attemptOutcome: "infrastructure_error", runOutcome: "passed" }),
      row({ attemptId: "att_2", attemptNumber: 2 }),
    ];
    expect(judgeFrozenAttempts([lapsed], resumedAtMs, retried).ok).toBe(true);
    const inconclusive = [
      row({ attemptOutcome: "infrastructure_error", runOutcome: "inconclusive" }),
    ];
    expect(judgeFrozenAttempts([lapsed], resumedAtMs, inconclusive).ok).toBe(true);
  });

  it("fails a lapsed Attempt that still passed, and a Run that neither moved nor ended non-passed", () => {
    const passedLate = judgeFrozenAttempts([lapsed], resumedAtMs, [row({})]);
    expect(passedLate.ok).toBe(false);
    expect(passedLate.detail).toContain("passed after its lease lapsed");
    const stuck = judgeFrozenAttempts([lapsed], resumedAtMs, [
      row({ attemptOutcome: "infrastructure_error", runOutcome: "passed" }),
    ]);
    expect(stuck.ok).toBe(false);
    expect(stuck.detail).toContain("no later Attempt");
  });

  it("has nothing to judge without a frozen Attempt", () => {
    expect(judgeFrozenAttempts([], resumedAtMs, []).ok).toBeNull();
  });
});

describe("argument parsing", () => {
  it("requires --out and applies the documented defaults", () => {
    expect(() => parseArguments([])).toThrow("--out");
    const options = parseArguments(["--out", "/tmp/capacity.json"]);
    expect(options).not.toBe("help");
    if (options === "help") return;
    expect(options.soakMinutes).toBe(30);
    expect(options.concurrency).toEqual([2, 4, 8]);
    expect(options.soakConcurrency).toBe(2);
    expect(options.phases).toEqual(["throughput", "soak", "chaos", "backpressure"]);
  });

  it("rejects unknown flags, non-integers and unknown phases", () => {
    expect(() => parseArguments(["--out", "x", "--target", "https://prod"])).toThrow(
      "Unknown flag",
    );
    expect(() => parseArguments(["--out", "x", "--soak-minutes", "1.5"])).toThrow("integer");
    expect(() => parseArguments(["--out", "x", "--phases", "soak,boom"])).toThrow("--phases");
    expect(parseArguments(["--help"])).toBe("help");
  });

  it("refuses a partition that cannot outlast the lease, but only when chaos runs", () => {
    expect(() => parseArguments(["--out", "x", "--partition-seconds", "35"])).toThrow(
      "--partition-seconds",
    );
    expect(parseArguments(["--out", "x", "--partition-seconds", "36"])).not.toBe("help");
    expect(
      parseArguments(["--out", "x", "--phases", "soak", "--partition-seconds", "10"]),
    ).not.toBe("help");
  });
  it("takes a case filter, a keep-stack flag and the slow-target delay, and rejects bad values", () => {
    const defaults = parseArguments(["--out", "x"]);
    if (defaults === "help") throw new Error("unexpected help");
    expect(defaults.chaosCases).toEqual(["controller_kill", "minio_restart", "worker_partition"]);
    expect(defaults.keepStackOnFailure).toBe(false);
    expect(defaults.partitionTargetDelayMs).toBe(20_000);
    const chosen = parseArguments([
      "--out",
      "x",
      "--chaos-cases",
      "minio_restart",
      "--keep-stack-on-failure",
      "true",
      "--partition-seconds",
      "10",
    ]);
    if (chosen === "help") throw new Error("unexpected help");
    expect(chosen.chaosCases).toEqual(["minio_restart"]);
    expect(chosen.keepStackOnFailure).toBe(true);
    expect(() => parseArguments(["--out", "x", "--chaos-cases", "minio_restart,boom"])).toThrow(
      "--chaos-cases",
    );
    expect(() => parseArguments(["--out", "x", "--keep-stack-on-failure", "yes"])).toThrow(
      "--keep-stack-on-failure",
    );
  });
});

describe("unexpected answers and server log lines", () => {
  it("keeps only answers that are neither accepted nor a documented refusal, with their detail", () => {
    const base = { ms: 12.6, retryAfter: false, queued: null, limit: null, atMs: 0 } as const;
    const found = unexpectedAnswers([
      { ...base, outcome: "accepted", status: 202, detail: null },
      { ...base, outcome: "queue_overflow", status: 429, detail: null },
      { ...base, outcome: "storage_unavailable", status: 503, detail: null },
      { ...base, outcome: "server_error", status: 502, detail: 'HTTP 502 server=Caddy body=""' },
      { ...base, outcome: "transport_error", status: null, detail: "Error: reset (ECONNRESET)" },
    ]);
    expect(found.map((entry) => [entry.outcome, entry.status, entry.ms, entry.detail])).toEqual([
      ["server_error", 502, 13, 'HTTP 502 server=Caddy body=""'],
      ["transport_error", null, 13, "Error: reset (ECONNRESET)"],
    ]);
    expect(
      unexpectedAnswers(
        Array.from({ length: 30 }, () => ({
          ...base,
          outcome: "server_error",
          status: 500,
          detail: null,
        })),
      ),
    ).toHaveLength(20);
  });

  it("picks the error and 5xx lines out of a log and keeps the last ones", () => {
    const log = [
      '{"level":"info","msg":"started"}',
      '{"level":"error","msg":"upstream failed"}',
      '{"status":200,"uri":"/v1/health/live"}',
      '{"status":502,"uri":"/v1/runs"}',
      "2026-01-01 ERROR something broke",
    ].join("\n");
    expect(errorLogLines(log)).toEqual([
      '{"level":"error","msg":"upstream failed"}',
      '{"status":502,"uri":"/v1/runs"}',
      "2026-01-01 ERROR something broke",
    ]);
    expect(errorLogLines(log, 1)).toEqual(["2026-01-01 ERROR something broke"]);
  });
});

describe("evidence audited through the object store", () => {
  const workspace = "ws_1";
  const store = (
    objects: Record<string, string>,
    unreadable: readonly string[] = [],
  ): EvidenceReader => ({
    async head(key) {
      if (unreadable.includes(key)) throw new Error("connection reset");
      const value = objects[key];
      return value === undefined ? null : { sizeBytes: Buffer.byteLength(value) };
    },
    async get(key) {
      const value = objects[key];
      if (value === undefined) return null;
      return (async function* () {
        yield Buffer.from(value);
      })();
    },
    async *list(prefix) {
      for (const [key, value] of Object.entries(objects))
        if (key.startsWith(prefix))
          yield { key, sizeBytes: Buffer.byteLength(value), modifiedAt: new Date(0) };
    },
  });
  /** The three objects of a committed bundle with one artifact `a.txt`; `content` is what is stored for it. */
  const bundle = (runId: string, attemptId: string, content = "hello") => {
    const base = `runs/${workspace}/${runId}/${attemptId}`;
    const manifest = {
      entries: [
        {
          relativePath: "a.txt",
          state: "available",
          sizeBytes: 5,
          sha256: sha256("hello"),
          artifactId: "art_1",
        },
      ],
    };
    return {
      [`${base}/a.txt`]: content,
      [`${base}/manifest.json`]: JSON.stringify(manifest),
      [`${base}/meta.json`]: JSON.stringify({ manifestHash: sha256(canonicalJson(manifest)) }),
    };
  };

  it("counts a Run once, on its last passed Attempt, and nothing that did not complete as passed", () => {
    const passed = passedAttempts([
      row({ runId: "run_1", attemptId: "att_1", attemptNumber: 1, attemptOutcome: "failed" }),
      row({ runId: "run_1", attemptId: "att_2", attemptNumber: 2 }),
      row({ runId: "run_2", runPhase: "running", runOutcome: null }),
      row({ runId: "run_3", runOutcome: "failed" }),
      row({ runId: "run_4", runGate: "failed" }),
    ]);
    expect([...passed.entries()].map(([runId, entry]) => [runId, entry.attemptId])).toEqual([
      ["run_1", "att_2"],
    ]);
  });

  it("reports a passed Run without a manifest with what the bucket says about its bundle", async () => {
    const objects = {
      ...bundle("run_1", "att_1"),
      // run_2's artifact and meta are stored but its manifest never was.
      [`runs/${workspace}/run_2/att_1/a.txt`]: "hello",
      [`runs/${workspace}/run_2/att_1/meta.json`]: "{}",
    };
    const audit = await auditEvidence(store(objects), workspace, [
      row({ runId: "run_1" }),
      row({ runId: "run_2", endedAt: "2026-01-01T00:00:05.000Z" }),
    ]);
    expect(audit.checked).toBe(2);
    expect(audit.unreadable).toEqual([]);
    expect(audit.missing).toEqual([
      {
        runId: "run_2",
        attemptId: "att_1",
        attemptEndedAt: "2026-01-01T00:00:05.000Z",
        manifestHead: "absent (NotFound)",
        metaHead: "present, 2 bytes",
        bundleVerification: "manifest.json is absent",
      },
    ]);
  });

  it("does not call a Run missing when the store could not answer, and says so apart", async () => {
    const manifest = `runs/${workspace}/run_1/att_1/manifest.json`;
    const audit = await auditEvidence(store(bundle("run_1", "att_1"), [manifest]), workspace, [
      row({ runId: "run_1" }),
    ]);
    expect(audit.missing).toEqual([]);
    expect(audit.unreadable).toEqual(["run_1"]);
  }, 15_000);

  it("verifies a bundle by its manifest hash and artifact bytes, and names what differs", async () => {
    const key = `runs/${workspace}/run_1/att_1`;
    expect(await verifyEvidenceBundle(store(bundle("run_1", "att_1")), key)).toEqual({
      ok: true,
      detail: "manifest hash and 1 artifact(s) verified",
    });
    expect(
      (await verifyEvidenceBundle(store(bundle("run_1", "att_1", "HELLO")), key)).detail,
    ).toContain("a.txt differs from its manifest entry");
    const { [`${key}/a.txt`]: _artifact, ...withoutArtifact } = bundle("run_1", "att_1");
    expect((await verifyEvidenceBundle(store(withoutArtifact), key)).detail).toContain(
      "artifact a.txt is absent",
    );
    const tampered = {
      ...bundle("run_1", "att_1"),
      [`${key}/manifest.json`]: JSON.stringify({ entries: [] }),
    };
    expect((await verifyEvidenceBundle(store(tampered), key)).detail).toContain(
      "does not hash to meta.manifestHash",
    );
    expect((await verifyEvidenceBundle(store({}), key)).detail).toBe("meta.json is absent");
  });

  it("sets aside Runs whose assertions passed with the gate failed, and expects them only inside an outage", () => {
    const rows = [
      row({ runId: "run_1" }),
      row({ runId: "run_2", runGate: "failed", endedAt: "2026-01-01T00:00:05.000Z" }),
      row({ runId: "run_3", runGate: "failed", endedAt: "2026-01-01T00:01:00.000Z" }),
      row({ runId: "run_4", runOutcome: "failed", runGate: "failed" }),
    ];
    expect(gateFailedPasses(rows).map((entry) => entry.runId)).toEqual(["run_2", "run_3"]);
    const window = {
      fromMs: Date.parse("2026-01-01T00:00:00.000Z"),
      toMs: Date.parse("2026-01-01T00:00:10.000Z"),
    };
    const inWindow = judgeGateFailedPasses(rows.slice(0, 2), window);
    expect(inWindow.ok).toBe(true);
    expect(inWindow.detail).toContain("1 of them inside the outage window");
    const outside = judgeGateFailedPasses(rows, window);
    expect(outside.ok).toBe(false);
    expect(outside.detail).toContain("outside it: run_3");
    expect(judgeGateFailedPasses(rows.slice(0, 2), null).ok).toBe(false);
    expect(judgeGateFailedPasses(rows.slice(0, 1), null).ok).toBe(true);
  });
});

describe("a run that stops part-way", () => {
  const failure = describeFailure("backpressure", new Error("member creation failed: 401"));

  it("keeps the thrown message and names the failing phase apart from the ones it cut off", () => {
    expect(failure.error).toContain("member creation failed: 401");
    expect(absentPhase(failure, "backpressure", "unused")).toEqual({
      status: "failed",
      reason: "The backpressure phase failed: Error: member creation failed: 401",
    });
    const later = absentPhase(failure, "chaos/minio_restart", "unused");
    expect(later.status).toBe("not run");
    expect(later.reason).toContain("the backpressure phase failed first");
    expect(later.reason).toContain("member creation failed: 401");
  });

  it("falls back to the plain reason when nothing failed", () => {
    expect(absentPhase(null, "soak", "The soak phase did not run.")).toEqual({
      status: "not run",
      reason: "The soak phase did not run.",
    });
    expect(describeFailure("setup", "plain text").error).toBe("plain text");
  });
});

describe("session expiry", () => {
  const envelope = (code: string, message: string) =>
    JSON.stringify({ error: { code, message, retryable: false } });

  it("recognises only the lapsed-session answer", () => {
    const lapsed = envelope("UNAUTHENTICATED", "Session is invalid or expired");
    expect(isSessionExpired(401, Buffer.from(lapsed))).toBe(true);
    expect(isSessionExpired(401, lapsed)).toBe(true);
    // Other refusals must reach the caller instead of being retried on a new login.
    expect(isSessionExpired(401, envelope("UNAUTHENTICATED", "Invalid credentials"))).toBe(false);
    expect(isSessionExpired(403, lapsed)).toBe(false);
    expect(isSessionExpired(401, envelope("FORBIDDEN", "Session is invalid or expired"))).toBe(
      false,
    );
    expect(isSessionExpired(401, "<html>proxy</html>")).toBe(false);
    expect(isSessionExpired(401, "")).toBe(false);
  });
});
