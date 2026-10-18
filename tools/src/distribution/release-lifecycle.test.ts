import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { revokeImage, upgradeLocalProfile } from "@testmaster/application";
import {
  constraintSeed,
  loadMigrations,
  PersistenceDatabase,
  planDatabaseUpgrade,
} from "@testmaster/persistence";
import { afterEach, expect, it } from "vitest";
import { localInstall, localVerify } from "./local-install.js";
import { RUNTIME_RESOURCES } from "./package.js";

const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});
const image = (letter: string) => `sha256:${letter.repeat(64)}`;
const sha = (data: Buffer | string) => createHash("sha256").update(data).digest("hex");

/** A candidate release source whose shipped migrations are the first `migrationCount` real ones. */
async function candidate(root: string, name: string, migrationCount: number, imageId: string) {
  const source = join(root, name);
  const all = await loadMigrations();
  for (const entry of ["apps/cli", "packages/runner"]) {
    await mkdir(join(source, entry, "dist"), { recursive: true });
    await writeFile(
      join(source, entry, "package.json"),
      JSON.stringify({
        name: entry === "apps/cli" ? "@testmaster/cli" : "@testmaster/runner",
        version: "0.1.0",
        type: "module",
        dependencies: {},
      }),
    );
    await writeFile(
      join(source, entry, "dist/main.js"),
      'console.log(process.argv.includes("--version") ? "0.1.0" : JSON.stringify({runner:"http"}));',
    );
  }
  for (const resource of RUNTIME_RESOURCES) {
    await mkdir(dirname(join(source, resource)), { recursive: true });
    if (
      resource === "packages/contracts/schemas" ||
      resource === "packages/application/skill-content" ||
      resource.includes("migrations/")
    )
      await mkdir(join(source, resource), { recursive: true });
    else await writeFile(join(source, resource), "fixture resource");
  }
  for (const migration of all.slice(0, migrationCount))
    await writeFile(
      join(
        source,
        "packages/persistence/migrations/sqlite",
        `${String(migration.version).padStart(4, "0")}_${migration.name}.sql`,
      ),
      migration.sql,
    );
  await writeFile(
    join(source, "containers/images.lock.json"),
    JSON.stringify({ "testmaster-runner": { imageId } }),
  );
  return source;
}
async function digests(paths: string[]): Promise<string[]> {
  return Promise.all(paths.map(async (path) => sha(await readFile(path))));
}
function tableDigest(database: PersistenceDatabase): string {
  const rows = ["runs", "attempts", "job_leases", "snapshots", "tests", "test_revisions"].map(
    (table) => database.all(`SELECT * FROM ${table} ORDER BY id`),
  );
  return sha(JSON.stringify(rows));
}

