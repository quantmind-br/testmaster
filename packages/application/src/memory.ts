import {
  ContractError,
  type MemoryEntry,
  type MemoryEntryInput,
  type MemoryEntryPatchInput,
  type MemoryEntryView,
  type MemoryState,
  validate,
} from "@testmaster/contracts";
import { scrubEvidenceText, semanticHash } from "@testmaster/domain";
import { AuditRepository, type EntityDocument, type PageCursor } from "@testmaster/persistence";
import { readAiState } from "./ai/sources.js";
import { authoringTransaction, decisionReason } from "./authoring.js";
import type { ResolvedConfig } from "./config.js";
import { allEntities, entity, requireEntity, type ServiceContext } from "./context.js";

type StoredMemory = MemoryEntry & EntityDocument;
/** One piece of evidence a memory entry cites. */
export type MemoryEvidenceRef = MemoryEntry["sourceRefs"][number];
/** The reviewer's reason for an approval, kept in the entity extensions like a requirement's. */
const DECISION_EXTENSION = "testmaster:decision";

/** What the model receives of an active entry: the statement and where it came from, never ids of approvals. */
export interface ActiveMemory {
  id: string;
  text: string;
  sourceRefs: MemoryEvidenceRef[];
  validFrom: string;
  expiresAt: string | null;
}

/** The fields of a memory edit; `approve` is a separate decision and never combined with an edit. */
export type MemoryEdit = Pick<
  MemoryEntryPatchInput,
  "expectedVersion" | "text" | "sourceRefs" | "validFrom" | "expiresAt"
>;

const unresolved = (index: number, detail: string): ContractError =>
  new ContractError("INVALID_ARGUMENT", `Source reference ${index} does not resolve: ${detail}`, {
    reasonCode: "memory_source_unresolved",
    index,
  });

/** The project a test belongs to, or null when the test does not exist. */
function projectOfTest(ctx: ServiceContext, testId: unknown): string | null {
  const test = ctx.entities.get("TestCase", ctx.workspaceId, String(testId));
  return test ? String(test.projectId) : null;
}
function projectOfRun(ctx: ServiceContext, runId: string): string | null {
  const run = ctx.entities.get("Run", ctx.workspaceId, runId);
  return run ? projectOfTest(ctx, run.testId) : null;
}
function projectOfRevision(ctx: ServiceContext, revisionId: unknown): string | null {
  const revision = ctx.entities.get("TestRevision", ctx.workspaceId, String(revisionId));
  return revision ? projectOfTest(ctx, revision.testId) : null;
}

/**
 * Refuses a reference that does not name evidence of `projectId`. Every identifier a reference
 * carries must resolve inside the project, and a reference that names no evidence at all (a path
 * or offset alone) is refused, so a memory entry always has a verifiable origin.
 */
function assertResolves(
  ctx: ServiceContext,
  projectId: string,
  ref: MemoryEvidenceRef,
  index: number,
) {
  const inProject = (found: string | null, what: string): void => {
    if (found !== projectId) throw unresolved(index, `${what} is not in this project`);
  };
  const anchored =
    ref.sourceRevisionId ??
    ref.artifactId ??
    ref.snapshotId ??
    ref.runId ??
    ref.codeSnapshotId ??
    null;
  if (!anchored) throw unresolved(index, "it names no source revision, artifact, Run or snapshot");
  if (ref.sourceRevisionId)
    inProject(
      readAiState<{ projectId: string }>(ctx, `revision:${ref.sourceRevisionId}`)?.projectId ??
        null,
      "source revision",
    );
  if (ref.runId) inProject(projectOfRun(ctx, ref.runId), "Run");
  if (ref.attemptId) {
    const attempt = ctx.entities.get("Attempt", ctx.workspaceId, ref.attemptId);
    if (!attempt || attempt.runId !== ref.runId)
      throw unresolved(index, "attempt does not belong to the cited Run");
  }
  if (ref.artifactId) {
    const artifact = ctx.entities.get("Artifact", ctx.workspaceId, ref.artifactId);
    inProject(artifact ? projectOfRevision(ctx, artifact.revisionId) : null, "artifact");
  }
  if (ref.snapshotId) {
    const snapshot = ctx.entities.get("Snapshot", ctx.workspaceId, ref.snapshotId);
    inProject(snapshot ? projectOfRevision(ctx, snapshot.revisionId) : null, "snapshot");
  }
  if (ref.codeSnapshotId) {
    const row = ctx.database.get(
      "SELECT project_id FROM code_snapshots WHERE workspace_id=? AND id=?",
      ctx.workspaceId,
      ref.codeSnapshotId,
    );
    inProject(row ? String(row.project_id) : null, "code snapshot");
  }
}

