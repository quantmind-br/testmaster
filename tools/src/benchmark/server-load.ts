import { execFile, execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import os from "node:os";
import { dirname, resolve } from "node:path";
import { performance } from "node:perf_hooks";
import { setTimeout as sleep } from "node:timers/promises";
import { fileURLToPath, pathToFileURL } from "node:url";
import { promisify } from "node:util";
import type { Application } from "@testmaster/application";
import type { ExecutablePlan } from "@testmaster/contracts";
import {
  type LatencySummary,
  minimumSamples,
  roundMillis as rounded,
  summarizeLatencies,
  uuidV7IdGenerator,
} from "@testmaster/domain";
import { type EntityDocument, OutboxRepository } from "@testmaster/persistence";
import {
  type BenchPrincipal,
  type BenchStack,
  type HttpResult,
  startBenchStack,
  startFixtureTarget,
} from "./server-load-stack.js";

const exec = promisify(execFile);

/* -------------------------------------------------------------------------------------------- */
/* Verdicts (unit-tested)                                                                         */
/* -------------------------------------------------------------------------------------------- */

export type Verdict = "met" | "not met" | "not measured";

/**
 * Samples that must all exceed a limit for "not met" to stand without a supported p95. If the true
 * p95 were at or below the limit, each request would exceed it with probability at most 5%, so five
 * of five exceeding has probability at most 3.2e-7: the fastest observed request already decides.
 */
export const exceedanceSamples = 5;

/**
 * Compares an upper-bound target (latency) with a measurement. Unsupported or missing data is never
 * a pass; `allSamplesExceed` lets a thin series still prove "not met".
 */
export function judgeUpperBound(
  measured: number | null,
  limit: number,
  supported: boolean,
  errors = 0,
  allSamplesExceed = false,
): Verdict {
  if (allSamplesExceed) return "not met";
  if (measured === null || !supported) return "not measured";
  return measured <= limit && errors === 0 ? "met" : "not met";
}

export interface Sample {
  readonly label: string;
  readonly ms: number;
  readonly ok: boolean;
  /** HTTP status, or `error` when the request never produced one. */
  readonly status: number | "error";
}

export interface LoopOptions {
  readonly concurrency: number;
  /** Iterations to start; the loop stops early when `maxMs` elapses. */
  readonly iterations: number;
  readonly maxMs: number;
}

export interface LoopResult {
  readonly samples: Sample[];
  readonly iterations: number;
  readonly wallMs: number;
  readonly truncated: boolean;
}

/**
 * Closed-loop load: `concurrency` workers each start the next iteration as soon as the previous one
 * finishes (no think time), until `iterations` were started or `maxMs` passed.
 */
export async function closedLoop(
  options: LoopOptions,
  work: (iteration: number) => Promise<Sample[]>,
  now: () => number = () => performance.now(),
): Promise<LoopResult> {
  const started = now();
  const samples: Sample[] = [];
  let next = 0;
  let truncated = false;
  const worker = async (): Promise<void> => {
    for (;;) {
      if (next >= options.iterations) return;
      if (now() - started >= options.maxMs) {
        truncated = true;
        return;
      }
      const iteration = next++;
      samples.push(...(await work(iteration)));
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, options.concurrency) }, worker));
  return { samples, iterations: next, wallMs: now() - started, truncated };
}

export interface OperationResult {
  readonly operation: string;
  readonly concurrency: number;
  /** Iterations requested for this level, and how many were started before the time limit. */
  readonly requestedIterations: number;
  readonly startedIterations: number;
  readonly truncatedByTime: boolean;
  readonly latency: LatencySummary;
  readonly errors: number;
  readonly statusCounts: Record<string, number>;
  readonly wallSeconds: number;
  readonly throughputPerSecond: number;
  readonly p95Supported: boolean;
  readonly p99Supported: boolean;
}

/** Aggregates one operation's samples; errors are counted separately and kept out of the latency percentiles. */
export function summarizeOperation(
  operation: string,
  concurrency: number,
  requestedIterations: number,
  loop: LoopResult,
): OperationResult {
  const mine = loop.samples.filter((sample) => sample.label === operation);
  const succeeded = mine.filter((sample) => sample.ok);
  const statusCounts: Record<string, number> = {};
  for (const sample of mine)
    statusCounts[String(sample.status)] = (statusCounts[String(sample.status)] ?? 0) + 1;
  const wallSeconds = loop.wallMs / 1000;
  return {
    operation,
    concurrency,
    requestedIterations,
    startedIterations: loop.iterations,
    truncatedByTime: loop.truncated,
    latency: summarizeLatencies(succeeded.map((sample) => sample.ms)),
    errors: mine.length - succeeded.length,
    statusCounts,
    wallSeconds: rounded(wallSeconds) ?? 0,
    throughputPerSecond: wallSeconds > 0 ? (rounded(succeeded.length / wallSeconds) ?? 0) : 0,
    p95Supported: succeeded.length >= minimumSamples(95),
    p99Supported: succeeded.length >= minimumSamples(99),
  };
}

export interface Nfr006Target {
  readonly id: string;
  /** What the requirement or SLO row asks for, in the words of the specification. */
  readonly item: string;
  readonly source: string;
  readonly proposedTarget: {
    readonly metric: string;
    readonly limit: number;
    readonly unit: "ms" | "s";
    readonly condition: string;
  };
  /** Operations whose p95 must stay within the limit; the worst reference concurrency decides. */
  readonly operations: readonly string[];
  /** Minimum number of Runs the dataset must hold for the target to apply. */
  readonly minimumDatasetRuns?: number;
  /** Why the benchmark cannot measure it, when no operation maps to it. */
  readonly notMeasurable?: string;
}

export interface NfrRow {
  readonly id: string;
  readonly item: string;
  readonly source: string;
  readonly proposedTarget: Nfr006Target["proposedTarget"];
  readonly measured: {
    readonly metric: string;
    readonly valueMs: number;
    readonly operation: string;
    readonly concurrency: number;
    readonly samples: number;
    readonly byConcurrency: {
      readonly concurrency: number;
      readonly p95Ms: number | null;
      readonly samples: number;
      readonly errors: number;
      readonly operation: string;
    }[];
  } | null;
  readonly verdict: Verdict;
  readonly reason: string;
}

/**
 * Computes the verdict of each NFR-006 target from the measured operations. The worst p95 across
 * the reference concurrency series decides; a level without enough samples makes the target "not
 * measured" unless another level already exceeds it ("not met" is never hidden by missing data).
 */