it("installs A, upgrades to B with backup/drain/readiness, rolls back only when compatible and never reinstalls a revoked image", async () => {
  const root = await mkdtemp(join(tmpdir(), "tm-lifecycle-"));
  roots.push(root);
  const total = (await loadMigrations()).length;
  const prefix = join(root, "prefix with spaces");
  const dataDir = join(root, "project", ".testmaster");
  const dbPath = join(dataDir, "testmaster.db");
  const installed = join(prefix, "lib/testmaster");
  const release = {
    a: await candidate(root, "release-a", total - 1, image("a")),
    a2: await candidate(root, "release-a2", total - 1, image("c")),
    b: await candidate(root, "release-b", total, image("b")),
  };

  // Operator configuration, policy and secret material live outside the install and the DB.
  const config = join(root, "home/.config/testmaster");
  await mkdir(config, { recursive: true });
  const operatorFiles = ["policy.json", "profiles.json", "vault.key"].map((name) =>
    join(config, name),
  );
  await Promise.all(
    operatorFiles.map((path, index) => writeFile(path, `operator-owned-${index}`, { mode: 0o600 })),
  );
  const operatorBefore = await digests(operatorFiles);

  // 1. Install version A: nothing to check yet, so there is no pre-deploy migration warning.
  const first = await localInstall(release.a, prefix, true, dataDir);
  expect(first.warnings).toEqual([]);
  await localVerify(prefix);

  // 2. Create state with A's schema: old Run, tombstone and a revoked image.
  const seed = await PersistenceDatabase.open(dbPath, {
    migrationsDir: join(installed, "packages/persistence/migrations/sqlite"),
  });
  seed.withTx((db) => {
    for (const statement of constraintSeed) db.exec(statement);
  });
  seed.run(
    "UPDATE attempts SET phase='completed',outcome='passed',ended_at='2026-10-05T00:00:01.000Z'",
  );
  seed.run(
    "INSERT INTO operational_state(key,value) VALUES('retention:artifact:ws-a:art-a','{\"stage\":\"deleted\"}')",
  );
  revokeImage(seed, image("d"), "withdrawn older runner build");
  const stateBefore = tableDigest(seed);
  expect(seed.status().currentVersion).toBe(total - 1);
  seed.close();

  // 3. Deploying B announces the irreversible migration before anything is replaced.
  const second = await localInstall(release.b, prefix, true, dataDir);
  expect(second.warnings.join(" ")).toContain(`Irreversible migration ${total}_`);
  expect((await planDatabaseUpgrade(dbPath)).currentVersion).toBe(total - 1);

  // 4. Compatible rollback: the data is still at A's schema, so A may be reinstalled unchanged.
  const rollback = await localInstall(release.a, prefix, true, dataDir);
  expect(rollback.warnings).toEqual([]);
  await localVerify(prefix);
  expect(await readFile(join(installed, "containers/images.lock.json"), "utf8")).toContain(
    image("a"),
  );
  expect((await planDatabaseUpgrade(dbPath)).currentVersion).toBe(total - 1);

  // 5. Upgrade: install B, then drain, back up the old schema, migrate and check readiness.
  await localInstall(release.b, prefix, true, dataDir);
  const upgrade = await upgradeLocalProfile({
    dataDir,
    migrationsDir: join(installed, "packages/persistence/migrations/sqlite"),
    imageLockPath: join(installed, "containers/images.lock.json"),
    backupDir: join(root, "backups/before-b"),
    drainTimeoutMs: 0,
  });
  expect(upgrade.receipt.steps.map((step) => step.step)).toEqual([
    "preflight",
    "drain",
    "backup",
    "migrate",
    "readiness",
    "resume",
  ]);
  expect(upgrade.receipt.backup?.databaseVersion).toBe(total - 1);
  expect(upgrade.receipt.rollbackPlan.appRollback).toBe("restore-required");
  // The seeded snapshot has no evidence bundle on disk: reported, not hidden and not a refusal.
  expect(upgrade.receipt.backup?.evidenceComplete).toBe(false);
  expect(upgrade.receipt.warnings.join(" ")).toContain("evidence index is incomplete");
  expect((await stat(join(root, "backups/before-b/manifest.json"))).isFile()).toBe(true);

  // 6. Incompatible rollback: A2 is not revoked, but it cannot open schema `total`. Refused with a
  //    clear error; the installed runtime, launcher and database stay byte-identical.
  const launcher = await readFile(join(prefix, "bin/testmaster"), "utf8");
  const receipt = await readFile(join(prefix, "lib/testmaster-install.json"), "utf8");
  const databaseBefore = await readFile(dbPath);
  await expect(localInstall(release.a2, prefix, true, dataDir)).rejects.toThrow(
    /Refusing to install: Database schema version \d+ is newer than this release supports \(\d+\)\..*restore the pre-upgrade backup/,
  );
  expect(await readFile(join(prefix, "bin/testmaster"), "utf8")).toBe(launcher);
  expect(await readFile(join(prefix, "lib/testmaster-install.json"), "utf8")).toBe(receipt);
  expect(await readFile(join(installed, "containers/images.lock.json"), "utf8")).toContain(
    image("b"),
  );
  expect(await readFile(dbPath)).toEqual(databaseBefore);
  await localVerify(prefix);

  // 7. Revoked image: revoking B's own digest makes even the same release uninstallable.
  const database = await PersistenceDatabase.open(dbPath, { migrate: false });
  revokeImage(database, image("b"), "withdrawn after incident");
  await expect(localInstall(release.b, prefix, true, dataDir)).rejects.toThrow(
    new RegExp(`Image testmaster-runner \\(${image("b")}\\) is revoked`),
  );
  await localVerify(prefix);

  // 8. Config, policy, secrets, tombstones, revocations and old Runs survive every step unchanged.
  expect(await digests(operatorFiles)).toEqual(operatorBefore);
  expect(database.status()).toMatchObject({ currentVersion: total, pending: [] });
  expect(
    database.get("SELECT value FROM operational_state WHERE key='retention:artifact:ws-a:art-a'")
      ?.value,
  ).toBe('{"stage":"deleted"}');
  expect(
    database.all("SELECT key FROM operational_state WHERE key LIKE 'image:revoked:%' ORDER BY key"),
  ).toEqual([{ key: `image:revoked:${image("b")}` }, { key: `image:revoked:${image("d")}` }]);
  expect(tableDigest(database)).toBe(stateBefore);
  expect(database.get("SELECT phase,status FROM runs WHERE id='run-a'")).toEqual({
    phase: "queued",
    status: "queued",
  });
  database.close();
});

it("refuses a rollback to a release whose pinned image was revoked even when the schema is compatible", async () => {
  const root = await mkdtemp(join(tmpdir(), "tm-lifecycle-revoked-"));
  roots.push(root);
  const total = (await loadMigrations()).length;
  const prefix = join(root, "prefix");
  const dataDir = join(root, ".testmaster");
  const older = await candidate(root, "older", total, image("a"));
  const newer = await candidate(root, "newer", total, image("b"));
  await localInstall(older, prefix, true, dataDir);
  const database = await PersistenceDatabase.open(join(dataDir, "testmaster.db"), {
    migrationsDir: join(prefix, "lib/testmaster/packages/persistence/migrations/sqlite"),
  });
  revokeImage(database, image("a"), "vulnerable build");
  database.close();
  await localInstall(newer, prefix, true, dataDir);
  const before = await readFile(join(prefix, "lib/testmaster/containers/images.lock.json"), "utf8");
  await expect(localInstall(older, prefix, true, dataDir)).rejects.toThrow(
    /is revoked and is never reinstalled/,
  );
  expect(await readFile(join(prefix, "lib/testmaster/containers/images.lock.json"), "utf8")).toBe(
    before,
  );
  // Control: the same data accepts the release that does not pin a revoked image.
  expect((await localInstall(newer, prefix, true, dataDir)).warnings).toEqual([]);
});
