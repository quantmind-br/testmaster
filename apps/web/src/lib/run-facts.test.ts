import { describe, expect, it } from "vitest";
import {
  announcementFor,
  buildCurrentContext,
  buildStepGroups,
  deriveRetryFacts,
  describeAttempt,
  describeCancelControl,
  describeRunFacts,
  formatDuration,
  formatServerTime,
  formatStructured,
  isTerminalEvent,
  runListBadge,
  sensitiveStepIds,
  toRunEvent,
} from "./run-facts";
import { applyEvent, applySnapshot, initialTimeline } from "./run-timeline";
import type { AttemptRecord, RunRecord, StepRecord } from "./run-types";
import { describeFreshness } from "./stale-evidence";

const baseRun: RunRecord = {
  id: "run-1",
  testId: "tst-1",
  revisionId: "rev-A",
  environmentRevisionId: "evr-A",
  batchId: null,
  mode: "replay",
  phase: "completed",
  status: "passed",
  outcome: "passed",
  origin: "api",
  gate: "passed",
  cleanupOutcome: "passed",
  analysisStatus: "not_requested",
  createdAt: "2030-01-01T00:00:00.000Z",
  version: 1,
};
const run = (patch: Partial<RunRecord>): RunRecord => ({ ...baseRun, ...patch });

function attempt(number: number, patch: Partial<AttemptRecord> = {}): AttemptRecord {
  return {
    id: `att-${number}`,
    runId: "run-1",
    number,
    workerId: null,
    phase: "completed",
    startedAt: "2030-01-01T00:00:01.000Z",
    endedAt: "2030-01-01T00:00:03.500Z",
    outcome: "passed",
    kind: number === 1 ? "initial" : "retry",
    policy: { maxAttempts: 2 },
    retry: null,
    ...patch,
  };
}

describe("run facts label", () => {
  it("UX-029 labels a Run Passed only when completed, passed, and neither cleanup nor the gate failed", () => {
    const clean = describeRunFacts(run({}), deriveRetryFacts([attempt(1)]));
    expect(clean).toMatchObject({ label: "Passed", status: "passed", passed: true });
    // Negative controls: every state that is not a clean pass must not read as Passed.
    expect(describeRunFacts(run({ cleanupOutcome: "failed" }), null)).toMatchObject({
      label: "Passed, but cleanup failed",
      status: "degraded",
      passed: false,
    });
    expect(describeRunFacts(run({ gate: "failed" }), null)).toMatchObject({
      label: "Passed, gate failed",
      passed: false,
    });
    expect(describeRunFacts(run({ gate: "failed", cleanupOutcome: "failed" }), null).label).toBe(
      "Passed, but cleanup failed and gate failed",
    );
    expect(describeRunFacts(run({ gate: "pending" }), null).label).toBe("Passed, gate pending");
    expect(describeRunFacts(run({ cleanupOutcome: "inconclusive" }), null).passed).toBe(false);
  });

  it("UX-029 a Run that is loading, running or without evidence never turns Passed with time", () => {
    expect(describeRunFacts(null, null)).toMatchObject({ label: "Not loaded", passed: false });
    for (const phase of ["queued", "preparing", "running", "collecting", "analyzing"] as const) {
      const facts = describeRunFacts(run({ phase, outcome: null, status: phase }), null);
      expect(facts.label).toBe("In progress");
      expect(facts.passed).toBe(false);
    }
    // A passed outcome on a Run that is not completed is still in progress.
    expect(describeRunFacts(run({ phase: "collecting" }), null).label).toBe("In progress");
    expect(describeRunFacts(run({ outcome: null }), null)).toMatchObject({
      label: "Finished without a verdict",
      passed: false,
    });
  });

  it("UX-029 a failed Run keeps its verdict and names a failed cleanup or gate", () => {
    const facts = describeRunFacts(
      run({ outcome: "failed", status: "failed", gate: "failed", cleanupOutcome: "failed" }),
      null,
    );
    expect(facts).toMatchObject({ label: "Failed", status: "failed", passed: false });
    expect(facts.notes).toEqual(["Cleanup failed.", "The gate failed."]);
    expect(describeRunFacts(run({ outcome: "cancelled" }), null).label).toBe("Cancelled");
  });

  it("UX-029 a list badge never shows a gate-failed pass as Passed", () => {
    expect(runListBadge(run({ gate: "failed" }))).toEqual({
      status: "degraded",
      label: "Passed, gate failed",
    });
    expect(runListBadge(run({}))).toEqual({ status: "passed" });
    expect(runListBadge(run({ outcome: "failed", status: "failed", gate: "failed" }))).toEqual({
      status: "failed",
    });
    // A list item that carries only its status follows the same rule.
    expect(runListBadge({ status: "passed", gate: "failed" }).status).toBe("degraded");
  });
});

