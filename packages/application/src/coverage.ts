import type { CoverageMetrics, ExecutablePlan, PlanStep } from "@testmaster/contracts";
import type { ReportSnapshot } from "@testmaster/reporting";
import { coverageMetrics } from "@testmaster/reporting";
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
  const requirements = allEntities(ctx, "Requirement").filter((value) => {
    const extensions = value.extensions as Record<string, unknown> | undefined;
    return projects.has(String(extensions?.["testmaster:projectId"]));
  });
  const requirementsKnown =
    projects.size > 0 &&
    [...projects].every((project) =>
      ctx.database.get(
        "SELECT value FROM operational_state WHERE key=?",
        `requirements:${ctx.workspaceId}:${project}`,
      ),
    );
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
          if (body.schema)
            declaredOperations.push(`${value.method} ${value.path} ${status} ${media}`);
        }
      }
    }
  }
  for (const item of snapshot.runs) {
    const revision = ctx.entities.get("TestRevision", ctx.workspaceId, item.run.revisionId);
    const plan = revision?.plan as ExecutablePlan | null;
    if (!plan) continue;
    const steps: PlanStep[] = [];
    const visit = (values: readonly PlanStep[]) => {
      for (const step of values) {
        steps.push(step);
        if (step.operation === "frame") visit(step.input.childSteps);
      }
    };
    visit(plan.steps);
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
      const path = `/${request.input.pathSegments.map((value) => ("literal" in value ? String(value.literal) : "{unknown}")).join("/")}`;
      const declared = operationSources.get(step.expectation.sourceRevisionId) ?? [];
      for (const operation of declared.filter(
        (value) => value.method === request.input.method && value.path === path,
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
          if (!statusAsserted || !step.expectation.pointer.includes(`/responses/${status}/`))
            continue;
          for (const media of Object.keys(response.content ?? {}))
            if (step.expectation.pointer.includes(media.replace(/~/g, "~0").replace(/\//g, "~1")))
              coveredOperations.push(`${operation.method} ${operation.path} ${status} ${media}`);
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
      declared: requirementsKnown ? requirements.map((value) => value.id) : null,
      scope: "Current project requirement inventory and active accepted revisions; mapping only",
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
        "Ready current OpenAPI sources; method/path/status/media/schema pairs with passing status and schema assertions",
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
