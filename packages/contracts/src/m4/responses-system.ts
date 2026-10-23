import { type Static, type TSchema, Type } from "@sinclair/typebox";
import { ExecutionLimits } from "../operations.js";
import * as P from "../primitives.js";

/**
 * Exact `data` bodies of the system routes (health, capabilities, code export, usage). Each schema
 * mirrors what the producing code really returns, not the generic catalog entry named in the route
 * table: `Application.readiness()`, `Application.capabilities()`, `CodeExportService.export()` and
 * `UsageService.get()`.
 */
const nullable = <T extends TSchema>(schema: T) => Type.Union([schema, Type.Null()]);

/** Probe state of one readiness component (local and server profile). */
const ProbeState = P.Enum(["ready", "unavailable"]);

/** GET /health/live answers exactly `{status:"alive"}` (core.ts); catalog `Health` is a superset. */
const Liveness = P.Obj({ status: Type.Literal("alive") });

/**
 * Local-profile readiness (`Application.readiness()` without a server config). `worker.runners`
 * always lists the four runner kinds probed against the pinned images and Docker.
 */
const LocalReadinessReport = P.Obj({
  status: ProbeState,
  components: P.Obj({ persistence: ProbeState, admission: ProbeState }),
  worker: P.Obj({
    status: P.Enum(["ready", "degraded"]),
    runners: P.Obj({
      http: P.Obj({ status: ProbeState }),
      playwright: P.Obj({ status: ProbeState }),
      python: P.Obj({ status: ProbeState }),
      terminal: P.Obj({ status: ProbeState }),
    }),
  }),
});

/** Stable reason codes of `serverReadiness` (packages/application/src/server-profile.ts). */
export const serverReadinessReasons = [
  "database_unreachable",
  "admission_disabled",
  "schema_behind",
  "schema_ahead",
  "rls_role_bypass",
  "rls_unprotected_tables",
  "storage_unwritable",
  "storage_unavailable",
  "storage_low_space",
  "master_key_unavailable",
] as const;

/**
 * Server-profile readiness (`serverReadiness`). `reasons` is empty exactly when `status` is
 * `ready`; the server has no Docker daemon, so `worker` counts live workers instead of runners.
 */
const ServerReadinessReport = P.Obj({
  status: ProbeState,
  components: P.Obj({
    persistence: ProbeState,
    admission: ProbeState,
    schema: ProbeState,
    tenantIsolation: ProbeState,
    storage: ProbeState,
    masterKey: ProbeState,
  }),
  reasons: Type.Array(P.Enum(serverReadinessReasons)),
  schema: P.Obj({
    databaseVersion: P.Nonnegative,
    supportedVersion: P.Nonnegative,
    state: P.Enum(["current", "behind", "ahead"]),
  }),
  atRestEncryption: Type.Literal("operator_attested"),
  worker: P.Obj({ status: P.Enum(["ready", "degraded"]), ready: P.Nonnegative }),
});

/** Body of GET /health/ready with HTTP 200 (ready) or 503 (unavailable); one of the two profiles. */
const ReadinessReport = Type.Union([LocalReadinessReport, ServerReadinessReport]);

/** One entry of the capability registry as reported by `Application.capabilities()`. */
const CapabilityFeature = P.Obj({
  id: P.Name,
  enabled: Type.Boolean(),
  milestone: P.Enum(["M0", "M1", "M2", "M3", "M4", "M5", "M6"]),
  /** Null exactly when the feature is enabled. */
  disabledReason: nullable(P.Description),
  experimental: Type.Optional(Type.Boolean()),
});

/**
 * `DockerExecutor.doctor()` called without a probe, so `security_precondition_failed` (which needs
 * a probe attempt) cannot occur here.
 */
const SandboxReport = P.Obj({
  available: Type.Boolean(),
  mode: P.Enum(["rootless", "rootful", "unknown"]),
  seccomp: Type.Boolean(),
  cgroupVersion: nullable(Type.String()),
  diagnostics: Type.Array(
    P.Enum([
      "seccomp_unavailable",
      "cgroup_v2_required",
      "resource_limits_unsupported",
      "docker_daemon_unavailable",
    ]),
  ),
});

/** `effectiveConfig.config.execution`: the validated `ProjectConfig.execution` object. */
const ExecutionConfig = P.Obj({
  ...ExecutionLimits.properties,
  executor: Type.Optional(P.Enum(["docker", "process"])),
  mode: Type.Optional(P.Mode),
  concurrency: Type.Optional(P.Positive),
});

