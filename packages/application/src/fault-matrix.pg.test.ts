import { createHash } from "node:crypto";
import { access, readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { publishFaultPoints } from "@testmaster/evidence";
import { PersistenceDatabase } from "@testmaster/persistence";
import { afterEach, expect, it } from "vitest";
import { readKeyFile } from "./backup-crypto.js";
import { type OpsStack, opsStack, restoreTarget, seedRun } from "./ops.testkit.js";
import { purgePoints } from "./retention-purge.js";
import {
  applyServerBackupRetention,
  backupFaultPoints,
  createServerBackup,
  listServerBackups,
  restoreFaultPoints,
  restoreServerBackup,
  retentionFaultPoints,
  verifyServerBackup,
} from "./server-backup.js";

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

class Crash extends Error {}
const crashAt =
  (target: string) =>
  (point: string): void => {
    if (point === target) throw new Crash(`crash at ${point}`);
  };
const sourceText = (name: string): Promise<string> =>
  readFile(new URL(`./${name}`, import.meta.url), "utf8");
const db = (stack: OpsStack) => stack.application.controllerScope().database;
const num = (stack: OpsStack, sql: string, ...values: unknown[]): number =>
  Number(db(stack).get<{ n: number }>(sql, ...values)?.n);
const now = new Date("2026-10-20T12:00:00.000Z");
const old = "2026-06-01T00:00:00.000Z";

async function freshStack(): Promise<OpsStack> {
  const stack = await opsStack();
  cleanups.push(() => stack.cleanup());
  return stack;
}
async function withFixture(): Promise<{ stack: OpsStack; payload: Buffer }> {
  const stack = await freshStack();
  const project = stack.workspace.projects.create({ name: "Demo" });
  const payload = Buffer.from("fault matrix evidence 5c1e");
  await stack.workspace.artifacts.importFixtureInput({
    projectId: String(project.id),
    name: "profile",
    bytes: payload,
    mimeType: "text/plain",
  });
  return { stack, payload };
}
const listing = async (stack: OpsStack) =>
  listServerBackups(
    stack.server.backup?.destination ?? "",
    await readKeyFile(stack.server.security.backupKeyFile, "backup key"),
  );
function insertOldAudit(stack: OpsStack, count: number): void {
  for (let index = 0; index < count; index++)
    db(stack).run(
      "INSERT INTO audit_events(workspace_id,id,created_at,actor,action,resource_id,request_id,timestamp) VALUES(?,?,?,?,?,?,?,?)",
      stack.workspaceId,
      `aud_old_${index}`,
      "2025-01-01T00:00:00.000Z",
      "usr_seed",
      "seed.event",
      "res_seed",
      "req_seed",
      "2025-01-01T00:00:00.000Z",
    );
}

it("VAL-045 the fault matrix names every write boundary of retention, backup, restore and evidence publication found in the implementation", async () => {
  const names = new Set<string>();
  // Every file that declares a fault point. The S3-only boundaries (restore.marker_written,
  // retention.object_deleted, publish.*) are crashed by fault-matrix-s3.docker.test.ts.
  for (const file of [
    "retention-purge.ts",
    "server-backup.ts",
    "server-backup-media.ts",
    "../../evidence/src/bundle.ts",
  ])
    for (const match of (await sourceText(file)).matchAll(
      /(?:fault|hook|faultHook\?\.)\("([a-z_]+\.[a-z_]+)"\)/g,
    ))
      names.add(String(match[1]));
  expect([...names].sort()).toEqual(
    [
      ...purgePoints,
      ...backupFaultPoints,
      ...restoreFaultPoints,
      ...retentionFaultPoints,
      ...publishFaultPoints,
    ].sort(),
  );
});

const purgeExpectations: Record<
  (typeof purgePoints)[number],
  { runs: number; oldAudit: number; summaries: number }
> = {
  "purge.run_deleted": { runs: 2, oldAudit: 3, summaries: 0 },
  "purge.runs_committed": { runs: 0, oldAudit: 3, summaries: 0 },
  "purge.audit_summarized": { runs: 0, oldAudit: 3, summaries: 0 },
  "purge.audit_deleted": { runs: 0, oldAudit: 3, summaries: 0 },
  "purge.audit_committed": { runs: 0, oldAudit: 0, summaries: 1 },
};

async function purgeCrash(point: (typeof purgePoints)[number]): Promise<void> {
  const stack = await freshStack();
  const expired = [
    seedRun(stack, { createdAt: old, endedAt: old, outcome: "passed" }),
    seedRun(stack, { createdAt: old, endedAt: old, outcome: "failed" }),
  ];
  const kept = seedRun(stack, {
    createdAt: "2026-10-15T00:00:00.000Z",
    endedAt: "2026-10-15T00:00:00.000Z",
    outcome: "passed",
  });
  insertOldAudit(stack, 3);
  const state = () => ({
    runs: num(
      stack,
      "SELECT COUNT(*) AS n FROM runs WHERE workspace_id=? AND id IN (?,?)",
      stack.workspaceId,
      expired[0]?.runId,
      expired[1]?.runId,
    ),
    oldAudit: num(
      stack,
      "SELECT COUNT(*) AS n FROM audit_events WHERE workspace_id=? AND timestamp<'2025-06-01'",
      stack.workspaceId,
    ),
    summaries: num(
      stack,
      "SELECT COUNT(*) AS n FROM audit_purge_summaries WHERE workspace_id=?",
      stack.workspaceId,
    ),
    permits: num(
      stack,
      "SELECT COUNT(*) AS n FROM operational_state WHERE key LIKE 'retention:purge-permit:%'",
    ),
  });
  expect(state()).toEqual({ runs: 2, oldAudit: 3, summaries: 0, permits: 0 });

  await expect(
    stack.workspace.retentionPurge.run({ now, faultHook: crashAt(point) }),
  ).rejects.toBeInstanceOf(Crash);
  expect(state()).toEqual({ ...purgeExpectations[point], permits: 0 });
  expect(
    num(
      stack,
      "SELECT COUNT(*) AS n FROM runs WHERE workspace_id=? AND id=?",
      stack.workspaceId,
      kept.runId,
    ),
  ).toBe(1);
  // The delete guards are armed again: no permit survives the crash.
  expect(() =>
    db(stack).run("DELETE FROM audit_events WHERE workspace_id=?", stack.workspaceId),
  ).toThrow();

  await stack.workspace.retentionPurge.run({ now });
  expect(state()).toEqual({ runs: 0, oldAudit: 0, summaries: 1, permits: 0 });
  expect(await stack.workspace.retentionPurge.verifySummaries()).toMatchObject({
    valid: true,
    summaries: 1,
  });
  expect(
    num(
      stack,
      "SELECT COUNT(*) AS n FROM runs WHERE workspace_id=? AND id=?",
      stack.workspaceId,
      kept.runId,
    ),
  ).toBe(1);
}

async function backupCrash(point: (typeof backupFaultPoints)[number]): Promise<void> {
  const { stack } = await withFixture();
  const database = db(stack);
  const destination = stack.server.backup?.destination ?? "";
  const projects = num(stack, "SELECT COUNT(*) AS n FROM projects");
  await expect(
    createServerBackup({ database, server: stack.server, faultHook: crashAt(point) }),
  ).rejects.toBeInstanceOf(Crash);
  const entries = await listing(stack);
  const promoted = entries.filter((entry) => entry.authentic);
  if (point === "backup.renamed") {
    // The directory was already renamed: it is complete and must verify.
    expect(promoted).toHaveLength(1);
    await verifyServerBackup(promoted[0]?.directory ?? "", stack.server);
  } else {
    expect(entries).toEqual([]);
    expect((await readdir(destination)).filter((name) => name.startsWith(".partial-"))).toEqual([]);
  }
  expect(
    database.get("SELECT value FROM operational_state WHERE key='backup:last-success'"),
  ).toBeUndefined();
  expect(
    database.get("SELECT value FROM operational_state WHERE key='backup:last-failure'")?.value,
  ).toBeTruthy();
  expect(num(stack, "SELECT COUNT(*) AS n FROM projects")).toBe(projects);

  const retry = await createServerBackup({ database, server: stack.server });
  await verifyServerBackup(retry.directory, stack.server);
  expect(
    database.get("SELECT value FROM operational_state WHERE key='backup:last-success'")?.value,
  ).toContain(retry.backupId);
}

it("VAL-045 a crash while removing an expired backup leaves every backup authentic and the next pass finishes", async () => {
  const { stack } = await withFixture();
  const server = {
    ...stack.server,
    backup: {
      ...(stack.server.backup as NonNullable<typeof stack.server.backup>),
      retention: { daily: 1, weekly: 0, monthly: 0 },
    },
  };
  const database = db(stack);
  const first = await createServerBackup({
    database,
    server,
    now: () => new Date(Date.UTC(2026, 9, 1, 3)),
  });
  const second = await createServerBackup({
    database,
    server,
    now: () => new Date(Date.UTC(2026, 9, 2, 3)),
  });
  await expect(
    applyServerBackupRetention(server, { faultHook: crashAt("retention.remove") }),
  ).rejects.toBeInstanceOf(Crash);
  expect(
    (await listing(stack))
      .filter((entry) => entry.authentic)
      .map((entry) => entry.backupId)
      .sort(),
  ).toEqual([first.backupId, second.backupId].sort());
  await verifyServerBackup(first.directory, server);
  const outcome = await applyServerBackupRetention(server);
  expect(outcome.removed).toEqual([first.backupId]);
  expect(
    (await listing(stack)).filter((entry) => entry.authentic).map((entry) => entry.backupId),
  ).toEqual([second.backupId]);
});

async function restoredDigest(
  server: OpsStack["server"],
): Promise<{ tables: Record<string, number>; isolated: string | undefined; files: string[] }> {
  const copy = PersistenceDatabase.openPostgres(
    (({ engine: _engine, ...rest }) => rest)(server.database),
  );
  try {
    const tables: Record<string, number> = {};
    for (const table of [
      "workspaces",
      "projects",
      "fixture_inputs",
      "memberships",
      "principals",
      "audit_events",
    ])
      tables[table] = Number(copy.get<{ n: number }>(`SELECT COUNT(*) AS n FROM ${table}`)?.n);
    return {
      tables,
      isolated: copy.get<{ value: string }>(
        "SELECT value FROM operational_state WHERE key='restore:isolated'",
      )?.value,
      files: await evidenceFiles(server),
    };
  } finally {
    copy.close();
  }
}
async function evidenceFiles(server: OpsStack["server"]): Promise<string[]> {
  const root = server.storage.kind === "filesystem" ? server.storage.root : "";
  const found: string[] = [];
  const walk = async (directory: string): Promise<void> => {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) await walk(path);
      else if (entry.name !== ".tm-restore-pending")
        found.push(
          `${path.slice(root.length)}:${createHash("sha256")
            .update(await readFile(path))
            .digest("hex")}`,
        );
    }
  };
  await walk(root).catch(() => undefined);
  return found.sort();
}

