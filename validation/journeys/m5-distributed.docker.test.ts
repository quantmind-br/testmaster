import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { Readable } from "node:stream";
import type { ExecutablePlan } from "@testmaster/contracts";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  type Controller,
  type ControllerName,
  type DistributedDeployment,
  type LiveController,
  startDistributedDeployment,
} from "./distributed-deployment.js";
import { eventually, healthPlan, Journey, type Json, object, text } from "./harness.js";
import type { Spawned } from "./server-stack.js";
import type { HttpsClient } from "./tls-proxy.js";
import {
  admitThroughTunnel,
  type Laptop,
  lineOf,
  lines,
  startLaptop,
  startCliAgent as startTunnelAgent,
} from "./tunnel-helpers.js";

/** Text only the journey's loopback target serves. */
const MARKER = "distributed-journey-3b7e51c9";
/** Term of every controller lease (`LOOP_LEASE_MS`); a survivor takes over within a term and a poll. */
const LEASE_TTL_MS = 30_000;
/** The documented bound of a leaderless scheduler: two terms (alerts.md). */
const LEADERLESS_BOUND_MS = 2 * LEASE_TTL_MS;

interface Aggregated {
  readonly runId: string;
  readonly attemptId: string;
  readonly workspaceId: string;
}

async function sha256Of(stream: Readable): Promise<string> {
  const hash = createHash("sha256");
  for await (const chunk of stream) hash.update(chunk as Buffer);
  return hash.digest("hex");
}

/**
 * M5 distributed profile (ADR-035, specs/08 `distributed`) on the real reference deployment of
 * `deploy/compose/compose.distributed.yaml`: PostgreSQL 17 with TLS, MinIO with TLS and Object Lock,
 * two controllers and Caddy in front of both, with remote workers, tunnel agents and the backup agent
 * as host processes on the default (rootful) Docker daemon. Each controller also has a TLS front
 * owned by this journey so a worker or an agent can be pinned to one controller deterministically.
 */
