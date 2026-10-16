import type * as ChildProcess from "node:child_process";
import { afterEach, expect, it, vi } from "vitest";
import {
  type AuthLab,
  defaults,
  httpFormConfig,
  oauthConfig,
  openLab,
  start,
} from "../../test/auth-lab.js";
import { scaffoldPlan } from "../authoring.js";
import type { StoredAuthProfile } from "./types.js";

// Hermetic: the encrypted file vault, never the host keyring.
vi.mock("node:child_process", async (importOriginal) => ({
  ...(await importOriginal<typeof ChildProcess>()),
  spawn: vi.fn(() => {
    throw Object.assign(new Error("Unavailable"), { code: "ENOENT" });
  }),
}));
const labs: AuthLab[] = [];
afterEach(async () => {
  for (const lab of labs.splice(0)) await lab.close();
});
async function lab(options?: Parameters<typeof openLab>[0]): Promise<AuthLab> {
  const created = await openLab(options);
  labs.push(created);
  return created;
}
const reveal = async (current: AuthLab, id: string) =>
  (await current.app.secrets.release(id)).resolve();
function stored(current: AuthLab, id: string): StoredAuthProfile {
  return current.app.authProfiles.profile(id);
}
function formProfile(current: AuthLab, name = "form") {
  return (async () => {
    const username = await current.secret(`${name}-user`, defaults.username);
    const password = await current.secret(`${name}-pass`, defaults.password);
    return await current.profile({
      name,
      kind: "form",
      config: httpFormConfig(current.site),
      secrets: { username, password },
    });
  })();
}
const rowCount = (current: AuthLab, table: string): number =>
  Number(current.app.database.get(`SELECT COUNT(*) AS n FROM ${table}`)?.n);

it("M4-03 REQ-018 creates every auth kind with its own roles and lists no credential value", async () => {
  const current = await lab();
  const user = await current.secret("u", defaults.username);
  const pass = await current.secret("p", defaults.password);
  const token = await current.secret("t", "static-bearer-token-0001");
  const key = await current.secret("k", defaults.apiKey);
  const cookie = await current.secret("c", "session=abc");
  const basic = await current.profile({
    name: "basic",
    kind: "basic",
    config: {},
    secrets: { username: user, password: pass },
  });
  const bearer = await current.profile({
    name: "bearer",
    kind: "bearer",
    config: {},
    secrets: { token },
  });
  const apiKey = await current.profile({
    name: "api-key",
    kind: "api-key",
    config: { header: "x-api-key" },
    secrets: { key },
  });
  const cookieProfile = await current.profile({
    name: "cookie",
    kind: "cookie",
    config: {},
    secrets: { cookie },
  });
  const form = await formProfile(current);
  const views = current.app.authProfiles.list(current.projectId);
  expect(views.map((view) => view.kind).sort()).toEqual(
    ["api-key", "basic", "bearer", "cookie", "form"].sort(),
  );
  // Managed roles are created with the profile and carry no value yet.
  expect(Object.keys(basic.managedSecrets)).toEqual(["authorization"]);
  expect(Object.keys(form.managedSecrets).sort()).toEqual([
    "otp",
    "session",
    "storageState",
    "token",
  ]);
  expect(Object.keys(bearer.managedSecrets)).toEqual([]);
  expect(Object.keys(apiKey.managedSecrets)).toEqual([]);
  expect(Object.keys(cookieProfile.managedSecrets)).toEqual([]);
  const serialized = JSON.stringify(views);
  for (const value of [
    defaults.password,
    defaults.username,
    defaults.apiKey,
    "static-bearer-token-0001",
    "session=abc",
  ])
    expect(serialized).not.toContain(value);
  expect(form.session.state).toBe("unauthenticated");
  expect(form.session.credentials).toEqual([]);
});

