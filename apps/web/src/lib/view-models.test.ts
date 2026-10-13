import { describe, expect, it } from "vitest";
import {
  buildDataFlow,
  describeFlowTable,
  describeRequestLine,
  describeStepTable,
  type FlowResource,
  layoutDataFlow,
  maskedValue,
  orphanedResources,
  type PlanLike,
  variableRefs,
} from "./data-flow";
import { describeFlake, type FlakeReport } from "./flake-view";
import { type BatchReceiptLike, buildMatrix, groupDifferences } from "./matrix";
import {
  describeExclusions,
  describeMetricFamilies,
  describeRate,
  type MetricsPayload,
  type RateMetric,
} from "./metrics-view";
import type { RunRecord, StepRecord } from "./run-types";
import { describeFreshness } from "./stale-evidence";

const step = (
  planStepId: string,
  status: StepRecord["status"] = "passed",
  durationMs = 25,
  observed: unknown = null,
): StepRecord => ({
  id: `res-${planStepId}`,
  attemptId: "att-1",
  planStepId,
  index: 0,
  status,
  expected: null,
  observed,
  error: null,
  durationMs,
  evidenceRefs: [],
});

const createOrder = {
  id: "create-order",
  operation: "request",
  description: "Create an order",
  input: {
    method: "POST",
    pathSegments: [{ literal: "orders" }],
    capture: [{ name: "order-id", from: "jsonPointer", pointer: "/id", sensitive: false }],
  },
};
const readOrder = {
  id: "read-order",
  operation: "request",
  description: "Read the order back",
  input: { method: "GET", pathSegments: [{ literal: "orders" }, { variableRef: "order-id" }] },
};

