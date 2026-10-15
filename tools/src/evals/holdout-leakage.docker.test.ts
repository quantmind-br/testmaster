import { spawn } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Application } from "@testmaster/application";
import { afterAll, beforeAll, expect, it } from "vitest";
import {
  assertRoundNotInvalidated,
  findLeaks,
  type LeakageGuard,
  type LeakageSet,
  sealedLeakageSet,
  startLeakageGuard,
} from "./leakage.js";
import { loadCorpusDriver, loadM3Corpus, writeEvalProfile } from "./m3.js";

/**
 * VAL-016(b): real Application analysis and healing prompt builders run on real failing Runs of
 * sealed clinic cases while the harness holds every sealed label, mutant and case identifier in
 * memory. Every outbound model request crosses the leakage guard and is independently rescanned.
 */
interface NegativeControl {
  rejected: boolean;
  blockedDelta: number;
  upstreamDelta: number;
}
interface Exercise {
  analysisPrompts: number;
  healingPrompts: number;
  blockedKinds: string[];
  blockedCaseIds: string[];
}
const root = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const corpusPath = "evals/holdout/m3-clinic/sealed.json";
const registered = JSON.parse(
  await readFile(
    join(root, "evals/rounds/m3-round8-holdout-muse-spark-contributor/preregistration.json"),
    "utf8",
  ),
);
const provider = registered.provider;
const decoding = registered.decoding;
const exercised = ["cl-bug-01", "cl-drift-02", "cl-adversarial-01"];
const keyEnv = provider.apiKeyEnv as string;
const temporary: string[] = [];
const servers: Server[] = [];
const upstreamBodies: { purpose: "analysis" | "healing"; body: string }[] = [];
let upstreamRequests = 0;
let upstreamUrl = "";

beforeAll(async () => {
  const server = createServer(async (request, response) => {
    response.setHeader("content-type", "application/json");
    if (request.url === "/v1/models") {
      response.end(JSON.stringify({ data: [{ id: provider.model }] }));
      return;
    }
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(Buffer.from(chunk));
    const body = Buffer.concat(chunks).toString("utf8");
    upstreamRequests++;
    const healing = body.includes("Return kind patch with a patch");
    upstreamBodies.push({ purpose: healing ? "healing" : "analysis", body });
    // Controlled output: the prompt is the object under test, not the model's answer.
    const output = healing
      ? { kind: "abstain", reason: "controlled provider", evidenceHandles: ["E1"] }
      : {
          failureKind: "unknown",
          hypotheses: [],
          recommendedAction: "collect_more_evidence",
          fixTargetHandle: null,
          limitations: [],
          nextSteps: [],
          evidenceGaps: [],
        };
    response.end(
      JSON.stringify({
        id: "controlled",
        object: "chat.completion",
        model: provider.model,
        choices: [
          {
            index: 0,
            message: { role: "assistant", content: JSON.stringify(output) },
            finish_reason: "stop",
          },
        ],
        usage: { prompt_tokens: 100, completion_tokens: 10, total_tokens: 110 },
      }),
    );
  });
  servers.push(server);
  await new Promise<void>((accept) => server.listen(0, "127.0.0.1", accept));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Missing upstream address");
  upstreamUrl = `http://127.0.0.1:${address.port}/v1`;
});
afterAll(async () => {
  for (const server of servers.splice(0)) {
    server.closeAllConnections();
    await new Promise<void>((accept) => server.close(() => accept()));
  }
  for (const directory of temporary.splice(0))
    await rm(directory, { recursive: true, force: true });
});

