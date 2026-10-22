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
  credentials: Type.Optional(
    Type.Array(
      P.Obj({
        header: Type.String({ pattern: "^[!#$%&'*+.^_`|~0-9A-Za-z-]+$", maxLength: 200 }),
        secretRef: P.id("sec"),
      }),
      { minItems: 1, maxItems: 8 },
    ),
  ),
});
export type PropertyProbe = Static<typeof PropertyProbe>;

/** A security or API probe a test revision runs instead of a plan (ADR-033). */
export const ProbeSpec = Type.Union([PropertyProbe]);
export type ProbeSpec = Static<typeof ProbeSpec>;

/** The checks a property probe runs: the requested ones, or every applicable default. */
export function resolvePropertyChecks(probe: PropertyProbe): PropertyCheck[] {
  if (probe.api === "graphql") return ["not_a_server_error"];
  if (probe.checks) return [...probe.checks];
  return propertyChecks.filter(
    (check) => check !== "ignored_auth" || (probe.credentials?.length ?? 0) > 0,
  );
}
