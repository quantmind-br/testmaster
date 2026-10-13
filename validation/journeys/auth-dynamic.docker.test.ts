import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, it } from "vitest";
// The fixture is plain JavaScript outside the build graph; journeys import it by path.
import {
  referenceAuthDefaults,
  startReferenceAuth,
  // @ts-expect-error The fixture ships no declaration files.
} from "../../fixtures/reference-auth/src/index.js";
import {
  action,
  assertion,
  data,
  executable,
  files,
  type Journey,
  journey,
  literal,
  locator,
  object,
  text,
} from "./harness.js";

interface Site {
  url: string;
  control: Record<string, unknown>;
  requests: { method: string; path: string; headers: Record<string, string>; body: string }[];
  counters: Record<string, number>;
  expireSessions(): void;
  close(): Promise<void>;
}
const defaults = referenceAuthDefaults as { username: string; password: string };
const metadata = {
  class: "deterministic-e2e",
  runner: "real-docker",
  externalDependency: "local-reference-auth",
  limitations: [
    "Reference identity provider and target on loopback; no real SaaS IdP, WebAuthn or push approval.",
    "Automated oracle only; CAPTCHA is a recorded checkpoint, never solved.",
  ],
};

/** Stores the target's username and password in the vault, bound to the site's origin. */
async function vaultCredentials(
  session: Journey,
  site: Site,
  password = defaults.password,
): Promise<Record<string, string>> {
  const set = async (name: string, variable: string, value: string) =>
    text(
      (
        await session.command(
          ["secret", "set", name, "--from-env", variable, "--allowed-origin", site.url],
          0,
          { [variable]: value },
        )
      ).id,
    );
  return {
    "site-user": await set("site-user", "TM_SITE_USER", defaults.username),
    "site-pass": await set("site-pass", "TM_SITE_PASS", password),
  };
}

/** Everything a journey needs: the site, the vault entries, a profile and an environment bound to it. */
async function setup(
  session: Journey,
  site: Site,
  options: { password?: string; profile?: Record<string, unknown> } = {},
) {
  await session.init(site.url);
  const ids = await vaultCredentials(session, site, options.password);
  const idOf = (name: string) => ids[name] as string;
  const body = options.profile ?? {
    name: "site-login",
    kind: "form",
    originBindings: [site.url],
    secrets: { username: idOf("site-user"), password: idOf("site-pass") },
    config: {
      http: {
        loginUrl: `${site.url}/api/login`,
        contentType: "json",
        fields: { username: "username", password: "password" },
        success: { statusIn: [200], tokenPointer: "/token" },
        challenge: { statusIn: [403], bodyContains: "captcha-required", kind: "captcha" },
      },
    },
  };
  const profilePath = join(session.cwd, "auth-profile.json");
  await writeFile(profilePath, JSON.stringify({ secrets: {}, ...body }));
  const profile = await session.command(["auth-profile", "create", "--file", profilePath]);
  const environment = await session.command([
    "env",
    "create",
    "--name",
    "authenticated",
    "--base-url",
    site.url,
    "--network-profile",
    "local-loopback",
    "--auth-ref",
    text(profile.id),
  ]);
  return { profile, environment, idOf, profilePath };
}
const items = (value: unknown): Record<string, unknown>[] =>
  (Array.isArray(value) ? value : (object(value).items as unknown[])).map((item) => object(item));

