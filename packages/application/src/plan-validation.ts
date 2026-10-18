import {
  ContractError,
  type ExecutablePlan,
  type PlanIssue,
  type PlanStep,
  type PlanValidation,
  type planValidationChecks,
  validate,
} from "@testmaster/contracts";
import { validateProposalPlan } from "@testmaster/planner";
import { schemaCitations, sourceSchemasFor, unusableSchemas } from "./ai/source-documents.js";
import { allEntities, requireEntity, type ServiceContext } from "./context.js";
import { captureDeclarations } from "./runs.js";

type Check = (typeof planValidationChecks)[number];
const semanticChecks: Record<string, { check: Check; code: string }> = {
  responseReference: { check: "sequence", code: "response_before_use" },
  unique: { check: "sequence", code: "duplicate_identifier" },
  binding: { check: "references", code: "undeclared_variable" },
  predicateInput: { check: "types", code: "predicate_input" },
  runner: { check: "types", code: "runner_mismatch" },
  requiredAssertion: { check: "assertions", code: "required_assertion_missing" },
  vacuousCount: { check: "assertions", code: "vacuous_count" },
  nthCount: { check: "assertions", code: "nth_count" },
};

/** The id of the innermost step a JSON pointer passes through, so an issue names a step, not just a path. */
export function stepIdAt(raw: unknown, pointer: string): string | null {
  let current: unknown = raw;
  let found: string | null = null;
  for (const segment of pointer.split("/").slice(1)) {
    if (!current || typeof current !== "object") break;
    current = (current as Record<string, unknown>)[
      segment.replaceAll("~1", "/").replaceAll("~0", "~")
    ];
    const candidate = current as { id?: unknown; kind?: unknown } | null;
    if (
      candidate &&
      typeof candidate === "object" &&
      "kind" in candidate &&
      typeof candidate.id === "string"
    )
      found = candidate.id;
  }
  return found;
}

function secretRefs(value: unknown, path = ""): { ref: string; path: string }[] {
  if (Array.isArray(value))
    return value.flatMap((item, index) => secretRefs(item, `${path}/${index}`));
  if (!value || typeof value !== "object") return [];
  return Object.entries(value as Record<string, unknown>).flatMap(([key, child]) =>
    key === "secretRef" && typeof child === "string"
      ? [{ ref: child, path: `${path}/${key}` }]
      : secretRefs(child, `${path}/${key}`),
  );
}

/**
 * The editor's pre-run checks (UX-022): structure, sequence, types, references, assertions, dependencies,
 * secrets and permissions. Nothing is persisted and no model is called; every issue names a JSON pointer and,
 * when it sits inside a step, that step.
 */
export class PlanValidationService {
  constructor(readonly ctx: ServiceContext) {}

