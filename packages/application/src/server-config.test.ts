import { chmod, mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { implementedFeatures } from "@testmaster/contracts";
import { afterEach, expect, it } from "vitest";
import { localDataDir, parseServerConfig, readServerConfig } from "./server-config.js";

const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});
const document = (overrides: Record<string, unknown> = {}) => ({
  mode: "server",
  database: { engine: "postgres", url: "postgres://testmaster@127.0.0.1:5432/testmaster" },
  storage: { kind: "filesystem", root: "/var/lib/testmaster/evidence" },
  server: {
    listen: { host: "0.0.0.0", port: 8080 },
    publicOrigin: "https://tm.example",
    trustedProxies: ["10.0.0.0/8"],
    origins: ["https://tm.example"],
  },
  security: {
    masterKeyFile: "/etc/testmaster/master.key",
    backupKeyFile: "/etc/testmaster/backup.key",
    atRestEncryption: { database: "operator-volume", evidence: "operator-volume" },
  },
  ...overrides,
});
async function scratch() {
  const root = await mkdtemp(join(tmpdir(), "tm-server-config-"));
  roots.push(root);
  return root;
}

const s3Location = {
  endpoint: "https://s3.example:9000",
  region: "eu-1",
  bucket: "evidence",
  forcePathStyle: true,
  accessKeyIdFile: "/etc/testmaster/s3-access-key-id",
  secretAccessKeyFile: "/etc/testmaster/s3-secret-access-key",
};
const distributed = (overrides: Record<string, unknown> = {}) => {
  const base = document();
  return {
    ...base,
    mode: "distributed",
    storage: { kind: "s3", ...s3Location, capacityBytes: 1_000_000, stagingRoot: "/var/tmp/tm" },
    server: { ...base.server, internalOrigin: "https://controller-1.internal:8443" },
    ...overrides,
  };
};
const refusal = (value: unknown) => {
  try {
    parseServerConfig(value);
  } catch (error) {
    return error as { code: string; details: Record<string, unknown> };
  }
  return undefined;
};

it("OPS-001 the distributed profile needs PostgreSQL and shared storage and refuses to degrade", () => {
  const parsed = parseServerConfig(distributed());
  expect(parsed.mode).toBe("distributed");
  expect(parsed.storage).toMatchObject({
    kind: "s3",
    bucket: "evidence",
    stagingRoot: "/var/tmp/tm",
  });
  expect(localDataDir(parsed.storage)).toBe("/var/tmp/tm");
  expect(refusal(distributed({ database: { engine: "sqlite", url: "x" } }))).toMatchObject({
    code: "POLICY_DENIED",
    details: { reasonCode: "distributed_requires_postgres" },
  });
  expect(
    refusal(distributed({ storage: { kind: "filesystem", root: "/var/lib/tm" } })),
  ).toMatchObject({
    code: "POLICY_DENIED",
    details: { reasonCode: "distributed_requires_shared_storage" },
  });
});

it("OPS-001 S3 storage in the server profile needs a complete location and the internal origin follows the mode", () => {
  const incomplete = { kind: "s3", ...s3Location, capacityBytes: 1, stagingRoot: "/var/tmp/tm" };
  expect(refusal(document({ storage: incomplete }))).toBeUndefined();
  expect(refusal(document({ storage: { kind: "s3" } }))?.code).toBe("INVALID_ARGUMENT");
  expect(refusal(document({ storage: { ...incomplete, capacityBytes: 0 } }))?.code).toBe(
    "INVALID_ARGUMENT",
  );
  const base = distributed();
  const { internalOrigin: _omitted, ...withoutOrigin } = base.server;
  expect(refusal(distributed({ server: withoutOrigin }))?.code).toBe("INVALID_ARGUMENT");
  expect(
    refusal(document({ server: { ...document().server, internalOrigin: "https://x.internal" } }))
      ?.code,
  ).toBe("INVALID_ARGUMENT");
  expect(
    parseServerConfig(distributed({ server: { ...base.server, expectedControllers: 3 } })).server
      .expectedControllers,
  ).toBe(3);
  expect(refusal(distributed({ server: { ...base.server, expectedControllers: 0 } }))?.code).toBe(
    "INVALID_ARGUMENT",
  );
});

it("SEC-030 a backup destination that shares the evidence storage identity is refused", () => {
  const backup = (destination: Record<string, unknown>) =>
    distributed({ backup: { destination: { kind: "s3", ...s3Location, ...destination } } });
  // Same endpoint and bucket: one outage or one deletion takes both copies.
  expect(refusal(backup({}))).toMatchObject({
    code: "POLICY_DENIED",
    details: { reasonCode: "backup_shares_storage_identity" },
  });
  // Same credential file: one leaked credential reaches both copies.
  expect(
    refusal(
      backup({
        endpoint: "https://backup.example:9000",
        bucket: "backups",
        secretAccessKeyFile: s3Location.secretAccessKeyFile,
        accessKeyIdFile: "/etc/testmaster/backup-access-key-id",
      }),
    ),
  ).toMatchObject({ details: { reasonCode: "backup_shares_storage_identity" } });
  // Positive control: a separate endpoint, bucket and credentials is accepted.
  expect(
    refusal(
      backup({
        endpoint: "https://backup.example:9000",
        bucket: "backups",
        accessKeyIdFile: "/etc/testmaster/backup-access-key-id",
        secretAccessKeyFile: "/etc/testmaster/backup-secret-access-key",
      }),
    ),
  ).toBeUndefined();
});

it("ADR-016 rejects deployment documents with passwords, plaintext public origins and missing at-rest attestation", () => {
  const issues = (value: unknown) => {
    try {
      parseServerConfig(value);
    } catch (error) {
      return JSON.stringify((error as { issues?: unknown; details?: unknown }).details);
    }
    return "";
  };
  expect(issues(document())).toBe("");
  expect(
    issues(
      document({ database: { engine: "postgres", url: "postgres://u:secret@db.example:5432/tm" } }),
    ),
  ).toContain("must not contain a password");
  expect(
    issues(document({ server: { ...document().server, publicOrigin: "http://tm.example" } })),
  ).toContain("https origin");
  expect(
    issues(
      document({ security: { ...document().security, atRestEncryption: { database: "none" } } }),
    ),
  ).toContain("operator-volume");
  expect(issues(document({ extra: true }))).toContain("extra");
});

it("ADR-016 reads the deployment file only when it is a private regular file owned by the caller", async () => {
  const root = await scratch();
  const path = join(root, "server.json");
  await writeFile(path, JSON.stringify(document()), { mode: 0o600 });
  expect((await readServerConfig(path)).server.publicOrigin).toBe("https://tm.example");
  await chmod(path, 0o644);
  await expect(readServerConfig(path)).rejects.toMatchObject({ code: "POLICY_DENIED" });
  await chmod(path, 0o600);
  const link = join(root, "link.json");
  await symlink(path, link);
  await expect(readServerConfig(link)).rejects.toMatchObject({ code: "POLICY_DENIED" });
  await expect(readServerConfig("relative.json")).rejects.toMatchObject({
    code: "INVALID_ARGUMENT",
  });
  await expect(readServerConfig(join(root, "missing.json"))).rejects.toMatchObject({
    code: "NOT_FOUND",
  });
});

it("ADR-016 advertises the identity, server and PostgreSQL features as implemented from one registry", () => {
  for (const feature of ["server", "postgres", "multi-user", "identity", "distributed"])
    expect(implementedFeatures.has(feature)).toBe(true);
});
