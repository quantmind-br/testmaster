import {
  ContractError,
  type Environment,
  type EnvironmentRevision,
  type ExecutablePlan,
  type Project,
  parseAndValidate,
  type TestCase,
  type TestRevision,
  validate,
} from "@testmaster/contracts";
import { materializePlanDefaults, semanticHash } from "@testmaster/domain";
import type { EntityDocument } from "@testmaster/persistence";
import { allEntities, entity, requireEntity, type ServiceContext } from "./context.js";

type Stored<T> = T & EntityDocument;
export function authoringTransaction<T>(ctx: ServiceContext, action: () => T): T {
  return ctx.database.db.isTransaction ? action() : ctx.database.withTx(action);
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
function origin(baseUrl: string): string {
  let url: URL;
  try {
    url = new URL(baseUrl);
  } catch {
    throw new ContractError("INVALID_ARGUMENT", "Environment baseUrl must be an absolute HTTP URL");
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
      "Environment baseUrl must be an HTTP origin without credentials, path, query or fragment",
    );
  return url.origin;
}
function networkProfile(baseUrl: string): EnvironmentRevision["networkProfile"] {
  const host = new URL(baseUrl).hostname;
  return host === "localhost" || host === "[::1]" || /^127\./.test(host)
    ? "local-loopback"
    : "public";
}

/** Strict, bounded parsing and shared structural/semantic validation; no effects. */
export function lintPlan(bytes: Uint8Array | string): ExecutablePlan {
  return materializePlanDefaults(parseAndValidate<ExecutablePlan>("ExecutablePlan", bytes));
}
export function scaffoldPlan(type: "frontend" | "backend"): ExecutablePlan {
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
  throw new ContractError("INVALID_ARGUMENT", "Scaffold type must be frontend or backend");
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
  purge(id: string, confirm: string | boolean): never {
    this.ctx.authorize("A", id);
    project(this.ctx, id);
    if (confirm !== id)
      throw new ContractError("INVALID_ARGUMENT", "Purge confirmation must equal the project ID");
    throw new ContractError(
      "CAPABILITY_UNAVAILABLE",
      "Project purge requires the M4 deletion lifecycle",
      { capability: "project-purge", milestone: "M4" },
    );
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
    ]);
    return authoringTransaction(this.ctx, () => {
      const owner = project(this.ctx, input.projectId);
      active(owner);
      this.uniqueName(input.projectId, input.name);
      const target = origin(input.baseUrl);
      const revision = entity(this.ctx, "evr", {
        targetOrigins: [target],
        networkProfile: input.networkProfile ?? networkProfile(target),
        authProfileRefs: [],
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
      return value;
    });
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
  update(id: string, patch: EnvironmentPatch, expectedVersion: number): Stored<Environment> {
    this.ctx.authorize("W");
    keys(patch, ["name", "baseUrl", "networkProfile", "locale", "timezone", "production"]);
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
      const revision = entity(this.ctx, "evr", {
        targetOrigins:
          patch.baseUrl === undefined ? previous.targetOrigins : [origin(patch.baseUrl)],
        networkProfile: patch.networkProfile ?? previous.networkProfile,
        authProfileRefs: previous.authProfileRefs,
        locale: patch.locale ?? previous.locale,
        timezone: patch.timezone ?? previous.timezone,
        variables: previous.variables,
        production: patch.production ?? previous.production,
      }) as Stored<EnvironmentRevision>;
      this.ctx.entities.insert("EnvironmentRevision", revision, { environmentId: id });
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
  }): Stored<TestCase> {
    this.ctx.authorize("W", input.projectId);
    keys(input, ["projectId", "plan", "name", "tags", "priority"]);
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
      const revision = new RevisionsService(this.ctx).create(value.id, plan);
      const next = { ...value, activeRevisionId: revision.id, version: 2 };
      this.ctx.entities.update("TestCase", this.ctx.workspaceId, value.id, 1, next);
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
  archive(id: string, expectedVersion: number): Stored<TestCase> {
    this.ctx.authorize("W");
    return authoringTransaction(this.ctx, () => {
      const current = requireEntity(this.ctx, "TestCase", id) as Stored<TestCase>;
      this.ctx.authorize("W", current.projectId);
      expected(current, expectedVersion);
      const next = {
        ...current,
        archivedAt: current.archivedAt ?? new Date().toISOString(),
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
    const cell = failed.matrixCell as Record<string, unknown>;
    if (proposal.approvalMode === "manual")
      ctx.authorizeNamed(
        "approve",
        "HealingProposal",
        current.projectId,
        String(cell.environmentId),
      );
    else ctx.authorize("X", current.projectId);
  } else ctx.authorize("W", current.projectId);
  expected(current, expectedVersion);
  const next = { ...current, activeRevisionId: revision.id, version: expectedVersion + 1 };
  ctx.entities.update("TestCase", ctx.workspaceId, current.id, expectedVersion, next);
  return next;
}
export class RevisionsService {
  constructor(readonly ctx: ServiceContext) {}
  create(testId: string, input: ExecutablePlan, parentId?: string): Stored<TestRevision> {
    this.ctx.authorize("W");
    const plan = lintPlan(JSON.stringify(input));
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
  promote(id: string, expectedVersion: number): Stored<TestCase> {
    this.ctx.authorize("W");
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
      return promoteRevisionCas(this.ctx, revision, current, expectedVersion);
    });
  }
}
