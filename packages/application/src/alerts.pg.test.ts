import { readFile } from "node:fs/promises";
import { afterEach, expect, it } from "vitest";
import { type AlertProbes, alertRuleCatalog, alertRules } from "./alerts.js";
import { addWorkspace, type OpsStack, opsStack, seedRun } from "./ops.testkit.js";

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

async function freshStack(): Promise<OpsStack> {
  const stack = await opsStack();
  cleanups.push(() => stack.cleanup());
  return stack;
}
const db = (stack: OpsStack) => stack.application.controllerScope().database;
const ago = (now: Date, minutes: number): string =>
  new Date(now.getTime() - minutes * 60_000).toISOString();
const healthy: AlertProbes = { storageUsedFraction: async () => 0.1, auditWritable: () => true };
const total = (stack: OpsStack, sql: string, ...values: unknown[]): number =>
  Number(db(stack).get<{ n: number }>(sql, stack.workspaceId, ...values)?.n);

function liveWorker(stack: OpsStack, now: Date): void {
  db(stack).run(
    "INSERT INTO workers(workspace_id,id,created_at,state,last_heartbeat_at) VALUES(?,?,?,?,?)",
    stack.workspaceId,
    `wrk_seed_${Math.random().toString(36).slice(2)}`,
    now.toISOString(),
    "ready",
    now.toISOString(),
  );
}
function queuedJob(stack: OpsStack, id: string, availableAt: string, state = "queued"): void {
  db(stack).run(
    "INSERT INTO job_leases(workspace_id,id,created_at,queue,resource_id,state,available_at) VALUES(?,?,?,?,?,?,?)",
    stack.workspaceId,
    id,
    availableAt,
    "local",
    `res_${id}`,
    state,
    availableAt,
  );
}
function deadLetterJob(stack: OpsStack, id: string): void {
  db(stack).run(
    "INSERT INTO job_leases(workspace_id,id,created_at,queue,resource_id,state,available_at,fence,attempts,data_json) VALUES(?,?,?,?,?,?,?,?,?,?)",
    stack.workspaceId,
    id,
    "2026-10-01T00:00:00.000Z",
    "analysis",
    `res_${id}`,
    "completed",
    "2026-10-01T00:00:00.000Z",
    1,
    3,
    JSON.stringify({ payload: {}, progress: {}, result: { state: "dead_letter" } }),
  );
}
function auditEvent(stack: OpsStack, action: string, timestamp: string): void {
  db(stack).run(
    "INSERT INTO audit_events(workspace_id,id,created_at,actor,action,resource_id,request_id,timestamp) VALUES(?,?,?,?,?,?,?,?)",
    stack.workspaceId,
    `aud_seed_${Math.random().toString(36).slice(2)}`,
    timestamp,
    "usr_seed",
    action,
    "res_seed",
    "req_seed",
    timestamp,
  );
}
function setState(stack: OpsStack, key: string, value: unknown): void {
  db(stack).run(
    "INSERT INTO operational_state(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value",
    key,
    JSON.stringify(value),
  );
}

interface Scenario {
  /** Creates the synthetic condition; returns probes that make it visible. */
  raise(stack: OpsStack, now: Date): AlertProbes | Promise<AlertProbes>;
  /** Removes the condition; returns the evaluation time and probes of the recovery pass. */
  clear(
    stack: OpsStack,
    now: Date,
  ): { now: Date; probes: AlertProbes } | Promise<{ now: Date; probes: AlertProbes }>;
}
const later = (now: Date, minutes: number): Date => new Date(now.getTime() + minutes * 60_000);

