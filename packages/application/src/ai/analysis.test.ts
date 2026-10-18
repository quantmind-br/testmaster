import {
  type Analysis,
  ContractError,
  type ExecutablePlan,
  type Run,
  type StepResult,
  validate,
} from "@testmaster/contracts";
import { canonicalJson, materializePlanDefaults, semanticHash } from "@testmaster/domain";
import { EntityRepository, PersistenceDatabase } from "@testmaster/persistence";
import { type LocatorEvidence, locatorFingerprint } from "@testmaster/planner";
import { afterEach, expect, it, vi } from "vitest";
import {
  fixtureInsert,
  relationalFixtures,
} from "../../../persistence/src/contract-relational-fixtures.js";
import { type ArtifactsService, EvidenceUnavailableError } from "../artifacts.js";
import type { ServiceContext } from "../context.js";
import { AnalysisService, resolveAnalysisEvidence } from "./analysis.js";
import type { DiscoveryDetail } from "./discovery.js";
import { ModelService } from "./model.js";

const databases: PersistenceDatabase[] = [];
afterEach(() => {
  for (const db of databases.splice(0)) db.close();
});
async function fixture(
  options: {
    passed?: boolean;
    queued?: boolean;
    requestOnly?: boolean;
    /** The price step checks a schema: a cited source schema, or an inline jsonConforms one. */
    schema?: boolean | "inline";
    status?: boolean;
    missing?: boolean;
    source?: boolean;
    unbound?: boolean;
    plan?: ExecutablePlan;
    /** Plan of a parent revision of the frozen one (set: the frozen revision is its child). */
    parentPlan?: ExecutablePlan;
    /** The frozen revision is imported code: no plan, a Playwright runner. */
    code?: boolean;
    /** Name of an auth profile bound to the Run's environment revision. */
    authProfile?: string;
    /** A completed Run and its attempt that ended inconclusive instead of passed/failed. */
    outcome?: "inconclusive";
    /** A passed Run whose gate failed (its evidence could not be published). */
    gateFailed?: boolean;
    /** How the Run's cleanup ended (the Run row's `cleanupOutcome`). */
    cleanupOutcome?: "inconclusive";
    /**
     * The environment revision opts in to this container's log; with `concurrentRun`, a second
     * Run of the same environment revision has an attempt that overlaps the fixture's attempt.
     */
    serverLogContainer?: string;
    concurrentRun?: boolean;
    step?: Partial<StepResult>;
  } = {},
) {
  const db = PersistenceDatabase.memory();
  databases.push(db);
  await db.migrate();
  const fixtures = relationalFixtures(db);
  const needed = [
    "Workspace",
    "Principal",
    "Membership",
    "Project",
    "Environment",
    "EnvironmentRevision",
    "TestCase",
    "TestRevision",
    "Run",
    "Attempt",
  ];
  const get = (kind: string) => {
    const fixture = fixtures.find((item) => item.kind === kind);
    if (!fixture) throw new Error(`Missing ${kind} fixture`);
    return fixture;
  };
  const ws = String(get("Workspace").dto.id);
  const principal = String(get("Principal").dto.id);
  if (options.authProfile) {
    const profile = get("AuthProfile");
    Object.assign(profile.dto, { name: options.authProfile });
    profile.row.data_json = canonicalJson(profile.dto);
    const environment = get("EnvironmentRevision");
    Object.assign(environment.dto, { authProfileRefs: [profile.dto.id] });
    environment.row.data_json = canonicalJson(environment.dto);
    needed.push("AuthProfile");
  }
  const revision = get("TestRevision");
  const plan: ExecutablePlan = options.plan ?? {
    schemaVersion: "1.0.0",
    kind: "executable",
    name: "Frozen business contract",
    type: "backend",
    runner: "http",
    requirementRefs: ["req_00000000-0000-4000-8000-000000000003"],
    steps: [
      {
        id: "request",
        kind: "action",
        operation: "request",
        description: "Read price",
        input: { method: "GET", pathSegments: [{ literal: "price" }] },
      },
      {
        id: "price",
        kind: "assertion",
        operation: "assert",
        required: true,
        description: "Exact price",
        input: { responseStepId: "request" },
        expectation:
          options.schema === "inline"
            ? { predicate: "jsonConforms", schema: { type: "integer", minimum: 1 } }
            : options.schema
              ? {
                  predicate: "jsonSchema",
                  sourceRevisionId: "svr_00000000-0000-4000-8000-000000000001",
                  pointer: "",
                }
              : options.status
                ? { predicate: "statusIn", values: [200] }
                : { predicate: "jsonEquals", value: { literal: 10 } },
      },
    ],
  };
  revision.dto.plan = options.code ? null : plan;
  if (options.code) revision.dto.runnerKind = "playwright";
  revision.dto.contentHash = semanticHash(plan);
  revision.row.content_hash = revision.dto.contentHash as string;
  // A parent revision (ordinal 1) of the frozen one, inserted with it: revisions are immutable, so
  // the link cannot be added afterwards.
  const parentRevisionId = "rev_00000000-0000-4000-8000-0000000000a1";
  const parentRevision = options.parentPlan
    ? {
        ...revision,
        dto: {
          ...revision.dto,
          id: parentRevisionId,
          ordinal: 1,
          parentId: null,
          plan: options.parentPlan,
          contentHash: semanticHash(options.parentPlan),
        },
        row: {
          ...revision.row,
          id: parentRevisionId,
          ordinal: 1,
          parent_id: null,
          content_hash: semanticHash(options.parentPlan),
        },
      }
    : null;
  if (parentRevision) {
    Object.assign(revision.dto, { ordinal: 2, parentId: parentRevisionId });
    Object.assign(revision.row, { ordinal: 2, parent_id: parentRevisionId });
    parentRevision.row.data_json = canonicalJson(parentRevision.dto);
  }
  revision.row.data_json = canonicalJson(revision.dto);
  const runFixture = get("Run");
  const terminal = options.outcome ?? (options.passed ? "passed" : "failed");
  const run = {
    ...runFixture.dto,
    phase: options.queued ? "queued" : "completed",
    status: options.queued ? "queued" : terminal,
    outcome: options.queued ? null : terminal,
    gate: options.queued ? "pending" : options.passed && !options.gateFailed ? "passed" : "failed",
    ...(options.cleanupOutcome ? { cleanupOutcome: options.cleanupOutcome } : {}),
    analysisStatus: "not_requested",
  } as unknown as Run;
  const repository = {
    binding: "verified",
    repositoryId: "local:fixture",
    commitSha: "a".repeat(40),
    checkoutSha: "a".repeat(40),
    dirtyHash: null,
  };
  if (options.source && !options.unbound) {
    const admission = { repository };
    run.matrixCell = {
      admissionSnapshot: admission,
      admissionSnapshotHash: semanticHash(admission),
    };
  }
  Object.assign(runFixture.row, {
    phase: run.phase,
    status: run.status,
    outcome: run.outcome,
    gate: run.gate,
    cleanup_outcome: run.cleanupOutcome,
    data_json: canonicalJson(run),
  });
  const attempt = get("Attempt");
  const attemptSpan = options.serverLogContainer
    ? { startedAt: "2026-10-17T12:00:00.000Z", endedAt: "2026-10-17T12:00:05.000Z" }
    : {};
  Object.assign(attempt.dto, { phase: "completed", outcome: terminal, ...attemptSpan });
  Object.assign(attempt.row, {
    phase: "completed",
    outcome: terminal,
    ...(options.serverLogContainer
      ? { started_at: attemptSpan.startedAt, ended_at: attemptSpan.endedAt }
      : {}),
    data_json: canonicalJson(attempt.dto),
  });
  if (options.serverLogContainer) {
    const environment = get("EnvironmentRevision");
    Object.assign(environment.dto, {
      serverLog: { kind: "docker", container: options.serverLogContainer },
    });
    environment.row.data_json = canonicalJson(environment.dto);
  }
  const jobId = String(attempt.row.job_id);
  db.withTx(() => {
    for (const kind of needed) {
      if (kind === "Attempt")
        db.run(
          "INSERT INTO job_leases(workspace_id,id,created_at,queue,resource_id,available_at,data_json) VALUES(?,?,?,?,?,?,?)",
          ws,
          jobId,
          new Date().toISOString(),
          "execution",
          run.id,
          new Date().toISOString(),
          "{}",
        );
      if (kind === "TestRevision" && parentRevision) {
        const parentInsert = fixtureInsert(parentRevision);
        db.run(parentInsert.sql, ...parentInsert.values);
      }
      const item = get(kind);
      const insert = fixtureInsert(item);
      db.run(insert.sql, ...insert.values);
    }
    if (options.concurrentRun) {
      // Same environment revision, attempt started while the fixture's attempt ran.
      const otherRunId = "run_00000000-0000-4000-8000-0000000000b1";
      const otherJobId = "job_00000000-0000-4000-8000-0000000000b1";
      const otherRun = structuredClone(runFixture);
      Object.assign(otherRun.dto, { id: otherRunId, idempotencyKey: "concurrent" });
      Object.assign(otherRun.row, {
        id: otherRunId,
        ...("idempotency_key" in otherRun.row ? { idempotency_key: "concurrent" } : {}),
        data_json: canonicalJson(otherRun.dto),
      });
      const otherAttempt = structuredClone(attempt);
      Object.assign(otherAttempt.dto, {
        id: "att_00000000-0000-4000-8000-0000000000b1",
        runId: otherRunId,
        jobId: otherJobId,
        startedAt: "2026-10-17T12:00:02.000Z",
        endedAt: "2026-10-17T12:00:09.000Z",
      });
      Object.assign(otherAttempt.row, {
        id: otherAttempt.dto.id,
        run_id: otherRunId,
        job_id: otherJobId,
        started_at: otherAttempt.dto.startedAt,
        ended_at: otherAttempt.dto.endedAt,
        data_json: canonicalJson(otherAttempt.dto),
      });
      db.run(
        "INSERT INTO job_leases(workspace_id,id,created_at,queue,resource_id,available_at,data_json) VALUES(?,?,?,?,?,?,?)",
        ws,
        otherJobId,
        new Date().toISOString(),
        "execution",
        otherRunId,
        new Date().toISOString(),
        "{}",
      );
      for (const item of [otherRun, otherAttempt]) {
        const insert = fixtureInsert(item);
        db.run(insert.sql, ...insert.values);
      }
    }
  });
  const ctx: ServiceContext = {
    database: db,
    entities: new EntityRepository(db),
    workspaceId: ws,
    principalId: principal,
    authorize() {},
    authorizeNamed() {},
  };
  const step: StepResult = {
    id: "stp_00000000-0000-4000-8000-000000000002",
    attemptId: String(attempt.dto.id),
    planStepId: options.requestOnly ? "request" : "price",
    index: 0,
    status: options.passed ? "passed" : "failed",
    ...(options.passed ? {} : { reasonCode: "assertion_mismatch" }),
    expected: options.requestOnly ? 200 : 10,
    observed: options.missing
      ? null
      : options.requestOnly || options.status
        ? 500
        : options.passed
          ? 10
          : 11,
    error: null,
    durationMs: 1,
    evidenceRefs: [],
    ...options.step,
  };
  ctx.entities.insert("StepResult", { ...step, workspaceId: ws });
  const complete = vi.fn(async (_input: unknown) => {
    throw new ContractError("QUOTA_EXCEEDED", "No budget");
  });
  const model = {
    complete,
    select: ModelService.prototype.select,
    config: {
      modelProviders: [
        {
          id: "fake",
          models: [
            { id: "fake-model", capabilities: { structuredJson: true } },
            { id: "plain-model", capabilities: { structuredJson: false } },
          ],
        },
      ],
      profilePolicy: { allowedModelProviders: ["fake"] },
      effectiveConfig: { policyHash: "a".repeat(64) },
    },
  } as unknown as ModelService;
  const artifacts = {
    get: vi.fn(async () => {
      throw new EvidenceUnavailableError("missing", run.id);
    }),
  } as unknown as ArtifactsService;
  const snapshot = get("CodeSnapshot");
  const files = [{ path: "src/price.ts", contentHash: "b".repeat(64), line: 1 }];
  const manifestHash = semanticHash({
    detectorVersion: "test-1",
    files,
    excludes: [],
    skipped: [],
  });
  Object.assign(snapshot.dto, { workspaceId: ws, excludes: [], dirtyHash: null, manifestHash });
  Object.assign(snapshot.row, {
    manifest_hash: manifestHash,
    data_json: canonicalJson(snapshot.dto),
  });
  if (options.source) {
    const insert = fixtureInsert(snapshot);
    db.run(insert.sql, ...insert.values);
  }
  const call = get("ModelCall");
  const callInsert = fixtureInsert(call);
  db.run(callInsert.sql, ...callInsert.values);
  const detail = {
    job: { id: "dsc_00000000-0000-4000-8000-000000000090", workspaceId: ws },
    codeSnapshot: ctx.entities.get("CodeSnapshot", ws, String(snapshot.dto.id)) ?? {
      ...snapshot.dto,
      workspaceId: ws,
    },
    summary: {
      detectorVersion: "test-1",
      manifestHash,
      fileRefs: files,
      symbols: [{ name: "price", kind: "function", ref: files[0] }],
      skippedFiles: [],
    },
    featureMap: { projectId: String(get("Project").dto.id) },
    repository,
  } as unknown as DiscoveryDetail;
  const discovery = { get: vi.fn(() => detail) };
  const service = new AnalysisService(ctx, model, artifacts, discovery);
  return {
    db,
    ctx,
    run,
    step,
    service,
    complete,
    artifacts,
    detail,
    discovery,
    modelCallId: String(call.dto.id),
  };
}

