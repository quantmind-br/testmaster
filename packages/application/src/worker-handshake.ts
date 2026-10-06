import { ContractError, type ExecutablePlan, Step, validate } from "@testmaster/contracts";
import type { EntityDocument } from "@testmaster/persistence";
import type { ImageLock } from "@testmaster/sandbox";

export interface WorkerHandshake {
  schemaVersions: string[];
  runnerVersion: string;
  runners: string[];
  actions: string[];
  imageDigests: string[];
}
export function localHandshake(lock: ImageLock): WorkerHandshake {
  const variants = Step.anyOf as { properties: { operation: { const: string } } }[];
  return {
    schemaVersions: ["1.0.0"],
    runnerVersion: "0.1.0",
    runners: ["playwright", "http", "python"],
    actions: variants.map((variant) => variant.properties.operation.const),
    imageDigests: Object.values(lock).map((entry) => entry.imageId),
  };
}
export function validateHandshake(
  input: WorkerHandshake,
  available: WorkerHandshake,
): WorkerHandshake {
  if (
    !input.runnerVersion ||
    input.runnerVersion.length > 128 ||
    ![input.schemaVersions, input.runners, input.actions, input.imageDigests].every(
      (values) =>
        Array.isArray(values) &&
        values.length <= 100 &&
        values.every(
          (value) => typeof value === "string" && value.length > 0 && value.length <= 128,
        ),
    )
  )
    throw new ContractError("INVALID_ARGUMENT", "Invalid local worker handshake");
  if (
    input.runners.some((value) => !available.runners.includes(value)) ||
    input.actions.some((value) => !available.actions.includes(value)) ||
    input.imageDigests.some((value) => !available.imageDigests.includes(value))
  )
    throw new ContractError("PRECONDITION_FAILED", "Worker advertises unavailable capabilities");
  return input;
}
export function supportsQueuedRun(
  handshake: WorkerHandshake,
  run: EntityDocument,
  revision: EntityDocument,
  lock: ImageLock,
): boolean {
  let plan: ExecutablePlan | null;
  try {
    plan = revision.plan ? validate<ExecutablePlan>("ExecutablePlan", revision.plan) : null;
  } catch {
    return false;
  }
  const runner = String(revision.runnerKind ?? revision.runner ?? plan?.runner ?? "playwright");
  const schema = plan?.schemaVersion ?? "1.0.0";
  if (!handshake.schemaVersions.includes(schema) || !handshake.runners.includes(runner))
    return false;
  const requiredImage =
    lock[runner === "python" ? "testmaster-runner-python" : "testmaster-runner"].imageId;
  if (!handshake.imageDigests.includes(requiredImage)) return false;
  const supports = (steps: ExecutablePlan["steps"]): boolean =>
    steps.every(
      (step) =>
        handshake.actions.includes(step.operation) &&
        (step.operation !== "frame" || supports(step.input.childSteps)),
    );
  if (
    plan &&
    (!supports(plan.steps) ||
      (plan.cleanup ?? []).some((step) => !handshake.actions.includes(step.operation)))
  )
    return false;
  const cell = run.matrixCell as Record<string, unknown>;
  const snapshot = cell.admissionSnapshot as { requiredCapabilities?: string[] } | undefined;
  return (snapshot?.requiredCapabilities ?? []).every(
    (capability) =>
      handshake.runners.includes(capability) || handshake.actions.includes(capability),
  );
}
