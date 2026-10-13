import { chmod, mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { implementedFeatures } from "@testmaster/contracts";
import { afterEach, expect, it } from "vitest";
import { Application } from "./application.js";
import { filesystemRoot, parseServerConfig, readServerConfig } from "./server-config.js";

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

it("ADR-016 refuses S3 storage with CAPABILITY_UNAVAILABLE for M5 and never falls back to the filesystem", async () => {
  const expected = expect.objectContaining({
    code: "CAPABILITY_UNAVAILABLE",
    details: expect.objectContaining({ capability: "s3-storage", milestone: "M5" }),
  });
  expect(() => parseServerConfig(document({ storage: { kind: "s3" } }))).toThrowError(expected);
  expect(() => filesystemRoot({ kind: "s3" })).toThrowError(expected);
  const root = await scratch();
  const home = join(root, "home");
  await mkdir(home);
  const config = { ...parseServerConfig(document()), storage: { kind: "s3" as const } };
  await expect(
    Application.open({ cwd: root, home, env: {}, server: config }),
  ).rejects.toMatchObject({
    code: "CAPABILITY_UNAVAILABLE",
  });
  // Positive control: the filesystem option is accepted and resolves to its root.
  expect(filesystemRoot(parseServerConfig(document()).storage)).toBe(
    "/var/lib/testmaster/evidence",
  );
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
  for (const feature of ["server", "postgres", "multi-user", "identity"])
    expect(implementedFeatures.has(feature)).toBe(true);
  expect(implementedFeatures.has("s3-storage")).toBe(false);
});