const scenarios: Record<string, Scenario> = {
  lease_expirations_abnormal: {
    raise(stack, now) {
      for (let index = 0; index < 3; index++)
        seedRun(stack, {
          createdAt: ago(now, 5),
          endedAt: ago(now, 5),
          outcome: "failed",
          leaseExpired: true,
        });
      return healthy;
    },
    clear: (_stack, now) => ({ now: later(now, 16), probes: healthy }),
  },
  queue_age_high: {
    raise(stack, now) {
      liveWorker(stack, now);
      queuedJob(stack, "job_old", ago(now, 10));
      return healthy;
    },
    clear(stack, now) {
      db(stack).run(
        "UPDATE job_leases SET state='cancelled' WHERE workspace_id=? AND id='job_old'",
        stack.workspaceId,
      );
      return { now, probes: healthy };
    },
  },
  storage_warning: {
    raise: () => ({ ...healthy, storageUsedFraction: async () => 0.85 }),
    clear: (_stack, now) => ({ now, probes: healthy }),
  },
  storage_critical: {
    raise: () => ({ ...healthy, storageUsedFraction: async () => 0.95 }),
    clear: (_stack, now) => ({ now, probes: healthy }),
  },
  backup_failing: {
    raise(stack, now) {
      setState(stack, "backup:last-failure", { at: ago(now, 60) });
      return healthy;
    },
    clear(stack, now) {
      setState(stack, "backup:last-success", { at: now.toISOString() });
      return { now: later(now, 1), probes: healthy };
    },
  },
  dlq_not_empty: {
    raise(stack) {
      deadLetterJob(stack, "job_dead");
      return healthy;
    },
    clear(stack, now) {
      db(stack).run(
        "UPDATE job_leases SET state='queued',data_json='{}' WHERE workspace_id=? AND id='job_dead'",
        stack.workspaceId,
      );
      return { now, probes: healthy };
    },
  },
  audit_unavailable: {
    raise: () => ({ ...healthy, auditWritable: () => false }),
    clear: (_stack, now) => ({ now, probes: healthy }),
  },
  cancellation_stuck: {
    raise(stack, now) {
      liveWorker(stack, now);
      const run = seedRun(stack, { createdAt: ago(now, 20) });
      db(stack).run(
        "INSERT INTO outbox(workspace_id,id,created_at,aggregate_id,seq,type,payload_ref,data_json,delivery_state) VALUES(?,?,?,?,?,?,?,?,?)",
        stack.workspaceId,
        "evt_cancel_stuck",
        ago(now, 10),
        run.runId,
        0,
        "run.cancel_requested",
        "evt_cancel_stuck",
        "{}",
        "delivered",
      );
      setState(stack, "test:stuck-run", run.runId);
      return healthy;
    },
    clear(stack, now) {
      db(stack).run(
        "UPDATE runs SET phase='completed',status='cancelled',outcome='cancelled' WHERE workspace_id=? AND phase='running'",
        stack.workspaceId,
      );
      return { now, probes: healthy };
    },
  },
  tenant_violation: {
    raise(stack, now) {
      auditEvent(stack, "tenant.violation.denied", ago(now, 5));
      return healthy;
    },
    clear: (_stack, now) => ({ now: later(now, 16), probes: healthy }),
  },
  egress_denied: {
    raise(stack, now) {
      seedRun(stack, {
        createdAt: ago(now, 5),
        endedAt: ago(now, 5),
        outcome: "blocked",
        reasonCode: "egress_denied",
      });
      return healthy;
    },
    clear: (_stack, now) => ({ now: later(now, 16), probes: healthy }),
  },
};

it("OPS-028 defines an alert rule for every required condition with an owner, severity and runbook anchor", async () => {
  const ids = alertRules().map((rule) => rule.id);
  expect(ids.sort()).toEqual(Object.keys(scenarios).sort());
  const runbooks = await readFile(
    new URL("../../../docs/operations/alerts.md", import.meta.url),
    "utf8",
  );
  for (const rule of alertRules()) {
    expect(rule.owner, rule.id).toMatch(/^(platform-operator|security-owner|workspace-admin)$/);
    expect(rule.runbook).toBe(`docs/operations/alerts.md#${rule.id}`);
    expect(runbooks, `${rule.id} runbook section`).toMatch(new RegExp(`^## ${rule.id}$`, "m"));
    expect(rule.threshold, rule.id).toBeTruthy();
  }
});

