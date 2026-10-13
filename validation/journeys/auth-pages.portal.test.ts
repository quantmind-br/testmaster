import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import {
  created,
  defaults,
  type Harness,
  httpLoginConfig,
  type Site,
  startSite,
  vaultSecret,
  waitForRun,
  whoAmIPlan,
} from "./auth-stack.js";
import {
  atViewport,
  expectAccessible,
  expectNoPageOverflow,
  keyboardOnly,
  type OpenPortal,
  openPortal,
} from "./portal.js";
import { type ServerStack, startServerStack } from "./server-stack.js";

/**
 * The authentication pages against the real server profile. The reference site plays both the
 * identity provider and the app under test on loopback; the server process signs in to it and the
 * server-profile worker executes the Runs.
 */
const callback = "http://127.0.0.1:9/callback";

let stack: ServerStack;
let site: Site;
let projectId = "";
const open: OpenPortal[] = [];
const harness = (): Harness => ({ stack, site });
const vault = (name: string, value: string) => vaultSecret(harness(), name, value);

beforeAll(async () => {
  site = await startSite({ redirectUri: callback, clientSecret: null });
  stack = await startServerStack({ worker: true });
  projectId = (
    await created<{ id: string }>(
      stack.ownerClient().mutate("POST", "/v1/projects", { name: "Auth pages project" }),
      "project",
    )
  ).id;
  await created<{ id: string }>(
    stack.ownerClient().mutate("POST", `/v1/projects/${projectId}/environments`, {
      name: "Reference site",
      baseUrl: site.url,
      networkProfile: "local-loopback",
      production: false,
    }),
    "environment",
  );
}, 600_000);

afterAll(async () => {
  for (const portal of open.splice(0)) await portal.close().catch(() => undefined);
  await stack?.stop();
  await site?.close();
});

/** Each page belongs to its own administrator: the server rate-limits writes per principal. */
async function portal() {
  const admin = await stack.addMember("org_admin");
  const opened = await openPortal(
    { baseUrl: stack.baseUrl, spkiSha256: stack.ca.spkiSha256 },
    admin,
  );
  open.push(opened);
  return opened;
}

/** Fills the creation form with vault secret IDs and a login configuration. */
async function createThroughForm(
  page: OpenPortal["page"],
  name: string,
  secrets: { username: string; password: string },
): Promise<string> {
  await page.goto("/auth-profiles/new");
  await page.getByRole("heading", { level: 1, name: "New authentication profile" }).waitFor();
  await page
    .getByRole("combobox", { name: /^Project/u })
    .selectOption({ label: "Auth pages project" });
  await page.getByRole("textbox", { name: /^Name/u }).fill(name);
  await page.getByLabel("Target origins").fill(site.url);
  await page.getByLabel("Vault secret ID for username").fill(secrets.username);
  await page.getByLabel("Vault secret ID for password").fill(secrets.password);
  await page.getByLabel("Configuration (JSON)").fill(JSON.stringify(httpLoginConfig(site)));
  await page.getByRole("button", { name: "Create profile" }).click();
  await page.waitForURL((url) => /^\/auth-profiles\/aup_/u.test(url.pathname));
  await page.getByRole("heading", { level: 1, name }).waitFor();
  return new URL(page.url()).pathname.split("/").pop() as string;
}

async function testSignIn(page: OpenPortal["page"]): Promise<string> {
  await page.getByLabel("Environment").first().selectOption({ label: "Reference site" });
  await page.getByRole("button", { name: "Test sign-in" }).click();
  const result = page.getByTestId("test-login-result");
  const alert = page.getByRole("alert");
  await result.or(alert).first().waitFor();
  if (await alert.count())
    throw new Error(`Test sign-in was refused: ${await alert.first().innerText()}`);
  return (await result.innerText()).replace(/\s+/gu, " ");
}

/** Everything the page, its storage and its URL expose to a viewer. */
async function exposure(page: OpenPortal["page"]): Promise<string> {
  const storage = await page.evaluate(() =>
    JSON.stringify([
      document.documentElement.outerHTML,
      Object.entries(localStorage),
      Object.entries(sessionStorage),
      location.href,
      document.cookie,
    ]),
  );
  const inputs = await page.evaluate(() =>
    [...document.querySelectorAll("input, textarea")].map(
      (element) => (element as HTMLInputElement).value,
    ),
  );
  return `${storage}\n${inputs.join("\n")}`;
}

