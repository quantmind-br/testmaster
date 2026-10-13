import { type Application, scaffoldPlan } from "@testmaster/application";
import { routeCatalog } from "@testmaster/contracts";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  createFailedRun,
  createModelAnalysisRun,
  type FixtureScope,
  newScenario,
} from "./healing-fixtures.js";
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
 * Analysis display and healing review in the portal (UX-033, UX-039, UX-040) against the real
 * server profile. Runs, analyses and proposals are seeded through the application services on the
 * same PostgreSQL database; every decision below goes through the browser and the `/v1` API.
 */
let stack: ServerStack;
let system: Application;
let viewer: StackUser;
let projectId = "";
let environmentId = "";
const open: OpenPortal[] = [];

async function portal(user: { login: string; password: string }) {
  const opened = await openPortal(
    { baseUrl: stack.baseUrl, spkiSha256: stack.ca.spkiSha256 },
    user,
  );
  open.push(opened);
  return opened;
}

function catalogPattern(path: string): RegExp {
  return new RegExp(`^${path.replace(/\{[^}]+\}/g, "[^/]+")}$`);
}

/** Every `/v1` request the page made must be a catalog route of the same method. */
function expectCatalogRequestsOnly(requests: readonly string[]): void {
  const apiRequests = requests.filter((entry) => entry.split(" ")[1]?.startsWith("/v1/"));
  expect(apiRequests.length).toBeGreaterThan(0);
  for (const request of apiRequests) {
    const [method = "", target = ""] = request.split(" ");
    const path = target.slice("/v1".length).split("?")[0] ?? "";
    expect(
      routeCatalog.some(
        (route) => route.method === method && catalogPattern(route.path).test(path),
      ),
      `not a catalog route: ${request}`,
    ).toBe(true);
  }
}

function scope(): FixtureScope {
  return { system, workspaceId: stack.workspaceId, projectId, environmentId };
}

beforeAll(async () => {
  stack = await startServerStack();
  system = (await stack.scope()).forWorkspaceSystem(stack.workspaceId);
  const project = system.projects.create({ name: "Healing portal project" });
  projectId = String(project.id);
  environmentId = String(
    system.environments.create({
      projectId,
      name: "staging",
      baseUrl: "http://127.0.0.1:9",
    }).id,
  );
  viewer = await stack.addMember("viewer");
}, 600_000);

afterAll(async () => {
  for (const opened of open.splice(0)) await opened.close().catch(() => undefined);
  await stack?.stop();
});

