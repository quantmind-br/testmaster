import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { Page } from "playwright-core";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  asOwner,
  type CountingTarget,
  closedPort,
  createEnvironment,
  createProject,
  createSecret,
  privateEndpointCalls,
  startCountingTarget,
} from "./m4-portal-support.js";
import {
  atViewport,
  expectAccessible,
  expectNoPageOverflow,
  keyboardOnly,
  type OpenPortal,
  openPortal,
} from "./portal.js";
import { type ServerStack, type StackUser, startServerStack } from "./server-stack.js";
import type { HttpsClient } from "./tls-proxy.js";

/**
 * UX-009 / UX-010: the onboarding wizard against the real server profile (PostgreSQL, built CLI
 * server process, TLS proxy). The target application is a local HTTP server that counts contacts,
 * so "a denied target is never contacted" is observed rather than assumed.
 */
let stack: ServerStack;
let brokenRunner: ServerStack;
let target: CountingTarget;
let projectId = "";
let environmentId = "";
let sourceId = "";
let brokenProjectId = "";
const open: OpenPortal[] = [];
const requests: string[] = [];

async function portal(user: StackUser | null, which: ServerStack = stack) {
  const opened = await openPortal(
    { baseUrl: which.baseUrl, spkiSha256: which.ca.spkiSha256 },
    user,
    { signIn: user !== null },
  );
  open.push(opened);
  return opened;
}

beforeAll(async () => {
  [stack, brokenRunner] = await Promise.all([
    startServerStack({ userPolicy: { allowUpload: true } }),
    // The only difference is a Docker daemon that cannot be reached.
    startServerStack({
      userPolicy: { allowUpload: true },
      extraEnv: { DOCKER_HOST: "unix:///nonexistent/tm-onboarding.sock" },
    }),
  ]);
  target = await startCountingTarget();
  projectId = await createProject(stack, "Onboarding journey");
  environmentId = await createEnvironment(stack, projectId, {
    name: "local",
    baseUrl: target.url,
    networkProfile: "local-loopback",
  });
  await writeFile(
    join(stack.cwd, "openapi.json"),
    JSON.stringify({
      openapi: "3.1.0",
      info: { title: "Health", version: "1" },
      paths: {
        "/health": { get: { operationId: "health", responses: { "200": { description: "ok" } } } },
      },
    }),
  );
  const scope = await asOwner(stack);
  const added = await scope.sources.add({
    projectId,
    role: "api-spec",
    path: "openapi.json",
    format: "openapi",
  });
  sourceId = added.source.id;
  brokenProjectId = await createProject(brokenRunner, "Broken runner journey");
  await createEnvironment(brokenRunner, brokenProjectId, {
    name: "local",
    baseUrl: target.url,
    networkProfile: "local-loopback",
  });
}, 600_000);

afterAll(async () => {
  for (const opened of open.splice(0)) {
    requests.push(...opened.diagnostics.requests);
    await opened.close().catch(() => undefined);
  }
  await target?.close();
  await Promise.all([stack?.stop(), brokenRunner?.stop()]);
});

type ActorClient = Pick<HttpsClient, "request" | "mutate">;
interface Actor {
  readonly user: StackUser;
  readonly client: ActorClient;
}
let actor: Actor;

/** The same principal as the browser session, over a bearer token (no extra sign-in budget). */
function bearerClient(token: string): ActorClient {
  const client = stack.anonymous();
  const authorization = { authorization: `Bearer ${token}` };
  return {
    request: (method, path, options = {}) =>
      client.request(method, path, {
        ...options,
        cookies: false,
        headers: { ...authorization, ...options.headers },
      }),
    mutate: (method, path, body, extra = {}) =>
      client.request(method, path, {
        body,
        cookies: false,
        headers: {
          origin: stack.baseUrl,
          "idempotency-key": crypto.randomUUID(),
          ...authorization,
          ...extra,
        },
      }),
  };
}

/**
 * The server limits mutations per principal (a burst of 20, then one per second) and sign-ins per
 * client address. Three organization admins take turns: each test starts from a state it sets
 * itself, and no principal is throttled by the previous test's saves.
 */
const actors: Actor[] = [];
let turn = 0;
beforeAll(async () => {
  for (let index = 0; index < 3; index++) {
    const user = await stack.addMember("org_admin");
    const token = await stack.issueToken(user.principalId, ["R", "W", "X", "A"]);
    actors.push({ user, client: bearerClient(token) });
  }
}, 120_000);
beforeEach(() => {
  actor = actors[turn++ % actors.length] as Actor;
});

const stateUrl = (id = projectId) => `/v1/projects/${id}/onboarding`;

