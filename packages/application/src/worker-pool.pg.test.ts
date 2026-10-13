import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { uuidV7IdGenerator } from "@testmaster/domain";
import { LeaseRepository } from "@testmaster/persistence";
import { createTestDatabase, type TestDatabase } from "@testmaster/persistence/testing";
import { afterEach, expect, it } from "vitest";
import {
  Application,
  authenticateBearer,
  authenticateSession,
  type ServerConfig,
  scaffoldPlan,
} from "./index.js";
import { fairShareCap } from "./worker-pool.js";

const persistenceDist = pathToFileURL(
  resolve(import.meta.dirname, "../../persistence/dist/index.js"),
).href;
const password = "correct horse battery staple";

const cleanups: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

interface Tenant {
  workspaceId: string;
  scoped: Application;
  testId: string;
  environmentId: string;
  revisionId: string;
  environmentRevisionId: string;
}

/** One PostgreSQL database holding `count` workspaces, each with a project, a test and an environment. */
async function tenants(count: number) {
  const database: TestDatabase = await createTestDatabase();
  cleanups.push(() => database.drop());
  const root = await mkdtemp(join(tmpdir(), "tm-pool-pg-"));
  cleanups.push(() => rm(root, { recursive: true, force: true }));
  const home = join(root, "home");
  await mkdir(home);
  const server: ServerConfig = {
    mode: "server",
    database: { engine: "postgres", ...database.config },
    storage: { kind: "filesystem", root: join(root, "evidence") },
    server: {
      listen: { host: "127.0.0.1", port: 0 },
      publicOrigin: "https://tm.example",
      trustedProxies: [],
      origins: ["https://tm.example"],
    },
    security: {
      masterKeyFile: join(root, "master.key"),
      backupKeyFile: join(root, "backup.key"),
      atRestEncryption: { database: "operator-volume", evidence: "operator-volume" },
    },
  };
  const application = await Application.open({ cwd: root, home, env: {}, server });
  cleanups.push(() => application.close());
  const first = application.operator.bootstrap({ workspaceName: "Alpha", ownerLogin: "owner-0" });
  const operator = application.forIdentity(
    authenticateBearer(application, application.operator.operatorToken().token),
  );
  const created = [{ login: "owner-0", workspace: first.workspace, recovery: first.ownerRecovery }];
  for (let index = 1; index < count; index++) {
    const next = operator.workspaces.create({
      name: `Tenant ${index}`,
      ownerLogin: `owner-${index}`,
    });
    created.push({
      login: `owner-${index}`,
      workspace: next.workspace,
      recovery: next.ownerRecovery,
    });
  }
  const members: Tenant[] = [];
  for (const entry of created) {
    await application.identityService.recover({
      principal: entry.login,
      recoveryToken: entry.recovery.recoveryToken,
      newPassword: password,
    });
    const login = await application.identityService.login({
      principal: entry.login,
      password,
    });
    const scoped = application.forIdentity(authenticateSession(application, login.sessionToken));
    const project = scoped.projects.create({ name: `${entry.login}-project` });
    const environment = scoped.environments.create({
      projectId: project.id,
      name: "local",
      baseUrl: "http://127.0.0.1:3000",
    });
    const test = scoped.tests.create({ projectId: project.id, plan: scaffoldPlan("backend") });
    members.push({
      workspaceId: String(entry.workspace.id),
      scoped,
      testId: test.id,
      environmentId: environment.id,
      revisionId: String(test.activeRevisionId),
      environmentRevisionId: scoped.environments.get(environment.id).activeRevisionId,
    });
  }
  return { application, database, members };
}

function queueRuns(tenant: Tenant, count: number): void {
  const leases = new LeaseRepository(tenant.scoped.database);
  tenant.scoped.database.withTx(() => {
    for (let index = 0; index < count; index++) {
      const runId = uuidV7IdGenerator.next("run");
      tenant.scoped.context.entities.insert("Run", {
        id: runId,
        workspaceId: tenant.workspaceId,
        testId: tenant.testId,
        revisionId: tenant.revisionId,
        environmentRevisionId: tenant.environmentRevisionId,
        batchId: null,
        matrixCell: {},
        mode: "replay",
        phase: "queued",
        status: "queued",
        outcome: null,
        origin: "pool-pg-test",
        gatePolicy: {},
        gate: "pending",
        cleanupOutcome: "not_required",
        analysisStatus: "not_requested",
      });
      leases.enqueue(tenant.workspaceId, runId, "local");
    }
  });
}

