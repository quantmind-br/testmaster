import { isIP } from "node:net";
import {
  assertNoNegativeBeforeRender,
  ContractError,
  type Environment,
  type EnvironmentRevision,
  type EnvironmentRevisionView,
  type ExecutablePlan,
  type Project,
  parseAndValidate,
  type TestCase,
  type TestRevision,
  validate,
} from "@testmaster/contracts";
import { materializePlanDefaults, semanticHash } from "@testmaster/domain";
import { AuditRepository, type EntityDocument } from "@testmaster/persistence";
import { type CanonicalTarget, canonicalUrl, classifyIp, PolicyDenied } from "@testmaster/sandbox";
import { assertCitedSchemasCompile } from "./ai/source-documents.js";
import { allEntities, entity, requireEntity, type ServiceContext } from "./context.js";
import { type RevisionStanding, revisionStanding } from "./revision-standing.js";

type Stored<T> = T & EntityDocument;

/** Records which revision became current, so history can tell candidates from superseded revisions. */
export function auditPromotion(
  ctx: ServiceContext,
  testId: string,
  revisionId: string,
  previousRevisionId: string | null,
): void {
  new AuditRepository(ctx.database).append({
    workspaceId: ctx.workspaceId,
    actor: ctx.principalId,
    action: "revision.promoted",
    resourceId: revisionId,
    requestId: ctx.correlationId ?? crypto.randomUUID(),
    beforeHash: previousRevisionId
      ? semanticHash({ testId, revisionId: previousRevisionId })
      : null,
    afterHash: semanticHash({ testId, revisionId }),
    timestamp: new Date().toISOString(),
  });
}
const MAX_DECISION_REASON = 2000;
/** The reason a reviewer gave with a decision, trimmed; null when none was given, `INVALID_ARGUMENT` when blank or too long. */
export function decisionReason(reason: string | undefined): string | null {
  if (reason === undefined) return null;
  const text = reason.trim();
  if (!text || text.length > MAX_DECISION_REASON)
    throw new ContractError(
      "INVALID_ARGUMENT",
      `A reason needs 1 to ${MAX_DECISION_REASON} characters`,
    );
  return text;
}
const PROMOTIONS_EXTENSION = "testmaster:promotions";
const ARCHIVE_EXTENSION = "testmaster:archive";
// A type alias (not an interface) so it is assignable to the JSON-valued extensions map.
export type PromotionRecord = {
  revisionId: string;
  reason: string;
  actorId: string;
  promotedAt: string;
};
/** The promotions of a test that recorded a reason, oldest first (kept in the test's extensions). */
export function promotionRecords(test: Pick<TestCase, "extensions">): PromotionRecord[] {
  const stored = test.extensions?.[PROMOTIONS_EXTENSION];
  return Array.isArray(stored) ? (stored as unknown as PromotionRecord[]) : [];
}
/**
 * Binding an auth profile to an environment needs no approval (the secret's allowed origins
 * already bound where a credential may go), so the change itself is recorded: the actor, the
 * environment, and hashes of the bound profile set before and after. Unchanged sets write nothing.
 */
export function auditAuthBinding(
  ctx: ServiceContext,
  environmentId: string,
  before: readonly string[],
  after: readonly string[],
): void {
  const sorted = (ids: readonly string[]) => [...ids].sort();
  if (semanticHash(sorted(before)) === semanticHash(sorted(after))) return;
  new AuditRepository(ctx.database).append({
    workspaceId: ctx.workspaceId,
    actor: ctx.principalId,
    action: "environment.auth_binding",
    resourceId: environmentId,
    requestId: ctx.correlationId ?? crypto.randomUUID(),
    beforeHash: semanticHash({ environmentId, authProfileRefs: sorted(before) }),
    afterHash: semanticHash({ environmentId, authProfileRefs: sorted(after) }),
    timestamp: new Date().toISOString(),
  });
}
export function authoringTransaction<T>(ctx: ServiceContext, action: () => T): T {
  return ctx.database.inTransaction ? action() : ctx.database.withTx(action);
}
export type ProjectPatch = Partial<Pick<Project, "name" | "slug" | "defaultEnvironmentId">>;
export interface EnvironmentInput {
  projectId: string;
  name: string;
  baseUrl: string;
  networkProfile?: EnvironmentRevision["networkProfile"];
  locale?: string;
  timezone?: string;
  production?: boolean;
  additionalOrigins?: string[];
  authRefs?: string[];
}
export type EnvironmentPatch = Partial<Omit<EnvironmentInput, "projectId">>;
export type TestPatch = Partial<Pick<TestCase, "name" | "tags" | "priority">>;