it("M4-03 REQ-018 refuses malformed profiles, foreign roles and secrets that are not authorized for the receiving origin", async () => {
  const current = await lab();
  const user = await current.secret("u", defaults.username);
  const pass = await current.secret("p", defaults.password);
  const elsewhere = await current.secret("elsewhere", defaults.password, ["http://127.0.0.1:9"]);
  const refuse = async (input: Parameters<AuthLab["profile"]>[0], message: RegExp) =>
    await expect(current.profile(input)).rejects.toMatchObject({
      code: expect.stringMatching(/INVALID_ARGUMENT|POLICY_DENIED/u),
      message: expect.stringMatching(message),
    });
  await refuse(
    { name: "bad-role", kind: "bearer", config: {}, secrets: { token: user, password: pass } },
    /role is not valid/u,
  );
  await refuse(
    { name: "missing", kind: "basic", config: {}, secrets: { username: user } },
    /missing/u,
  );
  await refuse(
    {
      name: "wrong-origin",
      kind: "basic",
      config: {},
      secrets: { username: user, password: elsewhere },
    },
    /not authorized for the origin/u,
  );
  await refuse(
    {
      name: "login-outside",
      kind: "form",
      config: httpFormConfig({ url: "http://127.0.0.1:9" } as never),
      secrets: { username: user, password: pass },
    },
    /outside the profile's origin bindings/u,
  );
  await refuse(
    {
      name: "both",
      kind: "form",
      config: { ...httpFormConfig(current.site), browser: { steps: [] } },
      secrets: { username: user, password: pass },
    },
    /./u,
  );
  await refuse(
    {
      name: "path-binding",
      kind: "basic",
      config: {},
      originBindings: [`${current.site.url}/app`],
      secrets: { username: user, password: pass },
    },
    /credential-free origin/u,
  );
  const unmanaged = await formProfile(current, "owner");
  await refuse(
    {
      name: "borrow-managed",
      kind: "bearer",
      config: {},
      secrets: { token: unmanaged.managedSecrets.session as string },
    },
    /managed credential cannot be a static secret/u,
  );
  // Positive control: the same inputs with a correctly bound secret are accepted.
  await expect(
    current.profile({
      name: "ok",
      kind: "basic",
      config: {},
      secrets: { username: user, password: pass },
    }),
  ).resolves.toMatchObject({ kind: "basic" });
  await current.app.secrets.remove(pass);
  await refuse(
    { name: "revoked", kind: "basic", config: {}, secrets: { username: user, password: pass } },
    /revoked/u,
  );
});

it("M4-03 REQ-018 validates OAuth redirect URIs, scopes and the OIDC openid scope", async () => {
  const current = await lab();
  const refuse = async (config: Record<string, unknown>, message: RegExp) =>
    await expect(
      current.profile({ name: `o-${Math.random()}`, kind: "oidc", config, secrets: {} }),
    ).rejects.toMatchObject({ code: "INVALID_ARGUMENT", message: expect.stringMatching(message) });
  await refuse(
    oauthConfig(current.site, { redirectUri: "http://127.0.0.1:9/other" }),
    /registered redirect URI/u,
  );
  await refuse(
    oauthConfig(current.site, { scopes: ["openid", "admin"] }),
    /exceed the allowed scopes/u,
  );
  await refuse(
    oauthConfig(current.site, { scopes: ["profile"], allowedScopes: ["profile"] }),
    /openid scope/u,
  );
  await expect(
    current.profile({
      name: "oidc-ok",
      kind: "oidc",
      config: oauthConfig(current.site),
      secrets: {},
    }),
  ).resolves.toMatchObject({ kind: "oidc" });
});

it("M4-03 SEC-022 test-login authenticates through the vault and saves no draft, revision or proposal", async () => {
  const current = await lab();
  const profile = await formProfile(current);
  const env = current.environment("login-env", [profile.id]);
  current.app.tests.create({
    projectId: current.projectId,
    plan: scaffoldPlan("backend"),
  });
  const tables = [
    "tests",
    "test_revisions",
    "proposals",
    "proposal_batches",
    "environment_revisions",
  ];
  const before = tables.map((table) => rowCount(current, table));
  const receipt = await current.app.authProfiles.testLogin(profile.id, env.id);
  expect(receipt).toMatchObject({
    outcome: "authenticated",
    reasonCode: null,
    credentialRoles: ["session"],
    draftsChanged: false,
  });
  expect(tables.map((table) => rowCount(current, table))).toEqual(before);
  const view = current.app.authProfiles.get(profile.id);
  expect(view.session.state).toBe("authenticated");
  expect(view.session.credentials.map((credential) => credential.role)).toEqual(["session"]);
  // The managed credential is a real session on the target and the receipt/view never carry it.
  const cookie = await reveal(current, profile.managedSecrets.session as string);
  const me = await fetch(`${current.site.url}/api/me`, { headers: { cookie } });
  expect(me.status).toBe(200);
  expect(JSON.stringify([receipt, view])).not.toContain(cookie.split("=")[1] as string);
  // Negative control: a credential the target never issued is rejected, so the check above is real.
  const forged = await fetch(`${current.site.url}/api/me`, {
    headers: { cookie: "session=forged" },
  });
  expect(forged.status).toBe(401);
});