describe("authentication pages on the server profile", () => {
  it("UX-046 M4-03 an admin creates a profile, tests the sign-in and never sees a credential value", async () => {
    const { page, diagnostics } = await portal();
    const username = await vault("page-user", defaults.username);
    const password = await vault("page-pass", defaults.password);
    const profileId = await createThroughForm(page, "Reference login", {
      username: username.id,
      password: password.id,
    });
    expect(profileId).toMatch(/^aup_/u);
    await page.getByText("No credentials yet").waitFor();
    expect(site.counters.logins).toBe(0);

    const outcome = await testSignIn(page);
    expect(outcome).toContain("Outcome: authenticated");
    expect(outcome).toContain("Credentials prepared: token");
    expect(outcome).toContain("Nothing was saved to any test, revision or proposal.");
    expect(site.counters.logins).toBe(1);
    await page.getByRole("cell", { name: "token", exact: true }).waitFor();
    expect(
      await page.getByRole("row").filter({ hasText: "token" }).first().innerText(),
    ).not.toMatch(/Bearer|correct-horse/u);

    // The credential, the vault IDs' values and the managed token are nowhere a viewer can look.
    const seen = await exposure(page);
    expect(seen).not.toContain(defaults.password);
    expect(seen).not.toMatch(/Bearer\s+[A-Za-z0-9_-]{16,}/u);
    // The secret ID inputs of the creation form are never prefilled with a stored value.
    await page.goto("/auth-profiles/new");
    await page.getByRole("heading", { level: 1, name: "New authentication profile" }).waitFor();
    expect(await page.getByRole("textbox", { name: /^Name/u }).inputValue()).toBe("");
    for (const label of ["Vault secret ID for username", "Vault secret ID for password"])
      expect(await page.getByLabel(label).inputValue()).toBe("");

    // The list shows the profile with its session state.
    await page.goto("/auth-profiles");
    await page.getByRole("link", { name: "Reference login" }).waitFor();
    await expectAccessible(page, "auth profiles list");
    // Only catalog /v1 routes were used.
    expect(
      diagnostics.requests.filter(
        (request) => !/^(GET|POST|PATCH|PUT|DELETE) \/(v1\/|assets\/|login|auth-|$)/u.test(request),
      ),
    ).toEqual([]);
    expect(
      diagnostics.requests.some(
        (request) => request === `POST /v1/auth-profiles/${profileId}/test-login`,
      ),
    ).toBe(true);
  });

  it("M4-03 a rejected sign-in is reported as an authentication failure and saves nothing", async () => {
    const { page } = await portal();
    const username = await vault("bad-user", defaults.username);
    const password = await vault("bad-pass", "definitely-not-the-password");
    await createThroughForm(page, "Rejected login", {
      username: username.id,
      password: password.id,
    });
    const failures = site.counters.loginFailures ?? 0;
    const outcome = await testSignIn(page);
    expect(outcome).not.toContain("Outcome: authenticated");
    expect(outcome).toContain("Outcome: failed (manual auth required)");
    expect(site.counters.loginFailures).toBe((failures as number) + 1);
    // Nothing was stored: the credentials table is still empty and the session is not authenticated.
    await page.getByText("No credentials yet").waitFor();
    expect(await exposure(page)).not.toContain("definitely-not-the-password");
  });

  it("SEC-023 M4-03 an authorization started from the page hands out a PKCE address and completes only with the person's redirect", async () => {
    const { page } = await portal();
    const issued = await created<{ id: string }>(
      stack.ownerClient().mutate("POST", "/v1/auth-profiles", {
        projectId,
        name: "Reference OIDC",
        kind: "oidc",
        originBindings: [site.url],
        secrets: {},
        config: {
          adapter: "generic",
          issuer: site.url,
          clientId: defaults.clientId,
          audience: defaults.audience,
          scopes: ["openid", "profile"],
          allowedScopes: ["openid", "profile", "email"],
          redirectUris: [callback],
          redirectUri: callback,
        },
      }),
      "oidc profile",
    );
    await page.goto(`/auth-profiles/${issued.id}`);
    await page.getByRole("heading", { level: 1, name: "Reference OIDC" }).waitFor();
    await page.getByLabel("Environment").last().selectOption({ label: "Reference site" });
    await page.getByRole("button", { name: "Start authorization" }).click();
    const address = (await page.getByTestId("authorize-url").innerText()).replace(/^.*?: /u, "");
    expect(address).toContain(`${site.url}/oauth/authorize`);
    expect(address).toMatch(/code_challenge=.+&code_challenge_method=S256/u);
    expect(address).not.toMatch(/code_verifier|client_secret/u);
    await expectAccessible(page, "authorization started");

    // A tampered redirect is refused and nothing is exchanged; the real one completes.
    const redirect = new URL(await site.approve(address));
    const tampered = new URL(redirect);
    tampered.searchParams.set("state", "attacker-chosen-state");
    const exchanges = site.counters.codeExchanges;
    const bad = await vault("redirect-tampered", tampered.href);
    await page.getByLabel("Vault secret ID holding the redirect URL").fill(bad.id);
    await page.getByRole("button", { name: "Complete authorization" }).click();
    await page.getByRole("alert").filter({ hasText: /state/iu }).first().waitFor();
    expect(site.counters.codeExchanges).toBe(exchanges);
    const good = await vault("redirect-good", redirect.href);
    await page.getByLabel("Vault secret ID holding the redirect URL").fill(good.id);
    await page.getByRole("button", { name: "Complete authorization" }).click();
    await page.getByRole("cell", { name: "accessToken", exact: true }).waitFor();
    expect(site.counters.codeExchanges).toBe(exchanges + 1);
    const seen = await exposure(page);
    expect(seen).not.toContain("code=");
    expect(seen).not.toMatch(/Bearer\s+[A-Za-z0-9_-]{16,}/u);
  });

  it("SEC-024 M4-03 a Run blocked on a CAPTCHA leaves a pending checkpoint that only a confirmed cancel stops", async () => {
    const { page } = await portal();
    const username = await vault("captcha-user", defaults.username);
    const password = await vault("captcha-pass", defaults.password);
    const profile = await created<{ id: string; managedSecrets: Record<string, string> }>(
      stack.ownerClient().mutate("POST", "/v1/auth-profiles", {
        projectId,
        name: "Captcha login",
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
    const authenticated = await created<{ id: string }>(
      stack.ownerClient().mutate("POST", `/v1/projects/${projectId}/environments`, {
        name: "Captcha site",
        baseUrl: site.url,
        networkProfile: "local-loopback",
        authRefs: [profile.id],
      }),
      "captcha environment",
    );
    const test = await created<{ id: string }>(
      stack.ownerClient().mutate("POST", `/v1/projects/${projectId}/tests`, {
        origin: "manual",
        plan: whoAmIPlan(profile.managedSecrets.token as string),
      }),
      "test",
    );
    const logins = site.counters.logins;
    const admitted = await created<{ runId: string }>(
      stack.ownerClient().mutate("POST", "/v1/runs", {
        testId: test.id,
        environmentId: authenticated.id,
      }),
      "run",
    );
    await page.goto("/auth-checkpoints");
    await page.getByRole("heading", { level: 1, name: "Manual checkpoints" }).waitFor();
    await vi.waitFor(
      async () => {
        await page.reload();
        await page.getByRole("heading", { level: 1, name: "Manual checkpoints" }).waitFor();
        if ((await page.getByRole("row").filter({ hasText: "pending" }).count()) === 0)
          throw new Error("No pending checkpoint yet");
      },
      { timeout: 60_000, interval: 500 },
    );
    const row = page.getByRole("row").filter({ hasText: "pending" }).first();
    expect(await row.innerText()).toContain("captcha");
    expect(await row.innerText()).toContain(admitted.runId);
    await expectAccessible(page, "auth checkpoints with a pending checkpoint");
    await row.getByRole("button", { name: "Cancel checkpoint" }).click();
    const dialog = page.getByRole("dialog");
    await dialog.waitFor();
    expect(await dialog.innerText()).toContain("The waiting Run stays blocked");
    await expectAccessible(page, "cancel checkpoint confirmation");
    // Keeping it leaves the checkpoint pending: the negative control for the confirmation.
    await dialog.getByRole("button", { name: "Keep waiting" }).click();
    await dialog.waitFor({ state: "detached" });
    await page.getByRole("row").filter({ hasText: "pending" }).first().waitFor();
    await page
      .getByRole("row")
      .filter({ hasText: "pending" })
      .first()
      .getByRole("button", { name: "Cancel checkpoint" })
      .click();
    await page.getByRole("dialog").getByRole("button", { name: "Cancel checkpoint" }).click();
    await page.getByRole("dialog").waitFor({ state: "detached" });
    await page.getByRole("row").filter({ hasText: "cancelled" }).first().waitFor();
    expect(await page.getByRole("row").filter({ hasText: "pending" }).count()).toBe(0);
    // The CAPTCHA was never attempted and the Run ended blocked on the human step.
    const ended = await waitForRun(harness(), admitted.runId);
    expect(ended).toMatchObject({ outcome: "blocked", reasonCode: "manual_auth_required" });
    expect(site.counters.logins).toBe(logins);
  });

  it("SEC-023 M4-03 revoking a session asks for confirmation, erases the credentials and is keyboard operable", async () => {
    const { page } = await portal();
    const username = await vault("revoke-user", defaults.username);
    const password = await vault("revoke-pass", defaults.password);
    await createThroughForm(page, "Revocable login", {
      username: username.id,
      password: password.id,
    });
    await testSignIn(page);
    await page.getByRole("cell", { name: "token", exact: true }).waitFor();
    const keyboard = await keyboardOnly(page);
    await keyboard.tabTo(
      (element) => element.tag === "button" && element.name === "Revoke session",
      200,
    );
    expect((await keyboard.focused()).focusRing).toBe(true);
    await keyboard.press("Enter");
    const dialog = page.getByRole("dialog");
    await dialog.waitFor();
    expect(await dialog.innerText()).toContain("Revocable login");
    // Escape cancels without revoking.
    await keyboard.press("Escape");
    await dialog.waitFor({ state: "detached" });
    await page.getByRole("cell", { name: "token", exact: true }).waitFor();
    await page.getByRole("button", { name: "Revoke session" }).focus();
    await keyboard.press("Enter");
    await dialog.waitFor();
    await keyboard.tabTo(
      (element) => element.tag === "button" && element.name === "Revoke session",
      10,
    );
    await keyboard.press("Enter");
    await dialog.waitFor({ state: "detached" });
    await page.getByText("No credentials yet").waitFor();
    expect(await page.getByText("revoked").count()).toBeGreaterThan(0);
    await keyboard.assertNoPointerUsed();
  });

  it("UX-051 UX-052 the authentication pages are axe clean and reflow at 320 px and 200 % zoom", async () => {
    const { page } = await portal();
    const profiles = (await stack.ownerClient().request("GET", "/v1/auth-profiles")).json<{
      data: { items: { id: string }[] } | { id: string }[];
    }>().data;
    const first = (Array.isArray(profiles) ? profiles : profiles.items)[0];
    expect(first).toBeTruthy();
    for (const path of [
      "/auth-profiles",
      "/auth-profiles/new",
      `/auth-profiles/${first?.id}`,
      "/auth-checkpoints",
    ]) {
      await page.goto(path);
      await page.getByRole("heading", { level: 1 }).first().waitFor();
      await expectAccessible(page, `desktop ${path}`);
    }
    await atViewport(page, { width: 320, zoom: 2 });
    for (const path of ["/auth-profiles", "/auth-profiles/new", `/auth-profiles/${first?.id}`]) {
      await page.goto(path);
      await page.getByRole("heading", { level: 1 }).first().waitFor();
      await expectAccessible(page, `320px ${path}`);
      await expectNoPageOverflow(page, `320px ${path}`);
    }
  });
});