it("passed execution abstains without inventing a failure hypothesis", async () => {
  const f = await fixture({ passed: true });
  const analysis = await f.service.analyze(f.run.id, {});
  expect(analysis).toMatchObject({
    failureKind: "unknown",
    hypotheses: [],
    source: "rules",
    parentId: null,
    recommendedAction: "collect_more_evidence",
  });
  expect(analysis.diagnosis?.conclusion.status).toBe("no_failure");
  expect(analysis.diagnosis?.healing.advice).toBe("not_indicated");
  expect(analysis.diagnosis?.nextSteps).toEqual([]);
});
it("a passed run whose gate failed on a recorded execution error names it and never reports no failure", async () => {
  const f = await fixture({ passed: true, gateFailed: true });
  f.db.run(
    "INSERT INTO outbox(workspace_id,id,created_at,aggregate_id,seq,type,payload_ref,data_json) VALUES(?,?,?,?,?,?,?,?)",
    f.ctx.workspaceId,
    "evt_00000000-0000-4000-8000-000000000046",
    new Date().toISOString(),
    f.run.id,
    8,
    "run.execution_error",
    "inline",
    canonicalJson({
      reasonCode: "insufficient_evidence",
      error: "INVALID_ARGUMENT",
      message: "Invalid Artifact",
      details: {
        issues: [
          {
            path: "/storageKey",
            rule: "maxLength",
            message: "must NOT have more than 200 characters",
          },
        ],
      },
    }),
  );
  const analysis = await f.service.analyze(f.run.id, {});
  const diagnosis = analysis.diagnosis!;
  expect(diagnosis.conclusion.status).not.toBe("no_failure");
  expect(diagnosis.conclusion.text).not.toContain("no failure was observed");
  expect(diagnosis.conclusion.text).toContain('INVALID_ARGUMENT "Invalid Artifact"');
  expect(diagnosis.conclusion.text).toContain("/storageKey maxLength");
  expect(diagnosis.observation?.summary).toContain("/storageKey");
  expect(diagnosis.nextSteps).toHaveLength(1);
  expect(analysis.facts.map((fact) => fact.text).join("\n")).toContain("/storageKey maxLength");
});
it("a passed run whose gate failed without a recorded error is not reported as no failure either", async () => {
  const f = await fixture({ passed: true, gateFailed: true });
  const analysis = await f.service.analyze(f.run.id, {});
  expect(analysis.diagnosis?.conclusion.status).toBe("cause_unknown");
  expect(analysis.diagnosis?.conclusion.text).toContain("its gate failed");
});
it("a passed run whose gate failed on cleanup names the resource declaration that kept it from running", async () => {
  const createStep = (resource: Record<string, unknown>) => ({
    schemaVersion: "1.0.0",
    kind: "executable",
    name: "Create a knowledge base",
    type: "backend",
    runner: "http",
    requirementRefs: ["req_00000000-0000-4000-8000-000000000003"],
    steps: [
      {
        id: "create_kb",
        kind: "action",
        operation: "request",
        description: "Create",
        input: {
          method: "POST",
          pathSegments: [{ literal: "kb" }],
          resource: {
            resourceType: "knowledge-base",
            correlationKey: { literal: "kb" },
            ...resource,
          },
        },
      },
    ],
    cleanup: [
      {
        resourceRef: "create_kb",
        operation: "request",
        input: { method: "DELETE", pathSegments: [{ literal: "kb" }] },
        successPredicate: { predicate: "statusIn", values: [200] },
        deadlineMs: 30000,
        required: true,
      },
    ],
  });
  const f = await fixture({
    passed: true,
    gateFailed: true,
    cleanupOutcome: "inconclusive",
    plan: createStep({ handle: "/data/id" }) as unknown as ExecutablePlan,
  });
  const diagnosis = (await f.service.analyze(f.run.id, {})).diagnosis!;
  expect(diagnosis.conclusion.status).toBe("cause_supported");
  expect(diagnosis.conclusion.text).toContain("its cleanup ended inconclusive");
  expect(diagnosis.conclusion.text).toContain(
    "step create_kb creates a knowledge-base without ownerProof",
  );
  expect(diagnosis.nextSteps.map((step) => step.text).join("\n")).toContain("ownerProof");
  // Control: complete declarations name no missing field, only the cleanup that did not delete.
  const complete = await fixture({
    passed: true,
    gateFailed: true,
    cleanupOutcome: "inconclusive",
    plan: createStep({
      handle: "/data/id",
      ownerProof: "/data/creator_id",
    }) as unknown as ExecutablePlan,
  });
  const text = (await complete.service.analyze(complete.run.id, {})).diagnosis!.conclusion.text;
  expect(text).toContain("was not deleted by its cleanup request");
  expect(text).not.toContain("without");
});
it("HTTP 500 request response is not locator drift or a certain product cause", async () => {
  const f = await fixture({ requestOnly: true });
  expect(await f.service.analyze(f.run.id, {})).toMatchObject({
    failureKind: "unknown",
    hypotheses: [],
  });
});
it("required HTTP status mismatch records the observation without proving product causality", async () => {
  const f = await fixture({ status: true });
  const analysis = await f.service.analyze(f.run.id);
  expect(analysis.failureKind).toBe("unknown");
  expect(
    analysis.facts.some((fact) => fact.evidenceRefs.some((ref) => ref.stepId === f.step.id)),
  ).toBe(true);
});
it.each([201, 204, 299])(
  "required unexpected successful status %i is an observed product mismatch",
  async (status) => {
    const f = await fixture({ status: true });
    const stored = JSON.parse(
      String(f.db.get("SELECT data_json FROM steps WHERE id=?", f.step.id)!.data_json),
    );
    stored.observed = status;
    f.db.run("UPDATE steps SET data_json=? WHERE id=?", canonicalJson(stored), f.step.id);
    const analysis = await f.service.analyze(f.run.id);
    expect(analysis).toMatchObject({
      failureKind: "product_bug",
      recommendedAction: "fix_product",
    });
    expect(analysis.hypotheses[0]?.supports).toContainEqual(
      expect.objectContaining({ stepId: f.step.id }),
    );
    expect(analysis.hypotheses[0]?.text).toContain("not a proven source-level root cause");
  },
);
it("required unexpected 3xx status without a recorded redirect remains unknown", async () => {
  const f = await fixture({ status: true });
  const stored = JSON.parse(
    String(f.db.get("SELECT data_json FROM steps WHERE id=?", f.step.id)!.data_json),
  );
  stored.observed = 302;
  f.db.run("UPDATE steps SET data_json=? WHERE id=?", canonicalJson(stored), f.step.id);
  expect(await f.service.analyze(f.run.id)).toMatchObject({
    failureKind: "unknown",
    hypotheses: [],
  });
});
it("missing JSON value does not establish an approved schema violation", async () => {
  const f = await fixture({ missing: true });
  expect((await f.service.analyze(f.run.id)).failureKind).toBe("unknown");
});
it("missing pointer structure reaches the catalog without turning into a rules schema claim", async () => {
  const f = await fixture({ missing: true });
  const stored = JSON.parse(
    String(f.db.get("SELECT data_json FROM steps WHERE id=?", f.step.id)!.data_json),
  );
  const diagnostic = {
    deepestPrefix: "/items/0",
    type: "object",
    keys: ["price"],
    unlistedKeyCount: 0,
    firstUnresolvedToken: "priceCents",
  };
  stored.error = {
    code: "RuntimeError",
    message: `HTTP jsonEquals expectation was not satisfied; missing JSON pointer: ${JSON.stringify(diagnostic)}`,
  };
  f.db.run("UPDATE steps SET data_json=? WHERE id=?", canonicalJson(stored), f.step.id);
  const analysis = await f.service.analyze(f.run.id, { model: true });
  expect(analysis.failureKind).toBe("unknown");
  const request = f.complete.mock.calls[0]![0] as { data: { measurements: unknown[] } };
  expect(request.data.measurements).toContainEqual(
    expect.objectContaining({ kind: "step", missingJsonPointer: diagnostic }),
  );
});
it("structured catalog retains frozen assertion semantics and verified reference hashes", async () => {
  const f = await fixture();
  await f.service.analyze(f.run.id, { model: true });
  expect(f.complete).toHaveBeenCalledTimes(1);
  const request = f.complete.mock.calls[0]![0] as unknown as { data: { measurements: unknown[] } };
  expect(request.data.measurements).toContainEqual(
    expect.objectContaining({
      kind: "step",
      operation: "assert",
      required: true,
      predicate: "jsonEquals",
      responseStepId: "request",
      expected: 10,
      observed: 11,
      ref: expect.objectContaining({ runId: f.run.id }),
      verifiedHash: expect.any(String),
    }),
  );
});
async function attachLocatorEvidence(
  f: Awaited<ReturnType<typeof fixture>>,
  namedCount: number,
  extra: LocatorEvidence["candidates"] = [],
) {
  const generated = Array.from({ length: 52 }, (_, index) => {
    const identity = {
      role: index >= 52 - namedCount ? "button" : "",
      name: index === 51 ? "Checkout" : index >= 52 - namedCount ? `Control ${index}` : "",
      tag: index >= 52 - namedCount ? "button" : "div",
      type: "",
      attributes: {},
    };
    return {
      ...identity,
      fingerprint: locatorFingerprint(identity),
      matched: index === 51,
      visible: true,
    };
  });
  const candidates = [...generated, ...extra];
  const payload = {
    schemaVersion: "1.0.0" as const,
    stepId: "price",
    phase: "before" as const,
    frameOrigin: "http://localhost",
    locator: { by: "role" as const, role: "button", name: "Checkout", exact: true },
    cardinality: 1,
    candidates,
    truncated: false,
    state: null,
  };
  return attachLocatorRecord(f, { ...payload, evidenceHash: semanticHash(payload) });
}
async function attachLocatorRecord(
  f: Awaited<ReturnType<typeof fixture>>,
  record: LocatorEvidence,
) {
  const fixtures = relationalFixtures(f.db);
  const snapshot = fixtures.find((item) => item.kind === "Snapshot")!;
  const artifact = fixtures.find((item) => item.kind === "Artifact")!;
  for (const item of [snapshot, artifact]) {
    if (item.kind === "Artifact") {
      Object.assign(item.dto, { state: "available", hash: "a".repeat(64) });
      item.row.state = "available";
      item.row.hash = "a".repeat(64);
      item.row.data_json = canonicalJson(item.dto);
    }
    const insert = fixtureInsert(item);
    f.db.run(insert.sql, ...insert.values);
  }
  const locatorPath = "locators/price.json";
  const hash = "a".repeat(64);
  const entries = [
    {
      artifactId: artifact.dto.id,
      relativePath: locatorPath,
      kind: "locator-evidence",
      sizeBytes: 20000,
      state: "available",
      redactionStatus: "sanitized",
      sha256: hash,
    },
  ];
  const bundle = {
    manifest: { snapshotId: snapshot.dto.id, attemptId: f.step.attemptId, entries },
  };
  vi.mocked(f.artifacts.get).mockResolvedValue(bundle as never);
  f.artifacts.read = vi.fn(async () => ({ bytes: Buffer.from(JSON.stringify(record)) })) as never;
  return { snapshot, artifact, locatorPath, hash };
}
it.each([
  { passed: false, namedCount: 1 },
  { passed: true, namedCount: 1 },
  { passed: false, namedCount: 40 },
])(
  "locator catalog preserves relevant identities and discloses summarized candidates ($passed, $namedCount)",
  async ({ passed, namedCount }) => {
    const f = await fixture({ passed });
    const { snapshot, artifact, locatorPath, hash } = await attachLocatorEvidence(f, namedCount);
    await f.service.analyze(f.run.id, { model: true });
    expect(f.complete).toHaveBeenCalledTimes(1);
    const request = f.complete.mock.calls[0]![0] as {
      data: { measurements: Record<string, unknown>[] };
    };
    const locator = request.data.measurements.find((item) => item.kind === "locator")!;
    expect(locator).toMatchObject({
      stepId: "price",
      phase: "before",
      cardinality: 1,
      truncated: false,
      unlistedCandidateCount: 52 - (passed ? 1 : namedCount),
    });
    const listed = locator.candidates as Record<string, unknown>[];
    expect(listed).toHaveLength(passed ? 1 : namedCount);
    expect(listed[0]).toMatchObject({ role: "button", name: "Checkout", matched: true });
    if (!passed)
      expect(listed[0]).toMatchObject({
        attributes: {},
        equivalence: expect.objectContaining({ equivalent: false }),
      });
    expect(JSON.stringify(locator)).not.toContain("fingerprint");
    expect(JSON.stringify(request.data)).not.toContain('"omitted"');
    const ref = {
      runId: f.run.id,
      attemptId: f.step.attemptId,
      snapshotId: snapshot.dto.id,
      artifactId: artifact.dto.id,
      relativePath: locatorPath,
      contentHash: hash,
    };
    expect(await resolveAnalysisEvidence(f.ctx, f.artifacts, f.run.id, ref as never)).toMatchObject(
      { bytes: expect.any(Buffer) },
    );
  },
);
it("catalog exposes bounded runner event metadata while retaining its resolvable handle", async () => {
  const f = await fixture();
  const event = {
    protocolVersion: "1.0.0",
    seq: 3,
    attemptId: f.step.attemptId,
    occurredAt: new Date().toISOString(),
    type: "step.finished",
    payload: {
      stepId: "price",
      index: 0,
      status: "failed",
      reasonCode: "assertion_mismatch",
      durationMs: 1,
      evidencePaths: [],
    },
  };
  f.db.run(
    "INSERT INTO observations(workspace_id,id,created_at,attempt_id,event_id,seq,fence,data_json) VALUES(?,?,?,?,?,?,?,?)",
    f.ctx.workspaceId,
    "evt_00000000-0000-4000-8000-000000000099",
    event.occurredAt,
    f.step.attemptId,
    "evt_00000000-0000-4000-8000-000000000099",
    event.seq,
    1,
    canonicalJson(event),
  );
  await f.service.analyze(f.run.id, { model: true });
  const request = f.complete.mock.calls[0]![0] as {
    data: { measurements: Record<string, unknown>[]; facts: { supports: string[] }[] };
  };
  const measurement = request.data.measurements.find((item) => item.kind === "observation")!;
  expect(measurement).toMatchObject({
    eventType: "step.finished",
    stepId: "price",
    reasonCode: "assertion_mismatch",
  });
  expect(
    request.data.facts.some((fact) => fact.supports.includes(String(measurement.evidenceId))),
  ).toBe(true);
  expect(
    await resolveAnalysisEvidence(f.ctx, f.artifacts, f.run.id, {
      runId: f.run.id,
      attemptId: f.step.attemptId,
      observationSeq: event.seq,
      contentHash: semanticHash(event),
    }),
  ).toEqual(event);
});
it("collection failure after a required mismatch preserves the mismatch and collection limitation", async () => {
  const f = await fixture();
  const value = { reasonCode: "storage_unavailable" };
  f.db.run(
    "INSERT INTO outbox(workspace_id,id,created_at,aggregate_id,seq,type,payload_ref,data_json) VALUES(?,?,?,?,?,?,?,?)",
    f.ctx.workspaceId,
    "evt_00000000-0000-4000-8000-000000000045",
    new Date().toISOString(),
    f.run.id,
    5,
    "run.execution_error",
    "inline",
    canonicalJson(value),
  );
  const analysis = await f.service.analyze(f.run.id);
  expect(analysis.failureKind).toBe("product_bug");
  expect(analysis.facts.some((fact) => fact.text.includes("storage_unavailable"))).toBe(true);
  expect(analysis.limitations.some((limitation) => limitation.includes("collection"))).toBe(true);
});
it("required frozen business mismatch cites the scoped persisted step and canonical hash", async () => {
  const f = await fixture();
  const original = f.db.get("SELECT data_json FROM runs WHERE id=?", f.run.id)?.data_json;
  const analysis = await f.service.analyze(f.run.id, {});
  expect(analysis.failureKind).toBe("product_bug");
  const ref = analysis.hypotheses[0]!.supports[0]!;
  expect(ref).toMatchObject({ runId: f.run.id, attemptId: f.step.attemptId, stepId: f.step.id });
  expect(await resolveAnalysisEvidence(f.ctx, f.artifacts, f.run.id, ref)).toMatchObject(f.step);
  expect(ref.contentHash).toBe(
    semanticHash(
      f.db.get("SELECT data_json FROM steps WHERE id=?", f.step.id)
        ? JSON.parse(
            String(f.db.get("SELECT data_json FROM steps WHERE id=?", f.step.id)!.data_json),
          )
        : null,
    ),
  );
  expect(f.db.get("SELECT data_json FROM runs WHERE id=?", f.run.id)?.data_json).toBe(original);
});
it("missing bundle preserves null snapshot with a disclosed evidence limitation", async () => {
  const f = await fixture();
  const analysis = await f.service.analyze(f.run.id, {});
  expect(analysis.snapshotId).toBeNull();
  expect(analysis.limitations).not.toHaveLength(0);
  expect(analysis.diagnosis?.observation?.absence).toBe("evidence_unavailable");
});
it("model failure retains byte-identical immutable factual predecessor and does not retry identical requests", async () => {
  const f = await fixture();
  const factual = await f.service.analyze(f.run.id, {});
  const before = f.db.get("SELECT data_json FROM analyses WHERE id=?", factual.id)?.data_json;
  const enriched = await f.service.analyze(f.run.id, { model: true });
  expect(enriched).toMatchObject({
    source: "rules",
    parentId: null,
    modelCallId: null,
    failureKind: factual.failureKind,
  });
  expect(enriched.id).not.toBe(factual.id);
  expect(enriched.limitations.some((value) => value.includes("Model enrichment abstained"))).toBe(
    true,
  );
  expect(f.db.get("SELECT data_json FROM analyses WHERE id=?", factual.id)?.data_json).toBe(before);
  expect(() => f.db.run("UPDATE analyses SET data_json=? WHERE id=?", "{}", factual.id)).toThrow();
  expect(() => f.db.run("DELETE FROM analyses WHERE id=?", enriched.id)).toThrow();
  expect((await f.service.analyze(f.run.id, { model: true })).id).toBe(enriched.id);
  expect(f.complete).toHaveBeenCalledTimes(1);
});
it("schema-valid enrichment that contradicts the rules cause abstains and names the rejecting rule", async () => {
  const f = await fixture();
  const factual = await f.service.analyze(f.run.id, {});
  expect(factual.failureKind).toBe("product_bug");
  f.complete.mockImplementationOnce(async () => ({
    modelCallId: "mdl_00000000-0000-4000-8000-000000000009",
    output: {
      failureKind: "test_fragility",
      hypotheses: [{ text: "Selector drift", supports: ["E1"], contradicts: [], confidence: 0.9 }],
      recommendedAction: "fix_test",
      fixTargetHandle: null,
      limitations: [],
      nextSteps: [],
      evidenceGaps: [],
    },
  }));
  const enriched = await f.service.analyze(f.run.id, { model: true });
  expect(enriched).toMatchObject({
    source: "rules",
    parentId: null,
    modelCallId: null,
    failureKind: "product_bug",
  });
  expect(enriched.limitations).toContain(
    "Model enrichment abstained: INVALID_ARGUMENT: Model cause contradicts the rules-derived factual cause.",
  );
});
it("nonterminal and unknown Runs are refused without analysis or jobs", async () => {
  const f = await fixture({ queued: true });
  await expect(f.service.analyze(f.run.id, {})).rejects.toMatchObject({
    code: "PRECONDITION_FAILED",
  });
  await expect(
    f.service.analyze("run_00000000-0000-4000-8000-000000000099", {}),
  ).rejects.toMatchObject({ code: "NOT_FOUND" });
  expect(f.db.get("SELECT COUNT(*) AS n FROM analyses")?.n).toBe(0);
  expect(f.db.get("SELECT COUNT(*) AS n FROM job_leases WHERE queue='analysis'")?.n).toBe(0);
});
it("identical factual diagnosis returns its immutable stored receipt", async () => {
  const f = await fixture();
  const first = await f.service.analyze(f.run.id, {});
  const second = await f.service.analyze(f.run.id, {});
  expect(second.id).toBe(first.id);
  expect(f.db.get("SELECT COUNT(*) AS n FROM analyses")?.n).toBe(1);
});
it("lost paid lease settles with unknown usage and never reissues enrichment", async () => {
  const f = await fixture();
  const factual = await f.service.analyze(f.run.id, {});
  const job = f.service.jobs.enqueue(f.ctx.workspaceId, "analysis", {
    operation: "model",
    targetId: f.run.id,
    actorId: f.ctx.principalId,
    evidenceHash: "b".repeat(64),
    configHash: "c".repeat(64),
    options: { model: true },
  }).job;
  const fence = f.service.jobs.claim({
    workspaceId: f.ctx.workspaceId,
    owner: "crashed",
    queue: "analysis",
    jobId: job.jobId,
  })!;
  f.service.jobs.mark(fence, { paidCallStarted: true, factualAnalysisId: factual.id });
  f.db.run(
    "UPDATE job_leases SET lease_expires_at=? WHERE id=?",
    "2020-01-01T00:00:00.000Z",
    job.jobId,
  );
  expect(await f.service.settlePending()).toBe(1);
  expect(f.complete).not.toHaveBeenCalled();
  expect(f.service.jobs.get(f.ctx.workspaceId, job.jobId)?.result).toMatchObject({
    unknownUsage: true,
  });
  expect(f.service.get(f.run.id)).toMatchObject({ source: "rules", parentId: null });
});
it("approved-schema mismatch takes precedence over generic business mismatch", async () => {
  const f = await fixture({ schema: true });
  expect(await f.service.analyze(f.run.id, {})).toMatchObject({
    failureKind: "contract_violation",
    recommendedAction: "review_contract",
    diagnosis: {
      conclusion: { status: "cause_partially_supported" },
      healing: { advice: "not_indicated" },
    },
    hypotheses: [expect.objectContaining({ support: "partially_supported" })],
  });
});
it("affected requirements come from the frozen revision, not the active test", async () => {
  const f = await fixture();
  const test = f.ctx.entities.get("TestCase", f.ctx.workspaceId, f.run.testId)!;
  f.ctx.entities.update("TestCase", f.ctx.workspaceId, test.id, Number(test.version), {
    ...test,
    workspaceId: f.ctx.workspaceId,
    version: Number(test.version) + 1,
    activeRevisionId: null,
  });
  expect((await f.service.analyze(f.run.id, {})).affectedRequirementIds).toEqual([
    "req_00000000-0000-4000-8000-000000000003",
  ]);
});
it("execution evidence rejects wrong hashes and cross-Run compound bindings", async () => {
  const f = await fixture();
  const analysis = await f.service.analyze(f.run.id, {});
  const ref = analysis.hypotheses[0]!.supports[0]!;
  await expect(
    resolveAnalysisEvidence(f.ctx, f.artifacts, f.run.id, { ...ref, contentHash: "0".repeat(64) }),
  ).rejects.toMatchObject({ code: "INVALID_ARGUMENT" });
  await expect(
    resolveAnalysisEvidence(f.ctx, f.artifacts, f.run.id, {
      ...ref,
      runId: "run_00000000-0000-4000-8000-000000000099",
    }),
  ).rejects.toMatchObject({ code: "INVALID_ARGUMENT" });
});
it("evidence authorization errors propagate rather than becoming a missing-bundle limitation", async () => {
  const f = await fixture();
  vi.mocked(f.artifacts.get).mockRejectedValueOnce(
    new ContractError("FORBIDDEN", "Evidence access denied"),
  );
  await expect(f.service.analyze(f.run.id, {})).rejects.toMatchObject({ code: "FORBIDDEN" });
  expect(f.db.get("SELECT COUNT(*) AS n FROM analyses")?.n).toBe(0);
});
it("persisted supervisor security refusal precedes business mismatch and resolves its observation", async () => {
  const f = await fixture();
  const value = { reasonCode: "security_precondition_failed", error: "POLICY_DENIED" };
  f.db.run(
    "INSERT INTO outbox(workspace_id,id,created_at,aggregate_id,seq,type,payload_ref,data_json) VALUES(?,?,?,?,?,?,?,?)",
    f.ctx.workspaceId,
    "evt_00000000-0000-4000-8000-000000000044",
    new Date().toISOString(),
    f.run.id,
    4,
    "run.execution_error",
    "inline",
    canonicalJson(value),
  );
  const analysis = await f.service.analyze(f.run.id, {});
  expect(analysis.failureKind).toBe("security_policy");
  const ref = analysis.hypotheses[0]!.supports[0]!;
  expect(ref).toMatchObject({
    runId: f.run.id,
    observationSeq: 4,
    contentHash: semanticHash(value),
  });
  expect(await resolveAnalysisEvidence(f.ctx, f.artifacts, f.run.id, ref)).toEqual(value);
});
type AnalysisFixture = Awaited<ReturnType<typeof fixture>>;
function recordRunnerEvent(
  f: AnalysisFixture,
  seq: number,
  type: string,
  payload: Record<string, unknown>,
) {
  const event = {
    protocolVersion: "1.0.0",
    seq,
    attemptId: f.step.attemptId,
    occurredAt: new Date().toISOString(),
    type,
    payload,
  };
  const id = `evt_00000000-0000-4000-8000-0000000000${String(60 + seq)}`;
  f.db.run(
    "INSERT INTO observations(workspace_id,id,created_at,attempt_id,event_id,seq,fence,data_json) VALUES(?,?,?,?,?,?,?,?)",
    f.ctx.workspaceId,
    id,
    event.occurredAt,
    f.step.attemptId,
    id,
    seq,
    1,
    canonicalJson(event),
  );
  return event;
}
const blockedByEgress = { outcome: "blocked", reasonCode: "egress_denied" };
it("a blocked run names the denied origin in the hypothesis, conclusion, facts and security next step", async () => {
  const f = await fixture();
  const denial = recordRunnerEvent(f, 3, "egress.denied", {
    stepId: "request",
    origin: "https://tracker.example.test",
    method: "GET",
    resourceType: "script",
    disposition: "fatal",
    count: 2,
  });
  recordRunnerEvent(f, 4, "runner.finished", blockedByEgress);
  const analysis = await f.service.analyze(f.run.id, {});
  expect(analysis.failureKind).toBe("security_policy");
  expect(analysis.hypotheses[0]?.text).toContain("https://tracker.example.test");
  expect(analysis.hypotheses[0]?.supports).toContainEqual(
    expect.objectContaining({ observationSeq: 3, contentHash: semanticHash(denial) }),
  );
  expect(analysis.facts.map((fact) => fact.text)).toContain(
    "The network policy denied 2 script requests to https://tracker.example.test; the denial blocked the run.",
  );
  expect(analysis.diagnosis?.conclusion.text).toContain("https://tracker.example.test");
  const review = analysis.diagnosis?.nextSteps.find((step) =>
    step.text.startsWith("Review the refused security precondition"),
  );
  expect(review?.text).toContain("https://tracker.example.test");
  expect(review?.text).toContain("--additional-origin");
  expect(review?.evidenceRefs).toEqual([
    expect.objectContaining({ observationSeq: 3, contentHash: semanticHash(denial) }),
  ]);
});
it("a security refusal without a recorded denial keeps the generic review step", async () => {
  const f = await fixture();
  recordRunnerEvent(f, 4, "runner.finished", blockedByEgress);
  const analysis = await f.service.analyze(f.run.id, {});
  expect(analysis.failureKind).toBe("security_policy");
  expect(analysis.facts.map((fact) => fact.text).join("\n")).not.toContain("network policy");
  expect(analysis.diagnosis?.nextSteps.map((step) => step.text)).toContain(
    "Review the refused security precondition and its recorded reason codes; do not change the test.",
  );
});
it("a passing run still surfaces an aborted passive denial as a fact without a failure", async () => {
  const f = await fixture({ passed: true });
  recordRunnerEvent(f, 3, "egress.denied", {
    stepId: "request",
    origin: "https://flagcdn.com",
    method: "GET",
    resourceType: "image",
    disposition: "aborted",
    count: 3,
  });
  const analysis = await f.service.analyze(f.run.id, {});
  expect(analysis.facts.map((fact) => fact.text)).toContain(
    "The network policy aborted 3 image requests to https://flagcdn.com; the page continued and the run was not failed by it.",
  );
  expect(analysis.diagnosis?.conclusion.status).toBe("no_failure");
  expect(analysis.hypotheses).toEqual([]);
  expect(analysis.failureKind).not.toBe("security_policy");
});

