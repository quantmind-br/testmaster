import { type Application, applyHealingPatch, scaffoldPlan } from "@testmaster/application";
import type { ExecutablePlan } from "@testmaster/contracts";
import { semanticHash, uuidV7IdGenerator } from "@testmaster/domain";
import { SqliteModelCallRecorder } from "@testmaster/persistence";
import { assertionsHash } from "@testmaster/planner";
import { entity } from "../../packages/application/src/context.js";
import { seedRun } from "../../packages/application/src/run-seed.testing.js";

/** Where fixtures are created: a system-scoped Application plus an existing project and environment. */
export interface FixtureScope {
  readonly system: Application;
  readonly workspaceId: string;
  readonly projectId: string;
  readonly environmentId: string;
}

const locatorChange = {
  stepId: "submit-login",
  path: "/input/locator",
  value: { by: "testId", value: "sign-in" },
};

export async function createFailedRun(scope: FixtureScope, testId: string, withAnalysis: boolean) {
  const seeded = await seedRun(scope.system, {
    testId,
    environmentId: scope.environmentId,
    attempts: [
      {
        outcome: "failed",
        steps: [
          { stepId: "open-login", status: "passed" },
          {
            stepId: "submit-login",
            status: "failed",
            reasonCode: "assertion_timeout",
            expected: "A button named Sign in",
            observed: "No element matched role=button name=Sign in",
          },
          { stepId: "check-error", status: "blocked", reasonCode: "upstream_failed" },
        ],
      },
    ],
  });
  if (withAnalysis) await scope.system.analysis.analyze(seeded.runId);
  return seeded;
}

/** A failed Run with a model-sourced analysis and one recorded model call. */
export async function createModelAnalysisRun(scope: FixtureScope) {
  const test = scope.system.tests.create({
    projectId: scope.projectId,
    plan: scaffoldPlan("frontend"),
  });
  // A model analysis always enriches an immutable factual (rules) analysis of the same Run.
  const failed = await createFailedRun(scope, test.id, true);
  const factual = scope.system.analysis.get(failed.runId);
  if (!factual) throw new Error("The factual analysis is missing");
  const modelCallId = uuidV7IdGenerator.next("mdl");
  await new SqliteModelCallRecorder(scope.system.database).record({
    id: modelCallId,
    workspaceId: scope.workspaceId,
    projectId: scope.projectId,
    createdAt: new Date().toISOString(),
    purpose: "analyze",
    provider: "quantforge",
    model: "qwen3.8-flash",
    promptHash: `sha256:${"a".repeat(64)}`,
    runId: failed.runId,
    inputRefs: [],
    usage: { inputTokens: 1234, outputTokens: 321, reasoningTokens: 87, cachedInputTokens: 0 },
    cost: "unknown",
    latency: 900,
    outcome: "success",
    cacheHit: false,
    repairAttempt: 0,
    transportAttempt: 1,
    reservationId: null,
    responseHash: null,
    finishReason: "stop",
  });
  const attemptId = failed.attemptIds[0] as string;
  const ref = { runId: failed.runId, attemptId, stepId: "submit-login" };
  scope.system.context.entities.insert(
    "Analysis",
    entity(scope.system.context, "ana", {
      runId: failed.runId,
      snapshotId: factual.snapshotId,
      parentId: factual.id,
      source: "model",
      affectedRequirementIds: [],
      facts: [{ text: "The sign-in button was not found", evidenceRefs: [ref] }],
      hypotheses: [
        {
          text: "The button was renamed in the latest release",
          supports: [ref],
          contradicts: [],
          confidence: 0.62,
          calibrated: false,
          support: "partially_supported",
        },
        {
          text: "<img src=x onerror=alert(1)> The page was served by a stale cache",
          supports: [],
          contradicts: [ref],
          confidence: 0.2,
          calibrated: false,
          support: "partially_supported",
        },
      ],
      failureKind: "test_fragility",
      confidence: 0.62,
      modelCallId,
      limitations: ["Model output is not calibrated against measured outcomes"],
      recommendedAction: "fix_test",
      diagnosis: {
        observation: {
          stepId: "submit-login",
          operation: "click",
          summary: "The click target was not found",
          expected: "A button named Sign in",
          observed: "No element matched",
          absence: null,
          evidenceRefs: [ref],
        },
        chain: [],
        alternatives: [],
        conclusion: { status: "cause_partially_supported", text: "Likely a renamed control" },
        nextSteps: [
          { text: "Compare the page with the baseline", source: "model", evidenceRefs: [ref] },
        ],
        evidenceGaps: ["No DOM snapshot of the failing page"],
        healing: { advice: "proposal_possible", reason: "The locator is the only difference." },
      },
    }),
  );
  return failed;
}

export interface ProposalOptions {
  /** The candidate also weakens an assertion, so its assertions are not intact. */
  readonly weakenAssertion?: boolean;
}

/** A proposal exactly as `healing.propose` stores it: a candidate revision plus the entity. */
export function insertProposal(
  scope: FixtureScope,
  testId: string,
  failedRunId: string,
  options: ProposalOptions = {},
) {
  const test = scope.system.tests.get(testId);
  const base = scope.system.revisions.get(String(test.activeRevisionId));
  const { id: _id, ...baseFields } = base;
  const applied = applyHealingPatch(base.plan as ExecutablePlan, {
    changes: [locatorChange],
    evidenceHandles: ["E1"],
    explanation: "The sign-in button is now identified by its test id instead of its role.",
  });
  const plan = structuredClone(applied.plan);
  if (options.weakenAssertion) {
    const assertion = plan.steps.find((step) => step.id === "check-error");
    if (assertion?.kind !== "assertion") throw new Error("Missing assertion step");
    assertion.expectation = { predicate: "visible" };
  }
  const ordinal =
    Math.max(...scope.system.revisions.list(testId).map((revision) => Number(revision.ordinal))) +
    1;
  const candidate = entity(scope.system.context, "rev", {
    ...baseFields,
    ordinal,
    parentId: base.id,
    origin: "healed",
    plan,
    contentHash: semanticHash(plan, "plan"),
    extensions: { "testmaster:verificationRequired": true },
  });
  scope.system.context.entities.insert("TestRevision", candidate);
  const proposal = entity(scope.system.context, "hea", {
    failedRunId,
    testId,
    analysisId: null,
    baseRevisionId: base.id,
    candidateRevisionId: candidate.id,
    diff: "The sign-in button is now identified by its test id instead of its role.",
    changes: [locatorChange],
    evidenceRefs: [{ runId: failedRunId }],
    preservedAssertionsHash: assertionsHash(base.plan as ExecutablePlan),
    risk: "read",
    status: "proposed",
    approvalMode: null,
    reviewerId: null,
    policyHash: null,
    verificationRunId: null,
    modelCallId: null,
    limitations: ["Locator equivalence evidence unavailable; manual review required"],
  });
  scope.system.context.entities.insert("HealingProposal", proposal);
  return { proposalId: proposal.id, candidateId: candidate.id, baseId: base.id };
}

export async function newScenario(scope: FixtureScope, options: ProposalOptions = {}) {
  const test = scope.system.tests.create({
    projectId: scope.projectId,
    plan: scaffoldPlan("frontend"),
  });
  const failed = await createFailedRun(scope, test.id, false);
  return { test, failed, ...insertProposal(scope, test.id, failed.runId, options) };
}
