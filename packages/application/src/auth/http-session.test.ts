import type * as ChildProcess from "node:child_process";
import type { PlanStep } from "@testmaster/contracts";
import { scrubText } from "@testmaster/domain";
import { afterEach, expect, it, vi } from "vitest";
import { type AuthLab, openLab } from "../../test/auth-lab.js";
import { httpCredentials } from "./http-session.js";
import { AuthProfilesService, type BrowserLoginProbe } from "./profiles.js";
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

const stored = (
  kind: StoredAuthProfile["kind"],
  parts: Partial<StoredAuthProfile> = {},
): StoredAuthProfile => ({ kind, secrets: {}, managedSecrets: {}, config: {}, ...parts }) as never;

it("maps each auth kind to the header its credential travels in", () => {
  const roles = (...names: string[]) => ({ roles: names });
  expect(
    httpCredentials(stored("basic", { managedSecrets: { authorization: "sec_a" } }), roles()),
  ).toEqual([{ header: "authorization", secretRef: "sec_a" }]);
  expect(httpCredentials(stored("bearer", { secrets: { token: "sec_t" } }), roles())).toEqual([
    { header: "authorization", secretRef: "sec_t", prefix: "Bearer " },
  ]);
  expect(httpCredentials(stored("api-key", { secrets: { key: "sec_k" } }), roles())).toEqual([
    { header: "x-api-key", secretRef: "sec_k" },
  ]);
  expect(
    httpCredentials(
      stored("api-key", { secrets: { key: "sec_k" }, config: { header: "X-Token" } }),
      roles(),
    ),
  ).toEqual([{ header: "X-Token", secretRef: "sec_k" }]);
  expect(httpCredentials(stored("cookie", { secrets: { cookie: "sec_c" } }), roles())).toEqual([
    { header: "cookie", secretRef: "sec_c" },
  ]);
  expect(
    httpCredentials(stored("oidc", { managedSecrets: { accessToken: "sec_o" } }), roles()),
  ).toEqual([{ header: "authorization", secretRef: "sec_o" }]);
  const form = stored("form", { managedSecrets: { token: "sec_tok", session: "sec_s" } });
  expect(httpCredentials(form, roles("token"))).toEqual([
    { header: "authorization", secretRef: "sec_tok" },
  ]);
  expect(httpCredentials(form, roles("session"))).toEqual([
    { header: "cookie", secretRef: "sec_s" },
  ]);
  // Browser-state profiles send their cookies as the storage state, not as a header.
  expect(httpCredentials(form, roles("storageState"))).toEqual([]);
  expect(httpCredentials(stored("manual"), roles("storageState"))).toEqual([]);
});

async function serviceLab(browserLogin?: BrowserLoginProbe) {
  const current = await openLab();
  labs.push(current);
  const service = new AuthProfilesService(current.app.context, {
    secrets: current.app.secrets,
    stepUp: async () => undefined,
    ...(browserLogin ? { browserLogin } : {}),
  });
  const prepare = (environmentId: string, runner?: "http" | "playwright" | "terminal") =>
    service.prepare({
      run: { id: "run_01900000-0000-7000-8000-000000000001", origin: "cli", requestedBy: "usr_x" },
      attemptId: "att_01900000-0000-7000-8000-000000000001",
      environment: service.environment(environmentId).environment,
      signal: new AbortController().signal,
      deadlineAt: Date.now() + 60_000,
      interactive: false,
      ...(runner ? { runner } : {}),
    });
  return { current, service, prepare };
}
const login: PlanStep = {
  id: "open",
  kind: "action",
  operation: "navigate",
  description: "Open the login page",
  input: { path: "/login" },
} as never;
const sessionState = (domain: string) =>
  JSON.stringify({
    cookies: [{ name: "sid", value: "tm-cookie", domain, path: "/", expires: -1, secure: false }],
    origins: [],
  });

it("HTTP and browser attempts receive the static header credential their auth-profile requests send", async () => {
  const lab = await serviceLab();
  const token = await lab.current.secret("api-token", "static-token-value");
  const profile = await lab.current.profile({
    name: "static-bearer",
    kind: "bearer",
    config: {},
    secrets: { token },
  });
  const environment = lab.current.environment("http-env", [profile.id]);
  const credentials = [{ header: "authorization", secretRef: token, prefix: "Bearer " }];
  const http = await lab.prepare(environment.id, "http");
  expect(http.runnerAuth).toEqual({ credentials });
  expect(http.secretIds).toContain(token);
  expect(JSON.stringify(http)).not.toContain("static-token-value");
  // A browser plan's request steps with `auth: "profile"` send the same header.
  const browser = await lab.prepare(environment.id, "playwright");
  expect(browser.runnerAuth).toEqual({ credentials });
  expect(browser.secretIds).toContain(token);
  // A terminal plan has no request step, so it never receives the credential.
  expect((await lab.prepare(environment.id, "terminal")).runnerAuth).toBeNull();
});

