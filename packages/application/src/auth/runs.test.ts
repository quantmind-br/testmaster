import type * as ChildProcess from "node:child_process";
import type { ExecutablePlan } from "@testmaster/contracts";
import { AttemptExecutor, type DockerAttempt } from "@testmaster/sandbox";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import {
  type AuthLab,
  defaults,
  httpFormConfig,
  openLab,
  type ReferenceAuth,
} from "../../test/auth-lab.js";
import { scaffoldPlan } from "../authoring.js";

// Hermetic: the encrypted file vault, never the host keyring.
vi.mock("node:child_process", async (importOriginal) => ({
  ...(await importOriginal<typeof ChildProcess>()),
  spawn: vi.fn(() => {
    throw Object.assign(new Error("Unavailable"), { code: "ENOENT" });
  }),
}));
const labs: AuthLab[] = [];
const ci = process.env.CI;
beforeEach(() => {
  process.env.CI = "true";
});
afterEach(async () => {
  vi.restoreAllMocks();
  if (ci === undefined) delete process.env.CI;
  else process.env.CI = ci;
  for (const lab of labs.splice(0)) await lab.close();
});

/** A backend plan whose request carries the managed credential as its Authorization header. */
function planWith(secretRef: string): ExecutablePlan {
  const plan = scaffoldPlan("backend");
  const request = plan.steps.find((step) => step.operation === "request");
  if (request?.operation !== "request") throw new Error("Request step missing");
  request.input.headers = { authorization: { secretRef } };
  return plan;
}
async function runLab(
  options: { wrongPassword?: boolean; kind?: "token" | "session"; plainUsername?: boolean } = {},
): Promise<{
  current: AuthLab;
  site: ReferenceAuth;
  profileId: string;
  secretId: string;
  testId: string;
  environmentId: string;
  executions: DockerAttempt[];
  run(
    request?: Record<string, unknown>,
  ): Promise<{ id: string; outcome: unknown; reasonCode: unknown; authFailure?: string }>;
}> {
  const current = await openLab();
  labs.push(current);
  const app = current.app;
  app.preflight = async () => {};
  const username = options.plainUsername
    ? undefined
    : await current.secret("run-user", defaults.username);
  const password = await current.secret(
    "run-pass",
    options.wrongPassword ? "not-the-password" : defaults.password,
  );
  const profile = await current.profile({
    name: "run-login",
    kind: "form",
    config: httpFormConfig(current.site, {
      success: { statusIn: [200], tokenPointer: "/token" },
    }),
    ...(username === undefined
      ? { username: defaults.username, secrets: { password } }
      : { secrets: { username, password } }),
  });
  const secretId = profile.managedSecrets.token as string;
  const env = current.environment("run-env", [profile.id]);
  const test = app.tests.create({ projectId: current.projectId, plan: planWith(secretId) });
  const executions: DockerAttempt[] = [];
  vi.spyOn(AttemptExecutor.prototype, "execute").mockImplementation(async (input) => {
    executions.push(input as unknown as DockerAttempt);
    return { outcome: "passed", reasonCode: "passed", logDropped: 0, events: [] };
  });
  return {
    current,
    site: current.site,
    profileId: profile.id,
    secretId,
    testId: test.id,
    environmentId: env.id,
    executions,
    async run(request = {}) {
      const receipt = await app.runs.admit(
        {
          testId: test.id,
          environmentId: env.id,
          extensions: { "testmaster:executor": "process" },
          ...request,
        },
        { wait: true },
      );
      await app.worker.run({ ephemeral: true, runIds: [receipt.runId] });
      const run = app.runs.get(receipt.runId);
      const failure = app.runs
        .events(receipt.runId)
        .find((event) => event.type === "run.execution_error");
      const details = (failure?.payload.details ?? {}) as { authFailure?: string };
      return {
        id: run.id,
        outcome: run.outcome,
        reasonCode: failure?.payload.reasonCode,
        authFailure: details.authFailure,
      };
    },
  };
}

/** Waits for the waiting Run to record its checkpoint. */
async function pendingCheckpoint(lab: { current: AuthLab }): Promise<string> {
  return await vi.waitFor(
    () => {
      const id = lab.current.app.authCheckpoints.list({ state: "pending" })[0]?.id;
      if (!id) throw new Error("No pending checkpoint yet");
      return id;
    },
    { timeout: 20_000, interval: 50 },
  );
}