  validate(
    projectId: string,
    input: { plan: unknown; environmentId?: string | undefined; testId?: string | undefined },
  ): PlanValidation {
    this.ctx.authorize("R", projectId);
    requireEntity(this.ctx, "Project", projectId);
    const issues: PlanIssue[] = [];
    const checked = new Set<Check>(["structure"]);
    const push = (
      check: Check,
      code: string,
      field: string,
      message: string,
      stepId: string | null = stepIdAt(input.plan, field),
    ): void => {
      checked.add(check);
      issues.push({ severity: "error", code, field, stepId, message });
    };
    let plan: ExecutablePlan | null = null;
    try {
      plan = validate<ExecutablePlan>("ExecutablePlan", input.plan);
      for (const check of ["sequence", "types", "references", "assertions"] as const)
        checked.add(check);
    } catch (error) {
      if (!(error instanceof ContractError) || error.code !== "INVALID_ARGUMENT") throw error;
      const issueList = error.issues.length
        ? error.issues
        : [{ path: "", rule: "schema", message: error.message }];
      const semantic = issueList.every((item) => item.rule in semanticChecks);
      for (const item of issueList) {
        const mapped = semanticChecks[item.rule];
        if (mapped) push(mapped.check, mapped.code, item.path, item.message);
        else push("structure", `schema_${item.rule}`, item.path, item.message);
      }
      // Schema errors stop the semantic pass; semantic errors mean it ran in full.
      if (semantic)
        for (const check of ["sequence", "types", "references", "assertions"] as const)
          checked.add(check);
    }
    if (plan) {
      try {
        validateProposalPlan(plan);
      } catch (error) {
        if (!(error instanceof ContractError)) throw error;
        const reasonCode = error.details.reasonCode;
        const code = typeof reasonCode === "string" ? reasonCode : "trivial_assertion";
        // An error that locates its causes reports each at its step; the others speak for the plan.
        if (error.issues.length)
          for (const { path, message } of error.issues) push("assertions", code, path, message);
        else push("assertions", code, "/steps", error.message, null);
      }
      checked.add("dependencies");
      checked.add("secrets");
      this.dependencies(plan, input.testId, push);
      this.secrets(input.plan, input.environmentId, push);
      this.schemaPointers(plan, push);
    }
    checked.add("permissions");
    try {
      this.ctx.authorize("X", projectId);
    } catch (error) {
      if (!(error instanceof ContractError) || error.code !== "FORBIDDEN") throw error;
      push(
        "permissions",
        "permission_execute",
        "",
        "You may not execute tests in this project.",
        null,
      );
    }
    const errors = issues.filter((issue) => issue.severity === "error");
    return {
      valid: errors.every((issue) => issue.code === "permission_execute"),
      runnable: errors.length === 0,
      issues,
      checked: [...checked],
    };
  }

  private dependencies(
    plan: ExecutablePlan,
    testId: string | undefined,
    push: (
      check: Check,
      code: string,
      field: string,
      message: string,
      stepId?: string | null,
    ) => void,
  ): void {
    if (plan.runPolicy === "once" && testId) {
      const consumed = allEntities(this.ctx, "TestCase").some((other) => {
        const active = other.activeRevisionId
          ? this.ctx.entities.get(
              "TestRevision",
              this.ctx.workspaceId,
              String(other.activeRevisionId),
            )
          : null;
        const consumerPlan = active?.plan as ExecutablePlan | null | undefined;
        return (consumerPlan?.dependsOn ?? []).some(
          (binding) => binding.required && binding.producerTestId === testId,
        );
      });
      if (consumed)
        push(
          "dependencies",
          "once_producer",
          "/runPolicy",
          "A one-shot test cannot be a dependency producer: another test depends on its outputs.",
          null,
        );
    }
    const bindings = plan.dependsOn ?? [];
    if (!bindings.length) return;
    const reaches = (current: string, seen: Set<string>): boolean => {
      if (current === testId) return true;
      if (seen.has(current)) return false;
      seen.add(current);
      const test = this.ctx.entities.get("TestCase", this.ctx.workspaceId, current);
      const revision = test?.activeRevisionId
        ? this.ctx.entities.get("TestRevision", this.ctx.workspaceId, String(test.activeRevisionId))
        : null;
      const upstream = (revision?.plan as ExecutablePlan | null | undefined)?.dependsOn ?? [];
      return upstream.some((binding) => reaches(binding.producerTestId, seen));
    };
    for (const [index, binding] of bindings.entries()) {
      const field = `/dependsOn/${index}`;
      const producer = this.ctx.entities.get(
        "TestCase",
        this.ctx.workspaceId,
        binding.producerTestId,
      );
      if (!producer) {
        push(
          "dependencies",
          "dependency_missing",
          `${field}/producerTestId`,
          "The producer test does not exist.",
          null,
        );
        continue;
      }
      if (testId && reaches(binding.producerTestId, new Set())) {
        push(
          "dependencies",
          "dependency_cycle",
          `${field}/producerTestId`,
          "This dependency would make the test depend on itself.",
          null,
        );
        continue;
      }
      const revisionId = binding.producerRevisionId ?? String(producer.activeRevisionId ?? "");
      const revision = revisionId
        ? this.ctx.entities.get("TestRevision", this.ctx.workspaceId, revisionId)
        : null;
      if (!revision || revision.testId !== producer.id) {
        push(
          "dependencies",
          "dependency_revision_missing",
          `${field}/producerRevisionId`,
          "The producer has no such revision.",
          null,
        );
        continue;
      }
      const producerPlan = revision.plan as ExecutablePlan | null;
      if (producerPlan?.runPolicy === "once")
        push(
          "dependencies",
          "dependency_producer_once",
          `${field}/producerTestId`,
          "The producer is a one-shot test (runPolicy once); a producer must run every time its consumers run.",
          null,
        );
      if (
        !producerPlan ||
        !captureDeclarations(producerPlan).some((capture) => capture.name === binding.outputName)
      )
        push(
          "dependencies",
          "dependency_output_missing",
          `${field}/outputName`,
          `The producer does not capture "${binding.outputName}".`,
          null,
        );
      if (!this.ctx.entities.get("Environment", this.ctx.workspaceId, binding.permittedEnvironment))
        push(
          "dependencies",
          "dependency_environment_missing",
          `${field}/permittedEnvironment`,
          "The permitted environment does not exist.",
          null,
        );
    }
  }

