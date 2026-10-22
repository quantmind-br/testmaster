import { randomBytes } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ServerConfig } from "@testmaster/application";
import { type GithubWorld, startGithubWorld } from "@testmaster/application/testing";
import type { GithubPull, PlanStep } from "@testmaster/contracts";
import { createServer } from "@testmaster/server";
import { afterAll, beforeAll, expect, it } from "vitest";
import {
  createTestDatabaseOn,
  type PostgresTestServer,
  startPostgresTestServer,
  type TestDatabase,
} from "../../packages/persistence/src/testing/server.js";
import { eventually, healthPlan, Journey, object, text } from "./harness.js";
import { type Spawned, spawnCli } from "./server-stack.js";
import { createTestCa, startTlsProxy, type TlsProxy } from "./tls-proxy.js";
import { type Laptop, lineOf, lines, startCliAgent, startLaptop } from "./tunnel-helpers.js";

/**
 * J12 tunnel variant (INT-024, SEC-039): a same-repository pull request preview runs on a remote
 * worker through the developer's tunnel, only after a reviewer approves the exact binding the
 * refusal named; a fork never reaches the tunnel. PostgreSQL, the real HTTP server and tunnel relay
 * behind a TLS proxy, the built CLI as remote worker and tunnel agent, real Docker sandboxes and a
 * fake GitHub that signs webhooks and records check runs.
 */
const SHA_A = "a7".repeat(20);
const SHA_B = "b8".repeat(20);
const SHA_C = "c9".repeat(20);
const SHA_D = "da".repeat(20);
const SHA_E = "eb".repeat(20);
const SHA_FORK = "fc".repeat(20);
const PR = 41;
const SUCCESS = { "TestMaster / result": "success", "TestMaster / required-gate": "success" };
/** A held step outlives every check below; only the tunnel or the Run may end it. */
const HELD_STEP_TIMEOUT_MS = 240_000;

let postgres: PostgresTestServer | undefined;
let database: TestDatabase | undefined;
let directory = "";
let world: GithubWorld | undefined;
let http: ReturnType<typeof createServer> | undefined;
let proxy: TlsProxy | undefined;
let laptop: Laptop | undefined;
let session: Journey | undefined;
let failure: unknown;
let caFile = "";
let token = "";
let env: NodeJS.ProcessEnv = {};
const spawned: Spawned[] = [];
let main: { agent: Spawned; tunnelId: string } | undefined;

const live = () => {
  if (!world || !proxy || !laptop || !session || !main) throw new Error("journey setup missing");
  return { world, proxy, laptop, session, main };
};

const spawn = (args: string[], extra: NodeJS.ProcessEnv = {}): Spawned => {
  const child = spawnCli(args, { ...env, ...extra }, directory);
  spawned.push(child);
  return child;
};

const stopProcess = async (process: Spawned) => {
  if (process.child.exitCode !== null || process.child.signalCode !== null) return;
  process.child.kill("SIGTERM");
  // Cleanup only: a process that ignores SIGTERM must not keep the journey alive.
  const kill = setTimeout(() => process.child.kill("SIGKILL"), 60_000);
  await process.exited;
  clearTimeout(kill);
};

async function recorded(name: string, body: () => Promise<Record<string, unknown>>) {
  try {
    live().session.oracles.push({ scenario: name, ...(await body()) });
  } catch (error) {
    failure ??= error;
    throw error;
  }
}

const verdict = (sha: string): Record<string, string | null> =>
  Object.fromEntries(
    live()
      .world.checks(sha)
      .map((check) => [check.name, check.conclusion ?? check.status]),
  );

const pullView = (sha: string): GithubPull => {
  const { world } = live();
  const view = world.app.github.pulls(world.integration.id).find((pull) => pull.headSha === sha);
  if (!view) throw new Error(`no pull view for ${sha}`);
  return view;
};

/** Reconciles until the head's pull leaves `awaiting_preview`/`running`; the remote worker runs it. */
const settle = (sha: string, timeoutMs = 240_000) =>
  eventually(
    async () => {
      const { world } = live();
      await world.runtime.controllerScope().github.reconcile();
      await world.app.github.settle();
      return pullView(sha);
    },
    (pull) =>
      pull.state !== "awaiting_preview" &&
      pull.state !== "running" &&
      !Object.values(verdict(sha)).some((value) => value === "queued" || value === "in_progress"),
    timeoutMs,
  );