/** A plan that calls the authenticated API with the managed credential as its Authorization header. */
function whoAmI(secretRef: string, expectedUser = defaults.username) {
  return executable("Who am I with the managed credential", "http", [
    action("me", "request", {
      method: "GET",
      pathSegments: [literal("api"), literal("me")],
      query: [],
      headers: { authorization: { secretRef } },
    }),
    {
      ...assertion("me_status", { responseStepId: "me" }, "statusIn"),
      expectation: { predicate: "statusIn", values: [200] },
    } as never,
    assertion(
      "me_user",
      { responseStepId: "me", jsonPointer: "/user" },
      "jsonEquals",
      expectedUser,
    ),
  ]);
}
async function run(
  session: Journey,
  testId: string,
  expectedExit: number,
  environment = "authenticated",
) {
  const result = await session.start([
    "test",
    "run",
    testId,
    "--env",
    environment,
    "--wait",
    "--timeout",
    "180",
  ]).result;
  const runId = text(object(data(result.json).receipt).runId);
  if (result.exitCode !== expectedExit)
    expect.fail(
      `exit ${result.exitCode}, expected ${expectedExit}: ${JSON.stringify(await session.command(["run", "events", runId]))}`,
    );
  const current = await session.current(runId);
  const events = items(await session.command(["run", "events", runId]));
  const failure = events.find((event) => event.type === "run.execution_error");
  const reduced = events.find((event) => event.type === "run.reduced");
  const payload = object(failure?.payload ?? {});
  return {
    runId,
    run: current,
    reasonCode: (payload.reasonCode ?? reduced?.payload.reasonCode) as string | undefined,
    authFailure: object(payload.details ?? {}).authFailure as string | undefined,
  };
}
/** Retained files (evidence bundles, logs, vault metadata) that contain any of the given values. */
async function leaks(session: Journey, values: string[]): Promise<string[]> {
  const found: string[] = [];
  for (const path of await files(session.dataDir)) {
    const content = await readFile(path, "latin1").catch(() => "");
    if (values.some((value) => content.includes(value)))
      found.push(path.slice(session.dataDir.length + 1));
  }
  return found;
}

it("M4-03 SEC-023 J10 an HTTP login runs before the Attempt and the managed token never reaches evidence", async () => {
  const site = (await startReferenceAuth()) as Site;
  try {
    await journey(
      "m4-auth-http-managed-token",
      async (session) => {
        const { profile } = await setup(session, site);
        const token = text(object(profile.managedSecrets).token);
        const test = await session.createTest(whoAmI(token));
        const first = await run(session, text(test.id), 0);
        expect(first.run.outcome).toBe("passed");
        expect(site.counters.logins).toBe(1);
        const call = site.requests.find((request) => request.path === "/api/me");
        const bearer = String(call?.headers.authorization ?? "");
        expect(bearer).toMatch(/^Bearer /u);
        const tokenValue = bearer.slice("Bearer ".length);
        // A second Run reuses the still-valid session: no new login.
        const second = await run(session, text(test.id), 0);
        expect(second.run.outcome).toBe("passed");
        expect(site.counters.logins).toBe(1);
        // Neither the credential nor the token the login produced is in any retained file.
        // (The plan literal names the expected user, so the username is searched in evidence only.)
        expect(await leaks(session, [tokenValue, defaults.password])).toEqual([]);
        expect(
          (await leaks(session, [defaults.username])).filter((path) => path.startsWith("runs/")),
        ).toEqual([]);
        const view = await session.command(["auth-profile", "get", text(profile.id)]);
        expect(JSON.stringify(view)).not.toContain(tokenValue);
        expect(object(view.session).state).toBe("authenticated");
        session.oracles.push({
          check: "httpLoginBeforeAttempt",
          healthy: true,
          observed: { logins: site.counters.logins, runs: [first.runId, second.runId] },
        });
      },
      metadata,
    );
  } finally {
    await site.close();
  }
});

