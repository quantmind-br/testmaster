import { type Static, type TSchema, Type } from "@sinclair/typebox";

export const SCHEMA_VERSION = "1.0.0" as const;
export const entityPrefixes = [
  "ws",
  "usr",
  "svc",
  "mem",
  "prj",
  "env",
  "evr",
  "sec",
  "src",
  "svr",
  "csp",
  "fea",
  "req",
  "dsc",
  "pbt",
  "pro",
  "tst",
  "rev",
  "sui",
  "bat",
  "run",
  "att",
  "stp",
  "var",
  "res",
  "art",
  "snp",
  "ana",
  "hea",
  "sch",
  "mdl",
  "aud",
  "idr",
  "job",
  "evt",
  "apr",
  "aup",
  "acp",
  "wrk",
  "dlv",
  "del",
  "mry",
  "vbl",
  "evl",
] as const;
export type EntityPrefix = (typeof entityPrefixes)[number];
export const uuidPattern = "[0-9a-f]{8}-[0-9a-f]{4}-[47][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}";
export const EntityId = Type.String({ pattern: `^(${entityPrefixes.join("|")})_${uuidPattern}$` });
export const id = (prefix: EntityPrefix) => Type.String({ pattern: `^${prefix}_${uuidPattern}$` });
export const Timestamp = Type.String({ format: "date-time", pattern: "Z$" });
export const ContentDigest = Type.String({ pattern: "^[0-9a-f]{64}$" });
export const Version = Type.Integer({ minimum: 1 });
export const Name = Type.String({ minLength: 1, maxLength: 200 });
export const Description = Type.String({ maxLength: 8000 });
export const Nonnegative = Type.Integer({ minimum: 0 });
export const Positive = Type.Integer({ minimum: 1 });
export const Enum = <T extends string>(values: readonly T[]) =>
  Type.Union(values.map((value) => Type.Literal(value)));
export const Obj = <T extends Record<string, TSchema>>(
  properties: T,
  options: Record<string, unknown> = {},
) => Type.Object(properties, { additionalProperties: false, ...options });
export const Json = Type.Recursive((Self) =>
  Type.Union([
    Type.Null(),
    Type.Boolean(),
    Type.Number(),
    Type.String(),
    Type.Array(Self),
    Type.Record(Type.String(), Self),
  ]),
);
export type JsonValue = Static<typeof Json>;
export const Extensions = Type.Record(
  Type.String({ pattern: "^[a-z][a-z0-9.-]*:[a-zA-Z0-9._-]+$" }),
  Json,
  { additionalProperties: false },
);
export const Money = Obj({
  amount: Type.Integer(),
  currency: Type.String({ pattern: "^[A-Z]{3}$" }),
  scale: Nonnegative,
});
export const Phase = Enum([
  "queued",
  "preparing",
  "running",
  "collecting",
  "analyzing",
  "completed",
]);
export const Outcome = Enum(["passed", "failed", "blocked", "cancelled", "inconclusive"]);
export const Gate = Enum(["pending", "passed", "failed", "not_applicable"]);
export const CleanupOutcome = Enum(["not_required", "pending", "passed", "failed", "inconclusive"]);
export const AnalysisStatus = Enum([
  "not_requested",
  "pending",
  "complete",
  "partial",
  "unavailable",
]);
export const StepStatus = Enum([
  "pending",
  "running",
  "passed",
  "failed",
  "blocked",
  "cancelled",
  "skipped",
  "not_run",
  "inconclusive",
]);
export const Risk = Enum(["read", "write", "destructive", "securityProbe"]);
export const Mode = Enum(["replay", "agent"]);
export const Priority = Enum(["critical", "high", "normal", "low"]);
export const FailureKind = Enum([
  "product_bug",
  "test_fragility",
  "environment",
  "contract_violation",
  "security_policy",
  "unknown",
]);
export const ArtifactState = Enum(["available", "missing", "expired", "partial"]);
export const RedactionStatus = Enum(["redacted", "restrictedRaw", "not_applicable"]);
export const Value = Type.Union([
  Obj({ literal: Json }),
  Obj({ secretRef: id("sec") }),
  Obj({ variableRef: Name }),
  Obj({ artifactRef: id("art") }),
]);
export type Value = Static<typeof Value>;
export const RelativePath = Type.String({
  minLength: 1,
  pattern: "^(?!/)(?![A-Za-z]:)(?!.*(?:^|/)\\.\\.(?:/|$))(?!.*\\\\).+$",
});
export const JsonPointer = Type.String({ pattern: "^(?:/(?:[^~/]|~[01])*)*$" });
export const EvidenceRef = Obj(
  {
    artifactId: Type.Optional(id("art")),
    sourceRevisionId: Type.Optional(id("svr")),
    snapshotId: Type.Optional(id("snp")),
    relativePath: Type.Optional(RelativePath),
    offset: Type.Optional(Nonnegative),
    length: Type.Optional(Nonnegative),
    page: Type.Optional(Positive),
    jsonPointer: Type.Optional(JsonPointer),
    contentHash: Type.Optional(ContentDigest),
    /** Persisted execution evidence without a committed bundle; resolved by scoped compound binding. */
    runId: Type.Optional(id("run")),
    attemptId: Type.Optional(id("att")),
    stepId: Type.Optional(Name),
    observationSeq: Type.Optional(Nonnegative),
    /** Authorized discovery code snapshot; binds an exact file location by relative path and content hash. */
    codeSnapshotId: Type.Optional(id("csp")),
  },
  {
    minProperties: 1,
    dependentRequired: {
      attemptId: ["runId"],
      stepId: ["runId", "attemptId"],
      observationSeq: ["runId"],
      codeSnapshotId: ["relativePath", "contentHash"],
    },
  },
);
export const Pagination = Obj({
  limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 100, default: 50 })),
  cursor: Type.Optional(Type.String({ maxLength: 4096 })),
});
export const Page = (item: TSchema) =>
  Obj({
    items: Type.Array(item),
    nextCursor: Type.Union([Type.String(), Type.Null()]),
    hasMore: Type.Boolean(),
  });
export const roles = [
  "org_owner",
  "org_admin",
  "maintainer",
  "runner",
  "reviewer",
  "viewer",
  "service_account",
] as const;
export const actions = [
  "read",
  "write",
  "execute",
  "admin",
  "approve",
  "raw",
  "export",
  "delete",
] as const;
export const scopes = {
  R: "read",
  W: "write",
  X: "execute",
  A: "admin",
  "healing:approve": "approve",
  "artifacts:raw": "raw",
  "secrets:export": "export",
} as const;
