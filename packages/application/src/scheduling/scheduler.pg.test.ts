import { spawn } from "node:child_process";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { createTestDatabase, type TestDatabase } from "@testmaster/persistence/testing";
import { afterEach, expect, it } from "vitest";
import { Application, authenticateSession, type ServerConfig, scaffoldPlan } from "../index.js";

const cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});
const password = "correct horse battery staple";
const repositoryRoot = resolve(import.meta.dirname, "../../../..");
const applicationDist = pathToFileURL(
  join(repositoryRoot, "packages/application/dist/index.js"),
).href;

interface Fixture {
  application: Application;
  server: ServerConfig;
  root: string;
  workspaceId: string;
  projectId: string;
  scheduleId: string;
  database: TestDatabase;
}

async function fixture(): Promise<Fixture> {
  const database = await createTestDatabase();
  cleanups.push(() => database.drop());
  const root = await mkdtemp(join(tmpdir(), "tm-scheduler-pg-"));
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
  const created = application.operator.bootstrap({ workspaceName: "Acme", ownerLogin: "owner" });
  const workspaceId = String(created.workspace.id);
  await application.identityService.recover({
    principal: "owner",
    recoveryToken: created.ownerRecovery.recoveryToken,
    newPassword: password,
  });
  const owner = application.forIdentity(
    authenticateSession(
      application,
      (await application.identityService.login({ principal: "owner", password })).sessionToken,
    ),
  );
  const project = owner.projects.create({ name: "Shop" });
  const environment = owner.environments.create({
    projectId: project.id,
    name: "staging",
    baseUrl: "http://127.0.0.1:9",
  });
  owner.tests.create({ projectId: project.id, plan: scaffoldPlan("backend"), name: "checkout" });
  owner.tests.create({ projectId: project.id, plan: scaffoldPlan("backend"), name: "profile" });
  const suite = owner.suites.create({
    name: "nightly",
    selection: {
      kind: "dynamic",
      projects: [{ projectId: project.id, environmentId: environment.id }],
    },
  });
  const schedule = owner.schedules.create({
    name: "every-minute",
    selection: { kind: "suite", suiteId: suite.id },
    trigger: { kind: "cron", cron: "* * * * *", timezone: "UTC" },
    overlap: "allow",
  });
  return {
    application,
    server,
    root,
    workspaceId,
    projectId: project.id,
    scheduleId: schedule.id,
    database,
  };
}

interface Child {
  exited: Promise<{ code: number | null; out: string; err: string }>;
  kill(signal: NodeJS.Signals): void;
  waitFor(text: string): Promise<void>;
}

/** One scheduler in its own OS process on an accelerated clock: one virtual minute passes every 100 ms. */
function startScheduler(f: Fixture, holder: string, runMs: number, base: number): Child {
  const script = `import { mkdir } from "node:fs/promises";
import { Application, Scheduler } from ${JSON.stringify(applicationDist)};
const [server, root, holder, runMs, base] = process.argv.slice(1);
const t0 = Date.now();
const clock = () => Number(base) + (Date.now() - t0) * 600;
const application = await Application.open({ cwd: root, home: root + "/home", env: {}, server: JSON.parse(server) });
const scheduler = new Scheduler(application.controllerScope(), {
  holder,
  now: clock,
  leaseMs: 30000,
  configureApplication(app) {
    app.preflight = async () => {};
    app.runs.host.liveWorker = () => true;
  },
});
console.log("ready");
let ticks = 0, led = 0, dispatched = 0;
while (Date.now() - t0 < Number(runMs)) {
  const summary = await scheduler.tick();
  ticks++;
  if (summary.leader) led++;
  dispatched += summary.dispatched;
  await new Promise((done) => setTimeout(done, 25));
}
scheduler.release();
console.log(JSON.stringify({ holder, ticks, led, dispatched }));
application.close();`;
  const child = spawn(
    process.execPath,
    [
      "--input-type=module",
      "-e",
      script,
      JSON.stringify(f.server),
      f.root,
      holder,
      String(runMs),
      String(base),
    ],
    { stdio: ["ignore", "pipe", "pipe"] },
  );
  let out = "";
  let err = "";
  const waiters: { text: string; resolve: () => void }[] = [];
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
  const { promise, resolve: done } = Promise.withResolvers<{
    code: number | null;
    out: string;
    err: string;
  }>();
  child.on("exit", (code) => done({ code, out, err }));
  cleanups.push(() => {
    child.kill("SIGKILL");
  });
  return {
    exited: promise,
    kill: (signal) => {
      child.kill(signal);
    },
    waitFor(text) {
      if (out.includes(text)) return Promise.resolve();
      const { promise: seen, resolve } = Promise.withResolvers<void>();
      waiters.push({ text, resolve });
      void promise.then(() => resolve());
      return seen.then(() => {
        if (!out.includes(text)) throw new Error(`child exited before printing ${text}: ${err}`);
      });
    },
  };
}
const sleep = (ms: number) => new Promise((done) => setTimeout(done, ms));

it("OPS-016 OPS-017 three scheduler processes with a killed leader and flapping leases never fire an occurrence twice on PostgreSQL", async () => {
  const f = await fixture();
  const base = Date.now();
  const a = startScheduler(f, "proc-a", 7000, base);
  const b = startScheduler(f, "proc-b", 7000, base);
  await Promise.all([a.waitFor("ready"), b.waitFor("ready")]);
  await sleep(2000);
  a.kill("SIGKILL");
  const c = startScheduler(f, "proc-c", 4000, base);
  const [aResult, bResult, cResult] = await Promise.all([a.exited, b.exited, c.exited]);
  expect(bResult.code, bResult.err).toBe(0);
  expect(cResult.code, cResult.err).toBe(0);
  expect(aResult.out).not.toContain('"holder"');
  const database = f.application.database.forWorkspace("*");
  const firings = database.all(
    "SELECT id,fire_instant,state,batch_id,lease_fence FROM schedule_firings WHERE schedule_id=?",
    f.scheduleId,
  );
  const dispatched = firings.filter((row) => row.state === "dispatched");
  expect(dispatched.length).toBeGreaterThanOrEqual(8);
  // One firing per instant; the unique key is also what the database enforces.
  expect(new Set(firings.map((row) => row.fire_instant)).size).toBe(firings.length);
  // One BatchRun per dispatched firing, one Run per member, and no batch shared between firings.
  const batches = database.all("SELECT id FROM batches");
  expect(batches).toHaveLength(dispatched.length);
  expect(new Set(dispatched.map((row) => row.batch_id)).size).toBe(dispatched.length);
  expect(database.all("SELECT id FROM runs")).toHaveLength(dispatched.length * 2);
  // Leadership really flapped: several fences wrote firings and the lease fence only moved forward.
  const fences = new Set(dispatched.map((row) => Number(row.lease_fence)));
  expect(fences.size).toBeGreaterThanOrEqual(2);
  const stored = database.all("SELECT fence FROM controller_leases WHERE name='scheduler'");
  expect(stored).toHaveLength(1);
  expect(Number(stored[0]?.fence)).toBeGreaterThanOrEqual(Math.max(...fences));
  // Tenant isolation: a connection scoped to another workspace sees none of the schedule rows.
  const foreign = f.application.database.forWorkspace("ws_someone_else");
  for (const table of ["schedules", "schedule_revisions", "schedule_firings"])
    expect(foreign.all(`SELECT 1 AS present FROM ${table}`)).toEqual([]);
  expect(database.all("SELECT 1 AS present FROM schedule_firings").length).toBeGreaterThan(0);
});