export function evaluateTargets(
  targets: readonly Nfr006Target[],
  results: readonly OperationResult[],
  referenceSeries: readonly number[],
  datasetRuns: number,
): NfrRow[] {
  return targets.map((target) => {
    const limitMs =
      target.proposedTarget.unit === "s"
        ? target.proposedTarget.limit * 1000
        : target.proposedTarget.limit;
    const base = {
      id: target.id,
      item: target.item,
      source: target.source,
      proposedTarget: target.proposedTarget,
    };
    if (target.notMeasurable)
      return {
        ...base,
        measured: null,
        verdict: "not measured" as const,
        reason: target.notMeasurable,
      };
    if (target.minimumDatasetRuns !== undefined && datasetRuns < target.minimumDatasetRuns)
      return {
        ...base,
        measured: null,
        verdict: "not measured" as const,
        reason: `The target applies to a dataset of ${target.minimumDatasetRuns} Runs; this run seeded ${datasetRuns}.`,
      };
    const levels = target.operations.flatMap((operation) =>
      referenceSeries.map((concurrency) => ({
        operation,
        concurrency,
        result: results.find(
          (entry) => entry.operation === operation && entry.concurrency === concurrency,
        ),
      })),
    );
    const byConcurrency = levels.map((level) => ({
      concurrency: level.concurrency,
      operation: level.operation,
      p95Ms: level.result?.latency.p95Ms ?? null,
      samples: level.result?.latency.count ?? 0,
      errors: level.result?.errors ?? 0,
    }));
    const verdicts = levels.map((level) =>
      judgeUpperBound(
        level.result?.latency.p95Ms ?? null,
        limitMs,
        level.result?.p95Supported ?? false,
        level.result?.errors ?? 0,
        // Every attempt either failed or took longer than the limit.
        (level.result?.latency.count ?? 0) + (level.result?.errors ?? 0) >= exceedanceSamples &&
          (level.result?.latency.minMs ?? Number.POSITIVE_INFINITY) > limitMs,
      ),
    );
    const measuredLevels = levels.filter((level) => level.result?.latency.p95Ms != null);
    const worst = measuredLevels.reduce<(typeof measuredLevels)[number] | null>(
      (best, level) =>
        best === null || (level.result?.latency.p95Ms ?? 0) > (best.result?.latency.p95Ms ?? 0)
          ? level
          : best,
      null,
    );
    const measured = worst?.result
      ? {
          metric: "p95",
          valueMs: worst.result.latency.p95Ms ?? 0,
          operation: worst.operation,
          concurrency: worst.concurrency,
          samples: worst.result.latency.count,
          byConcurrency,
        }
      : null;
    const verdict: Verdict = verdicts.includes("not met")
      ? "not met"
      : verdicts.every((entry) => entry === "met")
        ? "met"
        : "not measured";
    const reason =
      verdict === "met"
        ? `p95 within ${limitMs} ms with zero errors at every reference concurrency (${referenceSeries.join("/")}).`
        : verdict === "not met"
          ? `p95 exceeds ${limitMs} ms or errors occurred at a reference concurrency (worst: ${worst?.result?.latency.p95Ms} ms at concurrency ${worst?.concurrency}).`
          : `At least one reference concurrency has too few successful samples for a p95 measurement (the tool requires ${minimumSamples(95)}) and its fastest request did not already exceed ${limitMs} ms.`;
    return { ...base, measured, verdict, reason };
  });
}

/* -------------------------------------------------------------------------------------------- */
/* NFR-006 targets                                                                                */
/* -------------------------------------------------------------------------------------------- */

/**
 * Numeric targets that NFR-006 ("metas propostas medidas em hardware de referência") points to:
 * specs/10-validation.md section 9 (platform benchmark, UI responsiveness) and the proposed SLOs
 * of specs/08-operations.md section 9.2. All are proposals, none is a promise.
 */
export const nfr006Targets: readonly Nfr006Target[] = [
  {
    id: "NFR-006/admission-latency",
    item: "Admission latency",
    source:
      "specs/08-operations.md 9.2 (Admission latency, p95 < 2 s, no job executed in the request)",
    proposedTarget: {
      metric: "p95",
      limit: 2,
      unit: "s",
      condition: "up to configured capacity; authentication and database time count",
    },
    operations: ["admit_run"],
  },
  {
    id: "NFR-006/detail-open",
    item: "Run detail open (API request analogue of the UI target)",
    source: "specs/10-validation.md 9 (UI: p95 of detail open <= 2 s with 10,000 Runs)",
    proposedTarget: {
      metric: "p95",
      limit: 2,
      unit: "s",
      condition:
        "dataset of 10,000 Runs; the specification measures to useful render, the benchmark measures the API request only",
    },
    operations: ["run_detail"],
    minimumDatasetRuns: 10000,
  },
  {
    id: "NFR-006/search",
    item: "Run search and listing (API request analogue of the UI target)",
    source: "specs/10-validation.md 9 (UI: p95 of search <= 2 s with 10,000 Runs)",
    proposedTarget: {
      metric: "p95",
      limit: 2,
      unit: "s",
      condition:
        "dataset of 10,000 Runs; the worst of first page, cursor page and filtered search decides",
    },
    operations: ["list_runs_first_page", "list_runs_cursor_page", "search_runs"],
    minimumDatasetRuns: 10000,
  },
  {
    id: "NFR-006/orchestration-overhead",
    item: "Orchestration overhead per local warm dispatch",
    source:
      "specs/10-validation.md 9 (p95 <= 2 s, excluding imposed queue time, container preparation and application execution)",
    proposedTarget: { metric: "p95", limit: 2, unit: "s", condition: "local warm dispatch" },
    operations: [],
    notMeasurable:
      "Needs executed Runs with instrumented queue, preparation and execution boundaries at load; this benchmark executes only a handful of Runs to obtain artifacts, far below a measurable sample.",
  },
  {
    id: "NFR-006/queue-start-lag",
    item: "Queue start lag",
    source: "specs/08-operations.md 9.2 (Queue start lag, p95 < 60 s with slots available)",
    proposedTarget: {
      metric: "p95",
      limit: 60,
      unit: "s",
      condition: "slots available and target admitted",
    },
    operations: [],
    notMeasurable:
      "Needs a worker pool executing the admitted Runs; the benchmark leaves its admitted Runs queued so it measures the control plane only.",
  },
  {
    id: "NFR-006/artifact-publication",
    item: "Artifact publication",
    source: "specs/08-operations.md 9.2 (Artifact publication, p95 < 30 s up to 64 MiB)",
    proposedTarget: {
      metric: "p95",
      limit: 30,
      unit: "s",
      condition: "artifacts up to 64 MiB, healthy storage",
    },
    operations: [],
    notMeasurable:
      "The benchmark reads published artifacts; publication happens inside Run execution and is not exercised at load.",
  },
];

/* -------------------------------------------------------------------------------------------- */
/* Environment facts and process metering                                                          */
/* -------------------------------------------------------------------------------------------- */

const clockTicks = (() => {
  try {
    return Number(execFileSync("getconf", ["CLK_TCK"], { encoding: "utf8" }).trim()) || 100;
  } catch {
    return 100;
  }
})();

function processUsage(pid: number): { cpuSeconds: number; rssBytes: number } | null {
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
    // Fields after the command name (which may contain spaces) start at index 3 of the spec.
    const fields = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
    const cpuTicks = Number(fields[11]) + Number(fields[12]);
    const pages = Number(readFileSync(`/proc/${pid}/statm`, "utf8").split(" ")[1]);
    return { cpuSeconds: cpuTicks / clockTicks, rssBytes: pages * 4096 };
  } catch {
    return null;
  }
}

async function containerCpuSeconds(container: string): Promise<number | null> {
  try {
    const { stdout } = await exec("docker", ["exec", container, "cat", "/sys/fs/cgroup/cpu.stat"]);
    const match = /usage_usec (\d+)/u.exec(stdout);
    return match ? Number(match[1]) / 1e6 : null;
  } catch {
    return null;
  }
}

export interface ResourceUse {
  readonly serverCpuCores: number | null;
  readonly serverPeakRssMiB: number | null;
  readonly postgresCpuCores: number | null;
  readonly benchmarkClientCpuCores: number;
}

