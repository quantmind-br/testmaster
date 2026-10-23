import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { assertBackupSeparation } from "./server-backup.js";
import { parseServerConfig } from "./server-config.js";

const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

async function s3Server(allowSharedAccess: boolean) {
  const root = await mkdtemp(join(tmpdir(), "tm-backup-s3-"));
  roots.push(root);
  const files = {
    backupKey: join(root, "backup.key"),
    accessKeyId: join(root, "backup-access-key-id"),
    secretAccessKey: join(root, "backup-secret-access-key"),
  };
  for (const path of Object.values(files)) await writeFile(path, "x", { mode: 0o600 });
  const server = parseServerConfig({
    mode: "server",
    database: { engine: "postgres", url: "postgres://testmaster@127.0.0.1:5432/testmaster" },
    storage: { kind: "filesystem", root: join(root, "evidence") },
    server: {
      listen: { host: "127.0.0.1", port: 8080 },
      publicOrigin: "https://tm.example",
      trustedProxies: ["10.0.0.0/8"],
      origins: ["https://tm.example"],
    },
    security: {
      masterKeyFile: join(root, "master.key"),
      backupKeyFile: files.backupKey,
      atRestEncryption: { database: "operator-volume", evidence: "operator-volume" },
    },
    backup: {
      destination: {
        kind: "s3",
        endpoint: "https://backups.example:9000",
        region: "eu-1",
        bucket: "tm-backups",
        forcePathStyle: true,
        accessKeyIdFile: files.accessKeyId,
        secretAccessKeyFile: files.secretAccessKey,
      },
      ...(allowSharedAccess ? { allowSharedAccess: true } : {}),
    },
  });
  return { server, files };
}

it("OPS-024 an S3 backup destination is refused while the server user can read its credential files", async () => {
  const { server, files } = await s3Server(false);
  // The same user reads the backup key, which is refused first.
  await expect(assertBackupSeparation(server)).rejects.toMatchObject({
    details: { reasonCode: "backup_access_not_separated", path: "security.backupKeyFile" },
  });
  if (process.getuid?.() === 0) return; // root ignores file modes: the unreadable cases cannot be built
  await chmod(files.backupKey, 0o000);
  await expect(assertBackupSeparation(server)).rejects.toMatchObject({
    details: {
      reasonCode: "backup_access_not_separated",
      path: "backup.destination.accessKeyIdFile",
    },
  });
  await chmod(files.accessKeyId, 0o000);
  await expect(assertBackupSeparation(server)).rejects.toMatchObject({
    details: {
      reasonCode: "backup_access_not_separated",
      path: "backup.destination.secretAccessKeyFile",
    },
  });
  await chmod(files.secretAccessKey, 0o000);
  await assertBackupSeparation(server);
});

it("OPS-024 allowSharedAccess waives the S3 credential check for single-user deployments", async () => {
  const { server } = await s3Server(true);
  await assertBackupSeparation(server);
});