/** The developer pushes a head and attests its preview at the tunnel's loopback target. */
const push = async (sha: string, extra: { action?: string; fork?: { fullName: string } } = {}) => {
  const { world, laptop } = live();
  await world.openPr(PR, sha, extra);
  await world.runtime.controllerScope().github.reconcile();
  if (extra.fork) return;
  await world.app.github.previewDeployment({
    integrationId: world.integration.id,
    repositoryId: String(world.repository.id),
    prNumber: PR,
    headSha: sha,
    url: laptop.url,
  });
};

const runsOf = (pull: GithubPull) => {
  const { world } = live();
  if (!pull.batchId) return [];
  return (world.app.batches.get(pull.batchId).memberRuns as string[]).map((id) =>
    world.app.runs.get(id),
  );
};

const tunnelOf = (run: { matrixCell: unknown }) => object(run.matrixCell).tunnelId;

/** The reviewer approves exactly what the refusal of a head named, and nothing else. */
const approveRefusal = (sha: string) => {
  const { world, main } = live();
  const binding = object(pullView(sha).approvalBinding);
  expect(binding.actionSet).toEqual([`tunnel:${main.tunnelId}`]);
  return world.app.approvals.create({
    actorId: text(binding.actorId),
    revisionHash: text(binding.revisionHash),
    environmentRevisionId: text(binding.environmentRevisionId),
    originSet: binding.originSet as string[],
    actionSet: binding.actionSet as string[],
    policyHash: text(binding.policyHash),
    ...(binding.limits === undefined ? {} : { limits: object(binding.limits) }),
    reason: "Run the pull request preview against the developer's loopback app through the tunnel",
  });
};

beforeAll(async () => {
  session = await Journey.create("J12-tunnel", {
    class: "deterministic-e2e",
    runner: "real-docker-remote-workers",
    externalDependency: "local-fake-github-and-loopback-target",
    limitations: [
      "Local fake GitHub API and webhook sender; no real GitHub App is exercised.",
      "The HTTP server and tunnel relay run in the test process (createServer) rather than a spawned `server start`: a spawned server's GitHub reconciler has no API base override and would publish to api.github.com.",
      "Developer machine, relay, remote worker and Docker share one physical host.",
    ],
  });
  postgres = await startPostgresTestServer();
  database = await createTestDatabaseOn(postgres);
  directory = await mkdtemp(join(tmpdir(), "tm-j12-tunnel-"));
  await writeFile(join(directory, "master.key"), randomBytes(32), { mode: 0o600 });
  await mkdir(join(directory, "evidence"), { recursive: true });
  const ca = await createTestCa(join(directory, "ca"));
  caFile = join(directory, "ca.pem");
  await writeFile(caFile, ca.caPem, { mode: 0o600 });
  let directPort = 0;
  proxy = await startTlsProxy({ ca, upstreamPort: () => directPort });
  const server: ServerConfig = {
    mode: "server",
    database: { engine: "postgres", ...database.config },
    storage: { kind: "filesystem", root: join(directory, "evidence") },
    server: {
      listen: { host: "127.0.0.1", port: 0 },
      publicOrigin: proxy.origin,
      trustedProxies: ["127.0.0.1"],
      origins: [proxy.origin],
    },
    security: {
      masterKeyFile: join(directory, "master.key"),
      backupKeyFile: join(directory, "backup.key"),
      atRestEncryption: { database: "operator-volume", evidence: "operator-volume" },
    },
  };
  world = await startGithubWorld({ server, executor: "docker", publicOrigin: proxy.origin });
  http = createServer({ application: world.runtime, mode: "server", server, mcp: false });
  await http.listen({ host: "127.0.0.1", port: 0 });
  const address = http.server.address();
  directPort = typeof address === "object" && address ? address.port : 0;
  laptop = await startLaptop("laptop-only-j12");

  const home = join(directory, "home");
  await mkdir(home, { recursive: true, mode: 0o700 });
  env = {
    ...process.env,
    HOME: home,
    XDG_CONFIG_HOME: join(home, ".config"),
    XDG_DATA_HOME: join(home, ".local/share"),
    TESTMASTER_NO_TELEMETRY: "true",
    CI: "true",
  };
  for (const name of [
    "TESTMASTER_ENDPOINT",
    "TESTMASTER_PROFILE",
    "TESTMASTER_API_KEY",
    "TESTMASTER_DATA_DIR",
    "NODE_OPTIONS",
    "PGPASSWORD",
  ])
    delete env[name];

  token = world.app.tokens.create({
    name: "j12-tunnel",
    scopes: ["R", "W", "X"],
    grants: [],
    expiresAt: new Date(Date.now() + 60 * 60_000).toISOString(),
  }).token;
  const enrollment = world.app.workerPool.createEnrollment({ name: "j12-tunnel-worker" });
  const workerDirectory = join(directory, "worker");
  await mkdir(workerDirectory, { recursive: true, mode: 0o700 });
  const tokenFile = join(workerDirectory, "enroll.token");
  await writeFile(tokenFile, enrollment.enrollmentToken, { mode: 0o600 });
  const worker = spawn([
    "worker",
    "start",
    "--mode",
    "remote",
    "--controller",
    proxy.origin,
    "--ca-file",
    caFile,
    "--enroll-token-file",
    tokenFile,
    "--data-dir",
    join(workerDirectory, "data"),
    "--slots",
    "2",
  ]);
  await eventually(
    async () => lines(worker),
    (seen) => seen.some((line) => line.event === "worker.ready") || worker.child.exitCode !== null,
    120_000,
  );
  if (worker.child.exitCode !== null)
    throw new Error(`remote worker exited: ${worker.stderr()} ${worker.stdout()}`);

  main = await startCliAgent(
    { spawn, baseUrl: proxy.origin },
    { projectId: world.projectId, token, caFile, target: `127.0.0.1:${laptop.port}` },
  );
  // The fork's fixture is a separate server: a fork never reaches the developer's machine.
  const fixture = world.app.environments.create({
    projectId: world.projectId,
    name: "fork-fixture",
    baseUrl: world.target.origin,
    networkProfile: "local-loopback",
    locale: "en-US",
    timezone: "UTC",
  });
  await world.install();
  world.configureRepository({
    selection: { kind: "tests", testIds: [world.testId] },
    forkPolicy: "fixture-only",
    fixtureEnvironmentId: fixture.id,
    preview: { provider: "manual", environmentPattern: "*", timeoutMs: 1_800_000 },
    previewTunnelId: main.tunnelId,
  });
}, 300_000);