/** Meters the server process, the PostgreSQL container and this client over one measured phase. */
async function meter<T>(
  stack: BenchStack,
  work: () => Promise<T>,
): Promise<{ value: T; use: ResourceUse }> {
  const wall = performance.now();
  const serverStart = processUsage(stack.serverPid);
  const postgresStart = await containerCpuSeconds(stack.postgres.container);
  const clientStart = process.cpuUsage();
  let peak = serverStart?.rssBytes ?? 0;
  const timer = setInterval(() => {
    peak = Math.max(peak, processUsage(stack.serverPid)?.rssBytes ?? 0);
  }, 250);
  try {
    const value = await work();
    const seconds = (performance.now() - wall) / 1000;
    const serverEnd = processUsage(stack.serverPid);
    const postgresEnd = await containerCpuSeconds(stack.postgres.container);
    const client = process.cpuUsage(clientStart);
    return {
      value,
      use: {
        serverCpuCores:
          serverStart && serverEnd
            ? rounded((serverEnd.cpuSeconds - serverStart.cpuSeconds) / seconds)
            : null,
        serverPeakRssMiB: peak ? rounded(peak / 1048576) : null,
        postgresCpuCores:
          postgresStart !== null && postgresEnd !== null
            ? rounded((postgresEnd - postgresStart) / seconds)
            : null,
        benchmarkClientCpuCores: rounded((client.user + client.system) / 1e6 / seconds) ?? 0,
      },
    };
  } finally {
    clearInterval(timer);
  }
}

async function dockerFacts(): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  for (const [key, args] of [
    ["serverVersion", ["version", "--format", "{{.Server.Version}}"]],
    ["clientVersion", ["version", "--format", "{{.Client.Version}}"]],
    ["storageDriver", ["info", "--format", "{{.Driver}}"]],
    ["cgroupVersion", ["info", "--format", "{{.CgroupVersion}}"]],
  ] as const)
    out[key] = await exec("docker", [...args]).then(
      (result) => result.stdout.trim(),
      () => "unavailable",
    );
  return out;
}

async function hardwareFacts(
  workDirectory: string,
  nodeCommit: { commit: string; dirty: boolean },
) {
  const cpus = os.cpus();
  const filesystem = await exec("stat", ["-f", "-c", "%T", workDirectory]).then(
    (result) => result.stdout.trim(),
    () => "unknown",
  );
  const dockerRoot = await exec("docker", ["info", "--format", "{{.DockerRootDir}}"]).then(
    (result) => result.stdout.trim(),
    () => "",
  );
  const dockerFilesystem = dockerRoot
    ? await exec("stat", ["-f", "-c", "%T", dockerRoot]).then(
        (result) => result.stdout.trim(),
        () => "unknown",
      )
    : "unknown";
  return {
    cpuModel: cpus[0]?.model ?? "unknown",
    logicalCores: cpus.length,
    memoryTotalGiB: rounded(os.totalmem() / 1024 ** 3),
    memoryFreeGiBAtStart: rounded(os.freemem() / 1024 ** 3),
    kernel: os.release(),
    platform: `${os.platform()} ${os.arch()}`,
    node: process.version,
    docker: await dockerFacts(),
    evidenceAndStateFilesystem: filesystem,
    postgresDataFilesystem: dockerFilesystem,
    sourceCommit: nodeCommit.commit,
    sourceTreeDirty: nodeCommit.dirty,
  };
}

function sourceCommit(): { commit: string; dirty: boolean } {
  const root = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
  try {
    const commit = execFileSync("git", ["rev-parse", "HEAD"], {
      cwd: root,
      encoding: "utf8",
    }).trim();
    const status = execFileSync("git", ["status", "--porcelain", "--untracked-files=no"], {
      cwd: root,
      encoding: "utf8",
    }).trim();
    return { commit, dirty: status.length > 0 };
  } catch {
    return { commit: "unknown", dirty: false };
  }
}

/* -------------------------------------------------------------------------------------------- */
/* Seeding                                                                                        */
/* -------------------------------------------------------------------------------------------- */

export interface BenchOptions {
  readonly out: string;
  readonly projects: number;
  readonly testsPerProject: number;
  readonly runs: number;
  readonly concurrency: readonly number[];
  readonly referenceSeries: readonly number[];
  readonly iterations: number;
  readonly admissions: number;
  readonly maxSecondsPerLevel: number;
  readonly sseStreams: readonly number[];
  readonly sseEvents: number;
  readonly workDirectory: string;
}

const defaultOptions: Omit<BenchOptions, "out"> = {
  projects: 20,
  testsPerProject: 50,
  runs: 10000,
  concurrency: [1, 4, 8, 32],
  referenceSeries: [1, 4, 8],
  iterations: 200,
  admissions: 120,
  maxSecondsPerLevel: 90,
  sseStreams: [1, 4, 8, 32],
  sseEvents: 20,
  workDirectory: "/var/tmp",
};

interface Seeded {
  readonly projects: { id: string; environmentId: string; testIds: string[] }[];
  readonly testIds: string[];
  readonly runIds: string[];
  readonly runsByOutcome: Record<string, number>;
  readonly seedSeconds: number;
  readonly runsInDatabase: number;
}

const planFor = (name: string): ExecutablePlan => ({
  schemaVersion: "1.0.0" as const,
  kind: "executable" as const,
  name,
  type: "backend" as const,
  runner: "http" as const,
  requirementRefs: [],
  steps: [
    {
      id: "health_request",
      description: "health_request",
      kind: "action",
      operation: "request",
      input: { method: "GET", pathSegments: [{ literal: "health" }] },
    },
    {
      id: "health_status",
      description: "health_status",
      kind: "assertion",
      operation: "assert",
      input: { responseStepId: "health_request" },
      expectation: { predicate: "statusIn", values: [200] },
    },
    {
      id: "health_value",
      description: "health_value",
      kind: "assertion",
      operation: "assert",
      input: { responseStepId: "health_request", jsonPointer: "/status" },
      expectation: { predicate: "jsonEquals", value: { literal: "ok" } },
    },
  ],
});

/**
 * Seeds the dataset through the application services of the controller scope: projects,
 * environments and tests are created exactly as the API creates them, and each seeded terminal Run
 * is the document `RunsService.prepare` builds for its test (admission snapshot included),
 * completed with a recorded outcome. Seeded Runs have no attempts, steps or artifacts.
 */
async function seedDataset(
  stack: BenchStack,
  options: BenchOptions,
  targetUrl: string,
): Promise<Seeded> {
  const started = performance.now();
  const scope: Application = await stack.scope();
  const app = scope.forWorkspaceSystem(stack.workspaceId);
  const projects: Seeded["projects"] = [];
  const testIds: string[] = [];
  const templates = new Map<string, EntityDocument>();
  for (let p = 0; p < options.projects; p++) {
    const project = app.projects.create({ name: `Capacity project ${p + 1}` });
    const environment = app.environments.create({
      projectId: project.id,
      name: "bench",
      baseUrl: targetUrl,
      networkProfile: "local-loopback",
      locale: "en-US",
      timezone: "UTC",
    });
    const entry = { id: project.id, environmentId: environment.id, testIds: [] as string[] };
    for (let t = 0; t < options.testsPerProject; t++) {
      const test = app.tests.create({
        projectId: project.id,
        plan: planFor(`Capacity health ${p + 1}-${t + 1}`),
      });
      entry.testIds.push(test.id);
      testIds.push(test.id);
      templates.set(
        test.id,
        app.runs.prepare({
          testId: test.id,
          environmentId: environment.id,
          mode: "replay",
          healingPolicy: "off",
          origin: "api",
        }),
      );
    }
    projects.push(entry);
  }

  const total = options.runs;
  const spanMs = 14 * 24 * 3_600_000;
  const origin = Date.now() - spanMs;
  const runIds: string[] = [];
  const runsByOutcome: Record<string, number> = {};
  const outcomes = [
    "passed",
    "passed",
    "passed",
    "passed",
    "passed",
    "passed",
    "passed",
    "passed",
    "failed",
    "failed",
    "cancelled",
    "inconclusive",
  ] as const;
  const batch = 250;
  for (let from = 0; from < total; from += batch) {
    app.context.database.withTx(() => {
      for (let i = from; i < Math.min(total, from + batch); i++) {
        const testId = testIds[i % testIds.length] as string;
        const template = templates.get(testId) as EntityDocument;
        const outcome = outcomes[i % outcomes.length] as (typeof outcomes)[number];
        const createdAt = new Date(origin + Math.floor((i / total) * spanMs)).toISOString();
        const document = {
          ...structuredClone(template),
          id: uuidV7IdGenerator.next("run"),
          createdAt,
          phase: "completed",
          status: outcome,
          outcome,
          gate: outcome === "passed" ? "passed" : "failed",
          cleanupOutcome: "not_required",
          analysisStatus: "not_requested",
        } as EntityDocument;
        app.context.entities.insert("Run", document);
        runIds.push(document.id);
        runsByOutcome[outcome] = (runsByOutcome[outcome] ?? 0) + 1;
      }
    });
  }
  const counted = app.context.database.get(
    "SELECT COUNT(*) AS n FROM runs WHERE workspace_id=?",
    stack.workspaceId,
  );
  return {
    projects,
    testIds,
    runIds,
    runsByOutcome,
    seedSeconds: rounded((performance.now() - started) / 1000) ?? 0,
    runsInDatabase: Number(counted?.n ?? 0),
  };
}

