import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { exportEffectiveConfig, resolveConfig } from "./config.js";

const directories: string[] = [];
afterEach(async () => {
  for (const directory of directories.splice(0))
    await rm(directory, { recursive: true, force: true });
});
async function fixture(): Promise<{ cwd: string; home: string }> {
  const directory = await mkdtemp(join(tmpdir(), "tm-config-"));
  directories.push(directory);
  const cwd = join(directory, "repo");
  const home = join(directory, "home");
  await mkdir(cwd, { mode: 0o700 });
  await mkdir(join(home, ".config", "testmaster"), { recursive: true, mode: 0o700 });
  return { cwd, home };
}

it("preserves unaffected profile fields while flags and TESTMASTER environment win per leaf", async () => {
  const paths = await fixture();
  await writeFile(
    join(paths.home, ".config", "testmaster", "profiles.json"),
    JSON.stringify({
      defaultProfile: "local",
      profiles: {
        local: {
          config: { schemaVersion: "1.0.0", execution: { concurrency: 1, stepTimeoutMs: 10000 } },
        },
      },
    }),
  );
  await writeFile(
    join(paths.cwd, "testmaster.config.json"),
    JSON.stringify({ schemaVersion: "1.0.0", execution: { concurrency: 2 } }),
  );
  const result = await resolveConfig({
    ...paths,
    env: { TESTMASTER_CONCURRENCY: "3", CONCURRENCY: "99" },
    flags: { execution: { concurrency: 4 } },
  });
  expect(result.effectiveConfig.config.execution?.concurrency).toBe(4);
  expect(result.effectiveConfig.config.execution?.stepTimeoutMs).toBe(10000);
  expect(result.effectiveConfig.origins["execution.concurrency"]).toBe("flag");
  expect(result.effectiveConfig.origins["execution.stepTimeoutMs"]).toBe("profile");
});

it("rejects unsupported profile reasoning effort instead of ignoring it", async () => {
  const paths = await fixture();
  await writeFile(
    join(paths.home, ".config/testmaster/profiles.json"),
    JSON.stringify({
      defaultProfile: "test",
      profiles: {
        test: {
          modelProviders: [
            {
              id: "local",
              kind: "openai-compatible",
              baseUrl: "http://127.0.0.1:1234/v1",
              apiKeyEnv: "KEY",
              models: [
                { id: "model", capabilities: { structuredJson: true }, reasoningEffort: "extreme" },
              ],
            },
          ],
        },
      },
    }),
  );
  await expect(resolveConfig({ ...paths, env: {} })).rejects.toMatchObject({
    code: "INVALID_ARGUMENT",
  });
});

it("rejects unknown repository and flag keys rather than silently dropping security requests", async () => {
  const paths = await fixture();
  await writeFile(
    join(paths.cwd, "testmaster.config.json"),
    '{"schemaVersion":"1.0.0","execution":{"concurency":99}}',
  );
  await expect(resolveConfig({ ...paths, env: {} })).rejects.toMatchObject({
    code: "INVALID_ARGUMENT",
  });
  await writeFile(
    join(paths.cwd, "testmaster.config.json"),
    '{"schemaVersion":"1.0.0","modelProviders":["external"]}',
  );
  await expect(resolveConfig({ ...paths, env: {} })).rejects.toMatchObject({
    code: "INVALID_ARGUMENT",
  });
  await writeFile(join(paths.cwd, "testmaster.config.json"), '{"schemaVersion":"1.0.0"}');
  await expect(
    resolveConfig({ ...paths, env: {}, flags: JSON.parse('{"upload":true}') }),
  ).rejects.toMatchObject({ code: "INVALID_ARGUMENT" });
  await expect(
    resolveConfig({ ...paths, env: {}, flags: JSON.parse('{"__proto__":{"polluted":true}}') }),
  ).rejects.toMatchObject({ code: "INVALID_ARGUMENT" });
  expect(Object.prototype).not.toHaveProperty("polluted");
});

it("intersects profile ceilings with operator authorization and refuses a flag escalation", async () => {
  const paths = await fixture();
  await writeFile(
    join(paths.home, ".config", "testmaster", "policy.json"),
    JSON.stringify({
      limits: { maxAttempts: 2 },
      allowedModelProviders: ["local", "external"],
      allowUpload: true,
    }),
  );
  await writeFile(
    join(paths.home, ".config", "testmaster", "profiles.json"),
    JSON.stringify({
      profiles: {
        restricted: {
          policy: {
            limits: { maxAttempts: 1 },
            allowedModelProviders: ["local"],
            allowUpload: false,
          },
        },
      },
    }),
  );
  const options = {
    ...paths,
    profile: "restricted",
    env: {},
    flags: { execution: { maxAttempts: 1 } },
  };
  const result = await resolveConfig(options);
  expect(result.profilePolicy.allowedModelProviders).toEqual(["local"]);
  expect(result.profilePolicy.allowUpload).toBe(false);
  await expect(
    resolveConfig({ ...options, flags: { execution: { maxAttempts: 2 } } }),
  ).rejects.toMatchObject({ code: "POLICY_DENIED" });
});

it("does not let a profile grant process execution without operator user policy", async () => {
  const paths = await fixture();
  await writeFile(
    join(paths.home, ".config", "testmaster", "profiles.json"),
    JSON.stringify({
      profiles: {
        unsafe: {
          config: { schemaVersion: "1.0.0", execution: { executor: "process" } },
          policy: { security: { allowUnsafeProcessExecution: true } },
        },
      },
    }),
  );
  await expect(resolveConfig({ ...paths, profile: "unsafe", env: {} })).rejects.toMatchObject({
    code: "POLICY_DENIED",
  });
});

