import { readFile } from "node:fs/promises";

/**
 * Validator for the disaster-recovery rehearsal record (`validation/results/m4-dr-rehearsal.json`).
 * It re-derives the verdict from the raw rows (comparison, hash table, access and isolation checks,
 * step exit codes) instead of trusting the record's own `passed`, so a hand-edited or partial
 * record is reported rather than accepted.
 */

type Json = Record<string, unknown>;

const requiredPreserved = [
  "schemaVersion",
  "workspaceIds",
  "principals",
  "memberships(principal,role)",
  "projectIds",
  "fixtureInputs(id,hash,bytes)",
  "evidenceFiles(path->sha256)",
  "auditEvents.count",
  "auditEvents.digest",
] as const;
const requiredTightened = [
  "restore:isolated",
  "admission",
  "restore_review",
  "integrations.allPaused",
  "server_tokens.cleared",
  "sessions.cleared",
  "tm_restore_pending.absent",
] as const;

export async function loadDrRehearsal(path: string): Promise<Json> {
  return JSON.parse(await readFile(path, "utf8")) as Json;
}

function list(value: unknown): Json[] {
  return Array.isArray(value) ? (value as Json[]) : [];
}
function object(value: unknown): Json {
  return value && typeof value === "object" ? (value as Json) : {};
}
function positive(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value > 0;
}

export function findDrRehearsalViolations(evidence: Json): string[] {
  const violations: string[] = [];
  if (evidence.name !== "m4-dr-rehearsal") violations.push("record is not an m4-dr-rehearsal");
  const steps = list(evidence.steps);
  if (steps.length === 0) violations.push("no steps were recorded");
  for (const step of steps)
    if (step.exitCode !== 0) violations.push(`step ${String(step.name)} exited ${step.exitCode}`);

  const rows = list(object(evidence.comparison).rows);
  const byName = new Map(rows.map((row) => [String(row.name), row]));
  for (const row of rows)
    if (row.equal !== true) violations.push(`comparison row ${String(row.name)} differs`);
  for (const name of requiredPreserved)
    if (byName.get(name)?.kind !== "preserved")
      violations.push(`comparison is missing preserved row ${name}`);
  for (const name of requiredTightened)
    if (byName.get(name)?.kind !== "tightened")
      violations.push(`comparison is missing tightened row ${name}`);
  if (byName.get("postBackupWriteAbsent")?.kind !== "rpo")
    violations.push("comparison does not prove the post-backup write is gone");
  if (!rows.some((row) => String(row.name).startsWith("rowCount.")))
    violations.push("comparison has no row counts");

  const hashes = object(evidence.hashTable);
  const files = list(hashes.evidenceFiles);
  if (files.length === 0) violations.push("hash table lists no evidence file");
  for (const file of files)
    if (file.equal !== true || file.source !== file.restored)
      violations.push(`evidence file ${String(file.path)} hash differs after restore`);
  for (const input of list(hashes.fixtureInputs))
    if (
      input.equal !== true ||
      input.originalSha256 !== input.restoredEvidenceFileSha256 ||
      input.sourceContentHash !== input.restoredContentHash
    )
      violations.push(`fixture input ${String(input.id)} hash differs after restore`);

  for (const section of ["access", "isolation"] as const) {
    const checks = list(object(evidence[section]).checks);
    if (checks.length === 0) violations.push(`${section} recorded no check`);
    for (const check of checks)
      if (check.ok !== true) violations.push(`${section} check failed: ${String(check.name)}`);
  }

  if (!positive(evidence.rpoSeconds)) violations.push("RPO was not measured");
  if (!positive(evidence.rtoSeconds)) violations.push("RTO was not measured");
  const breakdown = Object.values(object(evidence.rtoBreakdownSeconds)).filter(
    (value): value is number => typeof value === "number",
  );
  if (
    positive(evidence.rtoSeconds) &&
    Math.abs(breakdown.reduce((sum, value) => sum + value, 0) - evidence.rtoSeconds) > 0.5
  )
    violations.push("RTO breakdown does not add up to the RTO");

  const s3 = object(evidence.s3Loss);
  if (s3.status !== "deferred" || s3.milestone !== "M5")
    violations.push("S3 loss must stay deferred to M5, not claimed");
  if (typeof object(evidence.tools).sourceCommit !== "string")
    violations.push("record does not name the source commit it exercised");
  if (evidence.passed !== (violations.length === 0))
    violations.push("the record's own verdict disagrees with its rows");
  return violations;
}