/* -------------------------------------------------------------------------------------------- */
/* Measured phases                                                                                */
/* -------------------------------------------------------------------------------------------- */

const pick = <T>(items: readonly T[], index: number): T => items[index % items.length] as T;
const randomItem = <T>(items: readonly T[]): T =>
  items[Math.floor(Math.random() * items.length)] as T;

function parseJson(result: HttpResult): Record<string, unknown> {
  const parsed: unknown = JSON.parse(result.body.toString());
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed))
    throw new Error("Response is not an object");
  return parsed as Record<string, unknown>;
}

function dataOf(result: HttpResult): Record<string, unknown> {
  const data = parseJson(result).data;
  if (!data || typeof data !== "object" || Array.isArray(data))
    throw new Error("Response has no data object");
  return data as Record<string, unknown>;
}

const expectOk = (result: HttpResult, accepted: readonly number[], what: string): HttpResult => {
  if (!accepted.includes(result.status))
    throw new Error(`${what} returned ${result.status}: ${result.body.toString().slice(0, 300)}`);
  return result;
};

function timed(label: string, result: HttpResult, accepted: readonly number[]): Sample {
  return { label, ms: result.ms, ok: accepted.includes(result.status), status: result.status };
}

async function guarded(
  label: string,
  accepted: readonly number[],
  call: () => Promise<HttpResult>,
): Promise<Sample[]> {
  const started = performance.now();
  try {
    return [timed(label, await call(), accepted)];
  } catch {
    return [{ label, ms: performance.now() - started, ok: false, status: "error" }];
  }
}

export interface PhaseOutcome {
  readonly result: OperationResult;
  readonly resources: ResourceUse;
}

interface Operation {
  readonly name: string;
  readonly route: string;
  readonly description: string;
  /** Prepares per-level state (for example cursors) before the measured loop. */
  prepare?(concurrency: number): Promise<void>;
  /** Number of iterations for a level. */
  iterations(options: BenchOptions): number;
  work(iteration: number, concurrency: number): Promise<Sample[]>;
}

/** Cursors of a paged route, fetched once per level so cursor pages are measured one request at a time. */
async function cursorPool(
  stack: BenchStack,
  path: string,
  query: string,
  pages: number,
): Promise<string[]> {
  const cursors: string[] = [];
  let cursor: string | null = null;
  for (let page = 0; page < pages; page++) {
    const separator = path.includes("?") ? "&" : "?";
    const response: HttpResult = expectOk(
      await stack.client.call(
        "GET",
        `${path}${separator}${query}${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`,
        { token: stack.owner.token },
      ),
      [200],
      "cursor walk",
    );
    const next: unknown = dataOf(response).nextCursor;
    if (typeof next !== "string") break;
    cursors.push(next);
    cursor = next;
  }
  if (!cursors.length)
    throw new Error(`No cursor from ${path}; dataset too small for cursor paging`);
  return cursors;
}

export interface BenchResult {
  readonly operations: (OperationResult & {
    readonly route: string;
    readonly resources: ResourceUse;
  })[];
}

/**
 * The server's default per-tenant mutation budget (apps/server `defaultTenantBudget`: burst 200,
 * 20 per second). Admission levels run after the budget has refilled so the limiter is not the
 * subject of the latency measurement; the backpressure phase measures the limiter itself.
 */
const tenantWritesPerSecond = 20;

