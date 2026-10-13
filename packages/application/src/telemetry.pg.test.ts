import { afterEach, expect, it } from "vitest";
import { addWorkspace, type OpsStack, opsStack, seedRun } from "./ops.testkit.js";
import { apiLatencyBuckets, queueWaitBuckets } from "./telemetry.js";

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});
async function freshStack(options: Parameters<typeof opsStack>[0] = {}): Promise<OpsStack> {
  const stack = await opsStack(options);
  cleanups.push(() => stack.cleanup());
  return stack;
}
const now = new Date("2026-10-20T12:00:00.000Z");
const day = (daysAgo: number, seconds = 0): string =>
  new Date(now.getTime() - daysAgo * 86_400_000 + seconds * 1000).toISOString();

function indicator(stack: OpsStack, id: string, at = now) {
  const found = stack.workspace.telemetry.slo(at).indicators.find((item) => item.id === id);
  if (!found) throw new Error(`Missing SLO indicator ${id}`);
  return found;
}

it("NFR-010 refuses metrics unless the telemetry policy enables them", async () => {
  const off = await freshStack();
  expect(() => off.workspace.telemetry.metricsText()).toThrowError(
    expect.objectContaining({ code: "POLICY_DENIED", details: { reasonCode: "metrics_disabled" } }),
  );
  const explicitOff = await freshStack({ telemetry: { metrics: false, logExport: "none" } });
  expect(() => explicitOff.workspace.telemetry.metricsText()).toThrowError(
    expect.objectContaining({ code: "POLICY_DENIED" }),
  );
  const on = await freshStack({ telemetry: { metrics: true, logExport: "none" } });
  const text = on.workspace.telemetry.metricsText();
  expect(text).toContain("# TYPE testmaster_api_requests_total counter");
  expect(text).toContain("testmaster_runs_active 0");
});