async function open(caseId: string, targetUrl: string, baseUrl: string) {
  const directory = await mkdtemp(join(tmpdir(), "tm-leak-"));
  temporary.push(directory);
  const cwd = join(directory, "repo");
  const home = join(directory, "home");
  await mkdir(cwd);
  await mkdir(join(home, ".config/testmaster"), { recursive: true });
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    HOME: home,
    XDG_CONFIG_HOME: join(home, ".config"),
    XDG_DATA_HOME: join(home, ".local/share"),
    TESTMASTER_DATA_DIR: join(cwd, ".testmaster"),
    TESTMASTER_OFFLINE: "false",
    CI: "false",
    [keyEnv]: "controlled-provider-key",
  };
  for (const name of [
    "NODE_OPTIONS",
    "TESTMASTER_PROJECT_ID",
    "TESTMASTER_PROFILE",
    "TESTMASTER_ENDPOINT",
    "TESTMASTER_API_KEY",
    "TESTMASTER_MODEL_API_KEY",
    "DOCKER_HOST",
    "DOCKER_CONTEXT",
  ])
    delete env[name];
  await writeEvalProfile(home, { ...provider, baseUrl }, decoding);
  await new Promise<void>((accept, reject) => {
    const child = spawn(
      process.execPath,
      [
        join(root, "apps/cli/dist/main.js"),
        "init",
        "--mode",
        "local",
        "--name",
        caseId,
        "--base-url",
        targetUrl,
        "--output",
        "json",
      ],
      { cwd, env, stdio: ["ignore", "ignore", "pipe"] },
    );
    let stderr = "";
    child.stderr.on("data", (chunk: Buffer) => {
      stderr = (stderr + chunk.toString()).slice(-2048);
    });
    child.on("error", reject);
    child.on("close", (code) =>
      code === 0 ? accept() : reject(new Error(`init exited ${String(code)}: ${stderr}`)),
    );
  });
  const configPath = join(cwd, "testmaster.config.json");
  const config = JSON.parse(await readFile(configPath, "utf8"));
  config.execution = {
    ...config.execution,
    executor: "docker",
    mode: "replay",
    concurrency: 1,
    maxAttempts: 1,
  };
  config.healing = { mode: "off" };
  config.telemetry = { enabled: false };
  await writeFile(configPath, JSON.stringify(config));
  const app = await Application.open({ cwd, home, env });
  const project = app.projects.list()[0]!;
  return { app, projectId: project.id, environmentId: app.environments.list(project.id)[0]!.id };
}
async function replay(app: Application, testId: string, environmentId: string) {
  const receipt = await app.runs.admit(
    { testId, environmentId, mode: "replay", healingPolicy: "off", seed: 17 },
    { wait: true },
  );
  await app.worker.run({ ephemeral: true, runIds: [receipt.runId] });
  return app.runs.get(receipt.runId);
}

const families = ["library", "helpdesk", "dockyard", "clinic"];

/** Starts the healthy and transformed targets of one sealed case and runs the real pipeline on it. */
async function exercise(
  guard: LeakageGuard,
  caseId: string,
  planName: string | null,
  leaking: string | null = null,
): Promise<{ exercise: Exercise; control: NegativeControl | null }> {
  const corpus = await loadM3Corpus(root, corpusPath);
  const driver = await loadCorpusDriver(root, corpus);
  const item = corpus.cases.find((row) => row.id === caseId)!;
  const shop = await driver.startCase(root, corpus, item, "healthy", 0);
  const port = Number(new URL(shop.url).port);
  let active = shop;
  try {
    const { app, projectId, environmentId } = await open(caseId, shop.url, guard.baseUrl);
    try {
      const plan = structuredClone(item.plan);
      if (planName !== null) plan.name = planName;
      const test = app.tests.create({ projectId, plan });
      const healthy = await replay(app, test.id, environmentId);
      expect(healthy.outcome, `${caseId} healthy`).toBe("passed");
      await shop.close();
      active = await driver.startCase(root, corpus, item, "transformed", port);
      const failed = await replay(app, test.id, environmentId);
      expect(failed.outcome, `${caseId} transformed`).toBe("failed");
      const bodies = upstreamBodies.length;
      const leaks = guard.state.leaks.length;
      await app.analysis.analyze(failed.id, { model: false });
      await app.analysis.analyze(failed.id, { model: true }).catch(() => undefined);
      // A refusal or abstention is a legitimate outcome here; only the outbound prompt matters.
      await app.healing.propose(failed.id, {}).catch(() => undefined);
      const control = async (): Promise<NegativeControl> => {
        const before = { requests: upstreamRequests, blocked: guard.state.blocked };
        const failure = await app.model
          .complete({
            projectId,
            purpose: "analyze",
            responseSchema: "AIAnalysisOutput",
            data: { evidence: leaking },
            dataClasses: ["execution_evidence"],
          })
          .then(
            () => null,
            (error: unknown) => error,
          );
        return {
          rejected: failure !== null,
          blockedDelta: guard.state.blocked - before.blocked,
          upstreamDelta: upstreamRequests - before.requests,
        };
      };
      const mine = upstreamBodies.slice(bodies);
      const blocked = guard.state.leaks.slice(leaks);
      return {
        exercise: {
          analysisPrompts: mine.filter((row) => row.purpose === "analysis").length,
          healingPrompts: mine.filter((row) => row.purpose === "healing").length,
          blockedKinds: blocked.map((leak) => leak.kind),
          blockedCaseIds: blocked.flatMap((leak) => leak.caseIds),
        },
        control: leaking === null ? null : await control(),
      };
    } finally {
      app.close();
    }
  } finally {
    await active.close();
  }
}
async function everySealedCase(): Promise<LeakageSet> {
  const cases = [];
  for (const family of families) {
    const corpus = await loadM3Corpus(root, `evals/holdout/m3-${family}/sealed.json`);
    cases.push(...corpus.cases);
  }
  return sealedLeakageSet(cases);
}

