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
let counter = 0;

/** A user-facing OIDC profile plus an environment bound to the reference site. */
async function oidc(current: AuthLab, config: Record<string, unknown> = {}) {
  const profile = await current.profile({
    name: `oidc-${++counter}`,
    kind: "oidc",
    config: oauthConfig(current.site, config),
    secrets: {},
  });
  return { profile, env: current.environment(`env-${counter}`, [profile.id]) };
}
/** Plays the human: opens the authorization URL and hands the redirect to TestMaster as a vault secret. */
async function authorizeAs(
  current: AuthLab,
  profileId: string,
  environmentId: string,
  tamper: (redirect: URL) => void = () => {},
) {
  const authorization = await current.app.authProfiles.authorize(profileId, environmentId);
  const redirect = new URL(await current.site.approve(authorization.authorizeUrl));
  tamper(redirect);
  const inputRef = await current.secret(`redirect-${++counter}`, redirect.href);
  const complete = () =>
    current.app.authProfiles.completeAuthorization(
      profileId,
      { authorizationId: authorization.authorizationId, inputRef },
      environmentId,
    );
  /** Presents the same callback again straight to the engine, bypassing the consumed vault input. */
  const replay = () =>
    current.app.authProfiles.engine.completeAuthorization(
      current.app.authProfiles.profile(profileId),
      current.app.authProfiles.environment(environmentId).environment,
      { authorizationId: authorization.authorizationId, redirectUrl: redirect.href },
    );
  return Object.assign(complete, { replay });
}
const refused = (authFailure: string) => ({ details: { authFailure } });

it("SEC-023 M4-03 completes an OIDC authorization-code flow with PKCE, state and nonce and keeps tokens only in the vault", async () => {
  const current = await lab();
  const { profile, env } = await oidc(current);
  const complete = await authorizeAs(current, profile.id, env.id);
  const view = await complete();
  expect(view.session.state).toBe("authenticated");
  expect(view.session.credentials.map((credential) => credential.role).sort()).toEqual([
    "accessToken",
    "refreshToken",
  ]);
  expect(current.site.counters.codeExchanges).toBe(1);
  const access = await reveal(current, profile.managedSecrets.accessToken as string);
  const me = await fetch(`${current.site.url}/api/oauth/me`, {
    headers: { authorization: access },
  });
  expect(me.status).toBe(200);
  const refresh = await reveal(current, profile.managedSecrets.refreshToken as string);
  const serialized = JSON.stringify([view, current.app.authProfiles.list(current.projectId)]);
  expect(serialized).not.toContain(access);
  expect(serialized).not.toContain(refresh);
  // The PKCE verifier secret is consumed, not left usable in the vault.
  const verifier = current.app.database.get("SELECT verifier_secret_id FROM auth_authorizations");
  expect(current.app.secrets.get(String(verifier?.verifier_secret_id)).revokedAt).toBeTruthy();
  // Negative control: the same redirect cannot be exchanged twice.
  await expect(complete.replay()).rejects.toMatchObject(refused("state_mismatch"));
  await expect(complete()).rejects.toMatchObject({ details: { reasonCode: "credential_revoked" } });
  expect(current.site.counters.codeExchanges).toBe(1);
});

it("SEC-023 refuses a callback whose state does not match and never exchanges the code", async () => {
  const current = await lab();
  const { profile, env } = await oidc(current);
  const complete = await authorizeAs(current, profile.id, env.id, (redirect) =>
    redirect.searchParams.set("state", "attacker-chosen-state"),
  );
  await expect(complete()).rejects.toMatchObject(refused("state_mismatch"));
  expect(current.site.counters.codeExchanges).toBe(0);
  expect(current.app.authProfiles.get(profile.id).session.credentials).toEqual([]);
  const wrongRedirect = await authorizeAs(current, profile.id, env.id, (redirect) => {
    redirect.host = "evil.example";
  });
  await expect(wrongRedirect()).rejects.toMatchObject(refused("redirect_mismatch"));
  expect(current.site.counters.codeExchanges).toBe(0);
  // Positive control: an untampered callback from the same provider succeeds.
  const good = await authorizeAs(current, profile.id, env.id);
  expect((await good()).session.state).toBe("authenticated");
});

