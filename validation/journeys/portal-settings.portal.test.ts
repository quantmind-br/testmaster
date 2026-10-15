import { scaffoldPlan } from "@testmaster/application";
import type { Page } from "playwright-core";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { nonCatalogApiRequests, usedCatalogRoutes } from "./catalog-routes.js";
import {
  atViewport,
  expectAccessible,
  expectNoPageOverflow,
  keyboardOnly,
  type OpenPortal,
  openPortal,
} from "./portal.js";
import { type ServerStack, type StackUser, startServerStack } from "./server-stack.js";

/**
 * Portal settings, secrets and retention against the real server profile (UX-046/047/048,
 * UX-003/006/007/008, UX-054/055/056, VAL-034, M4-05). Every call the pages make is checked against
 * the public route catalog.
 */
const secretValue = "s5b-secret-value-ZZ9-canary";
const rotatedValue = "s5b-rotated-value-QQ7-canary";

const profiles = JSON.stringify({
  defaultProfile: "stack",
  profiles: {
    stack: {
      modelProviders: [
        {
          id: "fake-local",
          kind: "openai-compatible",
          baseUrl: "http://127.0.0.1:9/v1",
          apiKeyEnv: "S5B_FAKE_KEY",
          models: [
            { id: "fake-model", capabilities: { structuredJson: true, maxOutputTokens: 1024 } },
          ],
        },
        {
          id: "fake-remote",
          kind: "openai-compatible",
          baseUrl: "https://llm.s5b.invalid/v1",
          apiKeyEnv: "S5B_FAKE_KEY",
          models: [
            { id: "remote-model", capabilities: { structuredJson: true, maxOutputTokens: 1024 } },
          ],
        },
      ],
    },
  },
});
const policy = JSON.stringify({ allowedModelProviders: ["fake-local"] });

let stack: ServerStack;
let projectId = "";
let projectSlug = "";
let environmentId = "";
let otherProjectId = "";
let viewer: StackUser;
let maintainer: StackUser;
const open: OpenPortal[] = [];
const allRequests: string[] = [];

interface Envelope<T> {
  data: T;
}

async function createProject(name: string, workspace = 0): Promise<{ id: string; slug: string }> {
  const created = await stack.ownerClient(workspace).mutate("POST", "/v1/projects", { name });
  if (created.status !== 201) throw new Error(`project: ${created.status} ${created.text}`);
  return created.json<Envelope<{ id: string; slug: string }>>().data;
}

async function createTest(project: string, name: string): Promise<{ id: string; version: number }> {
  const created = await stack.ownerClient().mutate("POST", `/v1/projects/${project}/tests`, {
    origin: "manual",
    plan: { ...scaffoldPlan("backend"), name },
  });
  if (created.status !== 201) throw new Error(`test: ${created.status} ${created.text}`);
  return created.json<Envelope<{ id: string; version: number }>>().data;
}

beforeAll(async () => {
  stack = await startServerStack({
    workspaces: 2,
    homeFiles: {
      ".config/testmaster/profiles.json": profiles,
      ".config/testmaster/policy.json": policy,
    },
  });
  const project = await createProject("Settings project");
  projectId = project.id;
  projectSlug = project.slug;
  otherProjectId = (await createProject("Other tenant project", 1)).id;
  const environment = await stack
    .ownerClient()
    .mutate("POST", `/v1/projects/${projectId}/environments`, {
      name: "Staging",
      baseUrl: "https://staging.s5b.test",
      networkProfile: "public",
      production: false,
    });
  if (environment.status !== 201)
    throw new Error(`environment: ${environment.status} ${environment.text}`);
  environmentId = environment.json<Envelope<{ id: string }>>().data.id;
  viewer = await stack.addMember("viewer");
  maintainer = await stack.addMember("maintainer");
}, 600_000);

afterAll(async () => {
  for (const portal of open.splice(0)) await portal.close().catch(() => undefined);
  await stack?.stop();
});

async function portal(
  user: { login: string; password: string },
  options: { workspace?: number; viewport?: { width: number; height: number } } = {},
): Promise<OpenPortal> {
  const opened = await openPortal(
    { baseUrl: stack.baseUrl, spkiSha256: stack.ca.spkiSha256 },
    user,
    options.viewport ? { viewport: options.viewport } : {},
  );
  open.push(opened);
  return opened;
}

async function ready(page: Page): Promise<void> {
  await page.waitForLoadState("networkidle");
  await page.waitForFunction(() => document.querySelector(".view-loading") === null);
}

async function apiGet<T>(path: string, client = stack.ownerClient()): Promise<T> {
  const response = await client.request("GET", `/v1${path}`);
  if (response.status !== 200) throw new Error(`GET ${path}: ${response.status} ${response.text}`);
  return response.json<Envelope<T>>().data;
}