describe("analysis panel on the Run page", () => {
  it("UX-033 a Run without analysis says so and never reads as 'no problem found'", async () => {
    const test = system.tests.create({ projectId, plan: scaffoldPlan("frontend") });
    const failed = await createFailedRun(scope(), test.id, false);
    const { page, diagnostics } = await portal(stack.owner);
    await page.goto(`/runs/${failed.runId}`);
    const panel = page.locator("[data-analysis-state]:not([data-analysis-state=loading])");
    await panel.waitFor();
    expect(await panel.getAttribute("data-analysis-state")).toBe("none");
    expect(await panel.textContent()).toContain("No analysis yet");
    expect(await panel.textContent()).toContain("Nothing here says what caused the result");
    expect(await panel.getByText("Cause supported by cited evidence").count()).toBe(0);
    expect(await panel.getByText("Healing proposals for this Run").count()).toBe(1);
    await panel.getByText("No healing proposal exists for this Run").waitFor();
    expect(diagnostics.pageErrors).toEqual([]);
    expectCatalogRequestsOnly(diagnostics.requests);
  });

  it("UX-033 a rules analysis shows its source, evidence chain, limitations and a qualified conclusion", async () => {
    const test = system.tests.create({ projectId, plan: scaffoldPlan("frontend") });
    const failed = await createFailedRun(scope(), test.id, true);
    const stored = system.analysis.get(failed.runId);
    expect(stored?.source).toBe("rules");
    const { page } = await portal(stack.owner);
    await page.goto(`/runs/${failed.runId}`);
    const panel = page.locator("[data-analysis-state]:not([data-analysis-state=loading])");
    await panel.getByRole("heading", { level: 2, name: "Analysis" }).waitFor();
    const text = (await panel.textContent()) ?? "";
    expect(text).toContain("Deterministic rules over recorded evidence. No model was used.");
    // Rules report no confidence, and the panel says so instead of inventing one.
    expect(text).toContain("No confidence was reported for this analysis.");
    for (const heading of ["Hypotheses", "Limitations"])
      await panel.getByRole("heading", { level: 3, name: heading }).waitFor();
    // The analysis never asserts a confirmed cause, whatever the rules concluded.
    expect(text.toLowerCase()).not.toContain("confirmed");
    const conclusion = panel.locator("[data-conclusion]");
    expect(await conclusion.count()).toBe(1);
    // Rules analysis uses no model, so there is no usage section to show.
    expect(await panel.getByRole("heading", { name: "Model usage" }).count()).toBe(0);
    await expectAccessible(page, "run analysis (rules) desktop");
  });

  it("UX-033 a model analysis is a suggestion: uncalibrated confidence, unsupported hypotheses and model usage", async () => {
    const failed = await createModelAnalysisRun(scope());
    const { page, diagnostics } = await portal(stack.owner);
    await page.goto(`/runs/${failed.runId}`);
    const panel = page.locator("[data-analysis-state]:not([data-analysis-state=loading])");
    await panel.getByRole("heading", { level: 3, name: "Hypotheses" }).waitFor();
    expect(await panel.getAttribute("data-analysis-state")).toBe("partial");
    const text = (await panel.textContent()) ?? "";
    expect(text).toContain("Partial analysis");
    expect(text).toContain("A model proposed this reading of the evidence");
    expect(text).toContain("Suspected cause — partially supported");
    expect(text).toContain("Not calibrated: this is a heuristic score");
    expect(text).toContain("Suggestion — no cited evidence");
    expect(text).toContain("Likely a renamed control");
    expect(text).toContain("model suggestion");
    expect(text).toContain("No DOM snapshot of the failing page");
    expect(text).toContain("Model output is not calibrated against measured outcomes");
    // Hostile model text stays inert text.
    expect(text).toContain("<img src=x onerror=alert(1)>");
    expect(await panel.locator("img").count()).toBe(0);
    // Model usage lists the provider, model and token counts of the call.
    const usage = panel.getByRole("table", { name: "Model calls recorded for this Run" });
    await usage.waitFor();
    const usageText = (await usage.textContent()) ?? "";
    expect(usageText).toContain("quantforge / qwen3.8-flash");
    expect(usageText).toContain("1234");
    expect(usageText).toContain("321");
    expect(usageText).toContain("87");
    expect(diagnostics.pageErrors).toEqual([]);
    expectCatalogRequestsOnly(diagnostics.requests);
    await expectAccessible(page, "run analysis (model) desktop");
    await atViewport(page, { width: 320, zoom: 2, textScale: 1 });
    await page.goto(`/runs/${failed.runId}`);
    await panel.getByRole("heading", { level: 3, name: "Hypotheses" }).waitFor();
    await expectNoPageOverflow(page, "run analysis at 320 px");
    await expectAccessible(page, "run analysis (model) 320px 200%");
  });

  it("UX-033 model usage is hidden quietly when the usage route is forbidden and shown otherwise", async () => {
    const failed = await createModelAnalysisRun(scope());
    const { page, diagnostics } = await portal(stack.owner);
    await page.route("**/v1/usage?*", (route) =>
      route.fulfill({
        status: 403,
        contentType: "application/json",
        body: JSON.stringify({
          schemaVersion: "1.0.0",
          requestId: "usage-denied",
          error: {
            code: "FORBIDDEN",
            message: "Action is not authorized",
            retryable: false,
            details: {},
            nextActions: [],
          },
        }),
      }),
    );
    const denied = page.waitForResponse(
      (response) => new URL(response.url()).pathname === "/v1/usage",
    );
    await page.goto(`/runs/${failed.runId}`);
    const panel = page.locator("[data-analysis-state]:not([data-analysis-state=loading])");
    await panel.getByRole("heading", { level: 3, name: "Hypotheses" }).waitFor();
    expect((await denied).status()).toBe(403);
    expect(diagnostics.requests.some((entry) => entry.startsWith("GET /v1/usage?"))).toBe(true);
    expect(await panel.getByRole("heading", { name: "Model usage" }).count()).toBe(0);
    expect(await panel.getByText("Model usage unavailable").count()).toBe(0);
    // The analysis itself still renders, so the quiet hiding costs the reader nothing else.
    expect(await panel.textContent()).toContain("Suspected cause — partially supported");
    // Positive control: without the denial the same Run shows its usage.
    await page.unroute("**/v1/usage?*");
    await page.reload();
    await panel.getByRole("heading", { name: "Model usage" }).waitFor();
  });

  it("UX-040 the Run lists its healing proposals with status and risk and links to the review", async () => {
    const scenario = await newScenario(scope());
    const { test, failed } = scenario;
    // A second failed Run of the same test has no proposal of its own.
    const unrelated = await createFailedRun(scope(), test.id, false);
    const { page } = await portal(stack.owner);
    await page.goto(`/runs/${failed.runId}`);
    const table = page.getByRole("table", { name: "Healing proposals for this Run" });
    await table.waitFor();
    const row = table.getByRole("row").filter({ hasText: scenario.proposalId });
    expect(await row.textContent()).toContain("Proposed");
    expect(await row.textContent()).toContain("Read-only");
    await row.getByRole("link", { name: scenario.proposalId }).click();
    await page.waitForURL((url) => url.pathname === `/healing-proposals/${scenario.proposalId}`);
    await page.getByRole("heading", { level: 1, name: "Healing proposal" }).waitFor();
    // Negative control: another Run of the same test shows no proposal.
    await page.goto(`/runs/${unrelated.runId}`);
    await page.getByText("No healing proposal exists for this Run").waitFor();
    expect(await page.getByRole("table", { name: "Healing proposals for this Run" }).count()).toBe(
      0,
    );
  });
});

