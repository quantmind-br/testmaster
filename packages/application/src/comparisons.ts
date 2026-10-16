import {
  ContractError,
  type EffectiveConfig,
  type JsonValue,
  type Run,
  validate,
} from "@testmaster/contracts";
import { semanticHash } from "@testmaster/domain";
import type { EntityDocument } from "@testmaster/persistence";
import { allEntities, requireEntity, type ServiceContext } from "./context.js";
import type { AdmissionSnapshot } from "./provenance.js";
import { withoutEnvironment } from "./run-config.js";
import type { BatchesService, RunsService } from "./runs.js";

export interface ComparisonPage {
  limit?: number;
  cursor?: string;
}
export interface ComparisonResult {
  comparability: "comparable" | "partially_comparable" | "incomparable";
  reasons: string[];
  differences: { field: string; left: unknown; right: unknown }[];
  nextCursor: string | null;
  comparisonIdentity: string;
}
export function runMatrixCell(run: Run): Record<string, JsonValue> {
  if (!run.matrixCell || typeof run.matrixCell !== "object" || Array.isArray(run.matrixCell))
    throw new ContractError("PRECONDITION_FAILED", "Run has no frozen matrix object");
  return run.matrixCell;
}
export function runComparability(
  left: Run,
  right: Run,
): Pick<ComparisonResult, "comparability" | "reasons"> {
  const leftCell = runMatrixCell(left);
  const rightCell = runMatrixCell(right);
  const l = leftCell.admissionSnapshot as unknown as AdmissionSnapshot | undefined;
  const r = rightCell.admissionSnapshot as unknown as AdmissionSnapshot | undefined;
  if (
    left.testId !== right.testId ||
    (l &&
      r &&
      semanticHash(l.requiredCapabilities ?? []) !== semanticHash(r.requiredCapabilities ?? []))
  )
    return { comparability: "incomparable", reasons: ["different-logical-test-or-runner"] };
  const reasons: string[] = [];
  if (left.revisionId !== right.revisionId) reasons.push("revision-changed");
  if (left.environmentRevisionId !== right.environmentRevisionId)
    reasons.push("environment-changed");
  // The environment is compared through its revision and hash; the recorded `environment` section
  // only restates that revision, so it must not report a second, execution-config difference.
  const configs = [leftCell, rightCell].map((cell) =>
    semanticHash(
      cell.effectiveConfig
        ? withoutEnvironment(cell.effectiveConfig as unknown as EffectiveConfig)
        : null,
    ),
  );
  if (
    configs[0] !== configs[1] ||
    semanticHash([leftCell.limits ?? null, leftCell.stepTimeoutCapMs ?? null]) !==
      semanticHash([rightCell.limits ?? null, rightCell.stepTimeoutCapMs ?? null])
  )
    reasons.push("execution-config-changed");
  if (!l || !r) reasons.push("admission-provenance-unavailable");
  else {
    for (const field of [
      "sourceRevisions",
      "inputFixtureHashes",
      "policyHash",
      "runnerImageDigest",
      "browserImageDigest",
      "runtimeIdentity",
      "modelConfigHash",
      "generationModel",
      "environmentHash",
      "seed",
    ] as const)
      if (semanticHash(l[field] ?? null) !== semanticHash(r[field] ?? null))
        reasons.push(`${field}-changed`);
    if (
      !l.repository?.commitSha ||
      !r.repository?.commitSha ||
      l.repository.binding !== "verified" ||
      r.repository.binding !== "verified"
    )
      reasons.push("source-binding-unavailable");
    else if (semanticHash(l.repository) !== semanticHash(r.repository))
      reasons.push("repository-provenance-changed");
    if (
      !l.runnerImageDigest ||
      !r.runnerImageDigest ||
      !l.runtimeIdentity?.nodeVersion ||
      !r.runtimeIdentity?.nodeVersion ||
      (l.requiredCapabilities.includes("playwright") &&
        (!l.runtimeIdentity.browserVersion ||
          !r.runtimeIdentity.browserVersion ||
          !l.runtimeIdentity.playwrightVersion ||
          !r.runtimeIdentity.playwrightVersion))
    )
      reasons.push("runtime-identity-unavailable");
  }
  return { comparability: reasons.length ? "partially_comparable" : "comparable", reasons };
}
export function comparisonPage(
  identity: string,
  result: Omit<ComparisonResult, "comparisonIdentity" | "nextCursor">,
  page: ComparisonPage = {},
): ComparisonResult {
  const limit = page.limit ?? 50;
  if (!Number.isInteger(limit) || limit < 1 || limit > 100)
    throw new ContractError("INVALID_ARGUMENT", "Comparison limit must be 1–100");
  let offset = 0;
  if (page.cursor) {
    try {
      const cursor = JSON.parse(Buffer.from(page.cursor, "base64url").toString()) as {
        identity: string;
        offset: number;
        hash: string;
      };
      if (
        cursor.identity !== identity ||
        !Number.isSafeInteger(cursor.offset) ||
        cursor.offset < 0 ||
        cursor.offset >= result.differences.length ||
        cursor.hash !== semanticHash({ identity, offset: cursor.offset })
      )
        throw new Error("Invalid cursor");
      offset = cursor.offset;
    } catch {
      throw new ContractError(
        "INVALID_ARGUMENT",
        "Comparison cursor is invalid or belongs to another comparison",
      );
    }
  }
  const next = offset + limit;
  return validate<ComparisonResult>("ComparisonResult", {
    ...result,
    differences: result.differences.slice(offset, next),
    comparisonIdentity: identity,
    nextCursor:
      next < result.differences.length
        ? Buffer.from(
            JSON.stringify({
              identity,
              offset: next,
              hash: semanticHash({ identity, offset: next }),
            }),
          ).toString("base64url")
        : null,
  });
}
export function logicalRunKey(run: Run): string {
  const cell = runMatrixCell(run);
  const config = cell.effectiveConfig as { config?: { browser?: unknown } } | undefined;
  return semanticHash({
    testId: run.testId,
    environmentId: cell.environmentId ?? run.environmentRevisionId,
    browser: config?.config?.browser ?? null,
    seed: cell.seed ?? null,
    repetitionIndex: cell.repetitionIndex ?? null,
  });
}
/** Fields of `left` whose semantic hash differs from the same field of `right`, in `left` key order. */
export function metadataDifferences(
  left: Record<string, unknown>,
  right: Record<string, unknown>,
): { field: string; left: unknown; right: unknown }[] {
  return Object.keys(left).flatMap((field) => {
    const a = left[field];
    const b = right[field];
    return semanticHash(a) === semanticHash(b) ? [] : [{ field, left: a, right: b }];
  });
}
type StepRecord = Record<string, unknown>;
/** One side of a comparison, reduced to what can be compared across runners. */
export interface ComparedSide {
  runner: unknown;
  /** Where the step ids come from: the frozen plan, or the Playwright reporter for imported code. */
  stepKind: "plan" | "code";
  /** The plan's statusIn assertion ids; null when the revision has no plan. */
  statusAssertionIds: ReadonlySet<string> | null;
  steps: readonly StepRecord[];
}
const isHttpStatus = (value: unknown): value is number =>
  typeof value === "number" && Number.isInteger(value) && value >= 100 && value <= 599;