/**
 * Body of GET /capabilities. Not the MCP `CapabilityManifest`: the MCP tool reshapes this report
 * into `capabilities`/`apiVersion`/`runnerVersion`/`protocolVersion`.
 */
const CapabilityReport = P.Obj({
  schemaVersion: Type.Literal("1.0.0"),
  features: Type.Array(CapabilityFeature),
  /** Empty when the pinned runner images are not ready, otherwise all five. */
  runners: Type.Array(P.Enum(["playwright", "http", "python", "terminal", "probe"]), {
    maxItems: 5,
    uniqueItems: true,
  }),
  sandbox: SandboxReport,
  limits: ExecutionConfig,
});

/** `metadata` of a code export (packages/planner CodeExportMetadata); identical for imported code. */
const CodeExportMetadata = P.Obj({
  version: Type.Literal("1.0.0"),
  format: P.Enum(["playwright", "pytest"]),
  framework: P.Enum([
    "playwright-test",
    "playwright-sync",
    "playwright-async",
    "requests",
    "pytest",
  ]),
  entrypoint: P.RelativePath,
  /** Semantic plan hash, or the revision content hash for imported authored code. */
  planHash: P.ContentDigest,
  /** Ids of assert steps of a generated plan; empty for imported code. */
  assertionIds: Type.Array(P.Name),
  requiredInputs: P.Obj({
    /** Secret ids a generated plan references; names read through `secrets.get` for imported code. Each is the `SECRET_` suffix. */
    secrets: Type.Array(P.Name),
    variables: Type.Array(P.Name),
    artifacts: Type.Array(P.id("art")),
    popupAliases: Type.Array(P.Name),
  }),
  /** Environment variables the project reads besides BASE_URL (imported Playwright code fixtures). */
  environment: Type.Optional(Type.Array(Type.String({ minLength: 1 }))),
  setupCommands: Type.Array(Type.String({ minLength: 1 })),
  runCommand: Type.String({ minLength: 1 }),
  runtime: P.Obj({
    node: Type.Optional(P.Name),
    python: Type.Optional(P.Name),
    playwright: P.Name,
  }),
  /** Every exported file except `export-metadata.json`, which is written after the listing. */
  files: Type.Array(
    P.Obj({ path: P.RelativePath, sha256: P.ContentDigest, sizeBytes: P.Nonnegative }),
  ),
});

/** Body of GET /revisions/{id}/code (no `out`: the route never writes to disk). */
const TestCodeExport = P.Obj({
  files: Type.Record(Type.String({ minLength: 1 }), Type.String()),
  metadata: CodeExportMetadata,
  testId: P.id("tst"),
  revisionId: P.id("rev"),
});

/**
 * Ledger money: a non-negative integer amount kept as a decimal string (BigInt arithmetic), unlike
 * the numeric `Money` primitive.
 */
const DecimalMoney = P.Obj({
  amount: Type.String({ pattern: "^\\d+$" }),
  currency: Type.String({ pattern: "^[A-Z]{3}$" }),
  scale: Type.Integer({ minimum: 0, maximum: 18 }),
});
const MoneyList = Type.Array(DecimalMoney);
const TokenCount = nullable(P.Nonnegative);
const TokenTotals = P.Obj({
  inputTokens: TokenCount,
  outputTokens: TokenCount,
  reasoningTokens: TokenCount,
});
const TokenCounters = P.Obj({
  inputTokens: P.Nonnegative,
  outputTokens: P.Nonnegative,
  reasoningTokens: P.Nonnegative,
});

/**
 * One recorded model call (`ModelCallRecord` without `rawPrompt`, plus normalized
 * `priceTableVersion` and `costBasis`). `cost` is `"unknown"` when the provider reported no price.
 */