/** A ready worker with fresh liveness that declared `slots` concurrent executions. */
function readyWorker(tenant: Tenant, name: string, slots: number): string {
  const { worker } = tenant.scoped.workerPool.createEnrollment({
    name,
    labels: { slots: String(slots) },
  });
  tenant.scoped.database.run(
    "UPDATE workers SET state='ready', last_heartbeat_at=? WHERE workspace_id=? AND id=?",
    new Date().toISOString(),
    tenant.workspaceId,
    worker.id,
  );
  return worker.id;
}

interface Child {
  line(text: string): Promise<void>;
  send(text: string): void;
  exited: Promise<{ code: number | null; out: string; err: string }>;
}

/** Runs a Node ES-module script in another OS process against the built persistence package. */
function startChild(script: string, args: string[]): Child {
  const child = spawn(process.execPath, ["--input-type=module", "-e", script, ...args], {
    stdio: ["ignore", "pipe", "pipe", "ipc"],
  });
  let out = "";
  let err = "";
  const waiters: Array<{ text: string; resolve: () => void }> = [];
  child.stdout.on("data", (chunk) => {
    out += String(chunk);
    for (const waiter of waiters.splice(0)) {
      if (out.includes(waiter.text)) waiter.resolve();
      else waiters.push(waiter);
    }
  });
  child.stderr.on("data", (chunk) => {
    err += String(chunk);
  });
  const exited = Promise.withResolvers<{ code: number | null; out: string; err: string }>();
  child.on("exit", (code) => exited.resolve({ code, out, err }));
  cleanups.push(() => {
    child.kill("SIGKILL");
  });
  return {
    exited: exited.promise,
    send: (text) => {
      child.send(text);
    },
    line(text) {
      if (out.includes(text)) return Promise.resolve();
      const seen = Promise.withResolvers<void>();
      waiters.push({ text, resolve: seen.resolve });
      void exited.promise.then(() => seen.resolve());
      return seen.promise.then(() => {
        if (!out.includes(text)) throw new Error(`child exited before printing ${text}: ${err}`);
      });
    },
  };
}

const claimingScript = `import { PersistenceDatabase, LeaseRepository } from ${JSON.stringify(persistenceDist)};
const [config, workspaceId, workerId, owner, role] = process.argv.slice(1);
const db = PersistenceDatabase.openPostgres(JSON.parse(config));
const leases = new LeaseRepository(db);
const claim = () => leases.claim({ workspaceId, owner, queue: "local", workerId });
if (role === "doomed") {
  if (!claim()) throw new Error("the ready worker must receive its first claim");
  console.log("claimed-first");
  await new Promise((resolve) => process.once("message", resolve));
  let after = 0;
  while (claim()) after += 1;
  console.log("after=" + after);
} else {
  let total = 0;
  while (claim()) total += 1;
  console.log("total=" + total);
}
db.close();`;

it("M4-08 REQ-038 PostgreSQL: a worker revoked under another OS process receives no further claim and its lease is fenced", async () => {
  const { members, database } = await tenants(1);
  const [tenant] = members;
  if (!tenant) throw new Error("Missing tenant");
  const doomed = readyWorker(tenant, "doomed", 2);
  const healthy = readyWorker(tenant, "healthy", 2);
  queueRuns(tenant, 6);

  const first = startChild(claimingScript, [
    JSON.stringify(database.config),
    tenant.workspaceId,
    doomed,
    "doomed-process",
    "doomed",
  ]);
  await first.line("claimed-first");
  const second = startChild(claimingScript, [
    JSON.stringify(database.config),
    tenant.workspaceId,
    healthy,
    "healthy-process",
    "healthy",
  ]);

  tenant.scoped.workerPool.revoke(doomed);
  first.send("go");
  const [doomedResult, healthyResult] = await Promise.all([first.exited, second.exited]);
  expect(doomedResult.code).toBe(0);
  expect(healthyResult.code).toBe(0);
  // The revoked worker is refused from its very next claim; the healthy one drains the rest.
  expect(doomedResult.out).toContain("after=0");
  expect(healthyResult.out).toContain("total=5");
  const states = tenant.scoped.database.all(
    "SELECT state, COUNT(*) AS n FROM job_leases WHERE workspace_id=? GROUP BY state ORDER BY state",
    tenant.workspaceId,
  );
  expect(states.map((row) => [row.state, Number(row.n)])).toEqual([
    ["leased", 5],
    ["reconciliation_required", 1],
  ]);
  expect(tenant.scoped.workerPool.get(doomed).state).toBe("revoked");
});