it("an HTTP attempt signs a browser-login profile in first and uses the captured state", async () => {
  const probe = vi.fn<BrowserLoginProbe>();
  const lab = await serviceLab(probe);
  const domain = new URL(lab.current.site.url).hostname;
  probe.mockImplementation(async ({ onAuthState }) => {
    await onAuthState(sessionState(domain));
    return { ok: true, reasonCode: "assertions_satisfied" };
  });
  const profile = await lab.current.profile({
    name: "browser-form",
    kind: "form",
    config: { browser: { steps: [login] } },
    secrets: {},
  });
  const environment = lab.current.environment("browser-env", [profile.id]);
  // A browser attempt still signs in itself, inside its own context.
  const browser = await lab.prepare(environment.id, "playwright");
  expect(browser.runnerAuth).toMatchObject({ login: { captureState: true } });
  expect(probe).not.toHaveBeenCalled();
  const http = await lab.prepare(environment.id, "http");
  expect(probe).toHaveBeenCalledOnce();
  const stateSecret = profile.managedSecrets.storageState as string;
  expect(http.runnerAuth).toEqual({ storageState: { secretRef: stateSecret } });
  expect(http.secretIds).toContain(stateSecret);
  expect(JSON.stringify(http)).not.toContain("tm-cookie");
});

it("an HTTP attempt is blocked, not unauthenticated, when the browser login fails or no browser exists", async () => {
  const failing = vi.fn<BrowserLoginProbe>(async () => ({ ok: false, reasonCode: "failed" }));
  const lab = await serviceLab(failing);
  const profile = await lab.current.profile({
    name: "browser-form",
    kind: "form",
    config: { browser: { steps: [login] } },
    secrets: {},
  });
  const environment = lab.current.environment("browser-env", [profile.id]);
  const recorded = vi.spyOn(lab.service.engine, "recordBrowserLoginFailure").mockReturnValue(null);
  await expect(lab.prepare(environment.id, "http")).rejects.toMatchObject({
    details: { reasonCode: "manual_auth_required", authFailure: "login_rejected" },
  });
  expect(failing).toHaveBeenCalledOnce();
  // The failure is counted against the profile (and leaves a pendency for a person).
  expect(recorded).toHaveBeenCalledOnce();
  const bare = await serviceLab();
  const other = await bare.current.profile({
    name: "browser-form",
    kind: "form",
    config: { browser: { steps: [login] } },
    secrets: {},
  });
  const env = bare.current.environment("no-browser", [other.id]);
  await expect(bare.prepare(env.id, "http")).rejects.toMatchObject({
    details: {
      reasonCode: "security_precondition_failed",
      authFailure: "browser_login_unavailable",
    },
  });
});

it("SEC-033 a plain username is not a redaction value, a secret username is, and the password always is", async () => {
  const lab = await serviceLab();
  const password = await lab.current.secret("redact-pass", "pw-canary-value");
  const secretUser = await lab.current.secret("redact-user", "root");
  const fill = (id: string, value: Record<string, string>): PlanStep =>
    ({
      id,
      kind: "action",
      operation: "fill",
      description: "Fill the field",
      input: { locator: { by: "testId", value: id }, value },
    }) as never;
  const plain = await lab.current.profile({
    name: "plain-username",
    kind: "form",
    username: "root",
    secrets: { password },
    config: {
      browser: {
        steps: [login, fill("user", { literal: "root" }), fill("pass", { secretRef: password })],
      },
    },
  });
  const masked = await lab.current.profile({
    name: "secret-username",
    kind: "form",
    secrets: { username: secretUser, password },
    config: {
      browser: {
        steps: [
          login,
          fill("user", { secretRef: secretUser }),
          fill("pass", { secretRef: password }),
        ],
      },
    },
  });
  /** What the Attempt would hand the redactor for an environment that uses `profileId`. */
  const redactionValues = async (name: string, profileId: string): Promise<string[]> => {
    const prepared = await lab.prepare(lab.current.environment(name, [profileId]).id, "playwright");
    return await Promise.all(
      prepared.secretIds.map(async (id) => (await lab.current.app.secrets.release(id)).resolve()),
    );
  };
  const dom = '<div id="root">Signed in as root with pw-canary-value</div>';
  const plainValues = await redactionValues("plain-env", plain.id);
  expect(plainValues).toContain("pw-canary-value");
  expect(plainValues).not.toContain("root");
  expect(scrubText(dom, plainValues).text).toBe(
    '<div id="root">Signed in as root with [REDACTED]</div>',
  );
  // Negative control: the same page with the username kept as a secret loses every `root`.
  const maskedValues = await redactionValues("secret-env", masked.id);
  expect(maskedValues).toEqual(expect.arrayContaining(["root", "pw-canary-value"]));
  expect(scrubText(dom, maskedValues).text).toBe(
    '<div id="[REDACTED]">Signed in as [REDACTED] with [REDACTED]</div>',
  );
});