it("authorized frozen source handle persists exact snapshot path and content binding", async () => {
  const f = await fixture({ source: true });
  f.complete.mockImplementationOnce(async (input) => {
    const request = input as { data: { measurements: { kind: string; evidenceId: string }[] } };
    const data = request.data;
    return {
      modelCallId: f.modelCallId,
      output: {
        failureKind: "product_bug",
        hypotheses: [
          {
            text: "Inspect price implementation",
            supports: ["E2"],
            contradicts: [],
            confidence: 0.5,
          },
        ],
        recommendedAction: "fix_product",
        fixTargetHandle: data.measurements.find((item) => item.kind === "source")!.evidenceId,
        limitations: [],
        nextSteps: [],
        evidenceGaps: [],
      },
    };
  });
  const result = await f.service.analyze(f.run.id, { model: true, discoveryId: f.detail.job.id });
  expect(result.limitations).toEqual(
    expect.not.arrayContaining([expect.stringContaining("Model enrichment abstained")]),
  );
  expect(result.fixTarget).toEqual({
    codeSnapshotId: f.detail.codeSnapshot.id,
    relativePath: "src/price.ts",
    contentHash: "b".repeat(64),
  });
  expect(result.hypotheses[0]!.calibrated).toBe(false);
});
it("wrong-project discovery and altered summary fail before model dispatch", async () => {
  const f = await fixture({ source: true });
  f.detail.featureMap.projectId = "prj_00000000-0000-4000-8000-000000000090";
  await expect(
    f.service.analyze(f.run.id, { model: true, discoveryId: f.detail.job.id }),
  ).rejects.toMatchObject({ code: "FORBIDDEN" });
  f.detail.featureMap.projectId = String(
    f.ctx.entities.get("TestCase", f.ctx.workspaceId, f.run.testId)!.projectId,
  );
  f.detail.summary.fileRefs[0]!.contentHash = "c".repeat(64);
  await expect(
    f.service.analyze(f.run.id, { model: true, discoveryId: f.detail.job.id }),
  ).rejects.toMatchObject({ code: "INVALID_ARGUMENT" });
  expect(f.complete).not.toHaveBeenCalled();
});
it("execution handles cannot be promoted to source fix targets", async () => {
  const f = await fixture();
  f.complete.mockImplementationOnce(async () => ({
    modelCallId: f.modelCallId,
    output: {
      failureKind: "product_bug",
      hypotheses: [
        { text: "Observed mismatch", supports: ["E2"], contradicts: [], confidence: 0.5 },
      ],
      recommendedAction: "fix_product",
      fixTargetHandle: "E2",
      limitations: [],
      nextSteps: [],
      evidenceGaps: [],
    },
  }));
  const result = await f.service.analyze(f.run.id, { model: true });
  expect(result.fixTarget).toBeUndefined();
  expect(result.modelCallId).not.toBeNull();
  expect(result.failureKind).toBe("product_bug");
  expect(
    result.limitations.some((value) =>
      value.includes("fix target without authorized source evidence was not recorded"),
    ),
  ).toBe(true);
});

it("oversized evidence abstains before dispatch instead of silently dropping its binding", async () => {
  const f = await fixture();
  const stored = JSON.parse(
    String(f.db.get("SELECT data_json FROM steps WHERE id=?", f.step.id)!.data_json),
  );
  stored.observed = "x".repeat(513);
  f.db.run("UPDATE steps SET data_json=? WHERE id=?", canonicalJson(stored), f.step.id);
  const result = await f.service.analyze(f.run.id, { model: true });
  expect(f.complete).not.toHaveBeenCalled();
  expect(result.limitations.some((value) => value.includes("oversized structures"))).toBe(true);
});
it.each([
  { cite: "locator", recorded: true },
  { cite: "run", recorded: false },
])(
  "a hypothesis supported only by a $cite handle is recorded: $recorded",
  async ({ cite, recorded }) => {
    const f = await fixture();
    await attachLocatorEvidence(f, 1);
    f.complete.mockImplementationOnce(async (input: unknown) => {
      const data = (input as { data: { measurements: Record<string, unknown>[] } }).data;
      const handle = String(data.measurements.find((item) => item.kind === cite)!.evidenceId);
      return {
        modelCallId: f.modelCallId,
        output: {
          failureKind: "product_bug",
          hypotheses: [{ text: "Observed", supports: [handle], contradicts: [], confidence: 0.5 }],
          recommendedAction: "fix_product",
          fixTargetHandle: null,
          limitations: [],
          nextSteps: [],
          evidenceGaps: [],
        },
      };
    });
    const result = await f.service.analyze(f.run.id, { model: true });
    expect(result.hypotheses.some((item) => item.text === "Observed")).toBe(recorded);
    if (!recorded)
      expect(
        result.limitations.some((value) => value.includes("execution observation support")),
      ).toBe(true);
  },
);
it("an under-supported alternative is dropped with a disclosure while a supported hypothesis is kept", async () => {
  const f = await fixture();
  f.complete.mockImplementationOnce(async () => ({
    modelCallId: f.modelCallId,
    output: {
      failureKind: "product_bug",
      hypotheses: [
        { text: "Observed mismatch", supports: ["E2"], contradicts: [], confidence: 0.6 },
        {
          text: "Alternative without observation",
          supports: ["E1"],
          contradicts: [],
          confidence: 0.2,
        },
      ],
      recommendedAction: "fix_product",
      fixTargetHandle: null,
      limitations: [],
      nextSteps: [],
      evidenceGaps: [],
    },
  }));
  const result = await f.service.analyze(f.run.id, { model: true });
  expect(result.modelCallId).not.toBeNull();
  expect(result.hypotheses.map((item) => item.confidence)).toEqual([0.6]);
  expect(result.limitations.some((value) => value.includes("were not recorded"))).toBe(true);
});
it("a model abstention does not erase the cause the rules established from observed evidence", async () => {
  const f = await fixture();
  const factual = await f.service.analyze(f.run.id);
  expect(factual.failureKind).toBe("product_bug");
  f.complete.mockImplementationOnce(async () => ({
    modelCallId: f.modelCallId,
    output: {
      failureKind: "unknown",
      hypotheses: [],
      recommendedAction: "collect_more_evidence",
      fixTargetHandle: null,
      limitations: [],
      nextSteps: [],
      evidenceGaps: [],
    },
  }));
  const result = await f.service.analyze(f.run.id, { model: true });
  expect(result.modelCallId).not.toBeNull();
  expect(result.failureKind).toBe("product_bug");
  expect(result.hypotheses.length).toBeGreaterThan(0);
  expect(result.recommendedAction).toBe("fix_product");
  expect(result.diagnosis).toEqual(factual.diagnosis);
  expect(result.hypotheses[0]?.support).toBe("partially_supported");
});
it("unknown model handles reject the entire enrichment and preserve the factual predecessor", async () => {
  const f = await fixture();
  const factual = await f.service.analyze(f.run.id);
  f.complete.mockImplementationOnce(async () => ({
    modelCallId: f.modelCallId,
    output: {
      failureKind: "product_bug",
      hypotheses: [
        { text: "Unknown support", supports: ["E999"], contradicts: [], confidence: 0.5 },
      ],
      recommendedAction: "fix_product",
      fixTargetHandle: null,
      limitations: [],
      nextSteps: [],
      evidenceGaps: [],
    },
  }));
  const result = await f.service.analyze(f.run.id, { model: true });
  expect(result).toMatchObject({ source: "rules", parentId: null });
  expect(result.modelCallId).toBeNull();
  expect(result.limitations.some((value) => value.includes("unknown execution evidence"))).toBe(
    true,
  );
});
it("an abstained enrichment is not labeled as model output and a later explicit model enriches the factual row", async () => {
  const f = await fixture();
  const factual = await f.service.analyze(f.run.id);
  // The default model is unavailable, so the enrichment abstains without a model call.
  const abstained = await f.service.analyze(f.run.id, { model: true });
  expect(abstained).toMatchObject({ source: "rules", modelCallId: null, parentId: null });
  expect(abstained.limitations.some((value) => value.includes("Model enrichment abstained"))).toBe(
    true,
  );
  expect(f.service.get(f.run.id)?.id).toBe(abstained.id);
  // Control: an explicit working model enriches from the factual diagnosis, not from the abstention.
  f.complete.mockImplementationOnce(async () => ({
    modelCallId: f.modelCallId,
    output: {
      failureKind: "unknown",
      hypotheses: [],
      recommendedAction: "collect_more_evidence",
      fixTargetHandle: null,
      limitations: [],
      nextSteps: [],
      evidenceGaps: [],
    },
  }));
  const enriched = await f.service.analyze(f.run.id, {
    model: true,
    provider: "fake",
    modelId: "fake-model",
  });
  expect(f.complete).toHaveBeenLastCalledWith(
    expect.objectContaining({ provider: "fake", model: "fake-model" }),
  );
  expect(enriched).toMatchObject({ source: "model", parentId: factual.id });
  expect(enriched.modelCallId).toBe(f.modelCallId);
  expect(enriched.limitations.some((value) => value.includes("Model enrichment abstained"))).toBe(
    false,
  );
});
it("a requested reading reports its status: used, abstained by a rule, or unavailable", async () => {
  const f = await fixture();
  // The default mock refuses with a quota error: a refusal that is not about the model's availability.
  const abstained = await f.service.analyze(f.run.id, { model: true });
  expect(f.service.modelStatus(abstained)).toMatchObject({
    state: "abstained",
    reasonCode: "QUOTA_EXCEEDED",
    modelCallId: null,
  });
  // A model absent from the provider inventory cannot be used at all.
  f.complete.mockRejectedValueOnce(
    new ContractError(
      "CAPABILITY_UNAVAILABLE",
      "Declared model is absent from provider inventory",
      {
        reasonCode: "model_not_in_inventory",
      },
    ),
  );
  const unavailable = await f.service.analyze(f.run.id, {
    model: true,
    provider: "fake",
    modelId: "fake-model",
  });
  expect(unavailable).toMatchObject({ source: "rules", modelCallId: null });
  expect(f.service.modelStatus(unavailable)).toMatchObject({
    state: "unavailable",
    reasonCode: "model_not_in_inventory",
    message: "Declared model is absent from provider inventory",
  });
  // Control: a real model call is `used` and carries its call id. A reading is stored per
  // configuration, so the control names the provider alone (its first model).
  f.complete.mockImplementationOnce(async () => ({
    modelCallId: f.modelCallId,
    output: {
      failureKind: "unknown",
      hypotheses: [],
      recommendedAction: "collect_more_evidence",
      fixTargetHandle: null,
      limitations: [],
      nextSteps: [],
      evidenceGaps: [],
    },
  }));
  const used = await f.service.analyze(f.run.id, { model: true, provider: "fake" });
  expect(f.service.modelStatus(used)).toEqual({
    state: "used",
    reasonCode: null,
    message: expect.any(String),
    modelCallId: f.modelCallId,
  });
});
it("a missing provider credential is an unavailable model reading, and the retry reaches the model once the key is set", async () => {
  const f = await fixture();
  f.complete.mockRejectedValueOnce(
    new ContractError("PRECONDITION_FAILED", "Provider API key is unavailable", {
      reasonCode: "provider_credentials_unavailable",
      provider: "fake",
      apiKeyEnv: "FAKE_KEY",
    }),
  );
  const options = { model: true, provider: "fake", modelId: "fake-model" };
  const analysis = await f.service.analyze(f.run.id, options);
  expect(analysis).toMatchObject({ source: "rules", modelCallId: null });
  const expected = {
    state: "unavailable",
    reasonCode: "provider_credentials_unavailable",
    message: "Provider API key is unavailable",
    modelCallId: null,
  };
  expect(f.service.modelStatus(analysis)).toEqual(expected);
  // Nothing was sent, so the same request evaluates again once the key is present.
  f.complete.mockImplementationOnce(async () => ({
    modelCallId: f.modelCallId,
    output: {
      failureKind: "unknown",
      hypotheses: [],
      recommendedAction: "collect_more_evidence",
      fixTargetHandle: null,
      limitations: [],
      nextSteps: [],
      evidenceGaps: [],
    },
  }));
  const retried = await f.service.analyze(f.run.id, options);
  expect(retried).toMatchObject({ source: "model", modelCallId: f.modelCallId });
  expect(f.complete).toHaveBeenCalledTimes(2);
  // The reading starts from the factual diagnosis, not from the refused one.
  expect(retried.limitations.join(" ")).not.toMatch(/Model enrichment abstained/u);
  // The refused reading stays stored with its status.
  expect(f.service.modelStatus(analysis)).toEqual(expected);
  // Control: a reading that abstained after the call is final and is not reissued.
  const other = await fixture();
  other.complete.mockRejectedValueOnce(
    new ContractError("PRECONDITION_FAILED", "Model output was rejected"),
  );
  const abstained = await other.service.analyze(other.run.id, { model: true });
  expect(other.service.modelStatus(abstained)).toMatchObject({
    state: "abstained",
    reasonCode: "PRECONDITION_FAILED",
  });
  const again = await other.service.analyze(other.run.id, { model: true });
  expect(again.id).toBe(abstained.id);
  expect(other.complete).toHaveBeenCalledTimes(1);
});
it("a reading refused because the project's compute slots were busy reaches the model on the next request", async () => {
  const f = await fixture();
  f.complete.mockRejectedValueOnce(
    new ContractError("QUOTA_EXCEEDED", "Two model calls of this project are already running", {
      reasonCode: "quota_exceeded",
      remaining: "unknown",
    }),
  );
  const busy = await f.service.analyze(f.run.id, { model: true });
  expect(f.service.modelStatus(busy)).toMatchObject({
    state: "abstained",
    reasonCode: "quota_exceeded",
  });
  f.complete.mockImplementationOnce(async () => ({
    modelCallId: f.modelCallId,
    output: {
      failureKind: "unknown",
      hypotheses: [],
      recommendedAction: "collect_more_evidence",
      fixTargetHandle: null,
      limitations: [],
      nextSteps: [],
      evidenceGaps: [],
    },
  }));
  const retried = await f.service.analyze(f.run.id, { model: true });
  expect(retried).toMatchObject({ source: "model", modelCallId: f.modelCallId });
  expect(f.complete).toHaveBeenCalledTimes(2);
});
it("a reading that met a busy local writer before the paid call reaches the model on the next request", async () => {
  const f = await fixture();
  const mark = f.service.jobs.mark.bind(f.service.jobs);
  vi.spyOn(f.service.jobs, "mark").mockImplementationOnce(() => {
    throw new ContractError("UNAVAILABLE", "Local writer is busy; retry the operation", {
      reasonCode: "writer_contention",
      retryable: true,
    });
  });
  const busy = await f.service.analyze(f.run.id, { model: true });
  expect(f.complete).not.toHaveBeenCalled();
  expect(f.service.modelStatus(busy)).toMatchObject({
    state: "abstained",
    reasonCode: "writer_contention",
  });
  vi.mocked(f.service.jobs.mark).mockImplementation(mark);
  f.complete.mockImplementationOnce(async () => ({
    modelCallId: f.modelCallId,
    output: {
      failureKind: "unknown",
      hypotheses: [],
      recommendedAction: "collect_more_evidence",
      fixTargetHandle: null,
      limitations: [],
      nextSteps: [],
      evidenceGaps: [],
    },
  }));
  const retried = await f.service.analyze(f.run.id, { model: true });
  expect(retried).toMatchObject({ source: "model", modelCallId: f.modelCallId });
  expect(f.complete).toHaveBeenCalledTimes(1);
});
it("a model reading that outlasts the job lease keeps its lease and is stored", async () => {
  const f = await fixture();
  vi.useFakeTimers({ toFake: ["Date", "setInterval", "clearInterval"] });
  try {
    f.complete.mockImplementationOnce(async () => {
      // The call has no deadline: five minutes is several lease lengths.
      await vi.advanceTimersByTimeAsync(5 * 60_000);
      return {
        modelCallId: f.modelCallId,
        output: {
          failureKind: "unknown",
          hypotheses: [],
          recommendedAction: "collect_more_evidence",
          fixTargetHandle: null,
          limitations: [],
          nextSteps: [],
          evidenceGaps: [],
        },
      };
    });
    const slow = await f.service.analyze(f.run.id, { model: true });
    expect(slow).toMatchObject({ source: "model", modelCallId: f.modelCallId });
    expect(f.service.modelStatus(slow)).toMatchObject({ state: "used" });
  } finally {
    vi.useRealTimers();
  }
});
it("an invalid explicit model choice is refused before any job or provider call", async () => {
  const f = await fixture();
  await expect(
    f.service.analyze(f.run.id, { model: true, provider: "missing" }),
  ).rejects.toMatchObject({
    code: "CAPABILITY_UNAVAILABLE",
    details: { reasonCode: "provider_unavailable", availableProviders: ["fake"] },
  });
  await expect(
    f.service.analyze(f.run.id, { model: true, provider: "fake", modelId: "absent" }),
  ).rejects.toMatchObject({
    code: "CAPABILITY_UNAVAILABLE",
    details: { reasonCode: "model_not_configured", availableModels: ["fake-model", "plain-model"] },
  });
  await expect(
    f.service.analyze(f.run.id, { model: true, provider: "fake", modelId: "plain-model" }),
  ).rejects.toMatchObject({
    code: "CAPABILITY_UNAVAILABLE",
    details: { reasonCode: "model_capability_missing" },
  });
  // A choice without the switch would silently run the rules only.
  await expect(f.service.analyze(f.run.id, { provider: "fake" })).rejects.toMatchObject({
    code: "INVALID_ARGUMENT",
  });
  expect(f.complete).not.toHaveBeenCalled();
  expect(f.db.get("SELECT COUNT(*) AS n FROM analyses")?.n).toBe(0);
  expect(f.db.get("SELECT COUNT(*) AS n FROM job_leases WHERE queue='analysis'")?.n).toBe(0);
});
it("stale source identity is refused before dispatch and unbound Runs disclose missing targets", async () => {
  const bound = await fixture({ source: true });
  bound.detail.repository!.commitSha = "c".repeat(40);
  await expect(
    bound.service.analyze(bound.run.id, { model: true, discoveryId: bound.detail.job.id }),
  ).rejects.toMatchObject({ code: "POLICY_DENIED" });
  expect(bound.complete).not.toHaveBeenCalled();
  const unbound = await fixture({ source: true, unbound: true });
  unbound.complete.mockImplementationOnce(async () => ({
    modelCallId: unbound.modelCallId,
    output: {
      failureKind: "unknown",
      hypotheses: [],
      recommendedAction: "collect_more_evidence",
      fixTargetHandle: null,
      limitations: [],
      nextSteps: [],
      evidenceGaps: [],
    },
  }));
  const result = await unbound.service.analyze(unbound.run.id, {
    model: true,
    discoveryId: unbound.detail.job.id,
  });
  expect(result.fixTarget).toBeUndefined();
  expect(result.limitations).toContain("Frozen Run is unbound; no source targets supplied.");
});

const persistencePlan: ExecutablePlan = {
  schemaVersion: "1.0.0",
  kind: "executable",
  name: "Creation and read",
  type: "backend",
  runner: "http",
  requirementRefs: [],
  steps: [
    {
      id: "create",
      kind: "action",
      operation: "request",
      input: { method: "POST", pathSegments: [{ literal: "items" }] },
    },
    {
      id: "read",
      kind: "action",
      operation: "request",
      input: { method: "GET", pathSegments: [{ literal: "items" }] },
    },
    {
      id: "price",
      kind: "assertion",
      operation: "assert",
      required: true,
      input: { responseStepId: "read", jsonPointer: "/items/0/price" },
      expectation: { predicate: "jsonEquals", value: { literal: 10 } },
    },
  ],
};

it("a passed creation followed by an empty collection recommends persistence inspection without healing", async () => {
  const diagnostic = {
    deepestPrefix: "/items",
    type: "array",
    length: 0,
    firstUnresolvedToken: "0",
  };
  const f = await fixture({
    plan: persistencePlan,
    missing: true,
    step: {
      index: 2,
      error: {
        code: "RuntimeError",
        message: `HTTP jsonEquals expectation was not satisfied; missing JSON pointer: ${JSON.stringify(diagnostic)}`,
      },
    },
  });
  for (const [index, id] of ["create", "read"].entries())
    f.ctx.entities.insert("StepResult", {
      ...f.step,
      id: `stp_00000000-0000-4000-8000-0000000000${index + 10}`,
      workspaceId: f.ctx.workspaceId,
      planStepId: id,
      index,
      status: "passed",
      reasonCode: undefined,
      expected: null,
      observed: 200,
      error: null,
    });
  const analysis = await f.service.analyze(f.run.id);
  expect(analysis.diagnosis?.observation?.absence).toBe("empty_collection");
  expect(analysis.diagnosis?.conclusion.status).toBe("cause_partially_supported");
  expect(analysis.diagnosis?.healing.advice).toBe("not_indicated");
  expect(analysis.diagnosis?.nextSteps[0]?.text).toBe(
    "Inspect the creation response at step create and the read at step read, including entity identity and environment.",
  );
  expect(analysis.diagnosis?.chain.map((item) => [item.stepId, item.verifies])).toEqual([
    ["create", null],
    ["read", null],
    ["price", "read"],
  ]);
  expect(analysis.hypotheses[0]?.support).toBe("partially_supported");
});