describe("attempts and retries", () => {
  const failed = attempt(1, { outcome: "failed" });
  const diagnostic = attempt(2, {
    retry: {
      previousAttemptId: "att-1",
      previousOutcome: "failed",
      category: "diagnostic",
      reasonCode: "assertion_mismatch",
    },
  });
  const infrastructure = attempt(2, {
    retry: {
      previousAttemptId: "att-1",
      previousOutcome: "inconclusive",
      category: "infrastructure",
      reasonCode: "worker_lost",
    },
  });

  it("UX-029 each Attempt keeps its own number, policy, retry reason and result", () => {
    const both = [diagnostic, failed];
    const first = describeAttempt(failed, both);
    const second = describeAttempt(diagnostic, both);
    expect(first).toMatchObject({
      title: "Attempt 1",
      policy: "Attempt 1 of at most 2",
      origin: "Initial attempt.",
      result: "Failed",
    });
    expect(second.result).toBe("Passed");
    expect(second.origin).toBe("Diagnostic retry after attempt 1 failed (assertion mismatch).");
    // The later success did not rewrite the earlier failure.
    expect(first.result).not.toBe(second.result);
    expect(describeAttempt(attempt(3, { outcome: null, phase: "running" }), both).result).toBe(
      "In progress",
    );
  });

  it("UX-029 a diagnostic retry that passes reports firstAttemptOutcome and passedOnRetry; an infrastructure recovery does not", () => {
    const facts = deriveRetryFacts([diagnostic, failed]);
    expect(facts).toEqual({
      firstAttemptOutcome: "failed",
      passedOnRetry: true,
      infrastructureRecoveries: [],
    });
    const failedRun = describeRunFacts(
      run({ outcome: "failed", status: "failed", gate: "failed" }),
      facts,
    );
    expect(failedRun.label).toBe("Failed");
    expect(failedRun.notes.join(" ")).toContain("not proof the test is stable");
    // Negative control: infrastructure recovery is separate and never confirmed flakiness.
    const recovery = deriveRetryFacts([attempt(1, { outcome: "inconclusive" }), infrastructure]);
    expect(recovery.passedOnRetry).toBe(false);
    expect(recovery.infrastructureRecoveries).toEqual([2]);
    const passedAfterRecovery = describeRunFacts(run({}), recovery);
    expect(passedAfterRecovery.label).toBe("Passed");
    expect(passedAfterRecovery.notes.join(" ")).toContain("not confirmed flakiness");
    expect(describeAttempt(infrastructure, [attempt(1), infrastructure]).origin).toContain(
      "Not a flakiness finding.",
    );
  });

  it("UX-029 server-reduced retry facts are honoured and steps stay grouped under their own Attempt", () => {
    expect(
      deriveRetryFacts([attempt(1)], { firstAttemptOutcome: "failed", passedOnRetry: true }),
    ).toMatchObject({ firstAttemptOutcome: "failed", passedOnRetry: true });
    const step = (
      attemptId: string,
      planStepId: string,
      index: number,
      patch: Partial<StepRecord> = {},
    ): StepRecord => ({
      id: `${attemptId}-${planStepId}`,
      attemptId,
      planStepId,
      index,
      status: "passed",
      expected: { status: 200 },
      observed: { status: 200 },
      error: null,
      durationMs: 1,
      evidenceRefs: [{ relativePath: `http/${planStepId}.json`, snapshotId: "snp-1" }],
      ...patch,
    });
    const records = [
      step("att-2", "s0", 0),
      step("att-1", "s1", 1),
      step("att-1", "s0", 0, { status: "failed", observed: { status: 500 } }),
      step("att-9", "s0", 0),
    ];
    const timeline = applySnapshot(initialTimeline("run-1"), {
      run: run({}),
      steps: records,
      attempts: [diagnostic, failed],
    });
    // A live step that the fetched records do not know yet still appears, in its own Attempt.
    const live = applyEvent(
      timeline,
      toRunEvent({
        seq: 4,
        type: "step.started",
        attemptId: "att-2",
        occurredAt: "2030-01-01T00:00:04.000Z",
        payload: { stepId: "s1", index: 1 },
      }),
    );
    const groups = buildStepGroups(live, records, [diagnostic, failed]);
    expect(groups.map((group) => [group.attemptId, group.rows.map((row) => row.stepId)])).toEqual([
      ["att-1", ["s0", "s1"]],
      ["att-2", ["s0", "s1"]],
      ["att-9", ["s0"]],
    ]);
    expect(groups[0]?.rows[0]).toMatchObject({
      status: "failed",
      observed: { status: 500 },
      evidencePaths: ["http/s0.json"],
    });
    expect(groups[1]?.rows[1]).toMatchObject({ status: "running", observed: null });
    expect(groups[2]?.attempt).toBeNull();
    // Negative control: a late step.started replay never reopens a finished step.
    const replayed = applyEvent(
      live,
      toRunEvent({
        seq: 5,
        type: "step.started",
        attemptId: "att-1",
        payload: { stepId: "s0", index: 0 },
      }),
    );
    expect(buildStepGroups(replayed, records, [diagnostic, failed])[0]?.rows[0]?.status).toBe(
      "failed",
    );
  });
});

