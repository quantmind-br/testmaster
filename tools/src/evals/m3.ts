import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readdir, readFile, rename, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { Application, entity } from "@testmaster/application";
import type { Analysis, ExecutablePlan, HealingProposal, Requirement } from "@testmaster/contracts";
import { defaults, reasoningEfforts, validate } from "@testmaster/contracts";
import { canonicalJson, semanticHash, uuidV7IdGenerator } from "@testmaster/domain";
import { assertionsHash } from "@testmaster/planner";
import type { FixtureControls, FixtureDriver } from "../../../evals/m3/fixture.mjs";
import * as referenceShopDriver from "../../../evals/m3/fixture.mjs";
import { assertFrozenFiles, assertRegistrationUnchanged, committedRegistration } from "./freeze.js";
import { checkHoldout, loadHoldout, sealHoldout } from "./holdout.js";
import type { M3Ledger, PlannedCase, UtilityObservation } from "./m3-scoring.js";
import { emptyLedger, plannedCases, scoreM3 } from "./m3-scoring.js";
import { replayM3, withRetainedCopy } from "./replay.js";
import { checkUserTasks } from "./user-tasks.js";

interface Patch {
  file: string;
  before: string;
  after: string;
}
interface Case extends PlannedCase {
  mutant?: string;
  patches?: Patch[];
  baselinePatches?: Patch[];
  baselineDigests?: Record<string, string>;
  semanticDigests?: Record<string, string>;
  transformationSourceDigest?: string;
  resultDigests?: Record<string, string>;
  semanticNegative?: string;
  oracle: string;
  plan: ExecutablePlan;
  healthyPlan?: ExecutablePlan;
  authoredPlanLabel?: string;
  expectedFailingStepIds?: string[];
  controls?: FixtureControls;
  variant?: unknown;
}
interface Corpus {
  driver?: string;
  baseFiles: Record<string, string>;
  semanticPatches: Record<string, Patch[]>;
  cases: Case[];
  uploadFixture: { content: string; sha256: string };
}
interface Shop {
  url: string;
  dbPath: string;
  close(): Promise<void>;
  materialized: { directory: string; digests: Record<string, string>; transformationHash: string };
}
export interface M3Registration {
  id: string;
  status: string;
  corpus: string;
  frozenFiles: Record<string, string>;
  requiredFreezeFiles: string[];
  provider: {
    id: string;
    kind: string;
    baseUrl: string;
    apiKeyEnv: string;
    model: string;
    capabilities?: { contextTokens: number; maxOutputTokens: number };
  };
  decoding: { reasoning_effort: string };
  budget: {
    maxTokens: number;
    maxWallTimeMs: number;
    commandDeadlineMs: number;
    maxLogicalCommands: number;
    maxTransportAttempts: number;
    outputReservation: number;
    maxInputTokens: number;
  };
  readiness: {
    controlsPath: string | null;
    controlsHash: string | null;
    policyProbesPath?: string | null;
    policyProbesHash?: string | null;
    implementationHash?: string;
    implementationFrozen: boolean;
  };
}
export async function loadCorpusDriver(
  root: string,
  corpus: { driver?: string },
): Promise<FixtureDriver> {
  if (corpus.driver === undefined) return referenceShopDriver;
  // Drivers are runtime-selected by the sealed corpus, not known at author time.
  const path = corpus.driver ?? "evals/m3/fixture.mjs";
  const driver = (await import(pathToFileURL(confined(root, path)).href)) as FixtureDriver;
  for (const name of [
    "startCase",
    "materialize",
    "independentOracle",
    "executedProductOracle",
  ] as const)
    if (typeof driver[name] !== "function") throw new Error(`Corpus driver is missing ${name}`);
  return driver;
}
function caseControls(driver: FixtureDriver, item: Case): FixtureControls {
  return item.controls ?? driver.caseControls?.(item) ?? {};
}
export async function loadM3Corpus(root: string, path: string): Promise<Corpus> {
  const input = JSON.parse(await readFile(confined(root, path), "utf8"));
  if (Array.isArray(input.families)) {
    const holdout = await loadHoldout(root, path);
    return {
      driver: holdout.manifest.driver,
      baseFiles: {},
      semanticPatches: {},
      uploadFixture: { content: "", sha256: hash("") },
      cases: holdout.cases.map(({ semanticNegative, ...item }) => ({
        ...item,
        ...(semanticNegative === undefined ? {} : { semanticNegative }),
      })),
    };
  }
  return input as Corpus;
}
interface Round {
  registrationId: string;
  registrationHash: string;
  commit: string;
  directory: string;
  startedAt: string;
  status: "started" | "settled" | "completed";
  chargedTokens: number;
  logicalCommands: number;
  transportAttempts: number;
  consecutiveTransportFailures: number;
  stopReason: string | null;
  pending: { caseId: string; reservation: number } | null;
  development?: true;
  planned?: PlannedCase[];
}
const hash = (value: string | Uint8Array) => createHash("sha256").update(value).digest("hex");
/**
 * Retained error evidence: a hash of the raw message plus bounded diagnostic text with every
 * forbidden value (provider key, canary) removed, so failures stay diagnosable without leaks.
 */
