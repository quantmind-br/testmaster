import {
  type Analysis,
  ContractError,
  type ExecutablePlan,
  type Run,
  type StepResult,
} from "@testmaster/contracts";
import { canonicalJson, semanticHash } from "@testmaster/domain";
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
import type { ModelService } from "./model.js";

const databases: PersistenceDatabase[] = [];
afterEach(() => {
  for (const db of databases.splice(0)) db.close();
});
async function fixture(
  options: {
    passed?: boolean;
    queued?: boolean;
    requestOnly?: boolean;
    schema?: boolean;
    status?: boolean;
    missing?: boolean;
    source?: boolean;
    unbound?: boolean;
    plan?: ExecutablePlan;
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
        expectation: options.schema
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
  revision.dto.plan = plan;
  revision.dto.contentHash = semanticHash(plan);
  revision.row.content_hash = revision.dto.contentHash as string;
  revision.row.data_json = canonicalJson(revision.dto);
  const runFixture = get("Run");
  const run = {
    ...runFixture.dto,
    phase: options.queued ? "queued" : "completed",
    status: options.queued ? "queued" : options.passed ? "passed" : "failed",
    outcome: options.queued ? null : options.passed ? "passed" : "failed",
    gate: options.queued ? "pending" : options.passed ? "passed" : "failed",
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
    data_json: canonicalJson(run),
  });
  const attempt = get("Attempt");
  Object.assign(attempt.dto, { phase: "completed", outcome: options.passed ? "passed" : "failed" });
  Object.assign(attempt.row, {
    phase: "completed",
    outcome: options.passed ? "passed" : "failed",
    data_json: canonicalJson(attempt.dto),
  });
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
      const item = get(kind);
      const insert = fixtureInsert(item);
      db.run(insert.sql, ...insert.values);
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
    consent: vi.fn(async () => ({
      dataClasses: ["execution_evidence", "code_summary"],
      revokedAt: null,
    })),
    config: {
      modelProviders: [{ id: "fake" }],
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
it.each([302, 401, 404])(
  "required unexpected non-success status %i remains unknown",
  async (status) => {
    const f = await fixture({ status: true });
    const stored = JSON.parse(
      String(f.db.get("SELECT data_json FROM steps WHERE id=?", f.step.id)!.data_json),
    );
    stored.observed = status;
    f.db.run("UPDATE steps SET data_json=? WHERE id=?", canonicalJson(stored), f.step.id);
    expect(await f.service.analyze(f.run.id)).toMatchObject({
      failureKind: "unknown",
      hypotheses: [],
    });
  },
);
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
async function attachLocatorEvidence(f: Awaited<ReturnType<typeof fixture>>, namedCount: number) {
  const candidates = Array.from({ length: 52 }, (_, index) => {
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
  const record: LocatorEvidence = { ...payload, evidenceHash: semanticHash(payload) };
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
    source: "model",
    parentId: factual.id,
    failureKind: factual.failureKind,
  });
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
    source: "model",
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
  expect(f.service.get(f.run.id)?.parentId).toBe(factual.id);
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
  { cite: "locator", accepted: true },
  { cite: "run", accepted: false },
])(
  "a hypothesis supported only by a $cite handle is accepted: $accepted",
  async ({ cite, accepted }) => {
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
    expect(result.modelCallId !== null).toBe(accepted);
    if (!accepted)
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
  expect(result.parentId).toBe(factual.id);
  expect(result.modelCallId).toBeNull();
  expect(result.limitations.some((value) => value.includes("unknown execution evidence"))).toBe(
    true,
  );
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
      nextSteps: [{ text: "Review whether a healing proposal is appropriate", evidence: ["E2"] }],
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

it.each([
  { handle: "E999", rejection: "unknown execution evidence" },
  { handle: "E1", rejection: "Model next step requires execution observation support" },
])(
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
        nextSteps: [{ text: "Inspect the response", evidence: [handle] }],
        evidenceGaps: [],
      },
    }));
    const analysis = await f.service.analyze(f.run.id, { model: true });
    expect(analysis.modelCallId).toBeNull();
    expect(analysis.diagnosis).toEqual(factual.diagnosis);
    expect(analysis.limitations.some((limitation) => limitation.includes(rejection))).toBe(true);
  },
);

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
