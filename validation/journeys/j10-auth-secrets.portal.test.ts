import { readFile } from "node:fs/promises";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import {
  created,
  defaults,
  type Harness,
  httpLoginConfig,
  runToEnd,
  type Site,
  startSite,
  vaultSecret,
  waitForRun,
  whoAmIPlan,
} from "./auth-stack.js";
import { files } from "./harness.js";
import { expectAccessible, type OpenPortal, openPortal } from "./portal.js";
import { type ServerStack, startServerStack } from "./server-stack.js";

/**
 * J10: auth, secrets and redaction (specs/10-validation.md). An admin configures a test account with
 * a one-time-password seed, Runs execute in the server-profile worker's isolated sandbox, and the
 * journey observes tokens expiring, the account password being rotated, auth failures versus
 * assertion failures, evidence and portal exposure of every secret, and the negative checkpoint cases
 * (expired, other tenant).
 */
const rotatedPassword = "rotated-horse-battery-9";

let stack: ServerStack;
let site: Site;
let harness: Harness;
let projectId = "";
let environmentId = "";
let profile: { id: string; managedSecrets: Record<string, string> };
let passwordSecret: { id: string };
let usernameSecret: { id: string };
let testId = "";
let lastRunId = "";
const open: OpenPortal[] = [];

const owner = () => stack.ownerClient();
async function admit(plan: unknown): Promise<string> {
  return (
    await created<{ id: string }>(
      owner().mutate("POST", `/v1/projects/${projectId}/tests`, { origin: "manual", plan }),
      "test",
    )
  ).id;
}
/** A fresh administrator per page: the server rate-limits writes per principal. */
async function portal(user?: { login: string; password: string }) {
  const opened = await openPortal(
    { baseUrl: stack.baseUrl, spkiSha256: stack.ca.spkiSha256 },
    user ?? (await stack.addMember("org_admin")),
  );
  open.push(opened);
  return opened;
}
/** Everything a viewer of the page can read back: markup, storage, cookies readable by script, URL, inputs. */
async function exposure(page: OpenPortal["page"]): Promise<string> {
  return await page.evaluate(() =>
    JSON.stringify([
      document.documentElement.outerHTML,
      Object.entries(localStorage),
      Object.entries(sessionStorage),
      location.href,
      document.cookie,
      [...document.querySelectorAll("input, textarea")].map(
        (element) => (element as HTMLInputElement).value,
      ),
    ]),
  );
}
/** Uncompressed retained evidence of the server profile that mentions any of the values. */
async function evidenceLeaks(values: string[]): Promise<string[]> {
  const config = JSON.parse(await readFile(stack.configPath, "utf8")) as {
    storage: { root: string };
  };
  const found: string[] = [];
  for (const path of await files(config.storage.root)) {
    if (path.endsWith(".db") || path.includes("/vault/")) continue;
    const content = await readFile(path, "latin1").catch(() => "");
    if (values.some((value) => content.includes(value))) found.push(path);
  }
  return found;
}

beforeAll(async () => {
  site = await startSite();
  site.control.requireOtp = true;
  stack = await startServerStack({ worker: true, workspaces: 2 });
  harness = { stack, site };
  projectId = (
    await created<{ id: string }>(
      owner().mutate("POST", "/v1/projects", { name: "J10 project" }),
      "project",
    )
  ).id;
  const username = await vaultSecret(harness, "j10-user", defaults.username);
  usernameSecret = username;
  passwordSecret = await vaultSecret(harness, "j10-pass", defaults.password);
  const seed = await vaultSecret(harness, "j10-totp-seed", defaults.totpSeed);
  profile = await created(
    owner().mutate("POST", "/v1/auth-profiles", {
      projectId,
      name: "J10 test account",
      kind: "form",
      originBindings: [site.url],
      secrets: { username: username.id, password: passwordSecret.id, totpSeed: seed.id },
      config: {
        ...httpLoginConfig(site),
        http: {
          ...httpLoginConfig(site).http,
          fields: { username: "username", password: "password", otp: "otp" },
        },
        otp: {},
      },
    }),
    "profile",
  );
  environmentId = (
    await created<{ id: string }>(
      owner().mutate("POST", `/v1/projects/${projectId}/environments`, {
        name: "J10 site",
        baseUrl: site.url,
        networkProfile: "local-loopback",
        authRefs: [profile.id],
      }),
      "environment",
    )
  ).id;
  testId = await admit(whoAmIPlan(profile.managedSecrets.token as string));
}, 600_000);

