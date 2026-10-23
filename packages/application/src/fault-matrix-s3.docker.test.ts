import { createHash, randomBytes } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { uuidV7IdGenerator } from "@testmaster/domain";
import {
  BundleAlreadyPublishedError,
  type BundleFileSource,
  BundleNotFoundError,
  bundleKeyFor,
  collectGarbage,
  FileEvidenceStore,
  FileObjectStore,
  findOrphanPublished,
  type ObjectStore,
  publishBundle,
  publishFaultPoints,
  publishMarkerKey,
  S3ObjectStore,
  verifyBundle,
} from "@testmaster/evidence";
import {
  type MinioTestServer,
  minioTestImage,
  startMinioTestServer,
} from "@testmaster/evidence/testing";
import { PersistenceDatabase } from "@testmaster/persistence";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  createTestDatabaseOn,
  type PostgresTestServer,
  startPostgresTestServer,
} from "../../persistence/src/testing/server.js";
import { readKeyFile } from "./backup-crypto.js";
import { type OpsStack, opsStack, restoreTarget } from "./ops.testkit.js";
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
import {
  catalogKey,
  catalogPrefix,
  dataPrefix,
  listS3Catalog,
  listS3DataNames,
} from "./server-backup-media.js";
import type { S3BackupDestination, S3StorageConfig, ServerConfig } from "./server-config.js";
import { openS3Store } from "./storage-config.js";

/*
 * VAL-045 (S3 part): every write boundary of backup, restore, retention and evidence publication
 * on the S3 profile is crashed, and afterwards nothing falsely complete is published or reported
 * and a rerun converges on the same bytes. PostgreSQL and MinIO run in containers; the evidence
 * credential and the backup credential are two MinIO users, each limited to its own bucket.
 */

let postgres: PostgresTestServer;
let minio: MinioTestServer;
let root: string;
let evidenceUser: { id: string; secret: string };
let backupUser: { id: string; secret: string };

const lockedBucket = "backups";
const plainBucket = "backups-plain";
const evidenceBucket = "evidence";
const region = "us-east-1";
const unique = () => `t${randomBytes(5).toString("hex")}`;

const policyFor = (buckets: string[], actions: string[]) => ({
  Version: "2012-10-17",
  Statement: [
    {
      Effect: "Allow",
      Action: actions,
      Resource: buckets.flatMap((bucket) => [`arn:aws:s3:::${bucket}`, `arn:aws:s3:::${bucket}/*`]),
    },
  ],
});

beforeAll(async () => {
  [postgres, minio] = await Promise.all([startPostgresTestServer(), startMinioTestServer()]);
  await minio.createBucket(evidenceBucket);
  await minio.createBucket(lockedBucket, { objectLock: { mode: "COMPLIANCE", days: 1 } });
  await minio.createBucket(plainBucket);
  evidenceUser = {
    id: `ev${randomBytes(5).toString("hex")}`,
    secret: randomBytes(18).toString("hex"),
  };
  backupUser = {
    id: `bk${randomBytes(5).toString("hex")}`,
    secret: randomBytes(18).toString("hex"),
  };
  await minio.createUser(
    evidenceUser.id,
    evidenceUser.secret,
    policyFor([evidenceBucket], ["s3:*"]),
  );
  // The backup writer adds and reads objects and removes a version once its lock has expired.
  // MinIO demands s3:DeleteObject for a versioned delete too (AWS tells the two actions apart),
  // so the credential could add a delete marker, but never remove a locked version.
  await minio.createUser(
    backupUser.id,
    backupUser.secret,
    policyFor(
      [lockedBucket, plainBucket],
      [
        "s3:PutObject",
        "s3:GetObject",
        "s3:GetObjectVersion",
        "s3:ListBucket",
        "s3:ListBucketVersions",
        "s3:DeleteObjectVersion",
        "s3:DeleteObject",
        "s3:GetBucketLocation",
      ],
    ),
  );
  root = await mkdtemp(join(tmpdir(), "tm-s3-matrix-"));
}, 300_000);

afterAll(async () => {
  await Promise.allSettled([postgres?.stop(), minio?.stop()]);
  if (root) await rm(root, { recursive: true, force: true });
});

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