it("detects the sealed case identifier the healing prompt builder really sends, keeps analysis prompts clean, and passes a healing prompt once the plan name is opaque", async () => {
  // Harness-side data a leak could come from: every label, mutant, case and oracle name of all
  // four sealed families, held in memory while the real pipeline runs.
  const set = await everySealedCase();
  const corpus = await loadM3Corpus(root, corpusPath);
  expect(corpus.cases).toHaveLength(30);
  const drift = corpus.cases.find((row) => row.id === "cl-drift-02")!;

  // Arm A: exactly what the spent rounds did, a test named after its sealed case.
  const faithful = await startLeakageGuard({ upstream: upstreamUrl, set });
  const armA: Record<string, Exercise> = {};
  try {
    for (const caseId of exercised)
      armA[caseId] = (await exercise(faithful, caseId, null)).exercise;
  } finally {
    await faithful.close();
  }
  // Analysis prompts of every failing case carry no sealed identifier.
  for (const caseId of exercised) expect(armA[caseId]!.analysisPrompts).toBeGreaterThan(0);
  // The healing prompt includes the whole plan, so the plan name (the sealed case ID, which spells
  // the case group) reaches the provider. The guard catches it before dispatch.
  expect(armA["cl-bug-01"]!.healingPrompts).toBe(0);
  expect(armA["cl-bug-01"]!.blockedKinds).toEqual([]);
  for (const caseId of ["cl-drift-02", "cl-adversarial-01"]) {
    expect(armA[caseId]!.healingPrompts, `${caseId} healing prompt must not be forwarded`).toBe(0);
    expect(armA[caseId]!.blockedKinds, caseId).toEqual(["case-id"]);
    expect(armA[caseId]!.blockedCaseIds, caseId).toEqual([caseId]);
  }
  expect(faithful.state).toMatchObject({ blocked: 2, invalid: true });
  expect(() => assertRoundNotInvalidated(faithful.state)).toThrow("round invalid");

  // Arm B: the same sealed drift case with an opaque test name.
  const opaque = await startLeakageGuard({ upstream: upstreamUrl, set });
  let armB: Exercise;
  let negativeControl: NegativeControl;
  const sentBefore = upstreamBodies.length;
  try {
    const run = await exercise(
      opaque,
      "cl-drift-02",
      "audit-subject-1",
      drift.labels!.truthKnownToAuthor!.mechanism,
    );
    armB = run.exercise;
    expect(armB.analysisPrompts).toBeGreaterThan(0);
    expect(armB.healingPrompts).toBeGreaterThan(0);
    expect(armB.blockedKinds).toEqual([]);
    const sent = upstreamBodies.slice(sentBefore);
    expect(sent.some((row) => row.body.includes("allowedReplacements"))).toBe(true);
    expect(sent.every((row) => row.body.includes("untrustedData"))).toBe(true);
    // Independent rescan of every body the provider actually received.
    for (const row of sent) expect(findLeaks(row.body, set)).toEqual([]);
    // Negative control: a deliberately label-bearing prompt through the same real pipeline.
    negativeControl = run.control!;
    expect(negativeControl).toEqual({ rejected: true, blockedDelta: 1, upstreamDelta: 0 });
    expect(opaque.state.leaks.map((leak) => leak.kind)).toEqual(["truth-mechanism"]);
    // Every block on this guard is the deliberate control; the real pipeline added none.
    expect(opaque.state).toMatchObject({ blocked: 1, invalid: true });
    expect(() => assertRoundNotInvalidated(opaque.state)).toThrow("round invalid");
  } finally {
    await opaque.close();
  }
  const record = {
    schemaVersion: "1.0.0",
    validation: "automated-only",
    corpus: corpusPath,
    forbiddenValuesAllFamilies: set.entries.length,
    harnessFaithfulPlanName: armA,
    opaquePlanName: { "cl-drift-02": armB },
    negativeControl,
  };
  await writeFile(
    join(root, "validation/results/m3-holdout-prompt-leakage-audit.json"),
    `${JSON.stringify(record, null, 2)}\n`,
  );
}, 900_000);