function buildOperations(
  stack: BenchStack,
  seeded: Seeded,
  artifacts: ArtifactSet,
  admissionPrincipals: () => Promise<BenchPrincipal[]>,
  environment: { projectId: string; testId: string; environmentId: string },
): Operation[] {
  const owner = stack.owner.token;
  const client = stack.client;
  let runCursors: string[] = [];
  let testCursors: { projectId: string; cursor: string }[] = [];
  let principals: BenchPrincipal[] = [];
  const perPrincipal = 15;
  let admissionCounter = 0;
  const testPageSize = Math.max(
    1,
    Math.min(10, Math.floor((seeded.projects[0]?.testIds.length ?? 2) / 2)),
  );
  const operations: Operation[] = [
    {
      name: "health_live",
      route: "GET /v1/health/live",
      description:
        "Control: unauthenticated route that never touches the database; isolates HTTP and Fastify cost.",
      iterations: (o) => o.iterations,
      work: () =>
        guarded("health_live", [200], () => client.call("GET", "/v1/health/live", { token: null })),
    },
    {
      name: "project_detail",
      route: "GET /v1/projects/{id}",
      description:
        "Control: authenticated single-entity read (authentication, audit write and one lookup).",
      iterations: (o) => o.iterations,
      work: (i) =>
        guarded("project_detail", [200], () =>
          client.call("GET", `/v1/projects/${pick(seeded.projects, i).id}`, { token: owner }),
        ),
    },
    {
      name: "run_detail",
      route: "GET /v1/runs/{id}",
      description: "Open one seeded Run (analogue of opening a Run detail page).",
      iterations: (o) => o.iterations,
      work: () =>
        guarded("run_detail", [200], () =>
          client.call("GET", `/v1/runs/${randomItem(seeded.runIds)}`, { token: owner }),
        ),
    },
    {
      name: "list_runs_first_page",
      route: "GET /v1/runs?limit=50",
      description:
        "First page of the workspace Run list (the server builds the full list, then pages).",
      iterations: (o) => o.iterations,
      work: () =>
        guarded("list_runs_first_page", [200], () =>
          client.call("GET", "/v1/runs?limit=50", { token: owner }),
        ),
    },
    {
      name: "list_runs_cursor_page",
      route: "GET /v1/runs?limit=50&cursor=...",
      description: "Pages 2-4 of the Run list through signed cursors.",
      prepare: async () => {
        runCursors = await cursorPool(stack, "/v1/runs", "limit=50", 3);
      },
      iterations: (o) => o.iterations,
      work: () =>
        guarded("list_runs_cursor_page", [200], () =>
          client.call(
            "GET",
            `/v1/runs?limit=50&cursor=${encodeURIComponent(randomItem(runCursors))}`,
            { token: owner },
          ),
        ),
    },
    {
      name: "search_runs",
      route: "GET /v1/runs?testId=...&limit=50",
      description: "Run search by test (filter evaluated server-side over the full list).",
      iterations: (o) => o.iterations,
      work: () =>
        guarded("search_runs", [200], () =>
          client.call("GET", `/v1/runs?testId=${randomItem(seeded.testIds)}&limit=50`, {
            token: owner,
          }),
        ),
    },
    {
      name: "list_tests_first_page",
      route: `GET /v1/projects/{id}/tests?limit=${testPageSize}`,
      description: "First page of one project's tests.",
      iterations: (o) => o.iterations,
      work: (i) =>
        guarded("list_tests_first_page", [200], () =>
          client.call(
            "GET",
            `/v1/projects/${pick(seeded.projects, i).id}/tests?limit=${testPageSize}`,
            {
              token: owner,
            },
          ),
        ),
    },
    {
      name: "list_tests_cursor_page",
      route: `GET /v1/projects/{id}/tests?limit=${testPageSize}&cursor=...`,
      description: "Page 2 of one project's tests through a signed cursor.",
      prepare: async () => {
        testCursors = [];
        for (const project of seeded.projects.slice(0, 8)) {
          const first = expectOk(
            await client.call("GET", `/v1/projects/${project.id}/tests?limit=${testPageSize}`, {
              token: owner,
            }),
            [200],
            "tests page",
          );
          const next = dataOf(first).nextCursor;
          if (typeof next === "string") testCursors.push({ projectId: project.id, cursor: next });
        }
        if (!testCursors.length)
          throw new Error("No test cursor; projects too small for cursor paging");
      },
      iterations: (o) => o.iterations,
      work: () => {
        const entry = randomItem(testCursors);
        return guarded("list_tests_cursor_page", [200], () =>
          client.call(
            "GET",
            `/v1/projects/${entry.projectId}/tests?limit=${testPageSize}&cursor=${encodeURIComponent(entry.cursor)}`,
            { token: owner },
          ),
        );
      },
    },
  ];
  if (artifacts.artifacts.length) {
    operations.push(
      {
        name: "artifact_read",
        route: "GET /v1/artifacts/{id}",
        description: `Full read of a published artifact (${artifacts.artifacts.map((entry) => entry.sizeBytes).join("/")} bytes) through the evidence gateway.`,
        iterations: (o) => o.iterations,
        work: () =>
          guarded("artifact_read", [200], () =>
            client.call("GET", `/v1/artifacts/${randomItem(artifacts.artifacts).artifactId}`, {
              token: owner,
            }),
          ),
      },
      {
        name: "artifact_range_read",
        route: "GET /v1/artifacts/{id} (Range)",
        description: "Single explicit byte range of a published artifact.",
        iterations: (o) => o.iterations,
        work: () => {
          const entry = randomItem(artifacts.artifacts);
          const end = Math.max(0, Math.min(entry.sizeBytes, 1024) - 1);
          return guarded("artifact_range_read", [206], () =>
            client.call("GET", `/v1/artifacts/${entry.artifactId}`, {
              token: owner,
              headers: { range: `bytes=0-${end}` },
            }),
          );
        },
      },
    );
  }
  operations.push({
    name: "admit_run",
    route: "POST /v1/runs",
    description: `Admit a Run (replay, queued, no worker): authentication, authorization, admission snapshot, queue insert, outbox. Each principal admits at most ${perPrincipal} Runs so the per-principal write rate limit (20 burst, 1/s) is never the subject, and the per-tenant budget (200 burst, 20/s) refills before every level.`,
    prepare: async (concurrency) => {
      void concurrency;
      principals = await admissionPrincipals();
    },
    iterations: (o) => o.admissions,
    work: () => {
      const principal = pick(principals, Math.floor(admissionCounter++ / perPrincipal));
      return guarded("admit_run", [202], () =>
        client.call("POST", "/v1/runs", {
          token: principal.token,
          idempotent: true,
          body: {
            testId: environment.testId,
            environmentId: environment.environmentId,
            mode: "replay",
            healingPolicy: "off",
            origin: "api",
          },
        }),
      );
    },
  });
  return operations;
}

interface ArtifactSet {
  readonly status: "available" | "unavailable";
  readonly reason: string | null;
  readonly runs: { runId: string; phase: string; outcome: string | null; entries: number }[];
  readonly artifacts: { artifactId: string; sizeBytes: number }[];
}

/**
 * The server refuses admission until a worker is live (a `ready` row with a heartbeat in the last
 * 30 s). Polling admission would spend the caller's write-rate budget, so wait on the database.
 */
async function waitForLiveWorker(stack: BenchStack): Promise<void> {
  const app = (await stack.scope()).forWorkspaceSystem(stack.workspaceId);
  const deadline = Date.now() + 180_000;
  for (;;) {
    const live = app.context.database.get(
      "SELECT 1 AS live FROM workers WHERE workspace_id=? AND state='ready' AND last_heartbeat_at>?",
      stack.workspaceId,
      new Date(Date.now() - 10_000).toISOString(),
    );
    if (live) return;
    if (Date.now() > deadline) throw new Error("The worker did not become live within 180 s");
    await sleep(500);
  }
}

/** Runs a few real Runs through a worker so the artifact reads have genuine published evidence. */
async function obtainArtifacts(
  stack: BenchStack,
  seeded: Seeded,
  count: number,
): Promise<ArtifactSet> {
  const project = seeded.projects[0];
  const testId = project?.testIds[0];
  if (!project || !testId)
    return { status: "unavailable", reason: "No seeded test", runs: [], artifacts: [] };
  const owner = stack.owner.token;
  const runs: ArtifactSet["runs"] = [];
  const artifacts: ArtifactSet["artifacts"] = [];
  try {
    await stack.startWorker();
    await waitForLiveWorker(stack);
    const receipts: string[] = [];
    for (let i = 0; i < count; i++) {
      const admitted = expectOk(
        await stack.client.call("POST", "/v1/runs", {
          token: owner,
          idempotent: true,
          body: {
            testId,
            environmentId: project.environmentId,
            mode: "replay",
            healingPolicy: "off",
            origin: "api",
          },
        }),
        [202],
        "artifact Run admission",
      );
      receipts.push(String(dataOf(admitted).runId));
    }
    const deadline = Date.now() + 240_000;
    for (const runId of receipts) {
      let phase = "queued";
      let outcome: string | null = null;
      while (Date.now() < deadline && phase !== "completed") {
        const detail = dataOf(
          await stack.client.call("GET", `/v1/runs/${runId}`, { token: owner }),
        );
        phase = String(detail.phase);
        outcome = typeof detail.outcome === "string" ? detail.outcome : null;
        if (phase !== "completed") await sleep(500);
      }
      const bundle = await stack.client.call("GET", `/v1/runs/${runId}/bundle`, { token: owner });
      const manifest = bundle.status === 200 ? dataOf(bundle).manifest : undefined;
      const entries: unknown[] =
        manifest &&
        typeof manifest === "object" &&
        "entries" in manifest &&
        Array.isArray(manifest.entries)
          ? manifest.entries
          : [];
      let available = 0;
      for (const entry of entries) {
        if (!entry || typeof entry !== "object") continue;
        const record = entry as Record<string, unknown>;
        if (
          record.state === "available" &&
          typeof record.artifactId === "string" &&
          typeof record.sizeBytes === "number" &&
          record.sizeBytes > 0
        ) {
          artifacts.push({ artifactId: record.artifactId, sizeBytes: record.sizeBytes });
          available++;
        }
      }
      runs.push({ runId, phase, outcome, entries: available });
    }
  } catch (error) {
    console.error(`[bench] artifact setup failed: ${error}\n${stack.logs().slice(-4000)}`);
    return {
      status: "unavailable",
      reason: error instanceof Error ? error.message : String(error),
      runs,
      artifacts: [],
    };
  } finally {
    await stack.stopWorker().catch(() => undefined);
  }
  return artifacts.length
    ? { status: "available", reason: null, runs, artifacts }
    : {
        status: "unavailable",
        reason: "The worker produced no available artifact",
        runs,
        artifacts: [],
      };
}