/** The cited source revisions that are no longer the active revision of a live source. */
function staleRefsOf(ctx: ServiceContext, entry: MemoryEntry): MemoryEvidenceRef[] {
  return entry.sourceRefs.filter((ref) => {
    if (!ref.sourceRevisionId) return false;
    const revision = readAiState<{ sourceId: string; projectId: string }>(
      ctx,
      `revision:${ref.sourceRevisionId}`,
    );
    if (!revision || revision.projectId !== entry.projectId) return true;
    const source = readAiState<{ revisionId: string; archivedAt: string | null }>(
      ctx,
      `source:${revision.sourceId}`,
    );
    return !source || source.archivedAt !== null || source.revisionId !== ref.sourceRevisionId;
  });
}

/** Where an entry stands at `now`; the first matching condition wins. */
function viewOf(ctx: ServiceContext, entry: MemoryEntry, now: string): MemoryEntryView {
  const staleRefs = staleRefsOf(ctx, entry);
  const state: MemoryState = entry.tombstoneAt
    ? "forgotten"
    : !entry.approval
      ? "pending"
      : entry.validFrom > now
        ? "scheduled"
        : entry.expiresAt !== null && entry.expiresAt <= now
          ? "expired"
          : staleRefs.length
            ? "stale"
            : "active";
  return { ...entry, version: entry.version ?? 1, state, staleRefs };
}

function projectEntries(ctx: ServiceContext, projectId: string): StoredMemory[] {
  const items: StoredMemory[] = [];
  let cursor: PageCursor | null = null;
  do {
    const page: { items: StoredMemory[]; next: PageCursor | null } = ctx.entities.page(
      "MemoryEntry",
      ctx.workspaceId,
      { limit: 100, where: { projectId }, ...(cursor ? { cursor } : {}) },
    ) as { items: StoredMemory[]; next: PageCursor | null };
    items.push(...page.items);
    cursor = page.next;
  } while (cursor);
  return items;
}

/**
 * The approved entries of a project that are inside their validity window and whose cited source
 * revisions are all still current. Authorization is the caller's: the model service reads this for
 * a call it already authorized.
 */
export function activeProjectMemory(ctx: ServiceContext, projectId: string): ActiveMemory[] {
  const now = new Date().toISOString();
  return projectEntries(ctx, projectId)
    .map((entry) => viewOf(ctx, entry, now))
    .filter((view) => view.state === "active")
    .map(({ id, text, sourceRefs, validFrom, expiresAt }) => ({
      id,
      text,
      sourceRefs,
      validFrom,
      expiresAt,
    }));
}

/**
 * Approved project memory (ADR-034): reviewed facts about one project that reach the planning,
 * analysis and healing prompts as untrusted data. Memory never rewrites a requirement, an
 * assertion or a policy; an edit sends an entry back to review, and a changed source retires it.
 */
export class MemoryService {
  constructor(
    readonly ctx: ServiceContext,
    private readonly config: ResolvedConfig,
  ) {}

