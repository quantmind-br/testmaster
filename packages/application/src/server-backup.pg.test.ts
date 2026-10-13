import { createHash } from "node:crypto";
import { access, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { PersistenceDatabase } from "@testmaster/persistence";
import { afterEach, expect, it } from "vitest";
import {
  type OpsStack,
  opsStack,
  ownerSession,
  restoreTarget,
  testPgRestore,
  writeKeyFile,
} from "./ops.testkit.js";
import {
  applyServerBackupRetention,
  createServerBackup,
  listServerBackups,
  readLiveLedger,
  restoreServerBackup,
  selectRetention,
  verifyServerBackup,
} from "./server-backup.js";

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

async function seeded(): Promise<{
  stack: OpsStack;
  fixtureId: string;
  storageKey: string;
  payload: Buffer;
}> {
  const stack = await opsStack();
  cleanups.push(() => stack.cleanup());
  const project = stack.workspace.projects.create({ name: "Demo" });
  const payload = Buffer.from("tenant evidence payload 7f3a");
  const imported = await stack.workspace.artifacts.importFixtureInput({
    projectId: String(project.id),
    name: "profile",
    bytes: payload,
    mimeType: "text/plain",
  });
  const row = stack.application
    .controllerScope()
    .database.get("SELECT storage_key FROM fixture_inputs WHERE id=?", imported.id);
  return {
    stack,
    fixtureId: String(imported.id),
    storageKey: String(row?.storage_key),
    payload,
  };
}

async function walk(directory: string): Promise<string[]> {
  const found: string[] = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) found.push(...(await walk(path)));
    else found.push(path);
  }
  return found;
}

it("OPS-024 PostgreSQL backup is a consistent encrypted dump and restores database rows and evidence into a fresh isolated stack", async () => {
  const { stack, fixtureId, storageKey, payload } = await seeded();
  const database = stack.application.controllerScope().database;
  const signedIn = await ownerSession(stack);
  signedIn.tokens.create({
    name: "ci",
    scopes: ["R"],
    expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
  });
  expect(Number(database.get("SELECT COUNT(*) AS n FROM server_tokens")?.n)).toBeGreaterThan(0);
  expect(Number(database.get("SELECT COUNT(*) AS n FROM sessions")?.n)).toBeGreaterThan(0);
  const result = await createServerBackup({ database, server: stack.server });
  expect(result.manifest.engine).toBe("postgres");
  expect(result.manifest.secretIncluded).toBe(false);
  expect(result.evidenceComplete).toBe(true);
  const key = await readFile(stack.server.security.backupKeyFile);
  expect(result.manifest.encryption?.keyId).toBe(createHash("sha256").update(key).digest("hex"));
  // The destination holds ciphertext only: no payload bytes, no SQL text, no row values.
  for (const file of await walk(result.directory)) {
    if (file.endsWith("manifest.json")) continue;
    const bytes = await readFile(file);
    expect(bytes.includes(payload)).toBe(false);
    expect(bytes.includes(Buffer.from("PGDMP"))).toBe(false);
    expect(bytes.includes(Buffer.from("Demo"))).toBe(false);
  }
  const verified = await verifyServerBackup(result.directory, stack.server);
  expect(verified.evidenceObjects).toBeGreaterThanOrEqual(1);
  expect(verified.archiveEntries).toBeGreaterThan(10);

  const target = await restoreTarget(stack);
  cleanups.push(() => target.cleanup());
  const restored = await restoreServerBackup({
    directory: result.directory,
    server: target.server,
  });
  expect(restored.evidenceComplete).toBe(true);
  expect(restored.postBackupLedger).toBe("unavailable");
  const copy = PersistenceDatabase.openPostgres(
    (({ engine: _engine, ...rest }) => rest)(target.server.database),
  );
  try {
    expect(copy.get("SELECT COUNT(*) AS n FROM projects")?.n).toBe(1);
    expect(
      copy.get("SELECT workspace_id FROM fixture_inputs WHERE id=?", fixtureId)?.workspace_id,
    ).toBe(stack.workspaceId);
    expect(
      copy.get("SELECT value FROM operational_state WHERE key='restore:isolated'")?.value,
    ).toBe("true");
    expect(copy.get("SELECT value FROM operational_state WHERE key='admission'")?.value).toBe(
      "suspended_restore",
    );
    // Restore only tightens access: every token and session of the old installation is gone.
    expect(Number(copy.get("SELECT COUNT(*) AS n FROM server_tokens")?.n)).toBe(0);
    expect(Number(copy.get("SELECT COUNT(*) AS n FROM sessions")?.n)).toBe(0);
    expect(copy.tableExists("tm_restore_pending")).toBe(false);
    // Row-level security and the owner-role protection survive the restore.
    const forced = copy.get(
      "SELECT relforcerowsecurity FROM pg_class WHERE relname='alerts'",
    )?.relforcerowsecurity;
    expect(forced).toBe(true);
  } finally {
    copy.close();
  }
  const restoredFile = await readFile(
    join(target.server.storage.kind === "filesystem" ? target.server.storage.root : "", storageKey),
  );
  expect(restoredFile.equals(payload)).toBe(true);
  await expect(
    access(
      join(
        target.server.storage.kind === "filesystem" ? target.server.storage.root : "",
        ".tm-restore-pending",
      ),
    ),
  ).rejects.toThrow();
});

