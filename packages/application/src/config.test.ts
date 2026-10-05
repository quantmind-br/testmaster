import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { resolveConfig } from "./config.js";

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