async function persistenceRun(plan: ExecutablePlan, step: Partial<StepResult>) {
  const f = await fixture({ plan, step: { index: 2, ...step } });
  for (const [index, id] of ["create", "read"].entries())
    f.ctx.entities.insert("StepResult", {
      ...f.step,
      id: `stp_00000000-0000-4000-8000-0000000000${index + 10}`,
      workspaceId: f.ctx.workspaceId,
      planStepId: id,
      index,
      status: "passed",
      reasonCode: undefined,
      expected: null,
      observed: 200,
      error: null,
    });
  return f;
}
it("a wrong value on a read that follows a passed write recommends persistence inspection", async () => {
  const f = await persistenceRun(persistencePlan, {});
  const analysis = await f.service.analyze(f.run.id);
  expect(analysis.failureKind).toBe("product_bug");
  expect(analysis.diagnosis?.nextSteps[0]?.text).toBe(
    "Inspect the creation response at step create and the read at step read, including entity identity and environment.",
  );
});
it("a wrong value on the write's own response compares the requirement instead", async () => {
  const plan: ExecutablePlan = {
    ...persistencePlan,
    steps: [
      persistencePlan.steps[0]!,
      {
        id: "price",
        kind: "assertion",
        operation: "assert",
        required: true,
        input: { responseStepId: "create", jsonPointer: "/price" },
        expectation: { predicate: "jsonEquals", value: { literal: 10 } },
      },
    ],
  };
  const f = await fixture({ plan, step: { index: 1 } });
  f.ctx.entities.insert("StepResult", {
    ...f.step,
    id: "stp_00000000-0000-4000-8000-000000000010",
    workspaceId: f.ctx.workspaceId,
    planStepId: "create",
    index: 0,
    status: "passed",
    reasonCode: undefined,
    expected: null,
    observed: 200,
    error: null,
  });
  const analysis = await f.service.analyze(f.run.id);
  expect(analysis.diagnosis?.nextSteps[0]?.text).toBe(
    "Compare the observed value at step price with the approved requirement before changing product code or the test.",
  );
});
it("a request that only captures a credential is not a write the read can be blamed on", async () => {
  const credential: ExecutablePlan = {
    ...persistencePlan,
    steps: [
      {
        id: "create",
        kind: "action",
        operation: "request",
        input: {
          method: "POST",
          pathSegments: [{ literal: "session" }],
          capture: [
            {
              name: "token",
              from: "jsonPointer",
              pointer: "/sessionToken",
              valueType: "string",
              sensitive: true,
            },
          ],
        },
      },
      ...persistencePlan.steps.slice(1),
    ],
  };
  const f = await persistenceRun(credential, {});
  const analysis = await f.service.analyze(f.run.id);
  expect(analysis.diagnosis?.nextSteps[0]?.text).toBe(
    "Compare the observed value at step price with the approved requirement before changing product code or the test.",
  );
});

it.each([
  {
    diagnostic: {
      deepestPrefix: "/items/0",
      type: "object",
      keys: ["price"],
      unlistedKeyCount: 0,
      firstUnresolvedToken: "priceCents",
    },
    absence: "missing_field",
  },
  {
    diagnostic: { deepestPrefix: "/items/0", type: "null", firstUnresolvedToken: "price" },
    absence: "null_value",
  },
])(
  "missing pointer $absence remains an observation rather than an approved contract claim",
  async ({ diagnostic, absence }) => {
    const f = await fixture({
      missing: true,
      step: {
        error: {
          code: "RuntimeError",
          message: `HTTP jsonEquals expectation was not satisfied; missing JSON pointer: ${JSON.stringify(diagnostic)}`,
        },
      },
    });
    const analysis = await f.service.analyze(f.run.id);
    expect(analysis.diagnosis?.observation?.absence).toBe(absence);
    expect(analysis.failureKind).toBe("unknown");
    expect(analysis.diagnosis?.conclusion.status).toBe("cause_unknown");
  },
);

it("new persistence requires layered diagnosis and support without breaking historical reads", async () => {
  const f = await fixture();
  const analysis = await f.service.analyze(f.run.id);
  const {
    id: _id,
    workspaceId: _workspace,
    createdAt: _created,
    version: _version,
    extensions: _extensions,
    diagnosis: _diagnosis,
    ...legacy
  } = analysis;
  const persist = f.service as unknown as {
    persist(
      fields: Omit<Analysis, "id" | "workspaceId" | "createdAt" | "version" | "extensions">,
    ): unknown;
  };
  expect(() => persist.persist(legacy)).toThrow(
    "New analysis requires layered diagnosis and hypothesis support",
  );
  expect(() =>
    persist.persist({
      ...legacy,
      diagnosis: analysis.diagnosis,
      hypotheses: analysis.hypotheses.map(({ support: _support, ...hypothesis }) => hypothesis),
    }),
  ).toThrow("New analysis requires layered diagnosis and hypothesis support");
  const historical = {
    ...analysis,
    id: "ana_00000000-0000-4000-8000-000000000098",
    createdAt: "2099-01-01T00:00:00.000Z",
    diagnosis: undefined,
  };
  f.ctx.entities.insert("Analysis", historical);
  const before = f.db.get("SELECT data_json FROM analyses WHERE id=?", historical.id)!.data_json;
  expect(f.service.get(f.run.id)?.diagnosis).toBeUndefined();
  expect(f.db.get("SELECT data_json FROM analyses WHERE id=?", historical.id)!.data_json).toBe(
    before,
  );
});

it("model next steps enrich evidence without overriding code-owned conclusion and healing", async () => {
  const f = await fixture();
  const factual = await f.service.analyze(f.run.id);
  f.complete.mockImplementationOnce(async () => ({
    modelCallId: f.modelCallId,
    output: {
      failureKind: "product_bug",
      hypotheses: [
        { text: "Observed mismatch", supports: ["E2"], contradicts: [], confidence: 0.8 },
      ],
      recommendedAction: "fix_test",
      fixTargetHandle: null,
      limitations: [],
      nextSteps: [
        { action: "inspect_persistence", evidence: ["E2"] },
        { action: "collect_more_evidence", evidence: ["E2"] },
      ],
      evidenceGaps: ["Source cause is unavailable"],
    },
  }));
  const analysis = await f.service.analyze(f.run.id, { model: true });
  expect(analysis.modelCallId).toBe(f.modelCallId);
  expect(analysis.diagnosis?.conclusion).toEqual(factual.diagnosis?.conclusion);
  expect(analysis.diagnosis?.healing).toEqual(factual.diagnosis?.healing);
  expect(analysis.diagnosis?.healing.advice).toBe("not_indicated");
  expect(analysis.diagnosis?.nextSteps[0]?.source).toBe("rules");
  expect(analysis.diagnosis?.nextSteps[1]).toMatchObject({
    source: "model",
    evidenceRefs: [expect.objectContaining({ stepId: f.step.id })],
  });
  // The rules already advised an action, so the model's different actionable step is not shown.
  expect(analysis.diagnosis?.nextSteps).toHaveLength(2);
  expect(analysis.limitations).toContain(
    "1 model next steps outside the recorded cause were not recorded.",
  );
  expect(analysis.diagnosis?.evidenceGaps).toContain("Source cause is unavailable");
  expect(analysis.hypotheses[0]?.support).toBe("partially_supported");
  const request = f.complete.mock.calls[0]![0] as {
    data: { observation: unknown; chain: unknown[] };
  };
  expect(request.data.observation).toMatchObject({ stepId: "price", supports: ["E2"] });
  expect(request.data.chain).toContainEqual(
    expect.objectContaining({ stepId: "price", verifies: "request", supports: ["E2"] }),
  );
});

it.each([{ handle: "E999", rejection: "unknown execution evidence" }])(
  "model next step citing $handle rejects enrichment and preserves rules layers",
  async ({ handle, rejection }) => {
    const f = await fixture();
    const factual = await f.service.analyze(f.run.id);
    f.complete.mockImplementationOnce(async () => ({
      modelCallId: f.modelCallId,
      output: {
        failureKind: "product_bug",
        hypotheses: [
          { text: "Observed mismatch", supports: ["E2"], contradicts: [], confidence: 0.5 },
        ],
        recommendedAction: "fix_product",
        fixTargetHandle: null,
        limitations: [],
        nextSteps: [{ action: "collect_more_evidence", evidence: [handle] }],
        evidenceGaps: [],
      },
    }));
    const analysis = await f.service.analyze(f.run.id, { model: true });
    expect(analysis.modelCallId).toBeNull();
    expect(analysis.diagnosis).toEqual(factual.diagnosis);
    expect(analysis.limitations.some((limitation) => limitation.includes(rejection))).toBe(true);
  },
);

it("model next steps may cite a verified Run handle without establishing a hypothesis cause", async () => {
  const f = await fixture();
  const factual = await f.service.analyze(f.run.id);
  f.complete.mockImplementationOnce(async () => ({
    modelCallId: f.modelCallId,
    output: {
      failureKind: "product_bug",
      hypotheses: [
        { text: "Observed mismatch", supports: ["E2"], contradicts: [], confidence: 0.5 },
      ],
      recommendedAction: "fix_product",
      fixTargetHandle: null,
      limitations: [],
      nextSteps: [{ action: "collect_more_evidence", evidence: ["E1"] }],
      evidenceGaps: [],
    },
  }));
  const analysis = await f.service.analyze(f.run.id, { model: true });
  expect(analysis.modelCallId).toBe(f.modelCallId);
  expect(analysis.diagnosis?.nextSteps.at(-1)).toEqual({
    text: "Collect the response and execution evidence for step price to distinguish product, contract, and environment explanations.",
    source: "model",
    evidenceRefs: factual.facts[0]!.evidenceRefs,
  });
  expect(analysis.diagnosis?.conclusion).toEqual(factual.diagnosis?.conclusion);
  expect(analysis.diagnosis?.healing).toEqual(factual.diagnosis?.healing);
});

it("model next steps are rendered by the application and dropped when they do not fit the recorded cause", async () => {
  const f = await fixture();
  const factual = await f.service.analyze(f.run.id);
  f.complete.mockImplementationOnce(async () => ({
    modelCallId: f.modelCallId,
    output: {
      failureKind: "product_bug",
      hypotheses: [
        { text: "Observed mismatch", supports: ["E2"], contradicts: [], confidence: 0.5 },
      ],
      recommendedAction: "fix_product",
      fixTargetHandle: null,
      limitations: [],
      nextSteps: [
        { action: "restore_environment", evidence: ["E1"] },
        { action: "review_healing_proposal", evidence: ["E2"] },
        { action: "compare_requirement", evidence: ["E2"] },
      ],
      evidenceGaps: [],
    },
  }));
  const analysis = await f.service.analyze(f.run.id, { model: true });
  expect(analysis.modelCallId).toBe(f.modelCallId);
  // The rules already advise comparing the requirement, so only the two misfits are counted.
  expect(analysis.diagnosis?.nextSteps).toEqual(factual.diagnosis?.nextSteps);
  expect(analysis.limitations).toContain(
    "2 model next steps outside the recorded cause were not recorded.",
  );
});

it("a model cause without an execution-supported hypothesis keeps the rules cause and the typed steps", async () => {
  const f = await fixture();
  const factual = await f.service.analyze(f.run.id);
  f.complete.mockImplementationOnce(async () => ({
    modelCallId: f.modelCallId,
    output: {
      failureKind: "product_bug",
      hypotheses: [],
      recommendedAction: "fix_product",
      fixTargetHandle: null,
      limitations: [],
      nextSteps: [{ action: "collect_more_evidence", evidence: ["E2"] }],
      evidenceGaps: [],
    },
  }));
  const analysis = await f.service.analyze(f.run.id, { model: true });
  expect(analysis.modelCallId).toBe(f.modelCallId);
  expect(analysis.failureKind).toBe(factual.failureKind);
  expect(analysis.recommendedAction).toBe(factual.recommendedAction);
  expect(analysis.hypotheses).toEqual(factual.hypotheses);
  expect(analysis.limitations).toContain(
    "A model cause without a hypothesis supported by execution observation was not recorded.",
  );
  expect(analysis.limitations).not.toEqual(
    expect.arrayContaining([expect.stringContaining("Model enrichment abstained")]),
  );
  expect(analysis.diagnosis?.nextSteps.at(-1)).toMatchObject({
    source: "model",
    text: "Collect the response and execution evidence for step price to distinguish product, contract, and environment explanations.",
  });
});

it("a passed Run records no model next steps because there is no failure to advise on", async () => {
  const f = await fixture({ passed: true });
  f.complete.mockImplementationOnce(async () => ({
    modelCallId: f.modelCallId,
    output: {
      failureKind: "unknown",
      hypotheses: [],
      recommendedAction: "collect_more_evidence",
      fixTargetHandle: null,
      limitations: [],
      nextSteps: [{ action: "collect_more_evidence", evidence: ["E1"] }],
      evidenceGaps: [],
    },
  }));
  const analysis = await f.service.analyze(f.run.id, { model: true });
  expect(analysis.modelCallId).toBe(f.modelCallId);
  expect(analysis.diagnosis?.nextSteps.filter((item) => item.source === "model")).toEqual([]);
  expect(analysis.limitations).toContain(
    "1 model next steps outside the recorded cause were not recorded.",
  );
});

it("relational chain caps at 64 while retaining the failed step and its early response", async () => {
  const plan: ExecutablePlan = {
    ...persistencePlan,
    steps: [
      ...Array.from({ length: 70 }, (_, index) => ({
        id: `read-${index}`,
        kind: "action" as const,
        operation: "request" as const,
        input: { method: "GET" as const, pathSegments: [{ literal: "items" }] },
      })),
      {
        id: "price",
        kind: "assertion",
        operation: "assert",
        input: { responseStepId: "read-0" },
        expectation: { predicate: "jsonEquals", value: { literal: 10 } },
      },
    ],
  };
  const f = await fixture({ plan, step: { index: 70 } });
  for (let index = 0; index < 70; index++)
    f.ctx.entities.insert("StepResult", {
      ...f.step,
      id: `stp_00000000-0000-4000-8000-${String(index + 100).padStart(12, "0")}`,
      workspaceId: f.ctx.workspaceId,
      planStepId: `read-${index}`,
      index,
      status: "passed",
      reasonCode: undefined,
      expected: null,
      observed: 200,
      error: null,
    });
  const analysis = await f.service.analyze(f.run.id);
  expect(analysis.diagnosis?.chain).toHaveLength(64);
  expect(analysis.diagnosis?.chain.map((item) => item.stepId)).toContain("read-0");
  expect(analysis.diagnosis?.chain.map((item) => item.stepId)).toContain("price");
  expect(analysis.diagnosis?.evidenceGaps).toContain(
    "Relational chain truncated: 7 step results omitted; failed and referenced steps are prioritized.",
  );
});

it("relational baseline compares latest compatible passing run without dynamic action value noise", async () => {
  const f = await fixture({ plan: persistencePlan, step: { index: 2 } });
  const request: StepResult = {
    ...f.step,
    id: "stp_00000000-0000-4000-8000-000000000010",
    planStepId: "read",
    index: 1,
    status: "passed",
    reasonCode: undefined,
    observed: { id: "dynamic-current" },
    expected: null,
    error: null,
  };
  f.ctx.entities.insert("StepResult", { ...request, workspaceId: f.ctx.workspaceId });
  const otherEnvironment = {
    ...f.ctx.entities.get("EnvironmentRevision", f.ctx.workspaceId, f.run.environmentRevisionId)!,
    workspaceId: f.ctx.workspaceId,
    id: "evr_00000000-0000-4000-8000-000000000098",
  };
  const environmentRow = f.db.get(
    "SELECT environment_id FROM environment_revisions WHERE workspace_id=? AND id=?",
    f.ctx.workspaceId,
    f.run.environmentRevisionId,
  )!;
  f.ctx.entities.insert("EnvironmentRevision", otherEnvironment, {
    environmentId: String(environmentRow.environment_id),
  });
  for (const [index, environment, assertionValue] of [
    [1, f.run.environmentRevisionId, 10],
    [2, f.run.environmentRevisionId, 12],
    [3, otherEnvironment.id, 11],
  ] as const) {
    const baseline = {
      ...f.run,
      workspaceId: f.ctx.workspaceId,
      environmentRevisionId: environment,
      id: `run_00000000-0000-4000-8000-0000000000${index + 70}`,
      createdAt: `2026-10-0${index + 1}T00:00:00.000Z`,
      outcome: "passed",
      status: "passed",
      gate: "passed",
    };
    f.ctx.entities.insert("Run", baseline);
    const fixture = relationalFixtures(f.db).find((item) => item.kind === "Attempt")!;
    const attemptId = `att_00000000-0000-4000-8000-0000000000${index + 70}`;
    Object.assign(fixture.dto, {
      id: attemptId,
      runId: baseline.id,
      phase: "completed",
      outcome: "passed",
    });
    Object.assign(fixture.row, {
      id: attemptId,
      run_id: baseline.id,
      phase: "completed",
      outcome: "passed",
      fence: index + 1,
      job_id: f.db.get("SELECT job_id FROM attempts WHERE id=?", f.step.attemptId)!.job_id,
      data_json: canonicalJson(fixture.dto),
    });
    const insert = fixtureInsert(fixture);
    f.db.run(insert.sql, ...insert.values);
    f.ctx.entities.insert("StepResult", {
      ...request,
      id: `stp_00000000-0000-4000-8000-0000000000${index + 70}`,
      attemptId,
      workspaceId: f.ctx.workspaceId,
      status: index === 2 ? "passed" : "failed",
      reasonCode: index === 2 ? undefined : "assertion_mismatch",
      observed: { id: `dynamic-${index}` },
    });
    f.ctx.entities.insert("StepResult", {
      ...f.step,
      id: `stp_00000000-0000-4000-8000-0000000000${index + 80}`,
      attemptId,
      workspaceId: f.ctx.workspaceId,
      status: "passed",
      reasonCode: undefined,
      observed: assertionValue,
    });
  }
  const analysis = await f.service.analyze(f.run.id);
  expect(analysis.diagnosis?.chain.find((item) => item.stepId === "read")?.baseline).toBe("same");
  expect(analysis.diagnosis?.chain.find((item) => item.stepId === "price")?.baseline).toBe(
    "different",
  );
});

it("latest attempt evidence excludes obsolete failures and historical analyses receive immutable successors", async () => {
  const f = await fixture();
  const legacy = {
    ...relationalFixtures(f.db).find((item) => item.kind === "Analysis")!.dto,
    workspaceId: f.ctx.workspaceId,
  };
  f.ctx.entities.insert("Analysis", legacy as never);
  const before = f.db.get(
    "SELECT data_json FROM analyses WHERE id=?",
    String(legacy.id),
  )!.data_json;
  const attemptFixture = relationalFixtures(f.db).find((item) => item.kind === "Attempt")!;
  const attemptId = "att_00000000-0000-4000-8000-000000000098";
  Object.assign(attemptFixture.dto, {
    id: attemptId,
    number: 2,
    phase: "completed",
    outcome: "passed",
  });
  Object.assign(attemptFixture.row, {
    id: attemptId,
    number: 2,
    phase: "completed",
    outcome: "passed",
    fence: 2,
    data_json: canonicalJson(attemptFixture.dto),
  });
  const insert = fixtureInsert(attemptFixture);
  f.db.run(insert.sql, ...insert.values);
  f.ctx.entities.insert("StepResult", {
    ...f.step,
    workspaceId: f.ctx.workspaceId,
    id: "stp_00000000-0000-4000-8000-000000000098",
    attemptId,
    status: "passed",
    reasonCode: undefined,
    observed: 10,
  });
  const analysis = await f.service.analyze(f.run.id);
  expect(analysis.diagnosis).toBeDefined();
  expect(analysis.diagnosis?.chain).toHaveLength(1);
  expect(analysis.diagnosis?.chain[0]?.status).toBe("passed");
  expect(analysis.failureKind).toBe("unknown");
  expect(analysis.id).not.toBe(legacy.id);
  expect(f.db.get("SELECT data_json FROM analyses WHERE id=?", String(legacy.id))!.data_json).toBe(
    before,
  );
});

it("rejected model response records actual unsupported hypothesis count without accepting its cause", async () => {
  const f = await fixture();
  f.complete.mockImplementationOnce(async () => ({
    modelCallId: f.modelCallId,
    output: {
      failureKind: "test_fragility",
      hypotheses: [
        { text: "Ungrounded drift", supports: ["E1"], contradicts: [], confidence: 0.9 },
      ],
      recommendedAction: "fix_test",
      fixTargetHandle: null,
      limitations: [],
      nextSteps: [],
      evidenceGaps: [],
    },
  }));
  const analysis = await f.service.analyze(f.run.id, { model: true });
  expect(analysis.modelCallId).toBeNull();
  expect(analysis.failureKind).toBe("product_bug");
  expect(
    f.service.jobs
      .forTarget(f.ctx.workspaceId, "analysis", f.run.id)
      .find((job) => job.payload.operation === "model")?.progress.unsupportedClaims,
  ).toBe(1);
});

it("observed network failure supports environment restoration rather than healing", async () => {
  const f = await fixture({
    requestOnly: true,
    step: { error: { code: "ECONNREFUSED", message: "Connection refused" } },
  });
  const analysis = await f.service.analyze(f.run.id);
  expect(analysis.failureKind).toBe("environment");
  expect(analysis.hypotheses[0]?.support).toBe("supported");
  expect(analysis.diagnosis?.conclusion.status).toBe("cause_supported");
  expect(analysis.diagnosis?.nextSteps[0]?.text).toBe(
    "Restore the observed environment or network condition and rerun the unchanged test.",
  );
  expect(analysis.diagnosis?.healing.advice).toBe("not_indicated");
});

