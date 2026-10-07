import {
  ContractError,
  type ExecutablePlan,
  type Run,
  type StepResult,
} from "@testmaster/contracts";
import { canonicalJson, semanticHash } from "@testmaster/domain";
import { EntityRepository, PersistenceDatabase } from "@testmaster/persistence";
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
  const plan: ExecutablePlan = {
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
it("missing JSON value does not establish an approved schema violation", async () => {
  const f = await fixture({ missing: true });
  expect((await f.service.analyze(f.run.id)).failureKind).toBe("unknown");
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
    modelCallId: "mdl_00000000-0000-4000-8000-000000000009",
    output: {
      failureKind: "product_bug",
      hypotheses: [
        { text: "Observed mismatch", supports: ["E2"], contradicts: [], confidence: 0.5 },
      ],
      recommendedAction: "fix_product",
      fixTargetHandle: "E2",
      limitations: [],
    },
  }));
  const result = await f.service.analyze(f.run.id, { model: true });
  expect(result.fixTarget).toBeUndefined();
  expect(
    result.limitations.some((value) =>
      value.includes("Fix target is not authorized source evidence"),
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
    },
  }));
  const result = await unbound.service.analyze(unbound.run.id, {
    model: true,
    discoveryId: unbound.detail.job.id,
  });
  expect(result.fixTarget).toBeUndefined();
  expect(result.limitations).toContain("Frozen Run is unbound; no source targets supplied.");
});
