import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { Application, resolveConfig, scaffoldPlan } from "@testmaster/application";
import type { Analysis, HealingProposal } from "@testmaster/contracts";
import { ContractError } from "@testmaster/contracts";
import { afterEach, expect, it, vi } from "vitest";
import type { FixtureDriver } from "../../../evals/m3/fixture.mjs";
import type { M3Registration } from "./m3.js";
import {
  applyExactPatches,
  assertImplementationBinding,
  assertNotStarted,
  assertRegistrationIdentity,
  assessAssistedCandidate,
  assessPolicyProbe,
  authenticateIntegrationTarget,
  checkM3,
  claimStart,
  compareProtectedAssertions,
  controlledHealingOutput,
  devM3,
  diagnosticUtility,
  freezeM3,
  healingRefusal,
  implementationManifest,
  loadCorpusDriver,
  settleM3,
  unsupportedClaimsForRun,
  writeEvalProfile,
} from "./m3.js";
import { emptyLedger, plannedCases } from "./m3-scoring.js";

const temporary: string[] = [];
afterEach(async () => {
  for (const path of temporary.splice(0)) await rm(path, { recursive: true, force: true });
  vi.restoreAllMocks();
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
  await writeEvalProfile(home, r.provider, r.decoding);
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
it.each(["low", "medium", "high", "xhigh", "max"])(
  "accepts the shared registered reasoning effort %s",
  async (effort) => {
    const { root, path, r } = await fixtureCopy();
    r.decoding.reasoning_effort = effort;
    await writeFile(join(root, path), JSON.stringify(r));
    expect((await checkM3(root, path)).modelCalls).toBe(0);
  },
);
it.each([{ reasoning_effort: "extreme" }, { reasoning_effort: "max", temperature: 1 }])(
  "refuses unsupported reasoning or additional wire controls %j",
  async (decoding) => {
    const { root, path, r } = await fixtureCopy();
    r.decoding = decoding;
    await writeFile(join(root, path), JSON.stringify(r));
    await expect(checkM3(root, path)).rejects.toThrow("generation controls");
  },
);
it("writes registered effort and local capabilities instead of fixed profile defaults", async () => {
  const { r } = await fixtureCopy();
  const home = await mkdtemp(join(tmpdir(), "tm-m3-profile-capabilities-"));
  temporary.push(home);
  r.decoding.reasoning_effort = "xhigh";
  r.provider.capabilities = { contextTokens: 1048576, maxOutputTokens: 131072 };
  await writeEvalProfile(home, r.provider, r.decoding);
  const config = await resolveConfig({ cwd: home, home, env: { HOME: home } });
  expect(config.modelProviders[0]!.models[0]).toMatchObject({
    reasoningEffort: "xhigh",
    capabilities: { contextTokens: 1048576, maxOutputTokens: 131072 },
  });
  r.provider.capabilities.contextTokens = 1.5;
  const { root, path } = await fixtureCopy();
  await writeFile(join(root, path), JSON.stringify(r));
  await expect(checkM3(root, path)).rejects.toThrow("capabilities");
});
async function developmentFixture() {
  const fixture = await fixtureCopy();
  fixture.r.provider.apiKeyEnv = "TESTMASTER_M3_DEV_UNSET_KEY";
  fixture.r.provider.baseUrl = "http://127.0.0.1:1/v1";
  fixture.r.budget.maxTokens = 1;
  await writeFile(
    join(fixture.root, fixture.path),
    JSON.stringify({
      provider: fixture.r.provider,
      decoding: fixture.r.decoding,
      budget: fixture.r.budget,
      corpus: fixture.r.corpus,
    }),
  );
  return fixture;
}
it("refuses unsafe dev labels and unknown IDs before creating results or a start marker", async () => {
  const { root, path, r } = await developmentFixture();
  for (const label of ["../escape", "UPPER", "", "a".repeat(42)])
    await expect(devM3(root, path, label, ["m3-bug-01"])).rejects.toThrow("output label");
  await expect(devM3(root, path, "known-label", ["m3-unknown-01"])).rejects.toThrow(
    "Unknown M3 case ID",
  );
  await expect(readFile(join(root, "evals/results"))).rejects.toMatchObject({ code: "ENOENT" });
  await expect(readFile(join(root, "evals/rounds", r.id, "started.json"))).rejects.toMatchObject({
    code: "ENOENT",
  });
});
it.each(["provider", "decoding", "budget", "corpus"])(
  "requires structurally valid dev %s even though freeze gates are skipped",
  async (field) => {
    const { root, path } = await developmentFixture();
    const input = JSON.parse(await readFile(join(root, path), "utf8"));
    delete input[field];
    await writeFile(join(root, path), JSON.stringify(input));
    await expect(devM3(root, path, "missing-input", ["m3-bug-01"])).rejects.toThrow();
    await expect(readFile(join(root, "evals/results"))).rejects.toMatchObject({ code: "ENOENT" });
  },
);
it("records an unstarted dev subset without freeze, scoring, dispatch or a start marker", async () => {
  const { root, path, r } = await developmentFixture();
  const original = globalThis.fetch;
  globalThis.fetch = () => {
    throw new Error("Missing-key dev probe attempted network");
  };
  try {
    const directory = await devM3(root, path, "subset", ["m3-bug-01"]);
    expect(directory).toMatch(/^evals\/results\/dev-subset-/);
    const round = JSON.parse(await readFile(join(root, directory, "round.json"), "utf8"));
    expect(round).toMatchObject({
      development: true,
      status: "completed",
      stopReason: "missing_key",
      logicalCommands: 0,
      transportAttempts: 0,
    });
    const report = JSON.parse(await readFile(join(root, directory, "report.json"), "utf8"));
    expect(report.development).toBe(true);
    expect(report.score).toBeUndefined();
    expect(JSON.parse(await readFile(join(root, directory, "summary.json"), "utf8"))).toMatchObject(
      {
        development: true,
        cases: [
          {
            id: "m3-bug-01",
            group: "bug",
            expectedFailureKind: "product_bug",
            diagnosis: null,
            status: "unstarted",
            errorCodes: [],
            proposalApprovalMode: null,
            callCount: 0,
            tokens: { conservativeCharge: 0 },
          },
        ],
      },
    );
    expect(await readFile(join(root, directory, "report.md"), "utf8")).toMatch(
      /^# M3 development probe \(not a registered round\)/,
    );
    await expect(readFile(join(root, "evals/rounds", r.id, "started.json"))).rejects.toMatchObject({
      code: "ENOENT",
    });
  } finally {
    globalThis.fetch = original;
  }
});
it("does not consult an existing start marker and scores only complete dev cohorts", async () => {
  const { root, path, r } = await developmentFixture();
  const marker = join(root, "evals/rounds", r.id, "started.json");
  await writeFile(marker, "registered round already started");
  const directory = await devM3(root, path, "all-cases");
  const report = JSON.parse(await readFile(join(root, directory, "report.json"), "utf8"));
  expect(report).toMatchObject({
    development: true,
    round: { development: true, status: "completed", stopReason: "missing_key" },
    score: { plannedMainCases: 30 },
  });
  expect(report.ledgers).toHaveLength(31);
  expect(await readFile(marker, "utf8")).toBe("registered round already started");
});
it("accepts a new exact round identity and confines it to its registration directory", async () => {
  const { root, r } = await fixtureCopy();
  r.id = "m3-round2-qwen38-medium";
  const path = `evals/rounds/${r.id}/preregistration.json`;
  await mkdir(dirname(join(root, path)), { recursive: true });
  await writeFile(join(root, path), JSON.stringify(r));
  expect((await checkM3(root, path)).modelCalls).toBe(0);
  const museId = "m3-round3-muse-spark-xhigh";
  expect(() =>
    assertRegistrationIdentity(museId, `evals/rounds/${museId}/preregistration.json`),
  ).not.toThrow();
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
  const changedEffort = await implementationManifest(resolve("."), {
    ...r,
    requiredFreezeFiles: [],
    corpus: "evals/m3/corpus.json",
    decoding: { reasoning_effort: "max" },
  });
  const changedCapabilities = await implementationManifest(resolve("."), {
    ...r,
    requiredFreezeFiles: [],
    corpus: "evals/m3/corpus.json",
    provider: {
      ...r.provider,
      capabilities: { contextTokens: 1048576, maxOutputTokens: 131072 },
    },
  });
  expect(() => assertImplementationBinding(manifest, changedEffort)).toThrow("changed after");
  expect(() => assertImplementationBinding(manifest, changedCapabilities)).toThrow("changed after");
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

it("loads an external driver and derives cohort counts without reference-shop case identities", async () => {
  const { root, path, r } = await fixtureCopy();
  const driver = "external-driver.mjs";
  await writeFile(
    join(root, driver),
    'export function startCase(){throw new Error("Unexpected execution");} export const materialize=startCase, independentOracle=startCase, executedProductOracle=startCase;',
  );
  const old = JSON.parse(await readFile(join(root, r.corpus), "utf8"));
  const cases = [
    old.cases.find((row: { group: string }) => row.group === "healthy"),
    old.cases.find((row: { group: string }) => row.group === "bug"),
  ].map((row, index) => ({
    id: `external-${index}`,
    group: row.group,
    expectedFailureKind: row.expectedFailureKind,
    plan: row.plan,
    oracle: "external",
    labels: { healingEligibility: "none" },
  }));
  const bytes = JSON.stringify({
    driver,
    baseFiles: {},
    semanticPatches: {},
    uploadFixture: { content: "", sha256: createHash("sha256").update("").digest("hex") },
    cases,
  });
  await writeFile(join(root, r.corpus), bytes);
  r.frozenFiles[r.corpus] = createHash("sha256").update(bytes).digest("hex");
  r.budget.maxLogicalCommands = cases.length * 2;
  r.budget.maxTransportAttempts = r.budget.maxLogicalCommands * 6;
  await writeFile(join(root, path), JSON.stringify(r));
  expect(await checkM3(root, path)).toMatchObject({
    plannedMainCases: 2,
    supplementalTrials: 0,
    denominators: { safeHealing: 0, causeAccuracy: 1, trueBugOffers: 1, healthy: 1 },
    modelCalls: 0,
    dockerCalls: 0,
  });
  await writeFile(join(root, "missing-driver.mjs"), "export const materialize = 1;");
  await expect(loadCorpusDriver(root, { driver: "missing-driver.mjs" })).rejects.toThrow(
    "missing startCase",
  );
  await expect(loadCorpusDriver(root, { driver: "../outside.mjs" })).rejects.toThrow("Unsafe path");
});

it("maps code-owned layered diagnoses and preserves unsupported-claim uncertainty", () => {
  const analysis = {
    source: "rules",
    modelCallId: null,
    failureKind: "product_bug",
    limitations: [],
    diagnosis: {
      conclusion: { status: "cause_partially_supported" },
      healing: { advice: "not_indicated" },
      nextSteps: [
        {
          source: "rules",
          text: "Inspect the creation response at step create and the read at step read.",
        },
      ],
    },
  } as unknown as Analysis;
  expect(diagnosticUtility(analysis)).toMatchObject({
    recommendedAction: "inspect_persistence",
    conclusion: { status: "cause_partially_supported", failureKind: "product_bug" },
    healing: { advice: "not_indicated" },
    nextSteps: { count: 1, sources: ["rules"] },
    unsupportedClaims: 0,
  });
  const model = { ...analysis, source: "model" as const, modelCallId: "call" };
  expect(diagnosticUtility(model).unsupportedClaims).toBeUndefined();
  expect(
    diagnosticUtility({
      ...model,
      limitations: ["2 model hypotheses without execution observation support were not recorded."],
    }).unsupportedClaims,
  ).toBe(2);
  expect(
    diagnosticUtility({
      ...analysis,
      diagnosis: { ...analysis.diagnosis!, conclusion: { status: "no_failure", text: "Passed" } },
    }).recommendedAction,
  ).toBe("no_action");
  expect(() => diagnosticUtility({ ...analysis, diagnosis: undefined })).toThrow(
    "Layered diagnosis unavailable",
  );
  const database = { all: () => [{ data_json: JSON.stringify({ progress: {} }) }] };
  const app = { database, context: { workspaceId: "workspace" } } as unknown as Application;
  expect(unsupportedClaimsForRun(app, "run")).toBeUndefined();
  database.all = () => [{ data_json: JSON.stringify({ progress: { unsupportedClaims: 3 } }) }];
  expect(unsupportedClaimsForRun(app, "run")).toBe(3);
});

it("replays manual candidates on a disposable copy without approving or promoting them", async () => {
  const workspace = await mkdtemp(join(tmpdir(), "tm-m3-manual-test-"));
  temporary.push(workspace);
  await mkdir(join(workspace, "repo"));
  await mkdir(join(workspace, "home"));
  await writeFile(join(workspace, "repo", "sentinel"), "original");
  const plan = scaffoldPlan("backend");
  const assertionId = plan.steps.find((step) => step.kind === "assertion")!.id;
  const proposal = { id: "proposal", candidateRevisionId: "candidate" } as HealingProposal;
  let count = 0;
  const admits: Record<string, unknown>[] = [];
  const copied = {
    tests: { get: () => ({ activeRevisionId: "base" }) },
    healing: { get: () => proposal },
    revisions: { get: () => ({ plan }) },
    runs: {
      admit: async (input: Record<string, unknown>) => {
        admits.push(input);
        return { runId: `run-${++count}` };
      },
      get: (id: string) => ({
        id,
        revisionId: "candidate",
        outcome: id === "run-1" ? "passed" : "failed",
        gate: id === "run-1" ? "passed" : "failed",
        environmentRevisionId: "environment",
        matrixCell: { seed: 17, healingPolicy: "off", admissionSnapshot: {} },
      }),
      steps: (id: string) => [
        { planStepId: assertionId, status: id === "run-1" ? "passed" : "failed" },
      ],
      events: () => [],
    },
    worker: { run: async () => undefined },
    database: { get: () => ({ n: 0 }) },
    context: { workspaceId: "workspace" },
    close: vi.fn(),
  } as unknown as Application;
  const opened = vi.spyOn(Application, "open").mockResolvedValue(copied);
  const checkpoint = vi.fn();
  const source = { database: { all: checkpoint } } as unknown as Application;
  const targets: string[] = [];
  const driver = {
    startCase: async (_root: string, _corpus: unknown, _case: unknown, side: string) => {
      targets.push(side);
      return {
        url: "http://127.0.0.1:1",
        dbPath: "",
        materialized: { directory: "", digests: {}, transformationHash: "" },
        close: async () => undefined,
      };
    },
    independentOracle: async () => ({
      healthy: targets.at(-1) === "transformed",
      defective: targets.at(-1) === "semantic",
      observed: null,
    }),
  } as unknown as FixtureDriver;
  const corpus = {
    baseFiles: {},
    semanticPatches: {},
    cases: [],
    uploadFixture: { content: "", sha256: "" },
  };
  const item = {
    id: "external-drift",
    group: "drift" as const,
    expectedFailureKind: "test_fragility" as const,
    plan,
    oracle: "external",
    semanticNegative: "negative",
  };
  const result = await assessAssistedCandidate(
    source,
    workspace,
    workspace,
    corpus,
    item,
    driver,
    proposal,
    "test",
    "environment",
    plan,
    1,
    "",
  );
  expect(result.proof).toMatchObject({
    positiveDrift: true,
    negativeSemantic: true,
    isolated: true,
    assertionsPreserved: true,
    promoted: false,
    candidateRevisionId: "candidate",
    positiveRunId: "run-1",
    negativeRunId: "run-2",
  });
  expect(admits).toEqual([
    expect.objectContaining({ revisionId: "candidate", healingPolicy: "off" }),
    expect.objectContaining({ revisionId: "candidate", healingPolicy: "off" }),
  ]);
  const copy = opened.mock.calls[0]![0]!.cwd!;
  expect(copy).not.toBe(join(workspace, "repo"));
  await expect(readFile(join(copy, "sentinel"))).rejects.toMatchObject({ code: "ENOENT" });
  expect(await readFile(join(workspace, "repo", "sentinel"), "utf8")).toBe("original");
});