async function restoreCrash(point: (typeof restoreFaultPoints)[number]): Promise<void> {
  const { stack } = await withFixture();
  const backup = await createServerBackup({ database: db(stack), server: stack.server });
  const reference = await restoreTarget(stack);
  cleanups.push(() => reference.cleanup());
  await restoreServerBackup({ directory: backup.directory, server: reference.server });
  const expected = await restoredDigest(reference.server);
  expect(expected.tables.projects).toBe(1);
  expect(expected.files.length).toBeGreaterThan(0);

  const target = await restoreTarget(stack);
  cleanups.push(() => target.cleanup());
  await expect(
    restoreServerBackup({
      directory: backup.directory,
      server: target.server,
      faultHook: crashAt(point),
    }),
  ).rejects.toBeInstanceOf(Crash);
  // The backup is untouched and the source database is still the original.
  await verifyServerBackup(backup.directory, stack.server);
  expect(num(stack, "SELECT COUNT(*) AS n FROM projects")).toBe(1);

  const config = (({ engine: _engine, ...rest }) => rest)(target.server.database);
  if (point === "restore.verified") {
    // Nothing was written: the target is still empty and a restore may proceed.
    const empty = PersistenceDatabase.openPostgres(config, { restore: true });
    try {
      expect(
        empty.all("SELECT tablename FROM pg_tables WHERE schemaname=current_schema()"),
      ).toEqual([]);
    } finally {
      empty.close();
    }
  } else if (point === "restore.finalized" || point === "restore.marker_cleared") {
    // Complete: the database opens and a second restore refuses to overwrite it. Only a crash
    // before the marker is removed leaves the evidence marker behind.
    expect(await restoredDigest(target.server)).toMatchObject({
      tables: expected.tables,
      isolated: "true",
    });
    await expect(
      restoreServerBackup({ directory: backup.directory, server: target.server }),
    ).rejects.toMatchObject({ details: { reasonCode: "restore_target_not_empty" } });
    const marker = access(
      join(
        target.server.storage.kind === "filesystem" ? target.server.storage.root : "",
        ".tm-restore-pending",
      ),
    );
    if (point === "restore.finalized") await marker;
    else await expect(marker).rejects.toThrow();
    return;
  } else {
    expect(() => PersistenceDatabase.openPostgres(config)).toThrowError(
      expect.objectContaining({
        details: expect.objectContaining({ reasonCode: "restore_incomplete" }),
      }),
    );
  }

  const rerun = await restoreServerBackup({ directory: backup.directory, server: target.server });
  expect(rerun.wipedInterruptedRestore).toBe(point !== "restore.verified");
  expect(await restoredDigest(target.server)).toEqual(expected);
  await expect(
    access(
      join(
        target.server.storage.kind === "filesystem" ? target.server.storage.root : "",
        ".tm-restore-pending",
      ),
    ),
  ).rejects.toThrow();
}

