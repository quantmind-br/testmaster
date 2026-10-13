import { type Application, scaffoldPlan } from "@testmaster/application";
import { routeCatalog } from "@testmaster/contracts";
import type { Page } from "playwright-core";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { entity } from "../../packages/application/src/context.js";
import { seedRun } from "../../packages/application/src/run-seed.testing.js";
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
 * Dashboard (VAL-007) and data-flow graph (REQ-053) against the real server profile: PostgreSQL,
 * `server start` as a child process and a TLS proxy. Runs are seeded through the same repositories
 * the worker uses, so the portal reads genuine server views; nothing on the page is a fixture.
 */
const secret = "tok_live_9f8e7d6c5b4a3210";

/** Request plan with a captured id, a sensitive captured token, a consumer and a resource cleanup. */
const flowPlan = {
  schemaVersion: "1.0.0",
  kind: "executable",
  name: "Order round trip",
  type: "backend",
  runner: "http",
  requirementRefs: [],
  steps: [
    {
      id: "create-order",
      kind: "action",
      operation: "request",
      description: "Create an order",
      required: true,
      risk: "write",
      input: {
        method: "POST",
        pathSegments: [{ literal: "orders" }],
        query: [],
        headers: {},
        capture: [
          {
            name: "order-id",
            from: "jsonPointer",
            pointer: "/id",
            valueType: "string",
            sensitive: false,
          },
          {
            name: "session-token",
            from: "jsonPointer",
            pointer: "/token",
            valueType: "string",
            sensitive: true,
          },
        ],
        resource: { resourceType: "order", correlationKey: { literal: "order-1" }, handle: "/id" },
      },
    },
    {
      id: "read-order",
      kind: "action",
      operation: "request",
      description: "Read the order back",
      required: true,
      input: {
        method: "GET",
        pathSegments: [{ literal: "orders" }, { variableRef: "order-id" }],
        query: [],
        headers: { Authorization: { variableRef: "session-token" } },
      },
    },
    {
      id: "check-status",
      kind: "assertion",
      operation: "assert",
      description: "Require HTTP 200",
      required: true,
      input: { responseStepId: "read-order" },
      expectation: { predicate: "statusIn", values: [200] },
    },
  ],
  cleanup: [
    {
      resourceRef: "create-order",
      operation: "request",
      input: {
        method: "DELETE",
        pathSegments: [{ literal: "orders" }, { variableRef: "create-order.handle" }],
        query: [],
        headers: {},
      },
      successPredicate: { predicate: "statusIn", values: [200, 204] },
      deadlineMs: 5000,
      required: true,
    },
  ],
};

/** The part of the metrics payload the truncation and empty-window checks rewrite. */
interface MetricsData {
  truncated: boolean;
  considered: number;
  metrics: {
    rates: Record<
      string,
      { numerator: number; denominator: number | null; state: string; value: number | null }
    >;
  };
}

let stack: ServerStack;
let app: Application;
let projectId = "";
let flowTestId = "";
let flakyTestId = "";
let flowRunId = "";
let flowAttempts: string[] = [];
const open: OpenPortal[] = [];

async function create<T extends { id: string }>(path: string, body: unknown): Promise<T> {
  const created = await stack.ownerClient().mutate("POST", path, body);
  if (created.status !== 201)
    throw new Error(`POST ${path} failed: ${created.status} ${created.text}`);
  return created.json<{ data: T }>().data;
}