function keys(value: object, allowed: readonly string[]): void {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new ContractError("INVALID_ARGUMENT", "Input must be an object");
  for (const key of Object.keys(value)) {
    if (!allowed.includes(key))
      throw new ContractError("INVALID_ARGUMENT", "Unknown input field", { field: key });
    if ((value as Record<string, unknown>)[key] === null && key !== "defaultEnvironmentId")
      throw new ContractError("INVALID_ARGUMENT", "Null is not an omitted input field", {
        field: key,
      });
  }
}
function active(value: { archivedAt: string | null }): void {
  if (value.archivedAt)
    throw new ContractError("PRECONDITION_FAILED", "Archived resource cannot be modified");
}
function expected(value: EntityDocument, version: number): void {
  if (version === undefined || version === null)
    throw new ContractError("PRECONDITION_REQUIRED", "Expected version is required");
  if (!Number.isSafeInteger(version) || version < 1)
    throw new ContractError("INVALID_ARGUMENT", "Expected version must be a positive integer");
  if (value.version !== version)
    throw new ContractError("REVISION_CONFLICT", "Entity version changed");
}
function project(ctx: ServiceContext, id: string): Stored<Project> {
  return requireEntity(ctx, "Project", id) as Stored<Project>;
}
function visible(ctx: ServiceContext, projectId: string): boolean {
  try {
    ctx.authorize("R", projectId);
    return true;
  } catch (error) {
    if (error instanceof ContractError && error.code === "FORBIDDEN") return false;
    throw error;
  }
}
function origin(baseUrl: string, label = "Environment baseUrl"): string {
  let url: URL;
  try {
    url = new URL(baseUrl);
  } catch {
    throw new ContractError("INVALID_ARGUMENT", `${label} must be an absolute HTTP URL`);
  }
  if (
    !["http:", "https:"].includes(url.protocol) ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    url.pathname !== "/"
  )
    throw new ContractError(
      "INVALID_ARGUMENT",
      `${label} must be an HTTP origin without credentials, path, query or fragment`,
    );
  return url.origin;
}
function networkProfile(baseUrl: string): EnvironmentRevision["networkProfile"] {
  const host = new URL(baseUrl).hostname;
  return host === "localhost" || host === "[::1]" || /^127\./.test(host)
    ? "local-loopback"
    : "public";
}

const MAX_ADDITIONAL_ORIGINS = 32;
const PROFILE_ADDRESSES: Record<EnvironmentRevision["networkProfile"], readonly string[]> = {
  public: ["public"],
  private: ["private"],
  "local-loopback": ["loopback"],
};
/**
 * Exact extra origins page subrequests may reach. Each one is a bare http(s) origin like the
 * base URL (no path, query, credentials or wildcard), unique, different from every target
 * origin, and a literal address must be one the network profile permits. Host names are
 * resolved and classified by the egress proxy at connection time.
 */
function additionalOrigins(
  value: unknown,
  targets: readonly string[],
  profile: EnvironmentRevision["networkProfile"],
): string[] {
  if (!Array.isArray(value) || value.length > MAX_ADDITIONAL_ORIGINS)
    throw new ContractError(
      "INVALID_ARGUMENT",
      `additionalOrigins must be an array of at most ${MAX_ADDITIONAL_ORIGINS} origins`,
      { field: "additionalOrigins" },
    );
  const seen = new Set(targets.map((target) => canonicalUrl(target).origin));
  const result: string[] = [];
  for (const item of value) {
    const invalid = (message: string, reason: string): ContractError =>
      new ContractError("INVALID_ARGUMENT", message, { field: "additionalOrigins", reason });
    if (typeof item !== "string") throw invalid("Each additional origin must be a string", "type");
    if (item.includes("*"))
      throw invalid("Additional origins cannot contain wildcards", "wildcard");
    const normalized = origin(item, "Additional origin");
    let canonical: CanonicalTarget;
    try {
      canonical = canonicalUrl(normalized);
    } catch (error) {
      if (error instanceof PolicyDenied)
        throw invalid(
          `Additional origin is refused by the network policy (${error.reason})`,
          error.reason,
        );
      throw error;
    }
    if (seen.has(canonical.origin))
      throw invalid("Additional origin is duplicated or equals a target origin", "duplicate");
    seen.add(canonical.origin);
    const literal =
      canonical.hostname === "localhost" || canonical.hostname.endsWith(".localhost")
        ? "loopback"
        : isIP(canonical.hostname)
          ? classifyIp(canonical.hostname)
          : undefined;
    if (literal && !(PROFILE_ADDRESSES[profile] ?? []).includes(literal))
      throw new ContractError(
        "POLICY_DENIED",
        `Network profile "${profile}" does not permit a ${literal} additional origin`,
        { field: "additionalOrigins", origin: normalized, reasonCode: "egress_denied" },
      );
    result.push(normalized);
  }
  return result;
}
/**
 * Extra subrequest origins to merge into an attempt's network policy. They widen only the egress
 * policy: they are neither target origins (secret and profile bindings, approvals) nor admitted
 * when the profile is offline, which allows authorized local targets only.
 */