async function apiList<T>(path: string, client = stack.ownerClient()): Promise<T[]> {
  const response = await client.request("GET", `/v1${path}`);
  if (response.status !== 200) throw new Error(`GET ${path}: ${response.status} ${response.text}`);
  const data = response.json<{ data: T[] | { items: T[] } }>().data;
  return Array.isArray(data) ? data : data.items;
}

async function signedInClient(user: StackUser) {
  const client = stack.anonymous();
  const login = await client.request("POST", "/v1/identity/login", {
    body: { principal: user.login, password: user.password },
    headers: { origin: stack.baseUrl, "idempotency-key": crypto.randomUUID() },
  });
  expect(login.status).toBe(200);
  client.csrfToken = login.json<{ data: { csrfToken: string } }>().data.csrfToken;
  return client;
}

interface EnvironmentRow {
  id: string;
  name: string;
  version: number;
  activeRevisionId: string;
}
interface Revision {
  id: string;
  targetOrigins: string[];
  production: boolean;
}

describe("project settings", () => {
  it("UX-047 UX-054 UX-007 M4-05 shows the impact of an environment change before saving, binds errors to fields and records a new revision", async () => {
    const { page, diagnostics } = await portal(stack.owner);
    allRequests.push(...diagnostics.requests);
    await page.goto(`/projects/${projectId}/settings`);
    await page.getByRole("heading", { level: 1, name: "Project settings" }).waitFor();
    await ready(page);
    await expectAccessible(page, "project settings");
    expect(await page.title()).toContain("Project settings");

    await page.getByRole("button", { name: "Edit Staging" }).click();
    const form = page.getByRole("form", { name: "Edit environment" });
    await form.waitFor();
    // Negative control: nothing changed, so saving is blocked with its reason and no request leaves.
    const before = diagnostics.requests.length;
    await form.getByRole("button", { name: "Save environment" }).click({ force: true });
    expect(
      await form.getByRole("button", { name: "Save environment" }).getAttribute("aria-disabled"),
    ).toBe("true");
    expect(await page.getByRole("dialog").count()).toBe(0);
    expect(diagnostics.requests.slice(before).filter((entry) => entry.startsWith("PATCH"))).toEqual(
      [],
    );

    // An invalid URL is reported next to the field and in the summary, before any dialog.
    await form.getByLabel("Base URL").fill("ftp://not-http.test");
    await form.getByRole("button", { name: "Save environment" }).click();
    const summary = page.getByTestId("error-summary");
    await summary.waitFor();
    expect(await summary.textContent()).toContain("http:// or https://");
    const urlField = form.getByLabel("Base URL");
    expect(await urlField.getAttribute("aria-invalid")).toBe("true");
    const describedBy = (await urlField.getAttribute("aria-describedby")) ?? "";
    expect(await page.locator(`[id="${describedBy.split(" ").at(-1)}"]`).innerText()).toContain(
      "http:// or https://",
    );
    expect(await page.getByRole("dialog").count()).toBe(0);

    // A valid change shows what it does to reproducibility, cost and data protection first.
    await urlField.fill("https://prod.s5b.test");
    await form.getByLabel("Production environment").check();
    const impact = form.getByTestId("impact-panel");
    expect(await impact.getAttribute("data-testid")).toBe("impact-panel");
    const impactText = await impact.innerText();
    expect(impactText).toContain("new environment revision");
    expect(impactText).toContain("not recomputed");
    expect(impactText).toContain("https://prod.s5b.test");
    expect(impactText).toContain("approval bound to the environment revision");
    expect(await apiList<Revision>(`/environments/${environmentId}/revisions`)).toHaveLength(1);

    await form.getByRole("button", { name: "Save environment" }).click();
    const dialog = page.getByRole("dialog");
    await dialog.waitFor();
    const dialogText = await dialog.innerText();
    for (const expected of ["Settings project", "Staging", "https://prod.s5b.test"])
      expect(dialogText).toContain(expected);
    await dialog.getByRole("button", { name: "Save changes" }).click();
    await page.getByRole("dialog").waitFor({ state: "detached" });
    await page.getByRole("button", { name: "Edit Staging" }).waitFor();

    const revisions = await apiList<Revision>(`/environments/${environmentId}/revisions`);
    expect(revisions).toHaveLength(2);
    expect(revisions.map((revision) => revision.targetOrigins[0]).sort()).toEqual([
      "https://prod.s5b.test",
      "https://staging.s5b.test",
    ]);
    expect(revisions.some((revision) => "variables" in revision)).toBe(false);
    allRequests.push(...diagnostics.requests);
  });

  it("VAL-034 UX-054 an edit conflict is reported without overwriting the other change", async () => {
    const { page, diagnostics } = await portal(stack.owner);
    await page.goto(`/projects/${projectId}/settings`);
    await page
      .getByRole("button", { name: /^Edit / })
      .first()
      .click();
    const form = page.getByRole("form", { name: "Edit environment" });
    await form.waitFor();
    const environments = await apiList<EnvironmentRow>(`/projects/${projectId}/environments`);
    const target = environments.find((entry) => entry.id === environmentId);
    expect(target).toBeDefined();
    // Another actor renames the environment while the form is open.
    const concurrent = await stack
      .ownerClient()
      .mutate(
        "PATCH",
        `/v1/environments/${environmentId}`,
        { name: "Renamed elsewhere" },
        { "if-match": `"${target?.version}"` },
      );
    expect(concurrent.status).toBe(200);
    await form.getByLabel("Base URL").fill("https://third.s5b.test");
    await form.getByRole("button", { name: "Save environment" }).click();
    await page.getByRole("dialog").getByRole("button", { name: "Save changes" }).click();
    const failure = page.getByRole("dialog").getByRole("alert");
    await failure.waitFor();
    await page.getByRole("dialog").getByRole("button", { name: "Cancel" }).click();
    const banner = page.getByTestId("error-banner");
    await banner.waitFor();
    expect(await banner.innerText()).toContain("REVISION_CONFLICT");
    expect(await banner.getByRole("button", { name: "Reload latest" }).count()).toBe(1);
    // Nothing was overwritten: the other actor's name and the previous target survive.
    const after = await apiList<EnvironmentRow>(`/projects/${projectId}/environments`);
    expect(after.find((entry) => entry.id === environmentId)?.name).toBe("Renamed elsewhere");
    const revisions = await apiList<Revision>(`/environments/${environmentId}/revisions`);
    expect(
      revisions.some((revision) => revision.targetOrigins.includes("https://third.s5b.test")),
    ).toBe(false);
    expect(
      diagnostics.requests.filter((entry) => entry.startsWith("PATCH /v1/environments/")),
    ).toHaveLength(1);
    allRequests.push(...diagnostics.requests);
  });

  it("UX-047 UX-007 lists the model providers read-only with the policy verdict, has no data-sharing controls and does not serve the removed model-consent routes", async () => {
    const { page, diagnostics } = await portal(stack.owner);
    await page.goto(`/projects/${projectId}/settings`);
    await page.getByRole("form", { name: "Token budget" }).waitFor();
    const local = page.getByRole("article", { name: "Provider fake-local" });
    await local.waitFor();
    expect(await local.innerText()).toContain("Allowed by policy");
    // A provider the server profile does not allow says so and is marked remote.
    const remote = page.getByRole("article", { name: "Provider fake-remote" });
    expect(await remote.innerText()).toContain("Blocked by policy");
    expect(await remote.innerText()).toContain("does not allow this provider");
    expect(await remote.innerText()).toContain("remote");
    const body = await page.locator("main").innerText();
    expect(body).not.toMatch(/data sharing|Allow sharing|Revoke sharing|no known price|consent/iu);
    expect(await page.getByRole("button", { name: /data sharing/iu }).count()).toBe(0);
    const owner = stack.ownerClient();
    const read = await owner.request("GET", `/v1/projects/${projectId}/model-providers`);
    expect(read.status).toBe(200);
    expect(
      read
        .json<{ data: { providers: { id: string; allowedByProfile: boolean }[] } }>()
        .data.providers.map((provider) => [provider.id, provider.allowedByProfile]),
    ).toEqual([
      ["fake-local", true],
      ["fake-remote", false],
    ]);
    const gone = await owner.request("GET", `/v1/projects/${projectId}/model-consents`);
    expect([404, 405]).toContain(gone.status);
    const write = await owner.mutate("PUT", `/v1/projects/${projectId}/model-consents/fake-local`, {
      dataClasses: ["dom"],
    });
    expect([404, 405]).toContain(write.status);
    allRequests.push(...diagnostics.requests);
  });

  it("UX-047 UX-054 sets the token budget with a field-bound error, an impact statement and a persisted limit", async () => {
    const { page, diagnostics } = await portal(stack.owner);
    await page.goto(`/projects/${projectId}/settings`);
    const form = page.getByRole("form", { name: "Token budget" });
    await form.waitFor();
    expect(await page.getByText("Not set (no token limit)").count()).toBeGreaterThan(0);
    await form.getByRole("textbox", { name: "Lifetime token budget" }).fill("lots");
    await form.getByRole("button", { name: "Set token budget" }).click();
    const summary = page.getByTestId("error-summary");
    await summary.waitFor();
    expect(await summary.textContent()).toContain("whole number of tokens");
    expect(
      await form
        .getByRole("textbox", { name: "Lifetime token budget" })
        .getAttribute("aria-invalid"),
    ).toBe("true");
    expect(await page.getByRole("dialog").count()).toBe(0);
    await form.getByRole("textbox", { name: "Lifetime token budget" }).fill("250000");
    expect(await form.getByTestId("impact-panel").innerText()).toContain("250,000 tokens");
    await form.getByRole("button", { name: "Set token budget" }).click();
    await page.getByRole("dialog").getByRole("button", { name: "Set budget" }).click();
    await page.getByRole("dialog").waitFor({ state: "detached" });
    await page.getByText("250,000").first().waitFor();
    const usage = await apiGet<{ lifetimeBudget: { tokenBudget: { limit: number | null } } }>(
      `/usage?projectId=${projectId}`,
    );
    expect(usage.lifetimeBudget.tokenBudget.limit).toBe(250000);
    allRequests.push(...diagnostics.requests);
  });

  it("UX-056 shows the real limits and no demo label in an ordinary workspace", async () => {
    const { page } = await portal(stack.owner);
    await page.goto(`/projects/${projectId}/settings`);
    const limits = page.getByRole("table", { name: "Execution limits (read only)" });
    await limits.waitFor();
    const text = await limits.innerText();
    expect(text).toContain("Whole execution deadline");
    expect(text).toContain("50 by default, 100 at most");
    expect(text).not.toContain("Not reported");
    expect(await page.getByTestId("demo-banner").count()).toBe(0);
  });

  it("UX-056 labels a demonstration workspace on every page and only that workspace", async () => {
    const second = stack.workspaces[1];
    expect(second).toBeDefined();
    const patched = await stack.ownerClient(1).mutate(
      "PATCH",
      `/v1/workspaces/${second?.workspaceId}`,
      { quotaPolicyId: "demo" },
      {
        "if-match": `"${(await apiGet<{ version: number }>(`/workspaces/${second?.workspaceId}`, stack.ownerClient(1))).version}"`,
      },
    );
    expect(patched.status).toBe(200);
    const demo = await portal(second?.owner as StackUser);
    await demo.page.goto("/");
    const banner = demo.page.getByTestId("demo-banner");
    await banner.waitFor();
    expect(await banner.innerText()).toContain("Demonstration workspace.");
    await demo.page.goto("/secrets");
    await demo.page.getByTestId("demo-banner").waitFor();
    await expectAccessible(demo.page, "demo workspace secrets");
    const ordinary = await portal(stack.owner);
    expect(await ordinary.page.getByTestId("demo-banner").count()).toBe(0);
    // A demo workspace cannot gate CI: the server refuses it (the sweep of that guard is server-side).
    const refused = await stack.ownerClient(1).request("GET", "/v1/ci/gate", {});
    expect([403, 404, 405]).toContain(refused.status);
  });
});