afterAll(async () => {
  await session?.close(failure);
  for (const child of spawned.reverse()) await stopProcess(child);
  await http?.close();
  await proxy?.close();
  await world?.stop();
  await laptop?.close();
  await database?.drop();
  await postgres?.stop();
  if (directory) await rm(directory, { recursive: true, force: true });
}, 300_000);

it("J12 tunnel: a same-repository PR preview runs through an approved tunnel and only the approved head turns green", async () => {
  await recorded("approved-head-through-tunnel", async () => {
    const { world, laptop, main } = live();
    const tunnel = () => world.app.tunnels.get(main.tunnelId);

    // Head A: the tunnel needs an approval nobody gave, so A is refused before anything runs.
    await push(SHA_A);
    const refusedA = await settle(SHA_A);
    expect(refusedA).toMatchObject({
      state: "denied",
      reasonCode: "admission_failed:POLICY_DENIED",
    });
    expect(Object.values(verdict(SHA_A))).not.toContain("success");
    expect(laptop.hits("/health")).toBe(0);
    expect(tunnel().usage.streamsOpened).toBe(0);

    // The reviewer approves the binding A's refusal named; the next head runs through the tunnel.
    approveRefusal(SHA_A);
    await push(SHA_B, { action: "synchronize" });
    const passedB = await settle(SHA_B);
    expect(passedB, JSON.stringify(passedB)).toMatchObject({ state: "completed", gate: "passed" });
    expect(verdict(SHA_B)).toEqual(SUCCESS);
    const [runB, ...extraB] = runsOf(passedB);
    expect(extraB).toEqual([]);
    expect(runB?.outcome).toBe("passed");
    expect(tunnelOf(runB as { matrixCell: unknown })).toBe(main.tunnelId);
    expect(laptop.hits("/health")).toBe(1);
    expect(lineOf(main.agent, "tunnel.stream.opened")).toBeDefined();
    const streamsAfterB = tunnel().usage.streamsOpened;
    expect(streamsAfterB).toBeGreaterThan(0);
    expect(Object.values(verdict(SHA_A))).not.toContain("success");

    // Head C: the approval was consumed by B's Run, so C is refused again.
    await push(SHA_C, { action: "synchronize" });
    const refusedC = await settle(SHA_C);
    expect(refusedC).toMatchObject({
      state: "denied",
      reasonCode: "admission_failed:POLICY_DENIED",
    });
    expect(Object.values(verdict(SHA_C))).not.toContain("success");
    expect(object(refusedC.approvalBinding).actionSet).toEqual([`tunnel:${main.tunnelId}`]);
    expect(laptop.hits("/health")).toBe(1);

    // A fork runs only on the fixture and never touches the tunnel.
    const fixtureHits = world.target.hits.length;
    await push(SHA_FORK, { fork: { fullName: "mallory/shop" } });
    const fork = await settle(SHA_FORK);
    const [forkRun] = runsOf(fork);
    expect(fork.reasonCode).toBe("fork_fixture_only");
    expect(forkRun).toBeDefined();
    expect(tunnelOf(forkRun as { matrixCell: unknown })).toBeUndefined();
    expect(world.target.hits.length).toBeGreaterThan(fixtureHits);
    expect(laptop.hits("/health")).toBe(1);
    expect(tunnel().usage.streamsOpened).toBe(streamsAfterB);

    return {
      tunnelId: main.tunnelId,
      runThroughTunnel: runB?.id,
      forkRun: forkRun?.id,
      verdicts: [SHA_A, SHA_B, SHA_C, SHA_FORK].map((sha) => ({ sha, verdict: verdict(sha) })),
    };
  });
}, 600_000);

