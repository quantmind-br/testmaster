import { randomUUID } from "node:crypto";
import { defaults } from "@testmaster/contracts";
import { afterEach, expect, it, vi } from "vitest";
import { addWorkspace, type OpsStack, opsStack, seedRun } from "./ops.testkit.js";

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  vi.useRealTimers();
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

const dayMs = 86_400_000;
const now = new Date("2026-10-20T12:00:00.000Z");
const daysAgo = (days: number): string => new Date(now.getTime() - days * dayMs).toISOString();

const db = (stack: OpsStack) => stack.application.controllerScope().database;
const count = (stack: OpsStack, table: string, id: string, ws: string): number =>
  Number(
    db(stack).get<{ n: number }>(
      `SELECT COUNT(*) AS n FROM ${table} WHERE workspace_id=? AND id=?`,
      ws,
      id,
    )?.n,
  );
function insertAudit(stack: OpsStack, timestamp: string, ws: string): string {
  const id = `aud_seed_${randomUUID()}`;
  db(stack).run(
    "INSERT INTO audit_events(workspace_id,id,created_at,actor,action,resource_id,request_id,timestamp) VALUES(?,?,?,?,?,?,?,?)",
    ws,
    id,
    timestamp,
    "usr_seed",
    "seed.event",
    "res_seed",
    "req_seed",
    timestamp,
  );
  return id;
}

it("SEC-037 OPS-021 the registered retention controller enforces the declared 90-day metadata and 365-day audit windows in every workspace on the real clock", async () => {
  const stack = await opsStack();
  cleanups.push(() => stack.cleanup());
  const other = addWorkspace(stack, "Other", "other-owner");
  expect(defaults.metadataRetentionDays).toBe(90);
  expect(defaults.auditRetentionDays).toBe(365);
  const seed = (ws: string, ageDays: number) => {
    const at = daysAgo(ageDays);
    return seedRun(stack, { createdAt: at, endedAt: at, outcome: "passed", workspaceId: ws });
  };
  const runs = {
    mineExpired: seed(stack.workspaceId, 91),
    mineInside: seed(stack.workspaceId, 89),
    otherExpired: seed(other, 120),
    otherInside: seed(other, 10),
  };
  const audit = {
    mineExpired: insertAudit(stack, daysAgo(366), stack.workspaceId),
    mineInside: insertAudit(stack, daysAgo(364), stack.workspaceId),
    otherExpired: insertAudit(stack, daysAgo(400), other),
    otherInside: insertAudit(stack, daysAgo(30), other),
  };

  // The enforcement path is the server profile's own controller, not a hand-called service method.
  const controller = stack.application.controllers
    .list("server")
    .find((c) => c.name === "retention-purge");
  expect(controller).toBeDefined();
  expect(stack.application.controllers.list("local").map((c) => c.name)).not.toContain(
    "retention-purge",
  );
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(now);
  await controller?.run(stack.application.controllerScope(), new AbortController().signal);

  const present = (table: string, id: string, ws: string) => count(stack, table, id, ws);
  // Positive: what is older than the declared window is gone, in both organizations.
  expect(present("runs", runs.mineExpired.runId, stack.workspaceId)).toBe(0);
  expect(present("runs", runs.otherExpired.runId, other)).toBe(0);
  expect(present("audit_events", audit.mineExpired, stack.workspaceId)).toBe(0);
  expect(present("audit_events", audit.otherExpired, other)).toBe(0);
  // Negative: everything inside the window stays.
  expect(present("runs", runs.mineInside.runId, stack.workspaceId)).toBe(1);
  expect(present("runs", runs.otherInside.runId, other)).toBe(1);
  expect(present("audit_events", audit.mineInside, stack.workspaceId)).toBe(1);
  expect(present("audit_events", audit.otherInside, other)).toBe(1);
  // Each organization's audit purge leaves its own signed summary.
  for (const ws of [stack.workspaceId, other])
    expect(
      Number(
        db(stack).get<{ n: number }>(
          "SELECT COUNT(*) AS n FROM audit_purge_summaries WHERE workspace_id=?",
          ws,
        )?.n,
      ),
    ).toBe(1);
});

it("SEC-037 OPS-021 a legal hold on one workspace keeps its rows through the controller while another workspace is purged", async () => {
  const stack = await opsStack();
  cleanups.push(() => stack.cleanup());
  const other = addWorkspace(stack, "Held", "held-owner");
  const old = daysAgo(200);
  const mine = seedRun(stack, { createdAt: old, endedAt: old, outcome: "passed" });
  const held = seedRun(stack, {
    createdAt: old,
    endedAt: old,
    outcome: "passed",
    workspaceId: other,
  });
  const heldAudit = insertAudit(stack, daysAgo(500), other);
  db(stack).run(
    "INSERT INTO operational_state(key,value) VALUES(?,?)",
    `retention:legal-hold:${other}`,
    "case-9",
  );
  const controller = stack.application.controllers
    .list("server")
    .find((c) => c.name === "retention-purge");
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(now);
  await controller?.run(stack.application.controllerScope(), new AbortController().signal);
  expect(count(stack, "runs", mine.runId, stack.workspaceId)).toBe(0);
  expect(count(stack, "runs", held.runId, other)).toBe(1);
  expect(count(stack, "audit_events", heldAudit, other)).toBe(1);
});