describe("secrets", () => {
  it("UX-046 stores a write-only secret, never shows or prefills the value, and rotation bumps the version", async () => {
    const { page, context, diagnostics } = await portal(stack.owner);
    const bodies: string[] = [];
    page.on("response", async (response) => {
      if (response.url().includes("/v1/")) bodies.push(await response.text().catch(() => ""));
    });
    await page.goto("/secrets");
    await page.getByRole("heading", { level: 1, name: "Secrets" }).waitFor();
    await ready(page);
    await expectAccessible(page, "secrets");
    const create = page.getByRole("form", { name: "Add a secret" });
    // Negative control: an empty value is reported at the field and nothing is sent.
    const before = diagnostics.requests.length;
    await create.getByLabel("Name").fill("api-token");
    await create.getByRole("button", { name: "Store secret" }).click();
    await page.getByTestId("error-summary").waitFor();
    expect(await create.getByLabel("Value").getAttribute("aria-invalid")).toBe("true");
    expect(
      diagnostics.requests.slice(before).filter((entry) => entry.startsWith("POST /v1/secrets")),
    ).toEqual([]);

    await create.getByLabel("Value").fill(secretValue);
    expect(await create.getByLabel("Value").getAttribute("type")).toBe("password");
    await create.getByLabel("Allowed origins").fill("https://staging.s5b.test");
    await create.getByRole("button", { name: "Store secret" }).click();
    const row = page.getByRole("row", { name: /api-token/ });
    await row.waitFor();
    expect(await row.innerText()).toContain("Set, hidden");
    expect(await row.innerText()).not.toContain(secretValue);
    // The form is cleared: the value is not kept in the page.
    expect(await create.getByLabel("Value").inputValue()).toBe("");
    expect(await create.getByLabel("Name").inputValue()).toBe("");

    // Rotate. The old value is not offered; the new value never comes back.
    await page.getByRole("button", { name: "Rotate api-token" }).click();
    const panel = page
      .getByRole("region", { name: /Rotate/ })
      .or(page.locator("section.panel"))
      .first();
    await panel.waitFor();
    expect(await panel.getByLabel("New value").inputValue()).toBe("");
    // Negative control: rotating without a value is refused at the field.
    await panel.getByRole("button", { name: "Rotate secret" }).click();
    await page.getByTestId("error-summary").waitFor();
    expect(await page.getByRole("dialog").count()).toBe(0);
    await panel.getByLabel("New value").fill(rotatedValue);
    await panel.getByRole("button", { name: "Rotate secret" }).click();
    expect(await page.getByRole("dialog").innerText()).toContain("version 2");
    await page.getByRole("dialog").getByRole("button", { name: "Rotate", exact: true }).click();
    await page.getByRole("dialog").waitFor({ state: "detached" });
    await page
      .getByRole("row", { name: /api-token/ })
      .getByText("2", { exact: true })
      .waitFor();
    expect(await panel.getByLabel("New value").inputValue()).toBe("");

    const listed = await apiList<{ id: string; locator: string; secretVersion: number }>(
      "/secrets",
    );
    const reference = listed.find((entry) => entry.locator === "api-token");
    expect(reference?.secretVersion).toBe(2);
    const history = await apiList<{ event: string; version: number }>(
      `/secrets/${reference?.id}/history`,
    );
    expect(history.map((entry) => entry.event).sort()).toEqual(["created", "rotated"]);

    // History is visible in the page without values.
    await page.getByRole("button", { name: "History of api-token" }).click();
    const historyTable = page.getByRole("table", { name: "Versions of api-token" });
    await historyTable.waitFor();
    expect(await historyTable.innerText()).toContain("Rotated");

    // The value appears nowhere: DOM, inputs, URL, storage, cookies or any API response.
    const dom = await page.evaluate(() => ({
      text: document.body.innerText + document.documentElement.outerHTML,
      inputs: [...document.querySelectorAll("input")].map((input) => input.value),
      url: location.href,
      storage: JSON.stringify([localStorage, sessionStorage].map((s) => ({ ...s }))),
    }));
    for (const value of [secretValue, rotatedValue]) {
      expect(dom.text).not.toContain(value);
      expect(dom.inputs).not.toContain(value);
      expect(dom.url).not.toContain(value);
      expect(dom.storage).not.toContain(value);
      expect(JSON.stringify(await context.cookies())).not.toContain(value);
      expect(bodies.join("\n")).not.toContain(value);
    }
    expect(diagnostics.console.join("\n")).not.toContain(secretValue);
    allRequests.push(...diagnostics.requests);
  });

  it("UX-046 UX-055 revokes a secret reference after a contextual confirmation that sends one request", async () => {
    const created = await stack.ownerClient().mutate("POST", "/v1/secrets", {
      name: "to-revoke",
      value: "revoke-me-value",
      allowedOrigins: [],
    });
    expect([200, 201]).toContain(created.status);
    const { page, diagnostics } = await portal(stack.owner);
    await page.goto("/secrets");
    await page.getByRole("button", { name: "Revoke to-revoke" }).click();
    const dialog = page.getByRole("dialog");
    const text = await dialog.innerText();
    expect(text).toContain("to-revoke");
    expect(text).toContain("Workspace");
    // A double click on the confirm button sends exactly one DELETE.
    const confirm = dialog.getByRole("button", { name: "Revoke secret" });
    await Promise.all([
      confirm.click({ force: true }),
      confirm.click({ force: true, timeout: 2000 }).catch(() => undefined),
    ]);
    await page.getByRole("dialog").waitFor({ state: "detached" });
    expect(
      diagnostics.requests.filter((entry) => entry.startsWith("DELETE /v1/secrets/")),
    ).toHaveLength(1);
    const listed = await apiList<{ locator: string; revokedAt?: string | null }>("/secrets");
    expect(listed.find((entry) => entry.locator === "to-revoke")?.revokedAt).toBeTruthy();
    allRequests.push(...diagnostics.requests);
  });

  it("UX-052 announces a stored secret once in the polite live region, never assertively, and never moves focus into it", async () => {
    const { page } = await portal(stack.owner);
    await page.goto("/secrets");
    await ready(page);
    type Announced = { __announced: string[] };
    await page.evaluate(() => {
      const target = document.querySelector('[data-testid="live-region"]');
      const log: string[] = [];
      (window as unknown as Announced).__announced = log;
      new MutationObserver(() => log.push(target?.textContent ?? "")).observe(target as Node, {
        childList: true,
        characterData: true,
        subtree: true,
      });
    });
    const create = page.getByRole("form", { name: "Add a secret" });
    await create.getByLabel("Name").fill("announce-token");
    await create.getByLabel("Value").fill("announce-value-0001");
    await create.getByRole("button", { name: "Store secret" }).click();
    await page.waitForFunction(() =>
      (window as unknown as Announced).__announced.some((entry) => entry.includes("Secret stored")),
    );
    const announced = await page.evaluate(() => (window as unknown as Announced).__announced);
    expect(announced.filter((entry) => entry.includes("Secret stored"))).toHaveLength(1);
    expect(await page.locator('[aria-live="assertive"]').count()).toBe(0);
    expect(
      await page.evaluate(
        () => document.activeElement?.closest('[data-testid="live-region"]') !== null,
      ),
    ).toBe(false);
    expect(await page.locator('[data-testid="live-region"]').getAttribute("aria-live")).toBe(
      "polite",
    );
    // Negative control: the failure path (empty value) announces nothing about storage.
    const before = announced.length;
    await create.getByLabel("Name").fill("announce-second");
    await create.getByRole("button", { name: "Store secret" }).click();
    await page.getByTestId("error-summary").waitFor();
    const after = await page.evaluate(() => (window as unknown as Announced).__announced);
    expect(after.slice(before).some((entry) => entry.includes("Secret stored"))).toBe(false);
  });

  it("UX-005 VAL-034 a viewer sees the secrets page with the reason controls are off and the server refuses the call", async () => {
    const { page } = await portal(viewer);
    await page.goto("/secrets");
    await page.getByRole("heading", { level: 1, name: "Secrets" }).waitFor();
    expect(await page.innerText("main")).toContain("Your role cannot manage secrets");
    expect(await page.getByRole("button", { name: /^Rotate / }).count()).toBe(0);
    expect(
      await page.getByRole("button", { name: "Store secret" }).getAttribute("aria-disabled"),
    ).toBe("true");
    // Server side: the same calls are refused even without the portal.
    const client = await signedInClient(viewer);
    const create = await client.mutate("POST", "/v1/secrets", {
      name: "viewer-secret",
      value: "x",
      allowedOrigins: [],
    });
    expect(create.status).toBe(403);
    const listed = await apiList<{ id: string }>("/secrets");
    const rotate = await client.mutate("POST", `/v1/secrets/${listed[0]?.id}/rotate`, {
      value: "y",
    });
    expect(rotate.status).toBe(403);
  });
});