it("CI disables healing and offline disables model and upload grants", async () => {
  const paths = await fixture();
  await writeFile(
    join(paths.home, ".config", "testmaster", "policy.json"),
    JSON.stringify({ allowedModelProviders: ["external"], allowUpload: true }),
  );
  const result = await resolveConfig({
    ...paths,
    env: { CI: "true", TESTMASTER_OFFLINE: "true" },
    flags: { healing: { mode: "apply" } },
  });
  expect(result.effectiveConfig.config.healing?.mode).toBe("off");
  expect(result.profilePolicy.allowedModelProviders).toEqual([]);
  expect(result.profilePolicy.allowUpload).toBe(false);
});

it("exports the normative local defaults and labels future operational controls unavailable", async () => {
  const paths = await fixture();
  const result = exportEffectiveConfig(await resolveConfig({ ...paths, env: {} }), {});
  expect(result.config.execution).toMatchObject({
    concurrency: 2,
    executionTimeoutMs: 1800000,
    attemptTimeoutMs: 300000,
    stepTimeoutMs: 30000,
    networkRequestTimeoutMs: 30000,
    preparationTimeoutMs: 120000,
    collectionGraceMs: 60000,
    analysisGraceMs: 60000,
    maxAttempts: 2,
    bodyBytes: 10485760,
    artifactBytes: 67108864,
    attemptArtifactBytes: 268435456,
    logBytes: 10485760,
  });
  expect(result.config.artifacts).toEqual({
    trace: "off",
    video: "off",
    httpBodies: "off",
    retentionDays: 30,
  });
  expect(result.operationalDefaults).toEqual({
    controllerBind: "127.0.0.1",
    httpRequestsPerAttempt: 4,
    llmTransportRetries: 1,
    browserCpu: 2,
    browserMemoryBytes: 2147483648,
    browserPids: 256,
    httpCpu: 1,
    httpMemoryBytes: 536870912,
    httpPids: 128,
    pythonCpu: 1,
    pythonMemoryBytes: 1073741824,
    pythonPids: 128,
    rawArtifactBytes: 268435456,
    storageWarningPercent: 80,
    storageSuspendPercent: 90,
    tenantActiveJobs: 1000,
    actorAdmissionsPerMinute: 60,
    actorAdmissionBurst: 20,
    maxPageSize: 100,
    signedLinkMs: 300000,
    tunnelMs: 900000,
    tunnelMaxMs: 3600000,
    tunnelStreams: 32,
    tunnelBytesPerSecond: 10485760,
    tunnelTotalBytes: 536870912,
    localBackup: "manual",
    serverBackup: "daily",
    backupDailyCopies: 7,
    backupWeeklyCopies: 4,
    backupMonthlyCopies: 3,
    scheduleMisfire: "skip",
    scheduleGraceMs: 300000,
    scheduleOverlap: "forbid",
    logRetentionDays: 14,
    executionTimeoutMs: 1800000,
    attemptTimeoutMs: 300000,
    stepTimeoutMs: 30000,
    networkRequestTimeoutMs: 30000,
    preparationTimeoutMs: 120000,
    collectionGraceMs: 60000,
    analysisGraceMs: 60000,
    maxAttempts: 2,
    browserConcurrency: 2,
    httpConcurrency: 4,
    pythonConcurrency: 1,
    batchCells: 500,
    workerHeartbeatMs: 10000,
    workerLeaseMs: 30000,
    cancellationGraceMs: 10000,
    tempBytes: 1073741824,
    bodyBytes: 10485760,
    artifactBytes: 67108864,
    attemptArtifactBytes: 268435456,
    logBytes: 10485760,
    pageSize: 50,
    manualAuthCheckpointMs: 300000,
    approvalMs: 1800000,
    artifactRetentionDays: 30,
    metadataRetentionDays: 90,
    auditRetentionDays: 365,
    llmEnabled: false,
    telemetryEnabled: false,
  });
  expect(result.unavailable.schedule).toBe("M4");
  expect(result.config.telemetry?.enabled).toBe(false);
});

it("redacts env secrets and credential URL patterns from exported config without mutating admission config", async () => {
  const paths = await fixture();
  const secret = "private-config-canary";
  const resolved = await resolveConfig({
    ...paths,
    env: {
      TESTMASTER_BASE_URL: `http://127.0.0.1:3000/?token=${secret}`,
      TESTMASTER_MODEL_API_KEY: secret,
    },
    flags: { project: { name: secret } },
  });
  const exported = JSON.stringify(
    exportEffectiveConfig(resolved, { TESTMASTER_MODEL_API_KEY: secret }),
  );
  expect(exported).not.toContain(secret);
  expect(resolved.effectiveConfig.config.project?.name).toBe(secret);
});

it("validates operator log retention and exposes it without changing artifact retention", async () => {
  const paths = await fixture();
  const resolved = await resolveConfig({ ...paths, env: { TESTMASTER_LOG_RETENTION_DAYS: "7" } });
  expect(exportEffectiveConfig(resolved, {}).logging.retentionDays).toBe(7);
  expect(resolved.effectiveConfig.config.artifacts?.retentionDays).toBe(30);
  for (const value of ["0", "366", "typo"])
    await expect(
      resolveConfig({ ...paths, env: { TESTMASTER_LOG_RETENTION_DAYS: value } }),
    ).rejects.toMatchObject({ code: "INVALID_ARGUMENT" });
});