it("ambiguous locator candidates produce manual-only advice without a supported cause", async () => {
  const f = await fixture({
    plan: {
      ...persistencePlan,
      type: "frontend",
      runner: "playwright",
      steps: [
        {
          id: "price",
          kind: "action",
          operation: "click",
          input: { locator: { by: "role", role: "button", name: "Old checkout", exact: true } },
        },
      ],
    },
    step: { reasonCode: "assertion_timeout", observed: null, expected: null },
  });
  await attachLocatorEvidence(f, 2);
  const analysis = await f.service.analyze(f.run.id);
  expect(analysis.failureKind).toBe("unknown");
  expect(analysis.diagnosis?.conclusion.status).toBe("cause_unknown");
  expect(analysis.diagnosis?.healing.advice).toBe("manual_review_only");
  expect(analysis.diagnosis?.nextSteps[0]?.text).toContain("Inspect locator candidates");
});

it("an assertion step whose locator matched nothing gets no healing advice, since its locator is what it checks", async () => {
  const f = await fixture({
    plan: {
      ...persistencePlan,
      type: "frontend",
      runner: "playwright",
      steps: [
        {
          id: "price",
          kind: "assertion",
          operation: "assert",
          input: { locator: { by: "role", role: "button", name: "Old checkout", exact: true } },
          expectation: { predicate: "visible" },
        },
      ],
    },
    step: { reasonCode: "assertion_timeout", observed: null, expected: null },
  });
  await attachLocatorEvidence(f, 2);
  const diagnosis = (await f.service.analyze(f.run.id)).diagnosis!;
  expect(diagnosis.conclusion.status).toBe("cause_unknown");
  expect(diagnosis.nextSteps[0]?.text).toContain("Inspect locator candidates");
  expect(diagnosis.healing.advice).toBe("not_indicated");
  expect(diagnosis.healing.reason).toContain("step price is an assertion");
  expect(diagnosis.healing.reason).toContain("save a corrected revision");
});

it("an action that timed out on its target says so in its fact; an assertion timeout does not", async () => {
  const message = "Locator did not match an attached element before the step deadline";
  const timedOut = (kind: "action" | "assertion") =>
    fixture({
      plan: {
        ...persistencePlan,
        type: "frontend",
        runner: "playwright",
        steps: [
          kind === "action"
            ? {
                id: "price",
                kind: "action",
                operation: "click",
                input: { locator: { by: "role", role: "button", name: "Pay", exact: true } },
              }
            : {
                id: "price",
                kind: "assertion",
                operation: "assert",
                input: { locator: { by: "role", role: "button", name: "Pay", exact: true } },
                expectation: { predicate: "visible" },
              },
        ],
      },
      step: {
        reasonCode: "assertion_timeout",
        observed: null,
        expected: null,
        error: { code: "assertion_timeout", message: `${message}.` },
      },
    });
  const factOf = async (f: Awaited<ReturnType<typeof fixture>>) =>
    (await f.service.analyze(f.run.id)).facts.find((fact) => fact.text.startsWith("Step price"))
      ?.text;
  expect(await factOf(await timedOut("action"))).toBe(
    `Step price (click) was failed: assertion_timeout (an action, not an assertion: ${message}).`,
  );
  expect(await factOf(await timedOut("assertion"))).toBe(
    "Step price (assert) was failed: assertion_timeout.",
  );
});
it("a step the runner refused before comparing a value names the runner's message; a compared mismatch does not", async () => {
  const failedText = (step: { observed: unknown; expected: unknown }) =>
    fixture({
      plan: {
        ...persistencePlan,
        type: "frontend",
        runner: "playwright",
        steps: [
          {
            id: "price",
            kind: "assertion",
            operation: "assert",
            input: {
              locator: {
                by: "text",
                value: "demo offline",
                exact: true,
                container: { by: "css", value: "article.result .engines" },
              },
            },
            expectation: { predicate: "visible" },
          },
        ],
      },
      step: {
        reasonCode: "assertion_mismatch",
        ...step,
        error: { code: "Error", message: "Locator is ambiguous; matched 4" },
      },
    });
  const refused = await failedText({ observed: null, expected: null });
  const analysis = await refused.service.analyze(refused.run.id);
  expect(analysis.facts.find((fact) => fact.text.startsWith("Step price"))?.text).toBe(
    "Step price (assert) was failed: assertion_mismatch (no value was compared: Locator is ambiguous; matched 4).",
  );
  expect(analysis.diagnosis?.observation?.summary).toContain(
    "(no value was compared: Locator is ambiguous; matched 4)",
  );
  const compared = await failedText({ observed: "hidden", expected: "visible" });
  expect(
    (await compared.service.analyze(compared.run.id)).facts.find((fact) =>
      fact.text.startsWith("Step price"),
    )?.text,
  ).toBe("Step price (assert) was failed: assertion_mismatch.");
});

async function unmatchedClickFixture() {
  const f = await fixture({
    plan: {
      ...persistencePlan,
      type: "frontend",
      runner: "playwright",
      steps: [
        {
          id: "price",
          kind: "action",
          operation: "click",
          input: { locator: { by: "role", role: "button", name: "Old checkout", exact: true } },
        },
      ],
    },
    step: { reasonCode: "assertion_timeout", observed: null, expected: null },
  });
  await attachLocatorEvidence(f, 2);
  return f;
}

it("manual-only advice for a test that never passed says there is no baseline and that a proposal can still be reviewed", async () => {
  const f = await unmatchedClickFixture();
  const healing = (await f.service.analyze(f.run.id)).diagnosis?.healing;
  expect(healing?.advice).toBe("manual_review_only");
  expect(healing?.reason).toContain("No passing run of this test revision exists");
  expect(healing?.reason).toContain("A healing proposal can still be requested");
});

it("manual-only advice with a passing baseline that matches no control says so instead of claiming there is no baseline", async () => {
  const f = await unmatchedClickFixture();
  f.ctx.entities.insert("Run", {
    ...f.run,
    workspaceId: f.ctx.workspaceId,
    id: "run_00000000-0000-4000-8000-000000000071",
    createdAt: "2026-10-02T00:00:00.000Z",
    outcome: "passed",
    status: "passed",
    gate: "passed",
  });
  const healing = (await f.service.analyze(f.run.id)).diagnosis?.healing;
  expect(healing?.advice).toBe("manual_review_only");
  expect(healing?.reason).toContain("Passing runs of this test revision exist");
  expect(healing?.reason).not.toContain("No passing run");
  expect(healing?.reason).toContain("A healing proposal can still be requested");
});

it("a model cause the rules did not reach becomes the conclusion, while the code-owned healing posture stays", async () => {
  const f = await unmatchedClickFixture();
  const factual = await f.service.analyze(f.run.id);
  expect(factual.diagnosis?.conclusion.status).toBe("cause_unknown");
  f.complete.mockImplementationOnce(async () => ({
    modelCallId: f.modelCallId,
    output: {
      failureKind: "test_fragility",
      hypotheses: [
        { text: "The button was renamed", supports: ["E2"], contradicts: [], confidence: 0.9 },
      ],
      recommendedAction: "fix_test",
      fixTargetHandle: null,
      limitations: [],
      nextSteps: [],
      evidenceGaps: [],
    },
  }));
  const analysis = await f.service.analyze(f.run.id, { model: true });
  expect(analysis).toMatchObject({ source: "model", failureKind: "test_fragility" });
  // The text reader sees the recorded cause, not the rules' "cause unknown".
  expect(analysis.diagnosis?.conclusion.status).toBe("cause_partially_supported");
  expect(analysis.diagnosis?.conclusion.text).toContain("test fragility");
  expect(analysis.diagnosis?.healing).toEqual(factual.diagnosis?.healing);
  expect(analysis.diagnosis?.nextSteps[0]).toEqual(factual.diagnosis?.nextSteps[0]);
});

function clickPlan(name: string, stepId = "price"): ExecutablePlan {
  return {
    ...persistencePlan,
    type: "frontend",
    runner: "playwright",
    steps: [
      {
        id: stepId,
        description: `Click ${name}.`,
        kind: "action",
        operation: "click",
        input: { locator: { by: "role", role: "button", name, exact: true } },
      },
      {
        id: "landed",
        kind: "assertion",
        operation: "assert",
        required: true,
        description: "Lands on the dashboard",
        input: { pageAlias: "main" },
        expectation: { predicate: "urlEquals", value: { literal: "/dashboard" } },
      },
    ],
  };
}
/** A failed click of a child revision whose parent revision passed two runs in this environment. */
async function childOfPassingParentFixture(parentPlan: ExecutablePlan) {
  const f = await fixture({
    plan: clickPlan("Log in"),
    parentPlan,
    step: { reasonCode: "assertion_timeout", observed: null, expected: null },
  });
  await attachLocatorEvidence(f, 2);
  for (const suffix of ["81", "82"])
    f.ctx.entities.insert("Run", {
      ...f.run,
      workspaceId: f.ctx.workspaceId,
      id: `run_00000000-0000-4000-8000-0000000000${suffix}`,
      createdAt: `2026-10-02T00:00:0${suffix.slice(1)}.000Z`,
      revisionId: "rev_00000000-0000-4000-8000-0000000000a1",
      outcome: "passed",
      status: "passed",
      gate: "passed",
    });
  return f;
}

it("a failed step changed from a parent revision that passed here is attributed to the test change", async () => {
  // The parent spells out the plan defaults (required, timeoutMs) the child leaves implicit; only the locator differs.
  const f = await childOfPassingParentFixture(materializePlanDefaults(clickPlan("Sign in")));
  const analysis = await f.service.analyze(f.run.id);
  expect(analysis).toMatchObject({ failureKind: "test_fragility", recommendedAction: "fix_test" });
  const diagnosis = analysis.diagnosis!;
  expect(diagnosis.conclusion.status).toBe("cause_partially_supported");
  expect(diagnosis.conclusion.text).toContain("Step price was changed in this revision");
  expect(diagnosis.conclusion.text).toContain("rev_00000000-0000-4000-8000-0000000000a1");
  expect(diagnosis.conclusion.text).toContain("(changed: input.locator)");
  expect(diagnosis.conclusion.text).toContain("passed 2 runs");
  expect(diagnosis.conclusion.text).toContain("not evidence of a product change");
  expect(diagnosis.nextSteps[0]?.text).toContain("save a corrected revision");
  expect(diagnosis.nextSteps[0]?.text).toContain("CLI: test revision create");
  expect(diagnosis.healing.advice).toBe("manual_review_only");
  // Evidence references stay bound to the analyzed Run; the parent's runs are named in the text.
  expect(
    analysis.hypotheses[0]?.supports.every(
      (ref) => ref.runId === undefined || ref.runId === f.run.id,
    ),
  ).toBe(true);
  expect(analysis.hypotheses[0]?.supports.length).toBeGreaterThan(0);
});

it("a failed step the parent revision does not have counts as changed", async () => {
  const f = await childOfPassingParentFixture(clickPlan("Log in", "other"));
  const diagnosis = (await f.service.analyze(f.run.id)).diagnosis!;
  expect(diagnosis.conclusion.text).toContain("the parent has no step with this id");
});

it("a failed step identical to the passing parent revision's keeps the unknown cause and cites the parent only in the healing reason", async () => {
  // Spelled-out defaults are not a change.
  const f = await childOfPassingParentFixture(materializePlanDefaults(clickPlan("Log in")));
  const analysis = await f.service.analyze(f.run.id);
  expect(analysis.failureKind).toBe("unknown");
  expect(analysis.diagnosis?.conclusion.status).toBe("cause_unknown");
  expect(analysis.diagnosis?.conclusion.text).not.toContain("parent revision");
  expect(analysis.diagnosis?.nextSteps[0]?.text).toContain("Inspect locator candidates");
  const healing = analysis.diagnosis?.healing;
  expect(healing?.advice).toBe("manual_review_only");
  expect(healing?.reason).toContain("No passing run of this test revision exists");
  expect(healing?.reason).toContain(
    "Its parent revision rev_00000000-0000-4000-8000-0000000000a1 passed 2 runs",
  );
});

it("a click that timed out on a locator matching nothing reports the locator and the visible candidates, not a null value", async () => {
  const locator = { by: "role" as const, role: "button", name: "Log in", exact: true };
  const f = await fixture({
    plan: {
      ...persistencePlan,
      type: "frontend",
      runner: "playwright",
      steps: [{ id: "price", kind: "action", operation: "click", input: { locator } }],
    },
    step: { reasonCode: "assertion_timeout", observed: null, expected: null },
  });
  const identity = (role: string, name: string, tag: string) => ({
    role,
    name,
    tag,
    type: "",
    attributes: {},
  });
  const candidates = [
    identity("button", "Sign in", "button"),
    identity("link", "Forgot password", "a"),
  ].map((item) => ({
    ...item,
    fingerprint: locatorFingerprint(item),
    matched: false,
    visible: true,
  }));
  const payload = {
    schemaVersion: "1.0.0" as const,
    stepId: "price",
    phase: "after" as const,
    frameOrigin: "http://localhost",
    locator,
    cardinality: 0,
    candidates,
    truncated: false,
    state: null,
  };
  const { locatorPath } = await attachLocatorRecord(f, {
    ...payload,
    evidenceHash: semanticHash(payload),
  });
  const analysis = await f.service.analyze(f.run.id);
  const observation = analysis.diagnosis?.observation;
  expect(observation?.expected).toContain("Log in");
  expect(observation?.observed).toContain("0 elements matched");
  expect(observation?.observed).toContain('button "Sign in"');
  expect(observation?.observed).not.toContain("Forgot password");
  expect(observation?.absence).not.toBe("null_value");
  expect(observation?.evidenceRefs).toContainEqual(
    expect.objectContaining({ relativePath: locatorPath }),
  );
  expect(analysis.diagnosis?.conclusion.status).toBe("cause_unknown");
});

const containedLocator = {
  by: "role" as const,
  role: "link",
  name: "New session",
  exact: true,
  container: { by: "role" as const, role: "main" },
};
const locatorAssertionPlan = (
  expectation:
    | { predicate: "hidden" }
    | { predicate: "countEquals" | "countAtLeast" | "countAtMost"; value: number },
) => ({
  ...persistencePlan,
  type: "frontend" as const,
  runner: "playwright" as const,
  steps: [
    {
      id: "price",
      kind: "assertion" as const,
      operation: "assert" as const,
      required: true,
      description: "Locator expectation",
      input: { locator: containedLocator },
      expectation,
    },
  ],
});

it.each([
  [{ predicate: "hidden" as const }, "No visible element matching locator"],
  [{ predicate: "countEquals" as const, value: 2 }, "2 elements matching locator"],
  [{ predicate: "countAtLeast" as const, value: 2 }, "At least 2 elements matching locator"],
  [{ predicate: "countAtMost" as const, value: 1 }, "At most 1 element matching locator"],
])(
  "a failed %j locator assertion states its own expectation, not one element",
  async (expectation, wanted) => {
    const f = await fixture({
      plan: locatorAssertionPlan(expectation),
      step: { reasonCode: "assertion_mismatch", observed: null, expected: null },
    });
    const identity = { role: "link", name: "New session", tag: "a", type: "", attributes: {} };
    const payload = {
      schemaVersion: "1.0.0" as const,
      stepId: "price",
      phase: "after" as const,
      frameOrigin: "http://localhost",
      locator: containedLocator,
      cardinality: 1,
      candidates: [
        { ...identity, fingerprint: locatorFingerprint(identity), matched: true, visible: true },
      ],
      truncated: false,
      state: null,
    };
    await attachLocatorRecord(f, { ...payload, evidenceHash: semanticHash(payload) });
    const analysis = await f.service.analyze(f.run.id);
    const observation = analysis.diagnosis?.observation;
    expect(observation?.expected).toContain(wanted);
    expect(observation?.expected).not.toContain("One element matching");
    expect(observation?.observed).toContain("1 element matched (1 visible)");
  },
);

it("a failed locator step whose locator evidence was not recorded is evidence_unavailable, not a null value", async () => {
  const f = await fixture({
    plan: locatorAssertionPlan({ predicate: "hidden" }),
    step: { reasonCode: "assertion_timeout", observed: null, expected: null },
  });
  const analysis = await f.service.analyze(f.run.id);
  const diagnosis = analysis.diagnosis!;
  expect(diagnosis.observation?.absence).toBe("evidence_unavailable");
  expect(diagnosis.evidenceGaps.some((gap) => gap.includes("locator evidence"))).toBe(true);
  const alternatives = diagnosis.alternatives.map((item) => item.text).join(" ");
  expect(alternatives).not.toMatch(/response shape|requested entity/iu);
});

it("layered observations remain bounded and scrubbed while retaining immutable evidence references", async () => {
  vi.stubEnv("TESTMASTER_DIAGNOSIS_SECRET", "sentinel-private-value");
  try {
    const f = await fixture({
      step: {
        observed: {
          password: "sentinel-private-value",
          visible: "sentinel-private-value",
          text: "x".repeat(513),
        },
      },
    });
    const analysis = await f.service.analyze(f.run.id);
    expect(JSON.stringify(analysis.diagnosis)).not.toContain("sentinel-private-value");
    expect(analysis.diagnosis?.observation?.observed).toContain("string_limit");
    expect(analysis.diagnosis?.observation?.observed?.length).toBeLessThanOrEqual(2000);
    expect(analysis.diagnosis?.observation?.evidenceRefs).toContainEqual(
      expect.objectContaining({ stepId: f.step.id }),
    );
  } finally {
    vi.unstubAllEnvs();
  }
});

async function attachTerminalProcess(
  f: Awaited<ReturnType<typeof fixture>>,
  metadata: Record<string, unknown>,
  shape: { relativePath: string; kind: string } = {
    relativePath: "terminal/go.json",
    kind: "terminal.process",
  },
) {
  const fixtures = relationalFixtures(f.db);
  const snapshot = fixtures.find((item) => item.kind === "Snapshot")!;
  const artifact = fixtures.find((item) => item.kind === "Artifact")!;
  for (const item of [snapshot, artifact]) {
    if (item.kind === "Artifact") {
      Object.assign(item.dto, { state: "available", hash: "a".repeat(64) });
      item.row.state = "available";
      item.row.hash = "a".repeat(64);
      item.row.data_json = canonicalJson(item.dto);
    }
    const insert = fixtureInsert(item);
    f.db.run(insert.sql, ...insert.values);
  }
  const entries = [
    {
      artifactId: artifact.dto.id,
      relativePath: shape.relativePath,
      kind: shape.kind,
      sizeBytes: 300,
      state: "available",
      redactionStatus: "sanitized",
      sha256: "a".repeat(64),
    },
  ];
  vi.mocked(f.artifacts.get).mockResolvedValue({
    manifest: { snapshotId: snapshot.dto.id, attemptId: f.step.attemptId, entries },
  } as never);
  f.artifacts.read = vi.fn(async () => ({
    bytes: Buffer.from(JSON.stringify(metadata)),
  })) as never;
  return { artifactId: String(artifact.dto.id) };
}
const hangingProcessPlan = {
  schemaVersion: "1.0.0",
  kind: "executable",
  name: "Hang",
  type: "cli",
  runner: "terminal",
  requirementRefs: [],
  steps: [
    {
      id: "go",
      kind: "action",
      operation: "run",
      description: "Run",
      input: { program: { path: "/bin/sleep" }, args: [{ literal: "60" }] },
      timeoutMs: 100,
    },
  ],
} as unknown as ExecutablePlan;
const processStep = {
  planStepId: "go",
  reasonCode: "assertion_timeout",
  expected: null,
  observed: null,
  error: { code: "assertion_timeout", message: "Process go did not exit within 100 ms" },
} satisfies Partial<StepResult>;

it("terminal process timeout is diagnosed from the terminal.process artifact, not as a null value", async () => {
  const f = await fixture({ plan: hangingProcessPlan, step: processStep });
  const { artifactId } = await attachTerminalProcess(f, {
    stepId: "go",
    kind: "run",
    exitCode: null,
    signal: "SIGKILL",
    durationMs: 100,
    timedOut: true,
    lingeringProcesses: 2,
    stdout: { bytes: 4, sha256: "b".repeat(64), truncated: false },
  });
  const analysis = await f.service.analyze(f.run.id);
  const diagnosis = analysis.diagnosis!;
  expect(analysis.failureKind).toBe("unknown");
  expect(diagnosis.observation?.absence).toBeNull();
  expect(diagnosis.observation?.expected).not.toBeNull();
  expect(diagnosis.observation?.expected).not.toBe("null");
  expect(diagnosis.observation?.observed).toContain("SIGKILL");
  expect(diagnosis.observation?.observed).toContain("2");
  expect(diagnosis.observation?.evidenceRefs).toContainEqual(
    expect.objectContaining({ artifactId, relativePath: "terminal/go.json" }),
  );
  expect(diagnosis.conclusion.status).toBe("cause_unknown");
  expect(diagnosis.evidenceGaps.some((gap) => gap.includes("outlived"))).toBe(true);
  expect(diagnosis.nextSteps.length).toBeGreaterThan(0);
  for (const step of diagnosis.nextSteps) expect(step.text).not.toMatch(/response/iu);
  expect(diagnosis.nextSteps[0]?.text).toContain("terminal/go.stdout.txt");
  expect(diagnosis.nextSteps[0]?.evidenceRefs).toContainEqual(
    expect.objectContaining({ artifactId }),
  );
});

