import { randomUUID } from "node:crypto";
import {
  type BatchReceipt,
  type BatchRequest,
  ContractError,
  type RunRequest,
  type SuiteExpansion,
  type SuiteInput,
  type SuitePatchInput,
  type SuiteRunInput,
  type SuiteSelection,
  validate,
} from "@testmaster/contracts";
import { semanticHash } from "@testmaster/domain";
import type { EntityDocument } from "@testmaster/persistence";
import { auditSecurity } from "./audit.js";
import { allEntities, entity, requireEntity, type ServiceContext } from "./context.js";
import type { BatchesService } from "./runs.js";

export interface StoredSuite extends EntityDocument {
  name: string;
  description: string;
  selection: SuiteSelection;
  state: "active" | "archived";
  createdBy: string;
  updatedAt: string;
}
type Member = SuiteExpansion["members"][number];
type Exclusion = SuiteExpansion["exclusions"][number];
type Mapping = SuiteExpansion["mapping"][number];
type Origin = NonNullable<RunRequest["origin"]>;

export interface SuiteRunOptions {
  origin?: Origin;
  idempotencyKey?: string;
  /** Admit even when no worker is live; the Runs then wait for one. */
  wait?: boolean;
  /** The caller's flag naming `wait`, quoted when no worker is live (CLI: `--queue`). */
  waitFlag?: string;
  scheduleId?: string | null;
  /** Runs inside the admission transaction (a stale scheduler leader throws here). */
  guard?: () => void;
}
/** One resolution of a list: what a caller sees, plus the exact requests a run would admit. */
export interface ResolvedSuite {
  expansion: SuiteExpansion;
  requests: RunRequest[];
}

function expectVersion(current: EntityDocument, version: number): void {
  if (version === undefined || version === null)
    throw new ContractError("PRECONDITION_REQUIRED", "Expected version is required");
  if (!Number.isSafeInteger(version) || version < 1)
    throw new ContractError("INVALID_ARGUMENT", "Expected version must be a positive integer");
  if (current.version !== version)
    throw new ContractError("REVISION_CONFLICT", "Entity version changed");
}
function inTx<T>(ctx: ServiceContext, action: () => T): T {
  return ctx.database.inTransaction ? action() : ctx.database.withTx(action);
}
function collectSecretRefs(value: unknown, into: Set<string>): void {
  if (!value || typeof value !== "object") return;
  for (const [name, child] of Object.entries(value)) {
    if (name === "secretRef" && typeof child === "string") into.add(child);
    else collectSecretRefs(child, into);
  }
}
function matches(
  test: EntityDocument,
  filter: { tags?: string[]; priorities?: string[]; nameContains?: string } | undefined,
): boolean {
  if (!filter) return true;
  if (filter.tags?.length && !(test.tags as string[]).some((tag) => filter.tags?.includes(tag)))
    return false;
  if (filter.priorities?.length && !filter.priorities.includes(String(test.priority))) return false;
  if (
    filter.nameContains &&
    !String(test.name).toLowerCase().includes(filter.nameContains.toLowerCase())
  )
    return false;
  return true;
}

/**
 * Lists (suites): ordered sets of tests across projects, either fixed TestRevision snapshots or
 * dynamic filters (REQ-034). Resolution never widens access: a project the requester cannot
 * execute in is an explicit exclusion, never a silent omission (UX-041, UX-042).
 */
export class SuitesService {
  constructor(
    readonly ctx: ServiceContext,
    private readonly batches: BatchesService,
  ) {}