it("VAL-045 a crash at purge.run_deleted leaves retention consistent, never half purged, and a rerun converges", () =>
  purgeCrash("purge.run_deleted"));
it("VAL-045 a crash at purge.runs_committed leaves retention consistent, never half purged, and a rerun converges", () =>
  purgeCrash("purge.runs_committed"));
it("VAL-045 a crash at purge.audit_summarized leaves retention consistent, never half purged, and a rerun converges", () =>
  purgeCrash("purge.audit_summarized"));
it("VAL-045 a crash at purge.audit_deleted leaves retention consistent, never half purged, and a rerun converges", () =>
  purgeCrash("purge.audit_deleted"));
it("VAL-045 a crash at purge.audit_committed leaves retention consistent, never half purged, and a rerun converges", () =>
  purgeCrash("purge.audit_committed"));

it("VAL-045 a crash at backup.holds never promotes a partial backup and the next backup verifies", () =>
  backupCrash("backup.holds"));
it("VAL-045 a crash at backup.dump never promotes a partial backup and the next backup verifies", () =>
  backupCrash("backup.dump"));
it("VAL-045 a crash at backup.evidence never promotes a partial backup and the next backup verifies", () =>
  backupCrash("backup.evidence"));
it("VAL-045 a crash at backup.index never promotes a partial backup and the next backup verifies", () =>
  backupCrash("backup.index"));