it("M4-03 REQ-018 reports a rejected login and does not hammer the target while it cools down", async () => {
  const current = await lab();
  const user = await current.secret("u", defaults.username);
  const wrong = await current.secret("p", "not-the-password");
  const profile = await current.profile({
    name: "wrong",
    kind: "form",
    config: httpFormConfig(current.site),
    secrets: { username: user, password: wrong },
  });
  const env = current.environment("wrong-env", [profile.id]);
  const receipt = await current.app.authProfiles.testLogin(profile.id, env.id);
  expect(receipt).toMatchObject({ outcome: "failed", reasonCode: "manual_auth_required" });
  expect(receipt.detail).toContain("login_rejected");
  expect(current.site.counters.loginFailures).toBe(1);
  const engine = current.app.authProfiles.engine;
  const environment = current.app.authProfiles.environment(env.id).environment;
  for (let attempt = 0; attempt < 3; attempt++)
    await expect(
      engine.ensure(stored(current, profile.id), environment, { interactive: false }),
    ).rejects.toMatchObject({ details: { authFailure: "refresh_cooldown" } });
  // No loop: the cooldown stopped every automatic retry before it reached the target.
  expect(current.site.counters.loginFailures).toBe(1);
  expect(current.app.authProfiles.get(profile.id).session).toMatchObject({
    state: "reauth_required",
    refreshFailures: 1,
  });
});

it("M4-03 SEC-023 a secret that lost its authorization for the login origin is never released to the target", async () => {
  const current = await lab();
  const profile = await formProfile(current);
  const env = current.environment("origin-env", [profile.id]);
  const password = stored(current, profile.id).secrets.password as string;
  // Positive control: while the secret is authorized for the target origin the sign-in succeeds.
  await expect(current.app.authProfiles.testLogin(profile.id, env.id)).resolves.toMatchObject({
    outcome: "authenticated",
  });
  const loginsBefore = current.site.counters.logins;
  // The secret is re-pointed at another origin after the profile was created.
  const row = current.app.database.get(
    "SELECT data_json FROM secret_references WHERE id=?",
    password,
  );
  const data = JSON.parse(String(row?.data_json)) as { allowedOrigins: string[] };
  data.allowedOrigins = ["http://127.0.0.1:9"];
  current.app.database.run(
    "UPDATE secret_references SET data_json=? WHERE id=?",
    JSON.stringify(data),
    password,
  );
  const receipt = await current.app.authProfiles.testLogin(profile.id, env.id);
  expect(receipt).toMatchObject({ outcome: "blocked", reasonCode: "security_precondition_failed" });
  expect(receipt.detail).toContain("origin_denied");
  // Negative control: the target never saw a second login attempt, so no credential left the host.
  expect(current.site.counters.logins).toBe(loginsBefore);
});

it("M4-03 SEC-023 two simultaneous logins of one profile share a single login against the target", async () => {
  const current = await lab();
  const profile = await formProfile(current);
  const env = current.environment("single-env", [profile.id]);
  current.site.control.loginDelayMs = 200;
  const [first, second] = await Promise.all([
    current.app.authProfiles.testLogin(profile.id, env.id),
    current.app.authProfiles.testLogin(profile.id, env.id),
  ]);
  expect([first.outcome, second.outcome]).toEqual(["authenticated", "authenticated"]);
  expect(current.site.counters.logins).toBe(1);
  // Negative control: a separate, later explicit login is a new login.
  await current.app.authProfiles.testLogin(profile.id, env.id);
  expect(current.site.counters.logins).toBe(2);
});

