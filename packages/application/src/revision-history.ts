import type {
  HealingProposal,
  TestCase,
  TestHistoryEntry,
  TestRevision,
} from "@testmaster/contracts";
import type { EntityDocument } from "@testmaster/persistence";
import { allEntities, requireEntity, type ServiceContext } from "./context.js";
import { comparePlans } from "./plan-analysis.js";

type StoredRevision = TestRevision & EntityDocument;
type Extensions = Record<string, unknown>;

/**
 * UX-020, UX-024: one entry per immutable revision with who changed it, why, which kind of change it is and the
 * lifecycle states derived from facts (promotion audit, acceptance record, active pointer).
 */
export class RevisionHistoryService {
  constructor(readonly ctx: ServiceContext) {}
  list(testId: string): TestHistoryEntry[] {
    const test = requireEntity(this.ctx, "TestCase", testId) as TestCase & EntityDocument;
    this.ctx.authorize("R", test.projectId);
    const revisions = (allEntities(this.ctx, "TestRevision") as StoredRevision[])
      .filter((item) => item.testId === testId)
      .sort((a, b) => a.ordinal - b.ordinal);
    const byId = new Map(revisions.map((revision) => [revision.id, revision]));
    const promotions = this.promotions(revisions.map((revision) => revision.id));
    const healings = new Map(
      (allEntities(this.ctx, "HealingProposal") as (HealingProposal & EntityDocument)[])
        .filter((item) => item.testId === testId)
        .map((item) => [item.candidateRevisionId, item] as const),
    );
    return revisions.map((revision, index) => {
      const previous =
        (revision.parentId ? byId.get(revision.parentId) : undefined) ?? revisions[index - 1];
      const extensions = (revision.extensions ?? {}) as Extensions;
      const healing = healings.get(revision.id);
      const authorship = extensions["testmaster:authorship"] as
        | { generatedBy?: string | null; humanEdits?: unknown[] }
        | undefined;
      const humanEdited = (authorship?.humanEdits?.length ?? 0) > 0;
      const change =
        previous?.plan && revision.plan ? comparePlans(previous.plan, revision.plan) : null;
      const kinds = new Set<TestHistoryEntry["changeKinds"][number]>();
      if (!previous) kinds.add("initial");
      if (change?.intent.length) kinds.add("intent_assertion");
      // Code revisions and plan/code switches cannot be compared structurally: a new hash is an intent change.
      if (previous && !change && previous.contentHash !== revision.contentHash)
        kinds.add("intent_assertion");
      if (change?.operational.length) kinds.add("operational");
      if (revision.origin !== "manual") kinds.add("source_model");
      if (!kinds.size) kinds.add("operational");
      const promotedAt = promotions.get(revision.id) ?? null;
      const current = test.activeRevisionId === revision.id;
      const states: TestHistoryEntry["states"] = [];
      if (current) states.push("current");
      else if (promotedAt) states.push("superseded");
      else states.push("candidate");
      if (extensions["testmaster:acceptance"]) states.push("accepted");
      return {
        id: revision.id,
        ordinal: revision.ordinal,
        createdAt: revision.createdAt,
        author: revision.author,
        origin: revision.origin,
        authorship:
          revision.origin === "healed"
            ? "healing"
            : revision.origin === "imported"
              ? "import"
              : revision.origin === "generated"
                ? "llm"
                : "human",
        humanEdited,
        parentId: revision.parentId,
        contentHash: revision.contentHash,
        changeKinds: [...kinds],
        assertionChanges: change?.assertions ?? { added: [], removed: [], changed: [] },
        operationalChanges: change?.operational ?? [],
        justification:
          typeof extensions["testmaster:justification"] === "string"
            ? extensions["testmaster:justification"]
            : (healing?.diff ?? null),
        proposalId:
          typeof extensions["testmaster:proposalId"] === "string"
            ? extensions["testmaster:proposalId"]
            : null,
        healingProposalId: healing?.id ?? null,
        modelCallId: healing?.modelCallId ?? authorship?.generatedBy ?? null,
        states,
        promotedAt,
      } as TestHistoryEntry;
    });
  }
  /** Most recent promotion instant per revision, from the append-only audit log. */
  private promotions(revisionIds: string[]): Map<string, string> {
    if (!revisionIds.length) return new Map();
    const rows = this.ctx.database.all(
      `SELECT resource_id, MAX(timestamp) AS promoted_at FROM audit_events WHERE workspace_id=? AND action='revision.promoted' AND resource_id IN (${revisionIds.map(() => "?").join(",")}) GROUP BY resource_id`,
      this.ctx.workspaceId,
      ...revisionIds,
    );
    return new Map(rows.map((row) => [String(row.resource_id), String(row.promoted_at)]));
  }
}