beforeAll(async () => {
  stack = await startServerStack({ workspaces: 1 });
  projectId = (await create<{ id: string }>("/v1/projects", { name: "Dashboard project" })).id;
  const environment = await create<{ id: string }>(`/v1/projects/${projectId}/environments`, {
    name: "staging",
    baseUrl: "http://127.0.0.1:9",
    networkProfile: "local-loopback",
  });
  const testIn = async (name: string, plan: unknown = { ...scaffoldPlan("backend"), name }) =>
    (await create<{ id: string }>(`/v1/projects/${projectId}/tests`, { plan, origin: "manual" }))
      .id;
  const steadyTestId = await testIn("Steady health check");
  flowTestId = await testIn("Order round trip", flowPlan);
  flakyTestId = await testIn("Flaky health check");

  // Seeding goes through the owner's identity so Runs belong to a real workspace member.
  app = (await stack.scope()).forIdentity({
    principalId: stack.owner.principalId,
    scopes: ["R", "W", "X", "A"],
    workspaceId: stack.workspaceId,
    credential: { kind: "system", id: "dashboard-journey-seed" },
  });
  const seed = (testId: string, attempts: Parameters<typeof seedRun>[1]["attempts"]) =>
    seedRun(app, { testId, environmentId: environment.id, attempts });

  for (let index = 0; index < 3; index++) await seed(steadyTestId, [{ outcome: "passed" }]);
  // Passed only on the retry: the first Attempt failed, so strict first-attempt rates exclude it.
  await seed(steadyTestId, [
    {
      outcome: "failed",
      steps: [{ stepId: "get-health", status: "failed", reasonCode: "assertion_mismatch" }],
    },
    { outcome: "passed", steps: [{ stepId: "get-health", status: "passed" }] },
  ]);
  await seed(steadyTestId, [
    {
      outcome: "blocked",
      steps: [{ stepId: "get-health", status: "blocked", reasonCode: "missing_secret" }],
    },
  ]);
  await seed(flakyTestId, [{ outcome: "failed" }]);
  await seed(flakyTestId, [{ outcome: "failed" }]);
  const flow = await seed(flowTestId, [
    {
      outcome: "failed",
      steps: [
        { stepId: "create-order", status: "passed", durationMs: 40, observed: { token: secret } },
        {
          stepId: "read-order",
          status: "failed",
          reasonCode: "assertion_mismatch",
          durationMs: 18,
        },
      ],
    },
    {
      outcome: "passed",
      steps: [
        { stepId: "create-order", status: "passed", durationMs: 41, observed: { token: secret } },
        { stepId: "read-order", status: "passed", durationMs: 19 },
        { stepId: "check-status", status: "passed", durationMs: 2 },
      ],
    },
  ]);
  flowRunId = flow.runId;
  flowAttempts = flow.attemptIds;
  const lastAttempt = flowAttempts.at(-1) ?? "";
  // One order left behind by the Run, and one ticket that its cleanup confirmed.
  app.context.entities.insert(
    "ResourceRecord",
    entity(app.context, "res", {
      creatorAttemptId: lastAttempt,
      resourceType: "order",
      handleRef: "create-order.handle",
      cleanupPlan: { stepId: "create-order", declaration: null },
      state: "orphaned",
      ownerProof: { contentHash: "a".repeat(64) },
    }),
  );
  app.context.entities.insert(
    "ResourceRecord",
    entity(app.context, "res", {
      creatorAttemptId: lastAttempt,
      resourceType: "ticket",
      handleRef: "make-ticket.handle",
      cleanupPlan: { stepId: "make-ticket", declaration: null },
      state: "cleaned",
      ownerProof: { contentHash: "b".repeat(64) },
    }),
  );
}, 600_000);

afterAll(async () => {
  for (const portal of open.splice(0)) await portal.close().catch(() => undefined);
  await stack?.stop();
});

async function portal(viewport?: { width: number; height: number }) {
  const opened = await openPortal(
    { baseUrl: stack.baseUrl, spkiSha256: stack.ca.spkiSha256 },
    stack.owner,
    viewport ? { viewport } : {},
  );
  open.push(opened);
  return opened;
}

const pathPattern = (path: string) => new RegExp(`^/v1${path.replace(/\{[^}]+\}/g, "[^/]+")}$`);
const catalog = routeCatalog.map((route) => ({
  method: route.method,
  pattern: pathPattern(route.path),
}));

/** Every browser request to `/v1` must be a route of the published catalog. */
function expectCatalogOnly(requests: readonly string[]): void {
  const api = requests.filter((entry) => entry.split(" ")[1]?.startsWith("/v1/"));
  expect(api.length).toBeGreaterThan(0);
  const unknown = api.filter((entry) => {
    const [method = "", target = ""] = entry.split(" ");
    const path = target.split("?")[0] ?? "";
    return !catalog.some((route) => route.method === method && route.pattern.test(path));
  });
  expect(unknown, "requests outside the route catalog").toEqual([]);
}