export function attemptAdditionalOrigins(
  revision: { additionalOrigins?: readonly string[] | undefined },
  targetOrigins: readonly string[],
  offline: boolean,
): string[] {
  if (offline) return [];
  return (revision.additionalOrigins ?? []).filter((extra) => !targetOrigins.includes(extra));
}

/** Strict, bounded parsing and shared structural/semantic validation; no effects. */
export function lintPlan(bytes: Uint8Array | string): ExecutablePlan {
  const plan = materializePlanDefaults(parseAndValidate<ExecutablePlan>("ExecutablePlan", bytes));
  assertNoNegativeBeforeRender(plan);
  return plan;
}
export function scaffoldPlan(type: "frontend" | "backend" | "cli"): ExecutablePlan {
  if (type === "frontend")
    return lintPlan(
      JSON.stringify({
        schemaVersion: "1.0.0",
        kind: "executable",
        name: "Reject an empty login password",
        type: "frontend",
        runner: "playwright",
        requirementRefs: [],
        steps: [
          {
            id: "open-login",
            kind: "action",
            operation: "navigate",
            description: "Open the login page",
            required: true,
            input: { path: "/login" },
          },
          {
            id: "submit-login",
            kind: "action",
            operation: "click",
            description: "Submit without a password",
            required: true,
            input: { locator: { by: "role", role: "button", name: "Sign in", exact: true } },
          },
          {
            id: "check-error",
            kind: "assertion",
            operation: "assert",
            description: "Require an explicit password validation error",
            required: true,
            input: { locator: { by: "testId", value: "password-error" } },
            expectation: { predicate: "textEquals", value: { literal: "Password is required" } },
          },
        ],
      }),
    );
  if (type === "backend")
    return lintPlan(
      JSON.stringify({
        schemaVersion: "1.0.0",
        kind: "executable",
        name: "Read service health",
        type: "backend",
        runner: "http",
        requirementRefs: [],
        steps: [
          {
            id: "get-health",
            kind: "action",
            operation: "request",
            description: "Read the controlled health endpoint",
            required: true,
            input: { method: "GET", pathSegments: [{ literal: "health" }], query: [], headers: {} },
          },
          {
            id: "check-status",
            kind: "assertion",
            operation: "assert",
            description: "Require HTTP 200",
            required: true,
            input: { responseStepId: "get-health" },
            expectation: { predicate: "statusIn", values: [200] },
          },
          {
            id: "check-health",
            kind: "assertion",
            operation: "assert",
            description: "Require a healthy service state",
            required: true,
            input: { responseStepId: "get-health", jsonPointer: "/status" },
            expectation: { predicate: "jsonEquals", value: { literal: "ok" } },
          },
        ],
      }),
    );
  if (type === "cli")
    return lintPlan(
      JSON.stringify({
        schemaVersion: "1.0.0",
        kind: "executable",
        name: "Print a greeting and exit cleanly",
        type: "cli",
        runner: "terminal",
        requirementRefs: [],
        steps: [
          {
            id: "print-greeting",
            kind: "action",
            operation: "run",
            description: "Run an image program without a shell",
            required: true,
            input: {
              program: { path: "/usr/bin/printf" },
              args: [{ literal: "%s" }, { literal: "hello" }],
            },
          },
          {
            id: "check-exit",
            kind: "assertion",
            operation: "assert",
            description: "Require a zero exit code",
            required: true,
            input: { processStepId: "print-greeting" },
            expectation: { predicate: "exitCodeIn", values: [0] },
          },
          {
            id: "check-output",
            kind: "assertion",
            operation: "assert",
            description: "Require the greeting on standard output",
            required: true,
            input: { processStepId: "print-greeting", stream: "stdout" },
            expectation: { predicate: "textEquals", value: { literal: "hello" } },
          },
        ],
      }),
    );
  throw new ContractError("INVALID_ARGUMENT", "Scaffold type must be frontend, backend or cli");
}
export function dryRunPlan(bytes: Uint8Array | string) {
  const plan = lintPlan(bytes);
  return {
    dryRun: true as const,
    validated: true as const,
    operations: [],
    unresolvedPreconditions: [],
    plan,
    contentHash: semanticHash(plan, "plan"),
  };
}