describe("cancellation and live events", () => {
  const live = run({ phase: "running", outcome: null, status: "running" });

  it("UX-028 the cancel control is enabled on a live Run and states a request apart from the terminal result", () => {
    const idle = describeCancelControl(live, initialTimeline("run-1"), null);
    expect(idle).toEqual({ enabled: true, reason: null, notice: null });
    const requested = describeCancelControl(live, initialTimeline("run-1"), {
      runId: "run-1",
      result: "requested",
      status: "running",
    });
    expect(requested.enabled).toBe(false);
    expect(requested.reason).toBe("Cancellation was already requested.");
    expect(requested.notice).toContain("has not stopped yet");
    expect(requested.notice).not.toContain("is cancelled");
  });

  it("UX-028 a finished Run disables cancel with the reason and a proven failure stays failed after a cancel request", () => {
    const timeline = [
      { seq: 0, type: "run.cancel_requested", payload: {} },
      { seq: 1, type: "run.completed", payload: { outcome: "failed" } },
    ]
      .map((event) => toRunEvent(event))
      .reduce(applyEvent, initialTimeline("run-1"));
    const control = describeCancelControl(run({ outcome: "failed" }), timeline, null);
    expect(control.enabled).toBe(false);
    expect(control.reason).toBe("The Run already finished as failed; there is nothing to cancel.");
    expect(control.notice).toContain("finished as failed");
    expect(control.notice).toContain("proven result stands");
    expect(
      describeCancelControl(baseRun, initialTimeline("run-1"), {
        runId: "run-1",
        result: "already_terminal",
        status: "passed",
      }).notice,
    ).toContain("nothing was cancelled");
    expect(describeCancelControl(null, initialTimeline("run-1"), null).enabled).toBe(false);
  });

  it("UX-027 duplicate and replayed stream events through toRunEvent never reopen a terminal Run", () => {
    const events = [
      {
        seq: 1,
        type: "run.phase_changed",
        occurredAt: "2030-01-01T00:00:02.000Z",
        payload: { phase: "running" },
      },
      {
        seq: 2,
        type: "run.completed",
        occurredAt: "2030-01-01T00:00:05.000Z",
        payload: { outcome: "failed" },
      },
    ];
    const once = events.map(toRunEvent).reduce(applyEvent, initialTimeline("run-1"));
    const replay = [...events, { seq: 1, type: "run.phase_changed", payload: { phase: "running" } }]
      .map(toRunEvent)
      .reduce(applyEvent, once);
    expect(replay.terminal).toMatchObject({ outcome: "failed" });
    expect(replay.phase).toBe("completed");
    // A later conflicting terminal event cannot replace the first result.
    const conflicting = applyEvent(
      replay,
      toRunEvent({ seq: 9, type: "run.completed", payload: { outcome: "passed" } }),
    );
    expect(conflicting.terminal?.outcome).toBe("failed");
    // Positive control: a new phase event on a live Run does move it forward.
    const advanced = applyEvent(
      initialTimeline("run-1"),
      toRunEvent({ seq: 0, type: "run.phase_changed", payload: { phase: "collecting" } }),
    );
    expect(advanced.phase).toBe("collecting");
    expect(isTerminalEvent({ seq: 2, type: "run.completed" })).toBe(true);
    expect(isTerminalEvent({ seq: 3, type: "run.phase_changed" })).toBe(false);
  });

  it("UX-026 announcements name the phase while live and the result once terminal", () => {
    const running = applyEvent(
      initialTimeline("run-1"),
      toRunEvent({ seq: 0, type: "run.phase_changed", payload: { phase: "running" } }),
    );
    expect(announcementFor(running)).toBe("Run is now running steps.");
    const done = applyEvent(
      running,
      toRunEvent({ seq: 1, type: "run.completed", payload: { outcome: "passed" } }),
    );
    expect(announcementFor(done)).toBe("Run finished as passed.");
    expect(announcementFor(done)).not.toContain("running");
  });

  it("UX-026 durations and times come from server timestamps and are shown in UTC", () => {
    expect(formatServerTime("2030-01-01T00:00:12.900Z")).toBe("2030-01-01 00:00:12 UTC");
    expect(formatServerTime(null)).toBe("—");
    expect(formatServerTime("not a date")).toBe("—");
    expect(formatDuration(850)).toBe("850 ms");
    expect(formatDuration(2500)).toBe("2.5 s");
    expect(formatDuration(125_000)).toBe("2 min 5 s");
    expect(formatDuration(null)).toBe("—");
    expect(formatDuration(-5)).toBe("—");
  });

  it("UX-031 expected and observed values render as text, strings verbatim and structures as JSON", () => {
    expect(formatStructured("<script>alert(1)</script>")).toBe("<script>alert(1)</script>");
    expect(formatStructured({ status: 200 })).toBe('{\n  "status": 200\n}');
    expect(formatStructured(null)).toBeNull();
    expect(formatStructured(undefined)).toBeNull();
  });
});

