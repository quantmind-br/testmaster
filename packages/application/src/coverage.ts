import type { CoverageMetrics, ExecutablePlan, PlanStep, RatioMetric } from "@testmaster/contracts";
import type { ReportRun, ReportSnapshot } from "@testmaster/reporting";
import { coverageMetrics, ratioMetric } from "@testmaster/reporting";
import { type RequirementSnapshot, requirementStatus } from "./ai/requirements.js";
import { allEntities, type ServiceContext } from "./context.js";

export function reportCoverage(ctx: ServiceContext, snapshot: ReportSnapshot): CoverageMetrics {
  const projects = new Set(snapshot.runs.map((item) => item.projectId));
  const tests = allEntities(ctx, "TestCase");
  const revisions = allEntities(ctx, "TestRevision").filter((revision) =>
    tests.some(
      (test) =>
        test.id === revision.testId &&
        projects.has(String(test.projectId)) &&
        test.activeRevisionId === revision.id,
    ),
  );
  const mapped = revisions.flatMap(
    (value) => (value.plan as ExecutablePlan | null)?.requirementRefs ?? [],
  );
  const inScopeRequirements = inScopeRequirementIds(ctx, projects);
  const coveredOperations: string[] = [],
    declaredOperations: string[] = [],
    visitedRoutes: string[] = [];
  let operationsKnown = false;
  const operationSources = new Map<string, Record<string, unknown>[]>();
  for (const source of allEntities(ctx, "Source").filter((value) =>
    projects.has(String(value.projectId)),
  )) {
    const row = ctx.database.get(
      "SELECT value FROM operational_state WHERE key=?",
      `ai:${ctx.workspaceId}:revision:${source.activeRevisionId}`,
    );
    if (!row) continue;
    const state = JSON.parse(String(row.value)) as {
      result: {
        revision: { status: string };
        inventory: { operations?: Record<string, unknown>[] };
      };
    };
    if (state.result.revision.status !== "ready" || !state.result.inventory.operations) continue;
    operationsKnown = true;
    operationSources.set(String(source.activeRevisionId), state.result.inventory.operations);
    for (const value of state.result.inventory.operations) {
      const operation = value.operation as {
        responses?: Record<string, { content?: Record<string, { schema?: unknown }> }>;
      };
      for (const [status, response] of Object.entries(operation.responses ?? {})) {
        for (const [media, body] of Object.entries(response.content ?? {})) {
          if (body.schema) declaredOperations.push(operationPairKey(value, status, media));
        }
      }
    }
  }
  for (const item of snapshot.runs) {
    const revision = ctx.entities.get("TestRevision", ctx.workspaceId, item.run.revisionId);
    const plan = revision?.plan as ExecutablePlan | null;
    if (!plan) continue;
    const steps = planSteps(plan);
    for (const step of steps) {
      if (!item.steps.some((result) => result.planStepId === step.id && result.status === "passed"))
        continue;
      if (step.operation === "navigate") visitedRoutes.push(JSON.stringify(step.input));
      if (
        step.operation !== "assert" ||
        step.expectation.predicate !== "jsonSchema" ||
        !("responseStepId" in step.input)
      )
        continue;
      const responseStepId = step.input.responseStepId;
      const request = steps.find((value) => value.id === responseStepId);
      if (request?.operation !== "request") continue;
      const declared = operationSources.get(step.expectation.sourceRevisionId) ?? [];
      const pointer = step.expectation.pointer;
      for (const operation of declared.filter(
        (value) =>
          value.method === request.input.method &&
          pointer.startsWith(
            `/paths/${pointerToken(String(value.path))}/${String(value.method).toLowerCase()}/`,
          ) &&
          requestMatchesPath(request.input.pathSegments, String(value.path)),
      )) {
        const operationContract = operation.operation as {
          responses?: Record<string, { content?: Record<string, unknown> }>;
        };
        const responses = operationContract.responses ?? {};
        for (const [status, response] of Object.entries(responses)) {
          const statusAsserted = steps.some(
            (value) =>
              value.operation === "assert" &&
              "responseStepId" in value.input &&
              value.input.responseStepId === request.id &&
              value.expectation.predicate === "statusIn" &&
              value.expectation.values.includes(Number(status)) &&
              item.steps.some(
                (result) => result.planStepId === value.id && result.status === "passed",
              ),
          );
          if (!statusAsserted || !pointer.includes(`/responses/${status}/`)) continue;
          for (const media of Object.keys(response.content ?? {}))
            if (pointer.includes(pointerToken(media)))
              coveredOperations.push(operationPairKey(operation, status, media));
        }
      }
    }
  }
  const requested = new Set(
    snapshot.selection.requestedRunIds ?? snapshot.runs.map((item) => item.run.id),
  );
  return coverageMetrics({
    requirement: {
      covered: mapped,
      declared: inScopeRequirements,
      scope:
        "Current project requirements still in scope (rejected and superseded ones excluded) and active accepted revisions; mapping only",
    },
    route: {
      covered: visitedRoutes,
      declared: null,
      scope:
        "Observed navigation; discovery is partial and total application route inventory is unknown",
    },
    operation: {
      covered: coveredOperations,
      declared: operationsKnown ? declaredOperations : null,
      scope:
        "Distinct method/path/status/media pairs with a schema across the ready, active OpenAPI sources of the project (an operation restated by several sources counts once; path parameter names are ignored), covered by passing status and schema assertions",
    },
    code: { covered: [], declared: null, scope: "No code instrumentation supplied" },
    execution: {
      covered: snapshot.runs
        .filter(
          (item) =>
            requested.has(item.run.id) &&
            (item.result.outcome === "passed" || item.result.outcome === "failed"),
        )
        .map((item) => item.run.id),
      declared: [...requested, ...snapshot.selection.notDispatched.map((value) => value.memberKey)],
      scope: "Frozen requested selection; dependency expansion excluded",
    },
  });
}