it("VAL-045 a crash at backup.manifest never promotes a partial backup and the next backup verifies", () =>
  backupCrash("backup.manifest"));
it("VAL-045 a crash at backup.renamed never promotes a partial backup and the next backup verifies", () =>
  backupCrash("backup.renamed"));

it("VAL-045 a crash at restore.verified keeps the backup recoverable, refuses a half-restored database and a rerun equals an uninterrupted restore", () =>
  restoreCrash("restore.verified"));
it("VAL-045 a crash at restore.target_prepared keeps the backup recoverable, refuses a half-restored database and a rerun equals an uninterrupted restore", () =>
  restoreCrash("restore.target_prepared"));
it("VAL-045 a crash at restore.evidence_restored keeps the backup recoverable, refuses a half-restored database and a rerun equals an uninterrupted restore", () =>
  restoreCrash("restore.evidence_restored"));
it("VAL-045 a crash at restore.database_restored keeps the backup recoverable, refuses a half-restored database and a rerun equals an uninterrupted restore", () =>
  restoreCrash("restore.database_restored"));
it("VAL-045 a crash at restore.migrated keeps the backup recoverable, refuses a half-restored database and a rerun equals an uninterrupted restore", () =>
  restoreCrash("restore.migrated"));
it("VAL-045 a crash at restore.finalizing keeps the backup recoverable, refuses a half-restored database and a rerun equals an uninterrupted restore", () =>
  restoreCrash("restore.finalizing"));
it("VAL-045 a crash at restore.finalized keeps the backup recoverable, refuses a half-restored database and a rerun equals an uninterrupted restore", () =>
  restoreCrash("restore.finalized"));
it("VAL-045 a crash at restore.marker_cleared leaves a complete restore that a second restore refuses to overwrite", () =>
  restoreCrash("restore.marker_cleared"));
it("VAL-045 a crash at restore.evidence_object keeps the backup recoverable, refuses a half-restored database and a rerun equals an uninterrupted restore", () =>
  restoreCrash("restore.evidence_object"));
it("VAL-045 a crash at backup.evidence_object never promotes a partial backup and the next backup verifies", () =>
  backupCrash("backup.evidence_object"));
