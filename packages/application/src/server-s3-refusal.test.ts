import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { Application } from "./application.js";
import { filesystemRoot, parseServerConfig } from "./server-config.js";

const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});
const document = (storage: Record<string, unknown>) => ({
  mode: "server",
  database: { engine: "postgres", url: "postgres://testmaster@127.0.0.1:5432/testmaster" },
  storage,
  server: {
    listen: { host: "0.0.0.0", port: 8080 },
    publicOrigin: "https://tm.example",
    trustedProxies: [],
    origins: ["https://tm.example"],
  },
  security: {
    masterKeyFile: "/etc/testmaster/master.key",
    backupKeyFile: "/etc/testmaster/backup.key",
    atRestEncryption: { database: "operator-volume", evidence: "operator-volume" },
  },
});

it("OPS-037 an S3-only server profile is refused with CAPABILITY_UNAVAILABLE and never served from the filesystem", async () => {
  const filesystem = parseServerConfig(document({ kind: "filesystem", root: "/srv/evidence" }));
  expect(filesystemRoot(filesystem.storage)).toBe("/srv/evidence");
  const refused = expect.objectContaining({
    code: "CAPABILITY_UNAVAILABLE",
    details: expect.objectContaining({ capability: "s3-storage", milestone: "M5" }),
  });
  expect(() => parseServerConfig(document({ kind: "s3" }))).toThrowError(refused);
  expect(() => filesystemRoot({ kind: "s3" })).toThrowError(refused);
  // The refusal also holds for an already parsed configuration handed to the application.
  const root = await mkdtemp(join(tmpdir(), "tm-s3-refusal-"));
  roots.push(root);
  await mkdir(join(root, "home"));
  await expect(
    Application.open({
      cwd: root,
      home: join(root, "home"),
      env: {},
      server: { ...filesystem, storage: { kind: "s3" as const } },
    }),
  ).rejects.toMatchObject({ code: "CAPABILITY_UNAVAILABLE" });
});