  /** A pending entry with its sources; text that holds credentials or personal data is refused. */
  create(projectId: string, input: MemoryEntryInput): MemoryEntryView {
    this.ctx.authorize("W", projectId);
    const request = validate<MemoryEntryInput>("MemoryEntryInput", input);
    const project = requireEntity(this.ctx, "Project", projectId);
    if (project.archivedAt)
      throw new ContractError("PRECONDITION_FAILED", "Project is archived", { projectId });
    refuseSensitive(request.text);
    for (const [index, ref] of request.sourceRefs.entries())
      assertResolves(this.ctx, projectId, ref, index);
    const now = new Date().toISOString();
    const validFrom = request.validFrom ?? now;
    const expiresAt = request.expiresAt ?? null;
    refuseEmptyWindow(validFrom, expiresAt);
    const created = entity(this.ctx, "mry", {
      projectId,
      text: request.text,
      sourceRefs: request.sourceRefs,
      validFrom,
      expiresAt,
      approval: null,
      tombstoneAt: null,
    }) as StoredMemory;
    authoringTransaction(this.ctx, () => {
      this.ctx.entities.insert("MemoryEntry", created);
      this.audit("memory.created", created.id, null, created);
    });
    return viewOf(this.ctx, created, now);
  }

  /** Every entry of a project, newest first, each with its derived state. */
  list(projectId: string): MemoryEntryView[] {
    this.ctx.authorize("R", projectId);
    requireEntity(this.ctx, "Project", projectId);
    const now = new Date().toISOString();
    return projectEntries(this.ctx, projectId).map((entry) => viewOf(this.ctx, entry, now));
  }

  get(id: string): MemoryEntryView {
    const current = this.entry(id);
    this.ctx.authorize("R", current.projectId);
    return viewOf(this.ctx, current, new Date().toISOString());
  }

  /** Edits an entry; any edit clears the approval so the changed fact is reviewed again. */
  update(id: string, edit: MemoryEdit): MemoryEntryView {
    const request = validate<MemoryEdit>("MemoryEntryPatchInput", edit);
    if (
      request.text === undefined &&
      request.sourceRefs === undefined &&
      request.validFrom === undefined &&
      request.expiresAt === undefined
    )
      throw new ContractError("INVALID_ARGUMENT", "An edit changes at least one field");
    return this.mutate(id, request.expectedVersion, (current) => {
      if (current.tombstoneAt)
        throw new ContractError("PRECONDITION_FAILED", "A forgotten entry cannot be edited", {
          reasonCode: "memory_forgotten",
        });
      if (request.text !== undefined) refuseSensitive(request.text);
      for (const [index, ref] of (request.sourceRefs ?? []).entries())
        assertResolves(this.ctx, current.projectId, ref, index);
      const validFrom = request.validFrom ?? current.validFrom;
      const expiresAt = request.expiresAt === undefined ? current.expiresAt : request.expiresAt;
      refuseEmptyWindow(validFrom, expiresAt);
      const { extensions: previous, ...base } = current;
      const { [DECISION_EXTENSION]: _decision, ...extensions } = previous ?? {};
      return {
        ...base,
        text: request.text ?? current.text,
        sourceRefs: request.sourceRefs ?? current.sourceRefs,
        validFrom,
        expiresAt,
        approval: null,
        ...(Object.keys(extensions).length ? { extensions } : {}),
      };
    });
  }

