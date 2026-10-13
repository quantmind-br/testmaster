import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { Application } from "./application.js";
import { scaffoldPlan } from "./authoring.js";
import { seedRun } from "./run-seed.testing.js";

const roots: string[] = [];
const applications: Application[] = [];
afterEach(async () => {
  for (const app of applications.splice(0)) app.close();
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "tm-run-views-"));
  roots.push(root);
  await mkdir(join(root, "home"));
  const app = await Application.open({ cwd: root, home: join(root, "home"), env: {} });
  applications.push(app);
  const init = await app.init();
  const test = app.tests.create({ projectId: init.projectId, plan: scaffoldPlan("backend") });
  return { app, init, test };
}

describe("run views", () => {
  it("UX-029 Attempts keep their number, pinned policy and the reason each retry exists", async () => {
    const { app, init, test } = await fixture();
    const diagnostic = await seedRun(app, {
      testId: test.id,
      environmentId: init.environmentId,
      attempts: [
        {
          outcome: "failed",
          steps: [{ stepId: "step-1", status: "failed", reasonCode: "assertion_mismatch" }],
        },
        { outcome: "passed", steps: [{ stepId: "step-1", status: "passed" }] },
      ],
    });
    const attempts = app.runViews.attempts(diagnostic.runId);
    expect(attempts.map((attempt) => attempt.number)).toEqual([1, 2]);
    expect(attempts[0]).toMatchObject({ kind: "initial", retry: null, outcome: "failed" });
    expect(attempts[1]).toMatchObject({
      kind: "retry",
      outcome: "passed",
      retry: {
        previousAttemptId: attempts[0]?.id,
        previousOutcome: "failed",
        category: "diagnostic",
        reasonCode: "assertion_mismatch",
      },
    });
    // The policy is the Run's pinned ceiling, identical on every Attempt.
    expect(attempts.map((attempt) => attempt.policy.maxAttempts)).toEqual([2, 2]);

    const infrastructure = await seedRun(app, {
      testId: test.id,
      environmentId: init.environmentId,
      attempts: [{ outcome: "inconclusive", leaseExpired: true }, { outcome: "passed" }],
    });
    const recovered = app.runViews.attempts(infrastructure.runId);
    expect(recovered[1]?.retry).toMatchObject({
      category: "infrastructure",
      previousOutcome: "inconclusive",
      reasonCode: "worker_lost",
    });
    // Negative control: a Run that never retried reports a single initial Attempt without a reason.
    const single = await seedRun(app, {
      testId: test.id,
      environmentId: init.environmentId,
      request: { limits: { maxAttempts: 1 } },
      attempts: [{ outcome: "passed" }],
    });
    expect(app.runViews.attempts(single.runId)).toMatchObject([
      { kind: "initial", retry: null, policy: { maxAttempts: 1 } },
    ]);
  }, 60_000);

  it("UX-040 healing proposals are listed only for the Run they were proposed for", async () => {
    const { app, init, test } = await fixture();
    const first = await seedRun(app, {
      testId: test.id,
      environmentId: init.environmentId,
      attempts: [{ outcome: "passed" }],
    });
    expect(app.runViews.healingProposals(first.runId)).toEqual([]);
    expect(() => app.runViews.healingProposals("run_missing")).toThrow();
  }, 60_000);

  it("VAL-007 quarantine never improves first-attempt or terminal rates and stays visible", async () => {
    const { app, init, test } = await fixture();
    const flaky = app.tests.create({ projectId: init.projectId, plan: scaffoldPlan("backend") });
    for (const outcome of ["passed", "failed", "passed"] as const)
      await seedRun(app, {
        testId: test.id,
        environmentId: init.environmentId,
        attempts: [{ outcome }],
      });
    for (const outcome of ["failed", "failed"] as const)
      await seedRun(app, {
        testId: flaky.id,
        environmentId: init.environmentId,
        attempts: [{ outcome }],
      });
    const before = await app.runViews.metrics(init.projectId);
    expect(before.considered).toBe(5);
    expect(before.quarantined).toEqual([]);
    expect(before.metrics.rates.terminalPassRate).toMatchObject({ numerator: 2, denominator: 5 });
    expect(before.metrics.rates.strictPassRate).toMatchObject({ numerator: 2, denominator: 5 });

    app.quarantine.set(flaky.id, {
      reason: "known flaky dependency",
      expiresAt: new Date(Date.now() + 86_400_000).toISOString(),
    });
    const after = await app.runViews.metrics(init.projectId);
    expect(after.metrics.rates.terminalPassRate).toEqual(before.metrics.rates.terminalPassRate);
    expect(after.metrics.rates.strictPassRate).toEqual(before.metrics.rates.strictPassRate);
    expect(after.metrics.rates.gatePassRate).toEqual(before.metrics.rates.gatePassRate);
    expect(after.quarantined).toEqual([
      expect.objectContaining({
        testId: flaky.id,
        active: true,
        runsInWindow: 2,
        failedRunsInWindow: 2,
        reason: "known flaky dependency",
      }),
    ]);
    expect(after.limitations.join(" ")).toContain("Quarantine never removes a Run");
  }, 60_000);

  it("VAL-007 the dashboard window is bounded and an inverted window is refused", async () => {
    const { app, init, test } = await fixture();
    for (let index = 0; index < 3; index++)
      await seedRun(app, {
        testId: test.id,
        environmentId: init.environmentId,
        attempts: [{ outcome: "passed" }],
      });
    const capped = await app.runViews.metrics(init.projectId, { limit: 2 });
    expect(capped).toMatchObject({ considered: 2, truncated: true });
    const future = await app.runViews.metrics(init.projectId, {
      since: new Date(Date.now() + 60_000).toISOString(),
      until: new Date(Date.now() + 120_000).toISOString(),
    });
    expect(future.considered).toBe(0);
    await expect(
      app.runViews.metrics(init.projectId, {
        since: "2030-01-02T00:00:00.000Z",
        until: "2030-01-01T00:00:00.000Z",
      }),
    ).rejects.toMatchObject({ code: "INVALID_ARGUMENT" });
  }, 60_000);
});