it("M4-03 SEC-023 stores a token login as a bearer credential and reauthenticates after the session expires", async () => {
  const current = await lab();
  const user = await current.secret("u", defaults.username);
  const pass = await current.secret("p", defaults.password);
  const profile = await current.profile({
    name: "token",
    kind: "form",
    config: httpFormConfig(current.site, {
      success: { statusIn: [200], tokenPointer: "/token" },
    }),
    secrets: { username: user, password: pass },
  });
  const env = current.environment("token-env", [profile.id]);
  const environment = current.app.authProfiles.environment(env.id).environment;
  const engine = current.app.authProfiles.engine;
  const ensured = await engine.ensure(stored(current, profile.id), environment, {
    interactive: false,
  });
  expect(ensured.roles).toEqual(["token"]);
  const bearer = await reveal(current, profile.managedSecrets.token as string);
  expect(bearer).toMatch(/^Bearer /u);
  expect(
    (await fetch(`${current.site.url}/api/me`, { headers: { authorization: bearer } })).status,
  ).toBe(200);
  // Still fresh: another ensure does not log in again.
  await engine.ensure(stored(current, profile.id), environment, { interactive: false });
  expect(current.site.counters.logins).toBe(1);
  current.site.expireSessions();
  expect(
    (await fetch(`${current.site.url}/api/me`, { headers: { authorization: bearer } })).status,
  ).toBe(401);
});

it("M4-03 REQ-018 derives a Basic header from vault secrets and sends static credentials only as configured", async () => {
  const current = await lab();
  const user = await current.secret("u", defaults.username);
  const pass = await current.secret("p", defaults.password);
  const profile = await current.profile({
    name: "basic",
    kind: "basic",
    config: {},
    secrets: { username: user, password: pass },
  });
  const env = current.environment("basic-env", [profile.id]);
  expect(await current.app.authProfiles.testLogin(profile.id, env.id)).toMatchObject({
    outcome: "authenticated",
    credentialRoles: ["authorization"],
  });
  const header = await reveal(current, profile.managedSecrets.authorization as string);
  expect(
    (await fetch(`${current.site.url}/api/basic`, { headers: { authorization: header } })).status,
  ).toBe(200);
  expect(
    (await fetch(`${current.site.url}/api/basic`, { headers: { authorization: "Basic Zm9v" } }))
      .status,
  ).toBe(401);
  // A revoked static secret ends use of the profile.
  await current.app.secrets.remove(pass);
  const receipt = await current.app.authProfiles.testLogin(profile.id, env.id);
  expect(receipt).toMatchObject({ outcome: "blocked", reasonCode: "credential_revoked" });
});

it("M4-03 SEC-023 revoking a session deletes derived credentials and blocks runs until an explicit login", async () => {
  const current = await lab();
  const profile = await formProfile(current);
  const env = current.environment("revoke-env", [profile.id]);
  await current.app.authProfiles.testLogin(profile.id, env.id);
  const sessionId = profile.managedSecrets.session as string;
  const cookie = await reveal(current, sessionId);
  const revoked = await current.app.authProfiles.revokeSession(profile.id);
  expect(revoked.session).toMatchObject({ state: "revoked", credentials: [] });
  expect(current.app.secrets.get(sessionId).revokedAt).toBeTruthy();
  await expect(reveal(current, sessionId)).rejects.toMatchObject({ code: "POLICY_DENIED" });
  const environment = current.app.authProfiles.environment(env.id).environment;
  await expect(
    current.app.authProfiles.engine.ensure(stored(current, profile.id), environment, {
      interactive: false,
    }),
  ).rejects.toMatchObject({
    details: { reasonCode: "credential_revoked", authFailure: "session_revoked" },
  });
  // Only an explicit authentication re-arms the profile; it yields a different session.
  expect(await current.app.authProfiles.testLogin(profile.id, env.id)).toMatchObject({
    outcome: "authenticated",
  });
  const next = await reveal(current, profile.managedSecrets.session as string);
  expect(next).not.toBe(cookie);
});