it("M4-03 REQ-018 SEC-023 a Run signs in before any credential is released and hands the Attempt the managed secret", async () => {
  const lab = await runLab();
  await lab.run();
  expect(lab.site.counters.logins).toBe(1);
  expect(lab.executions).toHaveLength(1);
  const released = lab.executions[0]?.secretRefs ?? [];
  expect(released.map((release) => release.secretRef)).toContain(lab.secretId);
  const managed = released.find((release) => release.secretRef === lab.secretId);
  const value = await managed?.resolve();
  expect(value).toMatch(/^Bearer /u);
  const me = await fetch(`${lab.site.url}/api/me`, { headers: { authorization: String(value) } });
  expect(me.status).toBe(200);
  // A second Run reuses the still-valid session instead of logging in again.
  await lab.run();
  expect(lab.site.counters.logins).toBe(1);
  // Negative control: an explicit login is a new login, so the count above is not a constant.
  await lab.current.app.authProfiles.testLogin(lab.profileId, lab.environmentId);
  expect(lab.site.counters.logins).toBe(2);
});

it("SEC-022 a Run signs in with a plain username and the Attempt receives no secret holding it", async () => {
  const lab = await runLab({ plainUsername: true });
  await lab.run();
  const logins = lab.site.requests.filter((request) => request.path === "/api/login");
  expect(logins).toHaveLength(1);
  expect(JSON.parse(logins[0]?.body ?? "{}")).toMatchObject({
    username: defaults.username,
    password: defaults.password,
  });
  // The Attempt resolves the managed session only: nothing it can redact equals the username.
  const released = await Promise.all(
    (lab.executions[0]?.secretRefs ?? []).map((release) => release.resolve()),
  );
  expect(released.some((value) => String(value).startsWith("Bearer "))).toBe(true);
  expect(released).not.toContain(defaults.username);
  expect(released).not.toContain(defaults.password);
});

it("M4-03 SEC-023 a rejected login blocks the Run before the Attempt starts and is not an assertion failure", async () => {
  const lab = await runLab({ wrongPassword: true });
  const blocked = await lab.run();
  expect(blocked.outcome).toBe("blocked");
  expect(blocked.reasonCode).toBe("manual_auth_required");
  expect(lab.executions).toHaveLength(0);
  expect(lab.site.counters.loginFailures).toBe(1);
  const events = lab.current.app.runs.events(blocked.id);
  const blockedEvent = events.find((event) => event.type.includes("blocked"));
  expect(JSON.stringify(blockedEvent ?? events)).not.toContain("not-the-password");
  // A second Run inside the cooldown does not hammer the target.
  const again = await lab.run();
  expect(again.outcome).toBe("blocked");
  expect(lab.site.counters.loginFailures).toBe(1);
});

it("M4-03 SEC-024 a CAPTCHA in a non-interactive Run records a checkpoint and blocks before any dependent action", async () => {
  const lab = await runLab();
  lab.site.control.captcha = true;
  const blocked = await lab.run();
  expect(blocked).toMatchObject({ outcome: "blocked", reasonCode: "manual_auth_required" });
  expect(lab.executions).toHaveLength(0);
  const pending = lab.current.app.authCheckpoints.list({ runId: blocked.id });
  expect(pending).toHaveLength(1);
  expect(pending[0]).toMatchObject({
    state: "pending",
    kind: "captcha",
    authProfileId: lab.profileId,
  });
  // The solver was never invoked: the target saw exactly the one rejected login.
  expect(lab.site.requests.filter((request) => request.path === "/api/login")).toHaveLength(1);
  // Negative control: without the CAPTCHA the same Run proceeds to its Attempt.
  lab.site.control.captcha = false;
  await lab.current.app.authProfiles.testLogin(lab.profileId, lab.environmentId);
  await lab.run();
  expect(lab.executions).toHaveLength(1);
});

it("REQ-018 SEC-024 an interactive Run waits for the requester to continue the checkpoint and then executes", async () => {
  process.env.CI = "";
  const lab = await runLab();
  lab.site.control.captcha = true;
  const running = lab.run({ origin: "cli" });
  const checkpointId = await pendingCheckpoint(lab);
  expect(lab.executions).toHaveLength(0);
  // The human clears the challenge out of band, then confirms.
  lab.site.control.captcha = false;
  const resolved = await lab.current.app.authCheckpoints.continue(checkpointId);
  expect(resolved).toMatchObject({ state: "completed" });
  await running;
  expect(lab.executions).toHaveLength(1);
  expect(lab.current.app.authCheckpoints.get(checkpointId).state).toBe("completed");
  // A checkpoint can be resolved only once.
  await expect(lab.current.app.authCheckpoints.continue(checkpointId)).rejects.toMatchObject({
    code: expect.stringMatching(/PRECONDITION_FAILED|CONFLICT/u),
  });
});