export class ProjectsService {
  constructor(readonly ctx: ServiceContext) {}
  create(input: { name: string; slug?: string }): Stored<Project> {
    this.ctx.authorize("W");
    keys(input, ["name", "slug"]);
    if (typeof input.name !== "string")
      throw new ContractError("INVALID_ARGUMENT", "Project name is required");
    return authoringTransaction(this.ctx, () => {
      const slug =
        input.slug ??
        input.name
          .normalize("NFC")
          .toLowerCase()
          .replace(/[^\p{L}\p{N}]+/gu, "-")
          .replace(/^-|-$/g, "");
      const value = entity(this.ctx, "prj", {
        name: input.name,
        slug,
        defaultEnvironmentId: null,
        archivedAt: null,
      }) as Stored<Project>;
      validate("Project", value);
      if (allEntities(this.ctx, "Project").some((item) => item.slug === slug))
        throw new ContractError("INVALID_ARGUMENT", "Project slug already exists");
      this.ctx.entities.insert("Project", value);
      return value;
    });
  }
  list(): Stored<Project>[] {
    this.ctx.authorize("R");
    return (allEntities(this.ctx, "Project") as Stored<Project>[]).filter((item) =>
      visible(this.ctx, item.id),
    );
  }
  get(id: string): Stored<Project> {
    this.ctx.authorize("R", id);
    return project(this.ctx, id);
  }
  update(id: string, patch: ProjectPatch, expectedVersion: number): Stored<Project> {
    this.ctx.authorize("W", id);
    keys(patch, ["name", "slug", "defaultEnvironmentId"]);
    return authoringTransaction(this.ctx, () => {
      const current = project(this.ctx, id);
      active(current);
      expected(current, expectedVersion);
      if (patch.defaultEnvironmentId != null) {
        const environment = requireEntity(
          this.ctx,
          "Environment",
          patch.defaultEnvironmentId,
        ) as Stored<Environment>;
        if (environment.projectId !== id || environment.archivedAt)
          throw new ContractError(
            "INVALID_ARGUMENT",
            "Default environment must be active in this project",
          );
      }
      const next = { ...current, ...patch, version: expectedVersion + 1 };
      if (
        allEntities(this.ctx, "Project").some((item) => item.id !== id && item.slug === next.slug)
      )
        throw new ContractError("INVALID_ARGUMENT", "Project slug already exists");
      this.ctx.entities.update("Project", this.ctx.workspaceId, id, expectedVersion, next);
      return next;
    });
  }
  archive(id: string, expectedVersion: number): Stored<Project> {
    this.ctx.authorize("W", id);
    return authoringTransaction(this.ctx, () => {
      const current = project(this.ctx, id);
      expected(current, expectedVersion);
      const next = {
        ...current,
        archivedAt: current.archivedAt ?? new Date().toISOString(),
        version: expectedVersion + 1,
      };
      this.ctx.entities.update("Project", this.ctx.workspaceId, id, expectedVersion, next);
      return next;
    });
  }
}