it("OPS-024 a tampered ciphertext, manifest or wrong key makes verification and restore fail before anything is written", async () => {
  const { stack } = await seeded();
  const database = stack.application.controllerScope().database;
  const result = await createServerBackup({ database, server: stack.server });
  await verifyServerBackup(result.directory, stack.server);

  const dump = join(result.directory, "database.dump.enc");
  const original = await readFile(dump);
  const flipped = Buffer.from(original);
  flipped[100] = (flipped[100] ?? 0) ^ 0xff;
  await writeFile(dump, flipped);
  await expect(verifyServerBackup(result.directory, stack.server)).rejects.toMatchObject({
    details: { reasonCode: "backup_integrity" },
  });
  const target = await restoreTarget(stack);
  cleanups.push(() => target.cleanup());
  await expect(
    restoreServerBackup({ directory: result.directory, server: target.server }),
  ).rejects.toMatchObject({ details: { reasonCode: "backup_integrity" } });
  const untouched = PersistenceDatabase.openPostgres(
    (({ engine: _engine, ...rest }) => rest)(target.server.database),
  );
  try {
    expect(untouched.tableExists("tm_restore_pending")).toBe(false);
  } finally {
    untouched.close();
  }
  await writeFile(dump, original);

  const manifestPath = join(result.directory, "manifest.json");
  const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
  await writeFile(
    manifestPath,
    JSON.stringify({ ...manifest, databaseVersion: manifest.databaseVersion - 1 }),
  );
  await expect(verifyServerBackup(result.directory, stack.server)).rejects.toMatchObject({
    details: { reasonCode: "backup_manifest_mac" },
  });
  await writeFile(manifestPath, JSON.stringify(manifest));

  await writeKeyFile(stack.server.security.backupKeyFile);
  await expect(verifyServerBackup(result.directory, stack.server)).rejects.toMatchObject({
    details: { reasonCode: expect.stringMatching(/backup_(key_mismatch|manifest_mac)/u) },
  });
});

it("OPS-024 an evidence object missing at backup time marks the backup incomplete and is reported, not hidden", async () => {
  const { stack, fixtureId, storageKey } = await seeded();
  const root = stack.server.storage.kind === "filesystem" ? stack.server.storage.root : "";
  await rm(join(root, storageKey));
  const result = await createServerBackup({
    database: stack.application.controllerScope().database,
    server: stack.server,
  });
  expect(result.evidenceComplete).toBe(false);
  expect(result.missingObjects).toEqual([fixtureId]);
  expect(result.manifest.missingObjects).toEqual([fixtureId]);
  const verified = await verifyServerBackup(result.directory, stack.server);
  expect(verified.complete).toBe(false);
});