it("a terminal step failure without a recorded timeout keeps the null observation and unknown cause", async () => {
  const f = await fixture({ plan: hangingProcessPlan, step: processStep });
  await attachTerminalProcess(f, {
    stepId: "go",
    kind: "run",
    exitCode: 1,
    signal: null,
    durationMs: 30,
    timedOut: false,
    lingeringProcesses: 0,
  });
  const analysis = await f.service.analyze(f.run.id);
  const diagnosis = analysis.diagnosis!;
  expect(diagnosis.observation?.absence).toBe("null_value");
  expect(diagnosis.conclusion.status).toBe("cause_unknown");
  expect(diagnosis.evidenceGaps.some((gap) => gap.includes("outlived"))).toBe(false);
  expect(diagnosis.nextSteps.length).toBeGreaterThan(0);
  for (const step of diagnosis.nextSteps) expect(step.text).not.toMatch(/response/iu);
  expect(diagnosis.nextSteps[0]?.text).not.toContain("terminal/go.stdout.txt");
});
it("a failed step lists a visible unnamed form control and still omits hidden or non-form nodes", async () => {
  const f = await fixture({ passed: false });
  const control = (tag: string, visible: boolean) => {
    const identity = {
      role: "",
      name: "",
      tag,
      type: tag === "input" ? "password" : "",
      attributes: { id: "pw", placeholder: "Password" },
    };
    return { ...identity, fingerprint: locatorFingerprint(identity), matched: false, visible };
  };
  await attachLocatorEvidence(f, 1, [
    control("input", true),
    control("input", false),
    control("div", true),
  ]);
  await f.service.analyze(f.run.id, { model: true });
  const request = f.complete.mock.calls[0]![0] as {
    data: { measurements: Record<string, unknown>[] };
  };
  const locator = request.data.measurements.find((item) => item.kind === "locator")!;
  const listed = locator.candidates as Record<string, unknown>[];
  expect(listed).toHaveLength(2);
  expect(listed).toContainEqual(
    expect.objectContaining({
      tag: "input",
      type: "password",
      visible: true,
      attributes: expect.objectContaining({ placeholder: "Password" }),
    }),
  );
  expect(locator.unlistedCandidateCount).toBe(55 - 2);
});
it("artifact availability facts aggregate per kind and cite every artifact of that kind", async () => {
  const f = await fixture({ passed: false });
  const fixtures = relationalFixtures(f.db);
  const snapshot = fixtures.find((item) => item.kind === "Snapshot")!;
  const artifact = fixtures.find((item) => item.kind === "Artifact")!;
  Object.assign(artifact.dto, { state: "available", hash: "a".repeat(64) });
  artifact.row.state = "available";
  artifact.row.hash = "a".repeat(64);
  artifact.row.data_json = canonicalJson(artifact.dto);
  for (const item of [snapshot, artifact]) {
    const insert = fixtureInsert(item);
    f.db.run(insert.sql, ...insert.values);
  }
  const entry = (relativePath: string, kind: string) => ({
    artifactId: artifact.dto.id,
    relativePath,
    kind,
    sizeBytes: 10,
    state: "available",
    redactionStatus: "sanitized",
    sha256: "a".repeat(64),
  });
  const entries = [
    entry("logs/container.log", "log"),
    entry("logs/egress.ndjson", "network"),
    entry("logs/runner.log", "log"),
  ];
  vi.mocked(f.artifacts.get).mockResolvedValue({
    manifest: { snapshotId: snapshot.dto.id, attemptId: f.step.attemptId, entries },
  } as never);
  const analysis = await f.service.analyze(f.run.id);
  const availability = analysis.facts.filter((fact) => fact.text.startsWith("Verified "));
  expect(availability.map((fact) => fact.text)).toEqual([
    "Verified 2 log artifacts available.",
    "Verified 1 network artifact available.",
  ]);
  expect(availability[0]!.evidenceRefs.map((ref) => ref.relativePath)).toEqual([
    "logs/container.log",
    "logs/runner.log",
  ]);
  expect(analysis.facts.some((fact) => fact.text.endsWith("is available."))).toBe(false);
});

const SCHEMA_SOURCE = "svr_00000000-0000-4000-8000-000000000001";
it("a failed jsonSchema step names the schema violations and hands them to the model", async () => {
  const f = await fixture({
    schema: true,
    step: {
      expected: { sourceRevisionId: SCHEMA_SOURCE, pointer: "" },
      observed: {
        violations: [
          { path: "/data/0/id", keyword: "type", message: "must be string" },
          { path: "/data/1", keyword: "required", message: "must have required property 'id'" },
        ],
        omittedViolations: 3,
        // Deeper than the model evidence bounds: kept structured, it would make the reading abstain.
        excerpt: { data: [{ id: 7, caps: { io: { in: ["text"] } } }, {}] },
      },
      error: {
        code: "Error",
        message:
          "Response does not match source schema: 5 violations; first at /data/0/id: must be string",
      },
    },
  });
  const analysis = await f.service.analyze(f.run.id, { model: true });
  expect(analysis.failureKind).toBe("contract_violation");
  expect(analysis.facts.map((fact) => fact.text)).toContain(
    `Step price (jsonSchema) rejected the response against ${SCHEMA_SOURCE}: 5 schema violations; first: /data/0/id type: must be string; /data/1 required: must have required property 'id'.`,
  );
  expect(analysis.diagnosis?.observation?.observed).toContain("must be string");
  expect(analysis.diagnosis?.observation?.expected).toContain(SCHEMA_SOURCE);
  // The reading is dispatched: a deep excerpt no longer makes the evidence catalog abstain.
  expect(f.complete).toHaveBeenCalledOnce();
  const request = f.complete.mock.calls[0]![0] as {
    data: { measurements: Record<string, unknown>[] };
  };
  const step = request.data.measurements.find((item) => item.stepId === "price")!;
  expect(step).toMatchObject({
    predicate: "jsonSchema",
    observed: {
      violations: [{ path: "/data/0/id", keyword: "type", message: "must be string" }, {}],
      omittedViolations: 3,
      excerpt: '{"data":[{"caps":{"io":{"in":["text"]}},"id":7},{}]}',
      excerptTruncated: false,
    },
  });
});
it("a failed jsonConforms step is a contract violation that names the inline schema's violations", async () => {
  const f = await fixture({
    schema: "inline",
    step: {
      expected: { type: "integer", minimum: 1 },
      observed: {
        violations: [{ path: "", keyword: "minimum", message: "must be >= 1" }],
        omittedViolations: 0,
        excerpt: 0,
      },
      error: {
        code: "Error",
        message: "Response does not match inline schema: 1 violation; first at /: must be >= 1",
      },
    },
  });
  const analysis = await f.service.analyze(f.run.id);
  expect(analysis.failureKind).toBe("contract_violation");
  expect(analysis.facts.map((fact) => fact.text)).toContain(
    "Step price (jsonConforms) rejected the response against the step's inline schema: 1 schema violation; first: / minimum: must be >= 1.",
  );
});
it("a jsonSchema check refused for an uncompilable source schema is a supported test-side cause", async () => {
  const f = await fixture({
    schema: true,
    step: {
      status: "inconclusive",
      reasonCode: "oracle_uncertain",
      expected: null,
      observed: null,
      error: {
        code: "Error",
        message: `Source schema ${SCHEMA_SOURCE} cannot be used for validation: strict mode: unknown keyword: "bogus"`,
      },
    },
  });
  const analysis = await f.service.analyze(f.run.id, {});
  expect(analysis).toMatchObject({ failureKind: "test_fragility", recommendedAction: "fix_test" });
  expect(analysis.facts.map((fact) => fact.text)).toContain(
    `Step price (jsonSchema) could not evaluate the response: Source schema ${SCHEMA_SOURCE} cannot be used for validation: strict mode: unknown keyword: "bogus"`,
  );
  const diagnosis = analysis.diagnosis!;
  expect(diagnosis.conclusion.status).toBe("cause_supported");
  expect(diagnosis.conclusion.text).toContain(
    `source schema ${SCHEMA_SOURCE} cannot be compiled (strict mode: unknown keyword: "bogus")`,
  );
  expect(diagnosis.conclusion.text).toContain("not in the product");
  expect(diagnosis.nextSteps[0]?.text).toContain("Fix the source schema in a new source revision");
  expect(diagnosis.nextSteps[0]?.evidenceRefs).toEqual([
    expect.objectContaining({ stepId: f.step.id }),
  ]);
  expect(diagnosis.healing.advice).toBe("not_indicated");
});
it("a code test that threw on an uncompilable source schema names the schema, not the throw", async () => {
  const key = `${SCHEMA_SOURCE}/paths/~1v1~1agents/get/responses/401/content/application~1json/schema`;
  const f = await fixture({
    code: true,
    step: {
      planStepId: "imported-test-0",
      status: "inconclusive",
      reasonCode: "insufficient_evidence",
      expected: null,
      observed: null,
      error: {
        code: "Error",
        message: `Error: Source schema ${JSON.stringify(key)} cannot be used for validation: strict mode: unknown keyword: "bogus"\n    at generated.spec.ts:14:19`,
      },
    },
  });
  const diagnosis = (await f.service.analyze(f.run.id, {})).diagnosis!;
  expect(diagnosis.conclusion.status).toBe("cause_supported");
  expect(diagnosis.conclusion.text).toContain(
    `source schema ${key} cannot be compiled (strict mode: unknown keyword: "bogus")`,
  );
  expect(diagnosis.nextSteps[0]?.text).toContain("Fix the source schema in a new source revision");
});
it("a failed urlEquals step reports the observed and expected URLs instead of an unknown cause", async () => {
  const f = await fixture({
    plan: {
      schemaVersion: "1.0.0",
      kind: "executable",
      name: "Login redirect",
      type: "frontend",
      runner: "playwright",
      requirementRefs: ["req_00000000-0000-4000-8000-000000000003"],
      steps: [
        {
          id: "landed",
          kind: "assertion",
          operation: "assert",
          required: true,
          description: "Lands on the dashboard",
          input: { pageAlias: "main" },
          expectation: { predicate: "urlEquals", value: { literal: "/dashboard" } },
        },
      ],
    },
    step: {
      planStepId: "landed",
      expected: "http://app.test/dashboard",
      observed: "http://app.test/login?error=1",
      error: {
        code: "Error",
        message:
          "Page URL http://app.test/login?error=1 differs from expected URL http://app.test/dashboard",
      },
    },
  });
  const analysis = await f.service.analyze(f.run.id, {});
  expect(analysis.failureKind).toBe("product_bug");
  expect(analysis.facts.map((fact) => fact.text)).toContain(
    'Step landed (urlEquals) observed the page URL "http://app.test/login?error=1" while expecting "http://app.test/dashboard".',
  );
  expect(analysis.diagnosis?.observation).toMatchObject({
    expected: expect.stringContaining("http://app.test/dashboard"),
    observed: expect.stringContaining("http://app.test/login?error=1"),
  });
});
it("a failed urlMatches step reports the observed URL and the pattern it misses", async () => {
  const pattern = "^(?!.*/login(?:[?#]|$))";
  const f = await fixture({
    plan: {
      schemaVersion: "1.0.0",
      kind: "executable",
      name: "Login leaves the form",
      type: "frontend",
      runner: "playwright",
      requirementRefs: ["req_00000000-0000-4000-8000-000000000003"],
      steps: [
        {
          id: "left_login",
          kind: "assertion",
          operation: "assert",
          required: true,
          description: "Leaves the login page",
          input: { pageAlias: "main" },
          expectation: { predicate: "urlMatches", pattern },
        },
      ],
    },
    step: {
      planStepId: "left_login",
      expected: { matches: pattern },
      observed: "http://app.test/login?error=1",
      error: {
        code: "Error",
        message: `Page URL http://app.test/login?error=1 does not match pattern ${pattern}`,
      },
    },
  });
  const analysis = await f.service.analyze(f.run.id, {});
  expect(analysis.failureKind).toBe("product_bug");
  expect(analysis.facts.map((fact) => fact.text)).toContain(
    `Step left_login (urlMatches) observed the page URL "http://app.test/login?error=1", which the pattern ${JSON.stringify(pattern)} does not match.`,
  );
});
it("the error fields a failing endpoint returned become a fact and reach the model data", async () => {
  const f = await fixture({ status: true });
  await attachTerminalProcess(
    f,
    { response: { status: 503, failureExcerpt: '{"error":"database unavailable"}' } },
    { relativePath: "http/request.json", kind: "http" },
  );
  const analysis = await f.service.analyze(f.run.id, { model: true });
  expect(analysis.facts.map((fact) => fact.text)).toContain(
    'HTTP step request responded 503 with recorded error fields: {"error":"database unavailable"}',
  );
  const request = f.complete.mock.calls[0]![0] as {
    data: { measurements: Record<string, unknown>[] };
  };
  expect(request.data.measurements.find((item) => item.kind === "http")).toMatchObject({
    stepId: "request",
    status: 503,
    failureExcerpt: '{"error":"database unavailable"}',
  });
  // A passing Run lists no such fact even when the endpoint returned an error that was expected.
  const passed = await fixture({ passed: true });
  await attachTerminalProcess(
    passed,
    { response: { status: 401, failureExcerpt: '{"error":"unauthorized"}' } },
    { relativePath: "http/request.json", kind: "http" },
  );
  const clean = await passed.service.analyze(passed.run.id, {});
  expect(clean.facts.map((fact) => fact.text).join("\n")).not.toContain("recorded error fields");
});

function requestStatusPlan(values: number[]): ExecutablePlan {
  return {
    schemaVersion: "1.0.0",
    kind: "executable",
    name: "Legacy redirect",
    type: "backend",
    runner: "http",
    requirementRefs: ["req_00000000-0000-4000-8000-000000000003"],
    steps: [
      {
        id: "request",
        kind: "action",
        operation: "request",
        description: "Read legacy path",
        input: { method: "GET", pathSegments: [{ literal: "legacy" }] },
      },
      {
        id: "price",
        kind: "assertion",
        operation: "assert",
        required: true,
        description: "Redirects",
        input: { responseStepId: "request" },
        expectation: { predicate: "statusIn", values },
      },
    ],
  };
}
/** Sets fields on the input of the first (request) step of a `requestStatusPlan`. */
function withRequestInput(plan: ExecutablePlan, input: Record<string, unknown>): ExecutablePlan {
  const request = plan.steps[0]!;
  if (request.kind !== "action" || request.operation !== "request")
    throw new Error("request step expected");
  Object.assign(request.input, input);
  return plan;
}
const redirectHop = { url: "http://app.test/legacy", status: 307, location: "/current" };
/**
 * Attaches the HTTP record of request step `request` and an opted-in server log as two artifacts,
 * each read back by its own path.
 */
async function attachServerLog(f: AnalysisFixture, status: number, log: string) {
  const fixtures = relationalFixtures(f.db);
  const snapshot = fixtures.find((item) => item.kind === "Snapshot")!;
  const base = fixtures.find((item) => item.kind === "Artifact")!;
  const snapshotInsert = fixtureInsert(snapshot);
  f.db.run(snapshotInsert.sql, ...snapshotInsert.values);
  const files = [
    {
      relativePath: "http/request.json",
      kind: "http",
      content: JSON.stringify({ response: { status }, redirects: [] }),
    },
    { relativePath: "logs/server.log", kind: "server-log", content: log },
  ];
  const entries = files.map((file, index) => {
    const artifact = structuredClone(base);
    const id = `art_00000000-0000-4000-8000-0000000009${index + 10}`;
    Object.assign(artifact.dto, {
      id,
      kind: file.kind,
      state: "available",
      hash: "a".repeat(64),
      storageKey: `${String(base.dto.storageKey)}-${index}`,
    });
    Object.assign(artifact.row, {
      id,
      state: "available",
      hash: "a".repeat(64),
      ...("storage_key" in artifact.row ? { storage_key: artifact.dto.storageKey } : {}),
      ...("kind" in artifact.row ? { kind: file.kind } : {}),
      data_json: canonicalJson(artifact.dto),
    });
    const insert = fixtureInsert(artifact);
    f.db.run(insert.sql, ...insert.values);
    return {
      artifactId: id,
      relativePath: file.relativePath,
      kind: file.kind,
      sizeBytes: Buffer.byteLength(file.content),
      state: "available",
      redactionStatus: "sanitized",
      sha256: "a".repeat(64),
    };
  });
  vi.mocked(f.artifacts.get).mockResolvedValue({
    manifest: { snapshotId: snapshot.dto.id, attemptId: f.step.attemptId, entries },
  } as never);
  f.artifacts.read = vi.fn(
    async (_runId: string, path: string, options: { offset?: number; maxBytes?: number } = {}) => {
      const bytes = Buffer.from(files.find((file) => file.relativePath === path)!.content);
      const offset = options.offset ?? 0;
      return { bytes: bytes.subarray(offset, offset + (options.maxBytes ?? 65536)) };
    },
  ) as never;
}
/** Records the runner's start and finish of step `request` around `during`, returning a log timestamp inside it. */
function requestStepWindow(f: AnalysisFixture): string {
  const started = recordRunnerEvent(f, 1, "step.started", { stepId: "request", index: 0 });
  recordRunnerEvent(f, 2, "step.finished", {
    stepId: "request",
    index: 0,
    status: "passed",
    durationMs: 5,
    evidencePaths: ["http/request.json"],
  });
  return `${started.occurredAt.slice(0, -1)}123456Z`;
}
const serverLogHeader =
  "testmaster: docker logs searxng-tm-app from 2026-10-17T12:00:00.000Z to 2026-10-17T12:00:05.000Z";