it.each([
  ["nonce", { nonceOverride: "replayed-nonce" }, "nonce_mismatch"],
  ["identity token audience", { idAudienceOverride: "another-client" }, "audience_mismatch"],
  ["access token audience", { audienceClaim: "another-api" }, "audience_mismatch"],
  ["issuer", { issuerClaim: "https://evil.example" }, "external_issuer"],
  ["granted scope", { scopeGrant: "openid profile admin" }, "scope_denied"],
] as const)(
  "SEC-023 refuses a %s mismatch without storing any token",
  async (_, control, failure) => {
    const current = await lab();
    const { profile, env } = await oidc(current);
    Object.assign(current.site.control, control);
    const complete = await authorizeAs(current, profile.id, env.id);
    await expect(complete()).rejects.toMatchObject(refused(failure));
    expect(current.app.authProfiles.get(profile.id).session.credentials).toEqual([]);
    expect(current.app.secrets.get(profile.managedSecrets.accessToken as string).provider).toBe(
      "managed",
    );
    // Positive control: with the provider behaving, the same profile authenticates.
    Object.assign(current.site.control, {
      nonceOverride: null,
      idAudienceOverride: null,
      audienceClaim: null,
      issuerClaim: null,
      scopeGrant: null,
    });
    const good = await authorizeAs(current, profile.id, env.id);
    expect((await good()).session.state).toBe("authenticated");
  },
);

it("SEC-023 refuses an external issuer in discovery before any credential is sent", async () => {
  const current = await lab({ clientSecret: "client-secret-value-0001" });
  const clientSecret = await current.secret("client-secret", "client-secret-value-0001");
  const profile = await current.profile({
    name: "external",
    kind: "oidc",
    config: oauthConfig(current.site),
    secrets: { clientSecret },
  });
  const env = current.environment("external-env", [profile.id]);
  current.site.control.discoveryIssuer = "https://evil.example";
  await expect(current.app.authProfiles.authorize(profile.id, env.id)).rejects.toMatchObject(
    refused("external_issuer"),
  );
  current.site.control.discoveryIssuer = null;
  current.site.control.discoveryExternalEndpoint = true;
  await expect(current.app.authProfiles.authorize(profile.id, env.id)).rejects.toMatchObject(
    refused("external_issuer"),
  );
  current.site.control.discoveryExternalEndpoint = false;
  const before = current.site.requests.filter((request) => request.path === "/oauth/token").length;
  const complete = await authorizeAs(current, profile.id, env.id);
  expect((await complete()).session.state).toBe("authenticated");
  // The client secret reached the token endpoint exactly once, and only the real issuer saw it.
  const tokenCalls = current.site.requests.filter((request) => request.path === "/oauth/token");
  expect(tokenCalls.length - before).toBe(1);
});

it("SEC-023 M4-03 refuses endpoints on another origin and never contacts that origin with a secret", async () => {
  const current = await lab({ clientSecret: "client-secret-value-0002" });
  const other = await start();
  try {
    const clientSecret = await current.secret("client-secret", "client-secret-value-0002");
    await expect(
      current.profile({
        name: "split-origin",
        kind: "oidc",
        config: oauthConfig(current.site, {
          endpoints: {
            authorization: `${current.site.url}/oauth/authorize`,
            token: `${other.url}/oauth/token`,
            jwks: `${current.site.url}/oauth/jwks`,
          },
        }),
        secrets: { clientSecret },
      }),
    ).rejects.toMatchObject({ message: expect.stringMatching(/not authorized for the origin/u) });
    expect(other.requests).toEqual([]);
    // Positive control: authorizing the secret for both origins makes the same profile valid.
    const both = await current.secret("client-both", "client-secret-value-0002", [
      current.site.url,
      other.url,
    ]);
    await expect(
      current.profile({
        name: "split-origin-ok",
        kind: "oidc",
        config: oauthConfig(current.site, {
          endpoints: {
            authorization: `${current.site.url}/oauth/authorize`,
            token: `${other.url}/oauth/token`,
            jwks: `${current.site.url}/oauth/jwks`,
          },
        }),
        secrets: { clientSecret: both },
      }),
    ).resolves.toMatchObject({ kind: "oidc" });
  } finally {
    await other.close();
  }
});

it("SEC-023 refreshes once for simultaneous executions and does not corrupt a rotating refresh token", async () => {
  const current = await lab();
  current.site.control.accessTokenTtlSeconds = 30; // inside the 60 s skew: every use needs a refresh
  const { profile, env } = await oidc(current);
  await (await authorizeAs(current, profile.id, env.id))();
  const engine = current.app.authProfiles.engine;
  const environment = current.app.authProfiles.environment(env.id).environment;
  const load = () => current.app.authProfiles.profile(profile.id) as StoredAuthProfile;
  current.site.control.accessTokenTtlSeconds = 3600;
  const results = await Promise.all(
    Array.from({ length: 6 }, () => engine.ensure(load(), environment, { interactive: false })),
  );
  expect(results.every((result) => result.roles[0] === "accessToken")).toBe(true);
  expect(current.site.counters.refreshes).toBe(1);
  expect(current.site.counters.refreshReuse).toBe(0);
  // The rotated refresh token still works afterwards, so the family was not killed.
  const access = await reveal(current, profile.managedSecrets.accessToken as string);
  expect(
    (
      await fetch(`${current.site.url}/api/oauth/me`, {
        headers: { authorization: access },
      })
    ).status,
  ).toBe(200);
  current.site.control.accessTokenTtlSeconds = 30;
  await engine.ensure(load(), environment, { interactive: false, explicit: true });
  expect(current.site.counters.refreshes).toBe(2);
  expect(current.site.counters.refreshReuse).toBe(0);
});