export class EnvironmentsService {
  constructor(readonly ctx: ServiceContext) {}
  create(input: EnvironmentInput): Stored<Environment> {
    this.ctx.authorize("W", input.projectId);
    keys(input, [
      "projectId",
      "name",
      "baseUrl",
      "networkProfile",
      "locale",
      "timezone",
      "production",
      "additionalOrigins",
      "authRefs",
    ]);
    return authoringTransaction(this.ctx, () => {
      const owner = project(this.ctx, input.projectId);
      active(owner);
      this.uniqueName(input.projectId, input.name);
      const target = origin(input.baseUrl);
      const profile = input.networkProfile ?? networkProfile(target);
      const revision = entity(this.ctx, "evr", {
        targetOrigins: [target],
        additionalOrigins: additionalOrigins(input.additionalOrigins ?? [], [target], profile),
        networkProfile: profile,
        authProfileRefs: this.authProfileRefs(input.projectId, input.authRefs ?? [], [target]),
        locale: input.locale ?? "en-US",
        timezone: input.timezone ?? "UTC",
        variables: {},
        production: input.production ?? false,
      }) as Stored<EnvironmentRevision>;
      const value = entity(this.ctx, "env", {
        projectId: input.projectId,
        name: input.name,
        activeRevisionId: revision.id,
        archivedAt: null,
      }) as Stored<Environment>;
      this.ctx.entities.insert("Environment", value);
      this.ctx.entities.insert("EnvironmentRevision", revision, { environmentId: value.id });
      auditAuthBinding(this.ctx, value.id, [], revision.authProfileRefs);
      return value;
    });
  }
  /** Every attached profile must belong to the project and be bound to each origin the environment targets. */
  private authProfileRefs(
    projectId: string,
    refs: readonly string[],
    targetOrigins: readonly string[],
  ): string[] {
    const unique = [...new Set(refs)];
    for (const id of unique) {
      const profile = this.ctx.entities.get("AuthProfile", this.ctx.workspaceId, id);
      if (!profile || profile.projectId !== projectId)
        throw new ContractError("NOT_FOUND", "Auth profile does not exist in this project", {
          authProfileId: id,
        });
      const bindings = profile.originBindings as string[];
      const outside = targetOrigins.filter((target) => !bindings.includes(target));
      if (outside.length)
        throw new ContractError(
          "PRECONDITION_FAILED",
          "Auth profile is not bound to the environment's target origin",
          { authProfileId: id, origins: outside, reasonCode: "security_precondition_failed" },
        );
    }
    return unique;
  }
  private uniqueName(projectId: string, name: string, except?: string): void {
    if (
      allEntities(this.ctx, "Environment").some(
        (item) => item.projectId === projectId && item.name === name && item.id !== except,
      )
    )
      throw new ContractError(
        "INVALID_ARGUMENT",
        "Environment name already exists in this project",
      );
  }
  list(projectId?: string): Stored<Environment>[] {
    this.ctx.authorize("R", projectId);
    if (projectId) project(this.ctx, projectId);
    return (allEntities(this.ctx, "Environment") as Stored<Environment>[]).filter(
      (item) => (!projectId || item.projectId === projectId) && visible(this.ctx, item.projectId),
    );
  }
  get(idOrName: string, projectId?: string): Stored<Environment> {
    this.ctx.authorize("R", projectId);
    const direct = this.ctx.entities.get<Stored<Environment>>(
      "Environment",
      this.ctx.workspaceId,
      idOrName,
    );
    const matches = direct
      ? [direct]
      : (allEntities(this.ctx, "Environment") as Stored<Environment>[]).filter(
          (item) =>
            item.name === idOrName &&
            (!projectId || item.projectId === projectId) &&
            visible(this.ctx, item.projectId),
        );
    const value = matches[0];
    if (!value || (projectId && value.projectId !== projectId))
      throw new ContractError("NOT_FOUND", "Environment does not exist", { idOrName });
    if (matches.length > 1)
      throw new ContractError(
        "INVALID_ARGUMENT",
        "Environment name is ambiguous; specify projectId",
      );
    this.ctx.authorize("R", value.projectId);
    return value;
  }
  /** Revision history, newest first, without `variables`, which may hold captured values. */
  revisions(idOrName: string): EnvironmentRevisionView[] {
    const environment = this.get(idOrName);
    return this.ctx.database
      .all<{ id: string }>(
        "SELECT id FROM environment_revisions WHERE workspace_id=? AND environment_id=? ORDER BY created_at DESC,id DESC",
        this.ctx.workspaceId,
        environment.id,
      )
      .map(({ id }) => {
        const revision = requireEntity(
          this.ctx,
          "EnvironmentRevision",
          id,
        ) as Stored<EnvironmentRevision>;
        return {
          id: revision.id,
          createdAt: revision.createdAt,
          targetOrigins: revision.targetOrigins,
          additionalOrigins: revision.additionalOrigins ?? [],
          networkProfile: revision.networkProfile,
          authProfileRefs: revision.authProfileRefs,
          locale: revision.locale,
          timezone: revision.timezone,
          production: revision.production,
        } as EnvironmentRevisionView;
      });
  }
  update(id: string, patch: EnvironmentPatch, expectedVersion: number): Stored<Environment> {
    this.ctx.authorize("W");
    keys(patch, [
      "name",
      "baseUrl",
      "networkProfile",
      "locale",
      "timezone",
      "production",
      "additionalOrigins",
      "authRefs",
    ]);
    return authoringTransaction(this.ctx, () => {
      const current = requireEntity(this.ctx, "Environment", id) as Stored<Environment>;
      this.ctx.authorize("W", current.projectId);
      active(project(this.ctx, current.projectId));
      active(current);
      expected(current, expectedVersion);
      this.uniqueName(current.projectId, patch.name ?? current.name, id);
      const previous = requireEntity(
        this.ctx,
        "EnvironmentRevision",
        current.activeRevisionId,
      ) as Stored<EnvironmentRevision>;
      const targetOrigins =
        patch.baseUrl === undefined ? previous.targetOrigins : [origin(patch.baseUrl)];
      const refs = this.authProfileRefs(
        current.projectId,
        patch.authRefs ?? previous.authProfileRefs,
        targetOrigins,
      );
      const profile = patch.networkProfile ?? previous.networkProfile;
      const revision = entity(this.ctx, "evr", {
        targetOrigins,
        additionalOrigins: additionalOrigins(
          patch.additionalOrigins ?? previous.additionalOrigins ?? [],
          targetOrigins,
          profile,
        ),
        networkProfile: profile,
        authProfileRefs: refs,
        locale: patch.locale ?? previous.locale,
        timezone: patch.timezone ?? previous.timezone,
        variables: previous.variables,
        production: patch.production ?? previous.production,
      }) as Stored<EnvironmentRevision>;
      this.ctx.entities.insert("EnvironmentRevision", revision, { environmentId: id });
      auditAuthBinding(this.ctx, id, previous.authProfileRefs, refs);
      const next = {
        ...current,
        name: patch.name ?? current.name,
        activeRevisionId: revision.id,
        version: expectedVersion + 1,
      };
      this.ctx.entities.update("Environment", this.ctx.workspaceId, id, expectedVersion, next);
      return next;
    });
  }
  setDefault(projectId: string, id: string, expectedVersion: number): Stored<Project> {
    this.ctx.authorize("W", projectId);
    return new ProjectsService(this.ctx).update(
      projectId,
      { defaultEnvironmentId: id },
      expectedVersion,
    );
  }
  archive(id: string, expectedVersion: number): Stored<Environment> {
    this.ctx.authorize("W");
    return authoringTransaction(this.ctx, () => {
      const current = requireEntity(this.ctx, "Environment", id) as Stored<Environment>;
      this.ctx.authorize("W", current.projectId);
      expected(current, expectedVersion);
      const owner = project(this.ctx, current.projectId);
      if (owner.defaultEnvironmentId === id)
        throw new ContractError(
          "PRECONDITION_FAILED",
          "Replace the default environment before archiving it",
        );
      const next = {
        ...current,
        archivedAt: current.archivedAt ?? new Date().toISOString(),
        version: expectedVersion + 1,
      };
      this.ctx.entities.update("Environment", this.ctx.workspaceId, id, expectedVersion, next);
      return next;
    });
  }
}

