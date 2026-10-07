import type { CoverageMetrics, ExecutionMetrics, RatioMetric } from "@testmaster/contracts";
import type { ReportSnapshot } from "./index.js";

export function ratioMetric(
  numerator: number,
  denominator: number | null,
  definition: string,
  scope: string,
): RatioMetric {
  if (denominator !== null && numerator > denominator)
    throw new Error("Metric numerator exceeds denominator");
  return {
    numerator,
    denominator,
    denominatorState: denominator === null ? "unknown" : "known",
    state:
      denominator === null ? "insufficientData" : denominator === 0 ? "notApplicable" : "available",
    value: denominator === null || denominator === 0 ? null : numerator / denominator,
    definition,
    scope,
  };
}
export function coverageMetrics(
  input: Partial<
    Record<
      keyof CoverageMetrics,
      { covered: readonly string[]; declared: readonly string[] | null; scope: string }
    >
  >,
): CoverageMetrics {
  const output = {} as CoverageMetrics;
  for (const key of ["requirement", "route", "operation", "code", "execution"] as const) {
    const item = input[key];
    const covered = new Set(item?.covered ?? []);
    const declared = item?.declared === null || !item ? null : new Set(item.declared);
    output[key] = ratioMetric(
      declared ? [...covered].filter((value) => declared.has(value)).length : covered.size,
      declared?.size ?? null,
      {
        requirement:
          "Distinct in-scope requirements with accepted scenarios / declared in-scope requirements (mapping, not verification)",
        route: "Distinct observed routes / declared in-scope routes",
        operation:
          "Distinct operation/status/schema pairs exercised / declared in-scope operation/status/schema pairs",
        code: "Instrumented covered code units / declared instrumented code units; never inferred from navigation",
        execution: "Requested cells with passed or failed outcome / frozen requested cells",
      }[key],
      item?.scope ?? "No authoritative denominator available",
    );
  }
  return output;
}
export function executionMetrics(snapshot: ReportSnapshot): ExecutionMetrics {
  const requestedIds = new Set(
    snapshot.selection.requestedRunIds ?? snapshot.runs.map((item) => item.run.id),
  );
  const runs = snapshot.runs.filter((item) => requestedIds.has(item.run.id));
  const count = (predicate: (item: (typeof runs)[number]) => boolean) =>
    runs.filter(predicate).length;
  const selected = snapshot.selection.requested;
  const outcomes = {
    passed: count((item) => item.result.outcome === "passed"),
    failed: count((item) => item.result.outcome === "failed"),
    blocked: count((item) => item.result.outcome === "blocked"),
    cancelled: count((item) => item.result.outcome === "cancelled"),
    inconclusive: count((item) => item.result.outcome === "inconclusive"),
    nonterminal: count((item) => item.result.phase !== "completed"),
  };
  if (
    selected !==
    snapshot.selection.notDispatched.length +
      Object.values(outcomes).reduce((n, value) => n + value, 0)
  )
    throw new Error("Execution denominator does not match frozen selection");
  const first = (item: (typeof runs)[number]) =>
    item.attempts.find((value) => value.number === 1)?.outcome ?? item.result.firstAttemptOutcome;
  const diagnostic = runs.filter((item) => item.attempts.length > 1 && first(item) === "failed");
  const infra = runs.filter(
    (item) =>
      item.attempts.length > 1 &&
      first(item) !== "failed" &&
      item.result.firstAttemptOutcome !== "failed",
  );
  const firstFailed = count((item) => first(item) === "failed");
  const firstPassed = count((item) => first(item) === "passed");
  const closed = runs.filter(
    (item) =>
      item.result.phase === "completed" &&
      (item.evidenceState === "unavailable" || item.manifest.entries.length > 0),
  );
  const stale = count((item) => item.freshness?.state === "stale");
  const rates: ExecutionMetrics["rates"] = {};
  const add = (name: string, numerator: number, denominator: number, definition: string) => {
    rates[name] = ratioMetric(
      numerator,
      denominator,
      definition,
      "Frozen requested Run/cell selection; expanded dependencies excluded from pass-rate denominator",
    );
  };
  add(
    "selectionCompletionRate",
    outcomes.passed + outcomes.failed,
    selected,
    "(N_passed + N_failed) / N_selected",
  );
  add(
    "strictPassRate",
    count((item) => {
      const cell = item.run.matrixCell as Record<string, unknown>;
      const effective = cell.effectiveConfig as
        | { config?: { healing?: { mode?: string } } }
        | undefined;
      return (
        first(item) === "passed" &&
        item.run.mode === "replay" &&
        (effective?.config?.healing?.mode ?? "off") === "off"
      );
    }),
    selected,
    "N_firstAttemptPassed under strict/no-heal / N_selected",
  );
  add("terminalPassRate", outcomes.passed, selected, "N_passed / N_selected");
  add("blockedRate", outcomes.blocked, selected, "N_blocked / N_selected");
  add("inconclusiveRate", outcomes.inconclusive, selected, "N_inconclusive / N_selected");
  add(
    "gatePassRate",
    count((item) => item.result.gate === "passed"),
    selected,
    "N_requiredRunsWithGatePassed / N_selected",
  );
  add(
    "retryRecoveryRate",
    infra.filter((item) => item.result.outcome === "passed").length,
    infra.length,
    "N_retrySafeInfraRunsRecoveredToPassed / N_retrySafeInfraRunsRetried (internal infrastructure retries only)",
  );
  add(
    "diagnosticRetryPassRate",
    diagnostic.filter((item) => item.result.passedOnRetry).length,
    diagnostic.length,
    "N_assertionFailedRunsWithPassedOnRetry / N_assertionFailedRunsDiagnosticallyRetried",
  );
  add(
    "firstAttemptFailureRate",
    firstFailed,
    firstFailed + firstPassed,
    "N_firstAttemptsFailed / N_firstAttemptsPassOrFail; blocked/cancelled/inconclusive excluded conditionally",
  );
  add(
    "artifactCompletenessRate",
    closed.filter(
      (item) =>
        item.evidenceState === "committed" &&
        item.manifest.entries.every((entry) => entry.state === "available"),
    ).length,
    closed.length,
    "N_closedRunsWithAllRequiredArtifactsValid / N_closedRunsRequiringArtifacts; retention reflected in separate completeness/freshness views",
  );
  add(
    "staleEvidenceRate",
    stale,
    runs.filter((item) => item.freshness !== undefined).length,
    "N_consultedEvidenceUnitsStaleForRequestedContext / N_consultedEvidenceUnits (Run bundles)",
  );
  const blockedReasons: Record<string, number> = {};
  for (const item of runs.filter((item) => item.result.outcome === "blocked")) {
    const reason = item.result.reasonCode ?? "unspecified";
    blockedReasons[reason] = (blockedReasons[reason] ?? 0) + 1;
  }
  return {
    counts: {
      requested: selected,
      accepted: runs.length,
      notDispatched: snapshot.selection.notDispatched.length,
      expanded: snapshot.runs.length - runs.length,
      allMembers: snapshot.runs.length,
      executed: count((item) =>
        item.steps.some((step) => !["not_run", "skipped", "pending"].includes(step.status)),
      ),
      attempts: runs.reduce((n, item) => n + item.attempts.length, 0),
      retried: count((item) => item.attempts.length > 1),
      duplicates: snapshot.selection.duplicates ?? 0,
      excluded: snapshot.selection.excluded.length,
      ...outcomes,
    },
    rates,
    exclusions: {
      firstAttemptNonPassOrFail: selected - firstPassed - firstFailed,
      expandedDependencies: snapshot.runs.length - runs.length,
      authorizedExcluded: snapshot.selection.excluded.length,
      duplicateSelections: snapshot.selection.duplicates ?? 0,
    },
    blockedReasons,
    retryPolicy:
      "Pinned execution limits; attempts never increase selected denominator; assertion failure remains failed after diagnostic pass",
  };
}