describe("data-flow graph", () => {
  it("REQ-053 draws an edge from the producing step to each consumer and lays the producer out first", () => {
    const graph = buildDataFlow({ steps: [createOrder, readOrder] }, [step("create-order")]);
    expect(graph.edges).toEqual([
      expect.objectContaining({
        kind: "variable",
        name: "order-id",
        from: "create-order",
        to: "read-order",
        unresolved: false,
        sensitive: false,
      }),
    ]);
    const layout = layoutDataFlow(graph);
    expect(layout.positions["create-order"]?.x).toBeLessThan(
      layout.positions["read-order"]?.x ?? 0,
    );
    expect(graph.nodes.find((node) => node.id === "create-order")?.run).toMatchObject({
      status: "passed",
      durationMs: 25,
    });
    // Negative control: a plan whose steps share nothing has no edge at all.
    const independent = buildDataFlow({
      steps: [
        { id: "a", operation: "request", input: { method: "GET", pathSegments: [] } },
        { id: "b", operation: "request", input: { method: "GET", pathSegments: [] } },
      ],
    });
    expect(independent.edges).toEqual([]);
    expect(independent.nodes.map((node) => node.run)).toEqual([null, null]);
  });

  it("REQ-053 flags a reference nothing produces as unresolved instead of dropping it", () => {
    const plan: PlanLike = { steps: [readOrder] };
    const graph = buildDataFlow(plan);
    expect(graph.edges).toEqual([
      expect.objectContaining({ name: "order-id", from: null, to: "read-order", unresolved: true }),
    ]);
    const rows = describeFlowTable(graph);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.notes.join(" ")).toContain("Unresolved reference");
    expect(rows[0]?.producedBy).toBeNull();
    // Negative control: once a producer exists the same reference is resolved and has no warning.
    const resolved = describeFlowTable(buildDataFlow({ steps: [createOrder, readOrder] }));
    expect(resolved.find((row) => row.name === "order-id")?.notes).toEqual([]);
    expect(variableRefs(readOrder.input)).toEqual(["order-id"]);
  });

  it("REQ-053 a dependency output feeds its consumer and an unknown name stays unresolved", () => {
    const plan: PlanLike = {
      dependsOn: [
        {
          producerTestId: "tst-producer",
          outputName: "fixture-id",
          consumerInput: "fixture",
          sensitive: false,
          required: true,
        },
      ],
      steps: [
        {
          id: "use",
          operation: "request",
          input: {
            method: "GET",
            pathSegments: [{ variableRef: "fixture" }, { variableRef: "missing" }],
          },
        },
      ],
    };
    const edges = buildDataFlow(plan).edges;
    expect(edges.find((edge) => edge.name === "fixture")).toMatchObject({
      from: "dependency:fixture",
      unresolved: false,
    });
    expect(edges.find((edge) => edge.name === "missing")).toMatchObject({
      from: null,
      unresolved: true,
    });
  });

  it("REQ-053 links a created resource to its cleanup and lists orphaned resources with their state", () => {
    const plan: PlanLike = {
      steps: [
        {
          id: "create-user",
          operation: "request",
          input: {
            method: "POST",
            pathSegments: [{ literal: "users" }],
            resource: { resourceType: "user", correlationKey: { literal: "k" } },
          },
        },
      ],
      cleanup: [{ resourceRef: "create-user" }],
    };
    const orphan: FlowResource = {
      id: "res-1",
      resourceType: "user",
      state: "orphaned",
      stepId: "create-user",
    };
    const graph = buildDataFlow(plan, [step("create-user")], [orphan]);
    expect(graph.edges.map((edge) => [edge.kind, edge.from, edge.to])).toEqual([
      ["resource", "create-user", "resource:create-user"],
      ["resource", "resource:create-user", "cleanup:0"],
    ]);
    expect(graph.nodes.find((node) => node.id === "resource:create-user")?.resourceState).toBe(
      "orphaned",
    );
    const rows = describeFlowTable(graph, [orphan]);
    expect(rows.find((row) => row.name === "user")?.notes.join(" ")).toContain("orphaned");
    expect(rows.every((row) => row.name !== "create-user.handle")).toBe(true);
    expect(orphanedResources([orphan])).toEqual([orphan]);

    // A resource no step of the revision explains still appears, with its state.
    const stray: FlowResource = {
      id: "res-9",
      resourceType: "ticket",
      state: "uncertain",
      stepId: null,
    };
    const withStray = describeFlowTable(graph, [orphan, stray]);
    expect(withStray.find((row) => row.key === "orphan:res-9")).toMatchObject({
      name: "ticket",
      producerStatus: { kind: "resource", status: "uncertain" },
    });

    // Negative control: a cleaned resource is not reported as left behind and raises no note.
    const cleaned: FlowResource = { ...orphan, state: "cleaned" };
    expect(orphanedResources([cleaned])).toEqual([]);
    const cleanRows = describeFlowTable(buildDataFlow(plan, [], [cleaned]), [cleaned]);
    expect(cleanRows.find((row) => row.name === "user")?.notes).toEqual([]);
    expect(cleanRows.some((row) => row.key.startsWith("orphan:"))).toBe(false);
  });

  it("REQ-053 masks sensitive captures: rows say hidden, no value is carried and observed data is withheld", () => {
    const secret = "tok_live_51HxHunter2";
    const sensitiveLogin = {
      id: "login",
      operation: "request",
      description: "Log in",
      input: {
        method: "POST",
        pathSegments: [{ literal: "login" }],
        capture: [{ name: "token", from: "jsonPointer", pointer: "/token", sensitive: true }],
      },
    };
    const useToken = {
      id: "profile",
      operation: "request",
      input: {
        method: "GET",
        pathSegments: [{ literal: "me" }],
        headers: { Authorization: { variableRef: "token" } },
      },
    };
    const plan: PlanLike = { steps: [sensitiveLogin, useToken] };
    const results = [step("login", "passed", 40, { body: { token: secret } }), step("profile")];
    const graph = buildDataFlow(plan, results);
    const rows = describeFlowTable(graph);
    const stepRows = describeStepTable(plan, graph);
    expect(graph.edges[0]).toMatchObject({ name: "token", sensitive: true });
    expect(rows[0]).toMatchObject({ name: "token", sensitive: true });
    expect(rows[0]?.notes.join(" ")).toContain("never shown");
    expect(maskedValue).toBe("••• hidden");
    expect(stepRows.find((row) => row.id === "login")?.observedWithheld).toBe(true);
    expect(JSON.stringify({ graph, rows, stepRows })).not.toContain(secret);
    expect(describeRequestLine(useToken.input)).toBe("GET /me");

    // Negative control: a plain capture is not marked sensitive and its step is not withheld.
    const plain = buildDataFlow({ steps: [createOrder, readOrder] }, [step("create-order")]);
    expect(describeFlowTable(plain).every((row) => !row.sensitive)).toBe(true);
    expect(
      describeStepTable({ steps: [createOrder, readOrder] }, plain).every(
        (row) => !row.observedWithheld,
      ),
    ).toBe(true);
  });

  it("REQ-053 includes steps inside a frame, in order, and prints variables by name only", () => {
    const plan: PlanLike = {
      steps: [
        { id: "frame-1", operation: "frame", input: { childSteps: [createOrder, readOrder] } },
      ],
    };
    const graph = buildDataFlow(plan);
    expect(graph.nodes.map((node) => node.id)).toEqual(["frame-1", "create-order", "read-order"]);
    expect(graph.edges).toHaveLength(1);
    expect(describeRequestLine(readOrder.input)).toBe("GET /orders/{order-id}");
    // Negative control: a step that is not a request has no request line.
    expect(describeStepTable(plan, graph).find((row) => row.id === "frame-1")?.request).toBeNull();
    expect(describeRequestLine({ locator: { by: "role" } })).toBeNull();
  });
});