it("SEC-024 an expired checkpoint ends the Run as blocked and cannot be resumed later", async () => {
  process.env.CI = "";
  const lab = await runLab();
  lab.site.control.captcha = true;
  const blocked = await lab.run({ origin: "cli", limits: { attemptTimeoutMs: 2500 } });
  expect(blocked).toMatchObject({ outcome: "blocked", reasonCode: "auth_checkpoint_expired" });
  expect(lab.executions).toHaveLength(0);
  const [checkpoint] = lab.current.app.authCheckpoints.list({ runId: blocked.id });
  expect(checkpoint?.state).toBe("expired");
  lab.site.control.captcha = false;
  await expect(
    lab.current.app.authCheckpoints.continue(String(checkpoint?.id)),
  ).rejects.toMatchObject({ details: { reasonCode: "auth_checkpoint_expired" } });
  expect(lab.executions).toHaveLength(0);
  expect(lab.site.counters.logins).toBe(0);
});

it("SEC-024 a pending checkpoint past its deadline reads as expired and cannot be continued", async () => {
  const lab = await runLab();
  lab.site.control.captcha = true;
  const blocked = await lab.run();
  const [pending] = lab.current.app.authCheckpoints.list({ runId: blocked.id });
  expect(pending?.state).toBe("pending");
  lab.site.control.captcha = false;
  // Nobody is waiting on this checkpoint; its deadline passes while it sits in the queue.
  const past = new Date(Date.now() - 1000).toISOString();
  const row = lab.current.app.database.get(
    "SELECT data_json FROM auth_checkpoints WHERE id=?",
    pending?.id,
  );
  const data = JSON.parse(String(row?.data_json)) as { expiresAt: string };
  data.expiresAt = past;
  lab.current.app.database.run(
    "UPDATE auth_checkpoints SET expires_at=?,data_json=? WHERE id=?",
    past,
    JSON.stringify(data),
    pending?.id,
  );
  expect(lab.current.app.authCheckpoints.get(String(pending?.id)).state).toBe("expired");
  await expect(lab.current.app.authCheckpoints.continue(String(pending?.id))).rejects.toMatchObject(
    { details: { reasonCode: "auth_checkpoint_expired" } },
  );
  expect(lab.site.counters.logins).toBe(0);
});

it("SEC-024 cancelling a checkpoint ends the waiting Run as blocked", async () => {
  process.env.CI = "";
  const lab = await runLab();
  lab.site.control.captcha = true;
  const running = lab.run({ origin: "cli" });
  const checkpointId = await pendingCheckpoint(lab);
  await lab.current.app.authCheckpoints.cancel(checkpointId);
  const run = await running;
  expect(run).toMatchObject({ outcome: "blocked", reasonCode: "manual_auth_required" });
  expect(lab.executions).toHaveLength(0);
});

it("M4-03 a revoked session refuses new Runs before any secret is released", async () => {
  const lab = await runLab();
  await lab.run();
  expect(lab.executions).toHaveLength(1);
  await lab.current.app.authProfiles.revokeSession(lab.profileId);
  await expect(
    lab.current.app.runs.admit(
      {
        testId: lab.testId,
        environmentId: lab.environmentId,
        extensions: { "testmaster:executor": "process" },
      },
      { wait: true },
    ),
  ).rejects.toMatchObject({ code: "POLICY_DENIED", details: { secretRef: lab.secretId } });
  expect(lab.executions).toHaveLength(1);
  expect(lab.site.counters.logins).toBe(1);
  // Positive control: an explicit re-authentication re-arms the profile and Runs are admitted again.
  await lab.current.app.authProfiles.testLogin(lab.profileId, lab.environmentId);
  await lab.run();
  expect(lab.executions).toHaveLength(2);
});

it("M4-03 SEC-023 a target that rejects the managed credential makes the next Run sign in again instead of replaying it", async () => {
  const lab = await runLab();
  await lab.run();
  await lab.run();
  // Positive control: while the target accepts the credential it is reused, never re-requested.
  expect(lab.site.counters.logins).toBe(1);
  vi.mocked(AttemptExecutor.prototype.execute).mockImplementationOnce(async (input) => {
    lab.executions.push(input as unknown as DockerAttempt);
    return { outcome: "blocked", reasonCode: "manual_auth_required", logDropped: 0, events: [] };
  });
  await lab.run();
  const view = lab.current.app.authProfiles.get(lab.profileId);
  expect(view.session.state).toBe("expired");
  expect(view.session.reason).toBe("target_rejected");
  await lab.run();
  expect(lab.site.counters.logins).toBe(2);
  expect(lab.current.app.authProfiles.get(lab.profileId).session.state).toBe("authenticated");
});
