import { type Static, type TSchema, Type } from "@sinclair/typebox";
import { VariableCapture } from "./operations.js";
import { Step } from "./plans.js";
import {
  ContentDigest,
  Description,
  Enum,
  id,
  Json,
  Name,
  Nonnegative,
  Obj,
  Outcome,
  Positive,
  RelativePath,
  StepStatus,
  Timestamp,
} from "./primitives.js";
import { reasonCodes } from "./registries.js";

const common = {
  protocolVersion: Type.Literal("1.0.0"),
  seq: Nonnegative,
  attemptId: id("att"),
  occurredAt: Timestamp,
};
const event = <T extends string, P extends TSchema>(type: T, payload: P) =>
  Obj({ ...common, type: Type.Literal(type), payload });
export const RunnerEvent = Type.Union([
  event(
    "runner.hello",
    Obj({
      nonce: Type.String({ minLength: 32, maxLength: 256 }),
      capabilities: Type.Optional(Type.Array(Name)),
    }),
  ),
  event(
    "step.started",
    Obj({ stepId: Name, index: Nonnegative, title: Type.Optional(Description) }),
  ),
  event(
    "step.finished",
    Obj({
      stepId: Name,
      index: Nonnegative,
      /** What the test framework called the step; the runners cut it at 500 characters. */
      title: Type.Optional(Description),
      status: StepStatus,
      reasonCode: Type.Optional(Enum(reasonCodes)),
      expected: Type.Optional(Json),
      observed: Type.Optional(Json),
      error: Type.Optional(Obj({ code: Name, message: Description })),
      durationMs: Nonnegative,
      evidencePaths: Type.Array(RelativePath),
    }),
  ),
  event(
    "artifact.begin",
    Obj({
      artifactId: id("art"),
      relativePath: RelativePath,
      kind: Name,
      mimeType: Name,
      sizeBytes: Nonnegative,
    }),
  ),
  event(
    "artifact.chunk",
    Obj({
      artifactId: id("art"),
      data: Type.String({
        pattern: "^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$",
        maxLength: 174764,
      }),
    }),
  ),
  event(
    "artifact.end",
    Obj({ artifactId: id("art"), sha256: ContentDigest, sizeBytes: Nonnegative }),
  ),
  ...(
    ["resource.intent", "resource.created", "resource.uncertain", "resource.cleanup"] as const
  ).map((type) =>
    event(
      type,
      Obj({
        resourceId: id("res"),
        /**
         * The plan step the resource belongs to: the creating request step, or the `resourceRef` of
         * a cleanup entry that found it by lookup. Absent: the step being executed.
         */
        stepId: Type.Optional(Name),
        resourceType: Name,
        correlationKey: Name,
        handleRef: Type.Optional(Name),
        ownerProof: Type.Optional(Json),
        state: Enum(["planned", "created", "cleanup_pending", "cleaned", "orphaned", "uncertain"]),
      }),
    ),
  ),
  event(
    "variable.captured",
    Obj({
      ...VariableCapture.properties,
      /** The step that produced the value; absent: the step being executed. A cleanup lookup names its entry's `resourceRef`. */
      stepId: Type.Optional(Name),
    }),
  ),
  event(
    "log",
    Obj({
      level: Enum(["debug", "info", "warn", "error"]),
      message: Type.String({ maxLength: 16384 }),
    }),
  ),
  /**
   * A browser request the route handler refused because its origin is outside the network policy,
   * deduplicated per origin and resource type with a count. `aborted` means a passive subresource
   * that was dropped without failing the attempt; `ignored` means the origin is on the
   * environment's `ignoredOrigins` and was dropped without failing the attempt; `fatal` means the
   * attempt was blocked. The origin never carries path, query or credentials.
   */
  event(
    "egress.denied",
    Obj({
      stepId: Name,
      origin: Name,
      method: Name,
      resourceType: Name,
      disposition: Enum(["aborted", "ignored", "fatal"]),
      count: Positive,
    }),
  ),
  event(
    "runner.finished",
    Obj({
      outcome: Outcome,
      reasonCode: Enum(reasonCodes),
      cleanupOutcome: Type.Optional(
        Enum(["not_required", "pending", "passed", "failed", "inconclusive"]),
      ),
    }),
  ),
  event(
    "secret.request",
    Obj({ requestId: Name, secretRef: id("sec"), secretVersion: Type.Integer({ minimum: 1 }) }),
  ),
  event("agent.request", Obj({ stepId: Name, observation: Json })),
  /**
   * Browser storage state captured after a login phase (SEC-022). Socket-only: the supervisor hands
   * it to the host for vault storage and never records it as an event, artifact or log line.
   */
  event(
    "auth.state",
    Obj({
      kind: Type.Literal("storageState"),
      data: Type.String({ minLength: 2, maxLength: 120000 }),
    }),
  ),
]);
export const SupervisorEvent = Type.Union([
  event(
    "secret.value",
    Obj({
      requestId: Name,
      secretRef: id("sec"),
      secretVersion: Type.Integer({ minimum: 1 }),
      value: Type.String(),
    }),
  ),
  event("control.cancel", Obj({ reasonCode: Enum(reasonCodes), deadlineMs: Nonnegative })),
  event("agent.action", Obj({ stepId: Name, action: Type.Union([Step, Type.Null()]) })),
]);
export const AgentActionSelection = Obj({ index: Type.Union([Nonnegative, Type.Null()]) });
export const AIGeneratedCodeOutput = Obj({
  code: Type.String({ minLength: 1, maxLength: 1048576 }),
  format: Enum(["playwright", "pytest"]),
});
export const CapabilityManifest = Obj({
  schemaVersion: Type.Literal("1.0.0"),
  apiVersion: Name,
  runnerVersion: Name,
  protocolVersion: Name,
  capabilities: Type.Array(
    Obj({
      id: Name,
      enabled: Type.Boolean(),
      milestone: Enum(["M0", "M1", "M2", "M3", "M4", "M5", "M6"]),
      disabledReason: Type.Union([Description, Type.Null()]),
      experimental: Type.Optional(Type.Boolean()),
    }),
  ),
  limits: Json,
});
export type RunnerEvent = Static<typeof RunnerEvent>;
export type SupervisorEvent = Static<typeof SupervisorEvent>;
export type CapabilityManifest = Static<typeof CapabilityManifest>;
