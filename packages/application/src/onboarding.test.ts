import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { Application } from "./application.js";
import { entity } from "./context.js";
import { type OnboardingProbes, OnboardingService } from "./onboarding.js";

const apps: Application[] = [];
const roots: string[] = [];
afterEach(async () => {
  for (const app of apps.splice(0)) app.close();
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});
async function fixture(probes: Partial<OnboardingProbes> = {}) {
  const root = await mkdtemp(join(tmpdir(), "tm-onboarding-"));
  roots.push(root);
  const home = join(root, "home");
  await mkdir(home);
  const app = await Application.open({ cwd: root, home, env: { HOME: home } });
  apps.push(app);
  const init = await app.init();
  const reach = vi.fn(probes.reach ?? (async () => ({ status: 200 })));
  const service = new OnboardingService(app.context, app.config, {
    runner: async () => ({ available: true, mode: "rootless", diagnostics: [] }),
    resolve: async () => ["93.184.216.34"],
    ...probes,
    reach,
  });
  const secret = (fields: Record<string, unknown>) => {
    const value = entity(app.context, "sec", {
      provider: "env",
      locator: "TARGET_TOKEN",
      secretVersion: 1,
      allowedOrigins: ["http://127.0.0.1:4010"],
      revokedAt: null,
      ...fields,
    });
    app.context.entities.insert("SecretReference", value);
    return value.id;
  };
  return {
    app,
    service,
    projectId: init.projectId,
    environmentId: init.environmentId,
    reach,
    secret,
  };
}
const target = (baseUrl: string, networkProfile = "local-loopback" as const) => ({
  baseUrl,
  networkProfile,
});

it("UX-009 resumes the saved step, choices and history for the same principal and project", async () => {
  const { service, projectId, app } = await fixture();
  const fresh = service.get(projectId);
  expect(fresh).toMatchObject({
    saved: false,
    version: 1,
    currentStep: "mode",
    completedSteps: [],
  });
  const saved = service.save(
    projectId,
    {
      currentStep: "target",
      completedSteps: ["mode", "project"],
      choices: { mode: "local", target: target("http://127.0.0.1:4010") },
    },
    1,
  );
  expect(saved).toMatchObject({ saved: true, version: 2, currentStep: "target" });
  const resumed = service.get(projectId);
  expect(resumed.choices.target?.baseUrl).toBe("http://127.0.0.1:4010");
  expect(resumed.completedSteps).toEqual(["mode", "project"]);
  expect(resumed.history.map((entry) => entry.event)).toEqual(["completed", "completed"]);
  // Negative control: another principal starts from an unsaved wizard, and a stale writer conflicts.
  const other = new OnboardingService(
    { ...app.context, principalId: "usr_other" },
    app.config,
    service.probes,
  );
  expect(other.get(projectId)).toMatchObject({ saved: false, currentStep: "mode" });
  expect(() =>
    service.save(projectId, { currentStep: "mode", completedSteps: [], choices: {} }, 1),
  ).toThrowError(expect.objectContaining({ code: "REVISION_CONFLICT" }));
  const revisited = service.save(
    projectId,
    { currentStep: "project", completedSteps: ["mode", "project"], choices: resumed.choices },
    2,
  );
  expect(revisited.history.at(-1)?.event).toBe("revisited");
});

it("UX-009 never stores credentials and reduces the target to an origin", async () => {
  const { service, projectId, app, secret } = await fixture();
  const save = (choices: Record<string, unknown>, version = 1) =>
    service.save(
      projectId,
      { currentStep: "target", completedSteps: [], choices } as never,
      version,
    );
  // Negative controls: every credential-shaped input is refused and nothing is persisted.
  expect(() => save({ target: target("http://user:hunter2@127.0.0.1:4010") })).toThrowError(
    expect.objectContaining({ code: "INVALID_ARGUMENT" }),
  );
  expect(() => save({ target: target("http://127.0.0.1:4010/?token=abc123def456") })).toThrowError(
    expect.objectContaining({ code: "INVALID_ARGUMENT" }),
  );
  expect(() => save({ password: "hunter2" })).toThrowError(
    expect.objectContaining({ code: "INVALID_ARGUMENT" }),
  );
  for (const command of [
    "export API_TOKEN=abcdef123456",
    "curl -H 'Authorization: Bearer abcdefghijklmnop'",
    "-----BEGIN PRIVATE KEY-----",
    "psql postgres://app:hunter2@db/app",
  ])
    expect(() =>
      save({ target: { ...target("http://127.0.0.1:4010"), prepareCommands: [command] } }),
    ).toThrowError(expect.objectContaining({ code: "INVALID_ARGUMENT" }));
  expect(service.get(projectId).saved).toBe(false);
  // Positive control: plain commands and secret *references* are accepted; the URL keeps only its origin.
  const secretId = secret({});
  const stored = save(
    {
      target: {
        ...target("http://127.0.0.1:4010/app/login"),
        prepareCommands: ["pnpm install", "pnpm dev --port 4010"],
      },
      authSecretRefs: [secretId],
    },
    1,
  );
  expect(stored.choices.target?.baseUrl).toBe("http://127.0.0.1:4010");
  expect(stored.choices.authSecretRefs).toEqual([secretId]);
  const row = app.context.database.get(
    "SELECT value FROM operational_state WHERE key LIKE 'onboarding:%'",
  );
  expect(String(row?.value)).not.toMatch(/hunter2|abc123def456|Bearer/u);
});

