import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { createServer as createHttpServer, type Server } from "node:http";
import { join } from "node:path";
import { promisify } from "node:util";
import type { ExecutablePlan, PlanStep } from "@testmaster/contracts";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  createTestDatabaseOn,
  type PostgresTestServer,
  startPostgresTestServer,
} from "../../packages/persistence/src/testing/server.js";
import {
  action,
  assertion,
  eventually,
  executable,
  healthPlan,
  Journey,
  literal,
  object,
  text,
} from "./harness.js";
import {
  type PartitionRelay as Relay,
  startPartitionRelay as startRelay,
} from "./partition-relay.js";
import { type ServerStack, type Spawned, startServerStack } from "./server-stack.js";

const exec = promisify(execFile);

/** Every step may wait far longer than a lease, so only the lease can end a held request. */
const HELD_STEP_TIMEOUT_MS = 240_000;
const SLOW_RESPONSE_MS = 4_000;
const FLOOD_RUNS = 6;

/**
 * The second Docker daemon of this host: the rootless one the `docker-rootless` project names. A
 * missing socket or a rootful daemon behind it fails the OPS-033 scenario instead of skipping it.
 */
const rootlessDockerHost =
  process.env.TESTMASTER_ROOTLESS_DOCKER_HOST ??
  `unix://${process.env.XDG_RUNTIME_DIR ?? `/run/user/${process.getuid?.() ?? 1000}`}/docker.sock`;

async function daemonIdentity(host?: string) {
  const env = { ...process.env };
  if (host) env.DOCKER_HOST = host;
  const { stdout } = await exec(
    "docker",
    ["info", "--format", "{{.ID}}|{{json .SecurityOptions}}"],
    { env },
  ).catch((error: unknown) => {
    throw new Error(`Docker daemon ${host ?? "default"} is unreachable: ${String(error)}`);
  });
  const [id = "", options = "[]"] = stdout.trim().split("|");
  return {
    id,
    rootless: (JSON.parse(options) as string[]).some((option) => option.includes("name=rootless")),
  };
}

interface Held {
  readonly path: string;
  readonly openedAt: number;
  closedAt: number | null;
}

/**
 * The target the sandboxed Attempts call. `/hang` holds its first request open until the client
 * goes away and answers every later one; `/orders` records the POST and never finishes its answer;
 * `/slow-*` answers after a few seconds so a worker's slots stay busy. A held answer sends a byte
 * every 2 s: the egress proxy closes an upstream idle for 30 s, so only the end of the Attempt may
 * close a live one.
 */
async function startTarget() {
  const held: Held[] = [];
  const hits = new Map<string, number>();
  const server: Server = createHttpServer((incoming, outgoing) => {
    const path = new URL(incoming.url ?? "/", "http://target").pathname;
    const count = (hits.get(path) ?? 0) + 1;
    hits.set(path, count);
    const answer = () => {
      outgoing.writeHead(200, { "content-type": "application/json" });
      outgoing.end(JSON.stringify({ status: "ok", id: `ord_${count}`, item: "remote" }));
    };
    if ((path === "/hang" && count === 1) || path === "/orders") {
      const entry: Held = { path, openedAt: Date.now(), closedAt: null };
      held.push(entry);
      incoming.resume();
      outgoing.writeHead(200, { "content-type": "application/json" });
      outgoing.write("{");
      // A real trickle against the real egress proxy's idle timer; fake timers cannot reach it.
      const trickle = setInterval(() => outgoing.write(" "), 2_000);
      outgoing.once("close", () => {
        clearInterval(trickle);
        entry.closedAt = Date.now();
      });
      return;
    }
    if (path.startsWith("/slow-")) {
      // A real slow answer keeps a worker slot busy inside the sandbox; fake timers cannot reach it.
      setTimeout(answer, SLOW_RESPONSE_MS);
      return;
    }
    answer();
  });
  const listening = Promise.withResolvers<void>();
  server.once("error", listening.reject);
  server.listen(0, "127.0.0.1", listening.resolve);
  await listening.promise;
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("target has no port");
  return {
    url: `http://127.0.0.1:${address.port}`,
    held,
    hits: (path: string) => hits.get(path) ?? 0,
    async close() {
      server.closeAllConnections();
      const closed = Promise.withResolvers<void>();
      server.close(() => closed.resolve());
      await closed.promise;
    },
  };
}