async function rates(page: Page): Promise<Record<string, string>> {
  return page.evaluate(() =>
    Object.fromEntries(
      [...document.querySelectorAll("[data-rate]")].map((element) => [
        element.getAttribute("data-rate") ?? "",
        (element.textContent ?? "").trim(),
      ]),
    ),
  );
}

async function openDashboard(page: Page, query = ""): Promise<void> {
  await page.goto(`/projects/${projectId}/dashboard${query}`);
  await page.getByRole("heading", { level: 1, name: "Dashboard" }).waitFor();
  await page.getByTestId("window-summary").waitFor();
}

describe("project dashboard (VAL-007)", () => {
  it("VAL-007 shows first-attempt, terminal, conditional and end-to-end rates as separate sections with fractions, definitions and zero exclusions", async () => {
    const { page, diagnostics } = await portal();
    await openDashboard(page);
    expect(await page.title()).toContain("Dashboard");
    expect(await page.getByTestId("window-summary").innerText()).toContain("8 Run(s)");

    const sections = page.locator("[data-family]");
    expect(
      await sections.evaluateAll((nodes) => nodes.map((n) => n.getAttribute("data-family"))),
    ).toEqual(["first-attempt", "terminal", "conditional", "end-to-end"]);
    for (const [family, caption] of [
      ["first-attempt", "First attempt metrics"],
      ["terminal", "Terminal metrics"],
      ["conditional", "Conditional metrics"],
      ["end-to-end", "End to end metrics"],
    ] as const) {
      const section = page.locator(`[data-family="${family}"]`);
      await section.getByRole("table", { name: caption }).waitFor();
      expect(await section.getByRole("columnheader").allInnerTexts()).toEqual([
        "Metric",
        "Rate",
        "Numerator and denominator",
        "Definition",
      ]);
    }
    const strict = page.locator('[data-family="first-attempt"] tbody tr').first();
    expect(await strict.innerText()).toContain("Strict first-attempt pass rate");
    expect(await strict.innerText()).toContain("3 of 8");
    expect(await strict.innerText()).toContain("N_selected");
    const read = await rates(page);
    // 5 of 8 Runs ended passed, but only 3 passed on the first Attempt: the two never merge.
    expect(read).toMatchObject({
      strictPassRate: "37.5%",
      terminalPassRate: "62.5%",
      selectionCompletionRate: "87.5%",
      blockedRate: "12.5%",
      firstAttemptFailureRate: "57.1%",
      gatePassRate: "62.5%",
    });
    expect(read.strictPassRate).not.toBe(read.terminalPassRate);

    // An empty denominator is stated in words and is never rendered as 0%.
    expect(read.retryRecoveryRate).toBe("Not applicable (no Runs in the denominator)");
    expect(read.retryRecoveryRate).not.toMatch(/^0/);
    expect(
      await page
        .locator('[data-family="conditional"] tbody tr', { hasText: "infrastructure retry" })
        .innerText(),
    ).toContain("0 of 0");

    // Exclusions: every one is listed, zeros included.
    const exclusions = page.getByRole("table", { name: "Exclusions from the rates" });
    await exclusions.waitFor();
    const counts = await page.evaluate(() =>
      Object.fromEntries(
        [...document.querySelectorAll("[data-exclusion]")].map((element) => [
          element.getAttribute("data-exclusion") ?? "",
          (element.textContent ?? "").trim(),
        ]),
      ),
    );
    expect(counts).toEqual({
      firstAttemptNonPassOrFail: "1",
      expandedDependencies: "0",
      authorizedExcluded: "0",
      duplicateSelections: "0",
    });

    // Blocked Runs, retry policy and every server limitation are on the page.
    expect(await page.getByRole("table", { name: "Blocked Runs by reason" }).innerText()).toContain(
      "unspecified",
    );
    expect(await page.getByTestId("retry-policy").innerText()).toContain(
      "attempts never increase selected denominator",
    );
    const limitations = await page.getByTestId("limitations").locator("li").allInnerTexts();
    expect(limitations).toHaveLength(2);
    expect(limitations.join(" ")).toContain("Quarantine never removes a Run from these rates");
    expect(limitations.join(" ")).toContain("Retries never enter the denominator");

    // Negative controls: no truncation notice for a complete window, and no quarantine rows yet.
    expect(await page.getByTestId("truncation-notice").count()).toBe(0);
    await page.getByText("No tests are quarantined").waitFor();
    expect(await page.getByTestId("quarantine-statement").innerText()).toContain(
      "not removed from these rates",
    );
    expect(diagnostics.pageErrors).toEqual([]);
    expect(diagnostics.console).toEqual([]);
    expectCatalogOnly(diagnostics.requests);
  });

  it("VAL-007 quarantine changes no rate, and the quarantined test stays visible with its failed Runs", async () => {
    const { page, diagnostics } = await portal();
    await openDashboard(page);
    const before = await rates(page);
    const failureRatesBefore = await page.locator("[data-family] tbody tr").allInnerTexts();

    app.quarantine.set(flakyTestId, {
      reason: "tracked in the flaky backlog",
      expiresAt: new Date(Date.now() + 86_400_000).toISOString(),
    });
    await page.reload();
    await page.getByTestId("window-summary").waitFor();
    expect(await rates(page)).toEqual(before);
    expect(await page.locator("[data-family] tbody tr").allInnerTexts()).toEqual(
      failureRatesBefore,
    );
    expect(await page.getByTestId("window-summary").innerText()).toContain("8 Run(s)");

    const quarantine = page.getByRole("table", { name: "Quarantined tests" });
    await quarantine.waitFor();
    const row = quarantine.locator("tbody tr");
    expect(await row.count()).toBe(1);
    const cells = await row.locator("td").allInnerTexts();
    expect(cells[0]).toBe(flakyTestId);
    expect(cells[2]).toBe("tracked in the flaky backlog");
    expect(cells[4]).toContain("Active");
    expect(cells.slice(5)).toEqual(["2", "2"]);
    expect(await page.getByTestId("quarantine-statement").innerText()).toContain(
      "every Run of a quarantined test stays in every denominator",
    );
    // Quarantine is not an exclusion from the window: the reported count stays at zero.
    expect(await page.locator('[data-exclusion="authorizedExcluded"]').innerText()).toBe("0");
    // The two failed first Attempts of the quarantined test are still in the failure rate.
    expect(before.firstAttemptFailureRate).toBe("57.1%");
    expect(await page.getByText("No tests are quarantined").count()).toBe(0);
    expect(diagnostics.pageErrors).toEqual([]);
    expectCatalogOnly(diagnostics.requests);
  });

  it("VAL-007 the window selector works from the keyboard, lives in the URL and asks the server for that window", async () => {
    const { page, diagnostics } = await portal();
    await openDashboard(page);
    const keyboard = await keyboardOnly(page);
    await keyboard.tabTo(
      (element) => element.tag === "select" && element.name.startsWith("Time window"),
    );
    expect((await keyboard.focused()).focusRing).toBe(true);
    await keyboard.press("ArrowUp");
    await page.waitForURL((url) => url.searchParams.get("days") === "7");
    await page.getByTestId("window-summary").getByText("last 7 days").waitFor();
    const weekly = diagnostics.requests.findLast((entry) => entry.includes("/metrics?"));
    const query = new URLSearchParams(weekly?.split("?")[1] ?? "");
    const spanDays =
      (Date.parse(query.get("until") ?? "") - Date.parse(query.get("since") ?? "")) / 86_400_000;
    expect(spanDays).toBeCloseTo(7, 5);
    expect(query.get("limit")).toBe("200");

    // Another value, then back to the default, which leaves the URL without a parameter.
    await keyboard.press("End");
    await page.waitForURL((url) => url.searchParams.get("days") === "90");
    await keyboard.press("ArrowUp");
    await page.waitForURL((url) => url.searchParams.get("days") === null);
    await page.getByTestId("window-summary").getByText("last 30 days").waitFor();

    // Refresh is reachable and operable with the keyboard, and asks the server again.
    const before = diagnostics.requests.filter((entry) => entry.includes("/metrics?")).length;
    const refreshed = page.waitForResponse((response) => response.url().includes("/metrics?"));
    await keyboard.tabTo((element) => element.tag === "button" && element.name === "Refresh");
    await keyboard.press("Enter");
    await refreshed;
    expect(
      diagnostics.requests.filter((entry) => entry.includes("/metrics?")).length,
    ).toBeGreaterThan(before);
    await keyboard.assertNoPointerUsed();
    expectCatalogOnly(diagnostics.requests);

    // A deep link keeps the chosen window.
    await page.goto(`/projects/${projectId}/dashboard?days=90`);
    await page.getByTestId("window-summary").getByText("last 90 days").waitFor();
    expect(await page.getByRole("combobox", { name: "Time window" }).inputValue()).toBe("90");
  });

  /**
   * Serves the metrics request from the real server and changes only the fields the callback
   * touches, so the truncated and empty states can be rendered without seeding 200+ Runs.
   */
  async function rewriteMetrics(page: Page, change: (data: MetricsData) => void): Promise<void> {
    await page.route(/\/v1\/projects\/[^/]+\/metrics\?/, async (route) => {
      const url = new URL(route.request().url());
      const served = await stack.ownerClient().request("GET", `${url.pathname}${url.search}`);
      expect(served.status).toBe(200);
      const body = served.json<{ data: MetricsData }>();
      change(body.data);
      await route.fulfill({ status: 200, json: body });
    });
  }

  it("VAL-007 says so when the window holds more Runs than the server reads, and when there are none", async () => {
    const { page } = await portal();
    await rewriteMetrics(page, (data) => {
      data.truncated = true;
    });
    await openDashboard(page);
    const notice = page.getByTestId("truncation-notice");
    await notice.waitFor();
    expect(await notice.innerText()).toContain("Showing the newest 8 Runs");
    await page.unroute(/\/v1\/projects\/[^/]+\/metrics\?/);

    // An empty window reports "no Runs" and never an all-zero dashboard.
    await rewriteMetrics(page, (data) => {
      data.considered = 0;
      for (const rate of Object.values(data.metrics.rates)) {
        rate.numerator = 0;
        rate.denominator = 0;
        rate.state = "notApplicable";
        rate.value = null;
      }
    });
    await page.reload();
    await page.getByText("No Runs in this window").waitFor();
    const read = await rates(page);
    expect(Object.values(read).every((text) => text.startsWith("Not applicable"))).toBe(true);
    expect(Object.values(read).some((text) => /^0%$/.test(text))).toBe(false);
  });

  it("VAL-007 the dashboard is axe clean on desktop and reflows at 320 px and 200 % zoom", async () => {
    const { page, diagnostics } = await portal();
    await openDashboard(page);
    await expectAccessible(page, "dashboard desktop");
    await atViewport(page, { width: 320, zoom: 2, textScale: 1 });
    await openDashboard(page);
    await expectNoPageOverflow(page, "dashboard at 320 px");
    await expectAccessible(page, "dashboard 320px 200%");
    expect(await page.getByRole("button", { name: "Refresh" }).isVisible()).toBe(true);
    expect(diagnostics.pageErrors).toEqual([]);
  });
});