it("OPS-033 PostgreSQL: a flooding tenant is held to its share, the other tenant is served and the cap lifts once nobody competes", async () => {
  const { application, members } = await tenants(2);
  const [flooder, newcomer] = members;
  if (!flooder || !newcomer) throw new Error("Missing tenants");
  const floodWorker = readyWorker(flooder, "flood-worker", 2);
  const newcomerWorker = readyWorker(newcomer, "newcomer-worker", 2);
  queueRuns(flooder, 1500);
  const controller = application.database;
  const capFor = (tenant: Tenant) =>
    fairShareCap({ database: controller, workspaceId: tenant.workspaceId, now: new Date() });
  // Nobody else waits: the busy tenant is not capped, so capacity never idles because of fairness.
  expect(capFor(flooder)).toBeUndefined();

  queueRuns(newcomer, 3);
  // Four declared slots shared by two competing tenants.
  expect(capFor(flooder)).toBe(2);
  expect(capFor(newcomer)).toBe(2);

  const leases = new LeaseRepository(flooder.scoped.database);
  const claimFlood = () =>
    leases.claim({
      workspaceId: flooder.workspaceId,
      owner: "flood",
      queue: "local",
      workerId: floodWorker,
      maxLeased: capFor(flooder) ?? 1_000_000,
    });
  expect(claimFlood()).not.toBeNull();
  expect(claimFlood()).not.toBeNull();
  // Third claim is refused although 1498 jobs wait: the flooder holds its share.
  expect(claimFlood()).toBeNull();

  // The newcomer is served immediately and never sees the flooder's rows.
  const own = new LeaseRepository(newcomer.scoped.database);
  const claimNewcomer = () =>
    own.claim({
      workspaceId: newcomer.workspaceId,
      owner: "newcomer",
      queue: "local",
      workerId: newcomerWorker,
      maxLeased: capFor(newcomer) ?? 1_000_000,
    });
  expect(claimNewcomer()).not.toBeNull();
  expect(
    Number(
      newcomer.scoped.database.get("SELECT COUNT(*) AS n FROM job_leases WHERE queue='local'")?.n,
    ),
  ).toBe(3);

  // Once the newcomer has nothing queued the flooder may use every slot again.
  while (
    own.claim({
      workspaceId: newcomer.workspaceId,
      owner: "newcomer",
      queue: "local",
      workerId: newcomerWorker,
    })
  );
  expect(capFor(flooder)).toBeUndefined();
});

it("OPS-033 PostgreSQL: admission answers each tenant with its own queue only and a full tenant never blocks another", async () => {
  const { members } = await tenants(2);
  const [busy, quiet] = members;
  if (!busy || !quiet) throw new Error("Missing tenants");
  readyWorker(quiet, "quiet-worker", 2);
  queueRuns(busy, 1000);
  quiet.scoped.preflight = async () => {};
  const receipt = await quiet.scoped.runs.admit(
    {
      testId: quiet.testId,
      environmentId: quiet.environmentId,
      mode: "replay",
      healingPolicy: "off",
      origin: "api",
    },
    { idempotencyKey: randomUUID() },
  );
  // The quiet tenant sees a queue of one: nothing of the busy tenant's 1000 jobs leaks into position or size.
  expect(receipt.queue).toMatchObject({ position: 1, queued: 1, limit: 1000 });
});

it("OPS-033 M4-08 INT-026 PostgreSQL: the worker, notification and delivery tables enforce tenant row-level security", async () => {
  const { application } = await tenants(1);
  const rows = application.database.all(
    "SELECT relname, relrowsecurity, relforcerowsecurity FROM pg_class WHERE relname IN ('workers','notification_deliveries','notification_attempts') ORDER BY relname",
  );
  expect(rows.map((row) => [row.relname, row.relrowsecurity, row.relforcerowsecurity])).toEqual([
    ["notification_attempts", true, true],
    ["notification_deliveries", true, true],
    ["workers", true, true],
  ]);
});
