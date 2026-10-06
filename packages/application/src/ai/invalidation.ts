import { canonicalJson, semanticHash } from "@testmaster/domain";
import { allEntities, type ServiceContext } from "../context.js";

/** Supersede authoring descendants, never immutable revisions or admitted Runs. */
export function invalidateAiDescendants(
  ctx: ServiceContext,
  projectId: string,
  reason: string,
): void {
  const key = `requirements:${ctx.workspaceId}:${projectId}`;
  const row = ctx.database.get("SELECT value FROM operational_state WHERE key=?", key);
  if (row) {
    const snapshot = JSON.parse(String(row.value)) as {
      requirements: { id: string; approval: string | null; version: number }[];
      version: number;
      fingerprint: string;
    };
    for (const requirement of snapshot.requirements) {
      const current = ctx.entities.get("Requirement", ctx.workspaceId, requirement.id);
      if (!current) continue;
      const next = { ...current, approval: null, version: Number(current.version) + 1 };
      ctx.entities.update(
        "Requirement",
        ctx.workspaceId,
        current.id,
        Number(current.version),
        next,
        { projectId },
      );
      requirement.approval = null;
      requirement.version = next.version;
    }
    snapshot.version++;
    snapshot.fingerprint = semanticHash({
      previous: snapshot.fingerprint,
      reason,
      version: snapshot.version,
    });
    ctx.database.run(
      "UPDATE operational_state SET value=? WHERE key=?",
      canonicalJson(snapshot),
      key,
    );
  }
  for (const batch of allEntities(ctx, "ProposalBatch")) {
    if (batch.projectId !== projectId || batch.state !== "proposed") continue;
    ctx.entities.update("ProposalBatch", ctx.workspaceId, batch.id, Number(batch.version), {
      ...batch,
      state: "stale",
      extensions: {
        ...((batch.extensions as Record<string, unknown>) ?? {}),
        "testmaster:invalidatedBy": reason,
      },
    });
  }
}