async function credentialFiles(
  user: { id: string; secret: string },
  name: string,
): Promise<{ accessKeyIdFile: string; secretAccessKeyFile: string }> {
  const accessKeyIdFile = join(root, `${name}.id`);
  const secretAccessKeyFile = join(root, `${name}.secret`);
  await writeFile(accessKeyIdFile, user.id, { mode: 0o600 });
  await writeFile(secretAccessKeyFile, user.secret, { mode: 0o600 });
  return { accessKeyIdFile, secretAccessKeyFile };
}

interface Locations {
  evidence: (stagingRoot: string, prefix: string) => Promise<S3StorageConfig>;
  backup: (bucket: string, prefix: string) => Promise<S3BackupDestination>;
}
const locations: Locations = {
  async evidence(stagingRoot, prefix) {
    return {
      kind: "s3",
      endpoint: minio.endpoint,
      region,
      bucket: evidenceBucket,
      prefix,
      forcePathStyle: true,
      ...(await credentialFiles(evidenceUser, "evidence")),
      capacityBytes: 1_073_741_824,
      stagingRoot,
    };
  },
  async backup(bucket, prefix) {
    return {
      kind: "s3",
      endpoint: minio.endpoint,
      region,
      bucket,
      prefix,
      forcePathStyle: true,
      ...(await credentialFiles(backupUser, "backup")),
    };
  },
};

const createDatabase = (options?: { fresh?: boolean; migrate?: boolean }) =>
  createTestDatabaseOn(postgres, options);

/** An application on PostgreSQL with S3 evidence, three fixture objects and an S3 backup destination. */
async function s3Stack(options: { backupBucket?: string } = {}): Promise<OpsStack> {
  const id = unique();
  const stack = await opsStack({
    createDatabase,
    storage: (stackRoot) => locations.evidence(join(stackRoot, "staging"), `ev-${id}`),
    backupDestination: () => locations.backup(options.backupBucket ?? lockedBucket, `bk-${id}`),
  });
  cleanups.push(() => stack.cleanup());
  const project = stack.workspace.projects.create({ name: "Demo" });
  for (const name of ["profile", "terms", "prices"])
    await stack.workspace.artifacts.importFixtureInput({
      projectId: String(project.id),
      name,
      bytes: Buffer.from(`s3 fault matrix evidence ${name} ${id}`),
      mimeType: "text/plain",
    });
  return stack;
}

const db = (stack: OpsStack) => stack.application.controllerScope().database;
const destinationOf = (server: ServerConfig): S3BackupDestination => {
  const destination = server.backup?.destination;
  if (!destination || typeof destination === "string") throw new Error("not an S3 destination");
  return destination;
};
const backupKey = (server: ServerConfig) =>
  readKeyFile(server.security.backupKeyFile, "backup key");
const listing = async (server: ServerConfig) =>
  listServerBackups(destinationOf(server), await backupKey(server));

async function digestOf(store: ObjectStore, prefix = ""): Promise<Map<string, string>> {
  const digests = new Map<string, string>();
  for await (const object of store.list(prefix)) {
    const hash = createHash("sha256");
    const body = await store.get(object.key);
    for await (const chunk of body ?? []) hash.update(chunk as Buffer);
    digests.set(object.key, hash.digest("hex"));
  }
  return digests;
}
async function keysOf(store: ObjectStore, prefix = ""): Promise<string[]> {
  const keys: string[] = [];
  for await (const object of store.list(prefix)) keys.push(object.key);
  return keys.sort();
}
const withStore = async <T>(
  location: Parameters<typeof openS3Store>[0],
  work: (store: S3ObjectStore) => Promise<T>,
): Promise<T> => {
  const store = await openS3Store(location);
  try {
    return await work(store);
  } finally {
    store.close();
  }
};
const evidenceOf = (server: ServerConfig, work: (digests: Map<string, string>) => unknown) =>
  withStore(server.storage as S3StorageConfig, async (store) => work(await digestOf(store)));

