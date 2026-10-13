import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadMigrations, PersistenceDatabase } from "@testmaster/persistence";
import { postgresParity } from "@testmaster/persistence/testing";
import { afterEach, expect, it, vi } from "vitest";
import { Application } from "./application.js";
import { assessRelease, revokedImageIds, revokeImage, upgradeLocalProfile } from "./release.js";

const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});
const imageA = `sha256:${"a".repeat(64)}`;
const imageB = `sha256:${"b".repeat(64)}`;
async function lockFile(root: string, imageId: string): Promise<string> {
  const path = join(root, `lock-${imageId.slice(7, 9)}.json`);
  await writeFile(path, JSON.stringify({ "testmaster-runner": { imageId } }));
  return path;
}

it("revokes image IDs durably and idempotently and validates input", async () => {
  const database = PersistenceDatabase.memory();
  await database.migrate();
  expect(() => revokeImage(database, "latest", "cve")).toThrow(/sha256/);
  expect(() => revokeImage(database, imageA, "  ")).toThrow(/reason/);
  expect(revokeImage(database, imageA, "CVE-2026-0001")).toMatchObject({ alreadyRevoked: false });
  const again = revokeImage(database, imageA, "other reason");
  expect(again).toMatchObject({ alreadyRevoked: true, reason: "CVE-2026-0001" });
  expect([...revokedImageIds(database)]).toEqual([imageA]);
  database.close();
});

// Not run on PostgreSQL: Backup, restore and upgrade of the SQLite data directory; PostgreSQL uses pg_dump (M4-02).
it.skipIf(postgresParity)(
  "refuses a release that pins a revoked image and allows one that does not",
  async () => {
    const root = await mkdtemp(join(tmpdir(), "tm-release-"));
    roots.push(root);
    const dataDir = join(root, "data");
    const database = await PersistenceDatabase.open(join(dataDir, "testmaster.db"));
    revokeImage(database, imageA, "withdrawn runner build");
    database.close();
    const revokedLock = await assessRelease({
      dataDir,
      imageLockPath: await lockFile(root, imageA),
    });
    expect(revokedLock.allowed).toBe(false);
    expect(revokedLock.blockers.join(" ")).toContain(`${imageA}) is revoked`);
    expect(
      (await assessRelease({ dataDir, imageLockPath: await lockFile(root, imageB) })).allowed,
    ).toBe(true);
    // The ordered upgrade shares the same refusal and runs nothing.
    await expect(
      upgradeLocalProfile({
        dataDir,
        imageLockPath: await lockFile(root, imageA),
        backupDir: join(root, "backup"),
      }),
    ).rejects.toMatchObject({ code: "PRECONDITION_FAILED" });
  },
);

// Not run on PostgreSQL: Backup, restore and upgrade of the SQLite data directory; PostgreSQL uses pg_dump (M4-02).
it.skipIf(postgresParity)(
  "carries image revocations into a restored data directory and keeps the restore suspended",
  async () => {
    const cwd = await mkdtemp(join(tmpdir(), "tm-revoke-restore-"));
    roots.push(cwd);
    const app = await Application.open({ cwd, home: join(cwd, "home") });
    try {
      await app.init();
      const backup = join(cwd, "pre-revocation-backup");
      await app.backups.create(backup);
      expect(app.revokedImages()).toEqual([]);
      expect(app.revokeImage(imageA, "withdrawn after the backup")).toMatchObject({
        alreadyRevoked: false,
      });
      expect(
        app.database.get("SELECT 1 AS ok FROM audit_events WHERE action='image.revoke.allowed'"),
      ).toBeDefined();
      const restored = join(cwd, "restored");
      await app.backups.restore(backup, restored);
      const database = await PersistenceDatabase.open(join(restored, "testmaster.db"), {
        migrate: false,
      });
      try {
        // Rolling back to the older data cannot reopen a revoked image or admission.
        expect([...revokedImageIds(database)]).toEqual([imageA]);
        expect(
          database.get("SELECT value FROM operational_state WHERE key='admission'")?.value,
        ).toBe("suspended_restore");
      } finally {
        database.close();
      }
    } finally {
      app.close();
    }
  },
);

// Not run on PostgreSQL: Backup, restore and upgrade of the SQLite data directory; PostgreSQL uses pg_dump (M4-02).
it.skipIf(postgresParity)(
  "declares an unverifiable post-backup ledger and keeps the restore suspended",
  async () => {
    const cwd = await mkdtemp(join(tmpdir(), "tm-ledger-lost-"));
    roots.push(cwd);
    const app = await Application.open({ cwd, home: join(cwd, "home") });
    try {
      await app.init();
      const backup = join(cwd, "backup");
      await app.backups.create(backup);
      const original = app.database.all.bind(app.database);
      const unreadable = vi
        .spyOn(app.database, "all")
        .mockImplementation((sql: string, ...args: unknown[]) => {
          if (sql.includes("FROM secret_references"))
            throw new Error("post-backup ledger unreadable");
          return original(sql, ...args);
        });
      const restoredDir = join(cwd, "restored");
      const result = await app.backups.restore(backup, restoredDir);
      unreadable.mockRestore();
      expect(result).toMatchObject({
        postBackupLedger: "unavailable",
        exclusionsGuaranteed: false,
        requiresOperatorReview: true,
      });
      const database = await PersistenceDatabase.open(join(restoredDir, "testmaster.db"), {
        migrate: false,
      });
      try {
        expect(
          database.get("SELECT value FROM operational_state WHERE key='restore_review'")?.value,
        ).toBe("post_backup_ledger_unavailable");
        expect(
          database.get("SELECT value FROM operational_state WHERE key='admission'")?.value,
        ).toBe("suspended_restore");
      } finally {
        database.close();
      }
      // Operator review refuses to open the restore until the loss is explicitly accepted.
      const restoredApp = await Application.open({
        cwd,
        home: app.config.home,
        env: { TESTMASTER_DATA_DIR: restoredDir },
      });
      try {
        expect(restoredApp.backups.review()).toMatchObject({ postBackupLedger: "unavailable" });
        expect(() =>
          restoredApp.backups.review({ apply: true, revocationsConfirmed: true }),
        ).toThrow(/ledger is unavailable/);
        expect(
          restoredApp.database.get("SELECT value FROM operational_state WHERE key='admission'")
            ?.value,
        ).toBe("suspended_restore");
        expect(
          restoredApp.backups.review({
            apply: true,
            revocationsConfirmed: true,
            ledgerLossAccepted: true,
          }),
        ).toMatchObject({ dryRun: false, admission: "enabled" });
      } finally {
        restoredApp.close();
      }
    } finally {
      app.close();
    }
  },
);

