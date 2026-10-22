import { type Static, Type } from "@sinclair/typebox";
import * as P from "../primitives.js";

/** The Schemathesis checks a property probe may run (ADR-033). */
export const propertyChecks = [
  "not_a_server_error",
  "status_code_conformance",
  "content_type_conformance",
  "response_schema_conformance",
  "ignored_auth",
] as const;
export type PropertyCheck = (typeof propertyChecks)[number];
/** Examples generated per operation when a property probe names none. */
export const DEFAULT_PROPERTY_EXAMPLES = 100;

/** A header whose whole value one secret holds; the value never enters a revision. */
export const ProbeCredential = P.Obj({
  header: Type.String({ pattern: "^[!#$%&'*+.^_`|~0-9A-Za-z-]+$", maxLength: 200 }),
  secretRef: P.id("sec"),
});
export type ProbeCredential = Static<typeof ProbeCredential>;
/** A target-relative request path, query included; the environment's base URL supplies the origin. */
const TargetPath = Type.String({ pattern: "^/[^\\s\\\\]*$", maxLength: 1024 });
const ProbeMethod = P.Enum(["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"]);
const ProbeRequest = P.Obj({
  method: ProbeMethod,
  path: TargetPath,
  /** Sent as `application/json`. */
  body: Type.Optional(P.Json),
});

/**
 * Generated tests against an imported API description: every selected operation receives examples
 * the description allows, and each response is checked against it (REQ-050). No model is involved.
 */
export const PropertyProbe = P.Obj({
  kind: Type.Literal("property"),
  api: P.Enum(["openapi", "graphql"]),
  /** The imported OpenAPI or GraphQL source revision the examples are generated from. */
  sourceRevisionId: P.id("svr"),
  /** OpenAPI `METHOD /path` or GraphQL root field names; absent means every operation. */
  operations: Type.Optional(Type.Array(P.Name, { minItems: 1, maxItems: 200, uniqueItems: true })),
  /** OpenAPI only: also run sequences that follow the description's links. */
  stateful: Type.Boolean(),
  maxExamples: Type.Optional(Type.Integer({ minimum: 1, maximum: 1000 })),
  checks: Type.Optional(
    Type.Array(P.Enum(propertyChecks), { minItems: 1, maxItems: 5, uniqueItems: true }),
  ),
  /** Headers sent with every example; each secret holds the whole header value. */
  credentials: Type.Optional(Type.Array(ProbeCredential, { minItems: 1, maxItems: 8 })),
});
export type PropertyProbe = Static<typeof PropertyProbe>;

/** ZAP alert risks, highest first; `failOn` fails the Run on that risk and every higher one. */
export const dastRisks = ["high", "medium", "low", "informational"] as const;
export type DastRisk = (typeof dastRisks)[number];

/**
 * A pinned ZAP spider and optional active scan of an authorized target (REQ-048). The spider
 * limits bound the traffic sent to the target; the active scan runs until ZAP finishes it.
 */
export const DastProbe = P.Obj({
  kind: Type.Literal("dast"),
  startPaths: Type.Array(TargetPath, { minItems: 1, maxItems: 20, uniqueItems: true }),
  spider: P.Obj({
    maxDurationMinutes: Type.Integer({ minimum: 1, maximum: 60 }),
    maxChildren: Type.Integer({ minimum: 0, maximum: 1000 }),
  }),
  activeScan: Type.Boolean(),
  /** `api-minimal` runs only the injection and traversal rules an HTTP API can answer. */
  policy: P.Enum(["default", "api-minimal"]),
  failOn: P.Enum(["high", "medium", "low"]),
  credentials: Type.Optional(Type.Array(ProbeCredential, { minItems: 1, maxItems: 8 })),
});
export type DastProbe = Static<typeof DastProbe>;

/**
 * Object-level access checks (REQ-048): every operation is sent as the intruder, which must be
 * refused with an expected status, and then as the owner, which must succeed.
 */
export const AccessProbe = P.Obj({
  kind: Type.Literal("access"),
  operations: Type.Array(ProbeRequest, { minItems: 1, maxItems: 50 }),
  owner: Type.Array(ProbeCredential, { minItems: 1, maxItems: 8 }),
  /** An empty list sends the intruder's requests without credentials. */
  intruder: Type.Array(ProbeCredential, { maxItems: 8 }),
  expect: Type.Array(Type.Union([Type.Literal(401), Type.Literal(403), Type.Literal(404)]), {
    minItems: 1,
    maxItems: 3,
    uniqueItems: true,
  }),
});
export type AccessProbe = Static<typeof AccessProbe>;

/**
 * An open-loop load test of one request (REQ-049). The budget bounds the traffic sent to the
 * target; a stop condition ends the test early and fails it. Durations stay within the longest
 * Attempt `ExecutionLimits` allows (900 s), which bounds the whole schedule.
 */
export const LoadProbe = P.Obj({
  kind: Type.Literal("load"),
  stages: Type.Array(
    P.Obj({
      durationSeconds: Type.Integer({ minimum: 1, maximum: 900 }),
      targetRps: Type.Integer({ minimum: 1, maximum: 1000 }),
    }),
    { minItems: 1, maxItems: 10 },
  ),
  maxConcurrency: Type.Integer({ minimum: 1, maximum: 500 }),
  request: P.Obj({
    ...ProbeRequest.properties,
    credentials: Type.Optional(Type.Array(ProbeCredential, { minItems: 1, maxItems: 8 })),
  }),
  stopConditions: P.Obj({
    maxErrorRate: Type.Number({ minimum: 0, maximum: 1 }),
    maxP95Ms: Type.Integer({ minimum: 1, maximum: 600000 }),
  }),
  budget: P.Obj({
    maxRequests: Type.Integer({ minimum: 1, maximum: 900000 }),
    maxDurationSeconds: Type.Integer({ minimum: 1, maximum: 900 }),
  }),
});
export type LoadProbe = Static<typeof LoadProbe>;

/** A security or API probe a test revision runs instead of a plan (ADR-033). */
export const ProbeSpec = Type.Union([PropertyProbe, DastProbe, AccessProbe, LoadProbe]);
export type ProbeSpec = Static<typeof ProbeSpec>;
export type ProbeKind = ProbeSpec["kind"];
/** Probes whose traffic volume a production environment never receives, approval or not. */
export const productionRefusedProbes: readonly ProbeKind[] = ["dast", "load"];

/** The checks a property probe runs: the requested ones, or every applicable default. */
export function resolvePropertyChecks(probe: PropertyProbe): PropertyCheck[] {
  if (probe.api === "graphql") return ["not_a_server_error"];
  if (probe.checks) return [...probe.checks];
  return propertyChecks.filter(
    (check) => check !== "ignored_auth" || (probe.credentials?.length ?? 0) > 0,
  );
}