async function firesAndResolves(rule: string): Promise<void> {
  const scenario = scenarios[rule];
  if (!scenario) throw new Error(`No scenario for ${rule}`);
  const stack = await freshStack();
  const now = new Date();
  expect((await stack.workspace.alerts.evaluate({ now, ...healthy })).fired).toEqual([]);

  const probes = await scenario.raise(stack, now);
  const raised = await stack.workspace.alerts.evaluate({ now, ...probes });
  expect(raised.errors).toEqual({});
  const alert = raised.fired.find((candidate) => candidate.rule === rule);
  expect(alert, `${rule} must fire`).toBeDefined();
  expect(alert).toMatchObject({
    state: "firing",
    owner: alertRuleCatalog[rule]?.owner,
    severity: alertRuleCatalog[rule]?.severity,
    runbook: `docs/operations/alerts.md#${rule}`,
  });
  const event = db(stack).get<{ aggregate_id: string; data_json: string }>(
    "SELECT aggregate_id,data_json FROM outbox WHERE workspace_id=? AND type='alert.fired' AND aggregate_id=?",
    stack.workspaceId,
    alert?.id,
  );
  expect(JSON.parse(String(event?.data_json))).toMatchObject({ alertId: alert?.id, rule });
  expect(
    total(
      stack,
      "SELECT COUNT(*) AS n FROM audit_events WHERE workspace_id=? AND action='alert.fired.allowed' AND resource_id=?",
      alert?.id,
    ),
  ).toBe(1);

  const cleared = await scenario.clear(stack, now);
  const recovery = await stack.workspace.alerts.evaluate({ now: cleared.now, ...cleared.probes });
  expect(recovery.resolved, `${rule} must resolve`).toContain(alert?.id);
  expect(stack.workspace.alerts.list({ state: "resolved" }).map((item) => item.id)).toContain(
    alert?.id,
  );
}

it("OPS-028 lease_expirations_abnormal fires from a synthetic condition with its outbox event and audit row, then resolves", () =>
  firesAndResolves("lease_expirations_abnormal"));
it("OPS-028 queue_age_high fires from a synthetic condition with its outbox event and audit row, then resolves", () =>
  firesAndResolves("queue_age_high"));
it("OPS-028 storage_warning fires from a synthetic condition with its outbox event and audit row, then resolves", () =>
  firesAndResolves("storage_warning"));
it("OPS-028 storage_critical fires from a synthetic condition with its outbox event and audit row, then resolves", () =>
  firesAndResolves("storage_critical"));
it("OPS-028 backup_failing fires from a synthetic condition with its outbox event and audit row, then resolves", () =>
  firesAndResolves("backup_failing"));
it("OPS-028 dlq_not_empty fires from a synthetic condition with its outbox event and audit row, then resolves", () =>
  firesAndResolves("dlq_not_empty"));
it("OPS-028 audit_unavailable fires from a synthetic condition with its outbox event and audit row, then resolves", () =>
  firesAndResolves("audit_unavailable"));
it("OPS-028 cancellation_stuck fires from a synthetic condition with its outbox event and audit row, then resolves", () =>
  firesAndResolves("cancellation_stuck"));
it("OPS-028 tenant_violation fires from a synthetic condition with its outbox event and audit row, then resolves", () =>
  firesAndResolves("tenant_violation"));
it("OPS-028 egress_denied fires from a synthetic condition with its outbox event and audit row, then resolves", () =>
  firesAndResolves("egress_denied"));