  private can(scope: "R" | "X", projectId: string): boolean {
    try {
      this.ctx.authorize(scope, projectId);
      return true;
    } catch (error) {
      if (error instanceof ContractError && error.code === "FORBIDDEN") return false;
      throw error;
    }
  }
  list(): StoredSuite[] {
    this.ctx.authorize("R");
    return (allEntities(this.ctx, "Suite") as StoredSuite[]).filter((s) => s.state === "active");
  }
  get(id: string): StoredSuite {
    this.ctx.authorize("R");
    return requireEntity(this.ctx, "Suite", id) as StoredSuite;
  }
  /** Rejects selections the requester cannot read or that point at missing, mismatched or archived resources. */
  assertSelection(selection: SuiteSelection): void {
    const seen = new Set<string>();
    const readable = (projectId: string): void => {
      const project = this.ctx.entities.get("Project", this.ctx.workspaceId, projectId);
      if (!project)
        throw new ContractError("NOT_FOUND", "Project does not exist", { id: projectId });
      this.ctx.authorize("R", projectId);
      if (project.archivedAt)
        throw new ContractError("PRECONDITION_FAILED", "Project is archived", { id: projectId });
    };
    const environment = (environmentId: string, projectId: string): void => {
      const env = requireEntity(this.ctx, "Environment", environmentId);
      if (env.projectId !== projectId || env.archivedAt)
        throw new ContractError(
          "PRECONDITION_FAILED",
          "Environment is not active in this project",
          {
            id: environmentId,
          },
        );
    };
    if (selection.kind === "dynamic") {
      for (const binding of selection.projects) {
        if (seen.has(binding.projectId))
          throw new ContractError("INVALID_ARGUMENT", "A project appears twice in a list", {
            id: binding.projectId,
          });
        seen.add(binding.projectId);
        readable(binding.projectId);
        environment(binding.environmentId, binding.projectId);
      }
      return;
    }
    for (const member of selection.members) {
      const key = `${member.testId}:${member.revisionId}:${member.environmentId}`;
      if (seen.has(key))
        throw new ContractError("INVALID_ARGUMENT", "A member appears twice in a list", {
          id: member.testId,
        });
      seen.add(key);
      const test = requireEntity(this.ctx, "TestCase", member.testId);
      const projectId = String(test.projectId);
      readable(projectId);
      const revision = requireEntity(this.ctx, "TestRevision", member.revisionId);
      if (revision.testId !== test.id || (!revision.plan && !revision.codeRef))
        throw new ContractError(
          "PRECONDITION_FAILED",
          "Revision does not belong to the test or has no executable plan",
          { id: member.revisionId },
        );
      environment(member.environmentId, projectId);
    }
  }
  private assertUniqueName(name: string, exceptId?: string): void {
    const clash = (allEntities(this.ctx, "Suite") as StoredSuite[]).find(
      (item) => item.state === "active" && item.name === name && item.id !== exceptId,
    );
    if (clash)
      throw new ContractError("INVALID_ARGUMENT", "A list with this name already exists", { name });
  }
  create(input: SuiteInput): StoredSuite {
    validate("SuiteInput", input);
    this.ctx.authorize("W");
    return inTx(this.ctx, () => {
      this.assertSelection(input.selection);
      this.assertUniqueName(input.name);
      const now = new Date().toISOString();
      const value = entity(this.ctx, "sui", {
        name: input.name,
        description: input.description ?? "",
        selection: input.selection,
        state: "active",
        createdBy: this.ctx.principalId,
        updatedAt: now,
      }) as StoredSuite;
      this.ctx.entities.insert("Suite", value);
      auditSecurity(this.ctx, "suites.create", value.id, "allowed");
      return value;
    });
  }
  update(id: string, patch: SuitePatchInput, expectedVersion: number): StoredSuite {
    validate("SuitePatchInput", patch);
    this.ctx.authorize("W");
    return inTx(this.ctx, () => {
      const current = requireEntity(this.ctx, "Suite", id) as StoredSuite;
      expectVersion(current, expectedVersion);
      if (current.state === "archived")
        throw new ContractError("PRECONDITION_FAILED", "Archived list cannot be modified");
      if (patch.selection) this.assertSelection(patch.selection);
      if (patch.name) this.assertUniqueName(patch.name, id);
      const next = {
        ...current,
        name: patch.name ?? current.name,
        description: patch.description ?? current.description,
        selection: patch.selection ?? current.selection,
        updatedAt: new Date().toISOString(),
        version: expectedVersion + 1,
      };
      this.ctx.entities.update("Suite", this.ctx.workspaceId, id, expectedVersion, next);
      auditSecurity(this.ctx, "suites.update", id, "allowed");
      return next;
    });
  }
  archive(id: string, expectedVersion: number): StoredSuite {
    this.ctx.authorize("W");
    return inTx(this.ctx, () => {
      const current = requireEntity(this.ctx, "Suite", id) as StoredSuite;
      expectVersion(current, expectedVersion);
      const next = {
        ...current,
        state: "archived" as const,
        updatedAt: new Date().toISOString(),
        version: expectedVersion + 1,
      };
      this.ctx.entities.update("Suite", this.ctx.workspaceId, id, expectedVersion, next);
      auditSecurity(this.ctx, "suites.archive", id, "allowed");
      return next;
    });
  }

