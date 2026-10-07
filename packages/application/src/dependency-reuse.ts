import {
  ContractError,
  type DependencyBinding,
  type ExecutablePlan,
  validate,
} from "@testmaster/contracts";
import { semanticHash } from "@testmaster/domain";
import type { EntityDocument } from "@testmaster/persistence";
import { allEntities, requireEntity, type ServiceContext } from "./context.js";

export interface ReuseBinding {
  consumerTestId: string;
  consumerRevisionId: string;
  producerTestId: string;
  producerRunId: string;
  producerRevisionId: string;
  producerEnvironmentRevisionId: string;
  outputName: string;
  consumerInput: string;
  variableId: string;
  variableHash: string;
  observationHash: string;
  secretHash: string | null;
  resourceHashes: Record<string, string>;
  origin: string;
}
function refuse(message: string): never {
  throw new ContractError("PRECONDITION_FAILED", message, { reasonCode: "upstream_failed" });
}
/** Read-only admission and release validation. Never decrypts or returns captured values. */
export function resolveReuse(
  ctx: ServiceContext,
  consumer: EntityDocument,
  binding: DependencyBinding,
  sourceRunIds: readonly string[],
  frozen?: ReuseBinding,
): ReuseBinding | null {
  const test = requireEntity(ctx, "TestCase", String(consumer.testId));
  ctx.authorize("R", String(test.projectId));
  const cell = consumer.matrixCell as Record<string, unknown>;
  const candidates = sourceRunIds
    .map((id) => {
      const run = requireEntity(ctx, "Run", id);
      const producerTest = requireEntity(ctx, "TestCase", String(run.testId));
      ctx.authorize("R", String(producerTest.projectId));
      if (producerTest.projectId !== test.projectId)
        refuse("Fixture producer belongs to another project");
      return run;
    })
    .filter((run) => run.testId === binding.producerTestId);
  if (!candidates.length) return null;
  const revisionId =
    binding.producerRevisionId ??
    String(requireEntity(ctx, "TestCase", binding.producerTestId).activeRevisionId);
  const matching = candidates.filter((run) => run.revisionId === revisionId);
  if (matching.length !== 1) refuse("Fixture producer is ambiguous or has a different revision");
  const producer = matching[0]!;
  const producerCell = producer.matrixCell as Record<string, unknown>;
  if (producer.phase !== "completed" || producer.outcome !== "passed" || producer.gate !== "passed")
    refuse("Fixture producer did not pass outcome and gate");
  if (
    producer.environmentRevisionId !== consumer.environmentRevisionId ||
    producerCell.environmentId !== binding.permittedEnvironment ||
    cell.environmentId !== binding.permittedEnvironment ||
    producerCell.baseUrl !== cell.baseUrl
  )
    refuse("Fixture producer environment or origin differs");
  if (
    binding.producerCell &&
    !Object.entries(binding.producerCell).every(
      ([field, value]) => semanticHash(producerCell[field] ?? null) === semanticHash(value),
    )
  )
    refuse("Fixture producer matrix identity differs");
  const plan = validate<ExecutablePlan>(
    "ExecutablePlan",
    requireEntity(ctx, "TestRevision", revisionId).plan,
  );
  const declarations: { name: string; valueType: string; sensitive: boolean }[] = [];
  const walk = (steps: ExecutablePlan["steps"]) => {
    for (const step of steps) {
      if (step.operation === "frame") walk(step.input.childSteps);
      if (step.operation === "request") {
        declarations.push(...(step.input.capture ?? []));
        if (step.input.resource)
          declarations.push({ name: "handle", valueType: "string", sensitive: true });
      }
    }
  };
  walk(plan.steps);
  const captures = declarations.filter((capture) => capture.name === binding.outputName);
  if (
    captures.length !== 1 ||
    captures[0]!.valueType !== binding.type ||
    captures[0]!.sensitive !== binding.sensitive
  )
    refuse("Fixture output declaration or taint differs");
  const variables = allEntities(ctx, "VariableValue").filter(
    (value) => value.producerRunId === producer.id && value.name === binding.outputName,
  );
  if (variables.length !== 1) refuse("Fixture output is missing or ambiguous");
  const variable = variables[0]!;
  const age = Date.now() - Date.parse(String(variable.createdAt));
  if (
    !Number.isFinite(age) ||
    age < 0 ||
    age > binding.maximumAge ||
    variable.type !== binding.type ||
    variable.taint !== (binding.sensitive ? "sensitive" : "public")
  )
    refuse("Fixture output is expired or incompatible");
  let secretHash: string | null = null;
  if (binding.sensitive) {
    if (!variable.encryptedValueRef) refuse("Sensitive fixture has no encrypted reference");
    const secret = requireEntity(ctx, "SecretReference", String(variable.encryptedValueRef));
    if (
      secret.revokedAt ||
      !(secret.allowedOrigins as string[]).includes(String(cell.baseUrl)) ||
      secret.provider === "ephemeral"
    )
      refuse("Sensitive fixture reference is revoked or origin-bound elsewhere");
    secretHash = semanticHash(secret);
  }
  const completed = allEntities(ctx, "Attempt")
    .filter((attempt) => attempt.runId === producer.id)
    .sort((left, right) => Number(right.number) - Number(left.number))[0];
  if (!completed || completed.phase !== "completed")
    refuse("Fixture producer has no completed final attempt");
  const observations = ctx.database
    .all(
      "SELECT data_json FROM observations WHERE workspace_id=? AND attempt_id=? ORDER BY seq",
      ctx.workspaceId,
      completed.id,
    )
    .map((row) => JSON.parse(String(row.data_json)) as Record<string, unknown>);
  const observation = observations.find((event) => {
    const payload = event.payload as Record<string, unknown> | undefined;
    return (
      event.type === "variable.captured" &&
      event.occurredAt === variable.createdAt &&
      payload?.name === binding.outputName &&
      payload.valueType === binding.type &&
      payload.sensitive === binding.sensitive &&
      (binding.sensitive
        ? payload.encryptedValueRef === variable.encryptedValueRef
        : payload.value !== null && typeof payload.value === "object" && "literal" in payload.value)
    );
  });
  if (!observation) refuse("Fixture output lacks its final-attempt capture observation");
  const attempts = new Set(
    allEntities(ctx, "Attempt")
      .filter((attempt) => attempt.runId === producer.id)
      .map((attempt) => attempt.id),
  );
  const resources = allEntities(ctx, "ResourceRecord").filter((resource) =>
    attempts.has(String(resource.creatorAttemptId)),
  );
  if (
    resources.some(
      (resource) => resource.state !== "created" || !resource.ownerProof || !resource.handleRef,
    )
  )
    refuse("Fixture resource is not live with verified ownership");
  const result: ReuseBinding = {
    consumerTestId: String(consumer.testId),
    consumerRevisionId: String(consumer.revisionId),
    producerTestId: String(producer.testId),
    producerRunId: producer.id,
    producerRevisionId: String(producer.revisionId),
    producerEnvironmentRevisionId: String(producer.environmentRevisionId),
    outputName: binding.outputName,
    consumerInput: binding.consumerInput,
    variableId: variable.id,
    variableHash: semanticHash(variable),
    observationHash: semanticHash(observation),
    secretHash,
    resourceHashes: Object.fromEntries(
      resources.map((resource) => [resource.id, semanticHash(resource)]),
    ),
    origin: String(cell.baseUrl),
  };
  if (frozen && semanticHash(result) !== semanticHash(frozen))
    refuse("Fixture reuse provenance changed before release");
  return result;
}