export class TestsService {
  constructor(readonly ctx: ServiceContext) {}
  create(input: {
    projectId?: string;
    plan: ExecutablePlan;
    name?: string;
    tags?: string[];
    priority?: TestCase["priority"];
    justification?: string;
  }): Stored<TestCase> {
    this.ctx.authorize("W", input.projectId);
    keys(input, ["projectId", "plan", "name", "tags", "priority", "justification"]);
    const plan = lintPlan(JSON.stringify(input.plan));
    return authoringTransaction(this.ctx, () => {
      let projectId = input.projectId;
      if (!projectId) {
        const candidates = new ProjectsService(this.ctx).list().filter((item) => !item.archivedAt);
        if (candidates.length !== 1)
          throw new ContractError(
            candidates.length ? "INVALID_ARGUMENT" : "PRECONDITION_FAILED",
            "Select an active project before creating a test",
          );
        projectId = candidates[0]?.id;
      }
      if (!projectId)
        throw new ContractError("PRECONDITION_FAILED", "An active project is required");
      this.ctx.authorize("W", projectId);
      active(project(this.ctx, projectId));
      const value = entity(this.ctx, "tst", {
        projectId,
        name: input.name ?? plan.name,
        activeRevisionId: null,
        tags: input.tags ?? plan.tags ?? [],
        priority: input.priority ?? plan.priority ?? "normal",
        archivedAt: null,
      }) as Stored<TestCase>;
      this.ctx.entities.insert("TestCase", value);
      const revision = new RevisionsService(this.ctx).create(value.id, plan, undefined, {
        ...(input.justification ? { justification: input.justification } : {}),
      });
      const next = { ...value, activeRevisionId: revision.id, version: 2 };
      this.ctx.entities.update("TestCase", this.ctx.workspaceId, value.id, 1, next);
      auditPromotion(this.ctx, value.id, revision.id, null);
      return next;
    });
  }
  list(projectId?: string): Stored<TestCase>[] {
    this.ctx.authorize("R", projectId);
    if (projectId) project(this.ctx, projectId);
    return (allEntities(this.ctx, "TestCase") as Stored<TestCase>[]).filter(
      (item) => (!projectId || item.projectId === projectId) && visible(this.ctx, item.projectId),
    );
  }
  get(id: string): Stored<TestCase> {
    this.ctx.authorize("R");
    const value = requireEntity(this.ctx, "TestCase", id) as Stored<TestCase>;
    this.ctx.authorize("R", value.projectId);
    return value;
  }
  update(id: string, patch: TestPatch, expectedVersion: number): Stored<TestCase> {
    this.ctx.authorize("W");
    keys(patch, ["name", "tags", "priority"]);
    return authoringTransaction(this.ctx, () => {
      const current = requireEntity(this.ctx, "TestCase", id) as Stored<TestCase>;
      this.ctx.authorize("W", current.projectId);
      active(project(this.ctx, current.projectId));
      active(current);
      expected(current, expectedVersion);
      const next = { ...current, ...patch, version: expectedVersion + 1 };
      this.ctx.entities.update("TestCase", this.ctx.workspaceId, id, expectedVersion, next);
      return next;
    });
  }
  /**
   * A reason is kept on the test with the actor and the time (`extensions['testmaster:archive']`), never in the
   * audit trail. Archiving an archived test keeps its first archive record.
   */
  archive(id: string, expectedVersion: number, reason?: string): Stored<TestCase> {
    this.ctx.authorize("W");
    const text = decisionReason(reason);
    return authoringTransaction(this.ctx, () => {
      const current = requireEntity(this.ctx, "TestCase", id) as Stored<TestCase>;
      this.ctx.authorize("W", current.projectId);
      expected(current, expectedVersion);
      const archivedAt = current.archivedAt ?? new Date().toISOString();
      const next = {
        ...current,
        ...(text && !current.archivedAt
          ? {
              extensions: {
                ...current.extensions,
                [ARCHIVE_EXTENSION]: { reason: text, actorId: this.ctx.principalId, archivedAt },
              },
            }
          : {}),
        archivedAt,
        version: expectedVersion + 1,
      };
      this.ctx.entities.update("TestCase", this.ctx.workspaceId, id, expectedVersion, next);
      return next;
    });
  }
}

