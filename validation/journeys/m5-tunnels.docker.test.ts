import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { request as httpsRequest } from "node:https";
import { join } from "node:path";
import type { Duplex } from "node:stream";
import { connect as tlsConnect } from "node:tls";
import type { ExecutablePlan, PlanStep } from "@testmaster/contracts";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { loadOrCreatePopKey } from "../../packages/application/src/proof-of-possession.js";
import {
  httpsWorkerTransport,
  RemoteCallError,
} from "../../packages/application/src/remote-worker-agent.js";
import { TunnelAgent } from "../../packages/application/src/tunnel-agent.js";
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
import { type PartitionRelay, startPartitionRelay } from "./partition-relay.js";
import { type ServerStack, type Spawned, startServerStack } from "./server-stack.js";
import {
  admitThroughTunnel,
  type Laptop,
  lineOf,
  lines,
  startLaptop,
  startCliAgent as startTunnelAgent,
} from "./tunnel-helpers.js";

/** Text only the developer's loopback target serves: it must never cross the relay in clear. */
const MARKER = "laptop-only-7f3c9e1a5b";
const TENANT_MARKER = "tenant-two-2d8b6f04";
/** A held step waits far longer than any check below; only the tunnel or the Run may end it. */
const HELD_STEP_TIMEOUT_MS = 240_000;

function markerPlan(marker: string): ExecutablePlan {
  return executable(
    "Laptop marker",
    "http",
    [
      action("marker_request", "request", { method: "GET", pathSegments: [literal("health")] }),
      { ...assertion("marker_status", { responseStepId: "marker_request" }, "statusIn") },
      assertion(
        "marker_value",
        { responseStepId: "marker_request", jsonPointer: "/marker" },
        "jsonEquals",
        marker,
      ),
    ].map((step) =>
      step.id === "marker_status"
        ? ({ ...step, expectation: { predicate: "statusIn", values: [200] } } as PlanStep)
        : step,
    ),
  );
}

function heldPlan(path: string): ExecutablePlan {
  const plan = healthPlan("ok", path);
  return {
    ...plan,
    steps: plan.steps.map((step, index) =>
      index === 0 ? ({ ...step, timeoutMs: HELD_STEP_TIMEOUT_MS } as PlanStep) : step,
    ),
  };
}

interface Upgrade {
  readonly status: number;
  readonly socket?: Duplex;
  readonly code?: string;
}

/**
 * M5-02 self-hosted tunnels (ADR-031) on the real server profile: PostgreSQL, the API behind TLS
 * with the relay in its process, `tunnel start` agents on the developer side and `worker start
 * --mode remote` workers running each tunnelled Attempt in the hardened Docker sandbox.
 */