type Target = Awaited<ReturnType<typeof startTarget>>;

interface WorkerLine {
  readonly event: string;
  readonly workerId?: string;
  readonly attemptId?: string;
  readonly runId?: string;
  readonly workspaceId?: string;
  readonly call?: string;
}

function workerLines(worker: Spawned): WorkerLine[] {
  return worker
    .stderr()
    .split("\n")
    .filter((line) => line.startsWith("{"))
    .flatMap((line) => {
      try {
        return [JSON.parse(line) as WorkerLine];
      } catch {
        return [];
      }
    });
}

function withStepTimeout(plan: ExecutablePlan, timeoutMs: number): ExecutablePlan {
  return {
    ...plan,
    steps: plan.steps.map((step, index) =>
      index === 0 ? ({ ...step, timeoutMs } as PlanStep) : step,
    ),
  };
}

async function containersOf(attemptId: string): Promise<string[]> {
  const { stdout } = await exec("docker", [
    "ps",
    "-aq",
    "--filter",
    `label=io.testmaster.attempt=${attemptId}`,
  ]);
  return stdout.split("\n").filter(Boolean);
}

/**
 * M5-01 remote workers (ADR-030) on the real server profile: PostgreSQL, `server start --mode
 * server` behind TLS, and `worker start --mode remote` processes that hold no database credential
 * and run their Attempts on this host's Docker daemon. Each worker reaches the controller only
 * over HTTPS; the partitioned one through a relay this journey blackholes.
 */