it("UX-009 refuses to complete a step whose choice is missing and rejects foreign references", async () => {
  const { service, projectId, app } = await fixture();
  expect(() =>
    service.save(projectId, { currentStep: "target", completedSteps: ["source"], choices: {} }, 1),
  ).toThrowError(expect.objectContaining({ code: "PRECONDITION_FAILED" }));
  expect(() =>
    service.save(
      projectId,
      {
        currentStep: "source",
        completedSteps: [],
        choices: { sourceIds: ["src_00000000-0000-7000-8000-000000000000"] },
      },
      1,
    ),
  ).toThrowError(expect.objectContaining({ code: "NOT_FOUND" }));
  const other = app.projects.create({ name: "Other" });
  const otherEnvironment = app.environments.create({
    projectId: other.id,
    name: "other",
    baseUrl: "http://127.0.0.1:4011",
  });
  expect(() =>
    service.save(
      projectId,
      {
        currentStep: "environment",
        completedSteps: [],
        choices: { environmentId: otherEnvironment.id },
      },
      1,
    ),
  ).toThrowError(expect.objectContaining({ code: "FORBIDDEN" }));
});

it("UX-010 reports a missing runner with its own reason and never falls back", async () => {
  const { service, projectId } = await fixture({
    runner: async () => ({
      available: false,
      mode: "unknown",
      diagnostics: ["docker_daemon_unavailable"],
    }),
  });
  const report = await service.check(projectId, {
    targetUrl: "http://127.0.0.1:4010",
    networkProfile: "local-loopback",
  });
  const runner = report.checks.find((check) => check.id === "runner");
  expect(runner).toMatchObject({
    status: "failed",
    reasonCode: "security_precondition_failed",
    diagnostic: "docker_daemon_unavailable",
  });
  expect(runner?.nextAction).toMatch(/never falls back/u);
  expect(report.ready).toBe(false);
  // The other prerequisites are still evaluated independently of the runner.
  expect(report.checks.find((check) => check.id === "policy")?.status).toBe("passed");
});

it("UX-010 denies a target by policy and never contacts it", async () => {
  const { service, projectId, reach } = await fixture();
  const report = await service.check(projectId, {
    targetUrl: "http://127.0.0.1:4010",
    networkProfile: "public",
  });
  expect(report.checks.find((check) => check.id === "policy")).toMatchObject({
    status: "failed",
    reasonCode: "egress_denied",
    diagnostic: "address_denied:loopback",
  });
  expect(report.checks.find((check) => check.id === "target")?.status).toBe("not_checked");
  expect(reach).not.toHaveBeenCalled();
  // Negative control: a metadata address is denied even under the private profile.
  const metadata = await service.check(projectId, {
    targetUrl: "http://169.254.169.254",
    networkProfile: "private",
  });
  expect(metadata.checks.find((check) => check.id === "policy")?.diagnostic).toBe(
    "address_denied:metadata",
  );
  const ambiguous = await service.check(projectId, {
    targetUrl: "http://127.0.0.1:4010@evil.example",
    networkProfile: "public",
  });
  expect(ambiguous.checks.find((check) => check.id === "policy")?.reasonCode).toBe("egress_denied");
});

it("UX-010 distinguishes an unreachable target from a policy denial", async () => {
  const { service, projectId, reach } = await fixture({
    reach: async () => ({ error: "connect ECONNREFUSED 127.0.0.1:4010" }),
  });
  const report = await service.check(projectId, {
    targetUrl: "http://127.0.0.1:4010",
    networkProfile: "local-loopback",
  });
  expect(report.checks.find((check) => check.id === "policy")?.status).toBe("passed");
  expect(report.checks.find((check) => check.id === "target")).toMatchObject({
    status: "failed",
    reasonCode: null,
    diagnostic: "target_unreachable",
  });
  expect(reach).toHaveBeenCalledOnce();
  expect(report.ready).toBe(false);
});

it("UX-010 flags missing, revoked and wrong-origin credentials separately and passes a healthy setup", async () => {
  const { service, projectId, secret } = await fixture();
  const input = { targetUrl: "http://127.0.0.1:4010", networkProfile: "local-loopback" as const };
  const authOf = async (secretRefs: string[]) =>
    (await service.check(projectId, { ...input, secretRefs })).checks.find(
      (check) => check.id === "auth",
    );
  expect(await authOf(["sec_00000000-0000-7000-8000-000000000000"])).toMatchObject({
    reasonCode: "missing_secret",
  });
  expect(await authOf([secret({ revokedAt: "2026-01-01T00:00:00.000Z" })])).toMatchObject({
    reasonCode: "credential_revoked",
  });
  expect(await authOf([secret({ allowedOrigins: ["https://other.example"] })])).toMatchObject({
    reasonCode: "egress_denied",
    diagnostic: "secret_origin_not_allowed",
  });
  const good = secret({});
  const healthy = await service.check(projectId, { ...input, secretRefs: [good] });
  expect(healthy.ready).toBe(true);
  expect(healthy.checks.map((check) => check.status)).toEqual([
    "passed",
    "passed",
    "passed",
    "passed",
  ]);
});