const ModelCallView = P.Obj({
  id: P.id("mdl"),
  workspaceId: P.id("ws"),
  projectId: P.id("prj"),
  createdAt: P.Timestamp,
  purpose: P.Enum([
    "summarize",
    "normalize",
    "plan",
    "resolve_action",
    "generate_code",
    "classify",
    "analyze",
    "heal",
  ]),
  provider: P.Name,
  model: P.Name,
  promptHash: P.ContentDigest,
  modelConfigHash: Type.Optional(P.ContentDigest),
  sourceRevisionIds: Type.Optional(Type.Array(P.id("svr"))),
  runId: Type.Optional(P.id("run")),
  /** Chunk ids, requirement keys or semantic hashes, depending on the purpose. */
  inputRefs: Type.Array(Type.String()),
  usage: P.Obj({
    inputTokens: TokenCount,
    outputTokens: TokenCount,
    reasoningTokens: TokenCount,
    cachedInputTokens: Type.Optional(TokenCount),
  }),
  cost: Type.Union([DecimalMoney, Type.Literal("unknown")]),
  priceTableVersion: nullable(P.Name),
  costBasis: P.Enum(["estimated", "unknown", "not_billed"]),
  /** Milliseconds. */
  latency: P.Nonnegative,
  outcome: P.Enum(["success", "invalid", "failed", "cancelled"]),
  cacheHit: Type.Boolean(),
  repairAttempt: P.Nonnegative,
  transportAttempt: P.Nonnegative,
  /** Budget reservation id (random UUID); null for cache hits. */
  reservationId: nullable(Type.String({ pattern: `^${P.uuidPattern}$` })),
  responseHash: nullable(P.ContentDigest),
  finishReason: nullable(Type.String()),
  failureReason: Type.Optional(P.Enum(["output_truncated", "content_filtered"])),
  /**
   * Bounded, scrubbed account of an invalid response: validator paths, rules and messages only,
   * never model output text.
   */
  validationFailure: Type.Optional(
    P.Obj({
      code: P.Name,
      message: Type.String({ maxLength: 300 }),
      issues: Type.Array(
        P.Obj({
          path: Type.String({ maxLength: 200 }),
          rule: Type.String({ maxLength: 60 }),
          message: Type.String({ maxLength: 200 }),
        }),
        { maxItems: 5 },
      ),
      omittedIssues: P.Nonnegative,
    }),
  ),
});

/**
 * Body of GET /usage (`UsageService.get`). `query` echoes the
 * validated filters. `tokens` turns null as soon as one call lacks that count, `measuredTokens`
 * sums only the known counts, and `cost` is `"unknown"` when any call has no price.
 */
const UsageReport = P.Obj({
  query: P.Obj({
    projectId: Type.Optional(P.id("prj")),
    runId: Type.Optional(P.id("run")),
    model: Type.Optional(P.Name),
    since: Type.Optional(P.Timestamp),
    until: Type.Optional(P.Timestamp),
  }),
  calls: Type.Array(ModelCallView),
  tokens: TokenTotals,
  measuredTokens: TokenCounters,
  /** Calls whose provider reported no count, per component. */
  unknownTokenCalls: TokenCounters,
  estimatedTokens: Type.Null(),
  cost: Type.Union([MoneyList, Type.Literal("unknown")]),
  estimatedCosts: MoneyList,
  /** Always empty: provider billing is never read. */
  billedCosts: MoneyList,
  unclassifiedCosts: MoneyList,
  billingReconciliation: P.Obj({
    status: Type.Literal("not_requested"),
    divergence: Type.Null(),
    explanation: Type.String({ minLength: 1 }),
  }),
  unknownCostCalls: P.Nonnegative,
  cacheHitCalls: P.Nonnegative,
  cachedInputTokens: P.Nonnegative,
  runtimeMs: P.Nonnegative,
  componentAccounting: Type.String({ minLength: 1 }),
  runs: Type.Array(
    P.Obj({
      projectId: P.id("prj"),
      runId: P.id("run"),
      storageBytes: P.Nonnegative,
      runtimeMs: P.Nonnegative,
    }),
  ),
  storageBytes: P.Nonnegative,
  /** Reservation rows of the usage ledger by state; a released reservation never became usage. */
  reservations: P.Obj({
    reserved: P.Nonnegative,
    settled: P.Nonnegative,
    released: P.Nonnegative,
  }),
});

export const systemResponseContracts = {
  Liveness,
  LocalReadinessReport,
  ServerReadinessReport,
  ReadinessReport,
  CapabilityFeature,
  SandboxReport,
  ExecutionConfig,
  CapabilityReport,
  CodeExportMetadata,
  TestCodeExport,
  DecimalMoney,
  ModelCallView,
  UsageReport,
};
export type Liveness = Static<typeof Liveness>;
export type LocalReadinessReport = Static<typeof LocalReadinessReport>;
export type ServerReadinessReport = Static<typeof ServerReadinessReport>;
export type ReadinessReport = Static<typeof ReadinessReport>;
export type CapabilityReport = Static<typeof CapabilityReport>;
export type TestCodeExport = Static<typeof TestCodeExport>;
export type DecimalMoney = Static<typeof DecimalMoney>;
export type ModelCallView = Static<typeof ModelCallView>;
export type UsageReport = Static<typeof UsageReport>;
