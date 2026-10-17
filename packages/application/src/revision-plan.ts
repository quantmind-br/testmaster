import type { ExecutablePlan } from "@testmaster/contracts";
import type { EntityDocument } from "@testmaster/persistence";
import type { ServiceContext } from "./context.js";

/**
 * The plan a revision verifies: its own, or for a code revision (generated from a plan, or imported
 * as a fix of one) the nearest plan in its parent chain. Requirements, features and coverage map a
 * code revision through it; null when no ancestor has a plan (code imported as a new test).
 */
export function governingPlan(ctx: ServiceContext, revisionId: string): ExecutablePlan | null {
  const seen = new Set<string>();
  let id: string | null = revisionId;
  while (id && !seen.has(id)) {
    seen.add(id);
    const revision: EntityDocument | null = ctx.entities.get("TestRevision", ctx.workspaceId, id);
    if (!revision) return null;
    if (revision.plan) return revision.plan as ExecutablePlan;
    id = revision.parentId ? String(revision.parentId) : null;
  }
  return null;
}