interface SseResult {
  readonly streams: number;
  readonly opened: number;
  readonly openFailures: number;
  readonly timeToFirstEvent: LatencySummary;
  readonly eventsPublished: number;
  readonly expectedDeliveries: number;
  readonly deliveries: number;
  readonly missedDeliveries: number;
  readonly fanOutLatency: LatencySummary;
  readonly publishIntervalMs: number;
  readonly resources: ResourceUse;
}

const nowMs = () => performance.timeOrigin + performance.now();

async function measureSse(
  stack: BenchStack,
  project: Seeded["projects"][number],
  streams: number,
  events: number,
): Promise<SseResult> {
  const owner = stack.owner.token;
  const testId = project.testIds[1] ?? project.testIds[0] ?? "";
  const admitted = expectOk(
    await stack.client.call("POST", "/v1/runs", {
      token: owner,
      idempotent: true,
      body: {
        testId,
        environmentId: project.environmentId,
        mode: "replay",
        healingPolicy: "off",
        origin: "api",
      },
    }),
    [202],
    "SSE Run admission",
  );
  const runId = String(dataOf(admitted).runId);
  const scope = await stack.scope();
  const app = scope.forWorkspaceSystem(stack.workspaceId);
  const publishIntervalMs = 250;
  const ttfe: number[] = [];
  const fanOut: number[] = [];
  let opened = 0;
  let openFailures = 0;
  const handles: { close(): void; closed: Promise<void> }[] = [];
  const { value: _unused, use } = await meter(stack, async () => {
    const firstEvents = Array.from({ length: streams }, () => Promise.withResolvers<void>());
    for (let index = 0; index < streams; index++) {
      const startedAt = performance.now();
      let buffer = "";
      let sawFirst = false;
      handles.push(
        stack.client.stream(
          `/v1/runs/${runId}/events`,
          owner,
          (text) => {
            const receivedAt = nowMs();
            buffer += text;
            let end = buffer.indexOf("\n\n");
            while (end !== -1) {
              const frame = buffer.slice(0, end);
              buffer = buffer.slice(end + 2);
              if (frame.includes("event:")) {
                if (!sawFirst) {
                  sawFirst = true;
                  ttfe.push(performance.now() - startedAt);
                  firstEvents[index]?.resolve();
                }
                const data = /^data: (.*)$/mu.exec(frame)?.[1];
                if (data?.includes('"run.benchmark_probe"')) {
                  const parsed: unknown = JSON.parse(data);
                  const payload =
                    parsed && typeof parsed === "object" && "payload" in parsed
                      ? parsed.payload
                      : null;
                  if (
                    payload &&
                    typeof payload === "object" &&
                    "sentAtMs" in payload &&
                    typeof payload.sentAtMs === "number"
                  )
                    fanOut.push(receivedAt - payload.sentAtMs);
                }
              }
              end = buffer.indexOf("\n\n");
            }
          },
          (status) => {
            if (status === 200) opened++;
            else {
              openFailures++;
              firstEvents[index]?.resolve();
            }
          },
        ),
      );
    }
    await Promise.race([Promise.all(firstEvents.map((entry) => entry.promise)), sleep(30_000)]);
    for (let n = 0; n < events; n++) {
      const sentAtMs = nowMs();
      app.context.database.withTx(() =>
        new OutboxRepository(app.context.database).append(
          stack.workspaceId,
          runId,
          "run.benchmark_probe",
          { n, sentAtMs },
        ),
      );
      await sleep(publishIntervalMs);
    }
    // Let the last poll (100 ms interval) deliver.
    await sleep(2000);
  });
  for (const handle of handles) handle.close();
  await Promise.all(handles.map((handle) => handle.closed));
  const expectedDeliveries = opened * events;
  return {
    streams,
    opened,
    openFailures,
    timeToFirstEvent: summarizeLatencies(ttfe),
    eventsPublished: events,
    expectedDeliveries,
    deliveries: fanOut.length,
    missedDeliveries: Math.max(0, expectedDeliveries - fanOut.length),
    fanOutLatency: summarizeLatencies(fanOut),
    publishIntervalMs,
    resources: use,
  };
}

/** One principal bursts admissions past its rate limit, then everything else must still answer. */
async function measureBackpressure(
  stack: BenchStack,
  project: Seeded["projects"][number],
  principal: BenchPrincipal,
) {
  const testId = project.testIds[2] ?? project.testIds[0] ?? "";
  const statuses: Record<string, number> = {};
  let retryAfterSeen = 0;
  const loop = await closedLoop({ concurrency: 8, iterations: 80, maxMs: 60_000 }, async () => {
    try {
      const response = await stack.client.call("POST", "/v1/runs", {
        token: principal.token,
        idempotent: true,
        body: {
          testId,
          environmentId: project.environmentId,
          mode: "replay",
          healingPolicy: "off",
          origin: "api",
        },
      });
      statuses[String(response.status)] = (statuses[String(response.status)] ?? 0) + 1;
      if (response.status === 429 && response.headers["retry-after"]) retryAfterSeen++;
      return [
        { label: "burst", ms: response.ms, ok: response.status === 202, status: response.status },
      ];
    } catch {
      statuses.error = (statuses.error ?? 0) + 1;
      return [{ label: "burst", ms: 0, ok: false, status: "error" as const }];
    }
  });
  const live = await stack.client.call("GET", "/v1/health/live", { token: null }).then(
    (r) => r.status,
    () => 0,
  );
  const authenticated = await stack.client
    .call("GET", `/v1/projects/${project.id}`, { token: stack.owner.token })
    .then(
      (r) => r.status,
      () => 0,
    );
  return {
    requests: loop.samples.length,
    statusCounts: statuses,
    retryAfterHeaderOnRateLimited: retryAfterSeen,
    serverErrors: Object.entries(statuses)
      .filter(([status]) => /^5/u.test(status) || status === "error")
      .reduce((sum, [, count]) => sum + count, 0),
    healthLiveAfter: live,
    authenticatedReadAfter: authenticated,
  };
}

/** One burst far beyond any measured level: the server must queue or refuse, not crash. */
async function measureSaturation(stack: BenchStack, seeded: Seeded, burst: number) {
  const statuses: Record<string, number> = {};
  const loop = await closedLoop(
    { concurrency: burst, iterations: burst, maxMs: 120_000 },
    async () => {
      try {
        const response = await stack.client.call("GET", `/v1/runs/${randomItem(seeded.runIds)}`, {
          token: stack.owner.token,
        });
        statuses[String(response.status)] = (statuses[String(response.status)] ?? 0) + 1;
        return [
          { label: "burst", ms: response.ms, ok: response.status === 200, status: response.status },
        ];
      } catch {
        statuses.error = (statuses.error ?? 0) + 1;
        return [{ label: "burst", ms: 0, ok: false, status: "error" as const }];
      }
    },
  );
  const live = await stack.client.call("GET", "/v1/health/live", { token: null }).then(
    (r) => r.status,
    () => 0,
  );
  return {
    concurrentRequests: burst,
    statusCounts: statuses,
    latency: summarizeLatencies(loop.samples.filter((s) => s.ok).map((s) => s.ms)),
    wallSeconds: rounded(loop.wallMs / 1000),
    healthLiveAfter: live,
  };
}

/* -------------------------------------------------------------------------------------------- */
/* Orchestration                                                                                  */
/* -------------------------------------------------------------------------------------------- */

