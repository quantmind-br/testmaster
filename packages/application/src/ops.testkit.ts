import { randomBytes } from "node:crypto";
import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createTestDatabase,
  postgresTestImage,
  type TestDatabase,
} from "@testmaster/persistence/testing";
import { Application } from "./application.js";
import type { ServerConfig } from "./server-config.js";

/**
 * Fixtures for the operations tests (backup, restore, purge, alerts). The PostgreSQL client tools
 * come from the pinned test image, run over the host network, so the host needs no `pg_dump`.
 */
const wrapper = (tool: string): string[] => [
  "docker",
  "run",
  "--rm",
  "-i",
  "--network",
  "host",
  "-e",
  "PGPASSWORD",
  "-e",
  "PGOPTIONS",
  "-e",
  "PGAPPNAME",
  postgresTestImage,
  tool,
];
export const testPgDump = wrapper("pg_dump");
export const testPgRestore = wrapper("pg_restore");

export async function writeKeyFile(path: string): Promise<Buffer> {
  const key = randomBytes(32);
  await writeFile(path, key, { mode: 0o600 });
  await chmod(path, 0o600);
  return key;
}

export interface OpsStack {
  application: Application;
  database: TestDatabase;
  root: string;
  home: string;
  server: ServerConfig;
  workspaceId: string;
  /** System-principal view of the bootstrapped workspace. */
  workspace: Application;
  ownerLogin: string;
  cleanup(): Promise<void>;
}

/** A migrated PostgreSQL database, one bootstrapped workspace, key files and an evidence root. */
export async function opsStack(
  options: { telemetry?: ServerConfig["telemetry"]; backup?: boolean } = {},
): Promise<OpsStack> {
  const database = await createTestDatabase();
  const root = await mkdtemp(join(tmpdir(), "tm-ops-"));
  const home = join(root, "home");
  await mkdir(home);
  await writeKeyFile(join(root, "master.key"));
  await writeKeyFile(join(root, "backup.key"));
  const server: ServerConfig = {
    mode: "server",
    database: { engine: "postgres", ...database.config },
    storage: { kind: "filesystem", root: join(root, "evidence") },
    server: {
      listen: { host: "127.0.0.1", port: 0 },
      publicOrigin: "https://tm.example",
      trustedProxies: [],
      origins: ["https://tm.example"],
    },
    security: {
      masterKeyFile: join(root, "master.key"),
      backupKeyFile: join(root, "backup.key"),
      atRestEncryption: { database: "operator-volume", evidence: "operator-volume" },
    },
    ...(options.telemetry ? { telemetry: options.telemetry } : {}),
    ...(options.backup === false
      ? {}
      : {
          backup: {
            destination: join(root, "backups"),
            pgDump: testPgDump,
            pgRestore: testPgRestore,
            allowSharedAccess: true,
          },
        }),
  };
  const application = await Application.open({ cwd: root, home, env: {}, server });
  const created = application.operator.bootstrap({
    workspaceName: "Acme",
    ownerLogin: "acme-owner",
  });
  const workspaceId = String(created.workspace.id);
  return {
    application,
    database,
    root,
    home,
    server,
    workspaceId,
    workspace: application.forWorkspaceSystem(workspaceId),
    ownerLogin: "acme-owner",
    async cleanup() {
      application.close();
      await database.drop();
      await rm(root, { recursive: true, force: true });
    },
  };
}

/** A second, empty database plus evidence root, for restore targets. */
export async function restoreTarget(stack: OpsStack): Promise<{
  server: ServerConfig;
  cleanup(): Promise<void>;
}> {
  const database = await createTestDatabase({ migrate: false });
  const evidence = join(stack.root, `restored-evidence-${randomBytes(3).toString("hex")}`);
  return {
    server: {
      ...stack.server,
      database: { engine: "postgres", ...database.config },
      storage: { kind: "filesystem", root: evidence },
    },
    cleanup: () => database.drop(),
  };
}