it("M4-03 SEC-024 J10 a failing assertion stays failed while rejected credentials block without reaching the target", async () => {
  const site = (await startReferenceAuth()) as Site;
  try {
    await journey(
      "m4-auth-failure-classes",
      async (session) => {
        const { profile, idOf } = await setup(session, site);
        const token = text(object(profile.managedSecrets).token);
        const wrong = await session.createTest(whoAmI(token, "bob"), "wrong-user.json");
        // Authentication works, the oracle disagrees: the Run FAILED, it is not blocked.
        const failed = await run(session, text(wrong.id), 1);
        expect(failed.run.outcome).toBe("failed");
        const steps = items(await session.command(["run", "steps", failed.runId]));
        expect(
          steps.filter((step) => step.status === "failed").map((step) => step.planStepId),
        ).toEqual(["me_user"]);
        // Rotate the stored password to a wrong value: the login is rejected, the Run is BLOCKED.
        await session.command(
          ["secret", "rotate", idOf("site-pass"), "--from-env", "TM_SITE_PASS"],
          0,
          { TM_SITE_PASS: "definitely-not-the-password" },
        );
        site.expireSessions();
        const good = await session.createTest(whoAmI(token), "good-user.json");
        // The target now rejects the stored token: inconclusive on authentication, not a failed assertion.
        const stale = await run(session, text(good.id), 1);
        expect(stale.run.outcome).toBe("inconclusive");
        expect(stale.reasonCode).toBe("manual_auth_required");
        // The rejected credential is not replayed: the next Run signs in again, and the wrong password blocks it.
        const apiCallsBefore = site.counters.apiCalls;
        const blocked = await run(session, text(good.id), 9);
        expect(blocked.run.outcome).toBe("blocked");
        expect(blocked.authFailure).toBe("login_rejected");
        expect(site.counters.apiCalls).toBe(apiCallsBefore);
        expect(site.counters.loginFailures).toBe(1);
        // The bounded cooldown means the next Run does not hammer the identity provider.
        const again = await run(session, text(good.id), 9);
        expect(again.run.outcome).toBe("blocked");
        expect(site.counters.loginFailures).toBe(1);
        // Restoring the secret and testing explicitly recovers the profile.
        await session.command(
          ["secret", "rotate", idOf("site-pass"), "--from-env", "TM_SITE_PASS"],
          0,
          { TM_SITE_PASS: defaults.password },
        );
        const environments = items(await session.command(["env", "list"]));
        const environmentId = text(environments.find((env) => env.name === "authenticated")?.id);
        const tested = await session.command([
          "auth-profile",
          "test-login",
          text(profile.id),
          "--environment",
          environmentId,
        ]);
        expect(tested.outcome).toBe("authenticated");
        const recovered = await run(session, text(good.id), 0);
        expect(recovered.run.outcome).toBe("passed");
        session.oracles.push({
          check: "authFailureDistinctFromAssertionFailure",
          healthy: true,
          observed: {
            failed: failed.run.outcome,
            inconclusive: stale.run.outcome,
            blocked: blocked.run.outcome,
            recovered: recovered.run.outcome,
          },
        });
      },
      metadata,
    );
  } finally {
    await site.close();
  }
});

it("M4-03 SEC-023 J10 an expired target session is re-established once and a revoked session refuses use", async () => {
  const site = (await startReferenceAuth()) as Site;
  try {
    await journey(
      "m4-auth-expiry-revocation",
      async (session) => {
        const { profile } = await setup(session, site);
        const test = await session.createTest(whoAmI(text(object(profile.managedSecrets).token)));
        await run(session, text(test.id), 0);
        expect(site.counters.logins).toBe(1);
        // The target expires the session: that Run is inconclusive, never a silent pass or a failed assertion.
        site.expireSessions();
        const stale = await run(session, text(test.id), 1);
        expect(stale.run.outcome).toBe("inconclusive");
        expect(stale.reasonCode).toBe("manual_auth_required");
        // The next Run signs in exactly once more and passes.
        const renewed = await run(session, text(test.id), 0);
        expect(renewed.run.outcome).toBe("passed");
        expect(site.counters.logins).toBe(2);
        // A revoked session refuses use before any Run is admitted or any login is attempted.
        await session.command(["auth-profile", "revoke-session", text(profile.id)]);
        const refused = await session.start([
          "test",
          "run",
          text(test.id),
          "--env",
          "authenticated",
          "--wait",
          "--timeout",
          "60",
        ]).result;
        expect(refused.exitCode).not.toBe(0);
        expect(object(refused.json?.error)).toMatchObject({ code: "POLICY_DENIED" });
        expect(site.counters.logins).toBe(2);
        expect(site.counters.loginFailures).toBe(0);
      },
      metadata,
    );
  } finally {
    await site.close();
  }
});