describe("backup on S3", () => {
  for (const point of backupFaultPoints)
    it(`a crash at ${point} publishes no backup that is not whole and the next backup restores identical evidence`, async () => {
      const stack = await s3Stack();
      const database = db(stack);
      const source = stack.application.objectStore;
      await expect(
        createServerBackup({
          database,
          server: stack.server,
          objectStore: source,
          faultHook: crashAt(point),
        }),
      ).rejects.toBeInstanceOf(Crash);

      const entries = await listing(stack.server);
      if (point === "backup.renamed") {
        // The manifest was committed: the backup is whole and must verify.
        expect(entries.filter((entry) => entry.authentic)).toHaveLength(1);
        await verifyServerBackup(entries[0]?.directory ?? "", stack.server);
      } else {
        expect(entries).toEqual([]);
        const leftovers = await withStore(destinationOf(stack.server), (store) => keysOf(store));
        expect(leftovers.some((key) => key.startsWith(catalogPrefix))).toBe(false);
        // A crash after the dump leaves objects behind that no listing shows.
        if (point !== "backup.holds") expect(leftovers.length).toBeGreaterThan(0);
        else expect(leftovers).toEqual([]);
      }
      expect(
        database.get("SELECT value FROM operational_state WHERE key='backup:last-success'"),
      ).toBeUndefined();
      expect(
        database.get("SELECT value FROM operational_state WHERE key='backup:last-failure'")?.value,
      ).toBeTruthy();

      const retry = await createServerBackup({
        database,
        server: stack.server,
        objectStore: source,
      });
      const report = await verifyServerBackup(retry.directory, stack.server);
      expect(report.evidenceObjects).toBe(3);
      expect(report.complete).toBe(true);

      const target = await restoreTarget(stack, {
        createDatabase,
        storage: await locations.evidence(
          join(root, `staging-${unique()}`),
          `restored-${unique()}`,
        ),
      });
      cleanups.push(() => target.cleanup());
      await restoreServerBackup({ directory: retry.directory, server: target.server });
      const expected = await digestOf(source);
      await evidenceOf(target.server, (restored) => {
        expect([...restored.keys()]).not.toContain("tm-restore-pending");
        expect(restored.size).toBe(3);
        for (const [key, hash] of restored) expect(expected.get(key)).toBe(hash);
      });
    });

  it("a backup never overwrites an object that already exists", async () => {
    const stack = await s3Stack();
    const database = db(stack);
    const fixed = { backupId: "fixed-backup", now: () => new Date(Date.UTC(2026, 9, 1, 3)) };
    const planted = `${dataPrefix}20261001T030000Z-fixed-backup/database.dump.enc`;
    await withStore(destinationOf(stack.server), (store) => store.put(planted, "planted"));
    const before = await withStore(destinationOf(stack.server), (store) => digestOf(store));
    await expect(
      createServerBackup({
        database,
        server: stack.server,
        objectStore: stack.application.objectStore,
        ...fixed,
      }),
    ).rejects.toMatchObject({ details: { reasonCode: "backup_object_exists" } });
    expect(await withStore(destinationOf(stack.server), (store) => digestOf(store))).toEqual(
      before,
    );
    expect(await listing(stack.server)).toEqual([]);
  });

  it("listing the backups reads one catalog object per backup and never the evidence objects", async () => {
    const stack = await s3Stack();
    const make = () =>
      createServerBackup({
        database: db(stack),
        server: stack.server,
        objectStore: stack.application.objectStore,
      });
    const [first, second] = [await make(), await make()];
    await expect(
      createServerBackup({
        database: db(stack),
        server: stack.server,
        objectStore: stack.application.objectStore,
        faultHook: crashAt("backup.index"),
      }),
    ).rejects.toBeInstanceOf(Crash);
    await withStore(destinationOf(stack.server), async (store) => {
      const read: string[] = [];
      const finished = await listS3Catalog({
        async *list(prefix) {
          for await (const object of store.list(prefix)) {
            read.push(object.key);
            yield object;
          }
        },
      });
      expect(finished.sort()).toEqual([first.directory, second.directory].sort());
      expect(read.sort()).toEqual(finished.map(catalogKey).sort());
      // Many more objects exist: the listing above did not touch them.
      expect((await keysOf(store)).length).toBeGreaterThan(read.length * 4);
      // The crashed backup has data but no catalog entry; a delimiter finds it without reading below.
      expect((await listS3DataNames(store)).length).toBe(3);
    });
    expect((await listing(stack.server)).map((entry) => entry.directory).sort()).toEqual(
      [first.directory, second.directory].sort(),
    );
  });
});