afterAll(async () => {
  for (const opened of open.splice(0)) await opened.close().catch(() => undefined);
  await stack?.stop();
  await site?.close();
});

describe("J10 auth, secrets and redaction", () => {
  it("J10 SEC-024 M4-03 a test account with a one-time-password seed signs in with a fresh code and the Run passes", async () => {
    const first = await runToEnd(harness, testId, environmentId);
    expect(first.outcome).toBe("passed");
    expect(site.counters.logins).toBe(1);
    const login = site.requests.find((request) => request.path === "/api/login");
    const code = String(JSON.parse(login?.body ?? "{}").otp);
    expect(code).toMatch(/^\d{6}$/u);
    // The valid session is reused: the one-time code is not spent again.
    expect((await runToEnd(harness, testId, environmentId)).outcome).toBe("passed");
    expect(site.counters.logins).toBe(1);
    // Negative control: the target really demands the code.
    const refused = await fetch(`${site.url}/api/login`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ username: defaults.username, password: defaults.password }),
    });
    expect(refused.status).toBe(401);
    expect(await evidenceLeaks([defaults.totpSeed, code])).toEqual([]);
  });

  it("J10 SEC-023 M4-03 an expired target token is an inconclusive authentication result, then the next Run signs in once more", async () => {
    site.expireSessions();
    const stale = await runToEnd(harness, testId, environmentId);
    expect(stale).toMatchObject({ outcome: "inconclusive", reasonCode: "manual_auth_required" });
    const renewed = await runToEnd(harness, testId, environmentId);
    expect(renewed.outcome).toBe("passed");
    expect(site.counters.logins).toBe(2);
  });

  it("J10 M4-03 a failed assertion stays failed and stays understandable when the values it compared are withheld", async () => {
    interface Step {
      planStepId: string;
      status: string;
      reasonCode: string | null;
      expected: unknown;
      observed: unknown;
      error: { message: string } | null;
    }
    const stepsOf = async (runId: string) =>
      (await owner().request("GET", `/v1/runs/${runId}/steps`)).json<{
        data: { items: Step[] };
      }>().data.items;
    const token = profile.managedSecrets.token as string;
    // Authentication works, the oracle disagrees: failed, never blocked, and the values are shown.
    const plain = await runToEnd(harness, await admit(whoAmIPlan(token, "bob")), environmentId);
    expect(plain.outcome).toBe("failed");
    expect(plain.authFailure).toBeNull();
    const plainStep = (await stepsOf(plain.id)).find((step) => step.planStepId === "me_user");
    expect(plainStep).toMatchObject({
      status: "failed",
      reasonCode: "assertion_mismatch",
      expected: "bob",
      observed: defaults.username,
    });
    // The same failure when the Attempt also knows the account name as a secret: the compared
    // values are withheld, but the step, the reason and the message that explain the failure remain.
    const guarded = await runToEnd(
      harness,
      await admit(whoAmIPlan(token, "bob", { "x-test-account": { secretRef: usernameSecret.id } })),
      environmentId,
    );
    expect(guarded.outcome).toBe("failed");
    const guardedSteps = await stepsOf(guarded.id);
    const guardedStep = guardedSteps.find((step) => step.planStepId === "me_user");
    expect(guardedStep).toMatchObject({
      status: "failed",
      reasonCode: "assertion_mismatch",
      error: { message: "HTTP jsonEquals expectation was not satisfied" },
    });
    expect(guardedSteps.find((step) => step.planStepId === "me")?.status).toBe("passed");
    expect(JSON.stringify(guardedStep)).not.toContain(defaults.username);
    expect(JSON.stringify(guardedStep)).not.toMatch(/sanitiz|redact/iu);
  });

  it("J10 SEC-022 SEC-023 rotating the account password blocks the Run as an authentication failure until the profile points at the new secret", async () => {
    const failuresBefore = site.counters.loginFailures as number;
    site.control.password = rotatedPassword;
    site.expireSessions();
    // The old password is now refused: the first Run notices the dead token, the next one cannot sign in.
    expect((await runToEnd(harness, testId, environmentId)).outcome).toBe("inconclusive");
    const blocked = await runToEnd(harness, testId, environmentId);
    expect(blocked).toMatchObject({ outcome: "blocked", reasonCode: "manual_auth_required" });
    // The target cannot say which factor was wrong, so the engine reports a rejected sign-in.
    expect(["login_rejected", "otp_rejected"]).toContain(blocked.authFailure);
    const apiCalls = site.counters.apiCalls;
    expect(site.counters.loginFailures).toBe(failuresBefore + 1);

    // The admin stores the new password and re-points the profile; the old secret is revoked.
    const replacement = await vaultSecret(harness, "j10-pass-rotated", rotatedPassword);
    const current = await owner().request("GET", `/v1/auth-profiles/${profile.id}`);
    const etag = String(current.headers.etag);
    const patched = await owner().mutate(
      "PATCH",
      `/v1/auth-profiles/${profile.id}`,
      {
        secrets: {
          username: current.json<{ data: { secrets: Record<string, string> } }>().data.secrets
            .username,
          password: replacement.id,
          totpSeed: current.json<{ data: { secrets: Record<string, string> } }>().data.secrets
            .totpSeed,
        },
      },
      { "if-match": etag },
    );
    expect(patched.status, patched.text).toBe(200);
    const revoked = await owner().mutate("DELETE", `/v1/secrets/${passwordSecret.id}`, undefined, {
      "if-match": "*",
    });
    expect([200, 204, 412, 428], revoked.text).toContain(revoked.status);

    // An explicit sign-in from the portal re-arms the profile, then Runs pass again.
    const { page } = await portal();
    await page.goto(`/auth-profiles/${profile.id}`);
    await page.getByRole("heading", { level: 1, name: "J10 test account" }).waitFor();
    await page.getByLabel("Environment").first().selectOption({ label: "J10 site" });
    await page.getByRole("button", { name: "Test sign-in" }).click();
    await page
      .getByTestId("test-login-result")
      .filter({ hasText: "Outcome: authenticated" })
      .waitFor();
    const recovered = await runToEnd(harness, testId, environmentId);
    expect(recovered.outcome).toBe("passed");
    lastRunId = recovered.id;
    expect(site.counters.apiCalls).toBeGreaterThan(apiCalls);
  });

  it("J10 UX-046 the old and the new password, the one-time code and the token are nowhere in forms, browser storage, URLs, API views or retained evidence", async () => {
    const { page } = await portal();
    const secrets = [defaults.password, rotatedPassword, defaults.totpSeed];
    for (const path of [
      "/auth-profiles",
      "/auth-profiles/new",
      `/auth-profiles/${profile.id}`,
      "/auth-checkpoints",
      "/secrets",
    ]) {
      await page.goto(path);
      await page.getByRole("heading", { level: 1 }).first().waitFor();
      const seen = await exposure(page);
      for (const value of secrets)
        expect(seen, `${value.slice(0, 4)}… on ${path}`).not.toContain(value);
      expect(seen).not.toMatch(/Bearer\s+[A-Za-z0-9_-]{16,}/u);
      if (path === `/auth-profiles/${profile.id}`) await expectAccessible(page, "profile detail");
    }
    const view = await owner().request("GET", `/v1/auth-profiles/${profile.id}`);
    for (const value of secrets) expect(view.text).not.toContain(value);
    const login = site.requests.filter((request) => request.path === "/api/login").at(-1);
    const sentCode = String(JSON.parse(login?.body ?? "{}").otp);
    expect(await evidenceLeaks([...secrets, sentCode])).toEqual([]);
    // Negative control: the scan can see a value that is present (the Run's own ID is in its evidence).
    expect((await evidenceLeaks([lastRunId])).length).toBeGreaterThan(0);
  });

  it("J10 SEC-024 SEC-030 a checkpoint that expired cannot be resumed and another tenant can neither see nor confirm it", async () => {
    site.control.captcha = false;
    const username = await vaultSecret(harness, "j10-captcha-user", defaults.username);
    const password = await vaultSecret(harness, "j10-captcha-pass", rotatedPassword);
    const captchaProfile = await created<{ id: string; managedSecrets: Record<string, string> }>(
      owner().mutate("POST", "/v1/auth-profiles", {
        projectId,
        name: "J10 captcha account",
        kind: "form",
        originBindings: [site.url],
        secrets: { username: username.id, password: password.id },
        config: {
          ...httpLoginConfig(site),
          challenge: { kind: "captcha", resolution: "storage-state" },
        },
      }),
      "captcha profile",
    );
    const captchaEnvironment = await created<{ id: string }>(
      owner().mutate("POST", `/v1/projects/${projectId}/environments`, {
        name: "J10 captcha site",
        baseUrl: site.url,
        networkProfile: "local-loopback",
        authRefs: [captchaProfile.id],
      }),
      "captcha environment",
    );
    const captchaTest = await admit(whoAmIPlan(captchaProfile.managedSecrets.token as string));
    const logins = site.counters.logins;
    const admitted = await created<{ runId: string }>(
      owner().mutate("POST", "/v1/runs", {
        testId: captchaTest,
        environmentId: captchaEnvironment.id,
        limits: { attemptTimeoutMs: 4000 },
      }),
      "run",
    );
    const checkpoint = await vi.waitFor(
      async () => {
        const listed = (await owner().request("GET", "/v1/auth-checkpoints?state=pending")).json<{
          data: { items: { id: string; runId: string; kind: string }[] };
        }>().data.items;
        const mine = listed.find((item) => item.runId === admitted.runId);
        if (!mine) throw new Error("No checkpoint appeared for the Run");
        return mine;
      },
      { timeout: 60_000, interval: 250 },
    );
    expect(checkpoint.kind).toBe("captcha");

    // Another tenant: the checkpoint does not exist for them, in the API or the portal.
    const stranger = stack.workspaces[1];
    expect(stranger).toBeTruthy();
    const other = stack.ownerClient(1);
    expect(
      (await other.mutate("POST", `/v1/auth-checkpoints/${checkpoint.id}/continue`, {})).status,
    ).toBe(404);
    expect(
      (await other.mutate("POST", `/v1/auth-checkpoints/${checkpoint.id}/cancel`, {})).status,
    ).toBe(404);
    expect(
      (await other.request("GET", "/v1/auth-checkpoints?state=pending")).json<{
        data: { items: unknown[] };
      }>().data.items,
    ).toEqual([]);
    const outsider = await portal(stranger?.owner);
    await outsider.page.goto(`/auth-profiles/${captchaProfile.id}`);
    await outsider.page.getByRole("heading", { level: 1, name: "Not found" }).waitFor();

    // The worker runs in CI mode: the Run ends blocked at once and the CAPTCHA is never attempted.
    const ended = await waitForRun(harness, admitted.runId);
    expect(ended).toMatchObject({ outcome: "blocked", reasonCode: "manual_auth_required" });
    const stateOf = async (): Promise<string> =>
      (await owner().request("GET", `/v1/auth-checkpoints/${checkpoint.id}`)).json<{
        data: { state: string };
      }>().data.state;
    // Positive control: until its deadline the requester could still resolve this checkpoint.
    expect(await stateOf()).toBe("pending");
    // The five-minute deadline passes while nobody resolves it.
    const database = (await stack.scope()).database;
    const past = new Date(Date.now() - 1000).toISOString();
    const row = database.get("SELECT data_json FROM auth_checkpoints WHERE id=?", checkpoint.id);
    const data = JSON.parse(String(row?.data_json)) as { expiresAt: string };
    data.expiresAt = past;
    database.run(
      "UPDATE auth_checkpoints SET expires_at=?,data_json=? WHERE id=?",
      past,
      JSON.stringify(data),
      checkpoint.id,
    );
    expect(await stateOf()).toBe("expired");
    const late = await owner().mutate("POST", `/v1/auth-checkpoints/${checkpoint.id}/continue`, {});
    expect(late.status).toBeGreaterThanOrEqual(400);
    expect(late.status).toBeLessThan(500);
    expect(JSON.stringify(late.json())).toContain("auth_checkpoint_expired");
    const after = await waitForRun(harness, admitted.runId);
    expect(after.outcome).toBe("blocked");
    expect(site.counters.logins).toBe(logins);
  });
});