describe("M5 distributed profile", () => {
  let d: DistributedDeployment | undefined;
  let session: Journey | undefined;
  let laptop: Laptop | undefined;
  let failure: unknown;
  let projectId = "";
  let environmentId = "";
  let healthTestId = "";
  const facts: Record<string, Json> = {};

  const live = () => {
    if (!d || !session || !laptop) throw new Error("journey setup missing");
    return { d, session, laptop };
  };

  const record = async <T>(work: () => Promise<T>): Promise<T> => {
    try {
      return await work();
    } catch (error) {
      failure ??= error;
      throw error;
    }
  };

  const call = async (client: HttpsClient, method: string, path: string, body?: unknown) =>
    method === "GET" ? client.request("GET", path) : client.mutate(method, path, body);

  const data = async (
    client: HttpsClient,
    method: string,
    path: string,
    body?: unknown,
  ): Promise<Json> => {
    const response = await call(client, method, path, body);
    if (response.status >= 300)
      throw new Error(`${method} ${path}: ${response.status} ${response.text}`);
    return object(object(response.json()).data);
  };

  const database = async () => (await live().d.scope()).database;

  const controllerOf = (name: ControllerName): Controller => {
    const found = live().d.controllers.find((controller) => controller.name === name);
    if (!found) throw new Error(`no controller ${name}`);
    return found;
  };

  const nameOfController = async (id: string): Promise<ControllerName> => {
    const row = (await database()).get<{ internal_origin: string }>(
      "SELECT internal_origin FROM controller_instances WHERE id=?",
      id,
    );
    const found = live().d.controllers.find(
      (controller) => controller.internalOrigin === row?.internal_origin,
    );
    if (!found) throw new Error(`controller ${id} is not a deployed controller`);
    return found.name;
  };

  const liveByName = async (): Promise<Record<ControllerName, LiveController>> => {
    const rows = await live().d.bothLive();
    const byName = Object.fromEntries(rows.map((row) => [row.name, row]));
    return byName as Record<ControllerName, LiveController>;
  };

  const createTest = async (plan: ExecutablePlan) =>
    text(
      (
        await data(live().d.client, "POST", `/v1/projects/${projectId}/tests`, {
          plan,
          origin: "manual",
        })
      ).id,
    );

  const admit = async (client: HttpsClient, testId: string, extra: Json = {}) => {
    const receipt = await data(client, "POST", "/v1/runs", {
      testId,
      environmentId,
      mode: "replay",
      healingPolicy: "off",
      origin: "api",
      limits: { maxAttempts: 2 },
      ...extra,
    });
    const runId = text(receipt.runId);
    live().session.runIds.push(runId);
    return runId;
  };

  const completed = (client: HttpsClient, runId: string, timeoutMs = 240_000) =>
    eventually(
      () => data(client, "GET", `/v1/runs/${runId}`),
      (view) => view.phase === "completed",
      timeoutMs,
    );

  /** Starts `worker start --mode remote` pinned to `origin` and waits until it is ready. */
  const startWorker = async (name: string, origin: string, caPem: string): Promise<Spawned> => {
    const { d } = live();
    const token = text(
      (await data(d.client, "POST", "/v1/workers", { name: `${name}-${randomUUID().slice(0, 8)}` }))
        .enrollmentToken,
    );
    const directory = join(d.cwd, ".workers", name);
    await mkdir(directory, { recursive: true, mode: 0o700 });
    const tokenFile = join(directory, "enroll.token");
    const caFile = join(directory, "ca.pem");
    await writeFile(tokenFile, token, { mode: 0o600 });
    await writeFile(caFile, caPem, { mode: 0o600 });
    const worker = d.spawn([
      "worker",
      "start",
      "--mode",
      "remote",
      "--controller",
      origin,
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

  const stopProcess = async (process: Spawned, signal: NodeJS.Signals = "SIGTERM") => {
    if (process.child.exitCode !== null || process.child.signalCode !== null) return;
    process.child.kill(signal);
    // Cleanup only: a process that ignores SIGTERM must not keep the journey alive.
    const kill = setTimeout(() => process.child.kill("SIGKILL"), 60_000);
    await process.exited;
    clearTimeout(kill);
  };

  /** Caddy's access log of the calls one Attempt made: which upstream answered and with what status. */
  const callsOf = async (attemptId: string) => {
    const log = await live().d.logs("caddy");
    return log.split("\n").flatMap((line) => {
      try {
        const entry = JSON.parse(line) as {
          request?: { uri?: string; method?: string };
          status?: number;
          upstream?: string;
        };
        const uri = entry.request?.uri ?? "";
        return uri.includes(`/attempts/${attemptId}`)
          ? [
              {
                method: String(entry.request?.method),
                path: uri.split("?")[0] ?? uri,
                status: Number(entry.status),
                upstream: String(entry.upstream),
              },
            ]
          : [];
      } catch {
        return [];
      }
    });
  };

  const attemptOf = async (runId: string) => {
    const row = (await database()).get<{ id: string; worker_id: string }>(
      "SELECT id,worker_id FROM attempts WHERE run_id=? ORDER BY number DESC LIMIT 1",
      runId,
    );
    if (!row) throw new Error(`no Attempt for ${runId}`);
    return { id: row.id, workerId: row.worker_id };
  };

  const remoteAttempt = async (attemptId: string) => {
    const row = (await database()).get<{ controller_id: string; state: string; fence: number }>(
      "SELECT controller_id,state,fence FROM remote_attempts WHERE attempt_id=?",
      attemptId,
    );
    if (!row) throw new Error(`no remote_attempts row for ${attemptId}`);
    return { controllerId: row.controller_id, state: row.state, fence: Number(row.fence) };
  };

  const bundlePrefix = (run: Aggregated) =>
    `runs/${run.workspaceId}/${run.runId}/${run.attemptId}/`;

  /** Hash of every object of the Attempt's bundle in the evidence bucket, by key. */
  const bucketBundle = async (run: Aggregated): Promise<Record<string, string>> => {
    const store = live().d.evidenceStore();
    const result: Record<string, string> = {};
    for await (const info of store.list(bundlePrefix(run))) {
      const stream = await store.get(info.key);
      if (!stream) throw new Error(`listed object ${info.key} is gone`);
      result[info.key] = await sha256Of(stream);
    }
    return result;
  };

  interface ManifestEntry {
    readonly relativePath: string;
    readonly artifactId: string;
    readonly mimeType: string;
    readonly sha256: string | null;
    readonly state: string;
  }

  const manifestOf = async (client: HttpsClient, runId: string): Promise<ManifestEntry[]> => {
    const bundle = await data(client, "GET", `/v1/runs/${runId}/bundle`);
    const manifest = object(bundle.manifest);
    return (manifest.entries as ManifestEntry[]) ?? [];
  };

  /**
   * Downloads every textual artifact of the Run through the artifact gateway of `client`'s
   * controller, with a link that `mint` minted, and returns the hash of what arrived by relative path.
   */
  const downloadArtifacts = async (
    mint: HttpsClient,
    download: HttpsClient,
    entries: readonly ManifestEntry[],
  ): Promise<Record<string, string>> => {
    const hashes: Record<string, string> = {};
    for (const entry of entries) {
      if (entry.state !== "available" || !/^(text\/|application\/json)/u.test(entry.mimeType))
        continue;
      const link = await data(mint, "POST", `/v1/artifacts/${entry.artifactId}/links`, {});
      const response = await download.request("GET", text(link.url), { cookies: false });
      if (response.status !== 200)
        throw new Error(`artifact ${entry.relativePath}: ${response.status} ${response.text}`);
      hashes[entry.relativePath] = createHash("sha256").update(response.text, "utf8").digest("hex");
    }
    return hashes;
  };

  /** A passed Run executed by a remote worker pinned to `origin`, admitted through `admitVia`. */
  const executeRun = async (
    name: string,
    worker: { origin: string; caPem: string },
    admitVia: HttpsClient,
    readVia: HttpsClient,
  ): Promise<Aggregated & { workerId: string; process: Spawned }> => {
    const { d } = live();
    const process = await startWorker(name, worker.origin, worker.caPem);
    const runId = await admit(admitVia, healthTestId);
    const view = await completed(readVia, runId);
    expect(view.outcome, JSON.stringify(view)).toBe("passed");
    const attempt = await attemptOf(runId);
    return {
      runId,
      attemptId: attempt.id,
      workerId: attempt.workerId,
      workspaceId: d.workspaceId,
      process,
    };
  };

  let primaryRun: Aggregated | undefined;
  /** The Run the first test executes; later tests (and the backup) reuse its evidence. */
  const ensurePrimaryRun = async (): Promise<Aggregated> => {
    if (primaryRun) return primaryRun;
    const { d } = live();
    const worker = await startWorker("primary", d.baseUrl, d.caPem);
    try {
      const runId = await admit(d.client, healthTestId);
      const view = await completed(d.client, runId);
      expect(view.outcome, JSON.stringify(view)).toBe("passed");
      primaryRun = {
        runId,
        attemptId: (await attemptOf(runId)).id,
        workspaceId: d.workspaceId,
      };
      return primaryRun;
    } finally {
      await stopProcess(worker);
    }
  };

  beforeAll(async () => {
    session = await Journey.create("m5-distributed", {
      class: "deterministic-e2e",
      runner: "real-docker-compose-distributed",
      externalDependency: "local-minio-s3",
      limitations: [
        "Both controllers, PostgreSQL, MinIO, Caddy, the remote workers and the backup agent share one physical host and one Docker daemon; the controllers' private link is the compose bridge network, not a cross-host network.",
        "Only the pinned MinIO image was exercised; AWS S3 and other S3 implementations were not. MinIO needs s3:DeleteObject for a versioned delete, so the backup credential here can hide a backup behind a delete marker (the locked version stays).",
        "The COMPLIANCE lock is one day in the journey (the minimum), so removal after a lock expires is not exercised here.",
        "A journey-owned TLS front per controller pins a worker or an agent to one controller; the public Caddy origin round-robins as deployed. Cross-host failure modes (a partitioned controller, clock skew between hosts) are exercised by unit and PostgreSQL tests, not here.",
      ],
    });
    laptop = await startLaptop(MARKER);
    d = await startDistributedDeployment();
    const client = d.client;
    projectId = text((await data(client, "POST", "/v1/projects", { name: "M5 distributed" })).id);
    environmentId = text(
      (
        await data(client, "POST", `/v1/projects/${projectId}/environments`, {
          name: "loopback",
          baseUrl: laptop.url,
          networkProfile: "local-loopback",
        })
      ).id,
    );
    healthTestId = await createTest(healthPlan("ok", "health"));
  }, 600_000);

  afterAll(async () => {
    if (d && failure !== undefined) {
      const logs = (
        await Promise.all(
          ["server", "server-2", "caddy", "minio"].map(
            async (service) =>
              `## ${service}\n${(await d?.logs(service).catch(() => ""))?.slice(-6_000)}`,
          ),
        )
      ).join("\n");
      session?.oracles.push({ check: "composeLogs", logs });
    }
    await session?.close(failure);
    await d?.teardown();
    await laptop?.close();
  }, 600_000);

  it("M5 distributed two controllers share PostgreSQL and S3 evidence", async () => {
    await record(async () => {
      const { d, session } = live();
      const controllers = await liveByName();
      expect(Object.keys(controllers).sort()).toEqual(["server", "server-2"]);
      expect(new Set(Object.values(controllers).map((row) => row.id)).size).toBe(2);

      // Shared PostgreSQL: a project created on one controller is read on the other.
      const viaA = await d.clientVia("server");
      const viaB = await d.clientVia("server-2");
      const shared = text((await data(viaA, "POST", "/v1/projects", { name: "created on A" })).id);
      expect(text((await data(viaB, "GET", `/v1/projects/${shared}`)).id)).toBe(shared);

      // A remote worker behind Caddy: its Attempt calls round-robin over both controllers, and a
      // call that reaches the non-holder is relayed to the holder (ADR-035).
      const worker = await startWorker("primary", d.baseUrl, d.caPem);
      const crossings: unknown[] = [];
      let crossed = false;
      let evidenceRun: Aggregated | undefined;
      try {
        for (let round = 0; round < 4 && !crossed; round++) {
          const runId = await admit(d.client, healthTestId);
          const view = await completed(d.client, runId);
          expect(view.outcome, JSON.stringify(view)).toBe("passed");
          const attempt = await attemptOf(runId);
          const holder = await remoteAttempt(attempt.id);
          const holderName = await nameOfController(holder.controllerId);
          const calls = await callsOf(attempt.id);
          const upstreams = new Set(calls.map((entry) => entry.upstream));
          const relayed = calls.filter(
            (entry) => entry.upstream !== `${holderName}:7331` && entry.status < 400,
          );
          evidenceRun = {
            runId,
            attemptId: attempt.id,
            workspaceId: d.workspaceId,
          };
          crossings.push({
            runId,
            holder: holderName,
            callsPerUpstream: Object.fromEntries(
              [...upstreams].map((upstream) => [
                upstream,
                calls.filter((entry) => entry.upstream === upstream).length,
              ]),
            ),
            relayedCalls: relayed.length,
            failedCalls: calls.filter((entry) => entry.status >= 400).map((e) => e.path),
          });
          expect(holder.state).toBe("settled");
          // No call of a passed Attempt may have failed because it reached the wrong controller.
          expect(calls.filter((entry) => entry.status >= 400)).toEqual([]);
          crossed = relayed.length > 0;
        }
      } finally {
        await stopProcess(worker);
      }
      expect(crossed, JSON.stringify(crossings)).toBe(true);
      if (!evidenceRun) throw new Error("no Run executed");
      primaryRun = evidenceRun;

      // Shared S3: the bundle one controller published is read through both gateways, hash for hash.
      const entries = await manifestOf(viaA, evidenceRun.runId);
      expect(entries.length).toBeGreaterThan(0);
      expect(await manifestOf(viaB, evidenceRun.runId)).toEqual(entries);
      const fromB = await downloadArtifacts(viaA, viaB, entries);
      const fromA = await downloadArtifacts(viaB, viaA, entries);
      expect(Object.keys(fromA).length).toBeGreaterThan(0);
      expect(fromA).toEqual(fromB);
      for (const entry of entries)
        if (entry.relativePath in fromA)
          expect(fromA[entry.relativePath], entry.relativePath).toBe(entry.sha256);
      const bucket = await bucketBundle(evidenceRun);
      expect(Object.keys(bucket)).toEqual(
        expect.arrayContaining([
          `${bundlePrefix(evidenceRun)}meta.json`,
          `${bundlePrefix(evidenceRun)}manifest.json`,
        ]),
      );
      for (const entry of entries)
        if (entry.sha256)
          expect(
            bucket[`${bundlePrefix(evidenceRun)}${entry.relativePath}`],
            entry.relativePath,
          ).toBe(entry.sha256);
      // Nothing of the bundle is on a controller's disk: the controllers only stage.
      facts.shared = {
        check: "twoControllersShareStores",
        healthy: true,
        controllers: Object.values(controllers).map((row) => ({
          id: row.id,
          origin: row.internalOrigin,
        })),
        projectCreatedOnA: shared,
        rounds: crossings,
        bundleKeys: Object.keys(bucket).length,
        artifactsCompared: Object.keys(fromA).length,
        bundleHashes: bucket,
      };
      session.oracles.push(facts.shared);
    });
  }, 900_000);

  it("M5 distributed a run admitted on one controller is served by the other", async () => {
    await record(async () => {
      const { d, session } = live();
      const controllers = await liveByName();
      const [a, b] = [controllerOf("server"), controllerOf("server-2")];
      const viaA = await d.clientVia("server");
      const requestsOnA = a.front.requests.length;
      const requestsOnB = b.front.requests.length;

      // The worker only ever talks to controller B; the Run is admitted and read on controller A.
      const run = await executeRun(
        "on-b",
        { origin: b.front.origin, caPem: d.frontCaPem },
        viaA,
        viaA,
      );
      try {
        const holder = await remoteAttempt(run.attemptId);
        expect(holder.controllerId).toBe(controllers["server-2"].id);
        expect(holder.controllerId).not.toBe(controllers.server.id);
        expect(holder.state).toBe("settled");
        const seenOnA = a.front.requests.slice(requestsOnA);
        const seenOnB = b.front.requests.slice(requestsOnB);
        expect(seenOnA.some((entry) => entry.startsWith("POST /v1/runs"))).toBe(true);
        expect(seenOnB.some((entry) => entry.startsWith("POST /v1/runs"))).toBe(false);
        expect(seenOnA.filter((entry) => entry.includes("/v1/workers/"))).toEqual([]);
        expect(
          seenOnB.filter((entry) => entry.includes(`/attempts/${run.attemptId}/`)).length,
        ).toBeGreaterThan(0);

        // Controller A never held the Attempt, yet serves its evidence from the shared bucket.
        const entries = await manifestOf(viaA, run.runId);
        const viaB = await d.clientVia("server-2");
        const served = await downloadArtifacts(viaA, viaA, entries);
        expect(await downloadArtifacts(viaB, viaB, entries)).toEqual(served);
        const bucket = await bucketBundle(run);
        for (const entry of entries)
          if (entry.relativePath in served) {
            expect(served[entry.relativePath], entry.relativePath).toBe(entry.sha256);
            expect(bucket[`${bundlePrefix(run)}${entry.relativePath}`]).toBe(entry.sha256);
          }
        session.oracles.push({
          check: "runAdmittedOnOneControllerServedByTheOther",
          healthy: true,
          runId: run.runId,
          admittedAndReadOn: "server",
          claimedAndHeldBy: "server-2",
          holderId: holder.controllerId,
          fence: holder.fence,
          workerCallsSeenOnAdmittingController: 0,
          artifactsServedByAdmittingController: Object.keys(served).length,
        });
      } finally {
        await stopProcess(run.process);
      }
    });
  }, 900_000);

  it("M5 distributed killing the leader moves scheduled loops to the survivor", async () => {
    await record(async () => {
      const { d, session } = live();
      const before = await liveByName();
      const database0 = await database();
      const leases = () =>
        database0.all<{ name: string; holder: string; fence: number; expires_at: string }>(
          "SELECT name,holder,fence,expires_at FROM controller_leases ORDER BY name",
        );
      const heldBefore = await eventually(
        leases,
        (rows) => rows.some((row) => row.name === "scheduler"),
        60_000,
      );
      const schedulerLease = heldBefore.find((row) => row.name === "scheduler");
      if (!schedulerLease) throw new Error("no scheduler lease");
      const victim = await nameOfController(schedulerLease.holder);
      const survivor: ControllerName = victim === "server" ? "server-2" : "server";
      const victimId = before[victim].id;
      const survivorId = before[survivor].id;

      // A schedule that fires every minute, so a firing lands before and another after the kill.
      const suite = await data(d.client, "POST", "/v1/suites", {
        name: `leader-kill-${randomUUID().slice(0, 8)}`,
        selection: { kind: "dynamic", projects: [{ projectId, environmentId }] },
      });
      const schedule = await data(d.client, "POST", "/v1/schedules", {
        name: `every-minute-${randomUUID().slice(0, 8)}`,
        selection: { kind: "suite", suiteId: text(suite.id) },
        trigger: {
          kind: "interval",
          everySeconds: 60,
          anchor: new Date(Date.now() + 5_000).toISOString(),
        },
      });
      const scheduleId = text(schedule.id);
      const firings = async () =>
        (await database()).all<{
          fire_instant: string;
          lease_fence: number;
          state: string;
          created_at: string;
        }>(
          "SELECT fire_instant,lease_fence,state,created_at FROM schedule_firings WHERE schedule_id=? ORDER BY fire_instant",
          scheduleId,
        );
      const first = await eventually(firings, (rows) => rows.length >= 1, 120_000);
      const fenceBefore = Number(first[0]?.lease_fence);
      const schedulerNow = (await leases()).find((row) => row.name === "scheduler");
      expect(Number(schedulerNow?.fence)).toBe(fenceBefore);
      const heldByVictim = (await leases()).filter((row) => row.holder === victimId);
      expect(heldByVictim.map((row) => row.name)).toContain("scheduler");

      // SIGKILL the container that holds the scheduler: no graceful release, only the TTL frees it.
      const killedAt = Date.now();
      await d.compose("kill", victim);
      const published = await eventually(
        async () => {
          const response = await d.client.request("GET", "/v1/projects").catch(() => null);
          return response?.status ?? 0;
        },
        (status) => status === 200,
        30_000,
      );
      expect(published).toBe(200);
      const apiBackAfterMs = Date.now() - killedAt;

      const moved = await eventually(
        leases,
        (rows) =>
          heldByVictim.every((old) => {
            const now = rows.find((row) => row.name === old.name);
            return now !== undefined && now.holder === survivorId && Number(now.fence) > old.fence;
          }),
        LEADERLESS_BOUND_MS + 20_000,
      );
      const takeoverMs = Date.now() - killedAt;
      expect(takeoverMs).toBeLessThanOrEqual(LEADERLESS_BOUND_MS);
      // A lease never has two holders and never goes backwards.
      for (const old of heldBefore) {
        const now = moved.find((row) => row.name === old.name);
        expect(Number(now?.fence)).toBeGreaterThanOrEqual(old.fence);
      }

      // The survivor's scheduler fires the next occurrence, exactly once, under a higher fence.
      const after = await eventually(
        firings,
        (rows) => rows.length >= 2 && Number(rows.at(-1)?.lease_fence) > fenceBefore,
        150_000,
      );
      const instants = after.map((row) => row.fire_instant);
      expect(new Set(instants).size).toBe(instants.length);
      expect([...instants].sort()).toEqual(instants);
      const last = after.at(-1);
      expect(Number(last?.lease_fence)).toBe(
        Number((await leases()).find((row) => row.name === "scheduler")?.fence),
      );
      // The firing the survivor made is for an instant after the kill, not one the victim had seen.
      expect(Date.parse(String(last?.fire_instant))).toBeGreaterThan(killedAt);

      // The killed container stays down until it is started again, then registers as a new controller.
      const state = (
        await d.compose("ps", "--all", "--format", "{{.Service}} {{.State}}", victim)
      ).trim();
      expect(state).toContain("exited");
      const staleRow = (await database()).get<{ stopped_at: string | null }>(
        "SELECT stopped_at FROM controller_instances WHERE id=?",
        victimId,
      );
      expect(staleRow?.stopped_at).toBeNull();
      await d.compose("up", "-d", "--wait", victim);
      const after2 = await liveByName();
      expect(after2[victim].id).not.toBe(victimId);
      expect(after2[survivor].id).toBe(survivorId);

      // Nothing else keeps firing: pause the schedule.
      const view = await data(d.client, "GET", `/v1/schedules/${scheduleId}`);
      await d.client.mutate(
        "POST",
        `/v1/schedules/${scheduleId}/pause`,
        {},
        {
          "if-match": `"${Number(view.version)}"`,
        },
      );
      session.oracles.push({
        check: "leaderKillMovesLoopsToSurvivor",
        healthy: true,
        killed: victim,
        killedControllerId: victimId,
        survivor,
        survivorControllerId: survivorId,
        schedulerFenceBefore: fenceBefore,
        leasesHeldByVictim: heldByVictim.map((row) => ({ name: row.name, fence: row.fence })),
        leasesAfter: moved
          .filter((row) => heldByVictim.some((old) => old.name === row.name))
          .map((row) => ({ name: row.name, holder: row.holder, fence: Number(row.fence) })),
        takeoverMs,
        leaseTtlMs: LEASE_TTL_MS,
        leaderlessBoundMs: LEADERLESS_BOUND_MS,
        apiAnsweredAgainAfterMs: apiBackAfterMs,
        firings: after.map((row) => ({
          fireInstant: row.fire_instant,
          fence: Number(row.lease_fence),
          state: row.state,
        })),
        restartedControllerId: after2[victim].id,
      });
    });
  }, 900_000);

  it("M5 distributed a tunnel stream crosses controllers", async () => {
    await record(async () => {
      const { d, laptop, session } = live();
      const controllers = await liveByName();
      const [a, b] = [controllerOf("server"), controllerOf("server-2")];
      const token = await d.issueToken(["R", "W", "X"]);

      // The developer's agent holds its tunnel on controller A; the worker only knows controller B.
      const agent = await startTunnelAgent(
        { spawn: (args, env) => d.spawn(args, env), baseUrl: a.front.origin },
        {
          projectId,
          token,
          caFile: d.frontCaFile,
          target: `127.0.0.1:${laptop.port}`,
          endpoint: a.front.origin,
        },
      );
      const worker = await startWorker("tunnel-on-b", b.front.origin, d.frontCaPem);
      try {
        const requestsOnA = a.front.requests.length;
        const requestsOnB = b.front.requests.length;
        const hitsBefore = laptop.hits("/health");
        const connectionsBefore = laptop.connections();
        const runId = await admitThroughTunnel({ ownerClient: () => d.client }, 0, {
          testId: healthTestId,
          environmentId,
          tunnelId: agent.tunnelId,
        });
        session.runIds.push(runId);
        const view = await completed(d.client, runId);
        expect(view.outcome, JSON.stringify(view)).toBe("passed");
        const attempt = await attemptOf(runId);
        const holder = await remoteAttempt(attempt.id);
        expect(await nameOfController(holder.controllerId)).toBe("server-2");
        const tunnel = (await database()).get<{ relay_id: string; state: string }>(
          "SELECT relay_id,state FROM tunnels WHERE id=?",
          agent.tunnelId,
        );
        expect(tunnel?.relay_id).toBe(controllers.server.id);
        expect(tunnel?.relay_id).not.toBe(holder.controllerId);

        // The worker opened its stream on B; the agent's one stream was opened by A's relay.
        const seenOnA = a.front.requests.slice(requestsOnA);
        const seenOnB = b.front.requests.slice(requestsOnB);
        expect(seenOnB.some((entry) => entry.endsWith(`/attempts/${attempt.id}/tunnel`))).toBe(
          true,
        );
        expect(seenOnA.some((entry) => entry.includes(`/attempts/${attempt.id}/tunnel`))).toBe(
          false,
        );
        expect(
          lines(agent.agent).filter((line) => line.event === "tunnel.stream.opened").length,
        ).toBe(1);
        expect(laptop.hits("/health")).toBe(hitsBefore + 1);
        expect(laptop.connections()).toBe(connectionsBefore + 1);
        session.oracles.push({
          check: "tunnelStreamCrossesControllers",
          healthy: true,
          runId,
          tunnelId: agent.tunnelId,
          tunnelRelay: "server",
          relayControllerId: tunnel?.relay_id,
          attemptHolder: "server-2",
          attemptHolderId: holder.controllerId,
          streamOpenedOnWorkerSideController: "server-2",
          agentStreams: 1,
          targetHits: 1,
          workerCalledAgentControllerDirectly: false,
          agentReady: lineOf(agent.agent, "tunnel.ready") !== undefined,
        });
      } finally {
        await stopProcess(worker);
        await stopProcess(agent.agent);
      }
    });
  }, 900_000);

  it("M5 distributed backups land in the locked bucket and restore after S3 loss", async () => {
    await record(async () => {
      const { d, session } = live();
      const run = await ensurePrimaryRun();
      const entries = await manifestOf(d.client, run.runId);
      const textual = await downloadArtifacts(d.client, d.client, entries);
      const bundleBefore = await bucketBundle(run);
      expect(Object.keys(textual).length).toBeGreaterThan(0);

      // The backup agent is the only holder of the backup credential; it fulfils an API request.
      const agent = d.spawn(["backup", "agent", "--mode", "server", "--config", d.agentConfigPath]);
      let backupName = "";
      const timings: Record<string, number> = {};
      try {
        await eventually(
          async () => agent.stdout(),
          (out) => out.includes('"agent"') || agent.child.exitCode !== null,
          60_000,
        );
        if (agent.child.exitCode !== null)
          throw new Error(`backup agent exited: ${agent.stderr()} ${agent.stdout()}`);
        const requestedAt = Date.now();
        const operation = await data(d.client, "POST", "/v1/operations/backups", {
          reason: "M5 distributed journey backup",
        });
        const done = await eventually(
          () => data(d.client, "GET", `/v1/operations/${text(operation.id)}`),
          (view) => view.state !== "requested" && view.state !== "running",
          300_000,
        );
        timings.backupMs = Date.now() - requestedAt;
        expect(done.state, JSON.stringify(done)).toBe("completed");
        const listed = object(
          await d.cli("backup", "list", "--mode", "server", "--config", d.agentConfigPath),
        );
        const backups = (listed.items as Json[]) ?? [];
        expect(backups.length).toBeGreaterThan(0);
        backupName = text(backups.at(-1)?.name ?? backups.at(-1)?.directory);
        facts.backupListEntry = object(backups.at(-1));
      } finally {
        await stopProcess(agent);
      }

      // The backup lives in the locked bucket and the controllers' evidence credential cannot touch it.
      const backupStore = d.s3Store(d.s3.backupBucket, d.s3.backup);
      const keys: string[] = [];
      for await (const info of backupStore.list("")) keys.push(info.key);
      const manifestKey = keys.find((key) => key.startsWith("catalog/"));
      expect(manifestKey, keys.join(",")).toBeDefined();
      expect(keys.some((key) => key.includes("database.dump.enc"))).toBe(true);
      const evidenceOnBackup = d.s3Store(d.s3.backupBucket, d.s3.evidence);
      await d
        .evidenceStore()
        .put(`probe/${randomUUID()}`, "evidence credential works on its own bucket");
      const denied: Record<string, boolean> = {};
      denied.list = await (async () => {
        try {
          for await (const _ of evidenceOnBackup.list("")) break;
          return false;
        } catch {
          return true;
        }
      })();
      denied.get = await evidenceOnBackup.get(String(manifestKey)).then(
        () => false,
        () => true,
      );
      denied.put = await evidenceOnBackup.put(`${randomUUID()}/x`, "x").then(
        () => false,
        () => true,
      );
      denied.delete = await evidenceOnBackup.delete(String(manifestKey)).then(
        () => false,
        () => true,
      );
      expect(denied).toEqual({ list: true, get: true, put: true, delete: true });
      // Even the backup credential cannot remove a version under COMPLIANCE retention or overwrite it.
      expect(await backupStore.deleteVersions(String(manifestKey))).toEqual({
        deleted: false,
        locked: true,
      });
      expect(await backupStore.head(String(manifestKey))).not.toBeNull();
      expect(
        await backupStore.put(String(manifestKey), "tampered", { ifNoneMatch: true }),
      ).toMatchObject({ created: false });
      const manifestBytes = await backupStore.get(String(manifestKey));
      expect(manifestBytes && (await sha256Of(manifestBytes))).toBeTruthy();

      // S3 loss: every object of the evidence bucket is gone, and so is the database.
      const lostAt = Date.now();
      const store = d.evidenceStore();
      let removed = 0;
      for await (const info of store.list("")) {
        await store.delete(info.key);
        removed++;
      }
      expect(removed).toBeGreaterThan(0);
      const remaining: string[] = [];
      for await (const info of store.list("")) remaining.push(info.key);
      expect(remaining).toEqual([]);
      await d.compose("stop", "server", "server-2");
      await d.recreateDatabase();

      // Restore into the empty database and the empty bucket with the backup agent's identity.
      const restoreStarted = Date.now();
      const restored = object(
        await d.cli(
          "backup",
          "restore",
          "--mode",
          "server",
          "--config",
          d.agentConfigPath,
          backupName,
        ),
      );
      timings.restoreMs = Date.now() - restoreStarted;
      await d.compose("up", "-d", "--wait", "server", "server-2");
      await d.bothLive();
      timings.lossToServingMs = Date.now() - lostAt;

      // The evidence is back: same objects, same hashes, served again through the artifact gateway.
      const bundleAfter = await bucketBundle(run);
      expect(bundleAfter).toEqual(bundleBefore);
      const owner = await d.signIn();
      const entriesAfter = await manifestOf(owner, run.runId);
      expect(entriesAfter).toEqual(entries);
      const textualAfter = await downloadArtifacts(owner, owner, entriesAfter);
      expect(textualAfter).toEqual(textual);
      for (const entry of entriesAfter)
        if (entry.relativePath in textualAfter)
          expect(textualAfter[entry.relativePath], entry.relativePath).toBe(entry.sha256);
      session.oracles.push({
        check: "backupLockedAndRestoredAfterS3Loss",
        healthy: true,
        runId: run.runId,
        backupName,
        backupObjects: keys.length,
        manifestKey,
        evidenceCredentialOnBackupBucketDenied: denied,
        lockedVersionDeletable: false,
        overwriteOfLockedManifestCreated: false,
        evidenceObjectsLost: removed,
        restoreResult: {
          evidenceComplete: restored.evidenceComplete,
          evidenceRestored: restored.evidenceRestored,
          postBackupLedger: restored.postBackupLedger,
        },
        bundleObjects: Object.keys(bundleAfter).length,
        bundleHashesIdentical: true,
        artifactsServedAfterRestore: Object.keys(textualAfter).length,
        timingsMs: timings,
      });
    });
  }, 1_500_000);

  it("M5 distributed refuses SQLite and filesystem storage", async () => {
    await record(async () => {
      const { d, session } = live();
      const base = object(JSON.parse(await readFile(d.hostConfigPath, "utf8")));
      const refused: Record<string, { exitCode: number | null; reasonCode: unknown }> = {};
      const attempt = async (label: string, config: Json | null, extra: string[] = []) => {
        const args = ["server", "start", "--mode", "distributed", ...extra];
        if (config) {
          const path = join(d.cwd, `refusal-${label}.json`);
          await writeFile(path, JSON.stringify(config), { mode: 0o600 });
          args.push("--config", path);
        }
        const process = d.spawn(args);
        const exitCode = await process.exited;
        const error = object(JSON.parse(process.stdout()).error);
        refused[label] = { exitCode, reasonCode: object(error.details).reasonCode };
        expect(exitCode, label).not.toBe(0);
        expect(error.code, label).toBe("POLICY_DENIED");
      };
      await attempt("sqlite", {
        ...base,
        database: { engine: "sqlite", url: join(d.cwd, "never-created.db") },
      });
      await attempt("filesystem", {
        ...base,
        storage: { kind: "filesystem", root: join(d.cwd, "never-created-evidence") },
      });
      await attempt("no-config", null);
      expect(refused.sqlite?.reasonCode).toBe("distributed_requires_postgres");
      expect(refused.filesystem?.reasonCode).toBe("distributed_requires_shared_storage");
      expect(refused["no-config"]?.reasonCode).toBe("distributed_requires_postgres");

      // Positive control: the same deployment file with PostgreSQL and S3 is accepted.
      const readiness = d.spawn(["server", "readiness", "--config", d.hostConfigPath]);
      const readinessExit = await readiness.exited;
      expect(readinessExit, readiness.stderr()).toBe(0);
      session.oracles.push({
        check: "distributedRefusesSqliteAndFilesystem",
        healthy: true,
        refusals: refused,
        controlReadinessExit: readinessExit,
      });
    });
  }, 300_000);
});