describe("restore from S3", () => {
  for (const point of restoreFaultPoints)
    it(`a crash at ${point} keeps the backup recoverable, never leaves unmarked half-restored evidence and a rerun equals an uninterrupted restore`, async () => {
      const stack = await s3Stack();
      const backup = await createServerBackup({
        database: db(stack),
        server: stack.server,
        objectStore: stack.application.objectStore,
      });
      const targetStorage = () =>
        locations.evidence(join(root, `staging-${unique()}`), `restored-${unique()}`);
      const reference = await restoreTarget(stack, {
        createDatabase,
        storage: await targetStorage(),
      });
      cleanups.push(() => reference.cleanup());
      await restoreServerBackup({ directory: backup.directory, server: reference.server });
      const expectedEvidence = await evidenceOf(reference.server, (digests) => digests);
      expect((expectedEvidence as Map<string, string>).size).toBe(3);

      const target = await restoreTarget(stack, { createDatabase, storage: await targetStorage() });
      cleanups.push(() => target.cleanup());
      await expect(
        restoreServerBackup({
          directory: backup.directory,
          server: target.server,
          faultHook: crashAt(point),
        }),
      ).rejects.toBeInstanceOf(Crash);
      // The backup is untouched.
      await verifyServerBackup(backup.directory, stack.server);

      const config = (({ engine: _engine, ...rest }) => rest)(target.server.database);
      const evidence = await withStore(target.server.storage as S3StorageConfig, (store) =>
        keysOf(store),
      );
      const complete = point === "restore.finalized" || point === "restore.marker_cleared";
      if (point === "restore.verified") {
        expect(evidence).toEqual([]);
      } else if (complete) {
        // A finished database: it opens, and a second restore refuses to overwrite it.
        const opened = PersistenceDatabase.openPostgres(config);
        opened.close();
        await expect(
          restoreServerBackup({ directory: backup.directory, server: target.server }),
        ).rejects.toMatchObject({ details: { reasonCode: "restore_target_not_empty" } });
        expect(evidence.includes("tm-restore-pending")).toBe(point === "restore.finalized");
        return;
      } else {
        // Evidence may be partial, but only while the marker says the restore is unfinished, and the
        // database refuses to open until it finishes.
        expect(evidence).toContain("tm-restore-pending");
        expect(() => PersistenceDatabase.openPostgres(config)).toThrowError(
          expect.objectContaining({
            details: expect.objectContaining({ reasonCode: "restore_incomplete" }),
          }),
        );
      }

      const rerun = await restoreServerBackup({
        directory: backup.directory,
        server: target.server,
      });
      expect(rerun.wipedInterruptedRestore).toBe(point !== "restore.verified");
      await evidenceOf(target.server, (digests) => expect(digests).toEqual(expectedEvidence));
    });

  it("a restore into an evidence bucket that holds foreign objects is refused and leaves them", async () => {
    const stack = await s3Stack();
    const backup = await createServerBackup({
      database: db(stack),
      server: stack.server,
      objectStore: stack.application.objectStore,
    });
    const storage = await locations.evidence(
      join(root, `staging-${unique()}`),
      `occupied-${unique()}`,
    );
    await withStore(storage, (store) => store.put("runs/ws_x/run_x/att_x/meta.json", "{}"));
    const target = await restoreTarget(stack, { createDatabase, storage });
    cleanups.push(() => target.cleanup());
    await expect(
      restoreServerBackup({ directory: backup.directory, server: target.server }),
    ).rejects.toMatchObject({ details: { reasonCode: "restore_target_not_empty" } });
    expect(await withStore(storage, (store) => keysOf(store))).toEqual([
      "runs/ws_x/run_x/att_x/meta.json",
    ]);
  });
});