const rate = (overrides: Partial<RateMetric> = {}): RateMetric => ({
  numerator: 2,
  denominator: 4,
  denominatorState: "known",
  state: "available",
  value: 0.5,
  definition: "definition text",
  scope: "scope",
  ...overrides,
});
const payload = (
  rates: Record<string, RateMetric>,
  exclusions: Record<string, number> = {},
): MetricsPayload => ({
  considered: 4,
  truncated: false,
  window: { since: "2030-01-01T00:00:00.000Z", until: "2030-01-31T00:00:00.000Z" },
  metrics: { counts: {}, rates, exclusions, blockedReasons: {}, retryPolicy: "policy" },
  quarantined: [],
  limitations: [],
});

describe("dashboard metrics view", () => {
  it("VAL-007 keeps the first-attempt, terminal, conditional and end-to-end families in separate sections", () => {
    const families = describeMetricFamilies(
      payload({
        strictPassRate: rate({ value: 0.25, numerator: 1 }),
        terminalPassRate: rate({ value: 0.75, numerator: 3 }),
        firstAttemptFailureRate: rate({ value: 0.5 }),
        gatePassRate: rate({ value: 1, numerator: 4 }),
      }),
    );
    expect(families.map((family) => family.family)).toEqual([
      "first-attempt",
      "terminal",
      "conditional",
      "end-to-end",
    ]);
    const keys = families.flatMap((family) => family.rows.map((row) => row.key));
    expect(new Set(keys).size).toBe(keys.length);
    expect(families[0]?.rows.map((row) => [row.key, row.display])).toEqual([
      ["strictPassRate", "25%"],
    ]);
    expect(families[1]?.rows[0]).toMatchObject({ key: "terminalPassRate", display: "75%" });
    expect(families[3]?.rows[0]).toMatchObject({ key: "gatePassRate", display: "100%" });
    // Negative control: no row, in any family, is a merged headline.
    const labels = families.flatMap((family) => family.rows.map((row) => row.label.toLowerCase()));
    expect(labels.some((label) => /overall|combined|total|headline/.test(label))).toBe(false);
  });

  it("VAL-007 an unavailable rate says Insufficient data or Not applicable and is never shown as 0%", () => {
    const unknown = describeRate(
      rate({
        denominator: null,
        denominatorState: "unknown",
        state: "insufficientData",
        value: null,
        numerator: 0,
      }),
    );
    expect(unknown).toMatchObject({
      display: "Insufficient data",
      fraction: "0 of unknown",
      available: false,
    });
    const empty = describeRate(
      rate({ denominator: 0, state: "notApplicable", value: null, numerator: 0 }),
    );
    expect(empty).toMatchObject({
      display: "Not applicable (no Runs in the denominator)",
      fraction: "0 of 0",
      available: false,
    });
    expect(describeRate(undefined)).toMatchObject({ display: "Not reported", available: false });
    // Negative control: a rate that is really zero over a known denominator stays 0%.
    expect(describeRate(rate({ numerator: 0, value: 0 }))).toMatchObject({
      display: "0%",
      fraction: "0 of 4",
      available: true,
    });
    expect(describeRate(rate({ value: 1 / 3, numerator: 1, denominator: 3 })).display).toBe(
      "33.3%",
    );
  });

  it("VAL-007 lists every reported exclusion, including zero, and keeps unknown ones visible", () => {
    const rows = describeExclusions(
      payload(
        {},
        {
          firstAttemptNonPassOrFail: 2,
          expandedDependencies: 0,
          authorizedExcluded: 0,
          duplicateSelections: 0,
          somethingNew: 3,
        },
      ),
    );
    expect(rows.map((row) => [row.key, row.count])).toEqual([
      ["firstAttemptNonPassOrFail", 2],
      ["expandedDependencies", 0],
      ["authorizedExcluded", 0],
      ["duplicateSelections", 0],
      ["somethingNew", 3],
    ]);
    expect(rows[0]?.label).toContain("blocked, cancelled, inconclusive");
    expect(rows[4]?.label).toBe("somethingNew");
    // Negative control: nothing is invented when the server reports no exclusion.
    expect(describeExclusions(payload({}))).toEqual([]);
  });
});