it("OPS-028 stays quiet on a healthy deployment and below every threshold", async () => {
  const stack = await freshStack();
  const now = new Date();
  seedRun(stack, {
    createdAt: ago(now, 5),
    endedAt: ago(now, 5),
    outcome: "failed",
    leaseExpired: true,
  });
  seedRun(stack, {
    createdAt: ago(now, 5),
    endedAt: ago(now, 5),
    outcome: "failed",
    leaseExpired: true,
  });
  // A stale queued job without a live worker is a platform outage, not a queue-age alert.
  queuedJob(stack, "job_waiting", ago(now, 60));
  setState(stack, "backup:last-failure", { at: ago(now, 60) });
  setState(stack, "backup:last-success", { at: ago(now, 30) });
  const quiet = await stack.workspace.alerts.evaluate({
    now,
    ...healthy,
    storageUsedFraction: async () => 0.79,
  });
  expect(quiet).toEqual({ fired: [], resolved: [], errors: {} });
  liveWorker(stack, now);
  db(stack).run(
    "UPDATE job_leases SET available_at=? WHERE workspace_id=? AND id='job_waiting'",
    ago(now, 1),
    stack.workspaceId,
  );
  const fresh = await stack.workspace.alerts.evaluate({ now, ...healthy });
  expect(fresh.fired).toEqual([]);
  expect(
    total(stack, "SELECT COUNT(*) AS n FROM outbox WHERE workspace_id=? AND type='alert.fired'"),
  ).toBe(0);
});

it("OPS-028 raises one alert per condition, refreshes it, keeps acknowledgement and never hides a failing rule", async () => {
  const stack = await freshStack();
  const now = new Date();
  const critical = { ...healthy, storageUsedFraction: async () => 0.95 };
  const first = await stack.workspace.alerts.evaluate({ now, ...critical });
  const second = await stack.workspace.alerts.evaluate({ now: later(now, 1), ...critical });
  expect(first.fired).toHaveLength(1);
  expect(second.fired).toEqual([]);
  const open = stack.workspace.alerts.list({ state: "firing" });
  expect(open).toHaveLength(1);
  expect(open[0]?.lastSeenAt).toBe(later(now, 1).toISOString());
  expect(
    total(stack, "SELECT COUNT(*) AS n FROM outbox WHERE workspace_id=? AND type='alert.fired'"),
  ).toBe(1);

  const acknowledged = stack.workspace.alerts.acknowledge(String(open[0]?.id));
  expect(acknowledged.state).toBe("acknowledged");
  expect(() => stack.workspace.alerts.acknowledge(String(open[0]?.id))).toThrowError(
    expect.objectContaining({ code: "PRECONDITION_FAILED" }),
  );
  await stack.workspace.alerts.evaluate({ now: later(now, 2), ...critical });
  expect(stack.workspace.alerts.list().find((item) => item.id === open[0]?.id)).toMatchObject({
    state: "acknowledged",
    acknowledgedBy: expect.any(String),
  });

  // A probe that fails is reported and the open alert is kept: no evidence is not recovery.
  const broken = await stack.workspace.alerts.evaluate({
    now: later(now, 3),
    ...healthy,
    storageUsedFraction: async () => {
      throw new Error("statfs unavailable");
    },
  });
  expect(Object.keys(broken.errors).sort()).toEqual(["storage_critical", "storage_warning"]);
  expect(broken.resolved).toEqual([]);
  expect(stack.workspace.alerts.list().find((item) => item.id === open[0]?.id)?.state).toBe(
    "acknowledged",
  );
});

it("OPS-028 evaluates each workspace on its own findings", async () => {
  const stack = await freshStack();
  const otherId = addWorkspace(stack, "Other", "other-owner");
  const now = new Date();
  for (let index = 0; index < 3; index++)
    seedRun(stack, {
      createdAt: ago(now, 5),
      endedAt: ago(now, 5),
      outcome: "failed",
      leaseExpired: true,
    });
  const mine = await stack.workspace.alerts.evaluate({ now, ...healthy });
  const theirs = await stack.application
    .forWorkspaceSystem(otherId)
    .alerts.evaluate({ now, ...healthy });
  expect(mine.fired.map((alert) => alert.rule)).toEqual(["lease_expirations_abnormal"]);
  expect(theirs.fired).toEqual([]);
  expect(stack.application.forWorkspaceSystem(otherId).alerts.list()).toEqual([]);
});