describe("retention on S3", () => {
  const policy = { daily: 1, weekly: 0, monthly: 0 };
  async function twoBackups(bucket: string) {
    const stack = await s3Stack({ backupBucket: bucket });
    const server: ServerConfig = {
      ...stack.server,
      backup: {
        ...(stack.server.backup as NonNullable<ServerConfig["backup"]>),
        retention: policy,
      },
    };
    const create = (day: number) =>
      createServerBackup({
        database: db(stack),
        server,
        objectStore: stack.application.objectStore,
        now: () => new Date(Date.UTC(2026, 9, day, 3)),
      });
    const first = await create(1);
    const second = await create(2);
    return { stack, server, first, second };
  }
  const authentic = async (server: ServerConfig) =>
    (await listing(server)).filter((entry) => entry.authentic).map((entry) => entry.backupId);

  // Keyed by the declared points, so a new retention boundary does not compile without a crash test.
  const retentionCrashes: Record<(typeof retentionFaultPoints)[number], () => Promise<void>> = {
    // Every backup stays whole and the next pass removes the expired one.
    "retention.remove": async () => {
      const { server, first, second } = await twoBackups(plainBucket);
      await expect(
        applyServerBackupRetention(server, { faultHook: crashAt("retention.remove") }),
      ).rejects.toBeInstanceOf(Crash);
      expect((await authentic(server)).sort()).toEqual([first.backupId, second.backupId].sort());
      await verifyServerBackup(first.directory, server);
      const outcome = await applyServerBackupRetention(server);
      expect(outcome.removed).toEqual([first.backupId]);
      expect(outcome.locked).toEqual([]);
      expect(await authentic(server)).toEqual([second.backupId]);
      expect(
        await withStore(destinationOf(server), (store) =>
          keysOf(store, `${dataPrefix}${first.directory}/`),
        ),
      ).toEqual([]);
    },

    // The manifest goes first, so a backup that lost objects is never listed.
    "retention.object_deleted": async () => {
      const { server, first, second } = await twoBackups(plainBucket);
      await expect(
        applyServerBackupRetention(server, { faultHook: crashAt("retention.object_deleted") }),
      ).rejects.toBeInstanceOf(Crash);
      // The manifest goes first: the half-deleted backup is not listed, the other one is whole.
      expect(await authentic(server)).toEqual([second.backupId]);
      const leftovers = await withStore(destinationOf(server), (store) =>
        keysOf(store, `${dataPrefix}${first.directory}/`),
      );
      expect(leftovers.length).toBeGreaterThan(0);
      expect(
        await withStore(destinationOf(server), (store) => keysOf(store, catalogPrefix)),
      ).toEqual([catalogKey(second.directory)]);
      // Within the grace the leftovers may belong to a running backup and are left alone.
      expect((await applyServerBackupRetention(server)).orphansCollected).toEqual([]);
      const later = await applyServerBackupRetention(server, {
        now: () => new Date(Date.now() + 3 * 86_400_000),
      });
      expect(later.orphansCollected).toEqual([first.directory]);
      expect(
        await withStore(destinationOf(server), (store) =>
          keysOf(store, `${dataPrefix}${first.directory}/`),
        ),
      ).toEqual([]);
      await verifyServerBackup(second.directory, server);
    },
  };
  for (const point of retentionFaultPoints)
    it(
      `a crash at ${point} never lists a backup that is not whole and the next pass converges`,
      retentionCrashes[point],
    );

  it("a backup under an unexpired lock stays listed, whole and retried: the refused removal is not an error and loses nothing", async () => {
    const { server, first, second } = await twoBackups(lockedBucket);
    const before = await withStore(destinationOf(server), (store) => digestOf(store));
    for (let pass = 0; pass < 2; pass++) {
      const outcome = await applyServerBackupRetention(server);
      expect(outcome.locked).toEqual([first.backupId]);
      expect(outcome.removed).toEqual([]);
      expect((await authentic(server)).sort()).toEqual([first.backupId, second.backupId].sort());
    }
    await verifyServerBackup(first.directory, server);
    expect(await withStore(destinationOf(server), (store) => digestOf(store))).toEqual(before);
  });

  it("the leftovers of a crashed backup stay while their lock holds, even past the grace", async () => {
    const stack = await s3Stack();
    await expect(
      createServerBackup({
        database: db(stack),
        server: stack.server,
        objectStore: stack.application.objectStore,
        faultHook: crashAt("backup.index"),
      }),
    ).rejects.toBeInstanceOf(Crash);
    const before = await withStore(destinationOf(stack.server), (store) => digestOf(store));
    expect(before.size).toBeGreaterThan(0);
    const outcome = await applyServerBackupRetention(stack.server, {
      now: () => new Date(Date.now() + 3 * 86_400_000),
    });
    expect(outcome.orphansCollected).toEqual([]);
    expect(await withStore(destinationOf(stack.server), (store) => digestOf(store))).toEqual(
      before,
    );
  });
});

