import type { Application } from "@testmaster/application";
import { routeCatalog } from "@testmaster/contracts";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { type CompareFixture, finishRun, seedCompareFixture } from "./compare-fixture.js";
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
 * Run and batch comparison, the batch matrix, flake studies and quarantine in the portal
 * (UX-035, UX-036, UX-037, UX-038) against the real server profile. Runs, batches and studies are
 * admitted through the application services on the same PostgreSQL database and finished through
 * the lease repository, exactly as a worker would; every user action below goes through the
 * browser and the `/v1` API.
 */
let stack: ServerStack;
let system: Application;
let data: CompareFixture;
let projectId = "";
let stagingId = "";
const open: OpenPortal[] = [];

async function portal(user = stack.owner, viewport?: { width: number; height: number }) {
  const opened = await openPortal(
    { baseUrl: stack.baseUrl, spkiSha256: stack.ca.spkiSha256 },
    user,
    viewport ? { viewport } : {},
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

beforeAll(async () => {
  stack = await startServerStack();
  system = (await stack.scope()).forWorkspaceSystem(stack.workspaceId);
  data = await seedCompareFixture(system, { projectName: "Compare portal project", bulk: true });
  projectId = data.projectId;
  stagingId = data.stagingId;
}, 900_000);

afterAll(async () => {
  for (const opened of open.splice(0)) await opened.close().catch(() => undefined);
  await stack?.stop();
});

describe("comparison pages", () => {
  it("UX-035 compares two Runs of different revisions: explicit mismatch, grouped differences, no regression verdict", async () => {
    const { page, diagnostics } = await portal();
    await page.goto("/compare");
    await page.getByRole("heading", { level: 1, name: "Compare Runs" }).waitFor();
    await page.getByLabel("Left Run ID").fill(data.passedRevisionOne);
    await page.getByLabel("Right Run ID").fill(data.failedRevisionTwo);
    await page.getByRole("button", { name: "Compare" }).click();
    const banner = page.locator("[data-comparability]");
    await banner.waitFor();
    expect(await banner.getAttribute("data-comparability")).toBe("partially_comparable");
    expect(await banner.textContent()).toContain("Partially comparable");
    const text = (await page.locator("main").textContent()) ?? "";
    expect(text).toContain("The test revision differs.");
    expect(text).toContain("not a regression");
    // Each difference sits in a table with its field, left and right value, grouped by topic.
    const revisions = page.getByRole("table", { name: "Differences: Test revision and plan" });
    await revisions.waitFor();
    const revisionRow = revisions.getByRole("row", { name: /^Revision / });
    expect(await revisionRow.getByRole("cell").nth(1).textContent()).toContain("rev_");
    expect(await revisionRow.getByRole("cell").nth(2).textContent()).toContain("rev_");
    // A verdict difference is listed as one, never labelled as a regression.
    const verdict = page.getByRole("table", { name: "Differences: Verdict and gate" });
    expect(await verdict.getByRole("row", { name: /^Outcome / }).textContent()).toMatch(
      /passed.*failed/,
    );
    expect(text.toLowerCase()).not.toContain("regression detected");
    // The compared pair lives in the URL so the view can be shared and survives a reload.
    const url = new URL(page.url());
    expect(url.searchParams.get("left")).toBe(data.passedRevisionOne);
    expect(url.searchParams.get("right")).toBe(data.failedRevisionTwo);
    await page.reload();
    await page.locator("[data-comparability]").waitFor();
    expect(await page.getByLabel("Left Run ID").inputValue()).toBe(data.passedRevisionOne);
    await expectAccessible(page, "run comparison desktop");
    expect(diagnostics.pageErrors).toEqual([]);
    expectCatalogRequestsOnly(diagnostics.requests);
    expect(diagnostics.requests).toContain("POST /v1/run-comparisons");
  });

  it("UX-035 two Runs of different tests are not comparable: the verdict difference is not presented", async () => {
    const { page } = await portal();
    await page.goto(`/compare?left=${data.passedRevisionOne}&right=${data.otherTest}`);
    const banner = page.locator("[data-comparability]");
    await banner.waitFor();
    expect(await banner.getAttribute("data-comparability")).toBe("incomparable");
    expect(await banner.textContent()).toContain("Not comparable");
    const text = (await page.locator("main").textContent()) ?? "";
    expect(text).toContain("The two sides run a different test or a different runner.");
    expect(text).toContain("verdict difference(s) are not shown");
    expect(text).toContain("These sides are not comparable, so their verdicts are unrelated.");
    // The verdict group is not rendered, and the remaining differences are collapsed for diagnosis.
    expect(await page.getByRole("table", { name: "Differences: Verdict and gate" }).count()).toBe(
      0,
    );
    const details = page.locator("details");
    expect(await details.count()).toBe(1);
    expect(await details.getAttribute("open")).toBeNull();
    // Negative control: the comparable pair on the previous page does render the verdict group.
    await page.goto(`/compare?left=${data.passedRevisionOne}&right=${data.failedRevisionTwo}`);
    await page.getByRole("table", { name: "Differences: Verdict and gate" }).waitFor();
  });

  it("UX-035 an unknown Run ID and a missing field are reported without leaking existence", async () => {
    const { page } = await portal();
    await page.goto("/compare");
    await page.getByLabel("Left Run ID").fill(data.passedRevisionOne);
    await page.getByRole("button", { name: "Compare" }).click();
    const summary = page.getByTestId("error-summary");
    await summary.waitFor();
    expect(await summary.textContent()).toContain("Enter the right run id.");
    expect(page.url()).not.toContain("left=");
    await page.getByLabel("Right Run ID").fill("run_00000000-0000-4000-8000-000000000000");
    await page.getByRole("button", { name: "Compare" }).click();
    await page.getByRole("region", { name: "Not found" }).waitFor();
    expect(await page.locator("[data-comparability]").count()).toBe(0);
  });

  it("UX-035 compares batches: a case missing from one side is not run, never passed, and cursors load more", async () => {
    const { page, diagnostics } = await portal();
    await page.goto(`/compare/batches?left=${data.incompleteBatch}&right=${data.completeBatch}`);
    const banner = page.locator("[data-comparability]");
    await banner.waitFor();
    expect(["partially_comparable", "incomparable"]).toContain(
      await banner.getAttribute("data-comparability"),
    );
    const missing = page.getByRole("table", {
      name: "Differences: Cases present on one side only",
    });
    await missing.waitFor();
    const row = missing.getByRole("row", { name: /present on one side only/ });
    const cells = await row.getByRole("cell").allTextContents();
    expect(cells.join(" | ")).toContain("Not present: not run");
    expect(cells.join(" ").toLowerCase()).not.toContain("passed");
    // The count differences are explicit too: requested members and members not dispatched.
    const counts = page.getByRole("table", { name: "Differences: Selection and counts" });
    expect(await counts.getByRole("row", { name: /Members not dispatched/ }).count()).toBe(1);

    // Thirty cases with opposite verdicts produce more differences than one page holds.
    await page.goto(`/compare/batches?left=${data.bulkLeft}&right=${data.bulkRight}`);
    await page.locator("[data-comparability]").waitFor();
    const loaded = page.getByText(/\d+ difference\(s\) loaded/);
    const firstCount = Number(/(\d+) difference/.exec((await loaded.textContent()) ?? "")?.[1]);
    expect(firstCount).toBe(50);
    await page.getByRole("button", { name: "Load more differences" }).click();
    await page.getByText("All differences loaded").waitFor();
    const secondCount = Number(/(\d+) difference/.exec((await loaded.textContent()) ?? "")?.[1]);
    expect(secondCount).toBeGreaterThan(firstCount);
    expect(await page.getByRole("button", { name: "Load more differences" }).count()).toBe(0);
    expectCatalogRequestsOnly(diagnostics.requests);
    expect(diagnostics.requests).toContain("POST /v1/batch-comparisons");
  });

  it("UX-035 compares two Runs with the keyboard alone", async () => {
    const { page } = await portal();
    await page.goto("/compare");
    await page.getByRole("heading", { level: 1, name: "Compare Runs" }).waitFor();
    const keyboard = await keyboardOnly(page);
    await keyboard.tabTo((element) => element.name.startsWith("Left Run ID"));
    expect((await keyboard.focused()).focusRing).toBe(true);
    await keyboard.type(data.passedRevisionOne);
    await keyboard.press("Tab");
    expect((await keyboard.focused()).name.startsWith("Right Run ID")).toBe(true);
    await keyboard.type(data.failedRevisionTwo);
    await keyboard.press("Tab");
    expect((await keyboard.focused()).name).toBe("Compare");
    await keyboard.press("Enter");
    await page.locator("[data-comparability]").waitFor();
    await keyboard.assertNoPointerUsed();
  });

  it("UX-035 the comparison reflows at 320 px and 200 % zoom", async () => {
    const { page } = await portal();
    await atViewport(page, { width: 320, zoom: 2, textScale: 1 });
    await page.goto(`/compare?left=${data.passedRevisionOne}&right=${data.failedRevisionTwo}`);
    await page.locator("[data-comparability]").waitFor();
    await expectNoPageOverflow(page, "run comparison at 320 px");
    await expectAccessible(page, "run comparison 320px 200%");
  });
});

describe("batch matrix", () => {
  it("UX-036 lists every Run per cell with text status, marks the absent pair Not run and lists the member not dispatched", async () => {
    const { page, diagnostics } = await portal();
    await page.goto(`/batches/${data.incompleteBatch}`);
    await page.getByRole("heading", { level: 2, name: "Matrix" }).waitFor();
    const summary = page.locator("[data-completeness]");
    expect(await summary.getAttribute("data-completeness")).toBe("incomplete");
    expect(await summary.textContent()).toContain("Incomplete: 1 member(s) were not dispatched");
    // The incomplete batch never shows a green gate.
    expect(
      await page
        .locator("main [data-status='passed']")
        .evaluateAll(
          (nodes) => nodes.filter((node) => node.textContent?.startsWith("Gate")).length,
        ),
    ).toBe(0);

    const matrix = page.getByRole("table", { name: "Batch matrix: tests by environment" });
    await matrix.waitFor();
    expect(await matrix.getByRole("columnheader").allTextContents()).toEqual([
      "Test",
      "canary",
      "staging",
    ]);
    const checkoutRow = matrix.getByRole("row", { name: /Checkout flow/ });
    const loginRow = matrix.getByRole("row", { name: /Login flow/ });
    // Failure only in canary stays in its own cell; staging passes in its own cell.
    const [checkoutCanary = "", checkoutStaging = ""] = await checkoutRow
      .getByRole("cell")
      .allTextContents();
    expect(checkoutCanary).toContain("Failed");
    expect(checkoutStaging).toContain("Passed");
    expect(checkoutCanary).not.toContain("Passed");
    // The pair that has no Run says so.
    const [loginCanary = "", loginStaging = ""] = await loginRow
      .getByRole("cell")
      .allTextContents();
    expect(loginCanary).toContain("Not run");
    expect(loginStaging).toContain("Passed");
    // Run conditions are exposed per cell; unrecorded values say so.
    expect(checkoutStaging).toContain("Browser");
    expect(checkoutStaging).toContain("Runner image");
    expect(checkoutStaging).toContain("Viewport");
    expect(checkoutStaging).toContain("Locale / time zone");
    expect(checkoutStaging).toContain("Not recorded");
    // The Run link goes to the Run, and the failed Run is the one in the canary cell.
    const failedLink = checkoutRow.locator(`[data-run-id="${data.incompleteFailedRun}"] a`);
    expect(await failedLink.getAttribute("href")).toBe(`/runs/${data.incompleteFailedRun}`);

    const notDispatched = page.getByRole("table", { name: "Members not dispatched" });
    await notDispatched.waitFor();
    const memberText = (await notDispatched.textContent()) ?? "";
    expect(memberText).toContain("tst_00000000-0000-4000-8000-000000000000");
    expect(memberText).toContain("upstream_failed");
    expect(memberText).toContain("not a pass");
    await expectAccessible(page, "incomplete batch matrix desktop");
    expect(diagnostics.pageErrors).toEqual([]);
    expectCatalogRequestsOnly(diagnostics.requests);
    expect(
      diagnostics.requests.some((entry) =>
        entry.startsWith(`GET /v1/runs?batchId=${data.incompleteBatch}`),
      ),
    ).toBe(true);
  });

  it("UX-036 a complete batch reads its gate, with every pair run and no Not run cell", async () => {
    const { page } = await portal();
    await page.goto(`/batches/${data.completeBatch}`);
    const matrix = page.getByRole("table", { name: "Batch matrix: tests by environment" });
    await matrix.waitFor();
    const summary = page.locator("[data-completeness]");
    expect(await summary.getAttribute("data-completeness")).toBe("complete");
    expect(await summary.textContent()).toContain("4 Runs, gate passed.");
    expect(await page.locator("main [data-status='passed']").first().textContent()).toContain(
      "Gate passed",
    );
    expect(await matrix.getByText("Not run").count()).toBe(0);
    expect(await matrix.getByRole("link", { name: /^Run / }).count()).toBe(4);
    expect(await page.getByText("Every requested member was dispatched.").count()).toBe(1);
  });

  it("UX-036 a running batch can be cancelled after a confirmation naming the batch", async () => {
    const { page, diagnostics } = await portal();
    await page.goto(`/batches/${data.runningBatch}`);
    await page.getByRole("heading", { level: 2, name: "Matrix" }).waitFor();
    expect(await page.locator("main").textContent()).toContain("Still running");
    await page.getByRole("button", { name: "Cancel batch" }).click();
    const dialog = page.getByRole("dialog", { name: "Cancel this batch?" });
    await dialog.waitFor();
    expect(await dialog.textContent()).toContain(data.runningBatch);
    // Dismissing the dialog sends nothing.
    await dialog.getByRole("button", { name: "Keep running" }).click();
    expect(diagnostics.requests.some((entry) => entry.startsWith("POST /v1/batches/"))).toBe(false);
    await page.getByRole("button", { name: "Cancel batch" }).click();
    await dialog.getByRole("button", { name: "Cancel batch" }).click();
    await page.getByText(/Cancellation requested for 1 Run\(s\)/).waitFor();
    expect(diagnostics.requests).toContain(`POST /v1/batches/${data.runningBatch}/cancel`);
    // Once the Run is cancelled the batch has nothing left to cancel.
    await page.getByRole("button", { name: "Cancel batch" }).waitFor({ state: "detached" });
    expect(await page.locator("main").textContent()).toContain("Cancelled");
    expectCatalogRequestsOnly(diagnostics.requests);
  });

  it("UX-036 an unknown batch is the not-found view", async () => {
    const { page } = await portal();
    await page.goto("/batches/bat_00000000-0000-4000-8000-000000000000");
    await page.getByRole("heading", { level: 1, name: "Not found" }).waitFor();
    expect(await page.getByRole("table").count()).toBe(0);
  });

  it("UX-036 the matrix reflows at 320 px and 200 % zoom and stays axe clean", async () => {
    const { page } = await portal();
    await atViewport(page, { width: 320, zoom: 2, textScale: 1 });
    await page.goto(`/batches/${data.incompleteBatch}`);
    await page.getByRole("table", { name: "Batch matrix: tests by environment" }).waitFor();
    await expectNoPageOverflow(page, "batch matrix at 320 px");
    await expectAccessible(page, "batch matrix 320px 200%");
  });

  it("UX-036 the matrix and its cancel action work with the keyboard alone", async () => {
    const { page } = await portal();
    await page.goto(`/batches/${data.incompleteBatch}`);
    await page.getByRole("table", { name: "Batch matrix: tests by environment" }).waitFor();
    const keyboard = await keyboardOnly(page);
    await keyboard.tabTo((element) => element.tag === "a" && element.name.startsWith("Run "), 80);
    expect((await keyboard.focused()).focusRing).toBe(true);
    await keyboard.assertNoPointerUsed();
  });
});

describe("flake studies", () => {
  it("UX-037 a finished study shows counts, interval, limitations and never calls a small sample stable", async () => {
    const { page, diagnostics } = await portal();
    await page.goto(`/flake-studies/${data.finishedStudy}`);
    const result = page.locator("[data-classification]");
    await result.waitFor();
    // The cohort has no verified source binding in this environment, so the study says so.
    expect(await result.getAttribute("data-classification")).toBe("insufficient_data");
    const text = (await page.locator("main").textContent()) ?? "";
    expect(text).toContain("Not enough data");
    expect(text).toContain("3 passed and 1 failed out of 4 valid Runs");
    expect(text).toContain("95% interval for the failure rate");
    expect(text).toContain("Strict: healing off and a single Attempt for every Run");
    expect(text).toContain("The source revision is not verified");
    expect(text).toContain("The study is complete");
    expect(text).not.toMatch(/\bstable\b/i);
    const counts = page.getByRole("table", { name: "Flake study counts" });
    expect(
      await counts
        .getByRole("row", { name: /^Failed / })
        .getByRole("cell")
        .nth(1)
        .textContent(),
    ).toBe("1");
    expect(
      await counts
        .getByRole("row", { name: /^Passed / })
        .getByRole("cell")
        .nth(1)
        .textContent(),
    ).toBe("3");
    expect(
      await page.getByRole("region", { name: "Runs" }).getByRole("link", { name: /^run_/ }).count(),
    ).toBe(4);
    await expectAccessible(page, "flake study desktop");
    expect(diagnostics.pageErrors).toEqual([]);
    expectCatalogRequestsOnly(diagnostics.requests);
  });

  it("UX-037 a running study polls calmly, shows progress, and stops polling once complete", async () => {
    const { page, diagnostics } = await portal();
    // The page polls on a timer; a controlled clock fires it without sleeping in the test.
    await page.clock.install();
    await page.goto(`/flake-studies/${data.runningStudy}`);
    await page.getByText("2 of 4 Runs finished").waitFor();
    expect(await page.locator("main").textContent()).toContain(
      "This page updates while Runs are still running.",
    );
    const requestsFor = () =>
      diagnostics.requests.filter((entry) => entry === `GET /v1/flake-studies/${data.runningStudy}`)
        .length;
    const initial = requestsFor();
    // Less than one interval later nothing has been polled: the interval is calm.
    await page.clock.runFor(2000);
    expect(requestsFor()).toBe(initial);
    // Finish the remaining Runs while the page is open; the next poll must pick them up.
    for (const runId of data.runningStudyRuns.slice(2)) finishRun(system, runId, "passed");
    await page.clock.runFor(5100);
    await page.getByText("The study is complete.").waitFor();
    expect(
      await page
        .getByRole("progressbar", { name: "Runs finished" })
        .evaluate((element) => (element instanceof HTMLProgressElement ? element.value : -1)),
    ).toBe(4);
    const settled = requestsFor();
    expect(settled).toBeGreaterThan(initial);
    // Negative control: a completed study makes no further requests, however long the page stays open.
    await page.clock.runFor(60_000);
    expect(requestsFor()).toBe(settled);
    expect(await page.locator("main").textContent()).not.toMatch(/\bstable\b/i);
  });

  it("UX-037 the start form rejects n below 2, shows the server's refusal and keeps the input", async () => {
    const { page, diagnostics } = await portal();
    await page.goto(`/projects/${projectId}/flake-studies/new?testId=${data.checkout}`);
    await page.getByRole("heading", { level: 1, name: "Start a flake study" }).waitFor();
    // The active revision is the default revision.
    await page.waitForFunction(
      (revision) =>
        document.querySelector<HTMLInputElement>("#flake-revisionId")?.value === revision,
      data.checkoutRevision,
    );
    await page.getByLabel("Environment").selectOption({ label: `staging (${stagingId})` });
    await page.getByLabel("Number of Runs (n)").fill("1");
    await page.getByRole("button", { name: "Start flake study" }).click();
    const summary = page.getByTestId("error-summary");
    await summary.waitFor();
    expect(await summary.textContent()).toContain("One Run cannot show flakiness.");
    expect(diagnostics.requests).not.toContain("POST /v1/flake-studies");
    await page.getByLabel("Number of Runs (n)").fill("5");
    await page.getByLabel("Seed").fill("7");
    await page.getByRole("button", { name: "Start flake study" }).click();
    const refusal = page.getByRole("alert", { name: "The study was not started" });
    await refusal.waitFor();
    // The server refuses without a live worker; the form keeps what the user typed.
    expect(await refusal.textContent()).toContain("PRECONDITION_FAILED");
    expect(await page.getByLabel("Number of Runs (n)").inputValue()).toBe("5");
    expect(await page.getByLabel("Seed").inputValue()).toBe("7");
    expect(diagnostics.requests).toContain("POST /v1/flake-studies");
    await expectAccessible(page, "flake study form desktop");
    expectCatalogRequestsOnly(diagnostics.requests);
  });

  it("UX-037 a started study opens its page (admission answered by the browser, the page is real)", async () => {
    const { page } = await portal();
    let body: unknown = null;
    await page.route("**/v1/flake-studies", async (route) => {
      if (route.request().method() !== "POST") return route.fallback();
      body = route.request().postDataJSON();
      return route.fulfill({
        status: 201,
        contentType: "application/json",
        body: JSON.stringify({ requestId: "req", data: { batchId: data.finishedStudy } }),
      });
    });
    await page.goto(
      `/projects/${projectId}/flake-studies/new?testId=${data.checkout}&environmentId=${stagingId}`,
    );
    await page.waitForFunction(
      (revision) =>
        document.querySelector<HTMLInputElement>("#flake-revisionId")?.value === revision,
      data.checkoutRevision,
    );
    await page.getByLabel("Number of Runs (n)").fill("4");
    await page.getByRole("button", { name: "Start flake study" }).click();
    await page.waitForURL((url) => url.pathname === `/flake-studies/${data.finishedStudy}`);
    expect(body).toEqual({
      testRevision: data.checkoutRevision,
      environment: stagingId,
      n: 4,
      seed: 0,
    });
    await page.locator("[data-classification]").waitFor();
  });

  it("UX-037 the study page reflows at 320 px and 200 % zoom", async () => {
    const { page } = await portal();
    await atViewport(page, { width: 320, zoom: 2, textScale: 1 });
    await page.goto(`/flake-studies/${data.finishedStudy}`);
    await page.locator("[data-classification]").waitFor();
    await expectNoPageOverflow(page, "flake study at 320 px");
    await expectAccessible(page, "flake study 320px 200%");
  });

  it("UX-037 the start form is operable with the keyboard alone", async () => {
    const { page } = await portal();
    await page.goto(`/projects/${projectId}/flake-studies/new`);
    await page.getByRole("heading", { level: 1, name: "Start a flake study" }).waitFor();
    const keyboard = await keyboardOnly(page);
    await keyboard.tabTo((element) => element.name.startsWith("Number of Runs"));
    await keyboard.press("Control+a");
    await keyboard.type("1");
    await keyboard.tabTo((element) => element.name === "Start flake study");
    await keyboard.press("Enter");
    await page.getByTestId("error-summary").waitFor();
    expect((await keyboard.focused()).role).toBe("alert");
    await keyboard.assertNoPointerUsed();
  });
});

describe("quarantine", () => {
  async function quarantineVia(page: OpenPortal["page"]) {
    await page.goto(`/projects/${projectId}/quarantine`);
    await page.getByRole("heading", { level: 1, name: "Quarantine" }).waitFor();
    await page
      .getByRole("table", { name: "Quarantined tests" })
      .or(page.getByText("No quarantined tests"))
      .waitFor();
  }

  const hostileReason = `Flaky redirect <img src=x onerror="window.__pwned='q'"> until the fix ships`;

  it("UX-038 quarantines a test with owner, reason and expiry, states the gate effect and keeps the failed Run failed", async () => {
    const { page, diagnostics } = await portal();
    await quarantineVia(page);
    const notice = await page.getByTestId("quarantine-notice").textContent();
    expect(notice).toContain("never changes a failed Run");
    expect(await page.getByTestId("coverage-note").textContent()).toContain("No active quarantine");

    // Validation: a past expiry is refused in the page and nothing is sent.
    await page
      .locator("#quarantine-testId")
      .selectOption({ label: `Checkout flow (${data.checkout})` });
    await page.locator("#quarantine-reason").fill(hostileReason);
    await page.locator("#quarantine-expiresAt").fill("2020-01-01T09:30");
    await page.getByRole("button", { name: "Review quarantine" }).click();
    const summary = page.getByTestId("error-summary");
    await summary.waitFor();
    expect(await summary.textContent()).toContain("The expiry must be in the future.");
    expect(diagnostics.requests).not.toContain(`PUT /v1/tests/${data.checkout}/quarantine`);
    expect(diagnostics.requests).not.toContain("POST /v1/execution-previews");

    // A future expiry opens the confirmation, which states the effect on the gate first.
    await page.locator("#quarantine-expiresAt").fill("2099-11-01T09:30");
    await page.getByRole("button", { name: "Review quarantine" }).click();
    const dialog = page.getByRole("dialog", { name: "Quarantine this test?" });
    await dialog.waitFor();
    const dialogText = (await dialog.textContent()) ?? "";
    expect(dialogText).toContain("Selected by default: its Runs count toward the gate.");
    expect(dialogText).toContain("Excluded from selection with reason quarantined");
    expect(dialogText).toContain("blocks the gate");
    expect(
      diagnostics.requests.filter((entry) => entry === "POST /v1/execution-previews").length,
    ).toBeGreaterThanOrEqual(2);
    expect(diagnostics.requests).not.toContain(`PUT /v1/tests/${data.checkout}/quarantine`);
    await dialog.getByRole("button", { name: "Quarantine test" }).click();

    const row = page.getByRole("row", { name: /Checkout flow/ });
    await row.waitFor();
    // The gate effect and the window counts load after the row appears.
    await row.getByText("Excluded from selection with reason quarantined").waitFor();
    await vi.waitFor(async () =>
      expect((await row.getByRole("cell").allTextContents())[4]).not.toBe("Not loaded"),
    );
    const rowText = (await row.textContent()) ?? "";
    expect(rowText).toContain("Active");
    expect(rowText).toContain("Excluded from selection with reason quarantined");
    expect(rowText).toContain("strict policy");
    expect(rowText).toContain("2099-11-01T");
    // The hostile reason is inert text.
    expect(rowText).toContain("<img src=x");
    expect(await page.locator("main img").count()).toBe(0);
    expect(await page.evaluate(() => Reflect.get(window, "__pwned"))).toBe(undefined);
    expect(await page.getByTestId("coverage-note").textContent()).toContain(
      "Coverage is reduced: 1 test is excluded",
    );
    // Runs of the quarantined test stay in the window counts; the failed Run is untouched.
    const cells = await row.getByRole("cell").allTextContents();
    expect(Number(cells[4])).toBeGreaterThan(0);
    expect(Number(cells[5])).toBeGreaterThan(0);
    const api = stack.ownerClient(0);
    const failed = await api.request("GET", `/v1/runs/${data.incompleteFailedRun}`);
    expect(failed.json<{ data: { outcome: string } }>().data.outcome).toBe("failed");
    const stored = await api.request("GET", `/v1/tests/${data.checkout}/quarantine`);
    expect(stored.json<{ data: { version: number; reason: string } }>().data).toMatchObject({
      version: 1,
      reason: hostileReason,
    });
    expect(diagnostics.pageErrors).toEqual([]);
    expectCatalogRequestsOnly(diagnostics.requests);
    await expectAccessible(page, "quarantine page desktop");
  });

  it("UX-038 edits a quarantine with its version and refuses a stale edit instead of overwriting", async () => {
    const { page, diagnostics } = await portal();
    await quarantineVia(page);
    await page.getByRole("button", { name: "Edit quarantine for Checkout flow" }).click();
    expect(await page.locator("#quarantine-reason").inputValue()).toBe(hostileReason);
    expect(await page.getByRole("heading", { level: 2, name: "Edit quarantine" }).count()).toBe(1);
    await page.locator("#quarantine-reason").fill("Ticket 42: redirect race, fix scheduled");
    await page.getByRole("button", { name: "Review changes" }).click();
    const dialog = page.getByRole("dialog", { name: "Update this quarantine?" });
    await dialog.waitFor();
    expect(await dialog.textContent()).toContain(
      "Excluded from selection with reason quarantined.",
    );
    await dialog.getByRole("button", { name: "Save changes" }).click();
    await page.getByRole("row", { name: /Ticket 42/ }).waitFor();
    const api = stack.ownerClient(0);
    const stored = await api.request("GET", `/v1/tests/${data.checkout}/quarantine`);
    expect(stored.json<{ data: { version: number } }>().data.version).toBe(2);

    // Someone else changes it; this page still holds version 2 and must not overwrite version 3.
    system.quarantine.set(data.checkout, {
      reason: "Changed elsewhere",
      expiresAt: "2099-12-01T00:00:00.000Z",
      expectedVersion: 2,
    });
    await page.getByRole("button", { name: "Edit quarantine for Checkout flow" }).click();
    await page.locator("#quarantine-reason").fill("Overwrite attempt");
    await page.getByRole("button", { name: "Review changes" }).click();
    await dialog.waitFor();
    await dialog.getByRole("button", { name: "Save changes" }).click();
    await dialog.getByRole("alert").waitFor();
    expect(await dialog.getByRole("alert").textContent()).toContain(
      "changed since the page loaded",
    );
    const after = await api.request("GET", `/v1/tests/${data.checkout}/quarantine`);
    expect(after.json<{ data: { reason: string; version: number } }>().data).toMatchObject({
      reason: "Changed elsewhere",
      version: 3,
    });
    await dialog.getByRole("button", { name: "Cancel" }).click();
    expectCatalogRequestsOnly(diagnostics.requests);
  });

  it("UX-038 an expired quarantine is marked expired and no longer claims an exclusion", async () => {
    const expiresAtMs = Date.now() + 1500;
    system.quarantine.set(data.login, {
      reason: "Old known issue",
      expiresAt: new Date(expiresAtMs).toISOString(),
    });
    // The real clock decides expiry (the server compares against Date.now()), so no fake clock can stand in.
    await vi.waitFor(() => expect(Date.now()).toBeGreaterThan(expiresAtMs), {
      timeout: 10_000,
      interval: 100,
    });
    const { page } = await portal();
    await quarantineVia(page);
    const row = page.getByRole("row", { name: /Login flow/ });
    await row.waitFor();
    const rowText = (await row.textContent()) ?? "";
    expect(rowText).toContain("Expired");
    expect(rowText).toContain("no longer excluded");
    expect(rowText).not.toContain("Excluded from selection with reason quarantined");
    expect(await row.locator("[data-state='expired']").count()).toBe(1);
    // Negative control: the active one still reads as active.
    expect(
      await page
        .getByRole("row", { name: /Checkout flow/ })
        .locator("[data-state='active']")
        .count(),
    ).toBe(1);
    expect(await page.getByTestId("coverage-note").textContent()).toContain("1 test is excluded");
  });

  it("UX-038 removes a quarantine behind a confirmation that says the test is selected again", async () => {
    const { page, diagnostics } = await portal();
    await quarantineVia(page);
    await page.getByRole("button", { name: "Remove quarantine for Checkout flow" }).click();
    const dialog = page.getByRole("dialog", { name: "Remove this quarantine?" });
    await dialog.waitFor();
    const text = (await dialog.textContent()) ?? "";
    expect(text).toContain("Excluded from selection with reason quarantined.");
    expect(text).toContain("Selected by default again");
    expect(text).toContain("Earlier failures stay in history and metrics");
    // Cancel first: nothing is sent.
    await dialog.getByRole("button", { name: "Cancel" }).click();
    expect(diagnostics.requests).not.toContain(`DELETE /v1/tests/${data.checkout}/quarantine`);
    await page.getByRole("button", { name: "Remove quarantine for Checkout flow" }).click();
    await dialog.getByRole("button", { name: "Remove quarantine" }).click();
    await page.getByText(/Quarantine removed for Checkout flow/).waitFor();
    await page.getByRole("row", { name: /Checkout flow/ }).waitFor({ state: "detached" });
    const gone = await stack.ownerClient(0).request("GET", `/v1/tests/${data.checkout}/quarantine`);
    expect(gone.status).toBe(404);
    // The failed Run and the metrics denominator still include the test's Runs.
    const metrics = await stack.ownerClient(0).request("GET", `/v1/projects/${projectId}/metrics`);
    expect(metrics.json<{ data: { considered: number } }>().data.considered).toBeGreaterThan(0);
    expect(
      (await stack.ownerClient(0).request("GET", `/v1/runs/${data.incompleteFailedRun}`)).json<{
        data: { outcome: string };
      }>().data.outcome,
    ).toBe("failed");
    expectCatalogRequestsOnly(diagnostics.requests);
  });

  it("UX-038 quarantines a test with the keyboard alone", async () => {
    const { page, diagnostics } = await portal();
    await quarantineVia(page);
    await page.getByRole("button", { name: "Review quarantine" }).waitFor();
    // The test list loads after the form renders; type-ahead needs the options to exist.
    await page
      .locator("#quarantine-testId option", { hasText: "Bulk" })
      .waitFor({ state: "attached" });
    const keyboard = await keyboardOnly(page);
    await keyboard.tabTo(
      (element) => element.tag === "select" && element.id === "quarantine-testId",
    );
    expect((await keyboard.focused()).focusRing).toBe(true);
    await keyboard.type("Bulk");
    await keyboard.press("Tab");
    expect((await keyboard.focused()).id).toBe("quarantine-reason");
    await keyboard.type("Keyboard decision");
    await keyboard.press("Tab");
    expect((await keyboard.focused()).id).toBe("quarantine-expiresAt");
    await keyboard.type("11112099");
    await keyboard.press("ArrowRight");
    await keyboard.type("0930");
    await keyboard.type("A");
    expect(await page.locator("#quarantine-expiresAt").inputValue()).toBe("2099-11-11T09:30");
    await keyboard.tabTo((element) => element.name === "Review quarantine");
    await keyboard.press("Enter");
    const dialog = page.getByRole("dialog", { name: "Quarantine this test?" });
    await dialog.waitFor();
    await keyboard.tabTo((element) => element.name === "Quarantine test");
    await keyboard.press("Enter");
    await page.getByRole("row", { name: /Bulk comparison/ }).waitFor();
    expect(diagnostics.requests).toContain(`PUT /v1/tests/${data.bulk}/quarantine`);
    await keyboard.assertNoPointerUsed();
  });

  it("UX-038 the quarantine page reflows at 320 px and 200 % zoom", async () => {
    const { page } = await portal();
    await atViewport(page, { width: 320, zoom: 2, textScale: 1 });
    await quarantineVia(page);
    await page.getByRole("row", { name: /Bulk comparison/ }).waitFor();
    await expectNoPageOverflow(page, "quarantine at 320 px");
    await expectAccessible(page, "quarantine 320px 200%");
  });
});