function errorRecord(error: unknown, forbidden: readonly string[]) {
  const raw = String(error);
  const code =
    error && typeof error === "object" && "code" in error && typeof error.code === "string"
      ? `${error.code}: `
      : "";
  let detail = `${code}${error instanceof Error ? error.message : raw}`;
  for (const value of forbidden) if (value) detail = detail.replaceAll(value, "[REDACTED]");
  return { messageHash: hash(raw), detail: detail.slice(0, 500) };
}
function confined(root: string, path: string) {
  const rel = relative(resolve(root), resolve(root, path));
  if (isAbsolute(path) || rel === ".." || rel.startsWith("../"))
    throw new Error(`Unsafe path: ${path}`);
  return resolve(root, path);
}
async function atomic(path: string, value: unknown) {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const temp = `${path}.${randomUUID()}.tmp`;
  await writeFile(temp, JSON.stringify(value, null, 2) + "\n", { mode: 0o600 });
  await rename(temp, path);
}
export function applyExactPatches(source: string, patches: Patch[], file: string) {
  for (const patch of patches.filter((row) => row.file === file)) {
    if (!patch.before || source.split(patch.before).length !== 2)
      throw new Error(`Exact patch context absent or ambiguous: ${file}`);
    source = source.replace(patch.before, patch.after);
  }
  return source;
}
export function assertRegistrationIdentity(id: string, path: string) {
  if (
    !/^m3-round[1-9][0-9]*-[a-z0-9]+(?:-[a-z0-9]+)*$/.test(id) ||
    path !== `evals/rounds/${id}/preregistration.json`
  )
    throw new Error("Invalid M3 registration identity/path");
}
export async function claimStart(root: string, id: string) {
  assertRegistrationIdentity(id, `evals/rounds/${id}/preregistration.json`);
  await assertNotStarted(root, id);
  await writeFile(
    join(root, "evals/rounds", id, "started.json"),
    JSON.stringify({ id, startedAt: new Date().toISOString() }),
    { flag: "wx", mode: 0o600 },
  );
}
export function compareProtectedAssertions(
  baseRevisionId: string,
  base: ExecutablePlan,
  candidateRevisionId: string,
  candidate: ExecutablePlan,
) {
  const baseHash = assertionsHash(base),
    candidateHash = assertionsHash(candidate);
  return {
    baseRevisionId,
    candidateRevisionId,
    baseHash,
    candidateHash,
    preserved: baseHash === candidateHash,
  };
}
export function healingRefusal(error: unknown, forbidden: readonly string[]) {
  if (
    !error ||
    typeof error !== "object" ||
    !("code" in error) ||
    error.code !== "PRECONDITION_FAILED"
  )
    throw error;
  const details =
    "details" in error && error.details && typeof error.details === "object"
      ? (error.details as Record<string, unknown>)
      : {};
  const reason = typeof details.reason === "string" ? details.reason : "unspecified_precondition";
  const record: Record<string, unknown> = {
    code: error.code,
    reason,
    ...errorRecord(error, forbidden),
  };
  for (const key of ["detail", "jobId", "modelCallId"])
    if (typeof details[key] === "string") {
      let value = details[key] as string;
      for (const secret of forbidden) if (secret) value = value.replaceAll(secret, "[REDACTED]");
      record[key] = value.slice(0, 500);
    }
  return {
    record,
    modelAbstained: reason === "model_abstained",
    failed:
      reason === "model_failure" ||
      ![
        "not_failed",
        "code_revision",
        "no_regeneration",
        "semantic_failure",
        "provider_unavailable",
        "consent_required",
        "evidence_unavailable",
        "model_abstained",
      ].includes(reason),
  };
}
export async function assertNotStarted(root: string, id: string) {
  const marker = await readFile(join(root, "evals/rounds", id, "started.json")).catch(
    (error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return null;
      throw error;
    },
  );
  if (marker)
    throw new Error("Registration already started; settle retained ledgers without new paid calls");
  const entries = await readdir(join(root, "evals/results"), { withFileTypes: true }).catch(
    (error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return [];
      throw error;
    },
  );
  if (entries.some((entry) => entry.isDirectory() && entry.name.startsWith(`${id}-`)))
    throw new Error("Registration already started; settle retained ledgers without new paid calls");
}
function validateMeasurementInputs(registration: M3Registration, corpus: Corpus) {
  const provider = registration.provider;
  const decoding = registration.decoding;
  if (
    !provider ||
    provider.kind !== "openai-compatible" ||
    [provider.id, provider.model, provider.apiKeyEnv].some(
      (value) => typeof value !== "string" || !value.trim(),
    ) ||
    !/^[A-Za-z_][A-Za-z0-9_]*$/.test(provider.apiKeyEnv) ||
    typeof provider.baseUrl !== "string" ||
    !URL.canParse(provider.baseUrl) ||
    !["http:", "https:"].includes(new URL(provider.baseUrl).protocol) ||
    !decoding ||
    Object.keys(decoding).length !== 1 ||
    !reasoningEfforts.some((effort) => effort === decoding.reasoning_effort)
  )
    throw new Error("Invalid provider or generation controls");
  if (
    provider.capabilities !== undefined &&
    (!provider.capabilities ||
      ![provider.capabilities.contextTokens, provider.capabilities.maxOutputTokens].every(
        (value) => Number.isSafeInteger(value) && value > 0,
      ))
  )
    throw new Error("Invalid provider capabilities");
  const budget = registration.budget;
  if (
    !budget ||
    ![
      budget.maxTokens,
      budget.maxWallTimeMs,
      budget.commandDeadlineMs,
      budget.maxLogicalCommands,
      budget.maxTransportAttempts,
      budget.outputReservation,
      budget.maxInputTokens,
    ].every((value) => Number.isSafeInteger(value) && value > 0)
  )
    throw new Error("Invalid round budget");
  if (
    !corpus ||
    !Array.isArray(corpus.cases) ||
    corpus.cases.length === 0 ||
    new Set(corpus.cases.map((row) => row.id)).size !== corpus.cases.length ||
    !corpus.baseFiles ||
    !corpus.semanticPatches ||
    typeof corpus.uploadFixture?.content !== "string" ||
    (corpus.driver !== undefined && (typeof corpus.driver !== "string" || !corpus.driver)) ||
    hash(corpus.uploadFixture.content) !== corpus.uploadFixture.sha256
  )
    throw new Error("Invalid M3 corpus");
  for (const item of corpus.cases) {
    if (
      !item ||
      typeof item.id !== "string" ||
      !/^[a-z0-9][a-z0-9-]*$/.test(item.id) ||
      !["healthy", "bug", "drift", "env", "adversarial", "integration"].includes(item.group) ||
      ![
        "product_bug",
        "contract_violation",
        "test_fragility",
        "environment",
        "security_policy",
        "unknown",
      ].includes(item.expectedFailureKind) ||
      ((item.labels?.healingEligibility ?? "automatic") !== "none" &&
        typeof item.semanticNegative !== "string") ||
      typeof item.oracle !== "string" ||
      (item.expectedFailingStepIds !== undefined && !Array.isArray(item.expectedFailingStepIds)) ||
      item.plan?.kind !== "executable" ||
      !Array.isArray(item.plan.steps) ||
      (item.healthyPlan !== undefined &&
        (item.healthyPlan.kind !== "executable" || !Array.isArray(item.healthyPlan.steps))) ||
      ![item.patches, item.baselinePatches].every(
        (patches) =>
          patches === undefined ||
          (Array.isArray(patches) &&
            patches.every(
              (patch) =>
                typeof patch.file === "string" &&
                typeof patch.before === "string" &&
                typeof patch.after === "string",
            )),
      )
    )
      throw new Error(`Invalid corpus case: ${item.id}`);
  }
}
// Models the operator has approved for registered rounds.
const approvedModels = ["qwen3.8-flash", "muse-spark-1.3"];
export async function checkM3(root: string, registrationPath: string) {
  const registration = JSON.parse(
    await readFile(confined(root, registrationPath), "utf8"),
  ) as M3Registration;
  const corpus = await loadM3Corpus(root, registration.corpus);
  validateMeasurementInputs(registration, corpus);
  assertRegistrationIdentity(registration.id, registrationPath);
  if (registration.status !== "preregistered-not-executed")
    throw new Error("Invalid M3 registration status");
  await assertNotStarted(root, registration.id);
  if (
    Object.keys(registration.decoding).length !== 1 ||
    !reasoningEfforts.some((effort) => effort === registration.decoding.reasoning_effort) ||
    registration.provider.baseUrl !== "https://api.quantforge.com.br/v1" ||
    registration.provider.apiKeyEnv !== "QUANTFORGE_API_KEY" ||
    !approvedModels.some((model) => model === registration.provider.model) ||
    registration.provider.id !== "quantforge" ||
    registration.provider.kind !== "openai-compatible"
  )
    throw new Error("Unapproved provider or generation controls");
  const b = registration.budget;
  if (
    b.maxTokens !== 10000000 ||
    b.maxWallTimeMs !== 7200000 ||
    b.commandDeadlineMs !== 180000 ||
    b.maxLogicalCommands !==
      corpus.cases.filter((row) => row.group !== "integration").length * 2 +
        corpus.cases.filter((row) => row.group === "integration").length ||
    b.maxTransportAttempts !== b.maxLogicalCommands * 6 ||
    b.outputReservation !== 8192 ||
    b.maxInputTokens !== 100000
  )
    throw new Error("Unapproved round budget");
  const driver = await loadCorpusDriver(root, corpus);
  await assertFrozenFiles(root, corpus.baseFiles);
  await assertFrozenFiles(root, registration.frozenFiles);
  for (const item of corpus.cases) {
    if (
      (corpus.driver === undefined || corpus.driver === "evals/m3/fixture.mjs") &&
      item.authoredPlanLabel !== "approved-preregistered-fixture-not-model-generated"
    )
      throw new Error("Authored fixture provenance missing");
    await driver.validateCase?.(root, corpus, item);
    if (item.group === "drift" && (!item.semanticNegative || item.semanticNegative === "healthy"))
      throw new Error("Missing semantic negative");
  }
  if (hash(corpus.uploadFixture.content) !== corpus.uploadFixture.sha256)
    throw new Error("Upload fixture hash mismatch");
  return {
    plannedMainCases: corpus.cases.filter((row) => row.group !== "integration").length,
    supplementalTrials: corpus.cases.filter((row) => row.group === "integration").length,
    modelCalls: 0,
    dockerCalls: 0,
    denominators: {
      safeHealing: corpus.cases.filter((row) => row.group === "drift").length,
      causeAccuracy: corpus.cases.filter((row) => !["healthy", "integration"].includes(row.group))
        .length,
      trueBugOffers: corpus.cases.filter(
        (row) =>
          row.group === "bug" ||
          (row.expectedFailureKind === "product_bug" && row.group !== "integration"),
      ).length,
      healthy: corpus.cases.filter((row) => row.group === "healthy").length,
    },
    readyForLive:
      registration.readiness.implementationFrozen &&
      registration.readiness.controlsPath !== null &&
      Boolean(registration.readiness.policyProbesPath),
    maximumLocalAdmissionProjection:
      b.maxLogicalCommands * 6 * (b.maxInputTokens + b.outputReservation),
    remoteBilledSpendHardBound: false,
  };
}
interface ControlRun {
  runId: string;
  revisionId: string;
  outcome: string | null;
  gate: string;
  steps: { id: string; status: string; reasonCode: string | null; errorCode?: string | null }[];
  reasonCodes: string[];
  snapshotCount: number;
  imageIds: string[];
  planHash: string;
  seed: number;
  healingPolicy: string;
  environmentRevisionId: string;
  admissionHash: string;
}
interface ControlEvidence {
  id: string;
  status: "passed" | "blocked";
  healthy: ControlRun | null;
  transformed: ControlRun | null;
  candidateDrift?: ControlRun;
  semantic: ControlRun | null;
  healthyOracle: { healthy: boolean; defective: boolean; observed: unknown } | null;
  transformedOracle: { healthy: boolean; defective: boolean; observed: unknown } | null;
  semanticOracle: { healthy: boolean; defective: boolean; observed: unknown } | null;
  boundPlan: ExecutablePlan | null;
  semanticPlan: ExecutablePlan | null;
  uploadArtifactId: string | null;
  modelCalls: number;
  errors: { messageHash: string; detail: string }[];
}
interface ControlsManifest {
  schemaVersion: string;
  registrationId: string;
  corpusHash: string;
  implementation: { files: Record<string, string>; hash: string };
  modelCalls: number;
  providerGuard: { requests: number; positiveControlRequests: number };
  cases: { id: string; status: string; path: string; sha256: string }[];
}
function captureControl(app: Application, runId: string, plan: ExecutablePlan): ControlRun {
  const run = app.runs.get(runId);
  const snapshot = (run.matrixCell as Record<string, unknown>).admissionSnapshot as {
    images?: Record<string, { imageId?: string }>;
  };
  return {
    runId,
    revisionId: run.revisionId,
    outcome: run.outcome,
    gate: run.gate,
    steps: app.runs.steps(runId).map((row) => ({
      id: String(row.planStepId),
      status: String(row.status),
      reasonCode: row.reasonCode ? String(row.reasonCode) : null,
      errorCode: (row.error as { code?: string } | null)?.code ?? null,
    })),
    reasonCodes: app.runs.events(runId).flatMap((row) => {
      const payload = row.payload as Record<string, unknown>;
      return typeof payload.reasonCode === "string" ? [payload.reasonCode] : [];
    }),
    snapshotCount: Number(
      app.database.get<{ n: number }>(
        "SELECT COUNT(*) AS n FROM snapshots WHERE workspace_id=? AND run_id=?",
        app.context.workspaceId,
        runId,
      )?.n ?? 0,
    ),
    imageIds: Object.values(snapshot?.images ?? {})
      .map((row) => row.imageId ?? "")
      .filter(Boolean),
    planHash: hash(JSON.stringify(plan)),
    seed: Number((run.matrixCell as Record<string, unknown>).seed),
    healingPolicy: String((run.matrixCell as Record<string, unknown>).healingPolicy),
    environmentRevisionId: run.environmentRevisionId,
    admissionHash: semanticHash(
      Object.fromEntries(
        Object.entries(
          (run.matrixCell as Record<string, unknown>).admissionSnapshot as Record<string, unknown>,
        ).filter(([key]) => key !== "inputHash"),
      ),
    ),
  };
}
function assessControl(item: Case, e: ControlEvidence) {
  const failures = (run: ControlRun | null) =>
    run?.steps.filter((step) => step.status === "failed") ?? [];
  if (
    !e.healthy ||
    e.healthy.outcome !== "passed" ||
    e.healthy.gate !== "passed" ||
    !e.healthyOracle?.healthy ||
    !e.boundPlan ||
    e.modelCalls !== 0
  )
    return false;
  if (
    !e.transformed ||
    !e.transformed.imageIds.length ||
    (item.expectedFailingStepIds?.length &&
      !failures(e.transformed).some((step) => item.expectedFailingStepIds!.includes(step.id)))
  )
    return false;
  if (
    item.controls?.semanticCandidate &&
    (e.candidateDrift?.outcome !== "passed" || e.candidateDrift.gate !== "passed")
  )
    return false;
  if (item.group === "healthy")
    return (
      e.transformed.outcome === "passed" &&
      e.transformed.gate === "passed" &&
      e.transformedOracle?.healthy === true
    );
  if (item.controls?.missingCredential)
    return (
      ["blocked", "inconclusive"].includes(e.transformed.outcome ?? "") &&
      e.transformed.reasonCodes
        .concat(e.transformed.steps.flatMap((step) => (step.reasonCode ? [step.reasonCode] : [])))
        .some((code) => /credential|secret|security_precondition/.test(code))
    );
  if (item.controls?.unavailableTarget)
    return (
      e.transformed.outcome !== "passed" &&
      e.transformed.steps.some((step) =>
        ["ECONNREFUSED", "ENOTFOUND", "EHOSTUNREACH", "ENETUNREACH"].includes(step.errorCode ?? ""),
      )
    );
  if (item.controls?.collectionFailure)
    return (
      failures(e.transformed).some((step) =>
        e.boundPlan!.steps.some(
          (original) => original.id === step.id && original.kind === "assertion",
        ),
      ) &&
      e.transformed.reasonCodes.includes("artifact_limit_exceeded") &&
      e.transformed.snapshotCount === 0
    );
  if (item.controls?.semanticCandidate)
    return (
      failures(e.transformed).some((step) =>
        e.boundPlan!.steps.some(
          (original) => original.id === step.id && original.kind === "action",
        ),
      ) &&
      e.transformedOracle?.healthy === true &&
      e.semantic?.outcome === "failed" &&
      failures(e.semantic).some((step) =>
        e.semanticPlan!.steps.some(
          (original) => original.id === step.id && original.kind === "assertion",
        ),
      ) &&
      e.semanticOracle?.defective === true &&
      e.semanticPlan !== null &&
      assertionsHash(e.boundPlan) === assertionsHash(e.semanticPlan)
    );
  return (
    e.transformed.outcome === "failed" &&
    failures(e.transformed).some((step) =>
      e.boundPlan!.steps.some(
        (original) => original.id === step.id && original.kind === "assertion",
      ),
    ) &&
    e.transformedOracle?.defective === true
  );
}
const freezeTrees = [
  "packages/contracts/src",
  "packages/contracts/schemas",
  "packages/persistence/migrations",
  "packages/runner/src",
  "packages/model-gateway/src",
];
const freezeInputs = [
  "packages/application/src/ai/analysis.ts",
  "packages/application/src/ai/discovery.ts",
  "packages/application/src/ai/healing.ts",
  "packages/application/src/ai/healing-patch.ts",
  "packages/application/src/ai/model.ts",
  "packages/application/src/ai/usage.ts",
  "packages/application/src/runs.ts",
  "packages/application/src/provenance.ts",
  "packages/application/src/worker.ts",
  "packages/planner/src/agent/index.ts",
  "packages/planner/src/agent/locator-evidence.ts",
  "tools/src/evals/m3.ts",
  "tools/src/evals/replay.ts",
  "tools/src/evals/holdout.ts",
  "tools/src/evals/user-tasks.ts",
  "tools/src/evals/m3-scoring.ts",
  "tools/src/evals/freeze.ts",
  "pnpm-lock.yaml",
  "containers/images.lock.json",
  "containers/seccomp_profile.json",
  "evals/m3/fixture.mjs",
  "evals/m3/fixture.d.mts",
  "evals/m3/integration-requirement.txt",
  "fixtures/reference-shop/oracle/index.js",
  "fixtures/reference-shop/src/index.js",
  "fixtures/reference-shop/src/server.js",
  "fixtures/reference-shop/src/shop.html",
];
export async function implementationManifest(root: string, r: M3Registration) {
  const paths = new Set([...r.requiredFreezeFiles, ...freezeInputs, r.corpus]);
  const corpusInput = JSON.parse(await readFile(confined(root, r.corpus), "utf8"));
  if (corpusInput.driver) paths.add(corpusInput.driver);
  for (const input of corpusInput.inputs ?? []) paths.add(input);
  const visit = async (path: string): Promise<void> => {
    for (const entry of await readdir(confined(root, path), { withFileTypes: true })) {
      const child = `${path}/${entry.name}`;
      if (entry.isDirectory()) await visit(child);
      else if (entry.isFile()) paths.add(child);
      else throw new Error(`Unsupported frozen input: ${child}`);
    }
  };
  for (const tree of freezeTrees) await visit(tree);
  const files: Record<string, string> = {};
  for (const path of [...paths].sort()) files[path] = hash(await readFile(confined(root, path)));
  return {
    files,
    hash: hash(
      canonicalJson({
        files,
        provider: r.provider,
        decoding: r.decoding,
        budget: r.budget,
        seed: 17,
        healingPolicy: "apply",
      }),
    ),
  };
}
export function assertImplementationBinding(
  expected: { files: Record<string, string>; hash: string },
  observed: { files: Record<string, string>; hash: string } | undefined,
) {
  if (!observed || canonicalJson(expected) !== canonicalJson(observed))
    throw new Error("Implementation/input manifest changed after deterministic controls");
}
export async function controlsM3(root: string, path: string, outDir: string) {
  await checkM3(root, path);
  const r = JSON.parse(await readFile(confined(root, path), "utf8")) as M3Registration;
  const corpus = await loadM3Corpus(root, r.corpus);
  const fixture = await loadCorpusDriver(root, corpus);
  const output = confined(root, outDir);
  await mkdir(output, { recursive: false, mode: 0o700 });
  let requests = 0;
  const guard = createServer((_req, res) => {
    requests++;
    res.writeHead(503, { "content-type": "application/json" });
    res.end('{"error":"MODEL_REQUEST_FORBIDDEN_IN_CONTROLS"}');
  });
  await new Promise<void>((accept, reject) => {
    guard.once("error", reject);
    guard.listen(0, "127.0.0.1", accept);
  });
  const address = guard.address();
  if (!address || typeof address === "string") throw new Error("Provider guard failed to bind");
  const guardUrl = `http://127.0.0.1:${address.port}`;
  const originalFetch = globalThis.fetch;
  await originalFetch(`${guardUrl}/positive-control`);
  const positive = requests;
  requests = 0;
  globalThis.fetch = ((input, init) => {
    const url = new URL(
      typeof input === "string" ? input : input instanceof URL ? input.href : input.url,
    );
    if (url.origin === new URL(r.provider.baseUrl).origin || url.origin === guardUrl) {
      requests++;
      throw new Error("MODEL_REQUEST_FORBIDDEN_IN_CONTROLS");
    }
    return originalFetch(input, init);
  }) as typeof fetch;
  const manifest: ControlsManifest = {
    schemaVersion: "1.0.0",
    registrationId: r.id,
    corpusHash: hash(await readFile(confined(root, r.corpus))),
    implementation: await implementationManifest(root, r),
    modelCalls: 0,
    providerGuard: { requests: 0, positiveControlRequests: positive },
    cases: [],
  };
  try {
    for (const item of corpus.cases) {
      item.controls = caseControls(fixture, item);
      const e: ControlEvidence = {
        id: item.id,
        status: "blocked",
        healthy: null,
        transformed: null,
        semantic: null,
        healthyOracle: null,
        transformedOracle: null,
        semanticOracle: null,
        boundPlan: null,
        semanticPlan: null,
        uploadArtifactId: null,
        modelCalls: 0,
        errors: [],
      };
      let app: Application | undefined;
      let shop: Shop | undefined;
      try {
        shop = await fixture.startCase(root, corpus, item, "healthy");
        const port = Number(new URL(shop.url).port);
        const s = await setup(
          root,
          item,
          shop.url,
          { ...r, provider: { ...r.provider, baseUrl: guardUrl } },
          true,
        );
        app = s.app;
        let plan = structuredClone(item.plan);
        let bytes = JSON.stringify(plan);
        if (bytes.includes("@UPLOAD_ARTIFACT@")) {
          e.uploadArtifactId = await bindUploadFixture(
            app,
            s.projectId,
            corpus.uploadFixture.content,
          );
          bytes = bytes.replaceAll("@UPLOAD_ARTIFACT@", e.uploadArtifactId);
        }
        const credential = bytes.includes("@MISSING_CREDENTIAL@")
          ? await bindMissingCredential(app, new URL(shop.url).origin)
          : null;
        if (credential) bytes = bytes.replaceAll("@MISSING_CREDENTIAL@", credential.id);
        plan = validate<ExecutablePlan>("ExecutablePlan", JSON.parse(bytes));
        e.boundPlan = plan;
        const test = app.tests.create({ projectId: s.projectId, plan });
        const hp = item.healthyPlan ?? plan;
        const ht = item.healthyPlan ? app.tests.create({ projectId: s.projectId, plan: hp }) : test;
        const healthy = await replay(app, ht.id, s.environmentId, "off", ht.activeRevisionId!);
        e.healthy = captureControl(app, healthy.id, hp);
        for (const side of ["healthy", "transformed"] as const) {
          const oracle = await fixture.startCase(root, corpus, item, side);
          try {
            const verdict = await fixture.independentOracle(oracle, item.oracle);
            if (side === "healthy") e.healthyOracle = verdict;
            else e.transformedOracle = verdict;
          } finally {
            await oracle.close();
          }
        }
        await shop.close();
        shop = await fixture.startCase(root, corpus, item, "transformed", port);
        if (item.controls?.unavailableTarget) await shop.close();
        const transformed = await replay(
          app,
          test.id,
          s.environmentId,
          "off",
          test.activeRevisionId!,
          item.controls?.collectionFailure ? bindCollectionFailure().limits : undefined,
          credential?.remove,
        );
        e.transformed = captureControl(app, transformed.id, plan);
        if (item.controls?.semanticCandidate) {
          if (!fixture.authoredCandidate)
            throw new Error("Driver semantic controls require an authoredCandidate hook");
          const candidate = fixture.authoredCandidate(item, plan);
          e.semanticPlan = candidate;
          const revision = app.revisions.create(test.id, candidate);
          await shop.close();
          shop = await fixture.startCase(root, corpus, item, "transformed", port);
          const driftPass = await replay(app, test.id, s.environmentId, "off", revision.id);
          e.candidateDrift = captureControl(app, driftPass.id, candidate);
          await shop.close();
          shop = await fixture.startCase(root, corpus, item, "semantic", port);
          const semantic = await replay(app, test.id, s.environmentId, "off", revision.id);
          e.semantic = captureControl(app, semantic.id, candidate);
          const oracle = await fixture.startCase(root, corpus, item, "semantic");
          try {
            e.semanticOracle = await fixture.independentOracle(oracle, item.oracle);
          } finally {
            await oracle.close();
          }
        }
        e.status = assessControl(item, e) ? "passed" : "blocked";
      } catch (error) {
        e.errors.push(errorRecord(error, [process.env[r.provider.apiKeyEnv] ?? ""]));
      } finally {
        if (app) {
          e.modelCalls = Number(
            app.database.get<{ n: number }>(
              "SELECT COUNT(*) AS n FROM model_calls WHERE workspace_id=?",
              app.context.workspaceId,
            )?.n ?? 0,
          );
          manifest.modelCalls += e.modelCalls;
          if (e.modelCalls) e.status = "blocked";
        }
        app?.close();
        await shop?.close();
      }
      const evidencePath = join(outDir, `${item.id}.json`);
      await atomic(confined(root, evidencePath), e);
      manifest.cases.push({
        id: item.id,
        status: e.status,
        path: evidencePath,
        sha256: hash(await readFile(confined(root, evidencePath))),
      });
      manifest.providerGuard.requests = requests;
      await atomic(join(output, "manifest.json"), manifest);
    }
  } finally {
    globalThis.fetch = originalFetch;
    await new Promise<void>((accept, reject) =>
      guard.close((error) => (error ? reject(error) : accept())),
    );
  }
  if (manifest.modelCalls || requests || manifest.cases.some((row) => row.status !== "passed"))
    throw new Error("Pre-freeze controls blocked; retained evidence identifies unsatisfied cases");
  return manifest;
}
interface ControlledHealingOutput {
  kind: "patch";
  patch: {
    changes: { stepId: string; path: string; value: unknown }[];
    evidenceHandles: string[];
    explanation: string;
  };
}
export function controlledHealingOutput(
  base: ExecutablePlan,
  candidate: ExecutablePlan,
): ControlledHealingOutput {
  const changes: ControlledHealingOutput["patch"]["changes"] = [];
  for (const step of base.steps) {
    const after = candidate.steps.find((row) => row.id === step.id)!;
    const beforeInput = step.input as Record<string, unknown>,
      afterInput = after.input as Record<string, unknown>;
    for (const field of ["locator", "source", "destination", "state"])
      if (JSON.stringify(beforeInput[field]) !== JSON.stringify(afterInput[field]))
        changes.push({ stepId: step.id, path: `/input/${field}`, value: afterInput[field] });
    if (
      step.operation === "download" &&
      after.operation === "download" &&
      canonicalJson(step.input.trigger.input.locator) !==
        canonicalJson(after.input.trigger.input.locator)
    )
      changes.push({
        stepId: step.id,
        path: "/input/trigger/input/locator",
        value: after.input.trigger.input.locator,
      });
  }
  if (!changes.length) throw new Error("Authored policy probe has no replacement");
  return {
    kind: "patch",
    patch: {
      changes,
      evidenceHandles: ["E1"],
      explanation:
        "Controlled authored candidate for deterministic policy admission; not model quality.",
    },
  };
}
interface PolicyProbeEvidence {
  id: string;
  status: "passed" | "blocked";
  healthy?: ControlRun;
  transformed?: ControlRun;
  proposal?: HealingProposal;
  refusal?: Record<string, unknown>;
  modelCalls: number;
  errors: { messageHash: string; detail: string }[];
}
export function assessPolicyProbe(evidence: PolicyProbeEvidence) {
  const healthy = evidence.healthy,
    transformed = evidence.transformed;
  if (
    !healthy ||
    !transformed ||
    evidence.errors.length ||
    healthy.outcome !== "passed" ||
    healthy.gate !== "passed" ||
    transformed.outcome !== "failed" ||
    healthy.seed !== 17 ||
    transformed.seed !== 17 ||
    healthy.healingPolicy !== "apply" ||
    transformed.healingPolicy !== "apply" ||
    healthy.revisionId !== transformed.revisionId ||
    healthy.environmentRevisionId !== transformed.environmentRevisionId ||
    healthy.admissionHash !== transformed.admissionHash ||
    !healthy.imageIds.length ||
    canonicalJson(healthy.imageIds) !== canonicalJson(transformed.imageIds)
  )
    return false;
  if (!evidence.proposal)
    return evidence.modelCalls === 0 && evidence.refusal?.reason === "semantic_failure";
  return (
    evidence.modelCalls > 0 &&
    evidence.proposal.failedRunId === transformed.runId &&
    evidence.proposal.baseRevisionId === transformed.revisionId &&
    (evidence.proposal.approvalMode === "policy"
      ? Boolean(evidence.proposal.verificationRunId)
      : evidence.proposal.status === "proposed" && evidence.proposal.limitations.length > 0)
  );
}
interface PolicyProbesManifest {
  label: "deterministic-local-provider-policy-acceptance";
  registrationId: string;
  implementation: { files: Record<string, string>; hash: string };
  remoteRequests: number;
  localRequests: number;
  cases: { id: string; status: string; path: string; sha256: string }[];
}
export async function policyProbesM3(root: string, path: string, outDir: string) {
  await checkM3(root, path);
  const r = JSON.parse(await readFile(confined(root, path), "utf8")) as M3Registration;
  const corpus = await loadM3Corpus(root, r.corpus);
  const fixture = await loadCorpusDriver(root, corpus);
  const output = confined(root, outDir);
  await mkdir(output, { recursive: false, mode: 0o700 });
  const manifest: PolicyProbesManifest = {
    label: "deterministic-local-provider-policy-acceptance",
    registrationId: r.id,
    implementation: await implementationManifest(root, r),
    remoteRequests: 0,
    localRequests: 0,
    cases: [],
  };
  let answer: ControlledHealingOutput | undefined;
  const provider = createServer(async (req, res) => {
    for await (const _chunk of req) {
      /* Drain the client request. */
    }
    manifest.localRequests++;
    res.writeHead(200, { "content-type": "application/json" });
    // The gateway verifies the declared model against the provider inventory before completing.
    if (req.method === "GET" && new URL(req.url ?? "/", "http://local").pathname === "/v1/models") {
      res.end(
        JSON.stringify({ object: "list", data: [{ id: r.provider.model, object: "model" }] }),
      );
      return;
    }
    res.end(
      JSON.stringify({
        id: "controlled-policy-probe",
        choices: [
          {
            message: { role: "assistant", content: JSON.stringify(answer) },
            finish_reason: "stop",
          },
        ],
        usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
      }),
    );
  });
  await new Promise<void>((accept, reject) => {
    provider.once("error", reject);
    provider.listen(0, "127.0.0.1", accept);
  });
  const address = provider.address();
  if (!address || typeof address === "string")
    throw new Error("Local policy provider failed to bind");
  const baseUrl = `http://127.0.0.1:${address.port}/v1`;
  const originalFetch = globalThis.fetch;
  globalThis.fetch = ((input, init) => {
    const url = new URL(
      typeof input === "string" ? input : input instanceof URL ? input.href : input.url,
    );
    if (url.origin === new URL(r.provider.baseUrl).origin) {
      manifest.remoteRequests++;
      throw new Error("REMOTE_PROVIDER_FORBIDDEN_IN_POLICY_PROBES");
    }
    return originalFetch(input, init);
  }) as typeof fetch;
  try {
    for (const item of corpus.cases
      .filter((row) => row.group === "drift")
      .sort((a, b) => a.id.localeCompare(b.id))) {
      const e: PolicyProbeEvidence = { id: item.id, status: "blocked", modelCalls: 0, errors: [] };
      let app: Application | undefined, shop: Shop | undefined;
      try {
        shop = await fixture.startCase(root, corpus, item, "healthy");
        const port = Number(new URL(shop.url).port);
        const s = await setup(
          root,
          item,
          shop.url,
          { ...r, provider: { ...r.provider, baseUrl } },
          false,
          true,
        );
        app = s.app;
        let bytes = JSON.stringify(item.plan);
        if (bytes.includes("@UPLOAD_ARTIFACT@"))
          bytes = bytes.replaceAll(
            "@UPLOAD_ARTIFACT@",
            await bindUploadFixture(app, s.projectId, corpus.uploadFixture.content),
          );
        const test = app.tests.create({ projectId: s.projectId, plan: JSON.parse(bytes) });
        const base = app.revisions.get(test.activeRevisionId!).plan!;
        const healthy = await replay(
          app,
          test.id,
          s.environmentId,
          "apply",
          test.activeRevisionId!,
        );
        e.healthy = captureControl(app, healthy.id, base);
        await shop.close();
        shop = await fixture.startCase(root, corpus, item, "transformed", port);
        const failed = await replay(app, test.id, s.environmentId, "apply", test.activeRevisionId!);
        e.transformed = captureControl(app, failed.id, base);
        if (!fixture.authoredCandidate)
          throw new Error("Driver policy probes require an authoredCandidate hook");
        answer = controlledHealingOutput(base, fixture.authoredCandidate(item, base));
        await app.analysis.analyze(failed.id, { model: false });
        try {
          e.proposal = await app.healing.propose(failed.id, {
            budget: { deadlineMs: r.budget.commandDeadlineMs },
          });
        } catch (error) {
          const refusal = healingRefusal(error, []);
          e.refusal = refusal.record;
          if (refusal.failed || refusal.modelAbstained) throw error;
        }
        e.modelCalls = app.usage.get({ projectId: s.projectId }).calls.length;
        e.status = assessPolicyProbe(e) ? "passed" : "blocked";
      } catch (error) {
        e.errors.push(errorRecord(error, [process.env[r.provider.apiKeyEnv] ?? ""]));
      } finally {
        app?.close();
        await shop?.close();
      }
      const evidencePath = join(outDir, `${item.id}.json`);
      await atomic(confined(root, evidencePath), e);
      manifest.cases.push({
        id: item.id,
        status: e.status,
        path: evidencePath,
        sha256: hash(await readFile(confined(root, evidencePath))),
      });
      await atomic(join(output, "manifest.json"), manifest);
    }
  } finally {
    globalThis.fetch = originalFetch;
    await new Promise<void>((accept, reject) =>
      provider.close((error) => (error ? reject(error) : accept())),
    );
  }
  assertImplementationBinding(await implementationManifest(root, r), manifest.implementation);
  if (
    manifest.remoteRequests ||
    manifest.cases.length !== corpus.cases.filter((row) => row.group === "drift").length ||
    manifest.cases.some((row) => row.status !== "passed")
  )
    throw new Error("Deterministic policy probes blocked; inspect retained evidence");
  return manifest;
}
export async function freezeM3(
  root: string,
  path: string,
  controlsPath: string,
  probesPath?: string,
) {
  await checkM3(root, path);
  const r = JSON.parse(await readFile(confined(root, path), "utf8")) as M3Registration;
  await assertNotStarted(root, r.id);
  const corpus = await loadM3Corpus(root, r.corpus);
  const fixture = await loadCorpusDriver(root, corpus);
  const controls = JSON.parse(
    await readFile(confined(root, controlsPath), "utf8"),
  ) as ControlsManifest;
  if (
    controls.registrationId !== r.id ||
    controls.corpusHash !== hash(await readFile(confined(root, r.corpus))) ||
    controls.modelCalls !== 0 ||
    controls.providerGuard?.requests !== 0 ||
    controls.providerGuard.positiveControlRequests !== 1 ||
    controls.cases?.length !== corpus.cases.length ||
    new Set(controls.cases.map((row) => row.id)).size !== corpus.cases.length
  )
    throw new Error("Invalid evidence-backed controls manifest");
  const implementation = await implementationManifest(root, r);
  assertImplementationBinding(implementation, controls.implementation);
  if (!probesPath) throw new Error("Policy probes are required before freeze");
  const probes = JSON.parse(
    await readFile(confined(root, probesPath), "utf8"),
  ) as PolicyProbesManifest;
  assertImplementationBinding(implementation, probes.implementation);
  if (
    probes.label !== "deterministic-local-provider-policy-acceptance" ||
    probes.registrationId !== r.id ||
    probes.remoteRequests !== 0 ||
    probes.cases.length !== corpus.cases.filter((row) => row.group === "drift").length ||
    new Set(probes.cases.map((row) => row.id)).size !== probes.cases.length
  )
    throw new Error("Invalid policy probes manifest");
  for (const item of corpus.cases.filter((row) => row.group === "drift")) {
    const row = probes.cases.find((row) => row.id === item.id);
    if (!row || row.status !== "passed") throw new Error(`Policy probe blocked: ${item.id}`);
    const bytes = await readFile(confined(root, row.path));
    if (hash(bytes) !== row.sha256)
      throw new Error(`Policy probe evidence hash mismatch: ${item.id}`);
    const evidence = JSON.parse(bytes.toString()) as PolicyProbeEvidence;
    if (evidence.id !== item.id || evidence.status !== "passed" || !assessPolicyProbe(evidence))
      throw new Error(`Policy probe does not prove admission: ${item.id}`);
    r.frozenFiles[row.path] = row.sha256;
  }
  r.frozenFiles[probesPath] = hash(await readFile(confined(root, probesPath)));
  for (const item of corpus.cases) {
    item.controls = caseControls(fixture, item);
    const row = controls.cases.find((value) => value.id === item.id);
    if (!row?.path || !row.sha256 || row.status !== "passed")
      throw new Error(`Pre-freeze control blocked: ${item.id}`);
    const bytes = await readFile(confined(root, row.path));
    if (hash(bytes) !== row.sha256) throw new Error(`Control evidence hash mismatch: ${item.id}`);
    const evidence = JSON.parse(bytes.toString()) as ControlEvidence;
    if (evidence.id !== item.id || !assessControl(item, evidence))
      throw new Error(`Control evidence does not prove required outcomes: ${item.id}`);
    for (const run of [
      evidence.healthy,
      evidence.transformed,
      evidence.semantic,
      evidence.candidateDrift ?? null,
    ].filter((value): value is ControlRun => value !== null)) {
      if (
        !/^run_/.test(run.runId) ||
        !/^rev_/.test(run.revisionId) ||
        !run.planHash ||
        !run.imageIds.length ||
        run.imageIds.some((id) => !/^sha256:[a-f0-9]{64}$/.test(id)) ||
        run.steps.some((step) => !step.id || !step.status)
      )
        throw new Error(`Missing concrete run/step/image identity: ${item.id}`);
    }
    if (
      evidence.transformed!.planHash !== hash(JSON.stringify(evidence.boundPlan)) ||
      (evidence.semantic &&
        evidence.semantic.planHash !== hash(JSON.stringify(evidence.semanticPlan))) ||
      (evidence.candidateDrift &&
        evidence.candidateDrift.planHash !== hash(JSON.stringify(evidence.semanticPlan)))
    )
      throw new Error(`Control plan binding mismatch: ${item.id}`);
    if (
      JSON.stringify(item.plan).includes("@UPLOAD_ARTIFACT@") &&
      !/^art_/.test(evidence.uploadArtifactId ?? "")
    )
      throw new Error(`Unbound upload artifact: ${item.id}`);
    for (const oracle of [
      evidence.healthyOracle,
      evidence.transformedOracle,
      evidence.semanticOracle,
    ].filter((value) => value !== null)) {
      if (
        !oracle ||
        oracle.observed === undefined ||
        !Object.keys(oracle.observed as object).length ||
        oracle.healthy === oracle.defective
      )
        throw new Error(`Missing independent oracle observations: ${item.id}`);
    }
    r.frozenFiles[row.path] = row.sha256;
  }
  r.requiredFreezeFiles = Object.keys(implementation.files);
  Object.assign(r.frozenFiles, implementation.files);
  r.frozenFiles[controlsPath] = hash(await readFile(confined(root, controlsPath)));
  r.readiness = {
    controlsPath,
    controlsHash: r.frozenFiles[controlsPath]!,
    policyProbesPath: probesPath,
    policyProbesHash: r.frozenFiles[probesPath]!,
    implementationHash: implementation.hash,
    implementationFrozen: true,
  };
  await atomic(confined(root, path), r);
}
/** Integration owner supplies a legitimate artifact import binding; no Artifact rows are fabricated here. */
export async function bindUploadFixture(
  app: Application,
  projectId: string,
  content: string,
): Promise<string> {
  const service = app.artifacts as unknown as {
    importFixtureInput?: (input: {
      projectId: string;
      name: string;
      bytes: Uint8Array;
      mimeType: string;
    }) => Promise<{ id: string }>;
  };
  if (!service.importFixtureInput)
    throw new Error(
      "Upload fixture input binding is unavailable; pre-freeze controls must block live execution",
    );
  const artifact = await service.importFixtureInput({
    projectId,
    name: "m3-profile.bin",
    bytes: Buffer.from(content),
    mimeType: "application/octet-stream",
  });
  return artifact.id;
}
export function bindCollectionFailure() {
  return {
    artifacts: { trace: "on", video: "on", retentionDays: defaults.artifactRetentionDays },
    limits: { artifactBytes: 1024, attemptArtifactBytes: 2048 },
  };
}
/** Operator-owned profile/policy for the isolated evaluation home, in the schema the CLI accepts. */
export async function writeEvalProfile(
  home: string,
  provider: M3Registration["provider"],
  decoding: M3Registration["decoding"],
) {
  await mkdir(join(home, ".config/testmaster"), { recursive: true });
  await writeFile(
    join(home, ".config/testmaster/profiles.json"),
    JSON.stringify({
      defaultProfile: "eval",
      profiles: {
        eval: {
          modelProviders: [
            {
              id: provider.id,
              kind: provider.kind,
              baseUrl: provider.baseUrl,
              apiKeyEnv: provider.apiKeyEnv,
              models: [
                {
                  id: provider.model,
                  reasoningEffort: decoding.reasoning_effort,
                  capabilities: {
                    structuredJson: true,
                    toolCalls: true,
                    contextTokens: provider.capabilities?.contextTokens ?? 128000,
                    maxOutputTokens: provider.capabilities?.maxOutputTokens ?? 8192,
                  },
                },
              ],
            },
          ],
        },
      },
    }),
  );
  await writeFile(
    join(home, ".config/testmaster/policy.json"),
    JSON.stringify({ allowedModelProviders: [provider.id] }),
  );
}
async function setup(
  root: string,
  item: Case,
  targetUrl: string,
  r: M3Registration,
  modelFree = false,
  localProvider = false,
) {
  const temporary = await mkdtemp(join(tmpdir(), "tm-m3-"));
  const cwd = join(temporary, "repo"),
    home = join(temporary, "home");
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
  if (modelFree || localProvider) {
    delete env[r.provider.apiKeyEnv];
    env.TESTMASTER_OFFLINE = "false";
    env[r.provider.apiKeyEnv] = "model-free-provider-guard";
  }
  await writeEvalProfile(home, r.provider, r.decoding);
  await new Promise<void>((accept, reject) => {
    const child = spawn(
      process.execPath,
      [
        join(root, "apps/cli/dist/main.js"),
        "init",
        "--mode",
        "local",
        "--name",
        item.id,
        "--base-url",
        targetUrl,
        "--output",
        "json",
      ],
      { cwd, env, stdio: ["ignore", "pipe", "pipe"] },
    );
    let stdout = "";
    child.stdout.on("data", (chunk: Buffer) => {
      stdout = (stdout + chunk.toString()).slice(0, 8192);
    });
    child.stderr.resume();
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) return accept();
      let reason = `exit ${String(code)}`;
      try {
        const failure = JSON.parse(stdout).error as { code: string; message: string };
        reason = `${failure.code}: ${failure.message}`;
      } catch {}
      reject(new Error(`Isolated CLI initialization failed (${reason})`));
    });
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
  config.healing = { mode: modelFree ? "off" : "apply" };
  config.telemetry = { enabled: false };
  if (item.controls?.collectionFailure) config.artifacts = bindCollectionFailure().artifacts;
  await writeFile(configPath, JSON.stringify(config));
  const app = await Application.open({ cwd, home, env });
  const project = app.projects.list()[0]!;
  if (!modelFree) {
    app.context.entities.update(
      "Project",
      app.context.workspaceId,
      project.id,
      project.version ?? 1,
      {
        ...project,
        version: (project.version ?? 1) + 1,
        extensions: { ...project.extensions, "testmaster:healingPolicy": "apply" },
      },
    );
    app.model.grantConsent(
      project.id,
      r.provider.id,
      ["execution_evidence", "dom", "plans", "requirements", "documents", "code_summary"],
      true,
    );
  }
  return {
    app,
    projectId: project.id,
    environmentId: app.environments.list(project.id)[0]!.id,
    temporary,
  };
}
/**
 * A real credential authorized for the target at admission and removed by the operator before
 * the attempt executes: the Run must be blocked without sending the target request.
 */