  /** The effective expansion of a stored list as the requester would run it right now. */
  expansion(id: string): SuiteExpansion {
    this.ctx.authorize("R");
    const suite = requireEntity(this.ctx, "Suite", id) as StoredSuite;
    return this.resolve(suite.selection, { id: suite.id, version: Number(suite.version) })
      .expansion;
  }
  /** Expansion of an unsaved definition; validated like a save, nothing is stored. */
  preview(input: SuiteInput): SuiteExpansion {
    validate("SuiteInput", input);
    this.ctx.authorize("R");
    this.assertSelection(input.selection);
    return this.resolve(input.selection, null).expansion;
  }

  /**
   * Resolves a selection for the requester. Projects they cannot read and execute in become
   * exclusions keyed by project (no names), so a revoked grant is visible and never omitted.
   */
  resolve(selection: SuiteSelection, ref: { id: string; version: number } | null): ResolvedSuite {
    const members: Member[] = [];
    const requests: RunRequest[] = [];
    const exclusions: Exclusion[] = [];
    const mapping = new Map<string, Mapping & { secrets: Set<string> }>();
    const excludedProjects = new Set<string>();
    const usable = new Map<string, EntityDocument | null>();
    const excludeProject = (
      projectId: string,
      kind: Exclusion["kind"],
      reasonCode: Exclusion["reasonCode"],
      message: string,
    ): null => {
      if (!excludedProjects.has(projectId)) {
        excludedProjects.add(projectId);
        exclusions.push({
          key: `project:${projectId}`,
          scope: "project",
          projectId,
          testId: null,
          kind,
          reasonCode,
          message,
        });
      }
      return null;
    };
    const project = (projectId: string): EntityDocument | null => {
      if (usable.has(projectId)) return usable.get(projectId) ?? null;
      let found: EntityDocument | null = null;
      if (!this.can("R", projectId) || !this.can("X", projectId))
        excludeProject(
          projectId,
          "access_denied",
          "actor_revoked",
          "You cannot read and execute in a project of this list",
        );
      else {
        const stored = this.ctx.entities.get("Project", this.ctx.workspaceId, projectId);
        if (!stored || stored.archivedAt)
          excludeProject(
            projectId,
            "project_unavailable",
            "upstream_failed",
            "A project of this list is missing or archived",
          );
        else found = stored;
      }
      usable.set(projectId, found);
      return found;
    };
    const environmentFor = (
      projectId: string,
      environmentId: string,
    ): { env: EntityDocument; revision: EntityDocument } | null => {
      const env = this.ctx.entities.get("Environment", this.ctx.workspaceId, environmentId);
      const revision =
        env && env.projectId === projectId && !env.archivedAt && env.activeRevisionId
          ? this.ctx.entities.get(
              "EnvironmentRevision",
              this.ctx.workspaceId,
              String(env.activeRevisionId),
            )
          : null;
      if (!env || !revision) {
        excludeProject(
          projectId,
          "environment_unavailable",
          "upstream_failed",
          "The environment pinned for a project of this list is missing or archived",
        );
        return null;
      }
      return { env, revision };
    };
    const add = (
      owner: EntityDocument,
      test: EntityDocument,
      revision: EntityDocument,
      env: { env: EntityDocument; revision: EntityDocument },
    ): void => {
      const projectId = String(owner.id);
      members.push({
        memberKey: `${members.length}:${test.id}`,
        projectId,
        projectName: String(owner.name),
        testId: test.id,
        testName: String(test.name),
        revisionId: revision.id,
        revisionOrdinal: Number(revision.ordinal),
        environmentId: env.env.id,
        environmentName: String(env.env.name),
      });
      requests.push({
        testId: test.id,
        revisionId: revision.id,
        environmentId: env.env.id,
      });
      let row = mapping.get(projectId);
      if (!row) {
        row = {
          projectId,
          projectName: String(owner.name),
          environmentId: env.env.id,
          environmentName: String(env.env.name),
          environmentRevisionId: env.revision.id,
          targetOrigins: [...(env.revision.targetOrigins as string[])],
          secretRefs: [],
          memberCount: 0,
          secrets: new Set<string>(),
        };
        mapping.set(projectId, row);
      }
      row.memberCount++;
      collectSecretRefs(revision.plan, row.secrets);
    };

    if (selection.kind === "fixed") {
      for (const pinned of selection.members) {
        const test = requireEntity(this.ctx, "TestCase", pinned.testId);
        const projectId = String(test.projectId);
        const owner = project(projectId);
        if (!owner) continue;
        const env = environmentFor(projectId, pinned.environmentId);
        if (!env) continue;
        const revision = this.ctx.entities.get(
          "TestRevision",
          this.ctx.workspaceId,
          pinned.revisionId,
        );
        if (
          test.archivedAt ||
          !revision ||
          revision.testId !== test.id ||
          (!revision.plan && !revision.codeRef)
        ) {
          exclusions.push({
            key: `member:${test.id}`,
            scope: "member",
            projectId,
            testId: test.id,
            kind: test.archivedAt ? "test_unavailable" : "revision_unavailable",
            reasonCode: "upstream_failed",
            message: test.archivedAt
              ? "A pinned test is archived"
              : "A pinned revision is missing or not executable",
          });
          continue;
        }
        add(owner, test, revision, env);
      }
    } else {
      const tests = allEntities(this.ctx, "TestCase");
      for (const binding of selection.projects) {
        const owner = project(binding.projectId);
        if (!owner) continue;
        const env = environmentFor(binding.projectId, binding.environmentId);
        if (!env) continue;
        const selected = tests
          .filter(
            (test) =>
              test.projectId === binding.projectId &&
              !test.archivedAt &&
              test.activeRevisionId &&
              matches(test, binding.filter),
          )
          .sort(
            (a, b) =>
              String(a.name).localeCompare(String(b.name)) ||
              String(a.id).localeCompare(String(b.id)),
          );
        for (const test of selected) {
          const revision = this.ctx.entities.get(
            "TestRevision",
            this.ctx.workspaceId,
            String(test.activeRevisionId),
          );
          // Dynamic lists select executable active revisions; a test without one is not a member.
          if (revision && (revision.plan || revision.codeRef)) add(owner, test, revision, env);
        }
      }
    }
    // Members are only added for projects that stayed usable, so the mapping never names an excluded one.
    const finalMapping: Mapping[] = [...mapping.values()].map(({ secrets, ...row }) => ({
      ...row,
      secretRefs: [...secrets].sort(),
    }));
    const body = {
      kind: selection.kind,
      members: members.map(({ memberKey: _key, ...rest }) => rest),
      exclusions,
      mapping: finalMapping,
    };
    const expansion: SuiteExpansion = {
      suiteId: (ref?.id ?? null) as SuiteExpansion["suiteId"],
      suiteVersion: ref?.version ?? null,
      kind: selection.kind,
      resolvedAt: new Date().toISOString(),
      hash: semanticHash(body),
      members,
      exclusions,
      mapping: finalMapping,
      requiresConfirmation: exclusions.map((item) => item.key),
      dispatchable: members.length > 0,
    };
    return { expansion, requests };
  }

