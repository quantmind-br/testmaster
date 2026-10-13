import { afterEach, describe, expect, it, vi } from "vitest";
import {
  applyEvent,
  applySnapshot,
  describeCancellation,
  describeStages,
  initialTimeline,
  orderedSteps,
  serverDuration,
  type TimelineState,
} from "./run-timeline";
import type { AttemptRecord, RunEventEnvelope, RunRecord, StepRecord } from "./run-types";

afterEach(() => vi.useRealTimers());

const t = (seconds: number) => new Date(Date.UTC(2030, 0, 1, 0, 0, seconds)).toISOString();
function ev(
  seq: number,
  type: string,
  seconds: number,
  payload: Record<string, unknown> = {},
  attemptId: string | null = "att-1",
): RunEventEnvelope {
  return { seq, eventId: `evt-${seq}`, type, occurredAt: t(seconds), attemptId, payload };
}
const happyPath: RunEventEnvelope[] = [
  ev(0, "run.accepted", 0, {}, null),
  ev(1, "attempt.claimed", 2, { attemptId: "att-1", number: 1 }),
  ev(2, "run.phase_changed", 3, { phase: "preparing", attemptId: "att-1" }),
  ev(3, "run.snapshot_sealed", 5),
  ev(4, "run.phase_changed", 6, { phase: "running", attemptId: "att-1" }),
  ev(5, "step.started", 7, { stepId: "login", index: 0 }),
  ev(6, "step.finished", 9, { stepId: "login", index: 0, status: "passed", durationMs: 1800 }),
  ev(7, "run.phase_changed", 10, { phase: "collecting", attemptId: "att-1" }),
  ev(8, "cleanup.finished", 11),
  ev(9, "run.completed", 12, { outcome: "passed" }),
];
const fold = (events: readonly RunEventEnvelope[], from?: TimelineState) =>
  events.reduce(applyEvent, from ?? initialTimeline("run-1"));