describe("healing review", () => {
  it("UX-039 the review shows before and after, the assertion invariant, risk, policy and evidence", async () => {
    const scenario = await newScenario(scope());
    const { page, diagnostics } = await portal(stack.owner);
    await page.goto(`/healing-proposals/${scenario.proposalId}`);
    await page.getByRole("heading", { level: 1, name: "Healing proposal" }).waitFor();
    await page.locator("[data-assertions-intact]").waitFor();
    expect(
      await page.locator("[data-assertions-intact]").getAttribute("data-assertions-intact"),
    ).toBe("yes");
    const main = (await page.locator("main").textContent()) ?? "";
    expect(main).toContain("Assertions intact: healing does not change what the test checks");
    expect(main).toContain("check-error");
    expect(main).toContain("Proposed");
    expect(main).toContain("Read-only");
    expect(main).toContain("Manual review required");
    expect(main).toContain(
      "Not healed. The original Run stays failed and nothing has been applied.",
    );
    expect(main).toContain(scenario.candidateId);
    expect(main).toContain(scenario.baseId);
    // Before and after are rendered as a line diff with removed and added rows.
    const diff = page.getByRole("region", {
      name: "Before and after for step submit-login, field /input/locator",
    });
    await diff.waitFor();
    const diffText = (await diff.textContent()) ?? "";
    expect(diffText).toContain("removed:");
    expect(diffText).toContain("added:");
    expect(diffText).toContain("sign-in");
    expect(diffText).toContain("Sign in");
    // The original failure is linked, never rewritten.
    await page.getByRole("link", { name: scenario.failed.runId }).first().waitFor();
    // Evidence references link back to the Run.
    expect(main).toContain("Locator equivalence evidence unavailable");
    expect(diagnostics.pageErrors).toEqual([]);
    expectCatalogRequestsOnly(diagnostics.requests);
    await expectAccessible(page, "healing review desktop");
    await atViewport(page, { width: 320, zoom: 2, textScale: 1 });
    await page.goto(`/healing-proposals/${scenario.proposalId}`);
    await page.getByRole("heading", { level: 1, name: "Healing proposal" }).waitFor();
    await expectNoPageOverflow(page, "healing review at 320 px");
    await expectAccessible(page, "healing review 320px 200%");
  });

  it("UX-039 UX-040 accepting asks for confirmation, then starts a new verification Run and never shows healed while it is queued", async () => {
    const scenario = await newScenario(scope());
    const { page, diagnostics } = await portal(stack.owner);
    await page.goto(`/healing-proposals/${scenario.proposalId}`);
    const accept = page.getByRole("button", { name: "Accept proposal…" });
    // The button is disabled with a reason until the review has loaded, then it is enabled.
    await page.locator('button[aria-disabled="false"]', { hasText: "Accept proposal" }).waitFor();
    await accept.click();
    const dialog = page.getByRole("dialog", { name: "Accept this healing proposal?" });
    await dialog.waitFor();
    const dialogText = (await dialog.textContent()) ?? "";
    // The dialog restates what accepting creates.
    expect(dialogText).toContain(scenario.candidateId);
    expect(dialogText).toContain(scenario.baseId);
    expect(dialogText).toContain("new verification Run");
    // Cancelling changes nothing on the server.
    await dialog.getByRole("button", { name: "Cancel" }).click();
    expect(system.healing.get(scenario.proposalId).status).toBe("proposed");
    expect(diagnostics.requests.filter((entry) => entry.includes("/approve"))).toEqual([]);

    await accept.click();
    await dialog.getByRole("button", { name: "Accept and verify" }).click();
    await page.locator("[data-notice]").waitFor();
    expect(await page.locator("[data-notice]").textContent()).toContain("Proposal approved");
    await page.locator('[data-healing-status="approved"]').first().waitFor();
    const headline = page.locator("[data-lifecycle-headline]");
    await headline.waitFor();
    expect(await headline.getAttribute("data-healed")).toBe("no");
    // The full review stays readable with a queued verification Run: no degraded banner.
    expect(await page.getByText("Review unavailable").count()).toBe(0);
    expect(await page.locator("[data-assertions-intact]").count()).toBe(1);
    await page
      .getByRole("region", { name: "Before and after for step submit-login, field /input/locator" })
      .waitFor();
    expect(await headline.textContent()).toContain("Not healed yet");

    const stored = system.healing.get(scenario.proposalId);
    expect(stored.status).toBe("approved");
    expect(stored.approvalMode).toBe("manual");
    const verificationRunId = String(stored.verificationRunId);
    const verification = system.runs.get(verificationRunId);
    // A new Run on the candidate revision: not the failed one, not finished.
    expect(verificationRunId).not.toBe(scenario.failed.runId);
    expect(verification).toMatchObject({
      revisionId: scenario.candidateId,
      origin: "verification",
      phase: "queued",
    });
    expect(verification.outcome).toBeNull();
    // The historical failure is untouched and the candidate is not active yet.
    expect(system.runs.get(scenario.failed.runId).outcome).toBe("failed");
    expect(system.tests.get(scenario.test.id).activeRevisionId).toBe(scenario.baseId);
    await page.getByRole("link", { name: `Open verification Run ${verificationRunId}` }).waitFor();
    const lifecycle = (await page.locator("main").textContent()) ?? "";
    expect(lifecycle).toContain("has not finished");
    expect(lifecycle).not.toContain("Verified: Run");
    // Once decided, the decision controls say so instead of offering a second approval.
    expect(
      await page.getByRole("button", { name: "Accept proposal…" }).getAttribute("aria-disabled"),
    ).toBe("true");
    expectCatalogRequestsOnly(diagnostics.requests);
  });

  it("UX-039 a proposal whose assertions are not intact cannot be accepted", async () => {
    const scenario = await newScenario(scope(), { weakenAssertion: true });
    const { page, diagnostics } = await portal(stack.owner);
    await page.goto(`/healing-proposals/${scenario.proposalId}`);
    await page.locator("[data-assertions-intact]").waitFor();
    expect(
      await page.locator("[data-assertions-intact]").getAttribute("data-assertions-intact"),
    ).toBe("no");
    expect(await page.locator("main").textContent()).toContain(
      "Assertions NOT intact: this candidate changes what the test checks",
    );
    const accept = page.getByRole("button", { name: "Accept proposal…" });
    expect(await accept.getAttribute("aria-disabled")).toBe("true");
    const reasons = page.getByTestId("accept-unavailable");
    expect(await reasons.textContent()).toContain("Healing never changes assertions");
    await accept.click({ force: true });
    expect(await page.getByRole("dialog").count()).toBe(0);
    expect(diagnostics.requests.filter((entry) => entry.includes("/approve"))).toEqual([]);
    expect(system.healing.get(scenario.proposalId).status).toBe("proposed");
    await expectAccessible(page, "healing review (assertions not intact)");
  });

  it("UX-039 a proposal whose base revision is no longer active is blocked with the reason", async () => {
    const scenario = await newScenario(scope());
    const test = system.tests.get(scenario.test.id);
    const other = system.revisions.create(
      scenario.test.id,
      scaffoldPlan("frontend"),
      scenario.baseId,
    );
    system.revisions.promote(other.id, Number(test.version));
    const { page } = await portal(stack.owner);
    await page.goto(`/healing-proposals/${scenario.proposalId}`);
    const reasons = page.getByTestId("accept-unavailable");
    await reasons.getByText("no longer the base of this proposal", { exact: false }).waitFor();
    expect(
      await page.getByRole("button", { name: "Accept proposal…" }).getAttribute("aria-disabled"),
    ).toBe("true");
  });

  it("UX-039 a concurrent change is a recoverable conflict: nothing is overwritten and a reload lets the reviewer decide", async () => {
    const scenario = await newScenario(scope());
    const { page } = await portal(stack.owner);
    await page.goto(`/healing-proposals/${scenario.proposalId}`);
    await page.locator('button[aria-disabled="false"]', { hasText: "Accept proposal" }).waitFor();
    // Another reviewer annotates the proposal while this page is open.
    const current = system.healing.get(scenario.proposalId);
    system.context.entities.update(
      "HealingProposal",
      system.context.workspaceId,
      current.id,
      Number(current.version),
      {
        ...current,
        limitations: [...current.limitations, "Second reviewer: check the staging data first"],
        version: Number(current.version) + 1,
      },
    );
    await page.getByRole("button", { name: "Accept proposal…" }).click();
    await page.getByRole("button", { name: "Accept and verify" }).click();
    const banner = page.locator('[data-failure="conflict"]');
    await banner.waitFor();
    expect(await banner.textContent()).toContain(
      "This proposal changed while you were reviewing it",
    );
    expect(await banner.textContent()).toContain("Nothing was applied");
    // Nothing was applied and the other reviewer's edit is intact.
    const afterConflict = system.healing.get(scenario.proposalId);
    expect(afterConflict.status).toBe("proposed");
    expect(afterConflict.verificationRunId).toBeNull();
    expect(afterConflict.limitations).toContain("Second reviewer: check the staging data first");
    // The alert took focus so it is announced and reachable.
    expect(await banner.evaluate((element) => element === document.activeElement)).toBe(true);
    expect(await page.getByRole("dialog").count()).toBe(0);
    // Recovery: reload shows the other reviewer's note and the decision can be retried.
    await banner.getByRole("button", { name: "Reload review" }).click();
    await page.getByText("Second reviewer: check the staging data first").first().waitFor();
    expect(await page.locator('[data-failure="conflict"]').count()).toBe(0);
    await page.getByRole("button", { name: "Accept proposal…" }).click();
    await page.getByRole("button", { name: "Accept and verify" }).click();
    await page.locator("[data-notice]").waitFor();
    expect(system.healing.get(scenario.proposalId).status).toBe("approved");
  });

  it("UX-039 rejecting needs a reason bound to its field and records it", async () => {
    const scenario = await newScenario(scope());
    const { page, diagnostics } = await portal(stack.owner);
    await page.goto(`/healing-proposals/${scenario.proposalId}`);
    await page.getByRole("heading", { level: 3, name: "Reject with a reason" }).waitFor();
    await page.getByRole("button", { name: "Reject proposal" }).click();
    const summary = page.getByTestId("error-summary");
    await summary.waitFor();
    expect(await summary.textContent()).toContain("Enter the reason for rejecting this proposal.");
    const reason = page.getByLabel("Reason", { exact: false });
    expect(await reason.getAttribute("aria-invalid")).toBe("true");
    expect(await reason.getAttribute("aria-describedby")).toBeTruthy();
    expect(diagnostics.requests.filter((entry) => entry.includes("/reject"))).toEqual([]);
    expect(system.healing.get(scenario.proposalId).status).toBe("proposed");

    await reason.fill("The test id belongs to a different button on this page.");
    await page.getByRole("button", { name: "Reject proposal" }).click();
    await page.locator("[data-notice]").waitFor();
    expect(await page.locator("[data-notice]").textContent()).toContain("Proposal rejected");
    await page.locator('[data-healing-status="rejected"]').first().waitFor();
    const stored = system.healing.get(scenario.proposalId);
    expect(stored.status).toBe("rejected");
    expect(stored.limitations.join(" ")).toContain("The test id belongs to a different button");
    expect(stored.verificationRunId).toBeNull();
    expect(system.tests.get(scenario.test.id).activeRevisionId).toBe(scenario.baseId);
    expect(await page.locator("[data-lifecycle-headline]").textContent()).toContain("rejected");
    expectCatalogRequestsOnly(diagnostics.requests);
  });

  it("UX-039 a viewer reads the review but accept and reject are disabled with the reason", async () => {
    const scenario = await newScenario(scope());
    const { page, diagnostics } = await portal(viewer);
    await page.goto(`/healing-proposals/${scenario.proposalId}`);
    await page.locator("[data-assertions-intact]").waitFor();
    const accept = page.getByRole("button", { name: "Accept proposal…" });
    expect(await accept.getAttribute("aria-disabled")).toBe("true");
    expect(await page.getByTestId("accept-unavailable").textContent()).toContain(
      "Your role cannot approve healing proposals",
    );
    expect(await page.getByTestId("reject-unavailable").textContent()).toContain(
      "Your role cannot reject healing proposals",
    );
    await accept.click({ force: true });
    await page.getByRole("button", { name: "Reject proposal" }).click({ force: true });
    expect(await page.getByRole("dialog").count()).toBe(0);
    expect(diagnostics.requests.filter((entry) => /\/(approve|reject)$/.test(entry))).toEqual([]);
    expect(system.healing.get(scenario.proposalId).status).toBe("proposed");
    await expectAccessible(page, "healing review as viewer");
  });

  it("UX-039 UX-051 accepting works with the keyboard alone", async () => {
    const scenario = await newScenario(scope());
    const { page } = await portal(stack.owner);
    await page.goto(`/healing-proposals/${scenario.proposalId}`);
    await page.locator('button[aria-disabled="false"]', { hasText: "Accept proposal" }).waitFor();
    const keyboard = await keyboardOnly(page);
    await keyboard.tabTo((element) => element.name.startsWith("Accept proposal"), 200);
    expect((await keyboard.focused()).focusRing).toBe(true);
    await keyboard.press("Enter");
    const dialog = page.getByRole("dialog", { name: "Accept this healing proposal?" });
    await dialog.waitFor();
    await keyboard.tabTo((element) => element.name === "Accept and verify", 6);
    expect((await keyboard.focused()).focusRing).toBe(true);
    await keyboard.press("Enter");
    await page.locator("[data-notice]").waitFor();
    expect(system.healing.get(scenario.proposalId).status).toBe("approved");
    await keyboard.assertNoPointerUsed();
  });
});