it("J12 tunnel: revoking the tunnel stops the in-flight preview without a green check", async () => {
  await recorded("revoked-tunnel-in-flight", async () => {
    const { world, proxy, laptop, main } = live();
    const plan = healthPlan("ok", "hold-j12");
    const held = world.app.tests.create({
      projectId: world.projectId,
      plan: {
        ...plan,
        steps: plan.steps.map((step, index) =>
          index === 0 ? ({ ...step, timeoutMs: HELD_STEP_TIMEOUT_MS } as PlanStep) : step,
        ),
      },
    });
    world.configureRepository({ selection: { kind: "tests", testIds: [held.id] } });

    await push(SHA_D, { action: "synchronize" });
    expect(await settle(SHA_D)).toMatchObject({ state: "denied" });
    approveRefusal(SHA_D);
    await push(SHA_E, { action: "synchronize" });
    await eventually(
      async () => {
        await world.runtime.controllerScope().github.reconcile();
        return laptop.heldAt("/hold-j12");
      },
      (entries) => entries.length === 1,
      180_000,
    );

    // The owner kills the tunnel through the real surface while the preview's request is held.
    const stop = spawn(["--endpoint", proxy.origin, "tunnel", "stop", main.tunnelId], {
      TESTMASTER_API_KEY: token,
      NODE_EXTRA_CA_CERTS: caFile,
    });
    expect(await stop.exited, stop.stderr()).toBe(0);
    expect(JSON.parse(stop.stdout()).data).toMatchObject({ state: "revoked" });
    await eventually(
      async () => laptop.heldAt("/hold-j12")[0]?.closedAt ?? null,
      (closedAt) => closedAt !== null,
      30_000,
    );

    const ended = await settle(SHA_E);
    const [run] = runsOf(ended);
    expect(run?.outcome).toBe("cancelled");
    expect(
      world.app.database.get(
        "SELECT json_extract(data_json,'$.reasonCode') AS reason FROM outbox WHERE aggregate_id=? AND type='run.completed'",
        run?.id,
      )?.reason,
    ).toBe("tunnel_lost");
    expect(ended).toMatchObject({ state: "completed" });
    expect(ended.gate).not.toBe("passed");
    expect(Object.values(verdict(SHA_E))).not.toContain("success");
    expect(world.app.tunnels.get(main.tunnelId)).toMatchObject({
      state: "revoked",
      live: false,
    });
    return { run: run?.id, pull: ended.state, gate: ended.gate, verdict: verdict(SHA_E) };
  });
}, 600_000);