describe("run timeline reducer", () => {
  it("UX-026 request, dispatch, readiness, steps, collection and result advance in order from server time", () => {
    vi.useFakeTimers();
    // A wildly wrong browser clock must not change any duration.
    vi.setSystemTime(new Date("1999-01-01T00:00:00Z"));
    const queued = describeStages(fold(happyPath.slice(0, 1)));
    expect(queued.map((stage) => stage.state)).toEqual([
      "done",
      "active",
      "pending",
      "pending",
      "pending",
      "pending",
    ]);
    const running = describeStages(fold(happyPath.slice(0, 6)));
    expect(running.find((stage) => stage.key === "steps")).toMatchObject({ state: "active" });
    const done = describeStages(fold(happyPath));
    expect(done.map((stage) => stage.state)).toEqual(Array(6).fill("done"));
    expect(done.map((stage) => stage.durationMs)).toEqual([null, 2000, 3000, 1000, 4000, 2000]);
    // Negative control: a stage with a missing timestamp reports no duration instead of a guess.
    expect(describeStages(fold([ev(0, "run.accepted", 0, {}, null)])).at(1)?.durationMs).toBeNull();
    expect(serverDuration(t(5), t(2))).toBeNull();
    expect(serverDuration(null, t(2))).toBeNull();
  });

  it("VAL-034 duplicate and reordered events never regress the phase or replace the terminal result", () => {
    const ordered = fold(happyPath);
    const noisy = fold([
      ...happyPath.slice(5),
      ...happyPath,
      // A late replay of an earlier phase and a conflicting second terminal event.
      ev(10, "run.phase_changed", 13, { phase: "running", attemptId: "att-1" }),
      ev(11, "run.completed", 14, { outcome: "failed" }),
      ...happyPath.slice().reverse(),
    ]);
    expect(noisy.phase).toBe("completed");
    expect(noisy.terminal).toEqual({ outcome: "passed", at: t(12), reasonCode: null });
    expect(orderedSteps(noisy)).toEqual(orderedSteps(ordered));
    // Idempotence: re-applying any applied event returns the identical state object.
    expect(applyEvent(ordered, happyPath[4] as RunEventEnvelope)).toBe(ordered);
    // Negative control: before the terminal event the Run is still running, not completed.
    expect(fold(happyPath.slice(0, 9)).terminal).toBeNull();
    expect(fold(happyPath.slice(0, 9)).phase).toBe("collecting");
  });

  it("UX-027 a finished step is never reopened by a late step.started and keeps its server duration", () => {
    const state = fold([
      ev(0, "step.finished", 9, {
        stepId: "login",
        index: 0,
        status: "failed",
        reasonCode: "assertion_mismatch",
        durationMs: 40,
      }),
      ev(1, "step.started", 7, { stepId: "login", index: 0 }),
    ]);
    expect(orderedSteps(state)).toMatchObject([
      { stepId: "login", status: "failed", reasonCode: "assertion_mismatch", durationMs: 40 },
    ]);
    // Negative control: a step that only started is still running.
    expect(
      orderedSteps(fold([ev(0, "step.started", 7, { stepId: "a", index: 0 })]))[0]?.status,
    ).toBe("running");
  });

  it("UX-028 cancellation is reported as requested until the terminal event and never becomes a terminal result", () => {
    const requested = fold([
      ...happyPath.slice(0, 6),
      ev(
        6,
        "run.cancel_requested",
        8,
        { requestedBy: "prn-1", reasonCode: "user_cancelled" },
        null,
      ),
    ]);
    expect(requested.terminal).toBeNull();
    expect(describeCancellation(requested)?.message).toMatch(/has not stopped yet/);
    const cancelled = applyEvent(
      requested,
      ev(7, "run.completed", 9, { outcome: "cancelled" }, null),
    );
    expect(describeCancellation(cancelled)?.message).toMatch(/Run is cancelled/);
    // A proven failure that landed after the request stays failed.
    const failed = applyEvent(requested, ev(7, "run.completed", 9, { outcome: "failed" }, null));
    expect(failed.terminal?.outcome).toBe("failed");
    expect(describeCancellation(failed)?.message).toMatch(
      /finished as failed.*proven result stands/,
    );
    // Negative control: no cancel event, no cancellation message.
    expect(describeCancellation(fold(happyPath))).toBeNull();
  });

  it("UX-029 steps of a retry keep their own Attempt and number", () => {
    const state = fold([
      ev(0, "attempt.claimed", 1, { attemptId: "att-1", number: 1 }, "att-1"),
      ev(
        1,
        "step.finished",
        2,
        { stepId: "s", index: 0, status: "failed", durationMs: 5 },
        "att-1",
      ),
      ev(2, "attempt.claimed", 3, { attemptId: "att-2", number: 2 }, "att-2"),
      ev(
        3,
        "step.finished",
        4,
        { stepId: "s", index: 0, status: "passed", durationMs: 6 },
        "att-2",
      ),
    ]);
    expect(orderedSteps(state).map((step) => [step.attemptId, step.status])).toEqual([
      ["att-1", "failed"],
      ["att-2", "passed"],
    ]);
    expect(state.attempts["att-2"]?.number).toBe(2);
  });

  it("J05 a snapshot after a gap fills missing steps, keeps newer event state and never reopens a terminal result", () => {
    const run = (patch: Partial<RunRecord>): RunRecord =>
      ({
        id: "run-1",
        phase: "running",
        outcome: null,
        status: "running",
        createdAt: t(0),
        ...patch,
      }) as RunRecord;
    const step = (patch: Partial<StepRecord>): StepRecord =>
      ({
        id: "stp-1",
        attemptId: "att-1",
        planStepId: "login",
        index: 0,
        status: "passed",
        expected: null,
        observed: null,
        error: null,
        durationMs: 1800,
        evidenceRefs: [],
        ...patch,
      }) as StepRecord;
    const attempt = { id: "att-1", number: 1, startedAt: t(2) } as AttemptRecord;
    // Events stopped at seq 1; the snapshot knows the step finished and the Run is collecting.
    const gap = fold(happyPath.slice(0, 2));
    const healed = applySnapshot(gap, {
      run: run({ phase: "collecting" }),
      steps: [step({})],
      attempts: [attempt],
    });
    expect(healed.phase).toBe("collecting");
    expect(orderedSteps(healed)[0]).toMatchObject({ status: "passed", durationMs: 1800 });
    // A stale snapshot (older phase) cannot regress the live state.
    const stale = applySnapshot(fold(happyPath.slice(0, 8)), {
      run: run({ phase: "preparing" }),
      steps: [],
      attempts: [],
    });
    expect(stale.phase).toBe("collecting");
    // A completed snapshot sets the terminal result once; a later non-terminal snapshot cannot undo it.
    const completed = applySnapshot(healed, {
      run: run({ phase: "completed", outcome: "failed", status: "failed" }),
      steps: [],
      attempts: [],
    });
    expect(completed.terminal?.outcome).toBe("failed");
    const regress = applySnapshot(completed, {
      run: run({ phase: "running" }),
      steps: [],
      attempts: [],
    });
    expect(regress.terminal?.outcome).toBe("failed");
    expect(regress.phase).toBe("completed");
  });

  it("J05 a lease expiry is recorded on its Attempt without producing a verdict", () => {
    const state = fold([
      ev(0, "attempt.claimed", 1, { attemptId: "att-1", number: 1 }, "att-1"),
      ev(1, "attempt.lease_expired", 5, { jobId: "job-1", reasonCode: "worker_lost" }, "att-1"),
    ]);
    expect(state.attempts["att-1"]?.leaseExpired).toEqual({ at: t(5), reasonCode: "worker_lost" });
    expect(state.terminal).toBeNull();
  });
});