describe("freshness context", () => {
  it("UX-034 a failed lookup reads unknown, a changed revision reads stale, and history keeps its verdict", () => {
    const recorded = run({});
    const stale = describeFreshness(
      recorded,
      buildCurrentContext({ activeRevisionId: "rev-B" }, { activeRevisionId: "evr-A" }),
    );
    expect(stale.state).toBe("stale");
    expect(stale.headline).toContain("Passed at revision rev-A");
    expect(stale.findings.find((f) => f.dimension === "test revision")?.state).toBe("stale");
    expect(stale.findings.find((f) => f.dimension === "environment revision")?.state).toBe(
      "current",
    );
    // Negative controls: unchanged is current; a lookup that failed is unknown, never current.
    expect(
      describeFreshness(
        recorded,
        buildCurrentContext({ activeRevisionId: "rev-A" }, { activeRevisionId: "evr-A" }),
      ).state,
    ).toBe("current");
    const unknown = describeFreshness(recorded, buildCurrentContext(null, null));
    expect(unknown.state).toBe("unknown");
    expect(unknown.findings.every((finding) => finding.state === "unknown")).toBe(true);
    expect(
      describeFreshness(recorded, buildCurrentContext({ activeRevisionId: "rev-A" }, null)).state,
    ).toBe("unknown");
  });
});

describe("sensitive step data", () => {
  it("REQ-053 names only the steps that capture a sensitive value", () => {
    const plan = {
      steps: [
        {
          id: "login",
          operation: "request",
          input: { capture: [{ name: "token", sensitive: true }] },
        },
        {
          id: "list",
          operation: "request",
          input: { capture: [{ name: "count", sensitive: false }] },
        },
        { id: "ping", operation: "request", input: {} },
      ],
    };
    const sensitive = sensitiveStepIds(plan);
    expect(sensitive.has("login")).toBe(true);
    // Negative controls: a non-sensitive capture and a step without captures stay visible.
    expect(sensitive.has("list")).toBe(false);
    expect(sensitive.has("ping")).toBe(false);
    expect(sensitiveStepIds({ steps: [] }).size).toBe(0);
  });
});