  /**
   * Each `jsonSchema` pointer must reach a schema exactly as the runner input is built, and that
   * schema must compile in the source-schema validator the run uses.
   */
  private schemaPointers(
    plan: ExecutablePlan,
    push: (
      check: Check,
      code: string,
      field: string,
      message: string,
      stepId?: string | null,
    ) => void,
  ): void {
    const resolved = sourceSchemasFor(this.ctx, plan);
    const unusable = new Map(
      unusableSchemas(schemaCitations(plan), resolved).map((item) => [item.stepId, item]),
    );
    const visit = (steps: readonly PlanStep[], base: string): void => {
      for (const [index, step] of steps.entries()) {
        const path = `${base}/${index}`;
        if (step.operation === "frame") visit(step.input.childSteps, `${path}/input/childSteps`);
        if (step.operation !== "assert" || step.expectation.predicate !== "jsonSchema") continue;
        const { sourceRevisionId, pointer } = step.expectation;
        if (`${sourceRevisionId}${pointer}` in resolved) {
          const problem = unusable.get(step.id)?.problem;
          if (problem !== undefined)
            push(
              "references",
              "schema_uncompilable",
              `${path}/expectation/pointer`,
              `The schema at "${pointer}" of source revision ${sourceRevisionId} cannot be compiled, so the step could never judge a response: ${problem}. Fix the schema in a new source revision or cite another pointer.`,
            );
          continue;
        }
        push(
          "references",
          "schema_pointer_unresolved",
          `${path}/expectation/pointer`,
          `Pointer "${pointer}" does not reach a schema in source revision ${sourceRevisionId}: it must be /paths/<path>/<method>/... inside an operation, or /components/schemas/<Name> (/definitions/<Name> for Swagger 2), and the revision must be a ready OpenAPI source of this workspace.`,
        );
      }
    };
    visit(plan.steps, "/steps");
  }

  private secrets(
    rawPlan: unknown,
    environmentId: string | undefined,
    push: (
      check: Check,
      code: string,
      field: string,
      message: string,
      stepId?: string | null,
    ) => void,
  ): void {
    const references = secretRefs(rawPlan);
    if (!references.length) return;
    let origin: string | null = null;
    if (environmentId) {
      const environment = this.ctx.entities.get("Environment", this.ctx.workspaceId, environmentId);
      const revision = environment?.activeRevisionId
        ? this.ctx.entities.get(
            "EnvironmentRevision",
            this.ctx.workspaceId,
            String(environment.activeRevisionId),
          )
        : null;
      origin = ((revision?.targetOrigins as string[] | undefined) ?? [])[0] ?? null;
    }
    for (const { ref, path } of references) {
      const secret = this.ctx.entities.get("SecretReference", this.ctx.workspaceId, ref);
      if (!secret) push("secrets", "secret_missing", path, "The referenced secret does not exist.");
      else if (secret.revokedAt)
        push("secrets", "secret_revoked", path, "The referenced secret was revoked.");
      else if (origin && !(secret.allowedOrigins as string[]).includes(origin))
        push(
          "secrets",
          "secret_origin_not_allowed",
          path,
          "The secret is not allowed for this environment's origin.",
        );
    }
  }
}
