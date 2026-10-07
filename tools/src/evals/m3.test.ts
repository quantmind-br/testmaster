import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { createServer } from "node:http";
import { Application, resolveConfig, scaffoldPlan } from "@testmaster/application";
import { ContractError } from "@testmaster/contracts";
import { afterEach, expect, it } from "vitest";
import { emptyLedger, plannedCases } from "./m3-scoring.js";
import type { M3Registration } from "./m3.js";
import {
  applyExactPatches,
  assertNotStarted,
  assertRegistrationIdentity,
  assertImplementationBinding,
  assessPolicyProbe,
  authenticateIntegrationTarget,
  claimStart,
  checkM3,
  compareProtectedAssertions,
  controlledHealingOutput,
  freezeM3,
  healingRefusal,
  implementationManifest,
  settleM3,
  writeEvalProfile,
} from "./m3.js";

const temporary: string[] = [];
afterEach(async () => {
  for (const path of temporary.splice(0)) await rm(path, { recursive: true, force: true });
});
/**
 * The registration is historical once frozen: its inputs are the bytes committed with it, not the
 * current working tree, which may legitimately change after the round under a new registration.
 */
async function fixtureCopy() {
  const root = await mkdtemp(join(tmpdir(), "tm-m3-check-"));
  temporary.push(root);
  const path = "evals/rounds/m3-round1-qwen38-medium/preregistration.json";
  const git = (...args: string[]) =>
    execFileSync("git", ["--no-pager", ...args], { cwd: resolve("."), maxBuffer: 64 << 20 });
  const commit = git("log", "-1", "--format=%H", "--", path).toString().trim();
  const r = JSON.parse(git("show", `${commit}:${path}`).toString("utf8")) as M3Registration;
  for (const file of new Set([...Object.keys(r.frozenFiles), path])) {
    await mkdir(dirname(join(root, file)), { recursive: true });
    await writeFile(join(root, file), git("show", `${commit}:${file}`));
  }
  return { root, path, r };
}
it("checks all fixed cases and budgets without network, model or Docker invocation", async () => {
  const { root, path } = await fixtureCopy();
  const original = globalThis.fetch;
  globalThis.fetch = () => {
    throw new Error("Offline check attempted network");
  };
  try {
    expect(await checkM3(root, path)).toMatchObject({
      plannedMainCases: 30,
      supplementalTrials: 1,
      modelCalls: 0,
      dockerCalls: 0,
      denominators: { safeHealing: 12, causeAccuracy: 26, trueBugOffers: 9, healthy: 4 },
      // Historical controls do not satisfy the new policy-probe admission contract.
      readyForLive: false,
    });
  } finally {
    globalThis.fetch = original;
  }
});
it("rejects an absent exact context rather than substituting another patch", async () => {
  expect(() =>
    applyExactPatches(
      "unchanged",
      [{ file: "shop.html", before: "missing", after: "replacement" }],
      "shop.html",
    ),
  ).toThrow("context absent");
});
it("refuses a corpus whose frozen patch context is absent", async () => {
  const { root, path, r } = await fixtureCopy();
  const corpusPath = join(root, r.corpus);
  const corpus = JSON.parse(await readFile(corpusPath, "utf8"));
  corpus.cases.find((row: { id: string }) => row.id === "m3-drift-01").patches[0].before =
    "absent frozen context";
  const bytes = JSON.stringify(corpus);
  await writeFile(corpusPath, bytes);
  r.frozenFiles[r.corpus] = createHash("sha256").update(bytes).digest("hex");
  await writeFile(join(root, path), JSON.stringify(r));
  await expect(checkM3(root, path)).rejects.toThrow("context absent");
});
it("refuses a previously started registration even when its observations are missing", async () => {
  const { root, r } = await fixtureCopy();
  await mkdir(join(root, "evals/results", `${r.id}-2026-10-06T00-00-00Z`), { recursive: true });
  await expect(assertNotStarted(root, r.id)).rejects.toThrow("already started");
});
it("refuses changed generation controls and quotas before dispatch", async () => {
  const { root, path, r } = await fixtureCopy();
  r.budget.maxTokens++;
  await writeFile(join(root, path), JSON.stringify(r));
  await expect(checkM3(root, path)).rejects.toThrow("budget");
});
it("refuses hand-populated control booleans without retained run/step/oracle evidence", async () => {
  const { root, path } = await fixtureCopy();
  const control = "controls.json";
  await writeFile(
    join(root, control),
    JSON.stringify({
      cases: [
        {
          id: "m3-drift-01",
          healthyPassed: true,
          negativeConfirmed: true,
          semanticAssertionReached: true,
          semanticAssertionFailed: true,
        },
      ],
    }),
  );
  await expect(freezeM3(root, path, control)).rejects.toThrow("evidence-backed controls");
});
it("writes the registered provider as a profile the product configuration accepts", async () => {
  const { r } = await fixtureCopy();
  const home = await mkdtemp(join(tmpdir(), "tm-m3-profile-"));
  temporary.push(home);
  await writeEvalProfile(home, r.provider);
  const config = await resolveConfig({ cwd: home, home, env: { HOME: home } });
  expect(config.modelProviders).toMatchObject([
    {
      id: r.provider.id,
      baseUrl: r.provider.baseUrl,
      apiKeyEnv: r.provider.apiKeyEnv,
      models: [{ id: r.provider.model, reasoningEffort: "medium" }],
    },
  ]);
  expect(config.profilePolicy.allowedModelProviders).toEqual([r.provider.id]);
});
it("accepts a new exact round identity and confines it to its registration directory", async () => {
  const { root, r } = await fixtureCopy();
  r.id = "m3-round2-qwen38-medium";
  const path = `evals/rounds/${r.id}/preregistration.json`;
  await mkdir(dirname(join(root, path)), { recursive: true });
  await writeFile(join(root, path), JSON.stringify(r));
  expect((await checkM3(root, path)).modelCalls).toBe(0);
  for (const id of ["../escape", "m3-round0-qwen38-medium", "m3-round2-qwen38-medium/escape"])
    expect(() => assertRegistrationIdentity(id, path)).toThrow("identity/path");
  expect(() => assertRegistrationIdentity(r.id, "evals/rounds/other/preregistration.json")).toThrow(
    "identity/path",
  );
});
it("admits only one concurrent controller and permanently refuses its start marker", async () => {
  const { root, r } = await fixtureCopy();
  const attempts = await Promise.allSettled([claimStart(root, r.id), claimStart(root, r.id)]);
  expect(attempts.filter((row) => row.status === "fulfilled")).toHaveLength(1);
  expect(attempts.filter((row) => row.status === "rejected")).toHaveLength(1);
  await expect(assertNotStarted(root, r.id)).rejects.toThrow("already started");
});
it("compares stored normalized assertion bytes and detects an actual predicate mutation", async () => {
  const root = await mkdtemp(join(tmpdir(), "tm-m3-assertions-"));
  temporary.push(root);
  const app = await Application.open({ cwd: root, home: root, env: { HOME: root } });
  try {
    const init = await app.init();
    const raw = scaffoldPlan("backend");
    const test = app.tests.create({ projectId: init.projectId, plan: raw });
    const base = app.revisions.get(test.activeRevisionId!);
    const candidate = app.revisions.create(test.id, raw);
    const comparison = compareProtectedAssertions(
      base.id,
      base.plan!,
      candidate.id,
      candidate.plan!,
    );
    expect(comparison).toMatchObject({
      baseRevisionId: base.id,
      candidateRevisionId: candidate.id,
      preserved: true,
    });
    expect(base.plan!.steps.find((step) => step.kind === "assertion")!.timeoutMs).toBe(30000);
    const changed = structuredClone(candidate.plan!);
    const assertion = changed.steps.find((step) => step.kind === "assertion")!;
    if (assertion.operation !== "assert") throw new Error("Expected assertion fixture");
    assertion.expectation = { predicate: "statusEquals", value: { literal: 503 } };
    expect(compareProtectedAssertions(base.id, base.plan!, candidate.id, changed).preserved).toBe(
      false,
    );
  } finally {
    app.close();
  }
});
it("retains typed refusals without confusing safe abstention with model failure", () => {
  const deterministic = healingRefusal(
    new ContractError("PRECONDITION_FAILED", "Healing abstained", {
      reason: "semantic_failure",
      jobId: "job_bound",
    }),
    [],
  );
  expect(deterministic).toMatchObject({
    failed: false,
    modelAbstained: false,
    record: { reason: "semantic_failure", jobId: "job_bound" },
  });
  expect(
    healingRefusal(
      new ContractError("PRECONDITION_FAILED", "Healing abstained", {
        reason: "model_abstained",
        modelCallId: "call_bound",
      }),
      [],
    ),
  ).toMatchObject({ failed: false, modelAbstained: true });
  expect(
    healingRefusal(
      new ContractError("PRECONDITION_FAILED", "Healing failed", {
        reason: "model_failure",
        detail: "INVALID_ARGUMENT secret",
      }),
      ["secret"],
    ),
  ).toMatchObject({ failed: true, record: { detail: "INVALID_ARGUMENT [REDACTED]" } });
  expect(() => healingRefusal(new ContractError("UNAVAILABLE", "Transport failed"), [])).toThrow(
    "Transport failed",
  );
});
it("emits exact step-relative controlled replacements and never copies assertion mutations", () => {
  const plan = scaffoldPlan("frontend");
  const action = plan.steps.find((step) => step.operation === "navigate")!;
  plan.steps = [
    {
      id: "click",
      kind: "action",
      operation: "click",
      description: "Open",
      input: { locator: { by: "testId", value: "old" } },
    },
    action,
  ];
  const candidate = structuredClone(plan);
  const click = candidate.steps[0]!;
  if (click.operation !== "click") throw new Error("click");
  click.input.locator = { by: "testId", value: "new" };
  expect(controlledHealingOutput(plan, candidate)).toMatchObject({
    kind: "patch",
    patch: {
      changes: [{ stepId: "click", path: "/input/locator", value: { by: "testId", value: "new" } }],
      evidenceHandles: ["E1"],
    },
  });
  expect(() => controlledHealingOutput(plan, plan)).toThrow("no replacement");
});
it("binds implementation before controls and rejects stale hashes or missing catalogs", async () => {
  const { r } = await fixtureCopy();
  const manifest = await implementationManifest(resolve("."), {
    ...r,
    requiredFreezeFiles: [],
    corpus: "evals/m3/corpus.json",
  });
  expect(Object.keys(manifest.files)).toEqual(
    expect.arrayContaining([
      "packages/application/src/ai/discovery.ts",
      "packages/application/src/ai/healing-patch.ts",
      "packages/planner/src/agent/locator-evidence.ts",
      "packages/contracts/src/primitives.ts",
      "packages/contracts/schemas/AIAnalysisOutput.json",
      "packages/persistence/migrations/sqlite/0008_fixture_inputs.sql",
    ]),
  );
  expect(() => assertImplementationBinding(manifest, manifest)).not.toThrow();
  expect(() => assertImplementationBinding(manifest, { ...manifest, hash: "changed" })).toThrow(
    "changed after",
  );
  expect(() => assertImplementationBinding(manifest, undefined)).toThrow("changed after");
});
it("rotates the same integration secret across authenticated targets without widening its origin", async () => {
  const root = await mkdtemp(join(tmpdir(), "tm-m3-secret-"));
  temporary.push(root);
  const app = await Application.open({ cwd: root, home: root, env: { HOME: root } });
  let token = "healthy-token";
  const server = createServer((_req, res) => {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ token }));
  });
  await new Promise<void>((accept) => server.listen(0, "127.0.0.1", accept));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("server");
  const url = `http://127.0.0.1:${address.port}`;
  try {
    await app.init();
    const first = await authenticateIntegrationTarget(app, url);
    token = "mutant-token";
    const second = await authenticateIntegrationTarget(app, url, first.secret.id);
    expect(second.token).toBe("mutant-token");
    expect(second.secret.id).toBe(first.secret.id);
    expect(second.secret.secretVersion).toBe(first.secret.secretVersion + 1);
    expect(second.secret.allowedOrigins).toEqual([url]);
    token = "";
    await expect(authenticateIntegrationTarget(app, url, first.secret.id)).rejects.toThrow(
      "authentication failed",
    );
    expect(app.secrets.get(first.secret.id).secretVersion).toBe(second.secret.secretVersion);
  } finally {
    app.close();
    await new Promise<void>((accept) => server.close(() => accept()));
  }
});
it("requires comparable frozen apply baselines and real service proposals for policy probes", () => {
  const run = {
    runId: "run_baseline",
    revisionId: "rev_base",
    outcome: "passed",
    gate: "passed",
    steps: [],
    reasonCodes: [],
    snapshotCount: 1,
    imageIds: ["sha256:image"],
    planHash: "plan",
    seed: 17,
    healingPolicy: "apply",
    environmentRevisionId: "env_revision",
    admissionHash: "admission",
  };
  const evidence = {
    id: "m3-drift-01",
    status: "passed" as const,
    healthy: run,
    transformed: { ...run, runId: "run_failed", outcome: "failed", gate: "failed" },
    modelCalls: 0,
    errors: [],
    refusal: { reason: "semantic_failure" },
  };
  expect(assessPolicyProbe(evidence)).toBe(true);
  expect(assessPolicyProbe({ ...evidence, refusal: { reason: "model_failure" } })).toBe(false);
  expect(
    assessPolicyProbe({
      ...evidence,
      transformed: { ...evidence.transformed, healingPolicy: "off" },
    }),
  ).toBe(false);
  expect(
    assessPolicyProbe({
      ...evidence,
      transformed: { ...evidence.transformed, admissionHash: "different-runtime" },
    }),
  ).toBe(false);
  expect(assessPolicyProbe({ ...evidence, modelCalls: 1 })).toBe(false);
});
it("settles interrupted reserved calls without dispatch or releasing unknown charges", async () => {
  const root = await mkdtemp(join(tmpdir(), "tm-m3-settle-"));
  temporary.push(root);
  const directory = "evals/results/m3-round2-qwen38-medium-interrupted";
  await mkdir(join(root, directory), { recursive: true });
  const item = plannedCases()[0]!;
  await writeFile(join(root, directory, `${item.id}.json`), JSON.stringify(emptyLedger(item)));
  await writeFile(
    join(root, directory, "round.json"),
    JSON.stringify({
      registrationId: "m3-round2-qwen38-medium",
      registrationHash: "hash",
      commit: "commit",
      directory,
      startedAt: new Date().toISOString(),
      status: "started",
      chargedTokens: 649152,
      logicalCommands: 1,
      consecutiveTransportFailures: 0,
      stopReason: null,
      pending: { caseId: item.id, reservation: 649152 },
    }),
  );
  const original = globalThis.fetch;
  globalThis.fetch = () => {
    throw new Error("Settlement must not dispatch");
  };
  try {
    await settleM3(root, directory);
  } finally {
    globalThis.fetch = original;
  }
  const round = JSON.parse(await readFile(join(root, directory, "round.json"), "utf8"));
  const ledger = JSON.parse(await readFile(join(root, directory, `${item.id}.json`), "utf8"));
  expect(round).toMatchObject({
    status: "settled",
    chargedTokens: 649152,
    logicalCommands: 1,
    pending: { reservation: 649152 },
  });
  expect(ledger).toMatchObject({
    status: "error",
    usage: { conservativeCharge: 649152 },
    errors: [{ code: "unknown_paid_completion" }],
  });
  await expect(settleM3(root, directory)).rejects.toThrow("Only interrupted");
});
