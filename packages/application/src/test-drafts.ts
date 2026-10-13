import {
  ContractError,
  type TestCase,
  type TestDraft,
  type TestRevision,
} from "@testmaster/contracts";
import type { EntityDocument } from "@testmaster/persistence";
import { authoringTransaction } from "./authoring.js";
import { requireEntity, type ServiceContext } from "./context.js";

const maxDraftBytes = 1_048_576;

interface DraftRow {
  id: unknown;
  test_id: unknown;
  project_id: unknown;
  principal_id: unknown;
  base_revision_id: unknown;
  content_json: unknown;
  version: unknown;
  created_at: unknown;
  updated_at: unknown;
}

/**
 * UX-023: server-side, per-principal drafts of a test plan. A draft is private text that is never a
 * TestRevision; publishing goes through the revision route, so executed history stays immutable.
 */
export class TestDraftsService {
  constructor(readonly ctx: ServiceContext) {}
  get(testId: string): TestDraft {
    const test = this.test(testId);
    this.ctx.authorize("R", test.projectId);
    const row = this.row(testId);
    if (!row) throw new ContractError("NOT_FOUND", "No draft exists for this test", { testId });
    return this.document(row);
  }
  put(
    testId: string,
    input: { baseRevisionId: string; plan: unknown; expectedVersion?: number },
  ): TestDraft {
    const test = this.test(testId);
    this.ctx.authorize("W", test.projectId);
    if (test.archivedAt)
      throw new ContractError("PRECONDITION_FAILED", "Archived resource cannot be modified");
    if (typeof input.plan !== "object" || input.plan === null || Array.isArray(input.plan))
      throw new ContractError("INVALID_ARGUMENT", "A draft plan must be a JSON object");
    const content = JSON.stringify(input.plan);
    if (Buffer.byteLength(content) > maxDraftBytes)
      throw new ContractError("INVALID_ARGUMENT", "Draft is larger than 1 MiB");
    return authoringTransaction(this.ctx, () => {
      const base = requireEntity(this.ctx, "TestRevision", input.baseRevisionId) as TestRevision &
        EntityDocument;
      if (base.testId !== testId)
        throw new ContractError("INVALID_ARGUMENT", "Base revision belongs to another test");
      const existing = this.row(testId);
      const now = new Date().toISOString();
      if (!existing) {
        this.ctx.database.run(
          "INSERT INTO test_drafts(workspace_id,id,created_at,updated_at,version,project_id,test_id,principal_id,base_revision_id,content_json) VALUES(?,?,?,?,?,?,?,?,?,?)",
          this.ctx.workspaceId,
          `drf_${crypto.randomUUID()}`,
          now,
          now,
          1,
          test.projectId,
          testId,
          this.ctx.principalId,
          base.id,
          content,
        );
      } else {
        if (input.expectedVersion === undefined)
          throw new ContractError(
            "PRECONDITION_REQUIRED",
            "A draft already exists; send the version you last read",
            { currentVersion: Number(existing.version) },
          );
        if (input.expectedVersion !== Number(existing.version))
          throw new ContractError("REVISION_CONFLICT", "Draft changed in another session", {
            diff: {
              expectedVersion: input.expectedVersion,
              currentVersion: Number(existing.version),
              submitted: input.plan,
              current: JSON.parse(String(existing.content_json)),
            },
          });
        const result = this.ctx.database.run(
          "UPDATE test_drafts SET updated_at=?,version=version+1,base_revision_id=?,content_json=? WHERE workspace_id=? AND id=? AND version=?",
          now,
          base.id,
          content,
          this.ctx.workspaceId,
          String(existing.id),
          input.expectedVersion,
        );
        if (result.changes !== 1)
          throw new ContractError("REVISION_CONFLICT", "Draft changed in another session");
      }
      const saved = this.row(testId);
      if (!saved) throw new ContractError("INTERNAL", "Draft was not stored");
      return this.document(saved);
    });
  }
  discard(testId: string): void {
    const test = this.test(testId);
    this.ctx.authorize("W", test.projectId);
    this.ctx.database.run(
      "DELETE FROM test_drafts WHERE workspace_id=? AND test_id=? AND principal_id=?",
      this.ctx.workspaceId,
      testId,
      this.ctx.principalId,
    );
  }
  private test(testId: string): TestCase & EntityDocument {
    return requireEntity(this.ctx, "TestCase", testId) as TestCase & EntityDocument;
  }
  private row(testId: string): DraftRow | undefined {
    return this.ctx.database.get(
      "SELECT * FROM test_drafts WHERE workspace_id=? AND test_id=? AND principal_id=?",
      this.ctx.workspaceId,
      testId,
      this.ctx.principalId,
    ) as DraftRow | undefined;
  }
  private document(row: DraftRow): TestDraft {
    const latest = this.ctx.database.get(
      "SELECT id FROM test_revisions WHERE workspace_id=? AND test_id=? ORDER BY ordinal DESC LIMIT 1",
      this.ctx.workspaceId,
      String(row.test_id),
    );
    return {
      id: String(row.id),
      testId: String(row.test_id),
      projectId: String(row.project_id),
      principalId: String(row.principal_id),
      baseRevisionId: String(row.base_revision_id),
      plan: JSON.parse(String(row.content_json)),
      version: Number(row.version),
      createdAt: String(row.created_at),
      updatedAt: String(row.updated_at),
      baseSuperseded: latest ? String(latest.id) !== String(row.base_revision_id) : false,
    };
  }
}
