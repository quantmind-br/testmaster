import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { scaffoldPlan } from "@testmaster/application";
import type { ExecutablePlan } from "@testmaster/contracts";
import type { Page } from "playwright-core";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  asOwner,
  createEnvironment,
  createProject,
  type FakeModel,
  fakeModelSettings,
  privateEndpointCalls,
  startFakeModel,
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
 * UX-012 / UX-013: the requirements review and the feature map through the real server profile.
 * Normalization runs against a local OpenAI-compatible fake provider; no paid model is called.
 */
let stack: ServerStack;
let model: FakeModel;
let projectId = "";
let mapProjectId = "";
let plainProjectId = "";
let environmentId = "";
let desired: { sourceId: string };
const open: OpenPortal[] = [];
type Client = Pick<HttpsClient, "request" | "mutate">;
const admins: { user: StackUser; client: Client }[] = [];
let turn = 0;
let user: StackUser;
let client: Client;

function bearerClient(token: string): Client {
  const anonymous = stack.anonymous();
  const authorization = { authorization: `Bearer ${token}` };
  return {
    request: (method, path, options = {}) =>
      anonymous.request(method, path, {
        ...options,
        cookies: false,
        headers: { ...authorization, ...options.headers },
      }),
    mutate: (method, path, body, extra = {}) =>
      anonymous.request(method, path, {
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

async function portal(who: StackUser) {
  const opened = await openPortal({ baseUrl: stack.baseUrl, spkiSha256: stack.ca.spkiSha256 }, who);
  open.push(opened);
  return opened;
}

const statement = (key: string, text: string, handle: number, criteria: string) => ({
  key,
  text,
  acceptanceCriteria: [criteria],
  evidenceIds: [`E${handle}`],
  originKind: "explicit",
  confidence: null,
  reason: "Stated in the source",
});

function requestPlan(name: string, path: string, requirementRefs: string[]): ExecutablePlan {
  const plan = scaffoldPlan("backend");
  plan.name = name;
  plan.requirementRefs = requirementRefs;
  plan.steps = [
    {
      id: "call",
      kind: "action",
      operation: "request",
      description: "Call the endpoint",
      input: {
        method: "GET",
        pathSegments: path
          .split("/")
          .filter(Boolean)
          .map((literal) => ({ literal })),
      },
    },
    {
      id: "status",
      kind: "assertion",
      operation: "assert",
      description: "Status is 200",
      input: { responseStepId: "call" },
      expectation: { predicate: "statusIn", values: [200] },
    },
  ];
  return plan;
}

beforeAll(async () => {
  model = await startFakeModel();
  stack = await startServerStack(fakeModelSettings(model.baseUrl));
  projectId = await createProject(stack, "Requirements journey");
  mapProjectId = await createProject(stack, "Feature map journey");
  plainProjectId = await createProject(stack, "Plain normalization journey");
  for (let index = 0; index < 3; index++) {
    const member = await stack.addMember("org_admin");
    const token = await stack.issueToken(member.principalId, ["R", "W", "X", "A"]);
    admins.push({ user: member, client: bearerClient(token) });
  }
  environmentId = await createEnvironment(stack, mapProjectId, {
    name: "local",
    baseUrl: "http://127.0.0.1:4010",
    networkProfile: "local-loopback",
  });
  await createEnvironment(stack, projectId, {
    name: "local",
    baseUrl: "http://127.0.0.1:4010",
    networkProfile: "local-loopback",
  });
  const app = await asOwner(stack);
  await writeFile(join(stack.cwd, "desired.md"), "GET /health MUST return healthy=true.\n");
  await writeFile(join(stack.cwd, "code.md"), "app.get('/health',()=>({healthy:false}));\n");
  const first = await app.sources.add({ projectId, role: "prd", path: "desired.md" });
  await app.sources.add({ projectId, role: "code-summary", path: "code.md" });
  desired = { sourceId: first.source.id };
}, 600_000);

beforeEach(() => {
  const next = admins[turn++ % admins.length] as (typeof admins)[number];
  user = next.user;
  client = next.client;
});

afterAll(async () => {
  for (const opened of open.splice(0)) await opened.close().catch(() => undefined);
  await stack?.stop();
  await model?.close();
});

const reviewUrl = (id: string) => `/v1/projects/${id}/requirements/review`;

describe("requirements review", () => {
  it("UX-012 a conflict between a specification and the code shows the span on each side and blocks approval until a reasoned decision is recorded", async () => {
    model.setOutput({
      requirements: [
        statement("r-true", "Healthy is true", 1, "healthy=true"),
        statement("r-false", "Healthy is false", 2, "healthy=false"),
      ],
      conflicts: [],
      openQuestions: [],
    });
    const { page } = await portal(user);
    await page.goto(`/projects/${projectId}/requirements`);
    await page.getByRole("heading", { level: 1, name: "Requirements" }).waitFor();
    const callsBefore = model.calls();
    // Choosing nothing sends nothing; choosing both sources normalizes them.
    await page.getByLabel(/desired\.md/).check();
    await page.getByLabel(/code\.md/).check();
    await page.getByRole("button", { name: "Normalize" }).click();
    const conflicts = page.getByTestId("conflicts");
    await conflicts.locator("[data-conflict]").first().waitFor();
    expect(model.calls()).toBeGreaterThan(callsBefore);

    const conflict = conflicts.locator("[data-conflict]").first();
    expect(await conflict.getAttribute("data-resolved")).toBe("false");
    const origins = await conflict.getByTestId("origin").allInnerTexts();
    expect(origins).toHaveLength(2);
    const joined = origins.join(" ").replace(/\s+/g, " ");
    expect(joined).toContain("desired.md");
    expect(joined).toContain("code.md");
    expect(joined).toContain("GET /health MUST return healthy=true.");
    expect(joined).toContain("app.get('/health'");
    expect(joined).toMatch(/Span desired\.md, bytes 0–37 · hash [0-9a-f]{12} /);
    expect(joined).toContain("current revision");

    // The inferred statement stays blocked while its conflict is open, and the page says why;
    // the desired statement from the specification is not held back by it.
    const wrong = page.locator('[data-requirement="r-false"]');
    const desiredCard = page.locator('[data-requirement="r-true"]');
    expect(await wrong.getByRole("button", { name: "Approve" }).getAttribute("aria-disabled")).toBe(
      "true",
    );
    expect(
      await desiredCard.getByRole("button", { name: "Approve" }).getAttribute("aria-disabled"),
    ).not.toBe("true");
    await wrong.getByRole("button", { name: "Approve" }).click({ force: true });
    expect(await page.getByRole("dialog").count()).toBe(0);
    expect(await wrong.textContent()).toContain("Decide the conflict this requirement is part of");

    // A decision needs a statement and a reason; the form says which is missing.
    await conflict.getByRole("button", { name: "Record decision" }).click();
    const summary = conflict.getByTestId("error-summary");
    await summary.waitFor();
    const missing = await summary.textContent();
    expect(missing).toContain("Choose the statement to keep");
    expect(missing).toContain("Explain the decision");
    await conflict.getByLabel("Healthy is false").check();
    await conflict.getByRole("button", { name: "Record decision" }).click();
    expect(await conflict.getByTestId("error-summary").textContent()).toContain(
      "Explain the decision",
    );
    expect((await client.request("GET", reviewUrl(projectId))).text).not.toContain(
      "conflict_decided",
    );
    await conflict.getByLabel("Why").fill("The code is the source of truth for health.");
    await conflict.getByRole("button", { name: "Record decision" }).click();
    await conflict.getByTestId("decision").waitFor();
    const decision = (await conflict.getByTestId("decision").innerText()).replace(/\s+/g, " ");
    expect(decision).toContain("because The code is the source of truth for health.");
    expect(decision).toContain(user.principalId);
    expect(await page.locator("[data-conflict]").first().getAttribute("data-resolved")).toBe(
      "true",
    );

    // Approving is a contextual confirmation; the approval and the decision enter the history.
    const approved = wrong;
    await approved.getByRole("button", { name: "Approve" }).click();
    const dialog = page.getByRole("dialog");
    await dialog.waitFor();
    expect(await dialog.textContent()).toContain("r-false");
    await dialog.getByRole("button", { name: "Approve" }).click();
    await approved.getByText("Approved", { exact: true }).waitFor();
    const history = (await page.getByTestId("history").innerText()).replace(/\s+/g, " ");
    expect(history).toContain("Conflict decided");
    expect(history).toContain("Approved");
    expect(history).toContain("Normalized");
    expect(history).toContain(user.principalId);
  });

  it("UX-012 a re-normalization that rewords a requirement shows the interpretation change with the text before and after", async () => {
    model.setOutput({
      requirements: [statement("r-true", "Healthy is true when the database answers", 1, "ok")],
      conflicts: [],
      openQuestions: [],
    });
    const { page } = await portal(user);
    await page.goto(`/projects/${projectId}/requirements`);
    await page.getByRole("heading", { level: 1, name: "Requirements" }).waitFor();
    await page.getByLabel(/desired\.md/).check();
    await page.getByRole("button", { name: "Normalize" }).click();
    const history = page.getByTestId("history");
    await history.getByText("Interpretation changed").first().waitFor();
    const entry = history.locator('[data-change-kind="interpretation_changed"]').first();
    const text = (await entry.innerText()).replace(/\s+/g, " ");
    expect(text).toContain("r-true");
    expect(text).toContain("Healthy is true when the database answers");
    expect(text).toContain("Healthy is true");
    // The removal of the other statement is its own entry, not hidden in the rewording.
    expect(
      await history.locator('[data-change-kind="requirement_removed"]').count(),
    ).toBeGreaterThan(0);
  });

  it("UX-012 a requirement whose source was updated is flagged as resting on a superseded revision, and the old span stays readable", async () => {
    const app = await asOwner(stack);
    model.setOutput({
      requirements: [statement("r-true", "Healthy is true", 1, "healthy=true")],
      conflicts: [],
      openQuestions: [],
    });
    const { page } = await portal(user);
    await page.goto(`/projects/${projectId}/requirements`);
    await page.getByRole("heading", { level: 1, name: "Requirements" }).waitFor();
    await page.getByLabel(/desired\.md/).check();
    await page.getByRole("button", { name: "Normalize" }).click();
    const card = page.locator('[data-requirement="r-true"]');
    await card.waitFor();
    expect(await card.textContent()).not.toContain("superseded");
    await writeFile(join(stack.cwd, "desired.md"), "GET /health MUST return healthy=yes.\n");
    await app.sources.add({
      projectId,
      role: "prd",
      path: "desired.md",
      sourceId: desired.sourceId,
      expectedVersion: Number(app.sources.get(desired.sourceId).source.version),
    });
    await page.reload();
    await card.waitFor();
    expect(await card.textContent()).toContain("Rests on a superseded source revision");
    const origin = card.getByTestId("origin").first();
    expect(await origin.getAttribute("data-current")).toBe("false");
    expect(await origin.textContent()).toContain("Superseded revision");
    expect(await origin.textContent()).toContain("GET /health MUST return healthy=true.");
  });

  it("UX-012 normalization needs no grant: it calls the configured model and lists the requirement", async () => {
    model.setOutput({
      requirements: [statement("cart", "The shop has a cart", 1, "The shop has a cart")],
      conflicts: [],
      openQuestions: [],
    });
    const { page } = await portal(user);
    const app = await asOwner(stack);
    await writeFile(join(stack.cwd, "plain.md"), "The shop has a cart.\n");
    await app.sources.add({ projectId: plainProjectId, role: "prd", path: "plain.md" });
    await page.goto(`/projects/${plainProjectId}/requirements`);
    await page.getByRole("heading", { level: 1, name: "Requirements" }).waitFor();
    const callsBefore = model.calls();
    await page.getByLabel(/plain\.md/).check();
    await page.getByRole("button", { name: "Normalize" }).click();
    await page.locator('[data-requirement="cart"]').waitFor();
    expect(await page.getByTestId("normalize-failure").count()).toBe(0);
    expect(model.calls()).toBeGreaterThan(callsBefore);
  });
});

describe("feature map", () => {
  it("UX-013 the map shows items with no test, tests without a valid run and a valid run as visibly different states, and never counts absence as coverage", async () => {
    model.setOutput({
      requirements: [
        statement("health", "The health endpoint reports ok", 1, "GET /health returns ok"),
        statement("orders", "Orders can be listed", 1, "GET /orders returns a list"),
        statement("refunds", "Orders can be refunded", 1, "POST /refunds returns 201"),
      ],
      conflicts: [],
      openQuestions: [],
    });
    const app = await asOwner(stack);
    await writeFile(join(stack.cwd, "map-prd.md"), "The shop has health, orders and refunds.\n");
    const source = await app.sources.add({
      projectId: mapProjectId,
      role: "prd",
      path: "map-prd.md",
    });
    const normalized = await client.mutate(
      "POST",
      `/v1/projects/${mapProjectId}/requirements/normalizations`,
      { sourceRevisionIds: [source.revision.id] },
    );
    expect(normalized.status).toBe(200);
    const requirements = (await client.request("GET", reviewUrl(mapProjectId))).json<{
      data: { requirements: { id: string; key: string }[] };
    }>().data.requirements;
    const id = (key: string) => requirements.find((item) => item.key === key)?.id ?? "";
    const healthTest = app.tests.create({
      projectId: mapProjectId,
      plan: requestPlan("Health check", "/health", [id("health")]),
    });
    app.tests.create({
      projectId: mapProjectId,
      plan: requestPlan("Orders list", "/orders", [id("orders")]),
    });
    // The health test has a run with a verdict; the orders test only a blocked run.
    const record = (testId: string, outcome: "passed" | "blocked") => {
      const run = app.runs.prepare({ testId, environmentId });
      Object.assign(run, {
        phase: "completed",
        status: outcome,
        outcome,
        gate: outcome === "passed" ? "passed" : "failed",
      });
      app.context.entities.insert("Run", run);
    };
    record(healthTest.id, "passed");
    const ordersTest = app.tests.list(mapProjectId).find((test) => test.name === "Orders list");
    record(String(ordersTest?.id), "blocked");

    const { page } = await portal(user);
    await page.goto(`/projects/${mapProjectId}/feature-map`);
    await page.getByRole("heading", { level: 1, name: "Feature map" }).waitFor();
    const summary = page.getByTestId("coverage-summary");
    const count = async (kind: string) =>
      (await summary.locator(`[data-count="${kind}"]`).innerText()).trim();
    expect(await count("valid_run")).toMatch(/Has a valid run\s*1/);
    expect(await count("tests_without_valid_run")).toMatch(/Tests, no valid run\s*1/);
    expect(await count("no_tests")).toMatch(/No coverage\s*1/);

    const rowFor = (title: string) => page.getByRole("row", { name: new RegExp(title) });
    const badge = (title: string) => rowFor(title).locator("[data-coverage]");
    expect(await badge("The health endpoint reports ok").getAttribute("data-coverage")).toBe(
      "valid_run",
    );
    expect(await badge("Orders can be listed").getAttribute("data-coverage")).toBe(
      "tests_without_valid_run",
    );
    expect(await badge("Orders can be refunded").getAttribute("data-coverage")).toBe("no_tests");
    // Each state has its own words and its own icon shape: colour is never the only signal.
    const shapes = await Promise.all(
      ["valid_run", "tests_without_valid_run", "no_tests"].map((kind) =>
        page.locator(`table [data-coverage="${kind}"] svg`).first().getAttribute("data-shape"),
      ),
    );
    expect(new Set(shapes).size).toBe(3);
    expect(await rowFor("Orders can be refunded").innerText()).toContain("None");
    expect(await rowFor("The health endpoint reports ok").innerText()).toContain("passed");
    expect(await rowFor("Orders can be listed").innerText()).toContain("none with a verdict");

    // The filter lives in the URL and keeps only the chosen state.
    await page.getByLabel("Show").selectOption("no_tests");
    await page.waitForURL((url) => url.searchParams.get("coverage") === "no_tests");
    expect(await page.locator("table [data-coverage]").count()).toBe(1);
    await page.reload();
    expect(await page.getByLabel("Show").inputValue()).toBe("no_tests");
    expect(await page.getByRole("main").innerText()).toContain("Limitations");
  });

  it("UX-014 an endpoint found by discovery that no test covers appears as no coverage, linked to the discovery it came from", async () => {
    const app = await asOwner(stack);
    await writeFile(
      join(stack.cwd, "package.json"),
      JSON.stringify({ name: "shop", dependencies: { express: "4.19.0" } }),
    );
    await writeFile(
      join(stack.cwd, "app.js"),
      "import express from 'express';\nconst app = express();\napp.get('/health', (req, res) => res.send('ok'));\napp.get('/carts', (req, res) => res.send('[]'));\n",
    );
    const discovery = await app.discovery.discover({ projectId: mapProjectId });
    const { page } = await portal(user);
    await page.goto(`/projects/${mapProjectId}/feature-map`);
    await page.getByRole("heading", { level: 1, name: "Feature map" }).waitFor();
    const link = page.getByRole("link", { name: /^\d{4}-\d{2}-\d{2}T/ });
    await link.first().waitFor();
    expect(await link.first().getAttribute("href")).toContain(
      `/projects/${mapProjectId}/discovery/${discovery.job.id}`,
    );
    const cart = page.getByRole("row", { name: /GET \/carts/ });
    expect(await cart.locator("[data-coverage]").first().getAttribute("data-coverage")).toBe(
      "no_tests",
    );
    // Negative control: the endpoint the health test covers is not reported as uncovered.
    const health = page.getByRole("row", { name: /GET \/health/ });
    expect(await health.locator("[data-coverage]").first().getAttribute("data-coverage")).not.toBe(
      "no_tests",
    );
  });
});

describe("pages", () => {
  it("UX-051 UX-052 the requirements and feature map pages are axe clean, reflow at 320 px and 200 %, and approve with the keyboard alone", async () => {
    const { page } = await portal(user);
    const paths = [
      `/projects/${projectId}/requirements`,
      `/projects/${mapProjectId}/requirements`,
      `/projects/${mapProjectId}/feature-map`,
    ];
    for (const path of paths) {
      await page.goto(path);
      await page.getByRole("heading", { level: 1 }).first().waitFor();
      await expectAccessible(page, `S4a ${path} desktop`);
    }
    await atViewport(page, { width: 320, zoom: 2, textScale: 1 });
    for (const path of paths) {
      await page.goto(path);
      await page.getByRole("heading", { level: 1 }).first().waitFor();
      await expectNoPageOverflow(page, `S4a ${path} at 320 px`);
      await expectAccessible(page, `S4a ${path} 320px 200%`);
    }
    const keyboard = await portal(user);
    await keyboard.page.goto(`/projects/${mapProjectId}/requirements`);
    await keyboard.page.getByRole("heading", { level: 1, name: "Requirements" }).waitFor();
    const session = await keyboardOnly(keyboard.page);
    await session.tabTo((element) => element.name === "Approve", 200);
    expect((await session.focused()).focusRing).toBe(true);
    await session.press("Enter");
    const dialog = keyboard.page.getByRole("dialog");
    await dialog.waitFor();
    await session.press("Escape");
    await dialog.waitFor({ state: "detached" });
    await session.assertNoPointerUsed();
  });

  it("M4-04 the requirements and feature map journey called only catalog /v1 routes and its own static assets", async () => {
    const calls = open.flatMap((opened) => opened.diagnostics.requests);
    expect(calls.length).toBeGreaterThan(30);
    expect(privateEndpointCalls(calls)).toEqual([]);
    // Negative control: the checker really rejects an endpoint that is not in the catalog.
    expect(privateEndpointCalls(["POST /v1/private/requirements", "GET /api/state"])).toEqual([
      "POST /v1/private/requirements",
      "GET /api/state",
    ]);
    expect(calls.some((entry) => entry.includes("/requirements/decisions"))).toBe(true);
    expect(open.every((opened) => opened.diagnostics.pageErrors.length === 0)).toBe(true);
  });
});

export type { Page };