const run = (overrides: Partial<RunRecord> = {}): RunRecord => ({
  id: "run-1",
  testId: "tst-1",
  revisionId: "rev-aaaaaaaaaaaaaaaaaaaa",
  environmentRevisionId: "env-bbbbbbbbbbbbbbbbbbbb",
  batchId: null,
  mode: "replay",
  phase: "completed",
  status: "passed",
  outcome: "passed",
  origin: "api",
  gate: "passed",
  cleanupOutcome: "not_required",
  analysisStatus: "not_requested",
  createdAt: "2030-01-01T00:00:00.000Z",
  version: 1,
  matrixCell: {
    environmentName: "staging",
    repetitionIndex: 0,
    admissionSnapshot: { repository: { commitSha: "c0ffee" } },
  },
  ...overrides,
});

describe("evidence freshness", () => {
  it("UX-034 marks a passed Run stale when the test or source moved on, keeping the verdict", () => {
    const stale = describeFreshness(run(), {
      testRevisionId: "rev-new",
      environmentRevisionId: "env-bbbbbbbbbbbbbbbbbbbb",
      commitSha: "deadbeef",
    });
    expect(stale.state).toBe("stale");
    expect(stale.headline).toContain("Passed at revision");
    expect(stale.headline).toContain("test revision, source commit");
    expect(stale.findings.map((finding) => [finding.dimension, finding.state])).toEqual([
      ["test revision", "stale"],
      ["environment revision", "current"],
      ["source commit", "stale"],
    ]);
    // Negative control: identical context is current and says so.
    const current = describeFreshness(run(), {
      testRevisionId: "rev-aaaaaaaaaaaaaaaaaaaa",
      environmentRevisionId: "env-bbbbbbbbbbbbbbbbbbbb",
      commitSha: "c0ffee",
    });
    expect(current.state).toBe("current");
    expect(current.headline).toContain("Matches the current state");
    expect(current.headline).not.toContain("Stale");
  });

  it("UX-034 a dimension that could not be loaded is unknown, never current", () => {
    const unknown = describeFreshness(run(), { environmentRevisionId: "env-bbbbbbbbbbbbbbbbbbbb" });
    expect(unknown.state).toBe("unknown");
    expect(unknown.findings[0]).toMatchObject({ dimension: "test revision", state: "unknown" });
    expect(unknown.headline).toContain("could not be verified");
    // A Run with no recorded commit cannot be called current for a commit either.
    const noCommit = describeFreshness(run({ matrixCell: {} }), {
      testRevisionId: "rev-aaaaaaaaaaaaaaaaaaaa",
      environmentRevisionId: "env-bbbbbbbbbbbbbbbbbbbb",
      commitSha: "c0ffee",
    });
    expect(noCommit.findings.at(-1)).toMatchObject({
      dimension: "source commit",
      state: "unknown",
    });
    expect(noCommit.state).toBe("unknown");
    // Stale outranks unknown: a known change is never hidden by a missing lookup.
    expect(describeFreshness(run(), { testRevisionId: "rev-new" }).state).toBe("stale");
  });
});

const receipt = (overrides: Partial<BatchReceiptLike> = {}): BatchReceiptLike => ({
  batchId: "bat-1",
  requested: 2,
  accepted: 2,
  notDispatched: [],
  allMembers: ["tst-1:staging", "tst-2:staging"],
  counts: {},
  gate: "passed",
  ...overrides,
});