describe("M5-01 remote workers", () => {
  let postgres: PostgresTestServer | undefined;
  let stack: ServerStack | undefined;
  let target: Target | undefined;
  const relays: Relay[] = [];
  let session: Journey | undefined;
  let failure: unknown;
  const ids = {
    project: ["", ""],
    environment: ["", ""],
  };

  const live = () => {
    if (!stack || !target || !session) throw new Error("journey setup missing");
    return { stack, target, session };
  };

  const record = async <T>(work: () => Promise<T>): Promise<T> => {
    try {
      return await work();
    } catch (error) {
      failure ??= error;
      throw error;
    }
  };

  const api = async (workspace: number, method: string, path: string, body?: unknown) => {
    const client = live().stack.ownerClient(workspace);
    return method === "GET" ? client.request("GET", path) : client.mutate(method, path, body);
  };

  const data = async (workspace: number, method: string, path: string, body?: unknown) => {
    const response = await api(workspace, method, path, body);
    if (response.status >= 300)
      throw new Error(`${method} ${path}: ${response.status} ${response.text}`);
    return object(object(response.json()).data);
  };

  const createTest = async (workspace: number, plan: ExecutablePlan) =>
    text(
      (
        await data(workspace, "POST", `/v1/projects/${ids.project[workspace]}/tests`, {
          plan,
          origin: "manual",
        })
      ).id,
    );

  const admit = async (workspace: number, testId: string) => {
    const receipt = await data(workspace, "POST", "/v1/runs", {
      testId,
      environmentId: ids.environment[workspace],
      mode: "replay",
      healingPolicy: "off",
      origin: "api",
      limits: { maxAttempts: 2 },
    });
    const runId = text(receipt.runId);
    live().session.runIds.push(runId);
    return runId;
  };

  const run = async (workspace: number, runId: string) =>
    data(workspace, "GET", `/v1/runs/${runId}`);

  const completed = (workspace: number, runId: string, timeoutMs = 180_000) =>
    eventually(
      () => run(workspace, runId),
      (view) => view.phase === "completed",
      timeoutMs,
    );

  const attempts = async (runId: string) =>
    (await live().stack.scope()).database.all(
      "SELECT id,number,fence,outcome,worker_id,created_at FROM attempts WHERE run_id=? ORDER BY number",
      runId,
    );

  const enrollPrivate = async (name: string) => {
    const enrollment = await data(0, "POST", "/v1/workers", { name });
    return text(enrollment.enrollmentToken);
  };

  /** A shared pool worker enrolled by the operator with `server worker-enrollment`. */
  const enrollShared = async (name: string) => {
    const { stack } = live();
    const directory = join(stack.cwd, ".workers", name);
    await mkdir(directory, { recursive: true, mode: 0o700 });
    const tokenFile = join(directory, "issued.token");
    const enrollment = stack.spawn([
      "server",
      "worker-enrollment",
      "--config",
      stack.configPath,
      "--name",
      name,
      "--out",
      tokenFile,
    ]);
    expect(await enrollment.exited, enrollment.stderr()).toBe(0);
    return (await readFile(tokenFile, "utf8")).trim();
  };

  const startWorker = async (
    name: string,
    token: string,
    controller: string,
    slots = 2,
    env: Readonly<Record<string, string>> = {},
  ): Promise<Spawned> => {
    const { stack } = live();
    const directory = join(stack.cwd, ".workers", name);
    await mkdir(directory, { recursive: true, mode: 0o700 });
    const tokenFile = join(directory, "enroll.token");
    const caFile = join(directory, "ca.pem");
    await writeFile(tokenFile, token, { mode: 0o600 });
    await writeFile(caFile, stack.ca.caPem, { mode: 0o600 });
    const worker = stack.spawn(
      [
        "worker",
        "start",
        "--mode",
        "remote",
        "--controller",
        controller,
        "--ca-file",
        caFile,
        "--enroll-token-file",
        tokenFile,
        "--data-dir",
        join(directory, "data"),
        "--slots",
        String(slots),
      ],
      env,
    );
    await eventually(
      async () => workerLines(worker),
      (lines) =>
        lines.some((line) => line.event === "worker.ready") || worker.child.exitCode !== null,
      120_000,
    );
    if (worker.child.exitCode !== null)
      throw new Error(`remote worker ${name} exited: ${worker.stderr()} ${worker.stdout()}`);
    return worker;
  };

  const stopWorker = async (worker: Spawned) => {
    if (worker.child.exitCode !== null || worker.child.signalCode !== null) return;
    worker.child.kill("SIGTERM");
    // Cleanup only: a worker that ignores SIGTERM must not keep the journey's processes alive.
    const kill = setTimeout(() => worker.child.kill("SIGKILL"), 60_000);
    await worker.exited;
    clearTimeout(kill);
  };

  const lineOf = (worker: Spawned, event: string, attemptId?: string) =>
    workerLines(worker).find(
      (line) => line.event === event && (attemptId === undefined || line.attemptId === attemptId),
    );

  beforeAll(async () => {
    session = await Journey.create("M5-01-remote-workers", {
      class: "deterministic-e2e",
      runner: "real-docker-remote-workers",
      externalDependency: "local-held-target",
      limitations: [
        "Controller, workers and both Docker daemons share one physical host; the partition is a blackholing TCP relay between one worker and the controller's TLS proxy.",
        "Remote workers verify their own image lock on their own daemon: the host's default daemon, and for OPS-033 also its rootless daemon. Fair share across hosts is proven across two daemons, not across two machines.",
      ],
    });
    postgres = await startPostgresTestServer();
    const server = postgres;
    target = await startTarget();
    stack = await startServerStack({
      workspaces: 2,
      database: () => createTestDatabaseOn(server),
    });
    for (const workspace of [0, 1]) {
      ids.project[workspace] = text(
        (await data(workspace, "POST", "/v1/projects", { name: `M5-01 project ${workspace}` })).id,
      );
      ids.environment[workspace] = text(
        (
          await data(workspace, "POST", `/v1/projects/${ids.project[workspace]}/environments`, {
            name: "held-target",
            baseUrl: target.url,
            networkProfile: "local-loopback",
          })
        ).id,
      );
    }
  }, 300_000);

  afterAll(async () => {
    if (stack && failure !== undefined)
      session?.oracles.push({ check: "stackLogs", logs: stack.logs().slice(-20_000) });
    await session?.close(failure);
    for (const relay of relays) await relay.close().catch(() => undefined);
    await stack?.stop();
    await target?.close();
    await postgres?.stop();
  }, 300_000);

  // Remote worker state carries over: the partitioned worker A serves both partition scenarios.
  let workerA: Spawned | undefined;
  let relayA: Relay | undefined;

  it("M5-01 a partitioned remote worker loses its lease: its egress ends, its stale publication is refused with lease_lost and the Run completes from the worker that reclaimed it", async () => {
    await record(async () => {
      const { stack, target, session } = live();
      relayA = await startRelay(stack.proxy.port);
      relays.push(relayA);
      workerA = await startWorker("worker-a", await enrollPrivate("worker-a"), relayA.origin);
      const workerAId = text(lineOf(workerA, "worker.ready")?.workerId);

      const testId = await createTest(
        0,
        withStepTimeout(healthPlan("ok", "hang"), HELD_STEP_TIMEOUT_MS),
      );
      const runId = await admit(0, testId);
      await eventually(
        async () => target.held.filter((entry) => entry.path === "/hang"),
        (held) => held.length === 1,
        180_000,
      );
      const firstAttemptId = text(lineOf(workerA, "attempt.claimed")?.attemptId);
      expect(await containersOf(firstAttemptId)).toHaveLength(1);

      // A loses the controller; the target still holds A's request open.
      const partitionedAt = Date.now();
      relayA.partition();
      const workerB = await startWorker(
        "worker-b",
        await enrollPrivate("worker-b"),
        stack.proxy.origin,
      );
      const workerBId = text(lineOf(workerB, "worker.ready")?.workerId);

      const hang = target.held.find((entry) => entry.path === "/hang");
      await eventually(
        async () => hang?.closedAt ?? null,
        (closedAt) => closedAt !== null,
        90_000,
      );
      const egressEndedAfterMs = Number(hang?.closedAt) - partitionedAt;
      // The lease is 30 s and was renewed at most one heartbeat (10 s) before the partition.
      expect(egressEndedAfterMs).toBeLessThan(45_000);
      expect(lineOf(workerA, "attempt.lease_expired", firstAttemptId)).toBeDefined();
      await eventually(
        () => containersOf(firstAttemptId),
        (containers) => containers.length === 0,
        60_000,
      );

      const finished = await completed(0, runId);
      expect(finished.outcome).toBe("passed");
      const rows = await attempts(runId);
      expect(rows.map((row) => [Number(row.number), row.worker_id, row.outcome])).toEqual([
        [1, workerAId, "inconclusive"],
        [2, workerBId, "passed"],
      ]);
      expect(Number(rows[1]?.fence)).toBeGreaterThan(Number(rows[0]?.fence));
      expect(target.hits("/hang")).toBe(2);

      // Healed, A still holds its finished Attempt and tries to publish it: the controller refuses.
      relayA.heal();
      await eventually(
        async () => lineOf(workerA as Spawned, "attempt.lease_lost", firstAttemptId),
        (line) => line !== undefined,
        120_000,
      );
      expect(lineOf(workerA, "attempt.lease_lost", firstAttemptId)?.call).toBe("settle");
      expect(lineOf(workerA, "attempt.settled", firstAttemptId)).toBeUndefined();
      const scope = await stack.scope();
      expect(
        scope.database.all("SELECT id FROM artifacts WHERE attempt_id=?", firstAttemptId),
      ).toEqual([]);
      expect(scope.database.all("SELECT outcome FROM attempts WHERE id=?", firstAttemptId)).toEqual(
        [{ outcome: "inconclusive" }],
      );
      expect((await run(0, runId)).outcome).toBe("passed");

      await stopWorker(workerB);
      session.oracles.push({
        check: "partitionedWorkerRefusedAndReclaimed",
        healthy: true,
        runId,
        attempts: rows.map((row) => ({
          number: Number(row.number),
          fence: Number(row.fence),
          outcome: row.outcome,
          worker: row.worker_id === workerAId ? "A (partitioned)" : "B",
        })),
        egressEndedAfterPartitionMs: egressEndedAfterMs,
        staleSettle: "lease_lost",
        staleArtifacts: 0,
      });
    });
  }, 600_000);

  it("M5-01 an external effect in flight on a partitioned remote worker stays uncertain and its Run is not retried", async () => {
    await record(async () => {
      const { stack, target, session } = live();
      if (!workerA || !relayA) throw new Error("worker A missing");
      const plan = withStepTimeout(
        executable("Remote external effect", "http", [
          action("create", "request", {
            method: "POST",
            pathSegments: [literal("orders")],
            body: { kind: "json", value: { literal: { item: "remote" } } },
            resource: {
              resourceType: "order",
              correlationKey: { literal: `order-${randomUUID()}` },
              handle: "/id",
              ownerProof: "/item",
            },
          }),
          {
            ...assertion("created", { responseStepId: "create" }, "statusIn"),
            expectation: { predicate: "statusIn", values: [200] },
          } as PlanStep,
        ]),
        HELD_STEP_TIMEOUT_MS,
      );
      const runId = await admit(0, await createTest(0, plan));
      await eventually(
        async () => target.held.filter((entry) => entry.path === "/orders"),
        (held) => held.length === 1,
        180_000,
      );
      const scope = await stack.scope();
      const attemptId = text(
        (
          await eventually(
            async () => attempts(runId),
            (rows) => rows.length === 1,
            30_000,
          )
        )[0]?.id,
      );
      // The intent reached the controller before the request left the sandbox.
      await eventually(
        async () =>
          scope.database.all("SELECT state FROM resources WHERE creator_attempt_id=?", attemptId),
        (rows) => rows.length === 1,
        30_000,
      );

      relayA.partition();
      const finished = await completed(0, runId, 120_000);
      expect(finished.outcome).not.toBe("passed");
      const events = (await api(0, "GET", `/v1/runs/${runId}/events`)).text;
      expect(events).toContain("retry_unsafe_external_effect");
      expect(await attempts(runId)).toHaveLength(1);
      expect(target.hits("/orders")).toBe(1);
      expect(
        scope.database.all("SELECT state FROM resources WHERE creator_attempt_id=?", attemptId),
      ).toEqual([{ state: "uncertain" }]);

      relayA.heal();
      await eventually(
        async () => lineOf(workerA as Spawned, "attempt.lease_lost", attemptId),
        (line) => line !== undefined,
        120_000,
      );
      expect(target.hits("/orders")).toBe(1);
      await stopWorker(workerA);
      session.oracles.push({
        check: "inFlightEffectStaysUncertain",
        healthy: true,
        runId,
        outcome: finished.outcome,
        reasonCode: "retry_unsafe_external_effect",
        attempts: 1,
        targetPosts: target.hits("/orders"),
        resourceState: "uncertain",
      });
    });
  }, 600_000);

  it("M5-01 one workspace flooding the shared pool worker does not monopolize it: another workspace's Run starts while the flood is still queued", async () => {
    await record(async () => {
      const { stack, session } = live();
      const token = await enrollShared("shared-pool");

      // Admission needs a live worker in each workspace: the shared worker's first claim gives it
      // a ready row in every workspace it serves.
      const shared = await startWorker("shared", token, stack.proxy.origin, 2);
      const sharedLine = lineOf(shared, "worker.ready") as WorkerLine & { shared?: boolean };
      expect(sharedLine.shared).toBe(true);
      const scope = await stack.scope();
      await eventually(
        async () =>
          scope.database.all(
            "SELECT workspace_id FROM workers WHERE id=? AND state='ready'",
            text(sharedLine.workerId),
          ),
        (rows) => rows.length === 2,
        30_000,
      );
      const flood = await createTest(0, healthPlan("ok", "slow-flood"));
      const other = await createTest(1, healthPlan("ok", "slow-other"));
      const floodRuns: string[] = [];
      for (let index = 0; index < FLOOD_RUNS; index++) floodRuns.push(await admit(0, flood));
      const otherRun = await admit(1, other);
      for (const runId of floodRuns) expect((await completed(0, runId)).outcome).toBe("passed");
      expect((await completed(1, otherRun)).outcome).toBe("passed");

      const claims = workerLines(shared).filter((line) => line.event === "attempt.claimed");
      const order = claims.map((line) => (line.runId === otherRun ? "other" : "flood"));
      const otherPosition = order.indexOf("other");
      // The flood may fill both slots before the other workspace admits; from then on it may hold
      // only its share (one of two slots), so the other Run takes the next free slot.
      expect(otherPosition).toBeGreaterThanOrEqual(0);
      expect(otherPosition).toBeLessThanOrEqual(2);
      expect(
        order.slice(otherPosition + 1).filter((kind) => kind === "flood").length,
      ).toBeGreaterThanOrEqual(FLOOD_RUNS - 2);
      expect(new Set(claims.map((line) => line.workspaceId)).size).toBe(2);
      await stopWorker(shared);
      session.oracles.push({
        check: "sharedPoolFairShare",
        healthy: true,
        floodRuns: FLOOD_RUNS,
        claimOrder: order,
        otherClaimPosition: otherPosition,
      });
    });
  }, 600_000);

  it("OPS-033 two shared workers on two Docker daemons pool their slots: a flooding workspace holds at most its share of both and another workspace's Run takes the next free slot", async () => {
    await record(async () => {
      const { stack, session } = live();
      const rootful = await daemonIdentity();
      const rootless = await daemonIdentity(rootlessDockerHost);
      expect(rootful.rootless).toBe(false);
      expect(rootless.rootless).toBe(true);
      expect(rootless.id).not.toBe(rootful.id);

      // One slot on each daemon: two slots in the pool, two workspaces competing for them.
      const workers = [
        await startWorker(
          "pool-rootful",
          await enrollShared("pool-rootful"),
          stack.proxy.origin,
          1,
        ),
        await startWorker(
          "pool-rootless",
          await enrollShared("pool-rootless"),
          stack.proxy.origin,
          1,
          { DOCKER_HOST: rootlessDockerHost },
        ),
      ];
      const workerIds = workers.map((worker) => text(lineOf(worker, "worker.ready")?.workerId));
      const scope = await stack.scope();
      await eventually(
        async () =>
          scope.database.all(
            "SELECT workspace_id FROM workers WHERE id IN (?,?) AND state='ready'",
            ...workerIds,
          ),
        (rows) => rows.length === 4,
        30_000,
      );
      const flood = await createTest(0, healthPlan("ok", "slow-pool-flood"));
      const other = await createTest(1, healthPlan("ok", "slow-pool-other"));
      const floodRuns: string[] = [];
      for (let index = 0; index < FLOOD_RUNS; index++) floodRuns.push(await admit(0, flood));
      const otherRun = await admit(1, other);
      for (const runId of floodRuns) expect((await completed(0, runId)).outcome).toBe("passed");
      expect((await completed(1, otherRun)).outcome).toBe("passed");

      const runIds = [...floodRuns, otherRun];
      const claimed = scope.database.all(
        `SELECT run_id, worker_id FROM attempts WHERE run_id IN (${runIds.map(() => "?").join(",")}) ORDER BY created_at, run_id`,
        ...runIds,
      );
      const order = claimed.map((row) => (row.run_id === otherRun ? "other" : "flood"));
      const otherPosition = order.indexOf("other");
      // The flood may take both slots before the other workspace admits; from then on it may hold
      // only one of the two slots the daemons offer together, so the other Run takes the next one.
      expect(otherPosition).toBeGreaterThanOrEqual(0);
      expect(otherPosition).toBeLessThanOrEqual(2);
      expect(
        order.slice(otherPosition + 1).filter((kind) => kind === "flood").length,
      ).toBeGreaterThanOrEqual(FLOOD_RUNS - 2);
      // Both daemons ran Attempts of the pool.
      expect(new Set(claimed.map((row) => String(row.worker_id)))).toEqual(new Set(workerIds));
      for (const worker of workers) await stopWorker(worker);
      session.oracles.push({
        check: "twoDaemonFairShare",
        healthy: true,
        daemons: [
          { worker: workerIds[0], rootless: false },
          { worker: workerIds[1], rootless: true },
        ],
        slotsPerWorker: 1,
        floodRuns: FLOOD_RUNS,
        claimOrder: order,
        otherClaimPosition: otherPosition,
        attemptsPerWorker: workerIds.map(
          (id) => claimed.filter((row) => String(row.worker_id) === id).length,
        ),
      });
    });
  }, 600_000);
});