it("SEC-023 an expired refresh token ends in a checkpoint request and is never retried in a loop", async () => {
  const current = await lab();
  current.site.control.accessTokenTtlSeconds = 30;
  const { profile, env } = await oidc(current);
  await (await authorizeAs(current, profile.id, env.id))();
  current.site.control.refreshExpired = true;
  const engine = current.app.authProfiles.engine;
  const environment = current.app.authProfiles.environment(env.id).environment;
  const load = () => current.app.authProfiles.profile(profile.id) as StoredAuthProfile;
  await expect(engine.ensure(load(), environment, { interactive: false })).rejects.toMatchObject({
    details: {
      reasonCode: "manual_auth_required",
      checkpointRequired: true,
      kind: "reauthorization",
    },
  });
  expect(current.site.counters.refreshes).toBe(1);
  for (let attempt = 0; attempt < 3; attempt++)
    await expect(engine.ensure(load(), environment, { interactive: false })).rejects.toBeDefined();
  // The spent refresh token was erased, so nothing more was sent to the provider.
  expect(current.site.counters.refreshes).toBe(1);
  expect(current.app.secrets.get(profile.managedSecrets.refreshToken as string).provider).toBe(
    "managed",
  );
  expect(current.app.authProfiles.get(profile.id).session.state).toBe("reauth_required");
});

it("SEC-023 revoking an OAuth session revokes the refresh token at the provider and deletes derived credentials", async () => {
  const current = await lab();
  const { profile, env } = await oidc(current);
  await (await authorizeAs(current, profile.id, env.id))();
  const refresh = await reveal(current, profile.managedSecrets.refreshToken as string);
  const revoked = await current.app.authProfiles.revokeSession(profile.id);
  expect(revoked.session).toMatchObject({ state: "revoked", credentials: [] });
  for (const role of ["accessToken", "refreshToken"])
    expect(current.app.secrets.get(profile.managedSecrets[role] as string).revokedAt).toBeTruthy();
  // The provider no longer honours the revoked refresh token.
  const response = await fetch(`${current.site.url}/oauth/token`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "refresh_token",
      refresh_token: refresh,
      client_id: defaults.clientId,
    }).toString(),
  });
  expect(response.status).toBeGreaterThanOrEqual(400);
});

it("SEC-023 a Cognito profile signs in with a TOTP code and reports an unavailable adapter as a checkpoint request", async () => {
  const current = await lab();
  const username = await current.secret("cog-user", defaults.username);
  const password = await current.secret("cog-pass", defaults.password);
  const totpSeed = await current.secret("cog-seed", defaults.totpSeed);
  const profile = await current.profile({
    name: "cognito",
    kind: "oauth",
    config: oauthConfig(current.site, {
      adapter: "cognito",
      cognito: { region: "us-east-1", endpoint: `${current.site.url}/cognito` },
      otp: {},
    }),
    secrets: { username, password, totpSeed },
  });
  const env = current.environment("cognito-env", [profile.id]);
  const receipt = await current.app.authProfiles.testLogin(profile.id, env.id);
  expect(receipt).toMatchObject({ outcome: "authenticated", credentialRoles: ["accessToken"] });
  expect(current.site.counters.logins).toBe(1);
  expect(
    current.app.authProfiles
      .get(profile.id)
      .session.credentials.map((c) => c.role)
      .sort(),
  ).toEqual(["accessToken", "refreshToken"]);
  await current.app.authProfiles.revokeSession(profile.id);
  current.site.control.cognitoPasswordFlowDisabled = true;
  const noFlow = await current.app.authProfiles.testLogin(profile.id, env.id);
  expect(noFlow).toMatchObject({
    outcome: "checkpoint_required",
    reasonCode: "manual_auth_required",
  });
  expect(noFlow.detail).toContain("adapter");
  expect(current.site.counters.logins).toBe(1);
});

it("SEC-023 form profiles on an unrelated site never reuse an OAuth credential", async () => {
  const current = await lab();
  const { profile, env } = await oidc(current);
  await (await authorizeAs(current, profile.id, env.id))();
  const user = await current.secret("u", defaults.username);
  const pass = await current.secret("p", defaults.password);
  const form = await current.profile({
    name: "sibling-form",
    kind: "form",
    config: httpFormConfig(current.site),
    secrets: { username: user, password: pass },
  });
  expect(Object.values(form.managedSecrets)).not.toContain(profile.managedSecrets.accessToken);
  await current.app.authProfiles.revokeSession(profile.id);
  const sibling = current.environment("sibling", [form.id]);
  expect((await current.app.authProfiles.testLogin(form.id, sibling.id)).outcome).toBe(
    "authenticated",
  );
});