  /** Admission of one BatchRun from a list; expansion, revisions and mapping are frozen on it. */
  async run(
    id: string,
    input: SuiteRunInput = {},
    options: SuiteRunOptions = {},
  ): Promise<BatchReceipt> {
    validate("SuiteRunInput", input);
    this.ctx.authorize("X");
    const suite = requireEntity(this.ctx, "Suite", id) as StoredSuite;
    if (suite.state === "archived")
      throw new ContractError("PRECONDITION_FAILED", "Archived list cannot run");
    const key = options.idempotencyKey ?? randomUUID();
    const replay = this.replayed(key, id);
    if (replay) return replay;
    const { expansion, requests } = this.resolve(suite.selection, {
      id: suite.id,
      version: Number(suite.version),
    });
    return this.admit(expansion, requests, input, { ...options, idempotencyKey: key });
  }
  /** Frozen batches from the same key are returned even if the list changed after the first call. */
  private replayed(key: string, suiteId: string): BatchReceipt | null {
    const row = this.ctx.database.get(
      "SELECT response_json FROM idempotency_receipts WHERE workspace_id=? AND actor_scope=? AND operation='batch.admit' AND key=? AND expires_at>?",
      this.ctx.workspaceId,
      this.ctx.principalId,
      key,
      new Date().toISOString(),
    );
    if (!row) return null;
    const receipt = JSON.parse(String(row.response_json)) as BatchReceipt;
    const batch = this.ctx.entities.get("BatchRun", this.ctx.workspaceId, receipt.batchId);
    return batch?.suiteId === suiteId ? receipt : null;
  }
  /** Shared by lists and schedules: confirmation rules first, then one idempotent batch admission. */
  async admit(
    expansion: SuiteExpansion,
    requests: RunRequest[],
    input: SuiteRunInput,
    options: SuiteRunOptions & { idempotencyKey: string },
  ): Promise<BatchReceipt> {
    if (input.expectedExpansionHash && input.expectedExpansionHash !== expansion.hash)
      throw new ContractError("REVISION_CONFLICT", "The list changed since it was previewed", {
        expected: input.expectedExpansionHash,
        actual: expansion.hash,
      });
    const confirmed = new Set(input.confirmedExclusions ?? []);
    const known = new Set(expansion.exclusions.map((item) => item.key));
    const stale = [...confirmed].filter((key) => !known.has(key));
    if (stale.length)
      throw new ContractError("INVALID_ARGUMENT", "Confirmed exclusion does not apply", {
        keys: stale,
      });
    const unconfirmed = expansion.exclusions.filter((item) => !confirmed.has(item.key));
    if (unconfirmed.length)
      throw new ContractError(
        unconfirmed.some((item) => item.kind === "access_denied")
          ? "FORBIDDEN"
          : "PRECONDITION_FAILED",
        "Part of this list is not available; confirm the subset to run it",
        {
          reasonCode: unconfirmed[0]?.reasonCode,
          exclusions: unconfirmed,
          nextActions: ["confirm_subset"],
        },
      );
    if (!requests.length)
      throw new ContractError("PRECONDITION_FAILED", "No member of this list can be dispatched", {
        exclusions: expansion.exclusions,
      });
    const origin: Origin = options.origin ?? "api";
    const request: BatchRequest = {
      selection: requests.map((member) => ({
        ...member,
        mode: input.mode ?? "replay",
        origin,
        healingPolicy: input.healingPolicy ?? "off",
        ...(input.seed === undefined ? {} : { seed: input.seed }),
        ...(input.limits ? { limits: input.limits } : {}),
      })),
      partialDispatch: false,
    };
    return this.batches.admit(request, {
      idempotencyKey: options.idempotencyKey,
      ...(options.wait === undefined ? {} : { wait: options.wait }),
      ...(options.waitFlag ? { waitFlag: options.waitFlag } : {}),
      provenance: {
        suiteId: expansion.suiteId,
        scheduleId: options.scheduleId ?? null,
        snapshot: {
          suiteId: expansion.suiteId,
          suiteVersion: expansion.suiteVersion,
          kind: expansion.kind,
          resolvedAt: expansion.resolvedAt,
          hash: expansion.hash,
          members: expansion.members,
          exclusions: expansion.exclusions,
          mapping: expansion.mapping,
          confirmedExclusions: [...confirmed],
        },
        rejected: expansion.exclusions
          .filter((item) => confirmed.has(item.key))
          .map((item) => ({ memberKey: item.key, reasonCode: item.reasonCode })),
        ...(options.guard ? { guard: options.guard } : {}),
      },
    });
  }
}
