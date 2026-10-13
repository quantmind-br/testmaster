import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import { cp, mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { Application, readServerConfig, scaffoldPlan } from "@testmaster/application";
import { PersistenceDatabase } from "@testmaster/persistence";
import { describe, expect, it } from "vitest";
import { controlledShop, eventually, Journey, object, text } from "./harness.js";
import { startServerStack } from "./server-stack.js";

const root = resolve(import.meta.dirname, "../..");
const cli = join(root, "apps/cli/dist/main.js");

interface WorkerProcess {
  readonly child: ChildProcessWithoutNullStreams;
  readonly exited: Promise<number | null>;
  stderr(): string;
}

/**
 * OPS-038 per-component rolling upgrade with real workers (ADR-015, ADR-016): a worker process
 * of the current build holds in-flight Attempts on the rootless daemon while the database moves to
 * the next release's schema. The old worker finishes what it holds under its original fences,
 * claims nothing new and exits `worker_schema_behind`; an old-build process is refused at start;
 * a next-release worker then claims the queued Run and finishes it while the old API still serves.
 */
describe.skipIf(process.env.TESTMASTER_EXPECT_ROOTLESS !== "1")("OPS-038 rolling upgrade", () => {
  it("OPS-038 an older worker finishes its fenced leases and claims nothing new while a next-release worker takes over", async () => {
    const session = await Journey.create("OPS-038-rolling-upgrade", {
      class: "deterministic-e2e",
      runner: "real-docker-rootless",
      externalDependency: "local-reference-shop",
      limitations: [
        "The next release is simulated by one extra additive migration applied through migrationsDir.",
        "The next-release worker runs in the test process; the old worker is the built CLI.",
      ],
    });
    const shop = await controlledShop();
    const stack = await startServerStack({ worker: false });
    const scratch = await mkdtemp(join(tmpdir(), "tm-rolling-"));
    const processes: WorkerProcess[] = [];
    let upgraded: Application | undefined;
    const abort = new AbortController();
    const workerHome = join(scratch, "home");
    await mkdir(workerHome, { recursive: true });
    const spawnWorker = (): WorkerProcess => {
      const env: NodeJS.ProcessEnv = {
        ...process.env,
        HOME: workerHome,
        TESTMASTER_NO_TELEMETRY: "true",
        CI: "true",
      };
      for (const name of [
        "TESTMASTER_ENDPOINT",
        "TESTMASTER_PROFILE",
        "TESTMASTER_API_KEY",
        "NODE_OPTIONS",
        "PGPASSWORD",
      ])
        delete env[name];
      const child = spawn(
        process.execPath,
        [cli, "worker", "start", "--mode", "server", "--config", stack.configPath],
        { cwd: scratch, env, stdio: "pipe" },
      );
      let stderr = "";
      child.stderr.on("data", (chunk: Buffer) => {
        stderr += chunk.toString();
      });
      const worker: WorkerProcess = {
        child,
        stderr: () => stderr,
        exited: new Promise((done) => child.once("close", (code) => done(code))),
      };
      processes.push(worker);
      return worker;
    };
    try {
      const config = await readServerConfig(stack.configPath);
      // The next release: the shipped PostgreSQL migrations plus one additive migration.
      const source = join(root, "packages/persistence/migrations/postgres");
      const nextRelease = join(scratch, "next-release");
      await cp(source, nextRelease, { recursive: true });
      const count = (await readdir(source)).filter((name) => name.endsWith(".sql")).length;
      await writeFile(
        join(nextRelease, `${String(count + 1).padStart(4, "0")}_rolling_upgrade_probe.sql`),
        "CREATE TABLE rolling_upgrade_probe (id TEXT PRIMARY KEY);\n",
      );

      const owner = stack.ownerClient();
      const api = (method: string, path: string, body?: unknown) =>
        method === "GET" ? owner.request("GET", path) : owner.mutate(method, path, body);
      const project = object(
        object((await api("POST", "/v1/projects", { name: "Rolling" })).json()).data,
      );
      const environment = object(
        object(
          (
            await api("POST", `/v1/projects/${project.id}/environments`, {
              name: "shop",
              baseUrl: shop.url,
              networkProfile: "local-loopback",
            })
          ).json(),
        ).data,
      );
      const test = object(
        object(
          (
            await api("POST", `/v1/projects/${project.id}/tests`, {
              plan: scaffoldPlan("backend"),
              origin: "manual",
            })
          ).json(),
        ).data,
      );
      const admit = async () => {
        const response = await api("POST", "/v1/runs", {
          testId: test.id,
          environmentId: environment.id,
          mode: "replay",
          healingPolicy: "off",
          origin: "api",
        });
        expect(response.status).toBe(202);
        const runId = text(object(object(response.json()).data).runId);
        session.runIds.push(runId);
        return runId;
      };
      const phase = async (runId: string) => {
        const data = object(object((await api("GET", `/v1/runs/${runId}`)).json()).data);
        return { phase: String(data.phase), outcome: (data.outcome as string | null) ?? null };
      };
      const database = (await stack.scope()).database;
      const lease = (runId: string) =>
        database.get(
          "SELECT state,fence FROM job_leases WHERE workspace_id=? AND resource_id=?",
          stack.workspaceId,
          runId,
        );
      const attempts = (runId: string) =>
        database.all(
          "SELECT number,fence,outcome FROM attempts WHERE workspace_id=? AND run_id=? ORDER BY number",
          stack.workspaceId,
          runId,
        );

      // 1. An old-build worker holds two in-flight Attempts; a third Run waits in the queue.
      const oldWorker = spawnWorker();
      await eventually(
        async () => object(object((await api("GET", "/v1/health/ready")).json()).data),
        (data) => object(data.worker).status === "ready",
        120_000,
      );
      shop.hold();
      const held = [await admit(), await admit()];
      await eventually(
        async () => shop.hits(),
        (hits) => hits >= 2,
        120_000,
      );
      const queued = await admit();
      const fencesBefore = held.map((id) => Number(lease(id)?.fence));
      expect(held.map((id) => lease(id)?.state)).toEqual(["leased", "leased"]);
      expect(lease(queued)).toMatchObject({ state: "queued", fence: 0 });

      // 2. The database moves to the next release while the old worker is running.
      const migrator = PersistenceDatabase.openPostgres(config.database, {
        migrationsDir: nextRelease,
      });
      try {
        await migrator.migrate(nextRelease);
      } finally {
        migrator.close();
      }
      expect(database.schemaCompatibility().state).toBe("ahead");
      await eventually(
        async () =>
          database.get(
            "SELECT state FROM workers WHERE workspace_id=? ORDER BY created_at DESC LIMIT 1",
            stack.workspaceId,
          )?.state,
        (state) => state === "draining",
        60_000,
      );
      // It claims nothing new while it drains: the queued Run keeps fence 0 and has no Attempt.
      await new Promise((done) => setTimeout(done, 3000));
      expect(lease(queued)).toMatchObject({ state: "queued", fence: 0 });
      expect(attempts(queued)).toEqual([]);

      // 3. The old worker finishes what it holds, under the fences it already had.
      shop.release();
      for (const id of held)
        await eventually(
          () => phase(id),
          (view) => view.phase === "completed",
          180_000,
        );
      for (const [index, id] of held.entries()) {
        expect((await phase(id)).outcome).toBe("passed");
        expect(attempts(id).map((row) => Number(row.fence))).toEqual([fencesBefore[index]]);
        expect(attempts(id).length).toBe(1);
      }
      const oldExit = await oldWorker.exited;
      expect(oldExit).not.toBe(0);
      expect(oldWorker.stderr()).toContain("older than the database schema");

      // 4. A new process of the old build is refused at start and claims nothing.
      const retry = spawnWorker();
      expect(await retry.exited).not.toBe(0);
      expect(retry.stderr()).toMatch(/schema/u);
      expect(lease(queued)).toMatchObject({ state: "queued", fence: 0 });

      // 5. A next-release worker (built against the migrated schema) takes over the queued Run
      // while the previous release's API process is still serving.
      upgraded = await Application.open({
        cwd: scratch,
        home: workerHome,
        env: {},
        server: config,
        migrationsDir: nextRelease,
      });
      expect(upgraded.database.schemaCompatibility().state).toBe("current");
      const loop = upgraded
        .forWorkspaceSystem(stack.workspaceId)
        .worker.run({ signal: abort.signal });
      await eventually(
        () => phase(queued),
        (view) => view.phase === "completed",
        180_000,
      );
      expect((await phase(queued)).outcome).toBe("passed");
      expect(attempts(queued).length).toBe(1);
      expect(Number(attempts(queued)[0]?.fence)).toBeGreaterThanOrEqual(1);
      abort.abort();
      await loop;

      session.oracles.push({
        held: held.map((id, index) => ({
          runId: id,
          fencesBefore: fencesBefore[index],
          attempts: attempts(id).length,
        })),
        queued: { runId: queued, attempts: attempts(queued).length },
        oldWorker: { exitCode: oldExit, refusedAtStart: true },
      });
    } finally {
      abort.abort();
      for (const worker of processes) worker.child.kill("SIGTERM");
      await Promise.allSettled(processes.map((worker) => worker.exited));
      upgraded?.close();
      await stack.stop();
      await shop.close();
      await rm(scratch, { recursive: true, force: true });
      await session.close();
    }
  }, 1_200_000);
});