export async function bindMissingCredential(app: Application, origin: string) {
  const secret = await app.secrets.set(`m3-missing-${randomUUID()}`, randomUUID(), {
    ephemeral: true,
    allowedOrigins: [origin],
  });
  return {
    id: secret.id,
    remove: async () => {
      await app.secrets.remove(secret.id);
    },
  };
}
async function replay(
  app: Application,
  testId: string,
  environmentId: string,
  healingPolicy: "off" | "apply",
  revisionId?: string,
  limits?: { artifactBytes: number; attemptArtifactBytes: number },
  beforeExecution?: () => Promise<void>,
) {
  const receipt = await app.runs.admit(
    {
      testId,
      environmentId,
      ...(revisionId ? { revisionId } : {}),
      ...(limits ? { limits } : {}),
      mode: "replay",
      healingPolicy,
      seed: 17,
    },
    { wait: true },
  );
  await beforeExecution?.();
  await app.worker.run({ ephemeral: true, runIds: [receipt.runId] });
  return app.runs.get(receipt.runId);
}
function grounded(analysis: { facts: unknown[]; hypotheses: unknown[]; failureKind: string }) {
  return (
    analysis.facts.length > 0 &&
    (analysis.failureKind === "unknown" || analysis.hypotheses.length > 0)
  );
}
/** Utility classifications come from code-owned layers, never from corpus expected labels. */
export function diagnosticUtility(analysis: Analysis): UtilityObservation {
  const diagnosis = analysis.diagnosis;
  if (!diagnosis) throw new Error("Layered diagnosis unavailable for utility measurement");
  const status = diagnosis.conclusion.status;
  const advice = diagnosis.healing.advice;
  if (
    status !== "no_failure" &&
    status !== "cause_supported" &&
    status !== "cause_partially_supported" &&
    status !== "cause_unknown"
  )
    throw new Error("Invalid diagnosis conclusion for utility measurement");
  if (
    advice !== "not_indicated" &&
    advice !== "proposal_possible" &&
    advice !== "manual_review_only"
  )
    throw new Error("Invalid healing advice for utility measurement");
  const ruleSteps = diagnosis.nextSteps.filter((step) => step.source === "rules");
  const action =
    diagnosis.conclusion.status === "no_failure"
      ? "no_action"
      : analysis.failureKind === "security_policy"
        ? "review_security_precondition"
        : analysis.failureKind === "environment"
          ? "restore_environment"
          : analysis.failureKind === "contract_violation"
            ? "compare_contract"
            : ruleSteps.some((step) => step.text.startsWith("Inspect the creation response"))
              ? "inspect_persistence"
              : diagnosis.healing.advice === "proposal_possible"
                ? "review_healing_proposal"
                : diagnosis.healing.advice === "manual_review_only"
                  ? "inspect_locator_candidates"
                  : ruleSteps.some((step) =>
                        /approved requirement|current requirement|expected behavior/i.test(
                          step.text,
                        ),
                      )
                    ? "compare_requirement"
                    : "collect_more_evidence";
  const rejected = analysis.limitations
    .map((text) =>
      /^(\d+) model hypotheses without execution observation support were not recorded\.$/.exec(
        text,
      ),
    )
    .find(Boolean);
  return {
    recommendedAction: action,
    conclusion: { status, failureKind: analysis.failureKind },
    healing: { advice },
    nextSteps: {
      count: diagnosis.nextSteps.length,
      sources: diagnosis.nextSteps.map((step) => step.source),
    },
    ...(rejected
      ? { unsupportedClaims: Number(rejected[1]) }
      : analysis.source === "rules"
        ? { unsupportedClaims: 0 }
        : {}),
  };
}
export function unsupportedClaimsForRun(app: Application, runId: string): number | undefined {
  const jobs = app.database.all<{ data_json: string }>(
    "SELECT data_json FROM job_leases WHERE workspace_id=? AND queue='analysis' AND json_extract(data_json,'$.payload.targetId')=? ORDER BY created_at DESC,id DESC",
    app.context.workspaceId,
    runId,
  );
  for (const row of jobs) {
    const job = JSON.parse(row.data_json);
    const count = job.progress?.unsupportedClaims;
    if (Number.isSafeInteger(count) && count >= 0) return count;
  }
  return undefined;
}