describe("backup bucket protection", () => {
  it("neither the evidence credential, nor the backup credential, nor root can delete a locked backup", async () => {
    const stack = await s3Stack();
    const backup = await createServerBackup({
      database: db(stack),
      server: stack.server,
      objectStore: stack.application.objectStore,
    });
    const destination = destinationOf(stack.server);
    const manifestKey = catalogKey(backup.directory);
    const before = await withStore(destination, (store) => digestOf(store));

    // The application's evidence credential reaches nothing in the backup bucket.
    const evidenceCredential = await credentialFiles(evidenceUser, "evidence");
    const asApp = await openS3Store({ ...destination, ...evidenceCredential });
    try {
      await expect(asApp.get(manifestKey)).rejects.toMatchObject({
        details: { reasonCode: "storage_unavailable" },
      });
      await expect(asApp.put(`${backup.directory}/planted`, "x")).rejects.toMatchObject({
        details: { reasonCode: "storage_unavailable" },
      });
      await expect(asApp.delete(manifestKey)).rejects.toMatchObject({
        details: { reasonCode: "storage_unavailable" },
      });
      await expect(asApp.deleteVersions(manifestKey)).rejects.toMatchObject({
        details: { reasonCode: "storage_unavailable" },
      });
    } finally {
      asApp.close();
    }

    // The lock refuses the removal of the manifest's version, whatever the credential holds.
    await withStore(destination, async (store) => {
      expect(await store.deleteVersions(manifestKey)).toEqual({ deleted: false, locked: true });
    });

    // COMPLIANCE binds the bucket's root credential too.
    const asRoot = new S3ObjectStore({
      endpoint: minio.endpoint,
      region,
      bucket: lockedBucket,
      prefix: destination.prefix as string,
      forcePathStyle: true,
      accessKeyId: minio.accessKeyId,
      secretAccessKey: minio.secretAccessKey,
    });
    try {
      expect(await asRoot.deleteVersions(manifestKey)).toEqual({ deleted: false, locked: true });
    } finally {
      asRoot.close();
    }

    expect(await withStore(destination, (store) => digestOf(store))).toEqual(before);
    await verifyServerBackup(backup.directory, stack.server);
  });
});

