import { canonicalJson } from "@testmaster/domain";
import type { ServiceContext } from "../context.js";

/**
 * Append-only (bounded) record of how a project's requirements were interpreted. The audit table
 * keeps only hashes, so a reviewer could not otherwise see what a normalization changed.
 */
export type RequirementLogKind =
  | "requirement_added"
  | "requirement_removed"
  | "interpretation_changed"
  | "edited"
  | "approved"
  | "approval_reset"
  | "rejected"
  | "conflict_decided"
  | "normalized";
export interface RequirementLogEntry {
  at: string;
  kind: RequirementLogKind;
  actorId: string;
  requirementId: string | null;
  requirementKey: string | null;
  before: string | null;
  after: string | null;
  note: string | null;
  sourceRevisionIds: string[];
}
export type RequirementLogInput = Partial<RequirementLogEntry> & Pick<RequirementLogEntry, "kind">;
const MAX_ENTRIES = 500;
const MAX_TEXT = 2000;
const MAX_NOTE = 500;

export function readRequirementLog(ctx: ServiceContext, projectId: string): RequirementLogEntry[] {
  const row = ctx.database.get(
    "SELECT value FROM operational_state WHERE key=?",
    `requirements-log:${ctx.workspaceId}:${projectId}`,
  );
  return row ? (JSON.parse(String(row.value)) as RequirementLogEntry[]) : [];
}

export function appendRequirementLog(
  ctx: ServiceContext,
  projectId: string,
  entries: readonly RequirementLogInput[],
): void {
  if (!entries.length) return;
  const at = new Date().toISOString();
  const next = [
    ...readRequirementLog(ctx, projectId),
    ...entries.map(
      (entry): RequirementLogEntry => ({
        at,
        kind: entry.kind,
        actorId: entry.actorId ?? ctx.principalId,
        requirementId: entry.requirementId ?? null,
        requirementKey: entry.requirementKey ?? null,
        before: entry.before?.slice(0, MAX_TEXT) ?? null,
        after: entry.after?.slice(0, MAX_TEXT) ?? null,
        note: entry.note?.slice(0, MAX_NOTE) ?? null,
        sourceRevisionIds: [...(entry.sourceRevisionIds ?? [])].slice(0, 50),
      }),
    ),
  ].slice(-MAX_ENTRIES);
  ctx.database.run(
    "INSERT INTO operational_state(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value",
    `requirements-log:${ctx.workspaceId}:${projectId}`,
    canonicalJson(next),
  );
}

/** The text a reviewer reads: statement plus acceptance criteria, so a criteria-only change shows. */
export function describeRequirement(value: {
  text: string;
  acceptanceCriteria: readonly string[];
}): string {
  return [value.text, ...value.acceptanceCriteria.map((item) => `- ${item}`)].join("\n");
}

/** Distinct source revisions an evidence list points at (refs without one are skipped). */
export function revisionIdsOf(refs: readonly { sourceRevisionId?: string }[]): string[] {
  return [...new Set(refs.flatMap((ref) => (ref.sourceRevisionId ? [ref.sourceRevisionId] : [])))];
}