describe("run data flow (REQ-053)", () => {
  async function openRun(page: Page): Promise<void> {
    await page.goto(`/runs/${flowRunId}`);
    await page.getByRole("heading", { level: 2, name: "Data flow" }).waitFor();
    await page.getByRole("table", { name: "Data flow, as a table" }).waitFor();
  }

  it("REQ-053 draws the producer to consumer graph and the same data as a table, with the sensitive value hidden", async () => {
    const { page, diagnostics } = await portal();
    await openRun(page);
    const panel = page.locator(".data-flow-panel");
    const graph = panel.locator('svg[role="img"]');
    expect(await graph.count()).toBe(1);
    expect(await graph.getAttribute("aria-labelledby")).toMatch(/title.* .*desc/);
    expect(await graph.locator("title").textContent()).toBe("Data flow of the Run");
    expect(await graph.locator("desc").textContent()).toContain("table below the graph");

    // Nodes and edges: producer to consumer, the resource, its cleanup, and the sensitive edge.
    const nodes = await graph
      .locator("[data-node]")
      .evaluateAll((all) => all.map((n) => n.getAttribute("data-node")));
    expect(nodes).toEqual([
      "create-order",
      "resource:create-order",
      "read-order",
      "check-status",
      "cleanup:0",
    ]);
    const edges = await graph.locator("[data-edge]").evaluateAll((all) =>
      all.map((edge) => ({
        id: edge.getAttribute("data-edge"),
        line: edge.querySelector("path")?.getAttribute("class"),
      })),
    );
    // The server stores plan input with sorted keys, so the order of two refs in one step is not fixed.
    expect(edges.map((edge) => edge.id).sort()).toEqual(
      [
        "resource:order:create-order->resource:create-order",
        "variable:order-id:create-order->read-order",
        "variable:session-token:create-order->read-order",
        "resource:create-order:resource:create-order->cleanup:0",
      ].sort(),
    );
    // The sensitive edge differs by line pattern, not only by colour; the legend explains it.
    const lineOf = (id: string) => edges.find((edge) => edge.id === id)?.line;
    expect(lineOf("variable:session-token:create-order->read-order")).toContain(
      "flow-edge-sensitive",
    );
    expect(lineOf("variable:order-id:create-order->read-order")).not.toContain(
      "flow-edge-sensitive",
    );
    expect(await panel.getByLabel("Graph legend").innerText()).toContain(
      "sensitive value, never shown",
    );
    // Node text carries the status and the latency, so no meaning rests on colour.
    const nodeText = (id: string) => graph.locator(`[data-node="${id}"]`).textContent();
    const createNode = await nodeText("create-order");
    expect(createNode).toContain("Passed · 41 ms");
    expect(createNode).toContain("sensitive");
    expect(await nodeText("resource:create-order")).toContain("Orphaned");
    expect(await nodeText("check-status")).toContain("Passed · 2 ms");

    // The table lists the same flows.
    const table = page.getByRole("table", { name: "Data flow, as a table" });
    expect(await table.getByRole("columnheader").allInnerTexts()).toEqual([
      "Variable / resource",
      "Produced by",
      "Consumed by",
      "Sensitive",
      "Runtime status of producer",
      "Latency",
      "Notes",
    ]);
    const rows = await table
      .locator("tbody tr")
      .evaluateAll((all) =>
        all.map((row) =>
          [...row.querySelectorAll("td")].map((cell) => cell.innerText.replace(/\s+/g, " ").trim()),
        ),
      );
    expect(rows).toHaveLength(4);
    const orderId = rows.find((row) => row[0] === "order-id");
    expect(orderId).toEqual([
      "order-id",
      "Create an order",
      "Read the order back",
      "No",
      "Passed",
      "41 ms",
      "—",
    ]);
    const token = rows.find((row) => row[0] === "session-token");
    expect(token?.[3]).toBe("Yes · ••• hidden");
    expect(token?.[6]).toContain("never shown");
    const order = rows.find((row) => row[0] === "order");
    expect(order?.[4]).toBe("Passed");
    expect(order?.[6]).toContain("orphaned");

    // The sensitive value is nowhere on the page (text or markup), including the run's own step
    // table, and the capturing step withholds observed data.
    expect(await panel.innerText()).not.toContain(secret);
    expect(await panel.innerHTML()).not.toContain(secret);
    expect(await page.locator("body").innerText()).not.toContain(secret);
    expect(await page.content()).not.toContain(secret);
    expect(await panel.innerText()).toContain("••• hidden");
    const steps = page.getByRole("table", { name: "Steps, requests and latency" });
    const createRow = steps.locator("tbody tr", { hasText: "Create an order" });
    expect(await createRow.innerText()).toContain("POST /orders");
    expect(await createRow.innerText()).toContain("Withheld");
    const readRow = steps.locator("tbody tr", { hasText: "Read the order back" });
    expect(await readRow.innerText()).toContain("GET /orders/{order-id}");
    expect(await readRow.innerText()).not.toContain("Withheld");
    expect(diagnostics.pageErrors).toEqual([]);
    // The run page's analysis panel (404: none yet) and evidence panel (422: the seeded Run has no
    // committed bundle) log expected resource errors; anything else is a defect.
    expect(diagnostics.console.filter((entry) => !/status of (404|422)/.test(entry))).toEqual([]);
    expectCatalogOnly(diagnostics.requests);
  });

  it("REQ-053 lists the resource a Run left behind with its state and does not flag the one that was cleaned up", async () => {
    const { page } = await portal();
    await openRun(page);
    const banner = page.getByTestId("orphan-banner");
    expect(await banner.innerText()).toContain(
      "1 resource(s) of this Run are not confirmed cleaned up",
    );
    const resources = page.getByRole("table", { name: "Resources created by this Run" });
    const orphan = resources.locator("tbody tr", { hasText: "order" });
    expect(await orphan.innerText()).toContain("Orphaned");
    expect(await orphan.innerText()).toContain("create-order");
    expect(await orphan.innerText()).toContain("Not confirmed cleaned up");
    const cleaned = resources.locator("tbody tr", { hasText: "ticket" });
    expect(await cleaned.innerText()).toContain("Cleaned up");
    expect(await cleaned.innerText()).toContain("Cleanup confirmed");
    expect(await cleaned.innerText()).not.toContain("Not confirmed");
  });

  it("REQ-053 shows the results of the Attempt the viewer picks, from the keyboard", async () => {
    const { page, diagnostics } = await portal();
    await openRun(page);
    const graph = page.locator('svg[role="img"]');
    const nodeText = (id: string) => graph.locator(`[data-node="${id}"]`).textContent();
    // The newest Attempt passed; the first one failed at read-order.
    expect(await nodeText("read-order")).toContain("Passed");
    const keyboard = await keyboardOnly(page);
    await keyboard.tabTo(
      (element) => element.tag === "select" && element.name.startsWith("Attempt shown"),
    );
    expect((await keyboard.focused()).focusRing).toBe(true);
    await keyboard.press("ArrowUp");
    await graph.locator('[data-node="read-order"]', { hasText: "Failed" }).waitFor();
    expect(await nodeText("read-order")).toContain("Failed · 18 ms");
    // That Attempt created no resource record, so the graph does not claim a resource state.
    expect(await nodeText("resource:create-order")).toContain("State not recorded");
    expect(await nodeText("check-status")).toContain("No result");
    // The graph's scroll region is reachable by keyboard and shows a focus ring.
    await keyboard.tabTo(
      (element) => element.role === "region" && element.name === "Data flow graph",
      120,
    );
    expect((await keyboard.focused()).focusRing).toBe(true);
    await keyboard.assertNoPointerUsed();
    expectCatalogOnly(diagnostics.requests);
  });

  it("REQ-053 the data-flow page is axe clean and the graph scrolls inside its own region at 320 px", async () => {
    const { page } = await portal();
    await openRun(page);
    await expectAccessible(page, "run data flow desktop");
    await atViewport(page, { width: 320, zoom: 2, textScale: 1 });
    await openRun(page);
    await expectNoPageOverflow(page, "run data flow at 320 px");
    await expectAccessible(page, "run data flow 320px 200%");
    const region = page.getByRole("region", { name: "Data flow graph" });
    const metrics = await region.evaluate((element) => ({
      client: element.clientWidth,
      scroll: element.scrollWidth,
      tabIndex: (element as HTMLElement).tabIndex,
    }));
    expect(metrics.scroll).toBeGreaterThan(metrics.client);
    expect(metrics.tabIndex).toBe(0);
  });
});