it("M4-03 SEC-022 SEC-024 J10 a browser login is captured as a storage state, reused, and CAPTCHA stays a recorded checkpoint", async () => {
  const site = (await startReferenceAuth()) as Site;
  try {
    await journey(
      "m4-auth-browser-state",
      async (session) => {
        await session.init(site.url);
        const ids = await vaultCredentials(session, site);
        const idOf = (name: string) => ids[name] as string;
        const profilePath = join(session.cwd, "browser-profile.json");
        await writeFile(
          profilePath,
          JSON.stringify({
            name: "browser-login",
            kind: "form",
            originBindings: [site.url],
            secrets: { username: idOf("site-user"), password: idOf("site-pass") },
            config: {
              browser: {
                steps: [
                  {
                    id: "open",
                    kind: "action",
                    operation: "navigate",
                    description: "Open the login page",
                    required: true,
                    input: { path: "/login" },
                  },
                  {
                    id: "user",
                    kind: "action",
                    operation: "fill",
                    description: "Fill the username",
                    required: true,
                    input: {
                      locator: locator("username"),
                      value: { secretRef: idOf("site-user") },
                    },
                  },
                  {
                    id: "pass",
                    kind: "action",
                    operation: "fill",
                    description: "Fill the password",
                    required: true,
                    input: {
                      locator: locator("password"),
                      value: { secretRef: idOf("site-pass") },
                    },
                  },
                  {
                    id: "submit",
                    kind: "action",
                    operation: "click",
                    description: "Sign in",
                    required: true,
                    input: { locator: locator("submit") },
                  },
                ],
              },
            },
          }),
        );
        const profile = await session.command(["auth-profile", "create", "--file", profilePath]);
        await session.command([
          "env",
          "create",
          "--name",
          "authenticated",
          "--base-url",
          site.url,
          "--network-profile",
          "local-loopback",
          "--auth-ref",
          text(profile.id),
        ]);
        const plan = executable("Signed-in home page", "playwright", [
          action("home", "navigate", { path: "/home" }),
          assertion("whoami", { locator: locator("whoami") }, "textContains", "Signed in as"),
        ]);
        const test = await session.createTest(plan);
        const first = await run(session, text(test.id), 0);
        expect(first.run.outcome).toBe("passed");
        expect(site.counters.logins).toBe(1);
        const captured = await session.command(["auth-profile", "get", text(profile.id)]);
        expect(object(captured.session).state).toBe("authenticated");
        // The second Run reuses the captured state: the login form is not submitted again.
        const second = await run(session, text(test.id), 0);
        expect(second.run.outcome).toBe("passed");
        expect(site.counters.logins).toBe(1);
        const cookie = site.requests
          .filter((request) => request.path === "/home")
          .map((request) => /session=([^;]+)/u.exec(request.headers.cookie ?? "")?.[1])
          .find(Boolean);
        expect(cookie).toBeTruthy();
        expect(await leaks(session, [defaults.password, String(cookie)])).toEqual([]);
        // CAPTCHA: a second profile signs in against a target that now demands one. The login
        // never completes, the Run blocks on a human step and the pendency is recorded.
        site.control.captcha = true;
        const captchaPath = join(session.cwd, "captcha-profile.json");
        const base = JSON.parse(await readFile(profilePath, "utf8")) as Record<string, unknown>;
        await writeFile(
          captchaPath,
          JSON.stringify({
            ...base,
            name: "browser-captcha",
            config: {
              ...object(base.config),
              challenge: { kind: "captcha", resolution: "storage-state" },
            },
          }),
        );
        const captchaProfile = await session.command([
          "auth-profile",
          "create",
          "--file",
          captchaPath,
        ]);
        await session.command([
          "env",
          "create",
          "--name",
          "captcha",
          "--base-url",
          site.url,
          "--network-profile",
          "local-loopback",
          "--auth-ref",
          text(captchaProfile.id),
        ]);
        const blocked = await run(session, text(test.id), 9, "captcha");
        expect(blocked.run.outcome).toBe("blocked");
        expect(blocked.reasonCode).toBe("manual_auth_required");
        const pending = items(
          await session.command(["auth-checkpoint", "list", "--state", "pending"]),
        );
        expect(pending.some((checkpoint) => checkpoint.kind === "captcha")).toBe(true);
        expect(site.counters.logins).toBe(1);
      },
      metadata,
    );
  } finally {
    await site.close();
  }
});