/** The requirement ids still in scope: rejected and conflict-superseded ones are decided out. `null` when any project has no requirement snapshot. */
function inScopeRequirementIds(
  ctx: ServiceContext,
  projects: ReadonlySet<string>,
): string[] | null {
  if (!projects.size) return null;
  const inScope: string[] = [];
  for (const project of projects) {
    const row = ctx.database.get(
      "SELECT value FROM operational_state WHERE key=?",
      `requirements:${ctx.workspaceId}:${project}`,
    );
    if (!row) return null;
    const stored = JSON.parse(String(row.value)) as RequirementSnapshot;
    for (const value of stored.requirements) {
      const status = requirementStatus(value, stored.conflicts);
      if (status !== "rejected" && status !== "superseded") inScope.push(value.id);
    }
  }
  return inScope;
}

function planSteps(plan: ExecutablePlan): PlanStep[] {
  const steps: PlanStep[] = [];
  const visit = (values: readonly PlanStep[]) => {
    for (const step of values) {
      steps.push(step);
      if (step.operation === "frame") visit(step.input.childSteps);
    }
  };
  visit(plan.steps);
  return steps;
}

/**
 * One key per declared operation/status/media pair. Path parameter names are not part of an
 * operation's identity (`/v1/agents/{id}` and `/v1/agents/{agent_id}` are the same operation), so a
 * contract source that restates a product operation counts once.
 */
function operationPairKey(
  operation: { method?: unknown; path?: unknown },
  status: string,
  media: string,
): string {
  return `${operation.method} ${String(operation.path).replace(/\{[^}]*\}/g, "{}")} ${status} ${media}`;
}