describe("batch matrix and comparison grouping", () => {
  it("UX-036 a batch with every member present is complete; a missing or undispatched member makes it incomplete", () => {
    const runs = [
      run({ id: "r1", testId: "tst-1" }),
      run({ id: "r2", testId: "tst-2", outcome: "failed", status: "failed" }),
    ];
    const complete = buildMatrix(receipt(), runs);
    expect(complete.completeness).toBe("complete");
    expect(complete.columns).toEqual(["staging"]);
    expect(complete.rows.map((row) => row.testId)).toEqual(["tst-1", "tst-2"]);
    expect(complete.summary).toMatchObject({ passed: 1, failed: 1, inFlight: 0 });
    expect(complete.headline).toBe("2 Runs, gate passed.");

    const incomplete = buildMatrix(
      receipt({
        gate: "not_applicable",
        notDispatched: [{ memberKey: "tst-2:staging", reasonCode: "quarantined" }],
      }),
      runs.slice(0, 1),
    );
    expect(incomplete.completeness).toBe("incomplete");
    expect(incomplete.missingRuns).toBe(1);
    expect(incomplete.notDispatched).toEqual([
      { memberKey: "tst-2:staging", reasonCode: "quarantined" },
    ]);
    expect(incomplete.headline).toContain("Incomplete");
    expect(incomplete.headline).toContain("describes only the Runs that exist");
  });

  it("UX-036 repetitions of one pair share a cell, ordered by repetition, and in-flight Runs are counted", () => {
    const matrix = buildMatrix(receipt({ allMembers: ["a", "b", "c"] }), [
      run({ id: "r-late", matrixCell: { environmentName: "staging", repetitionIndex: 1 } }),
      run({ id: "r-early", matrixCell: { environmentName: "staging", repetitionIndex: 0 } }),
      run({
        id: "r-live",
        outcome: null,
        phase: "running",
        status: "running",
        testId: "tst-2",
        matrixCell: { environmentName: "staging", repetitionIndex: 0 },
      }),
    ]);
    expect(matrix.rows[0]?.cells.staging?.runs.map((item) => item.id)).toEqual([
      "r-early",
      "r-late",
    ]);
    expect(matrix.summary.inFlight).toBe(1);
    // Negative control: a different test never lands in the first row's cell.
    expect(matrix.rows[1]?.cells.staging?.runs.map((item) => item.id)).toEqual(["r-live"]);
  });

  it("UX-035 groups comparison differences by the part of the Run they describe", () => {
    const groups = groupDifferences([
      { field: "environment.baseUrl", left: "a", right: "b" },
      { field: "steps[0].status", left: "passed", right: "failed" },
      { field: "environment.name", left: "x", right: "y" },
      { field: "", left: 1, right: 2 },
    ]);
    expect(groups.map((group) => [group.group, group.items.length])).toEqual([
      ["environment", 2],
      ["steps", 1],
      ["other", 1],
    ]);
    // Negative control: no differences produce no group, so nothing reads as "different".
    expect(groupDifferences([])).toEqual([]);
  });
});

const flake = (overrides: Partial<FlakeReport> = {}): FlakeReport => ({
  batchId: "bat-1",
  testId: "tst-1",
  revisionId: "rev-1",
  environmentRevisionId: "env-1",
  counts: {
    nPlanned: 10,
    nPass: 10,
    nFail: 0,
    nBlocked: 0,
    nCancelled: 0,
    nInconclusive: 0,
    nValid: 10,
    nInFlight: 0,
  },
  failureRate: 0,
  wilson95: { low: 0, high: 0.2775 },
  zeroFailureUpper95: 0.2589,
  classification: "passing_observed",
  runIds: [],
  failureCauses: [],
  limitations: [],
  incompatible: [],
  ...overrides,
});

describe("flaky-study wording", () => {
  it("UX-037 ten passes never read as stable and print the 95% upper bound beside the verdict", () => {
    const summary = describeFlake(flake());
    const text = `${summary.label} ${summary.explanation} ${summary.interval}`;
    expect(text).not.toMatch(/\bstable\b/i);
    expect(summary.label).toBe("No failure observed");
    expect(summary.explanation).toContain("not proof of stability");
    expect(summary.explanation).toContain("as high as 25.9% (95% upper bound)");
    expect(summary.interval).toContain("0.0% to 27.8%");
    expect(summary.explanation).toContain("10 passed and 0 failed out of 10 valid Runs");

    const insufficient = describeFlake(
      flake({
        classification: "insufficient_data",
        counts: { ...flake().counts, nValid: 3, nPass: 3 },
      }),
    );
    expect(insufficient.explanation).toContain("Too few valid Runs");
    expect(insufficient.explanation).toContain("95% upper bound");
    expect(`${insufficient.label} ${insufficient.explanation}`).not.toMatch(/\bstable\b/i);
  });

  it("UX-037 without a zero-failure bound or interval the wording does not invent either", () => {
    const failing = describeFlake(
      flake({
        classification: "deterministic_failure",
        zeroFailureUpper95: null,
        wilson95: { low: 0.72, high: 1 },
        counts: { ...flake().counts, nPass: 0, nFail: 10 },
      }),
    );
    expect(failing.explanation).not.toContain("upper bound");
    expect(failing.tone).toBe("danger");
    expect(failing.interval).toContain("72.0% to 100.0%");
    const nothing = describeFlake(
      flake({ classification: "insufficient_data", wilson95: null, zeroFailureUpper95: null }),
    );
    expect(nothing.interval).toBe("No interval yet: no valid Run has finished.");
    expect(nothing.explanation).not.toContain("upper bound");
    expect(describeFlake(flake({ classification: "confirmed_flaky" })).tone).toBe("danger");
  });
});