/**
 * Waits for the step title inside the page body. Scoping to `main` matters: the shell navigation
 * has its own level-2 headings ("Project", "Settings"), and a page-wide match for "Project"
 * resolves before the wizard has left the previous step.
 */
async function stepHeading(page: Page, name: string) {
  await page.getByRole("main").getByRole("heading", { level: 2, name, exact: true }).waitFor();
}

async function putState(id: string, body: Record<string, unknown>, client = actor.client) {
  const current = await client.request("GET", stateUrl(id));
  const etag = String(current.headers.etag);
  // Every saved state keeps the source the wizard's "source" step requires.
  const choices = { sourceIds: [sourceId], ...(body.choices as Record<string, unknown>) };
  return client.mutate("PUT", stateUrl(id), { ...body, choices }, { "if-match": etag });
}

async function runChecks(page: Page, button: string) {
  await page.getByRole("button", { name: button }).click();
  await page.locator('[data-testid="prerequisite-report"], [role="alert"]').first().waitFor();
  if ((await page.getByTestId("prerequisite-report").count()) === 0)
    throw new Error(`prerequisite checks failed: ${await page.locator("main").innerText()}`);
}

describe("onboarding wizard", () => {
  it("UX-009 saves progress on the server per principal and resumes in a fresh browser at the same step", async () => {
    const first = await portal(actor.user);
    const { page } = first;
    await page.goto(`/projects/${projectId}/onboarding`);
    await page.getByRole("heading", { level: 1, name: /Set up Onboarding journey/ }).waitFor();
    await stepHeading(page, "Choose a mode");
    expect(await page.getByTestId("resume-note").count()).toBe(0);
    await page.getByLabel(/Server — shared by a team/).check();
    await page.getByRole("button", { name: "Save and continue" }).click();
    await stepHeading(page, "Project");
    await page.getByRole("button", { name: "Save and continue" }).click();
    await stepHeading(page, "Add sources");
    expect(await page.getByTestId("intake-policy").textContent()).toContain("Uploads are allowed");

    // Negative control: a step with a missing prerequisite names it and sends nothing.
    const putsBefore = first.diagnostics.requests.filter((entry) =>
      entry.startsWith("PUT /v1/projects"),
    ).length;
    await page.getByRole("button", { name: "Save and continue" }).click();
    await page.getByTestId("error-summary").waitFor();
    expect(await page.getByTestId("error-summary").textContent()).toContain(
      "Select at least one source",
    );
    expect(
      first.diagnostics.requests.filter((entry) => entry.startsWith("PUT /v1/projects")).length,
    ).toBe(putsBefore);

    await page.getByLabel(/openapi\.json/).check();
    await page.getByRole("button", { name: "Save and continue" }).click();
    await stepHeading(page, "Target application");
    await page.getByLabel("Base URL").fill(target.url);
    await page.getByLabel("Application type").fill("Node.js HTTP API");
    await page.getByRole("button", { name: "Save progress" }).click();
    await page.getByTestId("resume-note").waitFor();
    await first.close();

    // A brand-new browser: no local storage, no cookie jar, only the server remembers.
    const second = await portal(actor.user);
    await second.page.goto(`/projects/${projectId}/onboarding`);
    await stepHeading(second.page, "Target application");
    expect(await second.page.getByTestId("resume-note").textContent()).toContain(
      "Resumed from your saved progress",
    );
    expect(await second.page.getByLabel("Base URL").inputValue()).toBe(target.url);
    expect(await second.page.getByLabel("Application type").inputValue()).toBe("Node.js HTTP API");
    const steps = await second.page.getByRole("navigation", { name: "Setup steps" }).innerText();
    expect(steps).toMatch(/1\. Choose a mode\s+Done/);
    expect(steps).toMatch(/3\. Add sources\s+Done/);
    expect(steps).toMatch(/4\. Target application\s+Current/);
    expect(steps).toMatch(/5\. Runner\s+Not done/);
    // The saved source selection survives too.
    await second.page.getByRole("button", { name: "3. Add sources" }).click();
    expect(await second.page.getByLabel(/openapi\.json/).isChecked()).toBe(true);

    // Per principal: a colleague of the same workspace starts from scratch.
    const colleague = await stack.addMember("maintainer");
    const colleagueClient = stack.anonymous();
    const login = await colleagueClient.request("POST", "/v1/identity/login", {
      body: { principal: colleague.login, password: colleague.password },
      headers: { origin: stack.baseUrl, "idempotency-key": crypto.randomUUID() },
    });
    expect(login.status).toBe(200);
    const theirs = (await colleagueClient.request("GET", stateUrl())).json<{
      data: { saved: boolean; currentStep: string; completedSteps: string[] };
    }>().data;
    expect(theirs).toMatchObject({ saved: false, currentStep: "mode", completedSteps: [] });
    const mine = (await actor.client.request("GET", stateUrl())).json<{
      data: { saved: boolean; currentStep: string; completedSteps: string[]; choices: unknown };
    }>().data;
    expect(mine).toMatchObject({ saved: true, currentStep: "target" });
    expect(mine.completedSteps).toEqual(["mode", "project", "source"]);
    expect(JSON.stringify(mine.choices)).toContain(sourceId);
  });

  it("UX-009 never stores or sends a credential: embedded userinfo and password fields are refused, and the URL stays clean", async () => {
    const { page, diagnostics } = await portal(actor.user);
    await putState(projectId, {
      currentStep: "target",
      completedSteps: ["mode", "project", "source"],
      choices: { target: { baseUrl: target.url, networkProfile: "local-loopback" } },
    });
    await page.goto(`/projects/${projectId}/onboarding`);
    await stepHeading(page, "Target application");
    const before = (await actor.client.request("GET", stateUrl())).text;
    await page.getByLabel("Base URL").fill("http://deploy:hunter2-secret@127.0.0.1:3000");
    await page.getByRole("button", { name: "Save progress" }).click();
    const failure = page.getByTestId("save-failure");
    await failure.waitFor();
    expect(await failure.textContent()).toContain("INVALID_ARGUMENT");
    const after = (await actor.client.request("GET", stateUrl())).text;
    expect(after).not.toContain("hunter2-secret");
    expect(JSON.parse(after).data.version).toBe(JSON.parse(before).data.version);
    expect(page.url()).not.toContain("hunter2");
    expect(diagnostics.requests.some((entry) => entry.includes("hunter2"))).toBe(false);

    // The same guard holds below the UI: a password-shaped field or a token in free text.
    for (const body of [
      {
        choices: {
          target: { baseUrl: target.url, networkProfile: "local-loopback", password: "x" },
        },
      },
      {
        choices: {
          target: {
            baseUrl: target.url,
            networkProfile: "local-loopback",
            prepareCommands: ["export TOKEN=tm_api_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"],
          },
        },
      },
    ]) {
      const rejected = await putState(projectId, {
        currentStep: "target",
        completedSteps: ["mode", "project", "source"],
        ...body,
      });
      expect(rejected.status).toBe(400);
    }
    // Positive control: the same request without a credential is accepted.
    const accepted = await putState(projectId, {
      currentStep: "target",
      completedSteps: ["mode", "project", "source"],
      choices: { target: { baseUrl: target.url, networkProfile: "local-loopback" } },
    });
    expect(accepted.status).toBe(200);
    expect(stack.logs()).not.toContain("hunter2-secret");
  });

  it("UX-010 passes every prerequisite for a healthy target and still names what it does not claim", async () => {
    const { page } = await portal(actor.user);
    const saved = await putState(projectId, {
      currentStep: "reachability",
      completedSteps: ["mode", "project", "source", "target", "runner", "environment"],
      choices: {
        environmentId,
        target: { baseUrl: target.url, networkProfile: "local-loopback" },
      },
    });
    expect(saved.status).toBe(200);
    await page.goto(`/projects/${projectId}/onboarding`);
    await stepHeading(page, "Check prerequisites");
    const hitsBefore = target.hits();
    await runChecks(page, "Run the checks");
    const report = page.getByTestId("prerequisite-report");
    for (const check of ["runner", "auth", "policy", "target"])
      expect(await report.locator(`[data-check="${check}"]`).getAttribute("data-status")).toBe(
        "passed",
      );
    expect(await report.textContent()).toContain("Everything required for a first run is in place");
    expect(target.hits()).toBeGreaterThan(hitsBefore);
  });

  it("UX-010 a target that policy denies is refused with egress_denied and is never contacted", async () => {
    const { page } = await portal(actor.user);
    const saved = await putState(projectId, {
      currentStep: "reachability",
      completedSteps: ["mode", "project", "source", "target", "runner", "environment"],
      choices: { environmentId, target: { baseUrl: target.url, networkProfile: "public" } },
    });
    expect(saved.text).toContain('"reachability"');
    await page.goto(`/projects/${projectId}/onboarding`);
    await stepHeading(page, "Check prerequisites");
    const hitsBefore = target.hits();
    await runChecks(page, "Run the checks");
    const report = page.getByTestId("prerequisite-report");
    expect(await report.locator('[data-check="policy"]').getAttribute("data-status")).toBe(
      "failed",
    );
    expect(await report.getByTestId("reason-policy").textContent()).toBe("egress_denied");
    expect(await report.locator('[data-check="policy"]').textContent()).toContain(
      "address_denied:loopback",
    );
    expect(await report.locator('[data-check="target"]').getAttribute("data-status")).toBe(
      "not_checked",
    );
    expect(await report.textContent()).toContain("Something blocks a first run");
    expect(target.hits()).toBe(hitsBefore);
  });

  it("UX-010 an unreachable target is told apart from a policy denial and carries no invented reason code", async () => {
    const { page } = await portal(actor.user);
    const dead = `http://127.0.0.1:${await closedPort()}`;
    await putState(projectId, {
      currentStep: "reachability",
      completedSteps: ["mode", "project", "source", "target", "runner"],
      choices: { target: { baseUrl: dead, networkProfile: "local-loopback" } },
    });
    await page.goto(`/projects/${projectId}/onboarding`);
    await stepHeading(page, "Check prerequisites");
    await runChecks(page, "Run the checks");
    const report = page.getByTestId("prerequisite-report");
    expect(await report.locator('[data-check="policy"]').getAttribute("data-status")).toBe(
      "passed",
    );
    expect(await report.locator('[data-check="target"]').getAttribute("data-status")).toBe(
      "failed",
    );
    expect(await report.getByTestId("reason-target").textContent()).toBe("no registry code");
    expect(await report.locator('[data-check="target"]').textContent()).toContain(
      "target_unreachable",
    );
  });

  it("UX-010 a missing, a revoked and a wrongly bound secret each fail the authentication check with their own reason", async () => {
    const { page } = await portal(actor.user);
    const revoked = await createSecret(stack, {
      name: "revoked",
      value: "s3cret-revoked",
      allowedOrigins: [target.url],
    });
    const deleted = await stack.ownerClient().mutate("DELETE", `/v1/secrets/${revoked}`, undefined);
    expect(deleted.status).toBe(200);
    const elsewhere = await createSecret(stack, {
      name: "elsewhere",
      value: "s3cret-elsewhere",
      allowedOrigins: ["https://other.example.test"],
    });
    const good = await createSecret(stack, {
      name: "good",
      value: "s3cret-good",
      allowedOrigins: [target.url],
    });
    const missing = "sec_00000000-0000-4000-8000-000000000000";
    const cases: [string, string, string][] = [
      [revoked, "credential_revoked", "secret_revoked"],
      [elsewhere, "egress_denied", "secret_origin_not_allowed"],
    ];
    for (const [secret, reason, diagnostic] of cases) {
      await putState(projectId, {
        currentStep: "reachability",
        completedSteps: ["mode", "project", "source", "target", "runner", "environment"],
        choices: {
          environmentId,
          authSecretRefs: [secret],
          target: { baseUrl: target.url, networkProfile: "local-loopback" },
        },
      });
      await page.goto(`/projects/${projectId}/onboarding`);
      await stepHeading(page, "Check prerequisites");
      await runChecks(page, "Run the checks");
      const report = page.getByTestId("prerequisite-report");
      expect(await report.locator('[data-check="auth"]').getAttribute("data-status")).toBe(
        "failed",
      );
      expect(await report.getByTestId("reason-auth").textContent()).toBe(reason);
      expect(await report.locator('[data-check="auth"]').textContent()).toContain(diagnostic);
      // The secret value is never part of the page.
      expect(await page.content()).not.toMatch(/s3cret-/);
    }
    // A reference that never existed cannot be saved into the wizard; the check API still names it.
    const direct = await stack
      .ownerClient()
      .mutate("POST", `/v1/projects/${projectId}/onboarding/checks`, {
        targetUrl: target.url,
        networkProfile: "local-loopback",
        secretRefs: [missing],
      });
    expect(direct.status).toBe(200);
    const missingReport = direct.json<{
      data: {
        checks: { id: string; status: string; reasonCode: string | null; diagnostic: string }[];
      };
    }>().data;
    expect(missingReport.checks.find((check) => check.id === "auth")).toMatchObject({
      status: "failed",
      reasonCode: "missing_secret",
      diagnostic: "secret_not_found",
    });
    // Positive control: an active secret bound to the target origin passes.
    await putState(projectId, {
      currentStep: "reachability",
      completedSteps: ["mode", "project", "source", "target", "runner", "environment"],
      choices: {
        environmentId,
        authSecretRefs: [good],
        target: { baseUrl: target.url, networkProfile: "local-loopback" },
      },
    });
    await page.goto(`/projects/${projectId}/onboarding`);
    await stepHeading(page, "Check prerequisites");
    await runChecks(page, "Run the checks");
    expect(
      await page
        .getByTestId("prerequisite-report")
        .locator('[data-check="auth"]')
        .getAttribute("data-status"),
    ).toBe("passed");
  });

  it("UX-010 an unreachable container runtime fails the runner check with security_precondition_failed and never falls back", async () => {
    const { page } = await portal(brokenRunner.owner, brokenRunner);
    await page.goto(`/projects/${brokenProjectId}/onboarding`);
    await page.getByRole("heading", { level: 2, name: "Choose a mode" }).waitFor();
    await page.getByRole("button", { name: "5. Runner" }).click();
    await stepHeading(page, "Runner");
    await runChecks(page, "Check the runner");
    const runner = page.getByTestId("prerequisite-report").locator('[data-check="runner"]');
    expect(await runner.getAttribute("data-status")).toBe("failed");
    expect(await page.getByTestId("reason-runner").textContent()).toBe(
      "security_precondition_failed",
    );
    expect(await runner.textContent()).toContain("never falls back");
    // Positive control: the same wizard on the healthy stack reports the runner as available.
    const healthy = await portal(actor.user);
    await healthy.page.goto(`/projects/${projectId}/onboarding`);
    await healthy.page.getByRole("button", { name: "5. Runner" }).click();
    await stepHeading(healthy.page, "Runner");
    await runChecks(healthy.page, "Check the runner");
    expect(
      await healthy.page
        .getByTestId("prerequisite-report")
        .locator('[data-check="runner"]')
        .getAttribute("data-status"),
    ).toBe("passed");
  });

  it("UX-051 UX-052 the wizard is axe clean on every step type, reachable by keyboard alone, and reflows at 320 px and 200 %", async () => {
    const { page } = await portal(actor.user);
    await page.goto(`/projects/${projectId}/onboarding`);
    await page.getByRole("heading", { level: 2 }).first().waitFor();
    for (const step of [
      "1. Choose a mode",
      "3. Add sources",
      "4. Target application",
      "5. Runner",
      "6. Environment and authentication",
      "7. Check prerequisites",
      "8. Generate or write tests",
    ]) {
      await page.getByRole("button", { name: step }).click();
      await page.getByRole("heading", { level: 2, name: step.replace(/^\d+\. /, "") }).waitFor();
      await expectAccessible(page, `onboarding ${step}`);
    }
    await page.getByRole("button", { name: "7. Check prerequisites" }).click();
    await runChecks(page, "Run the checks");
    await expectAccessible(page, "onboarding prerequisite report");

    await atViewport(page, { width: 320, zoom: 2, textScale: 1 });
    await page.goto(`/projects/${projectId}/onboarding`);
    await page.getByRole("heading", { level: 1 }).first().waitFor();
    await expectNoPageOverflow(page, "onboarding at 320 px");
    await expectAccessible(page, "onboarding 320px 200%");
    expect(await page.getByRole("button", { name: "Save progress" }).isVisible()).toBe(true);
  });

  it("UX-051 the wizard can be completed with the keyboard alone and every control shows a focus ring", async () => {
    const { page } = await portal(actor.user);
    await putState(projectId, {
      currentStep: "mode",
      completedSteps: [],
      choices: {},
    });
    await page.goto(`/projects/${projectId}/onboarding`);
    await stepHeading(page, "Choose a mode");
    const keyboard = await keyboardOnly(page);
    await keyboard.tabTo((element) => element.tag === "input", 80);
    await keyboard.press("ArrowDown");
    expect((await keyboard.focused()).focusRing).toBe(true);
    await keyboard.tabTo((element) => element.name === "Save and continue", 80);
    expect((await keyboard.focused()).focusRing).toBe(true);
    await keyboard.press("Enter");
    await stepHeading(page, "Project");
    await keyboard.tabTo((element) => element.name === "Back", 80);
    await keyboard.press("Enter");
    await stepHeading(page, "Choose a mode");
    await keyboard.assertNoPointerUsed();
  });

  it("M4-04 the onboarding journey called only catalog /v1 routes and its own static assets", async () => {
    const calls = open.flatMap((opened) => opened.diagnostics.requests);
    expect(calls.length).toBeGreaterThan(20);
    expect(privateEndpointCalls(calls)).toEqual([]);
    // Negative control: the checker really rejects an endpoint that is not in the catalog.
    expect(privateEndpointCalls(["POST /v1/private/onboarding", "GET /api/state"])).toEqual([
      "POST /v1/private/onboarding",
      "GET /api/state",
    ]);
    expect(open.every((opened) => opened.diagnostics.pageErrors.length === 0)).toBe(true);
  });
});
