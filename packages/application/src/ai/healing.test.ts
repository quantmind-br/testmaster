import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ContractError, type ExecutablePlan } from "@testmaster/contracts";
import { semanticHash } from "@testmaster/domain";
import { assertionsHash, preserveAssertions } from "@testmaster/planner";
import { afterEach, expect, it } from "vitest";
import { Application } from "../application.js";
import { scaffoldPlan } from "../authoring.js";
import { entity } from "../context.js";
import { issueLocalToken } from "../local-auth.js";
import { HealingService } from "./healing.js";
import { applyHealingPatch } from "./healing-patch.js";

const apps: Application[] = [],
  roots: string[] = [];
afterEach(async () => {
  for (const app of apps.splice(0)) app.close();
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});
function browser(): ExecutablePlan {
  const plan = scaffoldPlan("frontend");
  plan.steps = [
    {
      id: "fill_email",
      kind: "action",
      operation: "fill",
      description: "Email",
      input: { locator: { by: "testId", value: "email" }, value: { literal: "user@example.com" } },
    },
    {
      id: "frame_a",
      kind: "action",
      operation: "frame",
      description: "Payment frame",
      input: {
        locator: { by: "testId", value: "payment" },
        childSteps: [
          {
            id: "business",
            kind: "assertion",
            operation: "assert",
            description: "Exact amount",
            input: { locator: { by: "testId", value: "amount" } },
            expectation: { predicate: "textEquals", value: { literal: "10.00" } },
          },
        ],
      },
    },
    {
      id: "response_wait",
      kind: "action",
      operation: "waitFor",
      description: "Wait for save",
      input: { response: { url: "/save", status: 200 }, deadlineMs: 3000 },
    },
  ];
  return plan;
}
const patch = (stepId: string, path: string, value: unknown) => ({
  changes: [{ stepId, path, value }],
  evidenceHandles: ["E1"],
  explanation: "Observed replacement",
});
it("healing seals nested assertions, response status predicates and enclosing frame identity", () => {
  const base = browser();
  const removed = structuredClone(base);
  const frame = removed.steps[1]!;
  if (frame.operation !== "frame") throw new Error("frame");
  frame.input.childSteps = [];
  expect(() => preserveAssertions(base, removed)).toThrow(ContractError);
  const response = structuredClone(base),
    wait = response.steps[2]!;
  if (wait.operation !== "waitFor" || !("response" in wait.input)) throw new Error("wait");
  wait.input.response.status = 201;
  expect(() => preserveAssertions(base, response)).toThrow(ContractError);
  const moved = structuredClone(base),
    movedFrame = moved.steps[1]!;
  if (movedFrame.operation !== "frame") throw new Error("frame");
  moved.steps.push(...movedFrame.input.childSteps);
  movedFrame.input.childSteps = [];
  expect(() => preserveAssertions(base, moved)).toThrow(ContractError);
  expect(assertionsHash(base)).not.toBe(assertionsHash(moved));
});
it("healing rejects forbidden paths, overlapping replacements, duplicate recursive IDs and absent fields", () => {
  const base = browser();
  for (const path of [
    "/expectation",
    "/required",
    "/timeoutMs",
    "/input/response/status",
    "/input/childSteps",
    "/risk",
  ])
    expect(() => applyHealingPatch(base, patch("response_wait", path, 201))).toThrow(ContractError);
  expect(() =>
    applyHealingPatch(base, {
      ...patch("fill_email", "/input/locator", { by: "testId", value: "renamed" }),
      changes: [
        { stepId: "fill_email", path: "/input/locator", value: { by: "testId", value: "renamed" } },
        { stepId: "fill_email", path: "/input/locator", value: { by: "testId", value: "other" } },
      ],
    }),
  ).toThrow(ContractError);
  const duplicate = structuredClone(base);
  duplicate.steps.push(structuredClone(base.steps[0]!));
  expect(() =>
    applyHealingPatch(
      duplicate,
      patch("fill_email", "/input/locator", { by: "testId", value: "renamed" }),
    ),
  ).toThrow(ContractError);
  const request = scaffoldPlan("backend");
  expect(() =>
    applyHealingPatch(
      request,
      patch(request.steps[0]!.id, "/input/body", { kind: "json", value: { literal: {} } }),
    ),
  ).toThrow(ContractError);
  expect(() =>
    applyHealingPatch(
      base,
      patch("fill_email", "/input/locator", {
        by: "testId",
        value: "renamed",
        expectation: { predicate: "visible" },
      }),
    ),
  ).toThrow(ContractError);
});
it("business input replacements require manual review and retain all protected plan content", () => {
  const base = browser();
  const applied = applyHealingPatch(
    base,
    patch("fill_email", "/input/value", { literal: "other@example.com" }),
  );
  expect(applied.manualOnly).toBe(true);
  expect(assertionsHash(applied.plan)).toBe(assertionsHash(base));
  expect(applied.plan.cleanup).toEqual(base.cleanup);
});
async function fixture(verificationOutcome: "passed" | "failed" = "passed", withProposal = true) {
  const root = await mkdtemp(join(tmpdir(), "tm-healing-"));
  roots.push(root);
  const home = join(root, "home");
  await mkdir(home);
  const app = await Application.open({ cwd: root, home, env: { HOME: home } });
  apps.push(app);
  const init = await app.init();
  const test = app.tests.create({ projectId: init.projectId, plan: scaffoldPlan("backend") });
  const failed = app.runs.resolve({ testId: test.id, environmentId: init.environmentId });
  Object.assign(failed, {
    phase: "completed",
    status: "failed",
    outcome: "failed",
    gate: "failed",
  });
  app.context.entities.insert("Run", failed);
  const original = app.revisions.get(String(test.activeRevisionId));
  const { id: _id, ...baseFields } = original;
  const candidate = entity(app.context, "rev", {
    ...baseFields,
    ordinal: 2,
    parentId: original.id,
    origin: "healed",
  });
  app.context.entities.insert("TestRevision", candidate);
  const verification = app.runs.resolve({
    testId: test.id,
    environmentId: init.environmentId,
    revisionId: candidate.id,
    origin: "verification",
    mode: "replay",
    limits: { maxAttempts: 1 },
  });
  Object.assign(verification, {
    phase: "completed",
    status: verificationOutcome,
    outcome: verificationOutcome,
    gate: verificationOutcome === "passed" ? "passed" : "failed",
  });
  app.context.entities.insert("Run", verification);
  const proposal = entity(app.context, "hea", {
    failedRunId: failed.id,
    testId: test.id,
    analysisId: null,
    baseRevisionId: original.id,
    candidateRevisionId: candidate.id,
    diff: "Controlled candidate",
    changes: [],
    evidenceRefs: [],
    preservedAssertionsHash: assertionsHash(original.plan!),
    risk: "read",
    status: "approved",
    approvalMode: "manual",
    reviewerId: app.context.principalId,
    policyHash: app.config.effectiveConfig.policyHash,
    verificationRunId: verification.id,
    modelCallId: null,
    limitations: [],
  });
  if (withProposal) app.context.entities.insert("HealingProposal", proposal);
  return { app, test, failed, candidate, verification, proposal };
}
it("healing approval requires named authority and ordinary promotion cannot bypass verification", async () => {
  const f = await fixture("failed");
  const denied = new HealingService(
    {
      ...f.app.context,
      authorizeNamed() {
        throw new ContractError("FORBIDDEN", "Denied");
      },
    },
    f.app.model,
    f.app.runs,
    f.app.artifacts,
    f.app.analysis,
  );
  await expect(denied.approve(f.proposal.id, 1)).rejects.toMatchObject({ code: "FORBIDDEN" });
  expect(() => f.app.revisions.promote(f.candidate.id, Number(f.test.version))).toThrow(
    ContractError,
  );
});
it("failed verification returns to reviewable without another candidate and leaves historical failure immutable", async () => {
  const f = await fixture("failed"),
    before = semanticHash(f.app.runs.get(f.failed.id));
  const result = f.app.healing.reconcile(f.verification.id);
  expect(result.status).toBe("proposed");
  expect(result.verificationRunId).toBe(f.verification.id);
  expect(f.app.healing.reconcile(f.verification.id)).toEqual(result);
  await expect(f.app.healing.approve(result.id, Number(result.version))).rejects.toMatchObject({
    code: "PRECONDITION_FAILED",
  });
  expect(f.app.revisions.list(f.test.id)).toHaveLength(2);
  expect(semanticHash(f.app.runs.get(f.failed.id))).toBe(before);
});
it("healing reconciliation CAS preserves concurrent author edits and reports revision conflict", async () => {
  const f = await fixture();
  const concurrent = f.app.revisions.create(
    f.test.id,
    scaffoldPlan("backend"),
    String(f.test.activeRevisionId),
  );
  f.app.revisions.promote(concurrent.id, Number(f.test.version));
  expect(() => f.app.healing.reconcile(f.verification.id)).toThrow(ContractError);
  expect(f.app.healing.get(f.proposal.id).status).toBe("proposed");
  expect(f.app.tests.get(f.test.id).activeRevisionId).toBe(concurrent.id);
});
it("bound passing verification atomically promotes candidate and is restart-idempotent", async () => {
  const f = await fixture();
  const result = f.app.healing.reconcile(f.verification.id);
  expect(result.status).toBe("verified");
  expect(f.app.tests.get(f.test.id).activeRevisionId).toBe(f.candidate.id);
  expect(f.app.healing.reconcile(f.verification.id)).toEqual(result);
  expect(f.app.runs.get(f.failed.id).outcome).toBe("failed");
});
it("local capability issuance cannot broaden issuer resource grants or expiry", async () => {
  const f = await fixture();
  const issuerExpiry = new Date(Date.now() + 60000).toISOString();
  const identity = {
    principalId: f.app.context.principalId,
    scopes: ["R", "A"] as const,
    expiresAt: issuerExpiry,
    grants: [
      {
        resourceType: "HealingProposal",
        actions: ["approve"] as const,
        projectIds: [String(f.test.projectId)],
        environmentIds: [],
        expiresAt: issuerExpiry,
        grantedBy: f.app.context.principalId,
      },
    ],
  };
  const view = f.app.withIdentity({
    ...identity,
    scopes: [...identity.scopes],
    grants: identity.grants.map((grant) => ({ ...grant, actions: [...grant.actions] })),
  });
  await expect(
    issueLocalToken(view, {
      scopes: ["R", "A"],
      expiresAt: issuerExpiry,
      tokenPath: join(roots.at(-1)!, "escalation.token"),
      grants: [
        {
          resourceType: "HealingProposal",
          actions: ["approve"],
          projectIds: [],
          environmentIds: [],
          expiresAt: issuerExpiry,
          grantedBy: f.app.context.principalId,
        },
      ],
    }),
  ).rejects.toMatchObject({ code: "FORBIDDEN" });
  await expect(
    issueLocalToken(view, {
      scopes: ["R", "A"],
      expiresAt: new Date(Date.now() + 120000).toISOString(),
      tokenPath: join(roots.at(-1)!, "long-lived.token"),
      grants: [],
    }),
  ).rejects.toMatchObject({ code: "FORBIDDEN" });
});
it("healing refuses missing provider without a candidate, persists the refusal and does not regenerate", async () => {
  const f = await fixture("failed", false);
  const revisionCount = f.app.revisions.list(f.test.id).length;
  await expect(f.app.healing.propose(f.failed.id, {})).rejects.toMatchObject({
    code: "PRECONDITION_FAILED",
    details: { reason: "provider_unavailable" },
  });
  expect(f.app.revisions.list(f.test.id)).toHaveLength(revisionCount);
  expect(
    f.app.database.all("SELECT id FROM healing_proposals WHERE failed_run_id=?", f.failed.id),
  ).toHaveLength(0);
  const jobs = f.app.database.all("SELECT data_json FROM job_leases WHERE queue='healing'");
  expect(jobs).toHaveLength(1);
  expect(String(jobs[0]!.data_json)).toContain("provider_unavailable");
  await expect(f.app.healing.propose(f.failed.id, {})).rejects.toMatchObject({
    code: "PRECONDITION_FAILED",
    details: { reason: "no_regeneration" },
  });
});
it("healing refuses passed runs before creating a healing job", async () => {
  const f = await fixture("passed", false);
  await expect(f.app.healing.propose(f.verification.id, {})).rejects.toMatchObject({
    code: "PRECONDITION_FAILED",
    details: { reason: "not_failed" },
  });
  expect(f.app.database.all("SELECT id FROM job_leases WHERE queue='healing'")).toHaveLength(0);
});