it("M4-03 REQ-018 attaches profiles to an environment only inside the profile's origin bindings and project", async () => {
  const current = await lab();
  const profile = await formProfile(current);
  const other = await start();
  try {
    expect(() =>
      current.app.environments.create({
        projectId: current.projectId,
        name: "foreign-origin",
        baseUrl: other.url,
        networkProfile: "local-loopback",
        authRefs: [profile.id],
      }),
    ).toThrowError(expect.objectContaining({ code: "PRECONDITION_FAILED" }));
    expect(() =>
      current.app.environments.create({
        projectId: current.projectId,
        name: "missing-profile",
        baseUrl: current.site.url,
        networkProfile: "local-loopback",
        authRefs: ["aut_00000000-0000-4000-8000-000000000000"],
      }),
    ).toThrowError(expect.objectContaining({ code: "NOT_FOUND" }));
    // Positive control.
    expect(current.environment("bound", [profile.id]).id).toBeTruthy();
  } finally {
    await other.close();
  }
});

it("SEC-022 binding an auth profile to an environment needs no approval and is audited with the actor", async () => {
  const current = await lab();
  const profile = await formProfile(current);
  const events = () =>
    current.app.database.all<{
      actor: string;
      resource_id: string;
      before_hash: string | null;
      after_hash: string | null;
    }>(
      "SELECT actor,resource_id,before_hash,after_hash FROM audit_events WHERE action='environment.auth_binding'",
    );
  // No profile attached: nothing to audit.
  current.environment("plain", []);
  expect(events()).toEqual([]);
  // Attaching needs only write permission and records who bound what.
  const bound = current.environment("audited", [profile.id]);
  const [created] = events();
  expect(events()).toHaveLength(1);
  expect(created).toMatchObject({
    actor: current.app.context.principalId,
    resource_id: bound.id,
  });
  expect(created?.before_hash).not.toBe(created?.after_hash);
  // A change that keeps the same profile set writes nothing; detaching writes a second event.
  const stored = current.app.environments.get(bound.id);
  const patched = current.app.environments.update(
    bound.id,
    { locale: "pt-BR" },
    Number(stored.version),
  );
  expect(events()).toHaveLength(1);
  current.app.environments.update(bound.id, { authRefs: [] }, Number(patched.version));
  const after = events();
  expect(after).toHaveLength(2);
  expect(after.map((event) => event.resource_id)).toEqual([bound.id, bound.id]);
  expect(new Set(after.map((event) => event.after_hash)).size).toBe(2);
});

it("SEC-022 stores and returns a plain username and signs in with it while the password stays a secret", async () => {
  const current = await lab();
  const pass = await current.secret("plain-pass", defaults.password);
  const form = await current.profile({
    name: "plain-form",
    kind: "form",
    config: httpFormConfig(current.site),
    secrets: { password: pass },
    username: defaults.username,
  });
  expect(form.username).toBe(defaults.username);
  expect(form.secrets).toEqual({ password: pass });
  expect(stored(current, form.id).secretRefs).toEqual([pass]);
  expect(current.app.authProfiles.get(form.id).username).toBe(defaults.username);
  expect(current.app.authProfiles.list(current.projectId).map((view) => view.username)).toEqual([
    defaults.username,
  ]);
  const env = current.environment("plain-form-env", [form.id]);
  expect(await current.app.authProfiles.testLogin(form.id, env.id)).toMatchObject({
    outcome: "authenticated",
  });
  const login = current.site.requests.find((request) => request.path === "/api/login");
  expect(JSON.parse(login?.body ?? "{}")).toEqual({
    username: defaults.username,
    password: defaults.password,
  });
  // Basic derives its header from the plain value too.
  const basic = await current.profile({
    name: "plain-basic",
    kind: "basic",
    config: {},
    secrets: { password: pass },
    username: defaults.username,
  });
  const basicEnv = current.environment("plain-basic-env", [basic.id]);
  expect(await current.app.authProfiles.testLogin(basic.id, basicEnv.id)).toMatchObject({
    outcome: "authenticated",
    credentialRoles: ["authorization"],
  });
  const header = await reveal(current, basic.managedSecrets.authorization as string);
  expect(Buffer.from(header.replace("Basic ", ""), "base64").toString()).toBe(
    `${defaults.username}:${defaults.password}`,
  );
  expect(
    (await fetch(`${current.site.url}/api/basic`, { headers: { authorization: header } })).status,
  ).toBe(200);
});