it("a 5xx whose server log recorded an exception while the request ran is a product bug citing that line", async () => {
  const f = await fixture({
    plan: requestStatusPlan([200]),
    step: { expected: 200, observed: 500 },
  });
  const at = requestStepWindow(f);
  await attachServerLog(
    f,
    500,
    [
      serverLogHeader,
      "2020-01-01T00:00:00.000000000Z ERROR an older failure outside the step",
      `${at} Traceback (most recent call last):`,
      `${at}   File "/usr/local/searxng/searx/webutils.py", line 130, in get_result_url`,
      `${at} AttributeError: 'NoneType' object has no attribute 'netloc'`,
      "",
    ].join("\n"),
  );
  const analysis = await f.service.analyze(f.run.id, { model: true });
  expect(analysis).toMatchObject({ failureKind: "product_bug", recommendedAction: "fix_product" });
  expect(analysis.hypotheses[0]?.text).toContain(
    "\"AttributeError: 'NoneType' object has no attribute 'netloc'\"",
  );
  expect(analysis.hypotheses[0]?.supports).toContainEqual(
    expect.objectContaining({ relativePath: "logs/server.log" }),
  );
  const fact = analysis.facts.find((item) => item.text.includes("logs/server.log"));
  expect(fact?.text).toBe(
    "The server log of container searxng-tm-app (logs/server.log) recorded 2 error lines while step request ran: \"AttributeError: 'NoneType' object has no attribute 'netloc'\"; \"Traceback (most recent call last):\".",
  );
  expect(fact?.evidenceRefs).toEqual(
    expect.arrayContaining([
      expect.objectContaining({ relativePath: "logs/server.log" }),
      expect.objectContaining({ stepId: f.step.id }),
    ]),
  );
  expect(analysis.diagnosis?.conclusion.text).toContain(
    "The server failed while handling request step request (HTTP 500)",
  );
  expect(analysis.diagnosis?.nextSteps[0]?.text).toContain(
    "Read the error lines of logs/server.log",
  );
  const request = f.complete.mock.calls[0]![0] as {
    data: { measurements: Record<string, unknown>[] };
  };
  expect(request.data.measurements.find((item) => item.kind === "server-log")).toMatchObject({
    container: "searxng-tm-app",
    unavailable: null,
  });
  // Control: the same 500 with a log that recorded nothing while the step ran is no product bug.
  const quiet = await fixture({
    plan: requestStatusPlan([200]),
    step: { expected: 200, observed: 500 },
  });
  requestStepWindow(quiet);
  await attachServerLog(
    quiet,
    500,
    `${serverLogHeader}\n2020-01-01T00:00:00.000000000Z ERROR an older failure outside the step\n`,
  );
  const unexplained = await quiet.service.analyze(quiet.run.id, {});
  expect(unexplained.failureKind).toBe("unknown");
  expect(unexplained.facts.map((item) => item.text)).toContain(
    'The server log of container searxng-tm-app (logs/server.log) recorded 1 error line during the attempt, none while step request ran; first: "ERROR an older failure outside the step".',
  );
});
it("a server log shared with a run that ran at the same time attributes no error to this run", async () => {
  // A long (valid) container name: the analysis must still fit its 200-character limitations.
  const container = `searxng-tm-app-${"x".repeat(100)}`;
  const logged = async (concurrentRun: boolean) => {
    const f = await fixture({
      plan: requestStatusPlan([200]),
      step: { expected: 200, observed: 500 },
      serverLogContainer: container,
      concurrentRun,
    });
    const at = requestStepWindow(f);
    await attachServerLog(
      f,
      500,
      `${serverLogHeader.replace("searxng-tm-app", container)}\n${at} AttributeError: 'NoneType' object has no attribute 'netloc'\n`,
    );
    return f.service.analyze(f.run.id, {});
  };
  const shared = await logged(true);
  expect(shared.failureKind).toBe("unknown");
  expect(shared.limitations).toContain(
    "The server log is shared with a run that ran at the same time (named in its fact); its lines are not attributed to this run.",
  );
  expect(shared.facts.find((item) => item.text.includes("logs/server.log"))?.text).toContain(
    "Run run_00000000-0000-4000-8000-0000000000b1 used the same server at the same time, so these lines may come from it.",
  );
  // Control: the same log with no overlapping run is a product bug citing the line.
  const alone = await logged(false);
  expect(alone.failureKind).toBe("product_bug");
  expect(alone.limitations.join("\n")).not.toContain("is shared with");
});
it("an unavailable server log is a limitation, never a cause", async () => {
  const f = await fixture({
    plan: requestStatusPlan([200]),
    step: { expected: 200, observed: 500 },
  });
  requestStepWindow(f);
  await attachServerLog(
    f,
    500,
    "testmaster: server log unavailable (docker logs searxng-tm-app from 2026-10-17T12:00:00.000Z to 2026-10-17T12:00:05.000Z): docker exited 1: No such container: searxng-tm-app\n",
  );
  const analysis = await f.service.analyze(f.run.id, {});
  expect(analysis.failureKind).toBe("unknown");
  expect(analysis.limitations).toContain(
    "The server log of container searxng-tm-app was unavailable: docker exited 1: No such container: searxng-tm-app.",
  );
});
it("a long docker error for an unavailable server log is clipped to the limitation bound", async () => {
  const f = await fixture({
    plan: requestStatusPlan([200]),
    step: { expected: 200, observed: 500 },
  });
  requestStepWindow(f);
  await attachServerLog(
    f,
    500,
    `testmaster: server log unavailable (docker logs searxng-tm-app from 2026-10-17T12:00:00.000Z to 2026-10-17T12:00:05.000Z): docker exited 1: ${"permission denied while connecting to the Docker daemon socket ".repeat(5)}\n`,
  );
  const analysis = await f.service.analyze(f.run.id, {});
  const limitation = analysis.limitations.find((item) => item.includes("was unavailable"));
  expect(
    limitation?.startsWith(
      "The server log of container searxng-tm-app was unavailable: docker exited 1: permission denied",
    ),
  ).toBe(true);
  expect(limitation?.length).toBeLessThanOrEqual(200);
});
it("server log lines reach facts with secrets masked", async () => {
  vi.stubEnv("TESTMASTER_SECRET_TOKEN", "s3cr3t-host-value-0042");
  try {
    const f = await fixture({
      plan: requestStatusPlan([200]),
      step: { expected: 200, observed: 502 },
    });
    const at = requestStepWindow(f);
    await attachServerLog(
      f,
      502,
      `${serverLogHeader}\n${at} RuntimeError: upstream refused key s3cr3t-host-value-0042\n`,
    );
    const analysis = await f.service.analyze(f.run.id, {});
    const texts = [
      ...analysis.facts.map((item) => item.text),
      ...analysis.hypotheses.map((item) => item.text),
    ].join("\n");
    expect(texts).toContain("RuntimeError: upstream refused key");
    expect(texts).not.toContain("s3cr3t-host-value-0042");
  } finally {
    vi.unstubAllEnvs();
  }
});
it("a statusIn expecting the redirect that the runner followed is a test defect, not a product bug", async () => {
  const f = await fixture({
    plan: requestStatusPlan([307]),
    step: { expected: 307, observed: 200 },
  });
  await attachTerminalProcess(
    f,
    { response: { status: 200, url: "http://app.test/current" }, redirects: [redirectHop] },
    { relativePath: "http/request.json", kind: "http" },
  );
  const analysis = await f.service.analyze(f.run.id, {});
  expect(analysis).toMatchObject({ failureKind: "test_fragility", recommendedAction: "fix_test" });
  expect(
    analysis.hypotheses[0]?.supports.some((ref) => ref.relativePath === "http/request.json"),
  ).toBe(true);
  expect(analysis.facts.map((fact) => fact.text)).toContain(
    "Step price (statusIn) expects status 307, but the runner followed 1 redirect of request step request (first hop 307 to /current) and recorded the final response status 200.",
  );
  expect(analysis.diagnosis?.conclusion.text).toContain("followed the redirect");
  expect(analysis.diagnosis?.nextSteps[0]?.text).toContain('redirect to "manual"');
  expect(analysis.diagnosis?.healing.advice).toBe("not_indicated");
  // Control: the same mismatch without a followed redirect stays an observed product mismatch.
  const plain = await fixture({
    plan: requestStatusPlan([307]),
    step: { expected: 307, observed: 200 },
  });
  await attachTerminalProcess(
    plain,
    { response: { status: 200 }, redirects: [] },
    { relativePath: "http/request.json", kind: "http" },
  );
  expect(await plain.service.analyze(plain.run.id, {})).toMatchObject({
    failureKind: "product_bug",
    recommendedAction: "fix_product",
  });
  // Control: a followed redirect the assertion did not expect does not excuse the mismatch.
  const unrelated = await fixture({
    plan: requestStatusPlan([404]),
    step: { expected: 404, observed: 200 },
  });
  await attachTerminalProcess(
    unrelated,
    { response: { status: 200 }, redirects: [redirectHop] },
    { relativePath: "http/request.json", kind: "http" },
  );
  expect(await unrelated.service.analyze(unrelated.run.id, {})).toMatchObject({
    failureKind: "product_bug",
  });
});
it.each([
  [400, "contract_violation", "review_contract", "Compare the body, query parameters and headers"],
  [422, "contract_violation", "review_contract", "Compare the body, query parameters and headers"],
  [401, "environment", "fix_environment", "auth profile or secret"],
  [403, "environment", "fix_environment", "auth profile or secret"],
  [404, "contract_violation", "review_contract", "Compare the path of request step request"],
  [405, "contract_violation", "review_contract", "Compare the method and path"],
  [409, "environment", "fix_environment", "Inspect the state the target holds"],
  [429, "environment", "fix_environment", "rate limit"],
] as const)(
  "a statusIn mismatch where the target answered %i gets a rules diagnosis, not cause_unknown",
  async (status, failureKind, recommendedAction, nextStep) => {
    const plan = requestStatusPlan([200]);
    // A 401/403 to a request that sends the profile session; one that sends nothing is read apart.
    if (status === 401 || status === 403) withRequestInput(plan, { auth: "profile" });
    const f = await fixture({
      plan,
      step: { expected: 200, observed: status },
    });
    await attachTerminalProcess(
      f,
      { response: { status, failureExcerpt: '{"error":"rejected"}' }, redirects: [] },
      { relativePath: "http/request.json", kind: "http" },
    );
    const analysis = await f.service.analyze(f.run.id, {});
    expect(analysis).toMatchObject({ failureKind, recommendedAction });
    expect(analysis.hypotheses[0]).toMatchObject({ support: "partially_supported" });
    expect(analysis.hypotheses[0]?.text).toContain(`HTTP ${status}`);
    const diagnosis = analysis.diagnosis!;
    expect(diagnosis.conclusion.status).toBe("cause_partially_supported");
    expect(diagnosis.conclusion.text).toContain(
      `answered with HTTP ${status} instead of the expected 200`,
    );
    expect(diagnosis.nextSteps[0]?.text).toContain(nextStep);
    // The next step cites the failed assertion and the recorded request/response evidence.
    expect(diagnosis.nextSteps[0]?.evidenceRefs).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ stepId: f.step.id }),
        expect.objectContaining({ relativePath: "http/request.json" }),
      ]),
    );
    expect(diagnosis.healing.advice).toBe("not_indicated");
    expect(diagnosis.healing.reason).toContain("not caused by a locator");
  },
);
it("a 4xx that a followed redirect explains stays a test defect, not a rejected request", async () => {
  const f = await fixture({
    plan: requestStatusPlan([307]),
    step: { expected: 307, observed: 404 },
  });
  await attachTerminalProcess(
    f,
    { response: { status: 404, url: "http://app.test/gone" }, redirects: [redirectHop] },
    { relativePath: "http/request.json", kind: "http" },
  );
  const analysis = await f.service.analyze(f.run.id, {});
  expect(analysis).toMatchObject({ failureKind: "test_fragility", recommendedAction: "fix_test" });
  expect(analysis.diagnosis?.conclusion.text).toContain("followed the redirect");
});
it("an optional statusIn assertion answered with a 4xx gets no rejection diagnosis", async () => {
  const plan = requestStatusPlan([200]);
  const assertion = plan.steps[1]!;
  if (assertion.kind !== "assertion") throw new Error("assertion expected");
  assertion.required = false;
  const f = await fixture({ plan, step: { expected: 200, observed: 422 } });
  await attachTerminalProcess(
    f,
    { response: { status: 422 }, redirects: [] },
    { relativePath: "http/request.json", kind: "http" },
  );
  expect(await f.service.analyze(f.run.id, {})).toMatchObject({
    failureKind: "unknown",
    hypotheses: [],
  });
});
it("an inconclusive run whose runner protocol failed names that error instead of an unknown cause", async () => {
  const f = await fixture({ outcome: "inconclusive" });
  // The executor discards every step result when the evidence protocol fails.
  f.db.run("DELETE FROM steps WHERE id=?", f.step.id);
  const { artifactId } = await attachTerminalProcess(
    f,
    { reasonCode: "insufficient_evidence", error: "Reserved artifact path" },
    { relativePath: "logs/protocol.json", kind: "protocol" },
  );
  const analysis = await f.service.analyze(f.run.id, { model: true });
  const { conclusion, nextSteps, healing } = analysis.diagnosis!;
  expect(conclusion.status).toBe("cause_supported");
  expect(conclusion.text).toContain("Reserved artifact path");
  expect(conclusion.text).toContain("not a product or assertion failure");
  expect(nextSteps[0]?.text).toContain("Rerun the unchanged test");
  expect(nextSteps[0]?.evidenceRefs).toContainEqual(
    expect.objectContaining({ artifactId, relativePath: "logs/protocol.json" }),
  );
  expect(healing.advice).toBe("not_indicated");
  expect(analysis.failureKind).toBe("unknown");
  const request = f.complete.mock.calls[0]![0] as {
    data: { facts: { text: string }[]; measurements: Record<string, unknown>[] };
  };
  expect(request.data.facts.map((fact) => fact.text).join("\n")).toContain(
    "Reserved artifact path",
  );
  expect(request.data.measurements.find((item) => item.kind === "protocol")).toMatchObject({
    reasonCode: "insufficient_evidence",
    error: "Reserved artifact path",
  });
});
it("a failure localizes to the first inconclusive step and never prints a placeholder", async () => {
  const f = await fixture({
    step: {
      planStepId: "request",
      status: "inconclusive",
      reasonCode: "insufficient_evidence",
      expected: null,
      observed: null,
      error: { code: "Error", message: "page.goto: net::ERR_ABORTED" },
    },
  });
  const analysis = await f.service.analyze(f.run.id, {});
  expect(analysis.diagnosis?.conclusion.text).toBe(
    "The failure is localized to step request; the evidence does not establish a cause.",
  );
  expect(analysis.diagnosis?.nextSteps[0]?.text).toContain("for step request");
  // Without any non-passed step result there is nothing to name, and no placeholder appears.
  const none = await fixture({ step: { status: "passed", observed: 10 } });
  none.ctx.entities.insert("StepResult", {
    ...none.step,
    id: "stp_00000000-0000-4000-8000-000000000003",
    workspaceId: none.ctx.workspaceId,
    planStepId: "request",
    index: 1,
    observed: null,
  });
  const unlocalized = await none.service.analyze(none.run.id, {});
  expect(unlocalized.diagnosis?.conclusion.text).toBe(
    "The failure could not be localized to a recorded step result; the evidence does not establish a cause.",
  );
  expect(JSON.stringify(unlocalized.diagnosis)).not.toContain("step unavailable");
  expect(unlocalized.diagnosis?.nextSteps[0]?.text).toContain("for the step that stopped the Run");
});
it("a run whose only non-passed step is inconclusive reports that step, its reason code and its error in the observation", async () => {
  const message = "page.goto: net::ERR_ABORTED at https://target.invalid/menu";
  const f = await fixture({
    step: {
      planStepId: "request",
      status: "inconclusive",
      reasonCode: "insufficient_evidence",
      expected: null,
      observed: null,
      error: { code: "Error", message },
    },
  });
  const analysis = await f.service.analyze(f.run.id, {});
  const observation = analysis.diagnosis?.observation;
  // The observation names the step the localization names, not "no failed step result".
  expect(analysis.diagnosis?.conclusion.text).toContain("localized to step request");
  expect(observation).toMatchObject({ stepId: "request", operation: "request" });
  expect(observation?.summary).toContain("was inconclusive: insufficient_evidence");
  expect(observation?.summary).toContain(`(runner message: ${message})`);
  expect(observation?.summary).not.toContain("no failed");
  expect(observation?.evidenceRefs[0]).toMatchObject({ stepId: f.step.id });
  // No value was compared, so the step is not misreported as a null observed value.
  expect(observation).toMatchObject({ expected: null, observed: null });
  expect(observation?.absence).not.toBe("null_value");
  // The error also reaches the facts the model reads.
  expect(analysis.facts.map((fact) => fact.text)).toContain(
    `Step request (request) was inconclusive: insufficient_evidence (runner message: ${message}).`,
  );
});
const labelPlan = (value: string): ExecutablePlan =>
  ({
    schemaVersion: "1.0.0",
    kind: "executable",
    name: "Login",
    type: "frontend",
    runner: "playwright",
    requirementRefs: [],
    steps: [
      {
        id: "submit",
        kind: "action",
        operation: "click",
        description: "Focus the password field",
        input: { locator: { by: "label", value, exact: true } },
      },
    ],
  }) as unknown as ExecutablePlan;
const clickStep = {
  planStepId: "submit",
  reasonCode: "assertion_timeout",
  expected: null,
  observed: null,
  error: { code: "assertion_timeout", message: "Click timed out" },
} satisfies Partial<StepResult>;
it("boolean-valued environment flags do not redact JSON booleans in the diagnosis text", async () => {
  vi.stubEnv("INSPECTOR_MASK_SECRETS", "true");
  vi.stubEnv("REQUIRE_API_KEY", "false");
  try {
    const f = await fixture({ plan: labelPlan("Password"), step: clickStep });
    const analysis = await f.service.analyze(f.run.id, {});
    expect(analysis.diagnosis?.observation?.summary).toContain(
      'Locator {"by":"label","exact":true,"value":"Password"}',
    );
    expect(JSON.stringify(analysis.diagnosis)).not.toContain("[REDACTED]");
  } finally {
    vi.unstubAllEnvs();
  }
});
it("a credential value in the environment is still redacted from the diagnosis text", async () => {
  vi.stubEnv("INSPECTOR_MASK_SECRETS", "true");
  vi.stubEnv("SERVICE_API_TOKEN", "tm-canary-credential-9876");
  try {
    const f = await fixture({ plan: labelPlan("tm-canary-credential-9876"), step: clickStep });
    const analysis = await f.service.analyze(f.run.id, {});
    expect(analysis.diagnosis?.observation?.summary).toContain('"exact":true');
    expect(analysis.diagnosis?.observation?.summary).toContain("[REDACTED]");
    expect(JSON.stringify(analysis)).not.toContain("tm-canary-credential-9876");
  } finally {
    vi.unstubAllEnvs();
  }
});
it("a failed code run maps its steps to what the reporter named and keeps expected, observed and the error", async () => {
  const message =
    "expect(received).toBe(expected)\n\nExpected: 200\nReceived: 404\n    at health.spec.ts:4:38";
  const f = await fixture({
    code: true,
    step: {
      planStepId: "imported-test-0",
      expected: 200,
      observed: 404,
      error: { code: "assertion_mismatch", message },
    },
  });
  const analysis = await f.service.analyze(f.run.id, {});
  expect(analysis.diagnosis?.observation).toMatchObject({
    stepId: "imported-test-0",
    operation: "playwright_test",
    expected: expect.stringContaining("200"),
    observed: expect.stringContaining("404"),
  });
  expect(analysis.diagnosis?.observation?.absence).not.toBe("null_value");
  // The observation cites Playwright's own message with its location, not only the step's status.
  expect(analysis.diagnosis?.observation?.summary).toContain("Received: 404");
  expect(analysis.diagnosis?.observation?.summary).toContain("at health.spec.ts:4:38");
  expect(analysis.diagnosis?.chain.map((link) => link.operation)).toEqual(["playwright_test"]);
  // The facts carry Playwright's own message with its location, citing the persisted step.
  const fact = analysis.facts.find((item) => item.text.includes("Received: 404"));
  expect(fact?.text).toContain("Step imported-test-0 (playwright_test) failed:");
  expect(fact?.text).toContain("at health.spec.ts:4:38");
  expect(fact?.evidenceRefs[0]?.stepId).toBe(f.step.id);
  expect(JSON.stringify(analysis)).not.toContain("unmapped");
});
it("a failed code step names the title the test framework gave it in the fact and the step summary", async () => {
  const message =
    "expect(received).toBe(expected)\n\nExpected: 200\nReceived: 404\n    at health.spec.ts:4:38";
  const f = await fixture({
    code: true,
    step: {
      planStepId: "imported-step-3",
      title: "expect.toHaveURL\n  (/dashboard)",
      expected: 200,
      observed: 404,
      error: { code: "assertion_mismatch", message },
    },
  });
  const analysis = await f.service.analyze(f.run.id, {});
  const fact = analysis.facts.find((item) => item.text.includes("Received: 404"));
  expect(fact?.text).toContain(
    "Step imported-step-3 (playwright_step: expect.toHaveURL (/dashboard)) failed:",
  );
  expect(analysis.diagnosis?.observation?.summary).toContain(
    "Step imported-step-3 (playwright_step: expect.toHaveURL (/dashboard)) was failed",
  );
  // The operation stays the structured field; the title is only text for the reader.
  expect(analysis.diagnosis?.observation?.operation).toBe("playwright_step");
  // The stored step result keeps the title as recorded, newline included, and validates.
  const stored = f.ctx.entities.get("StepResult", f.ctx.workspaceId, f.step.id);
  expect(stored).toMatchObject({ title: "expect.toHaveURL\n  (/dashboard)" });
  expect(() => validate("StepResult", f.step)).not.toThrow();
});
it("a code test that threw instead of asserting is a test defect and the diagnosis quotes the thrown error", async () => {
  const message =
    "Error: Cannot complete check_manifest: the supplied data does not include that schema.\n    at generated.spec.ts:14:9";
  const thrown = (error: string): Partial<StepResult> => ({
    planStepId: "imported-test-0",
    status: "inconclusive",
    reasonCode: "insufficient_evidence",
    expected: null,
    observed: null,
    error: { code: "Error", message: error },
  });
  const f = await fixture({ code: true, step: thrown(message) });
  const analysis = await f.service.analyze(f.run.id, {});
  expect(analysis).toMatchObject({ failureKind: "test_fragility", recommendedAction: "fix_test" });
  const diagnosis = analysis.diagnosis!;
  // The test recorded no comparison, so none is reported.
  expect(diagnosis.observation).toMatchObject({
    stepId: "imported-test-0",
    operation: "playwright_test",
    expected: null,
    observed: null,
  });
  expect(diagnosis.observation?.summary).toContain("Cannot complete check_manifest");
  expect(diagnosis.conclusion.status).toBe("cause_partially_supported");
  expect(diagnosis.conclusion.text).toContain("thrown by the test code");
  expect(diagnosis.conclusion.text).toContain("Cannot complete check_manifest");
  expect(diagnosis.conclusion.text).toContain("at generated.spec.ts:14:9");
  expect(diagnosis.nextSteps[0]?.text).toContain("Fix the test code, or regenerate it");
  expect(diagnosis.nextSteps[0]?.evidenceRefs).toEqual([
    expect.objectContaining({ stepId: f.step.id }),
  ]);
  expect(diagnosis.healing.advice).toBe("not_indicated");
  const fact = analysis.facts.find((item) => item.text.includes("threw an error"));
  expect(fact?.text).toContain("Step imported-test-0 (playwright_test) threw an error:");
  expect(fact?.text).toContain("at generated.spec.ts:14:9");
  // Control: a thrown connection error is an environment condition, not a defect of the code.
  const down = await fixture({
    code: true,
    step: thrown("Error: apiRequestContext.get: connect ECONNREFUSED 127.0.0.1:20311"),
  });
  expect(await down.service.analyze(down.run.id, {})).toMatchObject({
    failureKind: "environment",
    recommendedAction: "fix_environment",
  });
});
it("a pytest test that raised a non-assertion exception is read like a code test that threw", async () => {
  // The Python harness names a step after its pytest node id and sends the exception's class.
  const f = await fixture({
    code: true,
    step: {
      planStepId: "test_health.py__test_manifest",
      status: "inconclusive",
      reasonCode: "insufficient_evidence",
      expected: null,
      observed: null,
      error: {
        code: "KeyError",
        message: "KeyError: 'paths'\n    at test_health.py:9",
      },
    },
  });
  const analysis = await f.service.analyze(f.run.id, {});
  expect(analysis).toMatchObject({ failureKind: "test_fragility", recommendedAction: "fix_test" });
  expect(analysis.diagnosis?.conclusion.text).toContain("KeyError: 'paths'");
  expect(analysis.diagnosis?.conclusion.text).toContain("at test_health.py:9");
  expect(analysis.diagnosis?.nextSteps[0]?.text).toContain("Fix the test code, or regenerate it");
});
it("code steps are named by their reporter id, and a failed test and its failing expect state one fact", async () => {
  const f = await fixture({ code: true, step: { planStepId: "imported-test-0", error: null } });
  const stepRow = (planStepId: string, index: number, serial: number) =>
    f.ctx.entities.insert("StepResult", {
      ...f.step,
      id: `stp_00000000-0000-4000-8000-00000000010${serial}`,
      workspaceId: f.ctx.workspaceId,
      planStepId,
      index,
      expected: null,
      observed: null,
      error: {
        code: "assertion_mismatch",
        message: "expect(received).toBe(expected)\n\nReceived: 1",
      },
    });
  stepRow("imported-step-1", 1, 1);
  stepRow("imported-code", 1000000, 2);
  const analysis = await f.service.analyze(f.run.id, {});
  const operations = Object.fromEntries(
    analysis.diagnosis?.chain.map((link) => [link.stepId, link.operation]) ?? [],
  );
  expect(operations).toMatchObject({
    "imported-test-0": "playwright_test",
    "imported-step-1": "playwright_step",
    "imported-code": "playwright_run",
  });
  expect(analysis.facts.filter((item) => item.text.includes("Received: 1"))).toHaveLength(1);
});
/** Another persisted step of the fixture's attempt, with the fields it overrides. */
function addStep(
  f: AnalysisFixture,
  planStepId: string,
  index: number,
  fields: Partial<StepResult>,
) {
  f.ctx.entities.insert("StepResult", {
    ...f.step,
    id: `stp_00000000-0000-4000-8000-000000000${String(200 + index).padStart(3, "0")}`,
    workspaceId: f.ctx.workspaceId,
    planStepId,
    index,
    ...fields,
  });
}
const statusMessage = (expected: number, received: number) =>
  `expect(received).toBe(expected) // Object.is equality\n\nExpected: ${expected}\nReceived: ${received}\n    at generated.spec.ts:10:31`;