  /**
   * Approves an entry like a requirement: an `Approval` bound to the entry's content and the
   * project's environment. The author may approve their own entry; any later edit clears it.
   */
  approve(id: string, input: { expectedVersion: number; reason?: string }): MemoryEntryView {
    const reason = decisionReason(input.reason);
    return this.mutate(id, input.expectedVersion, (current) => {
      if (current.tombstoneAt)
        throw new ContractError("PRECONDITION_FAILED", "A forgotten entry cannot be approved", {
          reasonCode: "memory_forgotten",
        });
      if (current.approval)
        throw new ContractError("PRECONDITION_FAILED", "Memory entry is already approved", {
          reasonCode: "memory_already_approved",
        });
      const environment = allEntities(this.ctx, "Environment").find(
        (item) => item.projectId === current.projectId,
      );
      if (!environment)
        throw new ContractError(
          "PRECONDITION_FAILED",
          "Memory approval requires a project environment",
        );
      const approval = entity(this.ctx, "apr", {
        actorId: this.ctx.principalId,
        reviewerId: this.ctx.principalId,
        actionSet: ["memory.approve"],
        revisionHash: semanticHash(current),
        environmentRevisionId: environment.activeRevisionId,
        originSet: [],
        expiresAt: "9999-12-31T23:59:59.000Z",
        revokedAt: null,
        policyHash: this.config.effectiveConfig.policyHash,
        reason: `Approve memory entry ${id}`,
      });
      this.ctx.entities.insert("Approval", approval);
      return {
        ...current,
        approval: approval.id as string,
        ...(reason
          ? {
              extensions: {
                ...current.extensions,
                [DECISION_EXTENSION]: {
                  action: "approved",
                  reason,
                  actorId: this.ctx.principalId,
                  decidedAt: new Date().toISOString(),
                },
              },
            }
          : {}),
      };
    });
  }

  /**
   * Forgets an entry: its text and sources are erased and a tombstone is set; the approval stays
   * for audit. Forgetting a forgotten entry changes nothing.
   */
  forget(id: string): MemoryEntryView {
    const current = this.entry(id);
    this.ctx.authorize("W", current.projectId);
    if (current.tombstoneAt) return viewOf(this.ctx, current, new Date().toISOString());
    return this.mutate(id, current.version ?? 1, (latest) => ({
      ...latest,
      text: "",
      sourceRefs: [],
      tombstoneAt: new Date().toISOString(),
    }));
  }

  /** The active entries a prompt carries for one project. */
  activeProjectMemory(projectId: string): ActiveMemory[] {
    this.ctx.authorize("R", projectId);
    return activeProjectMemory(this.ctx, projectId);
  }

  private entry(id: string): StoredMemory {
    return requireEntity(this.ctx, "MemoryEntry", id) as StoredMemory;
  }

  private mutate(
    id: string,
    expectedVersion: number,
    action: (current: StoredMemory) => StoredMemory,
  ): MemoryEntryView {
    return authoringTransaction(this.ctx, () => {
      const current = this.entry(id);
      this.ctx.authorize("W", current.projectId);
      if (current.version !== expectedVersion)
        throw new ContractError("REVISION_CONFLICT", "Memory entry changed", {
          expectedVersion,
          actualVersion: current.version,
        });
      const next = action(current);
      this.ctx.entities.update("MemoryEntry", this.ctx.workspaceId, id, expectedVersion, next);
      this.audit("memory.updated", id, current, next);
      return viewOf(
        this.ctx,
        { ...next, version: expectedVersion + 1 } as StoredMemory,
        new Date().toISOString(),
      );
    });
  }

  private audit(action: string, resourceId: string, before: unknown, after: unknown): void {
    new AuditRepository(this.ctx.database).append({
      workspaceId: this.ctx.workspaceId,
      actor: this.ctx.principalId,
      action,
      resourceId,
      requestId: this.ctx.correlationId ?? crypto.randomUUID(),
      beforeHash: before ? semanticHash(before) : null,
      afterHash: semanticHash(after),
      timestamp: new Date().toISOString(),
    });
  }
}

/** Memory is for facts: text that holds a credential or personal data is never stored. */
function refuseSensitive(text: string): void {
  if (scrubEvidenceText(text).redacted)
    throw new ContractError(
      "POLICY_DENIED",
      "Memory text must not hold a credential or personal data; state the fact without it",
      { reasonCode: "memory_sensitive_content" },
    );
}

function refuseEmptyWindow(validFrom: string, expiresAt: string | null): void {
  if (expiresAt !== null && expiresAt <= validFrom)
    throw new ContractError("INVALID_ARGUMENT", "expiresAt must be after validFrom", {
      field: "expiresAt",
    });
}