it("SEC-022 switches a profile between a plain and a secret username on update", async () => {
  const current = await lab();
  const pass = await current.secret("switch-pass", defaults.password);
  const user = await current.secret("switch-user", defaults.username);
  const service = current.app.authProfiles;
  const created = await current.profile({
    name: "switch",
    kind: "basic",
    config: {},
    secrets: { username: user, password: pass },
  });
  expect(created.username).toBeUndefined();
  // A plain username replaces the secret one and the secret reference is dropped.
  const plain = await service.update(created.id, { username: "someone" }, created.version);
  expect(plain.username).toBe("someone");
  expect(plain.secrets).toEqual({ password: pass });
  expect(stored(current, created.id).secretRefs).toEqual([pass]);
  // Unrelated edits keep it.
  const renamed = await service.update(created.id, { name: "switch-renamed" }, plain.version);
  expect(renamed.username).toBe("someone");
  // Sending a secret username replaces the plain one.
  const secret = await service.update(
    created.id,
    { secrets: { username: user, password: pass } },
    renamed.version,
  );
  expect(secret.username).toBeUndefined();
  expect(secret.secrets).toEqual({ username: user, password: pass });
  // Both at once is ambiguous and refused without changing the profile.
  await expect(
    service.update(
      created.id,
      { username: "both", secrets: { username: user, password: pass } },
      secret.version,
    ),
  ).rejects.toMatchObject({ code: "INVALID_ARGUMENT", details: { role: "username" } });
  expect(service.get(created.id)).toMatchObject({
    version: secret.version,
    secrets: { username: user },
  });
});

it("SEC-022 refuses a plain value for every secret-only role and names the role", async () => {
  const current = await lab();
  const pass = await current.secret("refuse-pass", defaults.password);
  const user = await current.secret("refuse-user", defaults.username);
  const refuse = async (input: Parameters<AuthLab["profile"]>[0], role: string, message?: RegExp) =>
    await expect(current.profile(input)).rejects.toMatchObject({
      code: "INVALID_ARGUMENT",
      details: { role },
      ...(message ? { message: expect.stringMatching(message) } : {}),
    });
  type Input = Parameters<AuthLab["profile"]>[0];
  const form = (name: string, secrets: Record<string, string>, username?: string): Input => ({
    name,
    kind: "form",
    config: httpFormConfig(current.site),
    secrets,
    ...(username === undefined ? {} : { username }),
  });
  const basic = (name: string, secrets: Record<string, string>, username?: string): Input => ({
    name,
    kind: "basic",
    config: {},
    secrets,
    ...(username === undefined ? {} : { username }),
  });
  await refuse(
    form("plain-password", { password: "hunter2-plain" }, "root"),
    "password",
    /plain value/u,
  );
  await refuse(
    form("plain-totp", { password: pass, totpSeed: "JBSWY3DPEHPK3PXP" }, "root"),
    "totpSeed",
  );
  await refuse(
    { name: "plain-token", kind: "bearer", config: {}, secrets: { token: "plain-bearer-0001" } },
    "token",
  );
  // The username belongs in its own field, never as a plain value inside `secrets`.
  await refuse(
    basic("plain-in-secrets", { username: "root", password: pass }),
    "username",
    /username field/u,
  );
  // The two shapes never combine, and a kind without a username role has no plain username.
  await refuse(basic("both", { username: user, password: pass }, "root"), "username", /not both/u);
  await refuse(
    { name: "bearer-user", kind: "bearer", config: {}, secrets: { token: pass }, username: "root" },
    "username",
    /not valid for this auth kind/u,
  );
  await expect(current.profile(basic("padded", { password: pass }, " root"))).rejects.toMatchObject(
    { code: "INVALID_ARGUMENT" },
  );
  // Updates are held to the same rule, and nothing above was stored.
  const ok = await current.profile({
    name: "ok",
    kind: "basic",
    config: {},
    secrets: { password: pass },
    username: "root",
  });
  await expect(
    current.app.authProfiles.update(ok.id, { secrets: { password: "plain-again" } }, ok.version),
  ).rejects.toMatchObject({ code: "INVALID_ARGUMENT", details: { role: "password" } });
  expect(current.app.authProfiles.list(current.projectId).map((view) => view.name)).toEqual(["ok"]);
});