describe("M5-02 tunnels", () => {
  let postgres: PostgresTestServer | undefined;
  let stack: ServerStack | undefined;
  let laptop: Laptop | undefined;
  let admin: Laptop | undefined;
  let tenantLaptop: Laptop | undefined;
  let session: Journey | undefined;
  let failure: unknown;
  const relays: PartitionRelay[] = [];
  const agents: AbortController[] = [];
  const ids = {
    project: ["", ""],
    environment: ["", ""],
    otherProject: "",
    otherEnvironment: "",
    adminEnvironment: "",
  };
  const tokens = ["", ""];
  let caFile = "";

  const live = () => {
    if (!stack || !laptop || !admin || !tenantLaptop || !session)
      throw new Error("journey setup missing");
    return { stack, laptop, admin, tenantLaptop, session };
  };

  const record = async <T>(work: () => Promise<T>): Promise<T> => {
    try {
      return await work();
    } catch (error) {
      failure ??= error;
      throw error;
    }
  };

  const api = (workspace: number, method: string, path: string, body?: unknown) => {
    const client = live().stack.ownerClient(workspace);
    return method === "GET" ? client.request("GET", path) : client.mutate(method, path, body);
  };

  const data = async (workspace: number, method: string, path: string, body?: unknown) => {
    const response = await api(workspace, method, path, body);
    if (response.status >= 300)
      throw new Error(`${method} ${path}: ${response.status} ${response.text}`);
    return object(object(response.json()).data);
  };

  const refusal = async (workspace: number, method: string, path: string, body?: unknown) => {
    const response = await api(workspace, method, path, body);
    expect(response.status, response.text).toBeGreaterThanOrEqual(400);
    const error = object(object(response.json()).error);
    return { status: response.status, code: text(error.code), details: object(error.details) };
  };

  const createTest = async (workspace: number, projectId: string, plan: ExecutablePlan) =>
    text(
      (await data(workspace, "POST", `/v1/projects/${projectId}/tests`, { plan, origin: "manual" }))
        .id,
    );

  /** Admits a Run through a tunnel, binding the approval the refusal names first (SEC-039). */
  const admit = async (
    workspace: number,
    testId: string,
    tunnelId: string,
    environmentId = ids.environment[workspace],
  ) => {
    const runId = await admitThroughTunnel(live().stack, workspace, {
      testId,
      environmentId: environmentId as string,
      tunnelId,
    });
    live().session.runIds.push(runId);
    return runId;
  };

  const run = (workspace: number, runId: string) => data(workspace, "GET", `/v1/runs/${runId}`);

  const completed = (workspace: number, runId: string, timeoutMs = 180_000) =>
    eventually(
      () => run(workspace, runId),
      (view) => view.phase === "completed",
      timeoutMs,
    );

  const scope = async () => (await live().stack.scope()).database;

  const completionReason = async (runId: string) =>
    (await scope()).get(
      "SELECT json_extract(data_json,'$.reasonCode') AS reason FROM outbox WHERE aggregate_id=? AND type='run.completed'",
      runId,
    )?.reason;

  const attemptOf = async (runId: string) =>
    eventually(
      async () =>
        (await scope()).get(
          "SELECT id,worker_id FROM attempts WHERE run_id=? ORDER BY number DESC LIMIT 1",
          runId,
        ),
      (row) => row !== undefined,
      120_000,
    ).then((row) => ({ id: text(row?.id), workerId: text(row?.worker_id) }));

  const tunnel = (workspace: number, tunnelId: string) =>
    data(workspace, "GET", `/v1/tunnels/${tunnelId}`);

  const usage = async (workspace: number, tunnelId: string) =>
    object((await tunnel(workspace, tunnelId)).usage);

  /** `tunnel start` of the built CLI, in the foreground until it ends. */
  const startCliAgent = (
    workspace: number,
    target: string,
    extra: string[] = [],
    endpoint = live().stack.baseUrl,
  ) =>
    startTunnelAgent(live().stack, {
      projectId: ids.project[workspace] as string,
      token: tokens[workspace] as string,
      caFile,
      target,
      extra,
      endpoint,
    });

  const agentResult = async (agent: Spawned) => {
    await agent.exited;
    return object(object(JSON.parse(agent.stdout())).data);
  };

  /** A tunnel created over REST and served by an in-process agent, for open-token checks. */
  const startApiAgent = async (workspace: number, port: number) => {
    const opening = await data(workspace, "POST", "/v1/tunnels", {
      projectId: ids.project[workspace],
      target: { address: "127.0.0.1", port },
    });
    const view = object(opening.tunnel);
    const options = {
      endpoint: live().stack.baseUrl,
      ca: live().stack.ca.caPem,
      tunnelId: text(view.id),
      openToken: text(opening.openToken),
      target: { address: "127.0.0.1" as const, port },
      expiresAt: text(view.expiresAt),
    };
    const ready = Promise.withResolvers<void>();
    const controller = new AbortController();
    agents.push(controller);
    const ended = new TunnelAgent({
      ...options,
      log: (entry) => {
        if (entry.event === "tunnel.ready") ready.resolve();
      },
    }).run(controller.signal);
    ended.catch(ready.reject);
    await ready.promise;
    return { ...options, controller, ended };
  };

  const startWorker = async (workspace: number, name: string): Promise<Spawned> => {
    const { stack } = live();
    const token = text((await data(workspace, "POST", "/v1/workers", { name })).enrollmentToken);
    const directory = join(stack.cwd, ".workers", name);
    await mkdir(directory, { recursive: true, mode: 0o700 });
    const tokenFile = join(directory, "enroll.token");
    await writeFile(tokenFile, token, { mode: 0o600 });
    const worker = stack.spawn([
      "worker",
      "start",
      "--mode",
      "remote",
      "--controller",
      stack.baseUrl,
      "--ca-file",
      caFile,
      "--enroll-token-file",
      tokenFile,
      "--data-dir",
      join(directory, "data"),
      "--slots",
      "2",
    ]);
    await eventually(
      async () => lines(worker),
      (seen) =>
        seen.some((line) => line.event === "worker.ready") || worker.child.exitCode !== null,
      120_000,
    );
    if (worker.child.exitCode !== null)
      throw new Error(`remote worker ${name} exited: ${worker.stderr()} ${worker.stdout()}`);
    return worker;
  };

  /** The signed transport of an enrolled worker, built from its own key file. */
  const workerTransport = async (name: string) =>
    httpsWorkerTransport({
      endpoint: live().stack.baseUrl,
      credential: "unused-after-enrollment",
      key: await loadOrCreatePopKey(
        join(live().stack.cwd, ".workers", name, "data", "worker-key.pem"),
      ),
      ca: live().stack.ca.caPem,
    });

  const openStream = async (
    transport: Awaited<ReturnType<typeof workerTransport>>,
    workerId: string,
    attemptId: string,
  ): Promise<Upgrade> => {
    try {
      const socket = await transport.openStream(
        `/workers/${workerId}/attempts/${attemptId}/tunnel`,
      );
      socket.on("error", () => undefined);
      return { status: 101, socket };
    } catch (error) {
      if (!(error instanceof RemoteCallError)) throw error;
      return { status: error.status, code: error.code };
    }
  };

  /** A bare upgrade request: what an anonymous caller of the published address can do. */
  const upgrade = (path: string, headers: Record<string, string>): Promise<Upgrade> => {
    const { promise, resolve, reject } = Promise.withResolvers<Upgrade>();
    const request = httpsRequest(new URL(path, live().stack.baseUrl), {
      method: "GET",
      headers: { connection: "Upgrade", upgrade: "testmaster-tunnel/1", ...headers },
      ca: live().stack.ca.caPem,
    });
    request.on("upgrade", (_response, socket) => resolve({ status: 101, socket }));
    request.on("response", (response) => {
      const chunks: Buffer[] = [];
      response.on("data", (chunk: Buffer) => chunks.push(chunk));
      response.on("end", () => {
        const body = JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
        resolve({ status: response.statusCode ?? 0, code: body?.error?.code });
      });
    });
    request.on("error", reject);
    request.end();
    return promise;
  };

  const stopProcess = async (process: Spawned, signal: NodeJS.Signals = "SIGTERM") => {
    if (process.child.exitCode !== null || process.child.signalCode !== null) return;
    process.child.kill(signal);
    // Cleanup only: a process that ignores SIGTERM must not keep the journey alive.
    const kill = setTimeout(() => process.child.kill("SIGKILL"), 60_000);
    await process.exited;
    clearTimeout(kill);
  };

  beforeAll(async () => {
    session = await Journey.create("M5-02-tunnels", {
      class: "deterministic-e2e",
      runner: "real-docker-remote-workers",
      externalDependency: "local-loopback-target",
      limitations: [
        "Developer machine, relay, remote workers and Docker share one physical host: the target listens on host loopback, so the journey proves the worker's egress reaches it only through the tunnel by refusing every other loopback port the environment allows.",
        "The heartbeat loss is a blackholing TCP relay between one agent and the API's TLS proxy; the relay sees the API side of that proxy, which stands in for Caddy.",
      ],
    });
    postgres = await startPostgresTestServer();
    const server = postgres;
    admin = await startLaptop("admin-api");
    laptop = await startLaptop(MARKER, `http://127.0.0.1:${admin.port}`);
    tenantLaptop = await startLaptop(TENANT_MARKER);
    stack = await startServerStack({ workspaces: 2, database: () => createTestDatabaseOn(server) });
    caFile = join(stack.cwd, "stack-ca.pem");
    await writeFile(caFile, stack.ca.caPem, { mode: 0o600 });
    for (const workspace of [0, 1]) {
      const owner = stack.workspaces[workspace]?.owner;
      if (!owner) throw new Error("stack workspace missing");
      tokens[workspace] = await stack.issueToken(owner.principalId, ["R", "W", "X"], [], workspace);
      ids.project[workspace] = text(
        (await data(workspace, "POST", "/v1/projects", { name: `M5-02 project ${workspace}` })).id,
      );
      const target = workspace === 0 ? laptop : tenantLaptop;
      ids.environment[workspace] = text(
        (
          await data(workspace, "POST", `/v1/projects/${ids.project[workspace]}/environments`, {
            name: "laptop",
            baseUrl: target.url,
            networkProfile: "local-loopback",
            // The machine's admin API is an allowed origin: only the tunnel itself may refuse it.
            ...(workspace === 0 ? { additionalOrigins: [`http://127.0.0.1:${admin.port}`] } : {}),
          })
        ).id,
      );
    }
    ids.adminEnvironment = text(
      (
        await data(0, "POST", `/v1/projects/${ids.project[0]}/environments`, {
          name: "admin",
          baseUrl: `http://127.0.0.1:${admin.port}`,
          networkProfile: "local-loopback",
        })
      ).id,
    );
    ids.otherProject = text(
      (await data(0, "POST", "/v1/projects", { name: "M5-02 other project" })).id,
    );
    ids.otherEnvironment = text(
      (
        await data(0, "POST", `/v1/projects/${ids.otherProject}/environments`, {
          name: "laptop",
          baseUrl: laptop.url,
          networkProfile: "local-loopback",
        })
      ).id,
    );
  }, 300_000);

  afterAll(async () => {
    if (stack && failure !== undefined)
      session?.oracles.push({ check: "stackLogs", logs: stack.logs().slice(-20_000) });
    await session?.close(failure);
    for (const controller of agents) controller.abort();
    for (const relay of relays) await relay.close().catch(() => undefined);
    await stack?.stop();
    for (const target of [laptop, admin, tenantLaptop]) await target?.close();
    await postgres?.stop();
  }, 300_000);

  // The main tunnel, its worker and their state carry over between the scenarios below.
  let main: { agent: Spawned; tunnelId: string } | undefined;
  let worker: Spawned | undefined;
  let workerId = "";
  let tenantWorker: Spawned | undefined;
  let tenantWorkerId = "";
  let finishedAttemptId = "";

  it("M5-02 SEC-041 SEC-044 a remote worker reaches only the tunnel's loopback target, end to end over TLS the relay cannot read", async () => {
    await record(async () => {
      const { stack, laptop, admin, session } = live();

      // SEC-041: a name, a LAN address, the metadata address or a wildcard never becomes a target.
      for (const target of ["localhost:8080", "10.0.0.5:80", "169.254.169.254:80", "0.0.0.0:80"]) {
        const refused = stack.spawn(
          [
            "--endpoint",
            stack.baseUrl,
            "tunnel",
            "start",
            "--project",
            ids.project[0] as string,
            "--target",
            target,
          ],
          { TESTMASTER_API_KEY: tokens[0] as string, NODE_EXTRA_CA_CERTS: caFile },
        );
        expect(await refused.exited, target).not.toBe(0);
        expect(JSON.parse(refused.stdout()).error.code, target).toBe("INVALID_ARGUMENT");
      }
      for (const address of ["192.168.1.10", "0.0.0.0", "localhost"])
        expect(
          (
            await refusal(0, "POST", "/v1/tunnels", {
              projectId: ids.project[0],
              target: { address, port: laptop.port },
            })
          ).code,
          address,
        ).toBe("INVALID_ARGUMENT");

      main = await startCliAgent(0, `127.0.0.1:${laptop.port}`);
      const { tunnelId } = main;
      expect(await tunnel(0, tunnelId)).toMatchObject({
        state: "active",
        live: true,
        target: { address: "127.0.0.1", port: laptop.port },
      });
      worker = await startWorker(0, "tunnel-worker");
      workerId = text(lineOf(worker, "worker.ready")?.workerId);

      // A Run through the tunnel reads the marker only the loopback app serves.
      const markerTest = await createTest(0, ids.project[0] as string, markerPlan(MARKER));
      const runId = await admit(0, markerTest, tunnelId);
      const passed = await completed(0, runId);
      expect(passed.outcome).toBe("passed");
      expect(laptop.hits("/health")).toBe(1);
      finishedAttemptId = (await attemptOf(runId)).id;
      expect(lines(main.agent).filter((line) => line.event === "tunnel.stream.opened").length).toBe(
        1,
      );
      // The one stream is the only way in: the worker never connected to the app directly.
      expect(laptop.connections()).toBe(1);

      // End-to-end TLS: the relay forwarded the marker and the request line only as ciphertext.
      const relayed = stack.proxy.upgradedTraffic();
      expect(relayed.length).toBeGreaterThan(0);
      for (const clear of [MARKER, "GET /health", `127.0.0.1:${laptop.port}`])
        expect(relayed.includes(Buffer.from(clear)), clear).toBe(false);

      // Another loopback port the environment allows is refused by the tunnel, never dialed.
      expect((await fetch(`http://127.0.0.1:${admin.port}/`)).status).toBe(200);
      const adminHitsBefore = admin.hits("/");
      const redirectTest = await createTest(
        0,
        ids.project[0] as string,
        executable("Redirect to the admin API", "http", [
          action("redirect_request", "request", {
            method: "GET",
            pathSegments: [literal("to-admin")],
          }),
          {
            ...assertion("redirect_status", { responseStepId: "redirect_request" }, "statusIn"),
            expectation: { predicate: "statusIn", values: [200] },
          } as PlanStep,
        ]),
      );
      const redirected = await completed(0, await admit(0, redirectTest, tunnelId));
      expect(redirected.outcome).not.toBe("passed");
      expect(laptop.hits("/to-admin")).toBe(1);
      expect(admin.hits("/")).toBe(adminHitsBefore);

      // Admission binds the tunnel to its project and to its exact target.
      expect(
        await refusal(0, "POST", "/v1/runs", {
          testId: markerTest,
          environmentId: ids.adminEnvironment,
          tunnelId,
        }),
      ).toMatchObject({ code: "POLICY_DENIED", details: { reasonCode: "tunnel_target_mismatch" } });
      const otherTest = await createTest(0, ids.otherProject, markerPlan(MARKER));
      expect(
        (
          await refusal(0, "POST", "/v1/runs", {
            testId: otherTest,
            environmentId: ids.otherEnvironment,
            tunnelId,
          })
        ).code,
      ).toBe("NOT_FOUND");

      session.oracles.push({
        check: "tunnelReachesOnlyItsTarget",
        healthy: true,
        tunnelId,
        markerRun: { runId, outcome: passed.outcome },
        redirectToAdmin: {
          outcome: redirected.outcome,
          adminHits: admin.hits("/") - adminHitsBefore,
        },
        refusedTargets: ["localhost:8080", "10.0.0.5:80", "169.254.169.254:80", "0.0.0.0:80"],
        relayedBytes: relayed.length,
        plaintextInRelay: false,
      });
    });
  }, 600_000);

  it("M5-02 SEC-042 SEC-044 the relay admits a stream only for a held Attempt of the tunnel's Run, refuses the 33rd without affecting another tenant and is never a general proxy", async () => {
    await record(async () => {
      const { laptop, tenantLaptop, session } = live();
      if (!main || !worker) throw new Error("main tunnel missing");
      const { tunnelId } = main;

      const holdTest = await createTest(0, ids.project[0] as string, heldPlan("hold-flood"));
      const holdRun = await admit(0, holdTest, tunnelId);
      await eventually(
        async () => laptop.heldAt("/hold-flood"),
        (held) => held.length === 1,
        180_000,
      );
      const attempt = await attemptOf(holdRun);
      expect(attempt.workerId).toBe(workerId);
      const own = await workerTransport("tunnel-worker");

      // Anonymous callers of the published address reach nothing.
      expect(
        await upgrade(`/v1/workers/${workerId}/attempts/${attempt.id}/tunnel`, {}),
      ).toMatchObject({
        status: 401,
      });
      expect(await upgrade(`/v1/tunnels/${tunnelId}/session`, {})).toMatchObject({ status: 401 });

      // Another tenant's worker, a finished Attempt and a forged worker id are refused.
      tenantWorker = await startWorker(1, "tenant-worker");
      tenantWorkerId = text(lineOf(tenantWorker, "worker.ready")?.workerId);
      const foreign = await workerTransport("tenant-worker");
      expect(await openStream(foreign, tenantWorkerId, attempt.id)).toMatchObject({
        status: 422,
        code: "PRECONDITION_FAILED",
      });
      expect(await openStream(own, workerId, finishedAttemptId)).toMatchObject({
        code: "PRECONDITION_FAILED",
      });
      expect((await openStream(own, tenantWorkerId, attempt.id)).status).toBe(401);

      // The worker holding the Attempt fills the session's 32 streams; the 33rd is refused.
      const probes: Duplex[] = [];
      const active = async () => Number((await usage(0, tunnelId)).activeStreams);
      while ((await active()) < 32) {
        const opened = await openStream(own, workerId, attempt.id);
        expect(opened.status).toBe(101);
        if (opened.socket) probes.push(opened.socket);
      }
      const flood = await openStream(own, workerId, attempt.id);
      expect(flood).toMatchObject({ status: 429, code: "QUOTA_EXCEEDED" });

      // Another tenant's tunnel and Run are unaffected while the flood holds every stream.
      const tenantAgent = await startApiAgent(1, tenantLaptop.port);
      const tenantTest = await createTest(1, ids.project[1] as string, markerPlan(TENANT_MARKER));
      const tenantRun = await completed(1, await admit(1, tenantTest, tenantAgent.tunnelId));
      expect(tenantRun.outcome).toBe("passed");

      // A stream is a byte pipe to the one target: a request naming the metadata service, LAN or
      // another port still lands on the developer's app, behind the agent's pinned certificate.
      const probe = probes[0];
      if (!probe) throw new Error("no probe stream");
      const secure = tlsConnect({ socket: probe, rejectUnauthorized: false });
      await new Promise<void>((resolve, reject) => {
        secure.once("secureConnect", resolve);
        secure.once("error", reject);
      });
      const peer = secure.getPeerX509Certificate();
      expect(peer && createHash("sha256").update(peer.raw).digest("hex")).toBe(
        (await tunnel(0, tunnelId)).certificateSha256,
      );
      const answer = Promise.withResolvers<string>();
      let received = "";
      secure.on("data", (chunk: Buffer) => {
        received += chunk.toString("utf8");
        if (received.includes(MARKER)) answer.resolve(received);
      });
      secure.write(
        "GET http://169.254.169.254/latest/meta-data/ HTTP/1.1\r\nHost: 169.254.169.254\r\nConnection: close\r\n\r\n",
      );
      expect(await answer.promise).toContain(MARKER);
      expect(laptop.seen.at(-1)).toEqual({ host: "169.254.169.254", path: "/latest/meta-data/" });

      for (const socket of probes) socket.destroy();
      secure.destroy();
      await eventually(active, (count) => count === 1, 30_000);
      const settledUsage = await usage(0, tunnelId);
      expect(Number(settledUsage.streamsRefused)).toBeGreaterThanOrEqual(1);

      // Owner revocation of the tenant tunnel stays inside that tenant.
      tenantAgent.controller.abort();
      await tenantAgent.ended;
      expect((await tunnel(0, tunnelId)).live).toBe(true);

      // The quota decisions are audited with ids and hashes only.
      const audit = (await scope()).all(
        "SELECT action,resource_id,request_id,after_hash FROM audit_events WHERE resource_id=? ORDER BY created_at",
        tunnelId,
      );
      const actions = audit.map((row) => String(row.action));
      expect(actions).toEqual(
        expect.arrayContaining([
          "tunnel.create.allowed",
          "tunnel.open.allowed",
          "tunnel.stream.allowed",
          "tunnel.stream_quota.denied",
        ]),
      );
      expect(JSON.stringify(audit)).not.toContain(MARKER);

      // The held Run is still running; cancelling it closes only its stream.
      const cancelledAt = Date.now();
      await data(0, "POST", `/v1/runs/${holdRun}/cancel`, {});
      const held = laptop.heldAt("/hold-flood")[0];
      await eventually(
        async () => held?.closedAt ?? null,
        (closedAt) => closedAt !== null,
        30_000,
      );
      const cancelled = await completed(0, holdRun);
      expect(cancelled.outcome).toBe("cancelled");
      expect(await tunnel(0, tunnelId)).toMatchObject({ state: "active", live: true });

      session.oracles.push({
        check: "streamAuthorityAndQuota",
        healthy: true,
        tunnelId,
        anonymous: 401,
        foreignWorker: "PRECONDITION_FAILED",
        finishedAttempt: "PRECONDITION_FAILED",
        forgedWorkerId: 401,
        streamsBeforeRefusal: 32,
        thirtyThird: "QUOTA_EXCEEDED",
        otherTenantRun: tenantRun.outcome,
        metadataRequestLandedOn: "loopback target",
        auditActions: [...new Set(actions)].sort(),
        cancelClosedStreamAfterMs: Number(held?.closedAt) - cancelledAt,
      });
    });
  }, 600_000);

  it("M5-02 SEC-043 stopping a borrowing worker leaves the owner's tunnel open and the next worker completes the Run through it", async () => {
    await record(async () => {
      const { laptop, session } = live();
      if (!main || !worker) throw new Error("main tunnel missing");
      const { tunnelId } = main;
      const onceTest = await createTest(0, ids.project[0] as string, heldPlan("once-borrower"));
      const runId = await admit(0, onceTest, tunnelId);
      await eventually(
        async () => laptop.heldAt("/once-borrower"),
        (held) => held.length === 1,
        180_000,
      );
      await stopProcess(worker, "SIGKILL");
      const held = laptop.heldAt("/once-borrower")[0];
      await eventually(
        async () => held?.closedAt ?? null,
        (closedAt) => closedAt !== null,
        30_000,
      );
      expect(await tunnel(0, tunnelId)).toMatchObject({ state: "active", live: true });
      expect(main.agent.child.exitCode).toBeNull();

      worker = await startWorker(0, "tunnel-worker-2");
      workerId = text(lineOf(worker, "worker.ready")?.workerId);
      const finished = await completed(0, runId, 240_000);
      expect(finished.outcome).toBe("passed");
      expect(laptop.hits("/once-borrower")).toBe(2);
      session.oracles.push({
        check: "borrowerStopKeepsOwner",
        healthy: true,
        tunnelId,
        runId,
        outcome: finished.outcome,
        tunnelStateAfterBorrowerStop: "active",
      });
    });
  }, 600_000);

  it("M5-02 SEC-043 owner revocation closes the active stream within 5 s, refuses new ones and cancels the bound Run with tunnel_lost", async () => {
    await record(async () => {
      const { stack, laptop, session } = live();
      if (!main || !worker) throw new Error("main tunnel missing");
      const { tunnelId, agent } = main;
      const holdTest = await createTest(0, ids.project[0] as string, heldPlan("hold-revoke"));
      const runId = await admit(0, holdTest, tunnelId);
      await eventually(
        async () => laptop.heldAt("/hold-revoke"),
        (held) => held.length === 1,
        180_000,
      );
      const attempt = await attemptOf(runId);

      const stop = stack.spawn(["--endpoint", stack.baseUrl, "tunnel", "stop", tunnelId], {
        TESTMASTER_API_KEY: tokens[0] as string,
        NODE_EXTRA_CA_CERTS: caFile,
      });
      expect(await stop.exited, stop.stderr()).toBe(0);
      expect(JSON.parse(stop.stdout()).data).toMatchObject({ state: "revoked" });
      const held = laptop.heldAt("/hold-revoke")[0];
      await eventually(
        async () => held?.closedAt ?? null,
        (closedAt) => closedAt !== null,
        30_000,
      );
      // Measured from the revocation the server recorded, not from the CLI's process start.
      const revokedAt = Date.parse(text((await tunnel(0, tunnelId)).closedAt));
      const closedAfterMs = Number(held?.closedAt) - revokedAt;
      expect(closedAfterMs, `revoked ${revokedAt} closed ${held?.closedAt}`).toBeLessThanOrEqual(
        5_000,
      );

      // New streams stop at once at the authority.
      expect(
        (await openStream(await workerTransport("tunnel-worker-2"), workerId, attempt.id)).status,
      ).toBeGreaterThanOrEqual(400);
      expect(await agentResult(agent)).toMatchObject({ tunnelId, reason: "owner_revoked" });

      const cancelled = await completed(0, runId);
      expect(cancelled.outcome).toBe("cancelled");
      expect(await completionReason(runId)).toBe("tunnel_lost");
      expect(await tunnel(0, tunnelId)).toMatchObject({
        state: "revoked",
        closeReason: "owner_revoked",
        live: false,
      });
      const next = await createTest(0, ids.project[0] as string, markerPlan(MARKER));
      expect(
        await refusal(0, "POST", "/v1/runs", {
          testId: next,
          environmentId: ids.environment[0],
          tunnelId,
        }),
      ).toMatchObject({ code: "PRECONDITION_FAILED", details: { reasonCode: "tunnel_lost" } });

      // A used open token never opens a second session.
      const replayed = await startApiAgent(0, laptop.port);
      await expect(
        new TunnelAgent({
          endpoint: replayed.endpoint,
          ca: replayed.ca,
          tunnelId: replayed.tunnelId,
          openToken: replayed.openToken,
          target: replayed.target,
          expiresAt: replayed.expiresAt,
        }).run(new AbortController().signal),
      ).rejects.toMatchObject({ status: 401, code: "UNAUTHENTICATED" });
      replayed.controller.abort();
      await replayed.ended;
      const audit = JSON.stringify(
        (await scope()).all("SELECT * FROM audit_events WHERE resource_id=?", replayed.tunnelId),
      );
      expect(audit).toContain("tunnel.open.denied");
      expect(audit).not.toContain(replayed.openToken);

      session.oracles.push({
        check: "ownerRevocation",
        healthy: true,
        tunnelId,
        runId,
        streamClosedAfterRevocationMs: closedAfterMs,
        runReason: "tunnel_lost",
        agentReason: "owner_revoked",
        replayedOpenToken: "UNAUTHENTICATED",
      });
    });
  }, 600_000);

  it("M5-02 SEC-043 a silent control channel and the TTL end the session on both sides and cancel the bound Run", async () => {
    await record(async () => {
      const { stack, laptop, session } = live();
      const relay = await startPartitionRelay(stack.proxy.port);
      relays.push(relay);
      const silent = await startCliAgent(0, `127.0.0.1:${laptop.port}`, [], relay.origin);
      const expiring = await startCliAgent(0, `127.0.0.1:${laptop.port}`, ["--ttl", "60"]);

      // One held Run on each tunnel; the worker's two slots carry both.
      const silentRun = await admit(
        0,
        await createTest(0, ids.project[0] as string, heldPlan("hold-silent")),
        silent.tunnelId,
      );
      const expiringRun = await admit(
        0,
        await createTest(0, ids.project[0] as string, heldPlan("hold-expiring")),
        expiring.tunnelId,
      );
      for (const path of ["/hold-silent", "/hold-expiring"])
        await eventually(
          async () => laptop.heldAt(path),
          (held) => held.length === 1,
          180_000,
        );
      const partitionedAt = Date.now();
      relay.partition({ silentUpstream: true });
      const held = laptop.heldAt("/hold-silent")[0];
      await eventually(
        async () => held?.closedAt ?? null,
        (closedAt) => closedAt !== null,
        60_000,
      );
      expect(await agentResult(silent.agent)).toMatchObject({ reason: "heartbeat_lost" });
      const ended = await eventually(
        () => tunnel(0, silent.tunnelId),
        (view) => view.state !== "active",
        60_000,
      );
      expect(ended).toMatchObject({ state: "closed", closeReason: "heartbeat_lost" });
      const endedAfterMs = Date.parse(text(ended.closedAt)) - partitionedAt;
      // Three missed 10 s heartbeats, checked every 10 s.
      expect(endedAfterMs).toBeGreaterThanOrEqual(20_000);
      expect(endedAfterMs).toBeLessThan(50_000);
      // The stalled request may end first on the worker's own egress idle limit, so this Run
      // ends inconclusive or `tunnel_lost`; it never passes.
      const silentOutcome = (await completed(0, silentRun)).outcome;
      expect(["inconclusive", "cancelled"]).toContain(silentOutcome);

      // The TTL ends the other session on both sides while its request still flows.
      expect(await agentResult(expiring.agent)).toMatchObject({ reason: "ttl_expired" });
      expect(
        await eventually(
          () => tunnel(0, expiring.tunnelId),
          (view) => view.state !== "active",
          30_000,
        ),
      ).toMatchObject({ state: "expired", closeReason: "ttl_expired" });
      const expiringHeld = laptop.heldAt("/hold-expiring")[0];
      await eventually(
        async () => expiringHeld?.closedAt ?? null,
        (closedAt) => closedAt !== null,
        30_000,
      );
      expect((await completed(0, expiringRun)).outcome).toBe("cancelled");
      expect(await completionReason(expiringRun)).toBe("tunnel_lost");

      session.oracles.push({
        check: "heartbeatLossAndTtl",
        healthy: true,
        silentTunnel: {
          tunnelId: silent.tunnelId,
          endedAfterPartitionMs: endedAfterMs,
          boundRunOutcome: silentOutcome,
          boundRunReason: await completionReason(silentRun),
        },
        expiringTunnel: { tunnelId: expiring.tunnelId, reason: "ttl_expired" },
        boundRunReason: "tunnel_lost",
      });
      await stopProcess(worker as Spawned);
      await stopProcess(tenantWorker as Spawned);
    });
  }, 600_000);
});