/** A median above this at concurrency 1 marks an operation as saturated before any concurrency is added. */
const saturationMs = 2000;

/**
 * Waits until the server answers a liveness probe quickly again. Its request handlers are
 * synchronous, so work from abandoned (timed-out) requests keeps the single thread busy after the
 * clients are gone; the next series must not start behind that backlog. Returns the wait in seconds.
 */
async function settle(stack: BenchStack): Promise<number> {
  const started = performance.now();
  let quick = 0;
  while (quick < 3 && performance.now() - started < 600_000) {
    const probe = await stack.client.call("GET", "/v1/health/live", { token: null }).then(
      (result) => result.ms,
      () => Number.POSITIVE_INFINITY,
    );
    quick = probe < 100 ? quick + 1 : 0;
    if (quick < 3) await sleep(250);
  }
  return rounded((performance.now() - started) / 1000) ?? 0;
}

/**
 * The server refuses admission without a live worker (a `ready` worker row with a heartbeat in the
 * last 30 s). After the artifact Runs the real worker is stopped so that the admitted Runs stay
 * queued; this keeps that worker's row `ready` with a fresh heartbeat, standing in for a worker
 * whose slots are all busy. Returns the function that stops the heartbeat.
 */
async function keepWorkerPresent(stack: BenchStack): Promise<() => void> {
  const app = (await stack.scope()).forWorkspaceSystem(stack.workspaceId);
  const registered = Number(
    app.context.database.get(
      "SELECT COUNT(*) AS n FROM workers WHERE workspace_id=?",
      stack.workspaceId,
    )?.n ?? 0,
  );
  if (registered === 0)
    throw new Error("No worker registered: the server refuses admission without a live worker");
  const beat = () =>
    app.context.database.withTx(() =>
      app.context.database.run(
        "UPDATE workers SET state='ready', last_heartbeat_at=? WHERE workspace_id=?",
        new Date().toISOString(),
        stack.workspaceId,
      ),
    );
  beat();
  const timer = setInterval(beat, 5000);
  return () => clearInterval(timer);
}
export async function runBenchmark(options: BenchOptions): Promise<Record<string, unknown>> {
  const startedAt = new Date();
  const commit = sourceCommit();
  const root = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
  const fixture = await startFixtureTarget();
  const loadStart = os.loadavg();
  let stopPresence: () => void = () => undefined;
  const stack = await startBenchStack({
    workDirectory: options.workDirectory,
    cli: resolve(root, "apps/cli/dist/main.js"),
  });
  try {
    const hardware = await hardwareFacts(stack.workDirectory, commit);
    console.error(`[bench] stack up (server pid ${stack.serverPid}); seeding ${options.runs} Runs`);
    const seeded = await seedDataset(stack, options, fixture.url);
    console.error(`[bench] seeded ${seeded.runsInDatabase} Runs in ${seeded.seedSeconds}s`);
    stack.client.resetConnections();
    const artifacts = await obtainArtifacts(stack, seeded, 3);
    console.error(
      `[bench] artifacts: ${artifacts.status} (${artifacts.artifacts.length}) ${artifacts.reason ?? ""}`,
    );
    stopPresence = await keepWorkerPresent(stack);
    const fixtureAfterArtifacts = fixture.requests();

    const principalPool: BenchPrincipal[] = [];
    const environment = {
      projectId: seeded.projects[0]?.id ?? "",
      testId: seeded.projects[0]?.testIds[0] ?? "",
      environmentId: seeded.projects[0]?.environmentId ?? "",
    };
    const needed = Math.ceil((options.admissions * options.concurrency.length) / 15) + 1;
    const admissionPrincipals = async () => {
      while (principalPool.length < needed) principalPool.push(await stack.addRunner());
      return principalPool.slice(0, needed - 1);
    };
    const operations = buildOperations(stack, seeded, artifacts, admissionPrincipals, environment);

    const results: (OperationResult & {
      route: string;
      description: string;
      resources: ResourceUse;
      coldFirstRequestMs: number | null;
      settleSeconds: number;
    })[] = [];
    const skippedLevels: { operation: string; concurrency: number; reason: string }[] = [];
    const referenceLevels = options.referenceSeries.filter((level) =>
      options.concurrency.includes(level),
    );
    for (const operation of operations) {
      let preparedAt = Number.NEGATIVE_INFINITY;
      // Signed cursors expire after five minutes; refresh them well before that.
      const ensurePrepared = async (concurrency: number) => {
        if (performance.now() - preparedAt < 100_000) return;
        await operation.prepare?.(concurrency);
        preparedAt = performance.now();
      };
      // Warm-up: the first request is the cold sample and is reported separately; up to four more
      // warm the paths, but never more than 20 s of warm-up for an operation that is already slow.
      const warmups: Sample[] = [];
      if (operation.name !== "admit_run") {
        await ensurePrepared(1);
        const warmStart = performance.now();
        for (let i = 0; i < 5 && performance.now() - warmStart < 20_000; i++)
          warmups.push(...(await operation.work(i, 1)));
      }
      const cold = warmups[0]?.ms ?? null;
      let saturatedAtOne = false;
      for (const concurrency of options.concurrency) {
        if (saturatedAtOne && !referenceLevels.includes(concurrency)) {
          skippedLevels.push({
            operation: operation.name,
            concurrency,
            reason: `Stress level skipped: at concurrency 1 the median already exceeds ${saturationMs} ms, so ${concurrency} concurrent requests would only queue minutes of synchronous server work.`,
          });
          continue;
        }
        await ensurePrepared(concurrency);
        if (operation.name === "admit_run")
          await sleep(Math.ceil((options.admissions / tenantWritesPerSecond) * 1000) + 1000);
        const iterations = operation.iterations(options);
        const { value: loop, use } = await meter(stack, () =>
          closedLoop(
            { concurrency, iterations, maxMs: options.maxSecondsPerLevel * 1000 },
            (iteration) => operation.work(iteration, concurrency),
          ),
        );
        const summary = summarizeOperation(operation.name, concurrency, iterations, loop);
        if (concurrency === options.concurrency[0] && (summary.latency.p50Ms ?? 0) > saturationMs)
          saturatedAtOne = true;
        const settleSeconds = await settle(stack);
        results.push({
          ...summary,
          route: operation.route,
          description: operation.description,
          resources: use,
          coldFirstRequestMs: concurrency === options.concurrency[0] ? rounded(cold) : null,
          settleSeconds,
        });
        console.error(
          `[bench] ${operation.name} c=${concurrency} n=${summary.latency.count} p50=${summary.latency.p50Ms} p95=${summary.latency.p95Ms} p99=${summary.latency.p99Ms} err=${summary.errors} settle=${settleSeconds}s`,
        );
      }
    }

    const sse: SseResult[] = [];
    for (const streams of options.sseStreams) {
      const result = await measureSse(
        stack,
        seeded.projects[Math.min(1, seeded.projects.length - 1)] as Seeded["projects"][number],
        streams,
        options.sseEvents,
      );
      sse.push(result);
      console.error(
        `[bench] sse streams=${streams} ttfe p95=${result.timeToFirstEvent.p95Ms} fanout p95=${result.fanOutLatency.p95Ms} missed=${result.missedDeliveries}`,
      );
    }

    const probePrincipal = await stack.addRunner();
    const backpressure = await measureBackpressure(
      stack,
      seeded.projects[Math.min(2, seeded.projects.length - 1)] as Seeded["projects"][number],
      probePrincipal,
    );
    const saturation = await measureSaturation(stack, seeded, 256);
    console.error(
      `[bench] backpressure ${JSON.stringify(backpressure.statusCounts)} saturation ${JSON.stringify(saturation.statusCounts)}`,
    );

    const serverAlive = processUsage(stack.serverPid) !== null;
    const referenceSeries = options.referenceSeries.filter((level) =>
      options.concurrency.includes(level),
    );
    const nfr = evaluateTargets(nfr006Targets, results, referenceSeries, seeded.runsInDatabase);
    const finishedAt = new Date();
    return {
      schemaVersion: "1.0.0",
      benchmark: "server-load",
      requirement: "OPS-034",
      measuredRequirement: "NFR-006",
      startedAt: startedAt.toISOString(),
      finishedAt: finishedAt.toISOString(),
      durationSeconds: Math.round((finishedAt.getTime() - startedAt.getTime()) / 1000),
      hardware: {
        ...hardware,
        loadAverageAtStart: loadStart.map((value) => rounded(value)),
        loadAverageAtEnd: os.loadavg().map((value) => rounded(value)),
      },
      stack: {
        profile: "server",
        engine: "PostgreSQL",
        postgres: stack.postgres,
        evidenceStorage: "filesystem",
        clientTransport:
          "plain HTTP on loopback with X-Forwarded-Proto: https from a trusted proxy address; TLS termination and reverse-proxy cost are excluded",
        authentication:
          "bearer API tokens; one runner principal per admission slice, the workspace owner for reads",
        workers:
          "A real worker (Docker executor) runs three Runs to publish the artifacts that are read, then is stopped. During measurement its worker row is kept ready by a benchmark heartbeat because admission is refused without a live worker; no process claims work, so admitted Runs stay queued and the benchmark measures the control plane only",
        cache:
          "warm: five unmeasured requests per operation precede each series; the first of them is reported as coldFirstRequestMs",
        network: "loopback only; target is a local node:http fixture, no external network",
      },
      dataset: {
        workspaces: 1,
        projects: options.projects,
        testsPerProject: options.testsPerProject,
        tests: seeded.testIds.length,
        runsRequested: options.runs,
        runsInDatabaseAfterSeeding: seeded.runsInDatabase,
        runsByOutcome: seeded.runsByOutcome,
        seedSeconds: seeded.seedSeconds,
        seededRunShape:
          "terminal Run documents built by RunsService.prepare (admission snapshot included) and completed; no attempts, steps, events or artifacts",
        artifacts,
      },
      method: {
        load: "closed loop: each worker issues its next request as soon as the previous finishes; no think time",
        concurrencyLevels: options.concurrency,
        referenceSeries,
        referenceSeriesSource:
          "specs/10-validation.md 9 (concurrency series 1/4/8); the other levels are reported as stress levels and do not decide a verdict",
        iterationsPerLevel: options.iterations,
        admissionsPerLevel: options.admissions,
        maxSecondsPerLevel: options.maxSecondsPerLevel,
        percentileRule: `p95 is reported as a measurement from ${minimumSamples(95)} successful samples, p99 from ${minimumSamples(99)}; below that the number is shown but flagged unsupported and never decides a verdict`,
        errorHandling:
          "failed or non-expected-status requests are counted as errors and excluded from latency percentiles; a level with errors cannot be 'met'",
        fixtureTargetRequests: {
          afterArtifactRuns: fixtureAfterArtifacts,
          atEnd: fixture.requests(),
          note: "The target is only hit while the three artifact Runs execute; admission, listing, SSE and artifact reads send it nothing, so controller, queue and storage load is separate from target load",
        },
      },
      operations: results,
      skippedLevels,
      sse: {
        description:
          "N concurrent streams on one Run; time to first event, then fan-out latency of published events (publisher commit start to receipt, same host clock)",
        results: sse,
      },
      backpressure,
      saturation,
      serverStillRunning: serverAlive,
      nfr006: nfr,
      limitations: [
        "Single host: server, PostgreSQL container and the load generator share one machine and its other workloads (see loadAverage).",
        "Every PostgreSQL write transaction takes one advisory lock (ADR-015), so writes are serialized; the synchronous bridge blocks the server's only JavaScript thread for each query.",
        "Latencies are API request times, not UI render times; the UI targets are mapped to their API analogues.",
        "Orchestration overhead, queue start lag and artifact publication need executed Runs under load and are not measured.",
        "Artifacts are small (a few KiB); throughput for large artifacts is not measured.",
        "Distributed scale, S3-compatible storage and distributed SLOs belong to M5; Windows and macOS to M6.",
      ],
    };
  } catch (error) {
    console.error(`[bench] failed; server and worker log tail:\n${stack.logs().slice(-6000)}`);
    throw error;
  } finally {
    stopPresence();
    await stack.stop().catch((error) => console.error(`[bench] stack stop failed: ${error}`));
    await fixture.close();
  }
}