describe("retention and deletion", () => {
  it("UX-048 UX-055 keeps remove-reference, archive-test and expire-artifact apart and archives only the selected tests", async () => {
    const [one, two, three] = await Promise.all(
      ["Checkout flow", "Login flow", "Search flow"].map((name) => createTest(projectId, name)),
    );
    const { page, diagnostics } = await portal(stack.owner);
    await page.goto(`/projects/${projectId}/retention`);
    await page.getByRole("heading", { level: 1, name: "Retention and deletion" }).waitFor();
    await ready(page);
    await expectAccessible(page, "retention");
    const headings = await page.getByRole("heading", { level: 2 }).allInnerTexts();
    expect(headings).toEqual(
      expect.arrayContaining([
        "Remove a reference",
        "Archive a test",
        "Expire an artifact",
        "Purge project data",
        "Deletion history and tombstones",
      ]),
    );
    const main = await page.innerText("main");
    expect(main).toContain("deletes no test, revision, result or artifact");
    expect(main).toContain("History and evidence stay");

    // n = 0: the bulk action is inert and says it never widens to the whole list.
    const bar = page.getByRole("group", { name: "Bulk action for tests" });
    expect(await bar.innerText()).toContain("0 tests selected");
    expect(await bar.innerText()).toContain("Nothing is applied to the whole list");
    const before = diagnostics.requests.length;
    await bar.getByRole("button", { name: "Archive selected tests" }).click({ force: true });
    expect(await page.getByRole("dialog").count()).toBe(0);
    expect(
      diagnostics.requests.slice(before).filter((entry) => entry.startsWith("DELETE")),
    ).toEqual([]);

    await page.getByLabel("Select Checkout flow").check();
    await page.getByLabel("Select Login flow").check();
    expect(await bar.innerText()).toContain("2 tests selected");
    await bar.getByRole("button", { name: "Archive selected tests" }).click();
    const dialog = page.getByRole("dialog");
    const text = await dialog.innerText();
    expect(text).toContain("Archive selected tests: 2 tests");
    expect(text).toContain("Settings project");
    await dialog.getByRole("button", { name: "Archive selected" }).click();
    await page.getByRole("dialog").waitFor({ state: "detached" });
    const tests = await apiList<{ id: string; archivedAt: string | null }>(
      `/projects/${projectId}/tests`,
    );
    const archived = (id: string | undefined) => tests.find((entry) => entry.id === id)?.archivedAt;
    expect(archived(one?.id)).toBeTruthy();
    expect(archived(two?.id)).toBeTruthy();
    expect(archived(three?.id)).toBeNull();
    expect(
      diagnostics.requests.filter((entry) => entry.startsWith("DELETE /v1/tests/")),
    ).toHaveLength(2);

    // The remaining test archives on its own, with its name in the dialog.
    await page.getByRole("button", { name: "Archive test Search flow" }).click();
    expect(await page.getByRole("dialog").innerText()).toContain("Search flow");
    await page
      .getByRole("dialog")
      .getByRole("button", { name: "Archive test", exact: true })
      .click();
    await page.getByRole("dialog").waitFor({ state: "detached" });
    expect(
      archived(
        (
          await apiList<{ id: string; archivedAt: string | null }>(`/projects/${projectId}/tests`)
        ).find((entry) => entry.id === three?.id)?.id,
      ),
    ).toBeDefined();
    allRequests.push(...diagnostics.requests);
  });

  it("UX-048 SEC-030 purges a project only after archiving it and typing its slug, and lists the deletion", async () => {
    const project = await createProject("Purge target");
    const { page, diagnostics } = await portal(stack.owner);
    await page.goto(`/projects/${project.id}/retention`);
    const purge = page.getByRole("button", { name: "Purge project data" });
    await purge.waitFor();
    // Not archived: purge is inert and the reason is on the page.
    expect(await page.innerText("main")).toContain("Archive the project first.");
    await purge.click({ force: true });
    expect(await page.getByRole("dialog").count()).toBe(0);
    await page.getByRole("button", { name: "Archive project" }).click();
    await page.getByRole("dialog").getByRole("button", { name: "Archive project" }).click();
    await page.getByRole("dialog").waitFor({ state: "detached" });
    await page
      .getByRole("button", { name: "Purge project data" })
      .and(page.locator('[aria-disabled="false"]'))
      .waitFor();

    await page.getByRole("button", { name: "Purge project data" }).click();
    const dialog = page.getByRole("dialog");
    const confirm = dialog.getByRole("button", { name: "Purge project data" });
    // Wrong text keeps the button inert; no request leaves.
    await dialog.getByLabel("Project slug").fill("not-the-slug");
    expect(await confirm.getAttribute("aria-disabled")).toBe("true");
    await confirm.click({ force: true });
    expect(
      diagnostics.requests.filter(
        (entry) => entry.startsWith("POST /v1/projects/") && entry.endsWith("/purge"),
      ),
    ).toEqual([]);
    await dialog.getByLabel("Project slug").fill(project.slug);
    expect(await confirm.getAttribute("aria-disabled")).toBe("false");
    await Promise.all([
      confirm.click({ force: true }),
      confirm.click({ force: true, timeout: 2000 }).catch(() => undefined),
    ]);
    await page.getByRole("dialog").waitFor({ state: "detached" });
    expect(
      diagnostics.requests.filter(
        (entry) => entry.startsWith("POST /v1/projects/") && entry.endsWith("/purge"),
      ),
    ).toHaveLength(1);
    const operations = await apiList<{ id: string; physicalState: string }>(
      `/deletion-operations?projectId=${project.id}`,
    );
    expect(operations).toHaveLength(1);
    await page.getByRole("table", { name: "Deletion operations" }).waitFor();
    expect(await page.getByRole("table", { name: "Deletion operations" }).innerText()).toContain(
      operations[0]?.id ?? "",
    );
    allRequests.push(...diagnostics.requests);
  });

  it("VAL-034 SEC-030 only an admin can purge: a maintainer sees why it is off and the server refuses", async () => {
    const { page } = await portal(maintainer);
    await page.goto(`/projects/${projectId}/retention`);
    await page.getByRole("heading", { level: 1, name: "Retention and deletion" }).waitFor();
    expect(await page.innerText("main")).toContain("admin access is required");
    const client = await signedInClient(maintainer);
    const refused = await client.mutate("POST", `/v1/projects/${projectId}/purge`, {
      confirmationToken: projectSlug,
    });
    expect(refused.status).toBe(403);
    const operations = await apiList<{ id: string }>(`/deletion-operations?projectId=${projectId}`);
    expect(operations).toEqual([]);
  });

  it("UX-006 SEC-030 another tenant's project and a missing one render the same page on the settings and retention routes", async () => {
    const { page } = await portal(stack.owner);
    const views: string[] = [];
    for (const path of [
      `/projects/${otherProjectId}/settings`,
      `/projects/prj_00000000-0000-4000-8000-000000000000/settings`,
      `/projects/${otherProjectId}/retention`,
    ]) {
      await page.goto(path);
      await page.getByRole("heading", { level: 1, name: "Not found" }).waitFor();
      views.push((await page.locator("main").innerText()).replace(/\s+/gu, " "));
    }
    expect(new Set(views).size).toBe(1);
    expect(views[0]).not.toContain("Other tenant project");
  });
});