describe("evidence publication on S3", () => {
  const ids = () => ({
    workspaceId: uuidV7IdGenerator.next("ws"),
    runId: uuidV7IdGenerator.next("run"),
    attemptId: uuidV7IdGenerator.next("att"),
    revisionId: uuidV7IdGenerator.next("rev"),
    snapshotId: uuidV7IdGenerator.next("snp"),
  });

  /** A real sealed bundle, staged on a local directory, as the files `publishBundle` takes. */
  async function sealedBundle(bundleIds: ReturnType<typeof ids>): Promise<BundleFileSource[]> {
    const staging = await mkdtemp(join(tmpdir(), "tm-s3-publish-"));
    cleanups.push(() => rm(staging, { recursive: true, force: true }));
    const stage = await new FileEvidenceStore({ rootDir: staging }).openAttempt(bundleIds);
    for (const [path, text] of [
      ["a.txt", "alpha"],
      ["dir/b.txt", "bravo"],
    ] as const) {
      const writer = await stage.beginArtifact({
        relativePath: path,
        kind: "log",
        mimeType: "text/plain",
      });
      await writer.write(Buffer.from(text));
      await writer.end();
    }
    await stage.commit({ redactionPolicyHash: "0".repeat(64) });
    const local = new FileObjectStore(staging);
    const base = bundleKeyFor(bundleIds);
    const files: BundleFileSource[] = [];
    for await (const object of local.list(`${base}/`)) {
      const body = await local.get(object.key);
      const chunks: Buffer[] = [];
      for await (const chunk of body ?? []) chunks.push(chunk as Buffer);
      files.push({
        relativePath: object.key.slice(base.length + 1),
        body: () => Buffer.concat(chunks),
      });
    }
    return files;
  }

  for (const point of publishFaultPoints)
    it(`a crash at ${point} never leaves a committed bundle that is not whole and recovery publishes the same bytes`, async () => {
      const bundleIds = ids();
      const files = await sealedBundle(bundleIds);
      const location = await locations.evidence(
        join(root, `staging-${unique()}`),
        `ev-${unique()}`,
      );
      await withStore(location, async (store) => {
        const base = bundleKeyFor(bundleIds);
        await expect(
          publishBundle(store, bundleIds, files, { faultHook: crashAt(point) }),
        ).rejects.toBeInstanceOf(Crash);
        // The pending marker stays, so the collector knows the bundle is not referenced.
        expect(await store.head(publishMarkerKey(bundleIds))).not.toBeNull();
        if (point === "publish.meta") {
          // Committed and whole: a second publication is refused and the bytes do not change.
          const committed = await digestOf(store, `${base}/`);
          await verifyBundle(store, base, bundleIds);
          await expect(publishBundle(store, bundleIds, files)).rejects.toBeInstanceOf(
            BundleAlreadyPublishedError,
          );
          expect(await digestOf(store, `${base}/`)).toEqual(committed);
          // A bundle the database references is never collected.
          const kept = await collectGarbage(store, [{ relativePath: base, version: 1 }], {
            inspect: async () => ({
              activeAttempt: false,
              validUploadLease: false,
              legalHold: false,
              liveReferences: 1,
            }),
            mark: async () => ({ version: 1 }),
            tombstone: async () => ({ version: 1 }),
            deleted: async () => undefined,
          });
          expect(kept).toEqual([]);
          return;
        }
        expect(await store.head(`${base}/meta.json`)).toBeNull();
        await expect(verifyBundle(store, base, bundleIds)).rejects.toBeInstanceOf(
          BundleNotFoundError,
        );
        const orphans = await findOrphanPublished(store, { graceMs: 0 });
        expect(orphans.map((orphan) => orphan.bundleKey)).toEqual([base]);
        const removed = await collectGarbage(store, [{ relativePath: base, version: 1 }], {
          inspect: async () => ({
            activeAttempt: false,
            validUploadLease: false,
            legalHold: false,
            liveReferences: 0,
          }),
          mark: async () => ({ version: 1 }),
          tombstone: async () => ({ version: 1 }),
          deleted: async () => undefined,
        });
        expect(removed).toEqual([base]);
        expect(await keysOf(store)).toEqual([]);

        await publishBundle(store, bundleIds, files);
        const bundle = await verifyBundle(store, base, bundleIds);
        const expectedManifest = files.find((file) => file.relativePath === "manifest.json");
        const stored = await digestOf(store, `${base}/manifest.json`);
        expect([...stored.values()]).toEqual([
          createHash("sha256")
            .update((await (expectedManifest as BundleFileSource).body()) as Buffer)
            .digest("hex"),
        ]);
        expect(bundle.manifest.entries.length).toBe(2);
      });
    });
});