/** Transactional CAS shared by authoring and verified healing; no authorization bypass. */
export function promoteRevisionCas(
  ctx: ServiceContext,
  revision: Stored<TestRevision>,
  current: Stored<TestCase>,
  expectedVersion: number,
  reason: string | null = null,
): Stored<TestCase> {
  if (revision.origin === "healed") {
    const proposal = allEntities(ctx, "HealingProposal").find(
      (value) => value.candidateRevisionId === revision.id,
    );
    if (
      !proposal ||
      proposal.status !== "approved" ||
      !proposal.verificationRunId ||
      current.activeRevisionId !== proposal.baseRevisionId
    )
      throw new ContractError(
        "PRECONDITION_FAILED",
        "Healing promotion requires approved verification and unchanged base",
      );
    const verification = requireEntity(ctx, "Run", String(proposal.verificationRunId));
    const failed = requireEntity(ctx, "Run", String(proposal.failedRunId));
    if (
      verification.phase !== "completed" ||
      verification.outcome !== "passed" ||
      verification.gate !== "passed" ||
      verification.revisionId !== revision.id ||
      verification.origin !== "verification" ||
      verification.mode !== "replay" ||
      verification.environmentRevisionId !== failed.environmentRevisionId
    )
      throw new ContractError(
        "PRECONDITION_FAILED",
        "Healing promotion requires its exact passing verification",
      );
    const healingExtensions = proposal.extensions as Record<string, unknown> | undefined;
    if (
      proposal.approvalMode === "policy" &&
      healingExtensions?.["testmaster:deferredLocatorProofs"] !== undefined &&
      healingExtensions["testmaster:deferredLocatorProofRunId"] !== verification.id
    )
      throw new ContractError(
        "PRECONDITION_FAILED",
        "Deferred locator identity requires reconciliation proof before promotion",
      );
    if (proposal.approvalMode === "manual") ctx.authorize("W", current.projectId);
    else ctx.authorize("X", current.projectId);
  } else ctx.authorize("W", current.projectId);
  expected(current, expectedVersion);
  const next = {
    ...current,
    ...(reason
      ? {
          extensions: {
            ...current.extensions,
            [PROMOTIONS_EXTENSION]: [
              ...promotionRecords(current),
              {
                revisionId: revision.id,
                reason,
                actorId: ctx.principalId,
                promotedAt: new Date().toISOString(),
              },
            ],
          },
        }
      : {}),
    activeRevisionId: revision.id,
    version: expectedVersion + 1,
  };
  ctx.entities.update("TestCase", ctx.workspaceId, current.id, expectedVersion, next);
  auditPromotion(ctx, current.id, revision.id, current.activeRevisionId);
  return next;
}
export class RevisionsService {
  constructor(readonly ctx: ServiceContext) {}
  create(
    testId: string,
    input: ExecutablePlan,
    parentId?: string,
    options: { justification?: string } = {},
  ): Stored<TestRevision> {
    this.ctx.authorize("W");
    const plan = lintPlan(JSON.stringify(input));
    assertCitedSchemasCompile(this.ctx, plan);
    return authoringTransaction(this.ctx, () => {
      const owner = requireEntity(this.ctx, "TestCase", testId) as Stored<TestCase>;
      this.ctx.authorize("W", owner.projectId);
      active(project(this.ctx, owner.projectId));
      active(owner);
      if (parentId) {
        const parent = requireEntity(this.ctx, "TestRevision", parentId) as Stored<TestRevision>;
        if (parent.testId !== testId)
          throw new ContractError("INVALID_ARGUMENT", "Parent revision belongs to another test");
      }
      const ordinal = Number(
        this.ctx.database.get(
          "SELECT COALESCE(MAX(ordinal),0)+1 AS ordinal FROM test_revisions WHERE workspace_id=? AND test_id=?",
          this.ctx.workspaceId,
          testId,
        )?.ordinal,
      );
      const value = entity(this.ctx, "rev", {
        testId,
        ordinal,
        contentHash: semanticHash(plan, "plan"),
        plan,
        codeArtifactId: null,
        runnerKind: plan.runner,
        author: this.ctx.principalId,
        parentId: parentId ?? null,
        origin: "manual",
        ...(options.justification
          ? { extensions: { "testmaster:justification": options.justification } }
          : {}),
      }) as Stored<TestRevision>;
      this.ctx.entities.insert("TestRevision", value);
      return value;
    });
  }
  list(testId: string): Stored<TestRevision>[] {
    this.ctx.authorize("R");
    const owner = requireEntity(this.ctx, "TestCase", testId) as Stored<TestCase>;
    this.ctx.authorize("R", owner.projectId);
    return (allEntities(this.ctx, "TestRevision") as Stored<TestRevision>[])
      .filter((item) => item.testId === testId)
      .sort((a, b) => a.ordinal - b.ordinal);
  }
  get(id: string): Stored<TestRevision> {
    this.ctx.authorize("R");
    const value = requireEntity(this.ctx, "TestRevision", id) as Stored<TestRevision>;
    const owner = requireEntity(this.ctx, "TestCase", value.testId) as Stored<TestCase>;
    this.ctx.authorize("R", owner.projectId);
    return value;
  }
  /** Whether a revision is the active one, a candidate nothing replaced, or replaced. */
  standing(id: string): RevisionStanding {
    this.get(id);
    return revisionStanding(this.ctx, id);
  }
  promote(id: string, expectedVersion: number, reason?: string): Stored<TestCase> {
    this.ctx.authorize("W");
    const text = decisionReason(reason);
    return authoringTransaction(this.ctx, () => {
      const revision = requireEntity(this.ctx, "TestRevision", id) as Stored<TestRevision>;
      const current = requireEntity(this.ctx, "TestCase", revision.testId) as Stored<TestCase>;
      this.ctx.authorize("W", current.projectId);
      active(project(this.ctx, current.projectId));
      active(current);
      expected(current, expectedVersion);
      const healing = allEntities(this.ctx, "HealingProposal").find(
        (proposal) => proposal.candidateRevisionId === id,
      );
      if (revision.origin === "healed" || healing) {
        if (!healing || healing.status !== "verified" || current.activeRevisionId !== id)
          throw new ContractError(
            "PRECONDITION_FAILED",
            "Healing candidates require bound passing verification and base CAS",
          );
        return current;
      }
      if (
        (revision.extensions as Record<string, unknown> | undefined)?.[
          "testmaster:verificationRequired"
        ] === true &&
        !allEntities(this.ctx, "Run").some(
          (run) =>
            run.revisionId === id &&
            run.mode === "replay" &&
            run.outcome === "passed" &&
            run.gate === "passed",
        )
      )
        throw new ContractError(
          "PRECONDITION_FAILED",
          "Generated candidate requires a passing deterministic replay before promotion",
        );
      return promoteRevisionCas(this.ctx, revision, current, expectedVersion, text);
    });
  }
}