/* -------------------------------------------------------------------------------------------- */
/* CLI                                                                                            */
/* -------------------------------------------------------------------------------------------- */

function numberList(value: string, name: string): number[] {
  const list = value.split(",").map(Number);
  if (!list.length || list.some((entry) => !Number.isInteger(entry) || entry < 1))
    throw new Error(`${name} must be a comma-separated list of positive integers`);
  return list;
}

export function parseArguments(argv: readonly string[]): BenchOptions {
  const values = new Map<string, string>();
  for (let index = 0; index < argv.length; index += 2) {
    const flag = argv[index];
    const value = argv[index + 1];
    if (!flag?.startsWith("--") || value === undefined)
      throw new Error(`Expected --flag value pairs, got ${flag ?? "nothing"}`);
    values.set(flag.slice(2), value);
  }
  const known = [
    "out",
    "projects",
    "tests-per-project",
    "runs",
    "concurrency",
    "iterations",
    "admissions",
    "max-seconds",
    "sse-streams",
    "sse-events",
    "work-dir",
  ];
  for (const flag of values.keys())
    if (!known.includes(flag)) throw new Error(`Unknown flag --${flag}`);
  const out = values.get("out");
  if (!out) throw new Error("--out <file> is required");
  const integer = (name: string, fallback: number): number => {
    const raw = values.get(name);
    if (raw === undefined) return fallback;
    const parsed = Number(raw);
    if (!Number.isInteger(parsed) || parsed < 1)
      throw new Error(`--${name} must be a positive integer`);
    return parsed;
  };
  return {
    out: resolve(out),
    projects: integer("projects", defaultOptions.projects),
    testsPerProject: integer("tests-per-project", defaultOptions.testsPerProject),
    runs: integer("runs", defaultOptions.runs),
    concurrency: values.has("concurrency")
      ? numberList(values.get("concurrency") ?? "", "--concurrency")
      : defaultOptions.concurrency,
    referenceSeries: defaultOptions.referenceSeries,
    iterations: integer("iterations", defaultOptions.iterations),
    admissions: integer("admissions", defaultOptions.admissions),
    maxSecondsPerLevel: integer("max-seconds", defaultOptions.maxSecondsPerLevel),
    sseStreams: values.has("sse-streams")
      ? numberList(values.get("sse-streams") ?? "", "--sse-streams")
      : defaultOptions.sseStreams,
    sseEvents: integer("sse-events", defaultOptions.sseEvents),
    workDirectory: resolve(values.get("work-dir") ?? defaultOptions.workDirectory),
  };
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  try {
    const options = parseArguments(process.argv.slice(2));
    const result = await runBenchmark(options);
    await mkdir(dirname(options.out), { recursive: true });
    await writeFile(options.out, `${JSON.stringify(result, null, 2)}\n`);
    console.error(`[bench] wrote ${options.out}`);
  } catch (error) {
    console.error(error instanceof Error ? (error.stack ?? error.message) : String(error));
    process.exitCode = 1;
  }
}