describe("keyboard, reflow and the route catalog", () => {
  it("UX-051 saves an environment change with the keyboard alone and returns focus to the invoker when the dialog is cancelled", async () => {
    const { page } = await portal(stack.owner);
    await page.goto(`/projects/${projectId}/settings`);
    await page.getByRole("heading", { level: 1, name: "Project settings" }).waitFor();
    await ready(page);
    const keyboard = await keyboardOnly(page);
    await keyboard.tabTo((focused) => focused.name.startsWith("Edit"));
    await keyboard.press("Enter");
    await page.getByRole("form", { name: "Edit environment" }).waitFor();
    await keyboard.tabTo((focused) => focused.name.startsWith("Base URL"));
    await keyboard.press("Control+A");
    await keyboard.type("https://keyboard.s5b.test");
    await keyboard.tabTo((focused) => focused.name === "Save environment");
    const focusedBefore = await keyboard.focused();
    expect(focusedBefore.focusRing).toBe(true);
    await keyboard.press("Enter");
    await page.getByRole("dialog").waitFor();
    // Escape closes the dialog and the invoker has focus again.
    await keyboard.press("Escape");
    await page.getByRole("dialog").waitFor({ state: "hidden" });
    expect((await keyboard.focused()).name).toBe("Save environment");
    await keyboard.press("Enter");
    await page.getByRole("dialog").waitFor();
    await keyboard.tabTo((focused) => focused.name === "Save changes");
    await keyboard.press("Enter");
    await page.getByRole("dialog").waitFor({ state: "detached" });
    // The editor left the page; focus stays in the page, not on <body>.
    expect((await keyboard.focused()).tag).not.toBe("body");
    const revisions = await apiList<Revision>(`/environments/${environmentId}/revisions`);
    expect(
      revisions.some((revision) => revision.targetOrigins.includes("https://keyboard.s5b.test")),
    ).toBe(true);
  });

  it("UX-053 keeps the settings, secrets and retention actions usable at 320 px and 200 % zoom", async () => {
    const { page } = await portal(stack.owner);
    for (const path of [
      `/projects/${projectId}/settings`,
      "/secrets",
      `/projects/${projectId}/retention`,
    ]) {
      await page.goto(path);
      await ready(page);
      await atViewport(page, { width: 320, zoom: 2 });
      await page.goto(path);
      await ready(page);
      await expectNoPageOverflow(page, path);
      await expectAccessible(page, `${path} at 320px`);
      const buttons = await page.getByRole("button").evaluateAll((nodes) =>
        nodes
          .filter((node) => (node as HTMLElement).getClientRects().length > 0)
          .map((node) => {
            const box = (node as HTMLElement).getBoundingClientRect();
            return { text: node.textContent?.trim() ?? "", right: box.right, width: box.width };
          }),
      );
      expect(buttons.length, path).toBeGreaterThan(0);
      for (const button of buttons)
        expect(button.right, `${path}: ${button.text}`).toBeLessThanOrEqual(321);
    }
  });

  it("M4-05 REQ-036 every request the settings, secrets and retention pages made is a catalog /v1 route", async () => {
    expect(allRequests.length).toBeGreaterThan(20);
    expect(nonCatalogApiRequests(allRequests)).toEqual([]);
    // Negative control: a private endpoint would be reported.
    expect(nonCatalogApiRequests(["GET /v1/admin/private-dump", "POST /v1/secrets"])).toEqual([
      "GET /v1/admin/private-dump",
    ]);
    const used = usedCatalogRoutes(allRequests);
    for (const route of [
      "PATCH /environments/{id}",
      "GET /environments/{id}/revisions",
      "GET /projects/{id}/model-providers",
      "POST /projects/{id}/budget",
      "POST /secrets/{id}/rotate",
      "GET /secrets/{id}/history",
      "DELETE /tests/{id}",
      "POST /projects/{id}/purge",
      "GET /deletion-operations",
    ])
      expect(used, route).toContain(route);
  });
});