it("NFR-010 labels metrics without tenant identity and shows each workspace only its own counters", async () => {
  const stack = await freshStack({ telemetry: { metrics: true, logExport: "none" } });
  const otherId = addWorkspace(stack, "Globex", "globex-owner");
  seedRun(stack, { createdAt: day(1) });
  const { apiMetrics } = stack.application;
  for (let index = 0; index < 3; index++)
    apiMetrics.record({
      workspaceId: stack.workspaceId,
      method: "GET",
      route: "/v1/runs",
      status: 200,
      seconds: 0.02,
    });
  apiMetrics.record({
    workspaceId: otherId,
    method: "POST",
    route: "/v1/schedules",
    status: 503,
    seconds: 0.3,
  });

  const mine = stack.workspace.telemetry.metricsText();
  const theirs = stack.application.forWorkspaceSystem(otherId).telemetry.metricsText();
  expect(mine).toContain(
    'testmaster_api_requests_total{method="GET",route="/v1/runs",status_class="2xx"} 3',
  );
  expect(mine).toContain("testmaster_runs_active 1");
  expect(mine).not.toContain("/v1/schedules");
  expect(theirs).toContain(
    'testmaster_api_requests_total{method="POST",route="/v1/schedules",status_class="5xx"} 1',
  );
  expect(theirs).toContain("testmaster_runs_active 0");
  expect(theirs).not.toContain("/v1/runs");
  for (const text of [mine, theirs]) {
    expect(text).not.toContain(stack.workspaceId);
    expect(text).not.toContain(otherId);
    expect(text).not.toMatch(/Acme|Globex|acme-owner|globex-owner/);
    const labelNames = new Set([...text.matchAll(/[{,]([a-z_]+)="/g)].map((match) => match[1]));
    expect([...labelNames].sort()).toEqual(
      ["le", "method", "route", "state", "status_class"].filter((name) => labelNames.has(name)),
    );
  }
});

it("NFR-010 reports each SLO with its denominator, window, histogram and a proposed target kept apart from the observation", async () => {
  const stack = await freshStack();
  const empty = stack.workspace.telemetry.slo(now);
  expect(empty.indicators.map((item) => item.id)).toEqual([
    "api_availability",
    "api_latency_p95",
    "queue_wait_p95",
    "run_platform_success",
    "evidence_availability",
    "backup_freshness",
  ]);
  for (const item of empty.indicators) {
    expect(item.measurement, item.id).toBe("not_measured");
    expect(item.observed, item.id).toBeNull();
    expect(item.proposedTarget, item.id).toBeGreaterThan(0);
    expect(item.window, item.id).toBeTruthy();
  }

  // Ten Runs wait 2 s for their first attempt; one waits 90 s.
  for (let index = 0; index < 10; index++)
    seedRun(stack, {
      createdAt: day(1),
      startedAt: day(1, 2),
      endedAt: day(1, 30),
      outcome: "passed",
    });
  seedRun(stack, {
    createdAt: day(1),
    startedAt: day(1, 90),
    endedAt: day(1, 120),
    outcome: "passed",
  });
  const wait = indicator(stack, "queue_wait_p95");
  expect(wait).toMatchObject({
    measurement: "measured",
    denominator: 11,
    window: "30d",
    unit: "seconds",
  });
  expect(wait.observed).toBe(90);
  expect(wait.proposedTarget).toBe(60);
  expect(wait.buckets).toHaveLength(queueWaitBuckets.length);
  expect(wait.buckets.find((bucket) => bucket.le === 5)?.count).toBe(10);
  expect(wait.buckets.find((bucket) => bucket.le === 120)?.count).toBe(11);

  const { apiMetrics } = stack.application;
  for (let index = 0; index < 3; index++)
    apiMetrics.record({
      workspaceId: stack.workspaceId,
      method: "GET",
      route: "/v1/runs",
      status: 200,
      seconds: 0.02,
    });
  apiMetrics.record({
    workspaceId: stack.workspaceId,
    method: "GET",
    route: "/v1/runs",
    status: 503,
    seconds: 0.4,
  });
  const availability = indicator(stack, "api_availability");
  expect(availability).toMatchObject({
    numerator: 3,
    denominator: 4,
    window: "since_start",
    unit: "ratio",
  });
  expect(availability.observed).toBe(0.75);
  expect(availability.proposedTarget).toBe(0.999);
  const latency = indicator(stack, "api_latency_p95");
  expect(latency.buckets).toHaveLength(apiLatencyBuckets.length);
  expect(latency.observed).toBe(0.5);

  // Runs older than the window do not count.
  seedRun(stack, {
    createdAt: day(45),
    startedAt: day(45, 500),
    endedAt: day(45, 600),
    outcome: "passed",
  });
  expect(indicator(stack, "queue_wait_p95").denominator).toBe(11);
});

it("NFR-010 does not charge target timeouts or cancellations to the platform budget but charges lost leases", async () => {
  const stack = await freshStack();
  for (let index = 0; index < 10; index++)
    seedRun(stack, { createdAt: day(1), endedAt: day(1, 30), outcome: "passed" });
  for (const reasonCode of [
    "assertion_timeout",
    "attempt_timeout",
    "execution_timeout",
    "target_unreachable",
    "assertion_mismatch",
  ])
    seedRun(stack, { createdAt: day(1), endedAt: day(1, 30), outcome: "failed", reasonCode });
  seedRun(stack, {
    createdAt: day(1),
    endedAt: day(1, 30),
    outcome: "cancelled",
    reasonCode: "cancelled_by_user",
  });
  const apiBefore = indicator(stack, "api_availability");

  const clean = indicator(stack, "run_platform_success");
  expect(clean).toMatchObject({
    numerator: 10,
    denominator: 10,
    observed: 1,
    measurement: "measured",
  });
  expect(clean.errorBudgetRemaining).toBe(1);
  expect(indicator(stack, "api_availability")).toEqual(apiBefore);

  seedRun(stack, {
    createdAt: day(1),
    endedAt: day(1, 30),
    outcome: "inconclusive",
    leaseExpired: true,
  });
  const charged = indicator(stack, "run_platform_success");
  expect(charged).toMatchObject({ numerator: 10, denominator: 11 });
  expect(charged.observed).toBeCloseTo(10 / 11, 6);
  expect(charged.errorBudgetRemaining).toBeLessThan(0);
});

it("NFR-010 measures evidence availability and backup freshness only where they apply", async () => {
  const stack = await freshStack();
  seedRun(stack, {
    createdAt: day(1),
    endedAt: day(1, 30),
    outcome: "passed",
    artifact: "available",
  });
  seedRun(stack, {
    createdAt: day(1),
    endedAt: day(1, 30),
    outcome: "passed",
    artifact: "expired",
  });
  seedRun(stack, {
    createdAt: day(1),
    endedAt: day(1, 30),
    outcome: "passed",
    artifact: "missing",
  });
  const evidence = indicator(stack, "evidence_availability");
  expect(evidence).toMatchObject({ numerator: 1, denominator: 2, window: "current" });
  expect(indicator(stack, "backup_freshness").measurement).toBe("not_measured");
  stack.application
    .controllerScope()
    .database.run(
      "INSERT INTO operational_state(key,value) VALUES(?,?)",
      "backup:last-success",
      JSON.stringify({ at: new Date(now.getTime() - 3600_000).toISOString() }),
    );
  expect(indicator(stack, "backup_freshness")).toMatchObject({
    measurement: "measured",
    observed: 3600,
  });
  const bare = await freshStack({ backup: false });
  expect(indicator(bare, "backup_freshness").measurement).toBe("not_measured");
});