// Not run on PostgreSQL: Backup, restore and upgrade of the SQLite data directory; PostgreSQL uses pg_dump (M4-02).
it.skipIf(postgresParity)(
  "carries consent revocations made after the backup into the restored directory",
  async () => {
    const cwd = await mkdtemp(join(tmpdir(), "tm-consent-restore-"));
    roots.push(cwd);
    const app = await Application.open({ cwd, home: join(cwd, "home") });
    try {
      const { projectId, workspaceId } = await app.init();
      const consentId = "consent-restore-probe";
      app.database.run(
        "INSERT INTO consents(workspace_id,id,created_at,project_id,provider_id,data_classes_json,granted_at) VALUES(?,?,?,?,?,?,?)",
        workspaceId,
        consentId,
        new Date().toISOString(),
        projectId,
        "fake",
        '["documents"]',
        new Date().toISOString(),
      );
      const backup = join(cwd, "backup");
      await app.backups.create(backup);
      app.database.run(
        "UPDATE consents SET revoked_at=? WHERE id=?",
        new Date().toISOString(),
        consentId,
      );
      const restored = join(cwd, "restored");
      expect(await app.backups.restore(backup, restored)).toMatchObject({
        postBackupLedger: "replayed",
        exclusionsGuaranteed: true,
      });
      const database = await PersistenceDatabase.open(join(restored, "testmaster.db"), {
        migrate: false,
      });
      try {
        expect(
          database.get("SELECT revoked_at FROM consents WHERE id=?", consentId)?.revoked_at,
        ).not.toBeNull();
      } finally {
        database.close();
      }
    } finally {
      app.close();
    }
  },
);

// Not run on PostgreSQL: Backup, restore and upgrade of the SQLite data directory; PostgreSQL uses pg_dump (M4-02).
it.skipIf(postgresParity)(
  "resumes with the new release on the upgraded data directory with the same identities",
  async () => {
    const cwd = await mkdtemp(join(tmpdir(), "tm-resume-"));
    roots.push(cwd);
    const first = await Application.open({ cwd, home: join(cwd, "home") });
    const initialized = await first.init();
    const dataDir = first.config.dataDir;
    first.close();

    // Re-create the previous release's state: the application rows are real, migrations 10 and later are undone.
    const old = await PersistenceDatabase.open(join(dataDir, "testmaster.db"), { migrate: false });
    old.exec(
      "DROP TABLE refinement_turns; DROP TABLE test_drafts; DROP TABLE inbound_webhook_deliveries; DROP TABLE integrations; DROP TABLE sessions; DROP TABLE password_credentials; DELETE FROM schema_migrations WHERE version>=10",
    );
    old.run(
      "INSERT INTO workers(workspace_id,id,created_at,state,last_heartbeat_at) VALUES(?, 'wrk_previous',?, 'ready',?)",
      initialized.workspaceId,
      new Date().toISOString(),
      new Date(Date.now() - 3_600_000).toISOString(),
    );
    const before = old.all("SELECT id,created_at,data_json FROM projects ORDER BY id");
    expect(old.status().currentVersion).toBe(9);
    old.close();

    const { receipt } = await upgradeLocalProfile({
      dataDir,
      backupDir: join(cwd, "before-upgrade"),
      drainTimeoutMs: 0,
    });
    expect(receipt).toMatchObject({ upgraded: true, fromVersion: 9, irreversible: true });

    const resumed = await Application.open({ cwd, home: join(cwd, "home") });
    try {
      expect(resumed.database.status()).toMatchObject({
        currentVersion: (await loadMigrations()).length,
        pending: [],
      });
      expect(
        resumed.database.all("SELECT id,created_at,data_json FROM projects ORDER BY id"),
      ).toEqual(before);
      expect((await resumed.projects.list()).map((project) => project.id)).toContain(
        initialized.projectId,
      );
      expect(
        resumed.database.get("SELECT value FROM operational_state WHERE key='admission'")?.value,
      ).toBe("enabled");
      // The previous worker is drained and offline; a restart registers a new one rather than reviving it.
      expect(resumed.database.get("SELECT state FROM workers WHERE id='wrk_previous'")?.state).toBe(
        "draining",
      );
      expect(resumed.worker.live()).toBe(false);
    } finally {
      resumed.close();
    }
  },
);