/** Isolated evaluation never approves, reconciles or promotes the candidate. */
export async function assessAssistedCandidate(
  source: Application,
  workspace: string,
  root: string,
  corpus: Corpus,
  item: Case,
  driver: FixtureDriver,
  proposal: HealingProposal,
  testId: string,
  environmentId: string,
  basePlan: ExecutablePlan,
  port: number,
  canary: string,
) {
  // This is a newly authored harness workspace, not a retained prior-round original.
  source.database.all("PRAGMA wal_checkpoint(TRUNCATE)");
  return withRetainedCopy(workspace, async (copy) => {
    const cwd = join(copy, "repo"),
      home = join(copy, "home");
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      HOME: home,
      XDG_CONFIG_HOME: join(home, ".config"),
      XDG_DATA_HOME: join(home, ".local/share"),
      TESTMASTER_DATA_DIR: join(cwd, ".testmaster"),
    };
    for (const key of [
      "TESTMASTER_PROJECT_ID",
      "TESTMASTER_ENDPOINT",
      "TESTMASTER_API_KEY",
      "TESTMASTER_PROFILE",
    ])
      delete env[key];
    const app = await Application.open({ cwd, home, env });
    let target: Shop | undefined;
    try {
      const active = app.tests.get(testId).activeRevisionId;
      const proposalBefore = hash(JSON.stringify(app.healing.get(proposal.id)));
      const candidate = app.revisions.get(proposal.candidateRevisionId).plan!;
      const preserved = assertionsHash(basePlan) === assertionsHash(candidate);
      const runs: Record<string, ControlRun> = {};
      const oracles: Record<string, unknown> = {};
      let positiveDrift = false,
        negativeSemantic = false;
      for (const side of ["transformed", "semantic"] as const) {
        target = await driver.startCase(root, corpus, item, side, port, canary);
        const run = await replay(app, testId, environmentId, "off", proposal.candidateRevisionId);
        const captured = captureControl(app, run.id, candidate);
        runs[side] = captured;
        const oracle = await driver.startCase(root, corpus, item, side, 0, canary);
        try {
          const verdict = await driver.independentOracle(oracle, item.oracle);
          oracles[side] = verdict;
          if (side === "transformed")
            positiveDrift = run.outcome === "passed" && run.gate === "passed" && verdict.healthy;
          else
            negativeSemantic =
              run.outcome === "failed" &&
              captured.steps.some(
                (step) =>
                  step.status === "failed" &&
                  candidate.steps.some(
                    (original) => original.kind === "assertion" && original.id === step.id,
                  ),
              ) &&
              verdict.defective;
        } finally {
          await oracle.close();
        }
        await target.close();
        target = undefined;
      }
      if (
        app.tests.get(testId).activeRevisionId !== active ||
        hash(JSON.stringify(app.healing.get(proposal.id))) !== proposalBefore
      )
        throw new Error("Isolated candidate evaluation promoted or changed the proposal");
      return {
        proof: {
          positiveDrift,
          negativeSemantic,
          isolated: true,
          assertionsPreserved: preserved,
          promoted: false as const,
          candidateRevisionId: proposal.candidateRevisionId,
          positiveRunId: runs.transformed!.runId,
          negativeRunId: runs.semantic!.runId,
        },
        runs,
        oracles,
      };
    } finally {
      app.close();
      await target?.close();
    }
  });
}
async function report(root: string, round: Round, ledgers: M3Ledger[]) {
  if (round.development) {
    await atomic(join(root, round.directory, "summary.json"), {
      development: true,
      status: round.status,
      stopReason: round.stopReason,
      cases: ledgers.map((ledger) => ({
        id: ledger.id,
        group: ledger.group,
        expectedFailureKind: ledger.expectedFailureKind,
        diagnosis: ledger.diagnosis,
        status: ledger.status,
        errorCodes: ledger.errors.map((error) => error.code),
        proposalApprovalMode:
          (ledger.records.proposal as { approvalMode?: string } | undefined)?.approvalMode ?? null,
        healing: ledger.healing,
        callCount: ((ledger.records.calls ?? []) as unknown[]).length,
        tokens: {
          input: ledger.usage.inputTokens,
          output: ledger.usage.outputTokens,
          reasoning: ledger.usage.reasoningTokens,
          conservativeCharge: ledger.usage.conservativeCharge,
          unknownCalls: ledger.usage.unknownCalls,
        },
      })),
    });
    if (
      ledgers.filter((ledger) => ledger.group !== "integration").length !==
      (round.planned ?? plannedCases()).filter((row) => row.group !== "integration").length
    ) {
      await atomic(join(root, round.directory, "round.json"), round);
      await atomic(join(root, round.directory, "report.json"), {
        development: true,
        round,
        ledgers,
      });
      await writeFile(
        join(root, round.directory, "report.md"),
        `# M3 development probe (not a registered round)\n\nStatus: ${round.status}; stop: ${round.stopReason ?? "none"}.\n\nSelected cases: ${ledgers.length}. See summary.json and per-case ledgers; no primary metrics are scored for subsets. Development probes never count toward a milestone gate.\n`,
      );
      return;
    }
  }
  const score = scoreM3(ledgers, round.planned);
  await atomic(join(root, round.directory, "round.json"), round);
  await atomic(join(root, round.directory, "report.json"), {
    ...(round.development ? { development: true } : {}),
    round,
    score,
    ledgers,
  });
  await writeFile(
    join(root, round.directory, "report.md"),
    `${round.development ? "# M3 development probe (not a registered round)" : "# M3 coverage pilot"}\n\nStatus: ${round.status}; stop: ${round.stopReason ?? "none"}.\n\nSafe healing: ${score.safeHealingSuccessRate.successes}/${score.safeHealingSuccessRate.n}. Cause accuracy: ${score.diagnosisCauseAccuracy.successes}/${score.diagnosisCauseAccuracy.n}. Completion: ${score.endToEndCompletion.successes}/${score.endToEndCompletion.n}.\n\n${score.limitations.join("\n\n")}\n${round.development ? "\nDevelopment probes never count toward a milestone gate.\n" : ""}`,
  );
}
export async function settleM3(root: string, directory: string) {
  const path = confined(root, directory);
  const round = JSON.parse(await readFile(join(path, "round.json"), "utf8")) as Round;
  if (round.status !== "started") throw new Error("Only interrupted started rounds may be settled");
  const labels: PlannedCase[] = round.planned ?? [
    ...plannedCases(),
    { id: "m3-integration-01", group: "integration", expectedFailureKind: "product_bug" },
  ];
  const ledgers: M3Ledger[] = [];
  for (const label of labels) {
    let ledger: M3Ledger;
    try {
      ledger = JSON.parse(await readFile(join(path, `${label.id}.json`), "utf8")) as M3Ledger;
    } catch (error) {
      if (!(error && typeof error === "object" && "code" in error && error.code === "ENOENT"))
        throw error;
      ledger = emptyLedger(label);
    }
    if (round.pending?.caseId === label.id) {
      ledger.status = "error";
      ledger.usage.conservativeCharge = Math.max(
        ledger.usage.conservativeCharge,
        round.pending.reservation,
      );
      ledger.errors.push({
        phase: "interrupted",
        code: "unknown_paid_completion",
        messageHash: hash("Interrupted paid command; no retry authorized"),
      });
    }
    await atomic(join(path, `${label.id}.json`), ledger);
    ledgers.push(ledger);
  }
  round.status = "settled";
  round.stopReason ??= "interrupted-settlement-no-paid-calls";
  await report(root, round, ledgers);
}
export async function authenticateIntegrationTarget(
  app: Application,
  url: string,
  secretId?: string,
) {
  const response = await fetch(new URL("/api/auth/token", url), {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ email: "demo@example.test", password: "correct-password" }),
  });
  const body = (await response.json()) as { token?: string };
  if (!response.ok || !body.token) throw new Error("Integration fixture authentication failed");
  const secret = secretId
    ? await app.secrets.rotate(secretId, `Bearer ${body.token}`)
    : await app.secrets.set("m3-integration-auth", `Bearer ${body.token}`, {
        ephemeral: true,
        allowedOrigins: [new URL(url).origin],
      });
  return { token: body.token, secret };
}
export async function runM3(root: string, commit: string, path: string) {
  if (!/^[a-f0-9]{40,64}$/.test(commit)) throw new Error("Supply immutable preregistration commit");
  await checkM3(root, path);
  const bytes = await readFile(confined(root, path));
  assertRegistrationUnchanged(bytes, await committedRegistration(root, commit, path));
  const r = JSON.parse(bytes.toString()) as M3Registration;
  await assertNotStarted(root, r.id);
  if (!r.readiness.implementationFrozen || !r.readiness.controlsPath)
    throw new Error("Implementation/healthy-negative oracle controls not frozen");
  if (
    !r.readiness.policyProbesPath ||
    !r.readiness.policyProbesHash ||
    !r.readiness.implementationHash
  )
    throw new Error("Policy probes/implementation manifest not frozen");
  assertImplementationBinding(
    await implementationManifest(root, r),
    JSON.parse(await readFile(confined(root, r.readiness.controlsPath), "utf8")).implementation,
  );
  if (
    hash(await readFile(confined(root, r.readiness.policyProbesPath))) !==
    r.readiness.policyProbesHash
  )
    throw new Error("Policy probe manifest changed");
  for (const file of r.requiredFreezeFiles)
    if (!r.frozenFiles[file]) throw new Error(`Missing freeze: ${file}`);
  for (const file of Object.keys(r.frozenFiles)) {
    const current = await readFile(confined(root, file));
    assertRegistrationUnchanged(current, await committedRegistration(root, commit, file));
  }
  await assertFrozenFiles(root, r.frozenFiles);
  const corpus = await loadM3Corpus(root, r.corpus);
  const directory = `evals/results/${r.id}-${new Date().toISOString().replace(/[:.]/g, "-")}`;
  await mkdir(join(root, "evals/results"), { recursive: true });
  await claimStart(root, r.id);
  await mkdir(join(root, directory), { recursive: false, mode: 0o700 });
  const round: Round = {
    registrationId: r.id,
    registrationHash: hash(bytes),
    commit,
    directory,
    startedAt: new Date().toISOString(),
    status: "started",
    chargedTokens: 0,
    logicalCommands: 0,
    transportAttempts: 0,
    consecutiveTransportFailures: 0,
    stopReason: null,
    pending: null,
  };
  await executeRound(root, r, corpus, directory, round, orderedCases(corpus));
}
/** Development measurements share execution safeguards, but never claim registered-round evidence. */
export async function devM3(
  root: string,
  registrationPath: string,
  outLabel: string,
  caseIds?: string[],
) {
  if (!/^[a-z0-9][a-z0-9.-]{0,40}$/.test(outLabel))
    throw new Error("Invalid development output label");
  const bytes = await readFile(confined(root, registrationPath));
  const r = JSON.parse(bytes.toString()) as M3Registration;
  if (typeof r.corpus !== "string" || !r.corpus)
    throw new Error("Invalid development registration");
  const corpus = await loadM3Corpus(root, r.corpus);
  validateMeasurementInputs(r, corpus);
  const allCases = orderedCases(corpus);
  if (caseIds !== undefined) {
    if (!caseIds.length) throw new Error("Select at least one development case");
    for (const id of caseIds)
      if (!allCases.some((item) => item.id === id)) throw new Error(`Unknown M3 case ID: ${id}`);
  }
  const selected = caseIds ? allCases.filter((item) => caseIds.includes(item.id)) : allCases;
  const directory = `evals/results/dev-${outLabel}-${new Date().toISOString().replace(/[:.]/g, "-")}`;
  await mkdir(join(root, "evals/results"), { recursive: true });
  await mkdir(join(root, directory), { recursive: false, mode: 0o700 });
  const round: Round = {
    registrationId: typeof r.id === "string" ? r.id : `dev-${outLabel}`,
    registrationHash: hash(bytes),
    commit: "",
    directory,
    startedAt: new Date().toISOString(),
    status: "started",
    chargedTokens: 0,
    logicalCommands: 0,
    transportAttempts: 0,
    consecutiveTransportFailures: 0,
    stopReason: null,
    pending: null,
    development: true,
  };
  await executeRound(root, r, corpus, directory, round, selected);
  return directory;
}
function orderedCases(corpus: Corpus) {
  return corpus.cases
    .filter((row) => row.group !== "integration")
    .sort((a, b) => a.id.localeCompare(b.id))
    .concat(corpus.cases.filter((row) => row.group === "integration"));
}
async function executeRound(
  root: string,
  r: M3Registration,
  corpus: Corpus,
  directory: string,
  round: Round,
  ordered: Case[],
) {
  const fixture = await loadCorpusDriver(root, corpus);
  round.planned = corpus.cases.map(
    ({ id, group, expectedFailureKind, labels, defect, familyId, review }) => ({
      id,
      group,
      expectedFailureKind,
      ...(labels ? { labels } : {}),
      ...(defect === undefined ? {} : { defect }),
      ...(familyId ? { familyId } : {}),
      ...(review ? { review } : {}),
    }),
  );
  for (const item of ordered) item.controls = caseControls(fixture, item);
  const ledgers = ordered.map(emptyLedger);
  const flush = async () => {
    await atomic(join(root, directory, "round.json"), round);
    for (const row of ledgers) await atomic(join(root, directory, `${row.id}.json`), row);
  };
  await flush();
  const canary = `tm-canary-${randomUUID()}-never-public`;
  const forbidden = [process.env[r.provider.apiKeyEnv], canary].filter((value): value is string =>
    Boolean(value),
  );
  if (!process.env[r.provider.apiKeyEnv]) round.stopReason = "missing_key";
  for (const item of ordered) {
    const ledger = ledgers.find((row) => row.id === item.id)!;
    if (Date.now() >= Date.parse(round.startedAt) + r.budget.maxWallTimeMs)
      round.stopReason ??= "wall_time_exhausted";
    if (round.stopReason) continue;
    let app: Application | undefined;
    let shop: Shop | undefined;
    let phase = "setup";
    try {
      const deadline = Date.parse(round.startedAt) + r.budget.maxWallTimeMs;
      const remaining = () => Math.max(0, deadline - Date.now());
      shop = await fixture.startCase(root, corpus, item, "healthy", 0, canary);
      const port = Number(new URL(shop.url).port);
      const setupResult = await setup(root, item, shop.url, r);
      app = setupResult.app;
      ledger.records.workspace = setupResult.temporary;
      const plan = structuredClone(item.plan);
      const serialized = JSON.stringify(plan);
      if (serialized.includes("@UPLOAD_ARTIFACT@")) {
        const id = await bindUploadFixture(
          app,
          setupResult.projectId,
          corpus.uploadFixture.content,
        );
        Object.assign(plan, JSON.parse(serialized.replaceAll("@UPLOAD_ARTIFACT@", id)));
      }
      const credential = serialized.includes("@MISSING_CREDENTIAL@")
        ? await bindMissingCredential(app, new URL(shop.url).origin)
        : null;
      if (credential)
        Object.assign(
          plan,
          JSON.parse(JSON.stringify(plan).replaceAll("@MISSING_CREDENTIAL@", credential.id)),
        );
      const test = app.tests.create({ projectId: setupResult.projectId, plan });
      const baseRevisionId = test.activeRevisionId!;
      const basePlan = app.revisions.get(baseRevisionId).plan!;
      ledger.records.baseRevision = { id: baseRevisionId, protectedHash: assertionsHash(basePlan) };
      const measuredCalls = new Set<string>();
      let projectCharge = 0;
      const reconcile = async () => {
        const usage = app!.usage.get({ projectId: setupResult.projectId });
        const calls = usage.calls.filter((call) => !measuredCalls.has(call.id));
        const stored = (ledger.records.calls ?? []) as Record<string, unknown>[];
        for (const call of calls) {
          measuredCalls.add(call.id);
          ledger.usage.inputTokens += call.usage.inputTokens ?? 0;
          ledger.usage.outputTokens += call.usage.outputTokens ?? 0;
          ledger.usage.reasoningTokens += call.usage.reasoningTokens ?? 0;
          if (call.usage.inputTokens === null || call.usage.outputTokens === null)
            ledger.usage.unknownCalls++;
          if (call.cost === "unknown") ledger.usage.unknownCostCalls++;
          else ledger.usage.costs.push(call.cost);
          const timing = app!.database.get<{ latency: number; created_at: string }>(
            "SELECT latency,created_at FROM model_calls WHERE workspace_id=? AND project_id=? AND id=?",
            app!.context.workspaceId,
            setupResult.projectId,
            call.id,
          );
          stored.push({
            id: call.id,
            model: call.model,
            provider: call.provider,
            promptHash: call.promptHash,
            responseHash: call.responseHash,
            modelConfigHash: call.modelConfigHash,
            repairAttempt: call.repairAttempt,
            transportAttempt: call.transportAttempt,
            outcome: call.outcome,
            usage: call.usage,
            cost: call.cost,
            latencyMs: timing?.latency ?? null,
            createdAt: timing?.created_at ?? null,
          });
        }
        ledger.records.calls = stored;
        const wireRecords = app!.database.all<{ data_json: string }>(
          "SELECT data_json FROM model_calls WHERE workspace_id=? AND project_id=?",
          app!.context.workspaceId,
          setupResult.projectId,
        );
        if (wireRecords.some((row) => forbidden.some((value) => row.data_json.includes(value))))
          throw new Error("secret_escape");
        const budget = app!.database.get<{ used: number }>(
          "SELECT COALESCE(SUM(CASE WHEN state='reserved' THEN reserved_tokens ELSE COALESCE(charged_tokens,reserved_tokens) END),0) AS used FROM budget_reservations WHERE workspace_id=? AND project_id=? AND state<>'released'",
          app!.context.workspaceId,
          setupResult.projectId,
        );
        projectCharge = Number(budget?.used ?? 0);
      };
      const paid = async <T>(operation: () => Promise<T>) => {
        if (round.stopReason) throw new Error(round.stopReason);
        if (!remaining()) throw new Error("wall_time_exhausted");
        if (round.logicalCommands >= r.budget.maxLogicalCommands)
          throw new Error("logical_command_limit");
        await reconcile();
        const attempts = ledgers.reduce(
          (n, row) => n + ((row.records.calls ?? []) as unknown[]).length,
          0,
        );
        if (attempts + 6 > r.budget.maxTransportAttempts)
          throw new Error("transport_attempt_limit");
        const reserve = 6 * (r.budget.maxInputTokens + r.budget.outputReservation),
          remainingTokens = r.budget.maxTokens - round.chargedTokens;
        if (remainingTokens < reserve) throw new Error("budget_exhausted");
        app!.usage.setBudget(setupResult.projectId, { tokens: projectCharge + remainingTokens });
        const before = projectCharge;
        const beforeCallCount = ((ledger.records.calls ?? []) as unknown[]).length;
        round.logicalCommands++;
        round.pending = { caseId: item.id, reservation: reserve };
        round.chargedTokens += reserve;
        ledger.usage.conservativeCharge += reserve;
        await flush();
        let transportFailed = false;
        try {
          return await operation();
        } catch (error) {
          transportFailed = /UPSTREAM_TIMEOUT|UNAVAILABLE/.test(
            error && typeof error === "object" && "code" in error
              ? String(error.code)
              : String(error),
          );
          throw error;
        } finally {
          await reconcile();
          const records = (ledger.records.calls ?? []) as { outcome?: string }[];
          const terminal = records.at(-1);
          if (
            transportFailed ||
            (records.length > beforeCallCount && terminal?.outcome === "failed")
          ) {
            round.consecutiveTransportFailures++;
            if (round.consecutiveTransportFailures >= 2)
              round.stopReason = "consecutive_provider_transport_failures";
          } else if (records.length > beforeCallCount) round.consecutiveTransportFailures = 0;
          round.transportAttempts = ledgers.reduce(
            (n, row) => n + ((row.records.calls ?? []) as unknown[]).length,
            0,
          );
          const delta = projectCharge - before;
          round.chargedTokens += delta - reserve;
          ledger.usage.conservativeCharge += delta - reserve;
          round.pending = null;
          await flush();
        }
      };
      if (item.controls?.integrationWorkflow) {
        phase = "integration-source";
        const authentication = await authenticateIntegrationTarget(app, shop.url);
        const secret = authentication.secret;
        const sourcePath = join(setupResult.temporary, "repo", "integration.txt");
        const sourceText =
          (await readFile(
            confined(root, item.controls.integrationWorkflow.requirementPath),
            "utf8",
          )) + `\nAuthorized authentication reference: ${secret.id}.`;
        await writeFile(sourcePath, sourceText);
        const source = await app.sources.add({
          projectId: setupResult.projectId,
          role: "prd",
          path: sourcePath,
          format: "markdown",
        });
        const requirement = validate<Requirement>(
          "Requirement",
          entity(app.context, "req", {
            text: sourceText,
            acceptanceCriteria: [
              "Query created product price 123",
              "Query updated product name Workflow updated and price 456",
            ],
            sourceRefs: source.revision.chunks ?? [],
            originKind: "explicit",
            confidence: null,
            approval: null,
            extensions: {
              "testmaster:projectId": setupResult.projectId,
              "testmaster:fixtureAuthorization": "scripted-operator-not-independent-human-review",
            },
          }),
        );
        if (!requirement.sourceRefs.length)
          throw new Error("Integration authored source has no evidence chunks");
        app.database.withTx(() => {
          app!.context.entities.insert(
            "Requirement",
            requirement as unknown as Parameters<Application["context"]["entities"]["insert"]>[1],
            { projectId: setupResult.projectId },
          );
          app!.database.run(
            "INSERT INTO operational_state(key,value) VALUES(?,?)",
            `requirements:${app!.context.workspaceId}:${setupResult.projectId}`,
            canonicalJson({
              requirements: [requirement],
              conflicts: [],
              openQuestions: [],
              version: 1,
              fingerprint: semanticHash([requirement]),
            }),
          );
        });
        app.requirements.approve(requirement.id, requirement.version ?? 1);
        phase = "integration-generation";
        const batch = await paid(() =>
          app!.proposals.generate({
            projectId: setupResult.projectId,
            type: "integration",
            requirementIds: [requirement.id],
            budget: { deadlineMs: Math.min(r.budget.commandDeadlineMs, remaining()) },
          }),
        );
        const proposals = app.proposals
          .detail(batch.id)
          .proposals.filter((row) => row.validation === "valid" && row.plan.kind === "executable");
        if (proposals.length !== 1)
          throw new Error(
            "Integration generation did not yield exactly one validated executable proposal",
          );
        const accepted = app.proposals.accept(batch.id, {
          proposalIds: proposals.map((row) => row.id),
          expectedVersion: Number(batch.version),
          idempotencyKey: item.id,
        });
        const generated = app.tests.get(accepted.accepted[0]!);
        for (const side of ["healthy", "transformed"] as const) {
          if (side === "transformed") {
            await shop.close();
            shop = await fixture.startCase(root, corpus, item, side, port, canary);
            authentication.token = (
              await authenticateIntegrationTarget(app, shop.url, secret.id)
            ).token;
          }
          const result = await replay(
            app,
            generated.id,
            setupResult.environmentId,
            "off",
            generated.activeRevisionId!,
          );
          const steps = app.runs.steps(result.id);
          ledger.records[side] = { runId: result.id, outcome: result.outcome, gate: result.gate };
          ledger.stages[side] =
            side === "healthy"
              ? result.outcome === "passed" && result.gate === "passed"
              : result.outcome === "failed" &&
                steps.some(
                  (row) =>
                    row.status === "failed" &&
                    proposals[0]!.plan.kind === "executable" &&
                    proposals[0]!.plan.steps.some(
                      (step) => step.kind === "assertion" && step.id === row.planStepId,
                    ),
                );
          const verdict = await fixture.executedProductOracle(shop, authentication.token!);
          ledger.stages[`${side}Oracle`] = side === "healthy" ? verdict.healthy : verdict.defective;
          ledger.records[`${side}Oracle`] = verdict;
        }
        ledger.records.generatedRevision = {
          id: generated.activeRevisionId,
          hash: hash(JSON.stringify(proposals[0]!.plan)),
          acceptance: "scripted-operator-not-independent-human-intent-review",
        };
        ledger.stages.mutantDetected =
          ledger.stages.healthy === true &&
          ledger.stages.healthyOracle === true &&
          ledger.stages.transformed === true &&
          ledger.stages.transformedOracle === true;
        ledger.status = "observed";
        continue;
      }
      phase = "healthy";
      const healthyTest = item.healthyPlan
        ? app.tests.create({ projectId: setupResult.projectId, plan: item.healthyPlan })
        : test;
      const healthy = await replay(
        app,
        healthyTest.id,
        setupResult.environmentId,
        "apply",
        healthyTest.activeRevisionId!,
      );
      ledger.records.healthy = { runId: healthy.id, outcome: healthy.outcome, gate: healthy.gate };
      ledger.healing.healthyPassed = healthy.outcome === "passed" && healthy.gate === "passed";
      ledger.stages.healthy = ledger.healing.healthyPassed;
      // Oracle mutations use separate fresh instances and never alter execution target state.
      const oracleShop = await fixture.startCase(root, corpus, item, "healthy", 0, canary);
      try {
        ledger.healing.healthyOracle = (
          await fixture.independentOracle(oracleShop, item.oracle)
        ).healthy;
        ledger.stages.healthyOracle = ledger.healing.healthyOracle;
      } finally {
        await oracleShop.close();
      }
      await shop.close();
      shop = await fixture.startCase(root, corpus, item, "transformed", port, canary);
      if (item.controls?.unavailableTarget) await shop.close();
      const transformed = await replay(
        app,
        test.id,
        setupResult.environmentId,
        "apply",
        baseRevisionId,
        item.controls?.collectionFailure ? bindCollectionFailure().limits : undefined,
        credential?.remove,
      );
      ledger.records.transformed = {
        runId: transformed.id,
        outcome: transformed.outcome,
        gate: transformed.gate,
      };
      ledger.stages.transformed = true;
      if (item.controls?.collectionFailure) {
        const steps = app.runs.steps(transformed.id);
        const mismatch = steps.some(
          (row) =>
            plan.steps.some((step) => step.id === row.planStepId && step.kind === "assertion") &&
            row.status === "failed",
        );
        const limited = JSON.stringify(app.runs.events(transformed.id)).includes(
          "artifact_limit_exceeded",
        );
        const bundles = app.database.get(
          "SELECT id FROM snapshots WHERE workspace_id=? AND run_id=?",
          app.context.workspaceId,
          transformed.id,
        );
        if (!mismatch || !limited || bundles)
          throw new Error(
            "Collection failure control did not preserve mismatch with unavailable bundle",
          );
      }
      const immutableBefore = hash(
        JSON.stringify(app.database.all("SELECT data_json FROM runs WHERE id=?", transformed.id)),
      );
      phase = "rules";
      const rules = await app.analysis.analyze(transformed.id, { model: false });
      ledger.records.rules = {
        id: rules.id,
        hash: hash(JSON.stringify(rules)),
        failureKind: rules.failureKind,
      };
      ledger.utility = { rules: diagnosticUtility(rules) };
      ledger.stages.rules = true;
      phase = "model-diagnosis";
      let diagnosis = rules;
      try {
        diagnosis = await paid(() =>
          app!.analysis.analyze(transformed.id, {
            model: true,
            budget: { deadlineMs: Math.min(r.budget.commandDeadlineMs, remaining()) },
          }),
        );
        ledger.stages.modelDiagnosis =
          diagnosis.source === "model" && diagnosis.modelCallId !== null;
        if (diagnosis.source === "model" && diagnosis.modelCallId === null)
          ledger.errors.push({
            phase,
            code: "model_enrichment_abstained",
            messageHash: hash(JSON.stringify(diagnosis.limitations)),
          });
      } catch (error) {
        ledger.errors.push({ phase, code: "diagnosis_error", ...errorRecord(error, forbidden) });
      }
      if (diagnosis !== rules) ledger.utility.model = diagnosticUtility(diagnosis);
      const unsupportedClaims = unsupportedClaimsForRun(app, transformed.id);
      if (unsupportedClaims !== undefined) {
        ledger.utility.model ??= { ...diagnosticUtility(diagnosis) };
        ledger.utility.model.unsupportedClaims = unsupportedClaims;
      }
      ledger.diagnosis = {
        failureKind: diagnosis.failureKind,
        grounded: grounded(diagnosis),
        abstained: diagnosis.failureKind === "unknown",
      };
      ledger.records.modelDiagnosis = { id: diagnosis.id, hash: hash(JSON.stringify(diagnosis)) };
      phase = "healing";
      ledger.healing.offered = true;
      let proposal: HealingProposal | null = null;
      try {
        proposal = await paid(() =>
          app!.healing.propose(transformed.id, {
            budget: { deadlineMs: Math.min(r.budget.commandDeadlineMs, remaining()) },
          }),
        );
      } catch (error) {
        if (!(error instanceof Error) || !("code" in error) || error.code !== "PRECONDITION_FAILED")
          throw error;
        const refusal = healingRefusal(error, forbidden);
        const jobId = refusal.record.jobId;
        const job =
          typeof jobId === "string"
            ? app.database.get<{ state: string; data_json: string }>(
                "SELECT state,data_json FROM job_leases WHERE workspace_id=? AND id=? AND queue='healing'",
                app.context.workspaceId,
                jobId,
              )
            : null;
        ledger.records.refusal = {
          ...refusal.record,
          ...(job ? { job: { state: job.state, result: JSON.parse(job.data_json).result } } : {}),
        };
        ledger.stages.healing = false;
        if (refusal.failed)
          ledger.errors.push({
            phase,
            code: "healing_model_failure",
            ...errorRecord(error, forbidden),
          });
      }
      ledger.stages.healing = proposal !== null;
      if (proposal) {
        ledger.healing.manualReviewRequired = proposal.approvalMode !== "policy";
        ledger.healing.changeCount = proposal.changes.length;
        ledger.healing.proposed = true;
        const candidatePlan = app.revisions.get(proposal.candidateRevisionId).plan!;
        const protectedProposal = compareProtectedAssertions(
          baseRevisionId,
          basePlan,
          proposal.candidateRevisionId,
          candidatePlan,
        );
        ledger.records.proposalAssertions = protectedProposal;
        ledger.healing.assertionsPreserved = protectedProposal.preserved;
        // Mechanical inspection is not independent proposed-patch safety review.
        ledger.healing.unsafeProposed =
          !ledger.healing.assertionsPreserved ||
          proposal.changes.some(
            (change) =>
              ![
                "/input/locator",
                "/input/source",
                "/input/destination",
                "/input/trigger/input/locator",
                "/input/state",
              ].includes(change.path),
          );
        ledger.records.proposal = {
          id: proposal.id,
          hash: hash(JSON.stringify(proposal)),
          status: proposal.status,
          approvalMode: proposal.approvalMode,
        };
        if (proposal.verificationRunId && proposal.approvalMode === "policy") {
          ledger.stages.policyAdmission = true;
          ledger.healing.unsafeApplied = ledger.healing.unsafeProposed;
          if (ledger.healing.unsafeApplied) throw new Error("unsafe_autoapply");
          await app.worker.run({ ephemeral: true, runIds: [proposal.verificationRunId] });
          const verified = app.runs.get(proposal.verificationRunId);
          ledger.healing.verificationPassed =
            verified.outcome === "passed" && verified.gate === "passed";
          ledger.healing.falseRepair =
            ledger.healing.verificationPassed &&
            (item.defect ?? (item.group === "bug" || item.expectedFailureKind === "product_bug"));
          if (ledger.healing.falseRepair) throw new Error("false_repair");
          await app.healing.reconcile(verified.id);
          ledger.healing.applied =
            ledger.healing.verificationPassed &&
            app.tests.get(test.id).activeRevisionId === proposal.candidateRevisionId;
          ledger.stages.promotion = ledger.healing.applied;
          ledger.stages.verification = ledger.healing.verificationPassed;
          const candidate = app.revisions.get(proposal.candidateRevisionId);
          const protectedVerification = compareProtectedAssertions(
            baseRevisionId,
            basePlan,
            candidate.id,
            candidate.plan!,
          );
          ledger.records.verificationAssertions = protectedVerification;
          ledger.healing.assertionsPreserved = protectedVerification.preserved;
          if (item.group === "drift") {
            const driftOracle = await fixture.startCase(
              root,
              corpus,
              item,
              "transformed",
              0,
              canary,
            );
            try {
              ledger.healing.driftOracle = (
                await fixture.independentOracle(driftOracle, item.oracle)
              ).healthy;
            } finally {
              await driftOracle.close();
            }
            await shop.close();
            shop = await fixture.startCase(root, corpus, item, "semantic", port, canary);
            const negative = await replay(
              app,
              test.id,
              setupResult.environmentId,
              "off",
              proposal.candidateRevisionId,
            );
            const assertionIds = plan.steps
              .filter((step) => step.kind === "assertion")
              .map((step) => step.id);
            const steps = app.runs.steps(negative.id);
            ledger.healing.semanticAssertionReached = steps.some(
              (step) =>
                assertionIds.includes(String(step.planStepId)) &&
                ["passed", "failed"].includes(String(step.status)),
            );
            ledger.healing.semanticAssertionFailed =
              steps.some(
                (step) =>
                  assertionIds.includes(String(step.planStepId)) && step.status === "failed",
              ) && negative.outcome === "failed";
            const semanticOracle = await fixture.startCase(
              root,
              corpus,
              item,
              "semantic",
              0,
              canary,
            );
            try {
              ledger.healing.semanticOracle = (
                await fixture.independentOracle(semanticOracle, item.oracle)
              ).defective;
            } finally {
              await semanticOracle.close();
            }
            ledger.records.semantic = {
              runId: negative.id,
              outcome: negative.outcome,
              gate: negative.gate,
            };
            ledger.stages.semanticNegative =
              ledger.healing.semanticAssertionReached &&
              ledger.healing.semanticAssertionFailed &&
              ledger.healing.semanticOracle;
          }
        }
        if (proposal.approvalMode !== "policy" && item.group === "drift") {
          await shop.close();
          const candidate = await assessAssistedCandidate(
            app,
            setupResult.temporary,
            root,
            corpus,
            item,
            fixture,
            proposal,
            test.id,
            setupResult.environmentId,
            basePlan,
            port,
            canary,
          );
          ledger.healing.assistedCandidate = candidate.proof;
          ledger.records.assistedCandidate = candidate;
          ledger.stages.assistedCandidate =
            candidate.proof.positiveDrift && candidate.proof.negativeSemantic;
        }
      }
      if (
        hash(
          JSON.stringify(app.database.all("SELECT data_json FROM runs WHERE id=?", transformed.id)),
        ) !== immutableBefore
      )
        throw new Error("terminal_rewrite");
      const output = JSON.stringify({ ledger, rules, diagnosis, proposal });
      if (forbidden.some((value) => output.includes(value))) throw new Error("secret_escape");
      ledger.status = ledger.errors.length
        ? "error"
        : (ledger.records.refusal as { reason?: string } | undefined)?.reason ===
              "model_abstained" ||
            (proposal && proposal.approvalMode !== "policy")
          ? "abstained"
          : "observed";
    } catch (error) {
      ledger.status = "error";
      const message = String(error);
      ledger.errors.push({
        phase,
        code: message.includes("secret_escape")
          ? "secret_escape"
          : message.includes("terminal_rewrite")
            ? "terminal_rewrite"
            : "pipeline_error",
        ...errorRecord(error, forbidden),
      });
      if (
        /secret_escape|terminal_rewrite|unsafe_autoapply|false_repair|budget_exhausted|wall_time_exhausted|logical_command_limit|transport_attempt_limit/.test(
          message,
        )
      )
        round.stopReason = message.match(
          /secret_escape|terminal_rewrite|unsafe_autoapply|false_repair|budget_exhausted|wall_time_exhausted|logical_command_limit|transport_attempt_limit/,
        )![0]!;
    } finally {
      app?.close();
      await shop?.close();
      await flush();
    }
  }
  round.status = "completed";
  await report(root, round, ledgers);
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const root = resolve(fileURLToPath(new URL("../../../", import.meta.url)));
  const [mode, ...args] = process.argv.slice(2);
  const replayCaseIds = args.slice(2).filter((arg) => arg !== "--model");
  const extraCommand =
    mode === "replay" && args.length >= 2
      ? replayM3(root, args[0]!, args[1]!, {
          model: args.includes("--model"),
          ...(replayCaseIds.length ? { caseIds: replayCaseIds } : {}),
        })
      : mode === "holdout-check" &&
          (args.length === 1 || (args.length === 2 && args[1] === "--homologation"))
        ? checkHoldout(root, args[0]!, args[1] === "--homologation")
        : mode === "holdout-seal" && args.length === 2
          ? sealHoldout(root, args[0]!, args[1]!)
          : mode === "task-check" && args.length === 1
            ? checkUserTasks(root, args[0]!)
            : null;
  const command = extraCommand
    ? extraCommand.then((result) => console.log(JSON.stringify(result, null, 2)))
    : mode === "check" && args.length === 1
      ? checkM3(root, args[0]!).then((result) => console.log(JSON.stringify(result, null, 2)))
      : mode === "controls" && args.length === 2
        ? controlsM3(root, args[0]!, args[1]!)
        : mode === "run" && args.length === 2
          ? runM3(root, args[0]!, args[1]!)
          : mode === "dev" && args.length >= 2
            ? devM3(root, args[0]!, args[1]!, args.length > 2 ? args.slice(2) : undefined)
            : mode === "settle" && args.length === 1
              ? settleM3(root, args[0]!)
              : mode === "policy-probes" && args.length === 2
                ? policyProbesM3(root, args[0]!, args[1]!)
                : mode === "freeze" && args.length === 3
                  ? freezeM3(root, args[0]!, args[1]!, args[2]!)
                  : Promise.reject(
                      new Error(
                        "Usage: m3 check REGISTRATION | controls REGISTRATION OUT_DIR | policy-probes REGISTRATION OUT_DIR | run COMMIT REGISTRATION | dev REGISTRATION OUT_LABEL [CASE_ID...] | replay RESULTS_DIR OUT_LABEL [--model] [CASE_ID...] | holdout-check MANIFEST [--homologation] | holdout-seal MANIFEST OUT | task-check FILE | settle RESULTS | freeze REGISTRATION CONTROLS POLICY_PROBES",
                      ),
                    );
  command.catch((error) => {
    console.error(JSON.stringify({ error: String(error) }));
    process.exitCode = 1;
  });
}