/** The statusIn assertion ids of a plan, frames included. */
export function statusAssertionIds(
  plan: { steps?: StepRecord[] } | null,
): ReadonlySet<string> | null {
  if (!plan) return null;
  const ids = new Set<string>();
  const visit = (steps: StepRecord[]) => {
    for (const step of steps) {
      if ((step.expectation as { predicate?: string } | undefined)?.predicate === "statusIn")
        ids.add(String(step.id));
      const input = step.input as { childSteps?: StepRecord[] } | undefined;
      if (step.operation === "frame" && Array.isArray(input?.childSteps)) visit(input.childSteps);
    }
  };
  visit(plan.steps ?? []);
  return ids;
}
function stepSummary(step: StepRecord | undefined) {
  if (!step) return null;
  const error = step.error as { message?: string } | null | undefined;
  return {
    stepId: step.planStepId ?? null,
    status: step.status ?? null,
    reasonCode: step.reasonCode ?? null,
    expected: step.expected ?? null,
    observed: step.observed ?? null,
    error: typeof error?.message === "string" ? error.message : null,
  };
}
/**
 * The step a failed Run is about: the first failed one that carries details, else the first failed.
 * A code step whose test threw before any assertion is inconclusive and carries its error.
 */
function failingStep(steps: readonly StepRecord[]): StepRecord | undefined {
  const failed = steps.filter(
    (step) => step.status === "failed" || (step.status === "inconclusive" && step.error),
  );
  return (
    failed.find((step) => step.error || step.expected != null || step.observed != null) ?? failed[0]
  );
}
/** Every HTTP status a side's steps compared: the expected set and the status that was observed. */
function comparedStatuses(side: ComparedSide) {
  return side.steps.flatMap((step) => {
    const id = String(step.planStepId);
    const expected = Array.isArray(step.expected) ? step.expected : [step.expected];
    if (
      !isHttpStatus(step.observed) ||
      !expected.length ||
      !expected.every(isHttpStatus) ||
      (side.statusAssertionIds && !side.statusAssertionIds.has(id))
    )
      return [];
    return [{ stepId: id, expected, observed: step.observed, status: step.status ?? null }];
  });
}
function describeSteps(side: ComparedSide) {
  const byStatus: Record<string, number> = {};
  for (const step of side.steps) {
    const status = String(step.status);
    byStatus[status] = (byStatus[status] ?? 0) + 1;
  }
  return {
    runner: side.runner,
    stepSource:
      side.stepKind === "plan"
        ? "frozen plan step ids"
        : "Playwright reporter ordinals (imported-test-N, imported-step-N); they name no plan step",
    stepCount: side.steps.length,
    byStatus,
    stepIds: side.steps.slice(0, 20).map((step) => step.planStepId ?? null),
  };
}
/**
 * Differences two Runs of one test can still be read for when their steps cannot be paired: a plan
 * step and an imported-code step share no identity, so the steps themselves are listed per side
 * (`stepComparison`) and what both sides do state (the failing step with its expected and observed
 * values, the HTTP statuses compared, steps that do share an id) is compared directly.
 */