describe("loss of the evidence bucket and the database", () => {
  it("restores a fresh database and the emptied evidence bucket from the locked backup alone", async () => {
    const stack = await s3Stack();
    const startedAt = Date.now();
    const backup = await createServerBackup({
      database: db(stack),
      server: stack.server,
      objectStore: stack.application.objectStore,
    });
    const backedUpAt = Date.now();
    // Written after the backup: the data this disaster loses (the RPO).
    stack.workspace.projects.create({ name: "After the backup" });
    const source = await digestOf(stack.application.objectStore);
    expect(source.size).toBe(3);

    // The disaster: every evidence object is gone and the database is replaced by an empty one.
    const storage = stack.server.storage as S3StorageConfig;
    await withStore(storage, async (store) => {
      for (const key of await keysOf(store)) await store.delete(key);
      expect(await keysOf(store)).toEqual([]);
    });
    const lostAt = Date.now();
    const target = await restoreTarget(stack, { createDatabase, storage });
    cleanups.push(() => target.cleanup());

    const restoreStartedAt = Date.now();
    await restoreServerBackup({ directory: backup.directory, server: target.server });
    const restoreSeconds = (Date.now() - restoreStartedAt) / 1000;

    const restored = await withStore(storage, (store) => digestOf(store));
    expect(restored).toEqual(source);
    const config = (({ engine: _engine, ...rest }) => rest)(target.server.database);
    const opened = PersistenceDatabase.openPostgres(config);
    try {
      // Only what the backup held came back; the later project is the RPO.
      expect(opened.get<{ n: number }>("SELECT COUNT(*) AS n FROM projects")?.n).toBe(1);
    } finally {
      opened.close();
    }

    // The same backup cannot be removed or reached with the application's credential.
    const destination = destinationOf(stack.server);
    const manifestKey = catalogKey(backup.directory);
    const deleteRefused = await withStore(
      destination,
      async (store) => (await store.deleteVersions(manifestKey)).deleted === false,
    );
    const asApp = await openS3Store({
      ...destination,
      ...(await credentialFiles(evidenceUser, "evidence")),
    });
    const appCredentialDenied = await asApp.get(manifestKey).then(
      () => false,
      () => true,
    );
    asApp.close();
    expect(deleteRefused).toBe(true);
    expect(appCredentialDenied).toBe(true);
    const report = await verifyServerBackup(backup.directory, stack.server);
    expect(report.complete).toBe(true);

    // The results convention of tools/src/results-dir.ts; a package test cannot import tools.
    const results = resolve(
      dirname(fileURLToPath(import.meta.url)),
      "../../..",
      process.env.TESTMASTER_RESULTS_DIR || "validation/results/tmp",
    );
    await mkdir(results, { recursive: true });
    await writeFile(
      join(results, "m5-s3-loss-rehearsal.json"),
      `${JSON.stringify(
        {
          name: "m5-s3-loss-rehearsal",
          profile: "distributed",
          minioImage: minioTestImage,
          status: "measured",
          milestone: "M5",
          scenario: "evidence-bucket-loss",
          evidenceObjectsLost: source.size,
          backup: {
            backupId: backup.backupId,
            bucket: lockedBucket,
            objectLockMode: "COMPLIANCE",
            objectLockDays: 1,
            objects: report.filesChecked,
            authentic: report.complete,
          },
          lock: { deleteRefused, appCredentialDenied },
          restore: {
            exitCode: 0,
            emptiedBucketVerified: true,
            evidenceFiles: [...source].map(([path, hash]) => ({
              path,
              source: hash,
              restored: restored.get(path),
              equal: restored.get(path) === hash,
            })),
          },
          rpoSeconds: Math.max(0.001, Number(((lostAt - backedUpAt) / 1000).toFixed(3))),
          rtoSeconds: Math.max(0.001, Number(restoreSeconds.toFixed(3))),
          backupSeconds: Number(((backedUpAt - startedAt) / 1000).toFixed(3)),
          notMeasured: [
            "Object Lock expiry: COMPLIANCE retention has a one-day minimum, so removal after expiry is exercised only on an unlocked bucket",
            "restore of a bucket larger than the three fixture objects, and any network between hosts",
            "AWS S3, Ceph and other S3 implementations: only the pinned MinIO image ran",
            "the production RPO: rpoSeconds is only the test's gap between backup and loss; the real RPO is the backup interval (daily by default)",
            "the production RTO: rtoSeconds covers three tiny objects and a near-empty database on one host",
          ],
        },
        null,
        2,
      )}\n`,
    );
  });
});
