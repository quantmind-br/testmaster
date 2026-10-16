import type { StatsFs } from "node:fs";
import * as fs from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as sandbox from "@testmaster/sandbox";
import { afterEach, expect, it, vi } from "vitest";
import { Application, type ApplicationOptions } from "./application.js";
import { runEvidenceBytes, storageMetadataReserveBytes } from "./storage-admission.js";

vi.mock("node:fs/promises", async (importOriginal) => ({
  ...(await importOriginal<typeof fs>()),
}));

const roots: string[] = [];
const applications: Application[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  for (const app of applications.splice(0)) app.close();
  for (const root of roots.splice(0)) await fs.rm(root, { recursive: true, force: true });
});

async function fixture(options: Partial<ApplicationOptions> = { env: {} }) {
  const root = await fs.mkdtemp(join(tmpdir(), "tm-doctor-"));
  roots.push(root);
  await fs.mkdir(join(root, "home"));
  const app = await Application.open({ cwd: root, home: join(root, "home"), ...options });
  applications.push(app);
  await app.init();
  return app;
}
/** A host where Docker, the image lock and the browser sandbox all work; tests degrade one piece. */
async function healthyHost(app: Application, browserExit = 0) {
  const lock = await sandbox.readImageLock(
    new URL("../../../containers/images.lock.json", import.meta.url).pathname,
  );
  vi.spyOn(app, "images").mockResolvedValue(lock);
  vi.spyOn(app.secrets, "health").mockResolvedValue({ backend: "secret-tool", writable: true });
  const doctor = vi.spyOn(sandbox.DockerExecutor.prototype, "doctor").mockResolvedValue({
    available: true,
    mode: "rootful",
    seccomp: true,
    cgroupVersion: "2",
    diagnostics: [],
  });
  vi.spyOn(sandbox.DockerExecutor.prototype, "execute").mockResolvedValue({
    code: browserExit,
  } as never);
  return { doctor };
}
function denied(code: string) {
  return Object.assign(new Error("denied"), { code });
}

it("doctor fails closed on an unsupported Node major and on an unwritable data directory", async () => {
  const app = await fixture();
  await healthyHost(app);
  const healthy = await app.doctor();
  expect(healthy.blocking).toEqual([]);
  expect(healthy.status).toBe("PASS");
  expect(healthy.checks.node).toMatchObject({ status: "PASS", required: ">=24 <25" });
  expect(healthy.checks.writablePaths).toEqual({ status: "PASS" });
  if (app.database.engine === "sqlite")
    expect(healthy.checks.database).toMatchObject({ status: "PASS", journalMode: "wal" });
  else
    expect(healthy.checks.database).toEqual({ status: "PASS", schemaVersion: expect.any(Number) });

  const oldNode = await app.doctor({ nodeVersion: "25.0.0" });
  expect(oldNode.status).toBe("FAIL");
  expect(oldNode.blocking).toContain("node");
  expect(oldNode.checks.node).toMatchObject({ status: "FAIL", actual: "25.0.0" });

  const access = vi.spyOn(fs, "access").mockRejectedValue(denied("EACCES"));
  const readOnly = await app.doctor();
  expect(readOnly.status).toBe("FAIL");
  expect(readOnly.blocking).toContain("writablePaths");
  expect(readOnly.checks.writablePaths).toMatchObject({
    status: "FAIL",
    diagnostics: ["data_dir_not_writable"],
  });
  expect(JSON.stringify(readOnly)).not.toContain(app.config.dataDir);

  access.mockRejectedValueOnce(denied("ENOENT")).mockResolvedValueOnce(undefined);
  const pending = await app.doctor();
  expect(pending.checks.writablePaths).toEqual({ status: "PASS", pendingCreate: true });
});

it("doctor reports blocking failures apart from recommendations and exposes only redacted effective config", async () => {
  const canary = "doctor-config-canary-91f3";
  // exportEffectiveConfig redacts the values of credential-named variables of the real process.
  vi.stubEnv("TESTMASTER_MODEL_API_KEY", canary);
  vi.stubEnv("TESTMASTER_TIMEZONE", "Mars/Olympus_Mons");
  const app = await fixture({ flags: { project: { name: canary } } });
  await healthyHost(app, 1);
  // The raw admission config really holds the canary, so the absence below is redaction, not luck.
  expect(JSON.stringify(app.config.effectiveConfig)).toContain(canary);
  const report = await app.doctor();
  expect(JSON.stringify(report)).not.toContain(canary);
  expect(report.checks.config.effectiveConfig.operationalDefaults).toBeDefined();
  expect(report.status).toBe("PASS");
  expect(report.blocking).toEqual([]);
  expect(report.checks.timezone).toMatchObject({
    status: "WARN",
    configured: "Mars/Olympus_Mons",
    diagnostics: ["timezone_not_iana"],
  });
  expect(report.checks.browserSandbox).toEqual({
    status: "WARN",
    diagnostics: ["browser_sandbox_unavailable"],
  });
  expect(report.recommendations).toEqual(
    expect.arrayContaining([
      expect.stringContaining("IANA"),
      expect.stringContaining("Browser sandbox is unavailable"),
      expect.stringContaining("rootless"),
    ]),
  );
  expect(report.checks.network).toMatchObject({ status: "PASS", telemetry: "disabled" });
});

it("admission refuses a Run when the data directory is not writable before any container starts", async () => {
  const app = await fixture();
  const { doctor } = await healthyHost(app);
  vi.spyOn(fs, "access").mockRejectedValue(denied("EACCES"));
  await expect(app.preflight()).rejects.toMatchObject({
    code: "PRECONDITION_FAILED",
    details: { reasonCode: "storage_not_writable" },
  });
  expect(doctor).not.toHaveBeenCalled();
  expect(app.database.all("SELECT * FROM runs")).toEqual([]);
});

it("refuses admission by free bytes, never by used share, with redacted recovery options", async () => {
  const app = await fixture();
  const storage = vi.spyOn(fs, "statfs");
  const run = runEvidenceBytes(app.config.effectiveConfig.config.execution);
  const needed = run + storageMetadataReserveBytes;
  // 99 % used, yet the free bytes hold one run's worst-case evidence and the reserve: the storage
  // gate passes and the unrelated executor policy stops the request.
  storage.mockResolvedValue({ blocks: 100, bavail: 1, bsize: needed } as StatsFs);
  await expect(app.preflight(false, "process")).rejects.toMatchObject({ code: "POLICY_DENIED" });
  storage.mockResolvedValue({ blocks: 100, bavail: 1, bsize: needed - 1 } as StatsFs);
  const refused = await app.preflight().catch((error: unknown) => error);
  expect(refused).toMatchObject({
    code: "QUOTA_EXCEEDED",
    details: {
      reasonCode: "storage_reserve_insufficient",
      freeBytes: needed - 1,
      requiredBytes: needed,
      incomingRunBytes: run,
      path: "<data-dir>",
      options: expect.arrayContaining([
        expect.stringContaining("worker reconcile"),
        expect.stringContaining("never delete or move files outside TestMaster"),
      ]),
    },
  });
  expect(JSON.stringify(refused)).not.toContain(app.config.dataDir);
  // A run with smaller limits fits in the same free space.
  await expect(app.preflight(false, "process", run - 1)).rejects.toMatchObject({
    code: "POLICY_DENIED",
  });
});
