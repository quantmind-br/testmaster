import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { Application } from "./index.js";

const directories: string[] = [];
const applications: Application[] = [];
afterEach(async () => {
  for (const application of applications.splice(0)) application.close();
  for (const directory of directories.splice(0))
    await rm(directory, { recursive: true, force: true });
});
async function open(): Promise<Application> {
  const directory = await mkdtemp(join(tmpdir(), "tm-worker-gate-"));
  directories.push(directory);
  const application = await Application.open({ cwd: directory, home: directory, env: {} });
  applications.push(application);
  await application.init();
  return application;
}

it("OPS-038 a worker whose build is older than the database stops claiming and ends with worker_schema_behind", async () => {
  const application = await open();
  // Positive control: at the supported schema the same loop drains cleanly.
  await expect(application.worker.run({ ephemeral: true, runIds: [] })).resolves.toMatchObject({
    drained: true,
  });
  expect(application.database.schemaCompatibility().state).toBe("current");
  // The database is upgraded by a newer build while this worker is still running.
  const supported = application.database.schemaCompatibility().supportedVersion;
  application.database.withTx(() =>
    application.database.run(
      "INSERT INTO schema_migrations(version,name,checksum,applied_at) VALUES(?,?,?,?)",
      supported + 1,
      "newer_release",
      "0".repeat(64),
      new Date().toISOString(),
    ),
  );
  expect(application.database.schemaCompatibility()).toMatchObject({
    state: "ahead",
    databaseVersion: supported + 1,
    supportedVersion: supported,
  });
  await expect(application.worker.run({ ephemeral: true, runIds: [] })).rejects.toMatchObject({
    code: "PRECONDITION_FAILED",
    details: {
      reasonCode: "worker_schema_behind",
      databaseVersion: supported + 1,
      supportedVersion: supported,
    },
  });
});
