import { requireEntity, type ServiceContext } from "./context.js";

/**
 * Where a revision stands against its test. `candidate`: never promoted and newer than the active
 * revision (or the test has none), so nothing replaced it. `replaced`: older than the active one, or
 * promoted once and since replaced, as after a rollback.
 */
export type RevisionStanding = "active" | "candidate" | "replaced";

export function revisionStanding(ctx: ServiceContext, revisionId: string): RevisionStanding {
  const revision = requireEntity(ctx, "TestRevision", revisionId);
  const test = requireEntity(ctx, "TestCase", String(revision.testId));
  if (test.activeRevisionId === revisionId) return "active";
  const active = test.activeRevisionId
    ? requireEntity(ctx, "TestRevision", String(test.activeRevisionId))
    : null;
  if (active && Number(revision.ordinal) < Number(active.ordinal)) return "replaced";
  return everPromoted(ctx, revisionId) ? "replaced" : "candidate";
}

function everPromoted(ctx: ServiceContext, revisionId: string): boolean {
  return Boolean(
    ctx.database.get(
      "SELECT 1 FROM audit_events WHERE workspace_id=? AND action='revision.promoted' AND resource_id=? LIMIT 1",
      ctx.workspaceId,
      revisionId,
    ),
  );
}