it("a code step that expected a status and received a 401 or 403 is diagnosed like a rejected request and names the environment's auth profile", async () => {
  const failure = (observed: number): Partial<StepResult> => ({
    planStepId: "imported-step-1",
    expected: 200,
    observed,
    error: { code: "assertion_mismatch", message: statusMessage(200, observed) },
  });
  const f = await fixture({ code: true, authProfile: "root-session", step: failure(401) });
  const analysis = await f.service.analyze(f.run.id, {});
  expect(analysis).toMatchObject({
    failureKind: "environment",
    recommendedAction: "fix_environment",
  });
  expect(analysis.hypotheses[0]).toMatchObject({ support: "partially_supported" });
  const diagnosis = analysis.diagnosis!;
  expect(diagnosis.conclusion).toMatchObject({ status: "cause_partially_supported" });
  expect(diagnosis.conclusion.text).toContain(
    "The request asserted by code step imported-step-1 was answered with HTTP 401 instead of the expected 200",
  );
  expect(diagnosis.nextSteps[0]?.text).toContain('auth profile "root-session"');
  expect(diagnosis.nextSteps[0]?.evidenceRefs).toEqual([
    expect.objectContaining({ stepId: f.step.id }),
  ]);
  expect(diagnosis.healing.advice).toBe("not_indicated");
  // Control: the same 403 in an environment without an auth profile still gets the diagnosis.
  const bare = await fixture({ code: true, step: failure(403) });
  const bareDiagnosis = (await bare.service.analyze(bare.run.id, {})).diagnosis!;
  expect(bareDiagnosis.nextSteps[0]?.text).toContain("auth profile or secret");
  expect(bareDiagnosis.nextSteps[0]?.text).not.toContain("root-session");
  // Control: a code step whose compared values are not HTTP statuses is not read as a rejection.
  const count = await fixture({
    code: true,
    step: { ...failure(404), expected: 10, error: { code: "assertion_mismatch", message: "x" } },
  });
  expect(await count.service.analyze(count.run.id, {})).toMatchObject({
    failureKind: "unknown",
    hypotheses: [],
  });
});
it("a code failure is localized to the innermost failed step, whether or not its enclosing steps repeat the error", async () => {
  const error = { code: "assertion_mismatch", message: statusMessage(200, 401) };
  const compared = { expected: 200, observed: 401 };
  // Runs recorded before the reporter fix repeat the failure on the test and the steps around it.
  const repeated = await fixture({
    code: true,
    step: { planStepId: "imported-test-0", error, ...compared },
  });
  addStep(repeated, "imported-step-1", 1, { status: "passed", error: null });
  addStep(repeated, "imported-step-2", 2, { error, ...compared });
  addStep(repeated, "imported-step-3", 3, { error, ...compared });
  // Runs recorded after it keep the details on the innermost step only.
  const single = await fixture({
    code: true,
    step: { planStepId: "imported-test-0", error: null },
  });
  addStep(single, "imported-step-1", 1, { status: "passed", error: null });
  addStep(single, "imported-step-2", 2, { error: null });
  addStep(single, "imported-step-3", 3, { error, ...compared });
  for (const f of [repeated, single]) {
    const analysis = await f.service.analyze(f.run.id, {});
    expect(analysis.diagnosis?.observation).toMatchObject({
      stepId: "imported-step-3",
      operation: "playwright_step",
      expected: expect.stringContaining("200"),
      observed: expect.stringContaining("401"),
    });
    expect(analysis.diagnosis?.conclusion.text).toContain("imported-step-3");
    expect(analysis.facts.filter((item) => item.text.includes("Received: 401"))).toHaveLength(1);
  }
});
it("names the plan steps that have no recorded result when no recorded step failed", async () => {
  // The runner recorded `price` under an id that is not the plan's (a redacted one), and never
  // recorded the plan's `price`.
  const f = await fixture({ step: { planStepId: "request", status: "passed", observed: null } });
  addStep(f, "pr[REDACTED]e", 1, { status: "passed", observed: 10 });
  const analysis = await f.service.analyze(f.run.id, {});
  const diagnosis = analysis.diagnosis!;
  expect(diagnosis.conclusion.status).toBe("cause_unknown");
  expect(diagnosis.conclusion.text).toContain("1 frozen plan step has no recorded result (price)");
  expect(diagnosis.nextSteps[0]?.text).toContain("plan step price");
  expect(diagnosis.nextSteps[0]?.text).toContain("pr[REDACTED]e");
  expect(diagnosis.evidenceGaps).toEqual(
    expect.arrayContaining([
      "1 frozen plan step has no recorded result in the latest attempt: price.",
      "1 recorded step result matches no frozen plan step: pr[REDACTED]e.",
    ]),
  );
});
type ModelRequestData = {
  data: {
    requirements: Record<string, unknown>[];
    measurements: Record<string, unknown>[];
    limitations: string[];
  };
};
function storeRequirements(
  f: Awaited<ReturnType<typeof fixture>>,
  requirements: Record<string, unknown>[],
  conflicts: Record<string, unknown>[] = [],
) {
  const projectId = String(
    f.ctx.entities.get("TestCase", f.ctx.workspaceId, f.run.testId)!.projectId,
  );
  f.db.run(
    "INSERT INTO operational_state(key,value) VALUES(?,?)",
    `requirements:${f.ctx.workspaceId}:${projectId}`,
    canonicalJson({ requirements, conflicts, openQuestions: [], version: 1, fingerprint: "f" }),
  );
}
const requirementId = (n: number) => `req_00000000-0000-4000-8000-00000000000${n}`;
function storedRequirement(n: number, fields: Record<string, unknown> = {}) {
  return {
    id: requirementId(n),
    text: `Requirement ${n} text`,
    acceptanceCriteria: [`Criterion ${n}`],
    sourceRefs: [],
    originKind: "explicit",
    confidence: null,
    approval: "apr_00000000-0000-4000-8000-000000000001",
    ...fields,
  };
}
it("the model reading of a failed HTTP assertion carries the mapped requirement and the response the assertion read, without secrets", async () => {
  const f = await fixture({
    plan: requestStatusPlan([201]),
    step: { expected: [201], observed: 200 },
  });
  storeRequirements(f, [
    storedRequirement(3, {
      text: "GET /legacy returns HTTP 200; ask admin@example.com about it.",
      acceptanceCriteria: ["Without a session, GET /legacy returns HTTP 200 with a JSON object."],
    }),
  ]);
  await attachTerminalProcess(
    f,
    {
      response: {
        status: 200,
        headers: { "content-type": "application/json" },
        bodyMetadata: { sizeBytes: 20, contentType: "application/json" },
        failureExcerpt: null,
      },
    },
    { relativePath: "http/request.json", kind: "http" },
  );
  await f.service.analyze(f.run.id, { model: true });
  const { data } = f.complete.mock.calls[0]![0] as ModelRequestData;
  expect(data.requirements).toEqual([
    {
      id: requirementId(3),
      reviewState: "approved",
      text: "GET /legacy returns HTTP 200; ask [REDACTED] about it.",
      acceptanceCriteria: ["Without a session, GET /legacy returns HTTP 200 with a JSON object."],
      omittedCriteria: 0,
    },
  ]);
  expect(data.measurements.find((item) => item.kind === "http")).toMatchObject({
    stepId: "request",
    status: 200,
    contentType: "application/json",
    bodyBytes: 20,
  });
  expect(JSON.stringify(data)).not.toContain("admin@example.com");
});
it("mapped requirements keep their review state, are bounded, and disclose what is missing", async () => {
  const refs = [3, 4, 5, 6, 7, 8].map(requirementId);
  const f = await fixture({ plan: { ...requestStatusPlan([201]), requirementRefs: refs } });
  storeRequirements(
    f,
    [
      storedRequirement(3, {
        text: "x".repeat(2000),
        acceptanceCriteria: ["a", "b", "c", "d", "e", "f", "g", "h"],
      }),
      storedRequirement(4, {
        approval: null,
        extensions: {
          "testmaster:rejection": { reason: "out of scope", actorId: "a", rejectedAt: "t" },
        },
      }),
      storedRequirement(5),
      storedRequirement(6, {
        approval: null,
        extensions: {
          "testmaster:decision": { action: "edited", reason: "r", actorId: "a", decidedAt: "t" },
        },
      }),
      storedRequirement(7, { approval: null }),
    ],
    [
      {
        id: "cfl_1",
        requirementIds: [requirementId(5), requirementId(7)],
        reason: "r",
        sourceRefs: [],
        resolution: { selectedRequirementId: requirementId(7), reason: "r", actorId: "a" },
      },
    ],
  );
  await f.service.analyze(f.run.id, { model: true });
  const { data } = f.complete.mock.calls[0]![0] as ModelRequestData;
  expect(data.requirements.map((item) => [item.id, item.reviewState])).toEqual([
    [requirementId(3), "approved"],
    [requirementId(4), "rejected"],
    [requirementId(5), "superseded"],
    [requirementId(6), "edited"],
    [requirementId(7), "pending"],
  ]);
  expect(String(data.requirements[0]!.text)).toHaveLength(800);
  expect(data.requirements[0]).toMatchObject({
    acceptanceCriteria: ["a", "b", "c", "d", "e", "f"],
    omittedCriteria: 2,
  });
  expect(data.limitations).toContain(
    "Mapped requirements missing from the project's current requirement snapshot: 1.",
  );
});
const unauthenticatedCriterion = (status: number) =>
  `Without credentials, the response status is ${status} and the JSON body's error.code is "unauthorized".`;
async function rejectedWithoutCredentials(
  criteria: string[] | null,
  approval: string | null = "apr_00000000-0000-4000-8000-000000000001",
  input: Record<string, unknown> = {},
) {
  const f = await fixture({
    plan: withRequestInput(requestStatusPlan([403]), input),
    step: { expected: [403], observed: 401 },
  });
  if (criteria)
    storeRequirements(f, [storedRequirement(3, { acceptanceCriteria: criteria, approval })]);
  await attachTerminalProcess(
    f,
    {
      response: { status: 401, failureExcerpt: '{"error":{"code":"unauthorized"}}' },
      redirects: [],
    },
    { relativePath: "http/request.json", kind: "http" },
  );
  const analysis = await f.service.analyze(f.run.id, {});
  return { analysis, diagnosis: analysis.diagnosis! };
}
it("a 401 answer to a request that sent no credentials makes the expectation stale when an approved criterion states 401", async () => {
  const { analysis, diagnosis } = await rejectedWithoutCredentials([unauthenticatedCriterion(401)]);
  expect(analysis).toMatchObject({ failureKind: "test_fragility", recommendedAction: "fix_test" });
  expect(diagnosis.conclusion.text).toContain("sends no valid credential by design");
  expect(diagnosis.conclusion.text).toContain(
    `approved requirement ${requirementId(3)}, acceptance criterion 1`,
  );
  expect(diagnosis.nextSteps[0]?.text).toContain("testmaster_save_test with testId");
  expect(diagnosis.nextSteps[0]?.text).toContain("CLI: test revision create");
  expect(JSON.stringify([analysis.hypotheses, diagnosis])).not.toContain(
    "refused the credentials or session",
  );
  expect(JSON.stringify(diagnosis.nextSteps)).not.toContain("is valid and bound");
  expect(diagnosis.healing.advice).toBe("not_indicated");
  // Control: a criterion that states the expected status, not the observed one, blames the target.
  const contradicted = await rejectedWithoutCredentials([unauthenticatedCriterion(403)]);
  expect(contradicted.analysis).toMatchObject({
    failureKind: "product_bug",
    recommendedAction: "fix_product",
  });
  expect(contradicted.diagnosis.conclusion.text).toContain("acceptance criterion 1");
  // Control: a criterion that names both statuses does not say which side is wrong.
  const both = await rejectedWithoutCredentials([
    `Without credentials the status is 401 or 403 depending on the gateway.`,
  ]);
  expect(both.analysis).toMatchObject({ failureKind: "unknown" });
  // A literal or deliberately invalid credential is not one the environment supplied.
  for (const headers of [
    { cookie: { invalidCredential: { cookie: "ap_session" } } },
    { authorization: { literal: "Bearer forged" } },
  ]) {
    const forged = await rejectedWithoutCredentials([unauthenticatedCriterion(401)], undefined, {
      headers,
    });
    expect(forged.analysis).toMatchObject({ failureKind: "test_fragility" });
    expect(JSON.stringify(forged.diagnosis.nextSteps)).not.toContain("is valid and bound");
  }
});
it("a 401 answer to a request that sent no credentials keeps both alternatives and no auth profile hint when no approved criterion states a status", async () => {
  for (const { criteria, approval } of [
    { criteria: null, approval: undefined },
    { criteria: ["The list is returned as a JSON array."], approval: undefined },
    // An unapproved requirement establishes nothing, even when it states the observed status.
    { criteria: [unauthenticatedCriterion(401)], approval: null },
  ]) {
    const { analysis, diagnosis } = await rejectedWithoutCredentials(criteria, approval);
    expect(analysis).toMatchObject({
      failureKind: "unknown",
      recommendedAction: "review_contract",
    });
    expect(diagnosis.conclusion.status).toBe("cause_partially_supported");
    expect(diagnosis.conclusion.text).toContain("sends no valid credential by design");
    expect(diagnosis.alternatives.map((item) => item.failureKind).sort()).toEqual([
      "product_bug",
      "test_fragility",
    ]);
    expect(JSON.stringify([analysis.hypotheses, diagnosis])).not.toContain(
      "refused the credentials or session",
    );
    expect(JSON.stringify(diagnosis.nextSteps)).not.toContain("is valid and bound");
  }
});
it("a 401 answer to a request that sends the auth profile or a secret still points at the credentials", async () => {
  for (const input of [
    { auth: "profile" },
    { headers: { "X-Api-Key": { secretRef: "sec_00000000-0000-4000-8000-000000000001" } } },
  ]) {
    const plan = withRequestInput(requestStatusPlan([200]), input);
    const f = await fixture({ plan, step: { expected: [200], observed: 401 } });
    storeRequirements(f, [
      storedRequirement(3, { acceptanceCriteria: [unauthenticatedCriterion(401)] }),
    ]);
    const analysis = await f.service.analyze(f.run.id, {});
    expect(analysis).toMatchObject({
      failureKind: "environment",
      recommendedAction: "fix_environment",
    });
    expect(analysis.diagnosis?.conclusion.text).toContain(
      "the target refused the credentials or session of request step request",
    );
    expect(analysis.diagnosis?.nextSteps[0]?.text).toContain("auth profile or secret is valid");
  }
});
it("a failed test that maps to no requirement tells the model so instead of implying one", async () => {
  const f = await fixture({ plan: { ...requestStatusPlan([201]), requirementRefs: [] } });
  await f.service.analyze(f.run.id, { model: true });
  const { data } = f.complete.mock.calls[0]![0] as ModelRequestData;
  expect(data.requirements).toEqual([]);
  expect(data.limitations.join(" ")).toContain("maps to no requirement");
});
it("a failed generated-code run maps the requirements of the plan it was generated from", async () => {
  const requirementId = "req_00000000-0000-4000-8000-0000000000c1";
  const f = await fixture({
    code: true,
    parentPlan: { ...persistencePlan, requirementRefs: [requirementId] },
    step: { planStepId: "imported-test-0" },
  });
  const analysis = await f.service.analyze(f.run.id, { model: true });
  expect(analysis.affectedRequirementIds).toEqual([requirementId]);
  const { data } = f.complete.mock.calls[0]![0] as ModelRequestData;
  expect(data.limitations.join(" ")).not.toContain("maps to no requirement");
});

const lowerFixtures = [
  { name: "a value assertion", options: {} },
  {
    name: "a status assertion",
    options: { plan: requestStatusPlan([201]), step: { expected: [201], observed: 200 } },
  },
];
/** A model reading that disagrees with nothing but reports that the observation agrees with a requirement. */
function agreementReading(
  f: Awaited<ReturnType<typeof fixture>>,
  requirementAgreement: { requirementId: string; criterionIndex: number },
) {
  f.complete.mockImplementationOnce(async () => ({
    modelCallId: f.modelCallId,
    output: {
      failureKind: "unknown",
      hypotheses: [
        {
          text: "The observed value agrees with the approved requirement; the expectation is stale.",
          supports: ["E2"],
          contradicts: [],
          confidence: 0.9,
        },
      ],
      recommendedAction: "collect_more_evidence",
      fixTargetHandle: null,
      limitations: [],
      nextSteps: [],
      evidenceGaps: [],
      requirementAgreement,
    },
  }));
}
it.each(lowerFixtures)(
  "an approved mapped requirement the observation agrees with lowers a product_bug cause from $name to unknown",
  async ({ options }) => {
    const f = await fixture(options);
    storeRequirements(f, [storedRequirement(3)]);
    const factual = await f.service.analyze(f.run.id);
    expect(factual.failureKind).toBe("product_bug");
    agreementReading(f, { requirementId: requirementId(3), criterionIndex: 0 });
    const analysis = await f.service.analyze(f.run.id, { model: true });
    expect(analysis).toMatchObject({
      source: "model",
      failureKind: "unknown",
      recommendedAction: "collect_more_evidence",
    });
    expect(analysis.diagnosis?.conclusion.status).toBe("cause_unknown");
    expect(analysis.diagnosis?.nextSteps).toHaveLength(1);
    expect(analysis.diagnosis?.nextSteps[0]?.text).toContain(requirementId(3));
    expect(analysis.diagnosis?.nextSteps[0]?.text).toContain('"Criterion 3"');
    expect(analysis.diagnosis?.healing.advice).toBe("not_indicated");
    expect(analysis.limitations).toContain(
      `The observed value agrees with approved requirement ${requirementId(3)}, acceptance criterion 1, not with the test's expectation.`,
    );
    expect(analysis.limitations).not.toContain(
      "Model abstained; the evidenced rules-derived cause is retained.",
    );
    expect(analysis.hypotheses.map((item) => item.confidence)).toEqual([0.9]);
    // The cause is unknown, so the analysis reports no confidence of its own.
    expect(analysis.confidence).toBeNull();
  },
);
it("a requirement agreement is not recorded when its requirement is pending, and the rules cause stays", async () => {
  const f = await fixture();
  storeRequirements(f, [storedRequirement(3, { approval: null })]);
  const factual = await f.service.analyze(f.run.id);
  agreementReading(f, { requirementId: requirementId(3), criterionIndex: 0 });
  const analysis = await f.service.analyze(f.run.id, { model: true });
  expect(analysis.failureKind).toBe("product_bug");
  expect(analysis.diagnosis).toEqual(factual.diagnosis);
  expect(analysis.limitations).toContain(
    "A model-reported conflict with a requirement was not recorded: its requirement is pending, not approved.",
  );
});
it("a requirement agreement naming a requirement the test does not map to is not recorded", async () => {
  const f = await fixture();
  // Requirement 4 is approved in the project but the test maps to requirement 3 only.
  storeRequirements(f, [storedRequirement(3), storedRequirement(4)]);
  const factual = await f.service.analyze(f.run.id);
  agreementReading(f, { requirementId: requirementId(4), criterionIndex: 0 });
  const analysis = await f.service.analyze(f.run.id, { model: true });
  expect(analysis.failureKind).toBe("product_bug");
  expect(analysis.diagnosis).toEqual(factual.diagnosis);
  expect(analysis.limitations).toContain(
    "A model-reported conflict with a requirement was not recorded: it names no requirement supplied for the failed test.",
  );
});