/** RFC 6901 escaping of one pointer reference token. */
function pointerToken(value: string): string {
  return value.replace(/~/g, "~0").replace(/\//g, "~1");
}

/**
 * Whether a request's path segments reach an OpenAPI path template. A `{name}` in the template
 * stands for any value inside one segment, so `/items/7` reaches `/items/{id}`; a request segment
 * that is not a literal (a variable or secret) reaches only a segment that is one whole parameter.
 */
function requestMatchesPath(segments: readonly unknown[], template: string): boolean {
  const parts = template.split("/").filter(Boolean);
  return (
    parts.length === segments.length &&
    parts.every((part, index) => {
      const segment = segments[index];
      if (!segment || typeof segment !== "object" || !("literal" in segment))
        return /^\{[^}]*\}$/.test(part);
      const pattern = part
        .split(/\{[^}]*\}/)
        .map((piece) => piece.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
        .join("[^/]+");
      return new RegExp(`^${pattern}$`).test(String(segment.literal));
    })
  );
}

/** A Run counts as fresh passing evidence when it settled green on its own, not through a diagnostic retry. */
function freshPassingRun(item: ReportRun): boolean {
  const first =
    item.attempts.find((value) => value.number === 1)?.outcome ?? item.result.firstAttemptOutcome;
  return (
    item.run.mode === "replay" &&
    item.result.outcome === "passed" &&
    item.result.gate === "passed" &&
    item.evidenceState === "committed" &&
    item.freshness?.state === "current" &&
    !item.result.passedOnRetry &&
    first !== "failed"
  );
}

/** A Run is the latest of its test in a report by creation time, then by id. */
function latestRunPerTest(ctx: ServiceContext, runs: readonly ReportRun[]): ReportRun[] {
  const latest = new Map<string, { item: ReportRun; createdAt: string }>();
  for (const item of runs) {
    const createdAt = String(
      ctx.entities.get("Run", ctx.workspaceId, item.run.id)?.createdAt ?? "",
    );
    const known = latest.get(item.run.testId);
    if (
      !known ||
      createdAt > known.createdAt ||
      (createdAt === known.createdAt && item.run.id > known.item.run.id)
    )
      latest.set(item.run.testId, { item, createdAt });
  }
  return [...latest.values()].map((value) => value.item);
}

/**
 * `verifiedRequirementCoverage`: in-scope requirements whose mapped test passed a required business
 * assertion in the latest replay of the report (Run and gate passed, current revision and
 * environment, committed evidence, no diagnostic retry). Derived from recorded Run facts only.
 */
export function verifiedRequirementCoverage(
  ctx: ServiceContext,
  snapshot: ReportSnapshot,
): RatioMetric {
  const requested = new Set(
    snapshot.selection.requestedRunIds ?? snapshot.runs.map((item) => item.run.id),
  );
  const projects = new Set(snapshot.runs.map((item) => item.projectId));
  const declared = inScopeRequirementIds(ctx, projects);
  const verified = new Set<string>();
  for (const item of latestRunPerTest(
    ctx,
    snapshot.runs.filter((value) => requested.has(value.run.id)),
  )) {
    if (!freshPassingRun(item)) continue;
    const plan = ctx.entities.get("TestRevision", ctx.workspaceId, item.run.revisionId)
      ?.plan as ExecutablePlan | null;
    if (!plan) continue;
    const assertedBusiness = planSteps(plan).some(
      (step) =>
        step.kind === "assertion" &&
        step.required !== false &&
        item.steps.some((result) => result.planStepId === step.id && result.status === "passed"),
    );
    if (assertedBusiness) for (const id of plan.requirementRefs ?? []) verified.add(id);
  }
  const inScope = declared ? new Set(declared) : null;
  return ratioMetric(
    inScope ? [...verified].filter((id) => inScope.has(id)).length : verified.size,
    inScope?.size ?? null,
    "Distinct in-scope requirements with a passed required assertion in the latest fresh passing replay of a mapped active test / declared in-scope requirements",
    "Runs of this report only: latest replay per test, Run and gate passed, current test and environment revision, committed evidence, no diagnostic retry; a requirement without such a Run is uncovered",
  );
}