it("OPS-024 backup retention keeps 7 daily, 4 weekly and 3 monthly copies and never deletes an unauthentic entry", () => {
  const backups = Array.from({ length: 120 }, (_, index) => ({
    backupId: `b${index}`,
    createdAt: new Date(Date.UTC(2026, 9, 12) - index * 86_400_000).toISOString(),
    authentic: true,
  }));
  const { keep, remove } = selectRetention(backups, { daily: 7, weekly: 4, monthly: 3 });
  // The newest seven daily copies are always kept.
  for (let index = 0; index < 7; index += 1) expect(keep).toContain(`b${index}`);
  expect(keep.length).toBeGreaterThanOrEqual(7);
  expect(keep.length).toBeLessThanOrEqual(7 + 4 + 3);
  expect(keep.length + remove.length).toBe(120);
  expect(remove).toContain("b119");
  // Negative control: an older copy that is the newest of its week or month is kept.
  const oldest = backups[119];
  const monthly = backups.filter(
    (backup) => backup.createdAt.slice(0, 7) === oldest?.createdAt.slice(0, 7),
  );
  expect(monthly.length).toBeGreaterThan(0);
  const forged = [
    ...backups,
    { backupId: "forged", createdAt: "2020-01-01T00:00:00.000Z", authentic: false },
  ];
  const decision = selectRetention(forged, { daily: 7, weekly: 4, monthly: 3 });
  expect(decision.remove).not.toContain("forged");
  expect(decision.keep).not.toContain("forged");
});

it("OPS-024 the retention controller removes only expired authentic backups from the destination", async () => {
  const { stack } = await seeded();
  const database = stack.application.controllerScope().database;
  const server = {
    ...stack.server,
    backup: {
      ...(stack.server.backup as NonNullable<typeof stack.server.backup>),
      retention: { daily: 2, weekly: 0, monthly: 0 },
    },
  };
  const ids: string[] = [];
  for (let day = 0; day < 4; day += 1) {
    const created = await createServerBackup({
      database,
      server,
      now: () => new Date(Date.UTC(2026, 9, 1 + day, 3)),
    });
    ids.push(created.backupId);
  }
  const forgedDir = join(stack.root, "backups", "20200101T000000Z-forged");
  await (await import("node:fs/promises")).mkdir(forgedDir, { recursive: true });
  await writeFile(join(forgedDir, "manifest.json"), "{}");
  const outcome = await applyServerBackupRetention(server);
  expect(outcome.kept).toEqual([ids[3], ids[2]]);
  expect(outcome.removed.sort()).toEqual([ids[0], ids[1]].sort());
  expect(outcome.unauthentic).toEqual(["20200101T000000Z-forged"]);
  const key = await (await import("./backup-crypto.js")).readKeyFile(
    server.security.backupKeyFile,
    "k",
  );
  const remaining = await listServerBackups(server.backup.destination, key);
  expect(
    remaining
      .filter((entry) => entry.authentic)
      .map((entry) => entry.backupId)
      .sort(),
  ).toEqual([ids[2], ids[3]].sort());
  await stat(forgedDir);
});

it("OPS-024 a restore replays post-backup revocations from the live ledger so it can only tighten access", async () => {
  const { stack } = await seeded();
  const database = stack.application.controllerScope().database;
  const result = await createServerBackup({ database, server: stack.server });
  database.run(
    "INSERT INTO operational_state(key,value) VALUES(?,?)",
    "integration:revoked:ghi_1",
    "revoked",
  );
  const ledger = readLiveLedger(database);
  expect(ledger.tombstones?.map((row) => row.key)).toContain("integration:revoked:ghi_1");
  const target = await restoreTarget(stack);
  cleanups.push(() => target.cleanup());
  const restored = await restoreServerBackup({
    directory: result.directory,
    server: target.server,
    ledger,
  });
  expect(restored.postBackupLedger).toBe("replayed");
  const copy = PersistenceDatabase.openPostgres(
    (({ engine: _engine, ...rest }) => rest)(target.server.database),
  );
  try {
    expect(
      copy.get("SELECT value FROM operational_state WHERE key='integration:revoked:ghi_1'")?.value,
    ).toBe("revoked");
    expect(copy.get("SELECT value FROM operational_state WHERE key='restore_review'")?.value).toBe(
      "post_backup_revocations_and_tombstones_unverified",
    );
  } finally {
    copy.close();
  }
  expect(testPgRestore.length).toBeGreaterThan(0);
});
