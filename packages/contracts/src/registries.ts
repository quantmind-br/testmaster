export type Milestone = "M0" | "M1" | "M2" | "M3" | "M4" | "M5" | "M6";
export type ReducerEffect =
  | "passed"
  | "failed"
  | "blocked_before_start"
  | "inconclusive"
  | "cancelled_if_confirmed"
  | "evidence"
  | "cleanup"
  | "none";
export interface ReasonMapping {
  effect: ReducerEffect;
  gate: "evaluate" | "required_failure" | "unchanged";
  exit: number;
  reporter: "failure" | "error" | "skipped" | "none";
}
const reasonGroups: ReadonlyArray<{ codes: readonly string[]; mapping: ReasonMapping }> = [
  {
    codes: ["assertions_satisfied"],
    mapping: { effect: "passed", gate: "evaluate", exit: 0, reporter: "none" },
  },
  {
    codes: ["assertion_mismatch", "assertion_timeout"],
    mapping: { effect: "failed", gate: "required_failure", exit: 1, reporter: "failure" },
  },
  {
    codes: [
      "missing_secret",
      "credential_revoked",
      "manual_auth_required",
      "auth_checkpoint_expired",
      "upstream_failed",
      "dependency_cycle",
      "ambiguous_producer",
    ],
    mapping: {
      effect: "blocked_before_start",
      gate: "required_failure",
      exit: 6,
      reporter: "error",
    },
  },
  {
    codes: ["unsupported_capability"],
    mapping: {
      effect: "blocked_before_start",
      gate: "required_failure",
      exit: 8,
      reporter: "error",
    },
  },
  {
    codes: ["security_precondition_failed", "approval_required", "egress_denied"],
    mapping: {
      effect: "blocked_before_start",
      gate: "required_failure",
      exit: 9,
      reporter: "error",
    },
  },
  {
    codes: [
      "worker_lost",
      "worker_lease_expired",
      "execution_deadline",
      "attempt_timeout",
      "insufficient_evidence",
      "oracle_uncertain",
      "retry_unsafe_external_effect",
    ],
    mapping: { effect: "inconclusive", gate: "required_failure", exit: 1, reporter: "error" },
  },
  {
    codes: ["user_cancelled", "deadline_cancelled", "tunnel_lost"],
    mapping: {
      effect: "cancelled_if_confirmed",
      gate: "required_failure",
      exit: 1,
      reporter: "skipped",
    },
  },
  {
    codes: [
      "artifact_limit_exceeded",
      "storage_unavailable",
      "artifact_expired",
      "redaction_failed",
    ],
    mapping: { effect: "evidence", gate: "evaluate", exit: 1, reporter: "error" },
  },
  {
    codes: ["budget_exhausted", "quota_exceeded"],
    mapping: { effect: "none", gate: "unchanged", exit: 12, reporter: "error" },
  },
  {
    codes: ["schedule_misfire", "schedule_overlap", "owner_revoked"],
    mapping: { effect: "none", gate: "unchanged", exit: 1, reporter: "skipped" },
  },
  {
    codes: ["cleanup_failed", "cleanup_inconclusive"],
    mapping: { effect: "cleanup", gate: "evaluate", exit: 1, reporter: "error" },
  },
  {
    codes: ["optional_step_skipped", "stopped_after_failure", "cancelled_before_step"],
    mapping: { effect: "evidence", gate: "evaluate", exit: 1, reporter: "skipped" },
  },
];
export const reasonRegistry: Readonly<Record<string, ReasonMapping>> = Object.freeze(
  Object.fromEntries(
    reasonGroups.flatMap(({ codes, mapping }) =>
      codes.map((code) => [code, Object.freeze(mapping)]),
    ),
  ),
);
export const reasonCodes = Object.keys(reasonRegistry);
export const errorRegistry = {
  INVALID_ARGUMENT: { httpStatus: 400, retryable: false, cliExit: 5 },
  UNAUTHENTICATED: { httpStatus: 401, retryable: false, cliExit: 3 },
  FORBIDDEN: { httpStatus: 403, retryable: false, cliExit: 3 },
  NOT_FOUND: { httpStatus: 404, retryable: false, cliExit: 4 },
  IDEMPOTENCY_CONFLICT: { httpStatus: 409, retryable: "conditional", cliExit: 6 },
  RUN_IN_FLIGHT: { httpStatus: 409, retryable: "conditional", cliExit: 6 },
  REVISION_CONFLICT: { httpStatus: 412, retryable: false, cliExit: 6 },
  PRECONDITION_REQUIRED: { httpStatus: 428, retryable: false, cliExit: 6 },
  PRECONDITION_FAILED: { httpStatus: 422, retryable: false, cliExit: 6 },
  CAPABILITY_UNAVAILABLE: { httpStatus: 422, retryable: false, cliExit: 8 },
  POLICY_DENIED: { httpStatus: 422, retryable: false, cliExit: 9 },
  PAYLOAD_TOO_LARGE: { httpStatus: 413, retryable: false, cliExit: 5 },
  RATE_LIMITED: { httpStatus: 429, retryable: "conditional", cliExit: 11 },
  QUOTA_EXCEEDED: { httpStatus: 429, retryable: "conditional", cliExit: 12 },
  ARTIFACT_EXPIRED: { httpStatus: 410, retryable: false, cliExit: 4 },
  CURSOR_EXPIRED: { httpStatus: 410, retryable: false, cliExit: 6 },
  UNAVAILABLE: { httpStatus: 503, retryable: true, cliExit: 10 },
  UPSTREAM_TIMEOUT: { httpStatus: 504, retryable: "conditional", cliExit: 10 },
  INTERNAL: { httpStatus: 500, retryable: false, cliExit: 10 },
} as const;
export type ErrorCode = keyof typeof errorRegistry;
export interface ValidationIssue {
  path: string;
  rule: string;
  message: string;
}
export class ContractError extends Error {
  readonly code: ErrorCode;
  readonly details: Record<string, unknown>;
  readonly issues: readonly ValidationIssue[];
  constructor(
    code: ErrorCode,
    message: string,
    details: Record<string, unknown> = {},
    issues: readonly ValidationIssue[] = [],
  ) {
    super(message);
    this.name = "ContractError";
    this.code = code;
    this.details = details;
    this.issues = issues;
  }
}
export interface Capability {
  id: string;
  enabled: boolean;
  milestone: Milestone;
  disabledReason: string | null;
  experimental?: boolean;
}
const features: Record<Milestone, readonly string[]> = {
  M0: ["contracts", "state-reducer", "traceability"],
  M1: [
    "local-execution",
    "playwright",
    "http",
    "python",
    "docker",
    "unsafe-local",
    "worker",
    "evidence",
    "report-json",
    "report-markdown",
    "report-html",
    "report-junit",
    "report-allure",
    "backup-sqlite",
  ],
  M2: [
    "source-markdown",
    "source-text",
    "source-pdf",
    "source-openapi",
    "source-postman",
    "source-graphql",
    "code-summary",
    "code-diff",
    "normalize",
    "plan",
    "resolve_action",
    "generate_code",
    "agent-mode",
    "code-import",
    "code-export",
    "mcp",
    "agent-skills",
    "resources-cleanup",
    "model-accounting",
  ],
  M3: [
    "analysis",
    "healing",
    "run-comparison",
    "batch-comparison",
    "flake-study",
    "quarantine",
    "selective-run",
    "integration-planning",
    "artifact-deletion",
    "ci",
  ],
  M4: [
    "server",
    "postgres",
    "multi-user",
    "suites",
    "schedules",
    "auth-dynamic",
    "identity",
    "workers-registration",
    "integrations",
    "deliveries",
    "secrets-rotation",
    "audit-api",
  ],
  M5: [
    "distributed",
    "tunnels",
    "matrix-advanced",
    "visualMatches",
    "accessibilityViolations",
    "memory",
    "visual-baselines",
  ],
  M6: ["sso", "scim", "portability", "break-glass"],
};
export const capabilityRegistry: Readonly<Record<string, Capability>> = Object.freeze(
  Object.fromEntries(
    Object.entries(features).flatMap(([milestone, ids]) =>
      ids.map((id) => [
        id,
        Object.freeze({
          id,
          enabled: ["M0", "M1", "M2", "M3"].includes(milestone),
          milestone: milestone as Milestone,
          disabledReason: ["M0", "M1", "M2", "M3"].includes(milestone)
            ? null
            : `Available in ${milestone}`,
          ...(milestone === "M2" && ["plan", "generate_code", "agent-mode"].includes(id)
            ? { experimental: true }
            : {}),
        }),
      ]),
    ),
  ),
);
export function requireCapability(capability: string): void {
  const entry = capabilityRegistry[capability];
  if (!entry?.enabled)
    throw new ContractError("CAPABILITY_UNAVAILABLE", "Capability is unavailable", {
      capability,
      milestone: entry?.milestone ?? null,
    });
}