export function crossRunnerDifferences(
  left: ComparedSide,
  right: ComparedSide,
): ComparisonResult["differences"] {
  const differences: ComparisonResult["differences"] = [
    { field: "stepComparison", left: describeSteps(left), right: describeSteps(right) },
  ];
  const failing = [stepSummary(failingStep(left.steps)), stepSummary(failingStep(right.steps))];
  if (semanticHash(failing[0]) !== semanticHash(failing[1]))
    differences.push({ field: "failingStep", left: failing[0], right: failing[1] });
  const statuses = [comparedStatuses(left), comparedStatuses(right)];
  if (semanticHash(statuses[0]) !== semanticHash(statuses[1]))
    differences.push({ field: "statusCodes", left: statuses[0], right: statuses[1] });
  const rightById = new Map(right.steps.map((step) => [String(step.planStepId), step]));
  const paired = left.steps.flatMap((step) => {
    const other = rightById.get(String(step.planStepId));
    const a = stepSummary(step);
    const b = stepSummary(other);
    return other && semanticHash(a) !== semanticHash(b) ? [{ a, b }] : [];
  });
  if (paired.length)
    differences.push({
      field: "pairedSteps",
      left: paired.map((entry) => entry.a),
      right: paired.map((entry) => entry.b),
    });
  return differences;
}
export class ComparisonsService {
  constructor(
    readonly ctx: ServiceContext,
    readonly runService: RunsService,
    readonly batchService: BatchesService,
  ) {}
  runs(leftRunId: string, rightRunId: string, page?: ComparisonPage): ComparisonResult {
    const left = this.runService.get(leftRunId);
    const right = this.runService.get(rightRunId);
    if (left.phase !== "completed" || right.phase !== "completed")
      throw new ContractError("PRECONDITION_FAILED", "Comparison requires terminal Runs");
    const metadata = (run: Run) => {
      const cell = runMatrixCell(run);
      const revision = requireEntity(this.ctx, "TestRevision", run.revisionId);
      const baselines: { stepId: string; framePath: string[]; baselineId: string }[] = [];
      const visit = (steps: Record<string, unknown>[], framePath: string[] = []) => {
        for (const step of steps) {
          const expectation = step.expectation as
            | { predicate?: string; baselineId?: string }
            | undefined;
          if (expectation?.predicate === "visualMatches" && expectation.baselineId)
            baselines.push({
              stepId: String(step.id),
              framePath,
              baselineId: expectation.baselineId,
            });
          const input = step.input as { childSteps?: Record<string, unknown>[] } | undefined;
          if (step.operation === "frame" && Array.isArray(input?.childSteps))
            visit(input.childSteps, [...framePath, String(step.id)]);
        }
      };
      const plan = revision.plan as { steps?: Record<string, unknown>[] } | null;
      visit(plan?.steps ?? []);
      const attempts = allEntities(this.ctx, "Attempt").filter((a) => a.runId === run.id);
      const artifacts = allEntities(this.ctx, "Artifact")
        .filter((a) => a.runId === run.id)
        .map((a) => {
          const tombstone = this.ctx.database.get(
            "SELECT value FROM operational_state WHERE key=?",
            `retention:artifact:${this.ctx.workspaceId}:${a.id}`,
          );
          return {
            kind: a.kind,
            hash: a.hash,
            state: tombstone ? "revoked" : a.state,
            redactionStatus: a.redactionStatus,
            relativePath: String(a.storageKey).split("/").slice(4).join("/"),
          };
        })
        .sort((a, b) => a.relativePath.localeCompare(b.relativePath));
      const batch = run.batchId ? requireEntity(this.ctx, "BatchRun", run.batchId) : null;
      const selection = batch?.selectionSnapshot as { requestedRunIds?: string[] } | undefined;
      return {
        testId: run.testId,
        revisionId: run.revisionId,
        runner: revision.runnerKind,
        revisionOrigin: revision.origin,
        generationModelCallId:
          (cell.admissionSnapshot as Record<string, unknown> | undefined)?.generationModelCallId ??
          null,
        baselines,
        environmentRevisionId: run.environmentRevisionId,
        admission: cell.admissionSnapshot ?? null,
        outcome: run.outcome,
        gate: run.gate,
        cleanupOutcome: run.cleanupOutcome,
        steps: this.runService
          .steps(run.id)
          .map(({ id: _id, attemptId: _attemptId, ...step }) => step),
        artifacts,
        durations: attempts.map((a) => ({
          number: a.number,
          durationMs:
            typeof a.startedAt === "string" && typeof a.endedAt === "string"
              ? Date.parse(a.endedAt) - Date.parse(a.startedAt)
              : null,
        })),
        requested: selection?.requestedRunIds?.includes(run.id) ?? true,
      };
    };
    const l = metadata(left);
    const r = metadata(right);
    const differences = metadataDifferences(l, r);
    const comparability = runComparability(left, right);
    const side = (run: Run, compared: typeof l): ComparedSide => {
      const plan = requireEntity(this.ctx, "TestRevision", run.revisionId).plan as {
        steps?: Record<string, unknown>[];
      } | null;
      return {
        runner: compared.runner,
        stepKind: plan ? "plan" : "code",
        statusAssertionIds: statusAssertionIds(plan),
        steps: compared.steps,
      };
    };
    const leftSide = side(left, l);
    const rightSide = side(right, r);
    if (l.runner !== r.runner) {
      comparability.comparability = "incomparable";
      comparability.reasons.push("different-runner");
    }
    // A plan step and an imported-code step share no identity, whatever their runner: the steps
    // cannot be diffed one by one, so the sides are compared on what both state.
    if (l.runner !== r.runner || leftSide.stepKind !== rightSide.stepKind) {
      comparability.reasons.push("step-diff-unavailable");
      differences.unshift(...crossRunnerDifferences(leftSide, rightSide));
    }
    return comparisonPage(
      semanticHash({ leftRunId, rightRunId, l, r }),
      { ...comparability, differences },
      page,
    );
  }
  batches(leftBatchId: string, rightBatchId: string, page?: ComparisonPage): ComparisonResult {
    const left = this.batchService.get(leftBatchId);
    const right = this.batchService.get(rightBatchId);
    const members = (batch: EntityDocument) => {
      const map = new Map<string, Run[]>();
      for (const id of batch.memberRuns as string[]) {
        const run = this.runService.get(id);
        if (run.phase !== "completed")
          throw new ContractError(
            "PRECONDITION_FAILED",
            "Comparison requires terminal batch members",
          );
        const key = logicalRunKey(run);
        const bucket = map.get(key) ?? [];
        bucket.push(run);
        map.set(key, bucket);
      }
      return map;
    };
    const l = members(left);
    const r = members(right);
    const differences: ComparisonResult["differences"] = [];
    const reasons: string[] = [];
    let comparability: ComparisonResult["comparability"] = "comparable";
    for (const key of [...new Set([...l.keys(), ...r.keys()])].sort()) {
      const a = l.get(key) ?? [];
      const b = r.get(key) ?? [];
      if (a.length > 1 || b.length > 1) {
        reasons.push("ambiguous-logical-member-key");
        comparability = "incomparable";
        differences.push({
          field: `ambiguous-${key}`,
          left: a.map((run) => run.id),
          right: b.map((run) => run.id),
        });
        continue;
      }
      if (!a.length || !b.length) {
        if (comparability === "comparable") comparability = "partially_comparable";
        reasons.push("member-added-or-removed");
        differences.push({
          field: `member-${key}`,
          left: a[0]?.id ?? null,
          right: b[0]?.id ?? null,
        });
        continue;
      }
      const comparison = this.runs(a[0]!.id, b[0]!.id, { limit: 100 });
      if (comparison.comparability === "incomparable") comparability = "incomparable";
      else if (
        comparison.comparability === "partially_comparable" &&
        comparability === "comparable"
      )
        comparability = "partially_comparable";
      reasons.push(...comparison.reasons);
      differences.push(
        ...comparison.differences.map((difference) => ({
          ...difference,
          field: `${key}-${difference.field}`,
        })),
      );
    }
    for (const field of ["requestedCount", "rejectedMembers"])
      if (semanticHash(left[field]) !== semanticHash(right[field]))
        differences.push({ field, left: left[field], right: right[field] });
    const leftSelection = left.selectionSnapshot as {
      requestedRunIds?: string[];
      selective?: { excluded?: unknown };
    };
    const rightSelection = right.selectionSnapshot as {
      requestedRunIds?: string[];
      selective?: { excluded?: unknown };
    };
    for (const [field, a, b] of [
      [
        "expandedCount",
        (left.memberRuns as string[]).length -
          (leftSelection.requestedRunIds?.length ?? Number(left.requestedCount)),
        (right.memberRuns as string[]).length -
          (rightSelection.requestedRunIds?.length ?? Number(right.requestedCount)),
      ],
      [
        "quarantineExclusions",
        leftSelection.selective?.excluded ?? [],
        rightSelection.selective?.excluded ?? [],
      ],
    ] as const)
      if (semanticHash(a) !== semanticHash(b)) differences.push({ field, left: a, right: b });
    const result = { comparability, reasons: [...new Set(reasons)], differences };
    return comparisonPage(semanticHash({ leftBatchId, rightBatchId, result }), result, page);
  }
}
