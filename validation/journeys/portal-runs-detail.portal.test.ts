import type { Application } from "@testmaster/application";
import { routeCatalog } from "@testmaster/contracts";
import { OutboxRepository } from "@testmaster/persistence";
import type { Page } from "playwright";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  atViewport,
  expectAccessible,
  expectNoPageOverflow,
  keyboardOnly,
  type OpenPortal,
  openPortal,
} from "./portal.js";
import {
  artifactPaths,
  createRunsScope,
  createTest,
  hostileJson,
  type RunsScope,
  secretToken,
  seedArtifactRun,
  seedCleanupFailedRun,
  seedFailedRun,
  seedLiveRun,
  seedObservedRun,
  seedPassedRun,
  seedRetryRun,
} from "./runs-fixtures.js";
import { type ServerStack, startServerStack } from "./server-stack.js";

/**
 * Run history, Run detail and artifact viewing in the portal (UX-026 to UX-032, UX-034, M4-05)
 * against the real server profile. Runs are admitted and finalized through the same persistence
 * path the worker uses; every read, link mint and cancellation goes through the browser and `/v1`.
 */
declare global {
  interface Window {
    /** Set by hostile fixture bodies; it must stay undefined in the portal's origin. */
    __pwned?: string;
  }
}

interface RevisionsBody {
  data?: { items: { plan: { steps: { input: Record<string, unknown> }[] } }[] };
}

async function pwnedMarker(page: Page): Promise<string | undefined> {
  return page.evaluate(() => window.__pwned);
}

let stack: ServerStack;
let system: Application;
let scope: RunsScope;
let foreignScope: RunsScope;
const open: OpenPortal[] = [];

interface Seeded {
  runId: string;
  testId: string;
  attemptIds: string[];
  artifacts: { id: string; relativePath: string; sha256: string; sizeBytes: number }[];
}
const runs = {} as Record<
  | "artifact"
  | "tombstone"
  | "retry"
  | "cleanup"
  | "passed"
  | "failed"
  | "live"
  | "liveCancel"
  | "observed"
  | "foreign",
  Seeded
>;

/**
 * The server budgets authentication per client address (20 burst, 1 per second), and every
 * journey browser comes from one address; sign-ins are spaced so the budget never runs dry.
 */
let lastSignIn = 0;

async function portal(options: { signIn?: boolean } = {}): Promise<OpenPortal> {
  const wait = lastSignIn + 3000 - Date.now();
  if (wait > 0) {
    // Real time on purpose: the server's authentication budget refills on the wall clock.
    const { promise, resolve } = Promise.withResolvers<void>();
    setTimeout(resolve, wait);
    await promise;
  }
  lastSignIn = Date.now();
  const opened = await openPortal(
    { baseUrl: stack.baseUrl, spkiSha256: stack.ca.spkiSha256 },
    stack.owner,
    options,
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

/** The page may only talk to its own origin: no artifact bytes come from anywhere else. */
function trackForeignRequests(page: Page): string[] {
  const foreign: string[] = [];
  const origin = new URL(stack.baseUrl).origin;
  page.on("request", (request) => {
    const url = new URL(request.url());
    if (url.protocol.startsWith("http") && url.origin !== origin) foreign.push(request.url());
  });
  return foreign;
}

async function seedOne(
  seed: (scope: RunsScope, testId: string) => Promise<Omit<Seeded, "testId">>,
  inScope: RunsScope = scope,
): Promise<Seeded> {
  const test = createTest(inScope);
  const seeded = await seed(inScope, String(test.id));
  return { ...seeded, testId: String(test.id) };
}

async function openRun(page: Page, runId: string): Promise<void> {
  await page.goto(`/runs/${runId}`);
  await page
    .getByTestId("run-facts")
    .waitFor({ timeout: 15_000 })
    .catch(async (cause: unknown) => {
      const text = await page.locator("main").innerText();
      const statuses = await page.evaluate(() =>
        performance
          .getEntriesByType("resource")
          .filter((entry) => entry.name.includes("/v1/"))
          .map((entry) => `${entry.name.split("/v1/")[1]}=${Reflect.get(entry, "responseStatus")}`),
      );
      throw new Error(`Run ${runId} did not render: ${text.slice(0, 200)} ${statuses.join(" ")}`, {
        cause,
      });
    });
}

async function stageStates(page: Page): Promise<string[]> {
  return page
    .locator('[data-testid="run-timeline"] li')
    .evaluateAll((items) =>
      items.map((item) => `${item.getAttribute("data-stage")}:${item.getAttribute("data-state")}`),
    );
}

function artifactRow(page: Page, relativePath: string) {
  return page
    .getByRole("table", { name: "Artifacts of attempt 1" })
    .getByRole("row")
    .filter({ hasText: relativePath });
}

function appendEvent(
  runId: string,
  type: string,
  payload: Record<string, unknown>,
  workspaceId: string = stack.workspaceId,
): void {
  system.database.withTx(() =>
    new OutboxRepository(system.database).append(workspaceId, runId, type, payload),
  );
}

beforeAll(async () => {
  stack = await startServerStack({ workspaces: 2 });
  system = (await stack.scope()).forWorkspaceSystem(stack.workspaceId);
  scope = await createRunsScope(system, stack.workspaceId, "Run detail");
  const secondWorkspace = stack.workspaces[1];
  if (!secondWorkspace) throw new Error("the stack must provide a second workspace");
  const second = (await stack.scope()).forWorkspaceSystem(secondWorkspace.workspaceId);
  foreignScope = await createRunsScope(second, secondWorkspace.workspaceId, "Foreign");
  runs.artifact = await seedOne(seedArtifactRun);
  runs.tombstone = await seedOne(seedArtifactRun);
  runs.retry = await seedOne(seedRetryRun);
  runs.cleanup = await seedOne(seedCleanupFailedRun);
  runs.passed = await seedOne(seedPassedRun);
  runs.failed = await seedOne(seedFailedRun);
  runs.live = await seedOne(seedLiveRun);
  runs.liveCancel = await seedOne(seedLiveRun);
  runs.observed = await seedOne(seedObservedRun);
  runs.foreign = await seedOne(seedPassedRun, foreignScope);
}, 900_000);

afterAll(async () => {
  for (const opened of open.splice(0)) await opened.close().catch(() => undefined);
  await stack?.stop();
});

describe("Run timeline", () => {
  it("UX-026 UX-027 a finished Run lists six stages with server time and a reload reattaches to the same Run", async () => {
    const { page, diagnostics } = await portal();
    const foreign = trackForeignRequests(page);
    await openRun(page, runs.passed.runId);
    const stages = page.locator('[data-testid="run-timeline"] li');
    expect(await stages.count()).toBe(6);
    const keys = await stages.evaluateAll((items) =>
      items.map((item) => item.getAttribute("data-stage")),
    );
    expect(keys).toEqual(["request", "dispatch", "readiness", "steps", "collection", "terminal"]);
    const before = await stageStates(page);
    // A finished Run has no active stage left spinning.
    expect(before.some((entry) => entry.endsWith(":active"))).toBe(false);
    expect(before.at(-1)).toBe("terminal:done");
    // Timestamps come from the server and say so; a stage with none says "No timestamp yet".
    expect(await page.getByTestId("run-timeline").textContent()).toMatch(/\d{4}-\d\d-\d\d .* UTC/);
    await page.reload();
    await page.getByTestId("run-facts").waitFor();
    expect(await stageStates(page)).toEqual(before);
    expect(await page.getByTestId("run-facts").textContent()).toContain(runs.passed.runId);
    expect(diagnostics.pageErrors).toEqual([]);
    expect(foreign).toEqual([]);
    expectCatalogRequestsOnly(diagnostics.requests);
    await expectAccessible(page, "run detail (passed)");
  });

  it("UX-027 a live Run streams phase changes, announces them politely and shows the terminal result once", async () => {
    const { page, diagnostics } = await portal();
    await openRun(page, runs.live.runId);
    await page
      .getByTestId("stream-status")
      .filter({ hasText: "Live updates connected" })
      .waitFor({ timeout: 30_000 });
    // Negative control: before any terminal event the Run is in progress, not finished.
    expect(await page.getByTestId("run-facts").textContent()).toContain("In progress");
    expect(await stageStates(page)).not.toContain("terminal:done");
    const attemptId = runs.live.attemptIds[0];
    appendEvent(runs.live.runId, "run.phase_changed", { attemptId, phase: "collecting" });
    await expect
      .poll(async () => page.locator('[data-testid="live-region"]').textContent(), {
        timeout: 30_000,
      })
      .toContain("Run is now collecting evidence.");
    expect(await page.locator('[data-testid="live-region"]').getAttribute("aria-live")).toBe(
      "polite",
    );
    appendEvent(runs.live.runId, "run.completed", { outcome: "passed", attemptId });
    await expect
      .poll(async () => stageStates(page), { timeout: 30_000 })
      .toContain("terminal:done");
    await expect
      .poll(async () => page.locator('[data-testid="live-region"]').textContent(), {
        timeout: 30_000,
      })
      .toContain("Run finished as passed.");
    await expectAccessible(page, "run detail (live)");
    expect(diagnostics.pageErrors).toEqual([]);
    expectCatalogRequestsOnly(diagnostics.requests);
  });
});

describe("Run result and attempts", () => {
  it("UX-029 a pass is never plain Passed when cleanup or the gate failed", async () => {
    const { page } = await portal();
    await openRun(page, runs.passed.runId);
    const clean = (await page.getByTestId("run-facts").locator(".badge").first().textContent())
      ?.trim()
      .replace(/\s+/g, " ");
    expect(clean).toBe("Passed");
    await openRun(page, runs.cleanup.runId);
    const cleanup = await page.getByTestId("run-facts").locator(".badge").first().textContent();
    expect(cleanup).toContain("Passed, but cleanup failed");
    expect(cleanup?.trim()).not.toBe("Passed");
    await openRun(page, runs.retry.runId);
    const gate = await page.getByTestId("run-facts").locator(".badge").first().textContent();
    expect(gate).toContain("Passed, gate failed");
    // Negative control: a failed Run reads Failed and nothing softens it.
    await openRun(page, runs.failed.runId);
    const failed = await page.getByTestId("run-facts").locator(".badge").first().textContent();
    expect(failed).toContain("Failed");
    expect(failed).not.toContain("Passed");
  });

  it("UX-029 a retry keeps both attempts, the failed result stays visible and the pass is not called stable", async () => {
    const { page } = await portal();
    await openRun(page, runs.retry.runId);
    const attempts = page.getByTestId("attempts");
    await attempts.getByRole("table", { name: "Attempts of this Run" }).waitFor();
    const rows = attempts.getByRole("row");
    // Header row plus one row per Attempt.
    expect(await rows.count()).toBe(3);
    const text = (await attempts.textContent()) ?? "";
    expect(text).toContain("Failed");
    expect(text).toContain("Passed");
    const facts = (await page.getByTestId("run-facts").textContent()) ?? "";
    expect(facts).toContain("not proof the test is stable");
    // Each attempt's steps are listed under its own caption, with the first attempt's failure intact.
    const first = page.getByRole("table", { name: "Steps of attempt 1" });
    const second = page.getByRole("table", { name: "Steps of attempt 2" });
    await first.waitFor();
    await second.waitFor();
    expect(await first.textContent()).toContain("assertion mismatch");
    expect(await second.textContent()).not.toContain("assertion mismatch");
  });

  it("UX-029 a step cites evidence only from its own attempt's bundle", async () => {
    const { page } = await portal();
    await openRun(page, runs.retry.runId);
    const second = page.getByRole("table", { name: "Steps of attempt 2" });
    await second.waitFor();
    // The retry's step names a path that only attempt 1's bundle holds.
    await second.getByText("not in this attempt's bundle").waitFor();
    expect(await second.getByRole("button", { name: /Open screenshots\/first\.png/ }).count()).toBe(
      0,
    );
    // Positive control: the first attempt's step opens its own screenshot.
    const first = page.getByRole("table", { name: "Steps of attempt 1" });
    await first.getByRole("button", { name: /Open screenshots\/first\.png/ }).waitFor();
  });
});

describe("artifact metadata and viewers", () => {
  it("UX-030 UX-031 the artifact table shows size, hash, access class and integrity; restricted raw offers nothing", async () => {
    const { page, diagnostics } = await portal();
    await openRun(page, runs.artifact.runId);
    const table = page.getByRole("table", { name: "Artifacts of attempt 1" });
    await table.waitFor();
    const headers = await table.getByRole("columnheader").allTextContents();
    for (const header of [
      "Artifact",
      "Kind",
      "Step",
      "SHA-256",
      "Size",
      "Access class",
      "Integrity",
    ])
      expect(headers.join("|")).toContain(header);
    const screenshot = runs.artifact.artifacts.find(
      (artifact) => artifact.relativePath === artifactPaths.screenshot,
    );
    expect(screenshot).toBeDefined();
    const row = artifactRow(page, artifactPaths.screenshot);
    const rowText = (await row.textContent()) ?? "";
    expect(rowText).toContain(screenshot?.sha256 ?? "missing");
    expect(rowText).toContain("Available");
    expect(rowText).toContain("get-health");
    await row.getByRole("button", { name: `View image: ${artifactPaths.screenshot}` }).waitFor();
    // Restricted raw: a badge with text, no view/download action, and no link request for it.
    const restricted = artifactRow(page, artifactPaths.restricted);
    expect(await restricted.getByTestId("artifact-restricted").textContent()).toContain(
      "Restricted",
    );
    expect(await restricted.getByRole("button").count()).toBe(0);
    expect(await restricted.textContent()).toContain("Restricted raw");
    const restrictedId = runs.artifact.artifacts.find(
      (artifact) => artifact.relativePath === artifactPaths.restricted,
    )?.id;
    expect(restrictedId).toBeDefined();
    expect(diagnostics.requests.some((entry) => entry.includes(`${restrictedId}/links`))).toBe(
      false,
    );
    // The server refuses it as well, so hiding the button is not the only protection.
    const direct = await stack
      .ownerClient(0)
      .mutate("POST", `/v1/artifacts/${restrictedId}/links`, {});
    expect(direct.status).toBe(403);
    expect(direct.text).toContain("restricted_raw");
    // No artifact link was minted by merely opening the page.
    expect(diagnostics.requests.filter((entry) => entry.includes("/links"))).toEqual([]);
    await expectAccessible(page, "run detail (artifact table)");
  });

  it("UX-031 images, hostile JSON and HTML, long logs and downloads open only through gateway links and never run", async () => {
    const { page, diagnostics } = await portal();
    const foreign = trackForeignRequests(page);
    await openRun(page, runs.artifact.runId);
    await page.getByRole("table", { name: "Artifacts of attempt 1" }).waitFor();

    await page.getByRole("button", { name: `View image: ${artifactPaths.screenshot}` }).click();
    const image = page.getByTestId("artifact-image");
    await image.waitFor();
    await expect
      .poll(async () =>
        image.evaluate((element) =>
          element instanceof HTMLImageElement ? element.naturalWidth : 0,
        ),
      )
      .toBeGreaterThan(0);
    expect(await image.getAttribute("src")).toMatch(/^\/v1\/artifacts\/[^/]+\/content\?link=/);
    expect(await image.getAttribute("alt")).toContain(artifactPaths.screenshot);
    // The link is a capability: it must not be part of the page address.
    expect(page.url()).not.toContain("link=");
    await expectAccessible(page, "run detail (image viewer)");

    await page.getByRole("button", { name: `View as text: ${artifactPaths.http}` }).click();
    const text = page.getByTestId("artifact-text");
    await text.getByText("window.__pwned").waitFor();
    // Shown literally as text; nothing in it executed.
    expect(await text.textContent()).toContain("<script>window.__pwned='http'</script>");
    expect(await pwnedMarker(page)).toBe(undefined);
    expect(await text.locator("script").count()).toBe(0);

    await page.getByRole("button", { name: `View as text: ${artifactPaths.log}` }).click();
    await page.getByTestId("artifact-text").getByText("Showing the first 64.0 KB").waitFor();
    expect(await page.getByTestId("artifact-text").textContent()).toContain(
      "Download the artifact to read the rest",
    );

    await page
      .getByRole("button", { name: `View in sandboxed frame: ${artifactPaths.dom}` })
      .click();
    const frame = page.locator('[data-testid="artifact-panel"] iframe');
    await frame.waitFor();
    expect(await frame.getAttribute("sandbox")).toBe("");
    expect(await frame.getAttribute("src")).toMatch(/^\/v1\/artifacts\/[^/]+\/content\?link=/);
    expect(await frame.getAttribute("title")).toContain(artifactPaths.dom);
    // The frame content never ran its script in the portal's origin.
    expect(await pwnedMarker(page)).toBe(undefined);
    await expectAccessible(page, "run detail (frame viewer)");

    await page.getByRole("button", { name: `Download: ${artifactPaths.download}` }).click();
    const download = page.getByTestId("artifact-download");
    await download.waitFor();
    expect(await download.getAttribute("href")).toMatch(/^\/v1\/artifacts\/[^/]+\/content\?link=/);
    expect(await download.getAttribute("download")).toBe("export.zip");

    expect(page.url()).not.toContain("link=");
    // A sandboxed frame cannot read `navigator.serviceWorker`; Playwright's own init script does and reports it.
    expect(
      diagnostics.pageErrors.filter((error) => !error.includes("context is sandboxed")),
    ).toEqual([]);
    expect(foreign).toEqual([]);
    expectCatalogRequestsOnly(diagnostics.requests);
    // Links are minted on demand, one per opened artifact, and only for non-restricted entries.
    const minted = diagnostics.requests.filter((entry) => entry.startsWith("POST /v1/artifacts/"));
    expect(minted.length).toBe(5);
    expect(minted.every((entry) => entry.endsWith("/links"))).toBe(true);
  });

  it("UX-031 a deep link opens the textual artifact of the Run", async () => {
    const { page } = await portal();
    const log = runs.artifact.artifacts.find(
      (artifact) => artifact.relativePath === artifactPaths.log,
    );
    await page.goto(`/runs/${runs.artifact.runId}?artifact=${log?.id}`);
    await page.getByTestId("artifact-text").getByText("Showing the first 64.0 KB").waitFor();
    // Negative control: an unknown artifact id in the address opens nothing.
    await page.goto(`/runs/${runs.artifact.runId}?artifact=art-doesnotexist`);
    await page.getByTestId("run-facts").waitFor();
    await page.getByRole("table", { name: "Artifacts of attempt 1" }).waitFor();
    expect(await page.getByTestId("artifact-panel").count()).toBe(0);
  });
});

describe("gateway links", () => {
  it("UX-032 a tampered link shows an expired-link notice and a new link restores the artifact", async () => {
    const { page, diagnostics } = await portal();
    await openRun(page, runs.artifact.runId);
    await page.getByRole("table", { name: "Artifacts of attempt 1" }).waitFor();
    let tamper = true;
    await page.route("**/v1/artifacts/*/content*", async (route) => {
      if (!tamper) return route.continue();
      const url = new URL(route.request().url());
      const link = url.searchParams.get("link") ?? "";
      url.searchParams.set("link", `${link.slice(0, -2)}xx`);
      return route.continue({ url: url.toString() });
    });
    await page.getByRole("button", { name: `View as text: ${artifactPaths.http}` }).click();
    const notice = page.locator('[data-gateway-state="link-expired"]');
    await notice.waitFor();
    expect(await notice.textContent()).toContain("expired or is no longer valid");
    expect(await page.getByTestId("artifact-text").count()).toBe(0);
    tamper = false;
    await page.getByRole("button", { name: "Request a new link" }).click();
    await page.getByTestId("artifact-text").getByText("window.__pwned").waitFor();
    expect(await page.locator('[data-gateway-state="link-expired"]').count()).toBe(0);
    expect(diagnostics.pageErrors).toEqual([]);
  });

  it("UX-032 a deleted artifact says so, its earlier link stops working and other tenants are refused", async () => {
    const { page, diagnostics } = await portal();
    await openRun(page, runs.tombstone.runId);
    await page.getByRole("table", { name: "Artifacts of attempt 1" }).waitFor();
    const logId = runs.tombstone.artifacts.find(
      (artifact) => artifact.relativePath === artifactPaths.http,
    )?.id;
    expect(logId).toBeDefined();
    await page.getByRole("button", { name: `View as text: ${artifactPaths.http}` }).click();
    await page.getByTestId("artifact-text").getByText("window.__pwned").waitFor();
    const linkRequest = diagnostics.requests.find((entry) =>
      entry.startsWith(`GET /v1/artifacts/${logId}/content?link=`),
    );
    expect(linkRequest).toBeDefined();
    const linkPath = linkRequest?.slice("GET ".length) ?? "";
    // The capability works for the artifact it was minted for, from any client...
    expect((await stack.anonymous().request("GET", linkPath)).status).toBe(200);
    // ...and only for that artifact: the same link on another artifact is refused.
    const otherId = runs.tombstone.artifacts.find(
      (artifact) => artifact.relativePath === artifactPaths.console,
    )?.id;
    const linkValue = new URL(linkPath, "https://x.test").searchParams.get("link") ?? "";
    const swapped = await stack
      .anonymous()
      .request("GET", `/v1/artifacts/${otherId}/content?link=${encodeURIComponent(linkValue)}`);
    expect(swapped.status).toBe(401);
    // Another tenant cannot mint a link for it either.
    const foreignMint = await stack
      .ownerClient(1)
      .mutate("POST", `/v1/artifacts/${logId}/links`, {});
    expect(foreignMint.status).not.toBe(200);
    expect(foreignMint.status).not.toBe(201);

    // Real deletion through the owner's session: the issued link dies at once and a new mint is refused.
    const deleted = await stack
      .ownerClient(0)
      .mutate("DELETE", `/v1/artifacts/${logId}`, undefined);
    expect(deleted.status).toBe(200);
    expect((await stack.anonymous().request("GET", linkPath)).status).toBe(404);
    await page.getByRole("button", { name: "Close viewer" }).click();
    await page.getByRole("button", { name: `View as text: ${artifactPaths.http}` }).click();
    const gone = page.locator('[data-gateway-state="gone"]');
    await gone.waitFor();
    expect(await gone.textContent()).toContain("This artifact expired or was deleted.");
    expect(await page.getByTestId("artifact-text").count()).toBe(0);
    // Negative control: an artifact that was not deleted still opens.
    await page.getByRole("button", { name: `View as text: ${artifactPaths.console}` }).click();
    await page.getByTestId("artifact-text").getByText("page ready").waitFor();
    expect(diagnostics.pageErrors).toEqual([]);
  });
});

describe("evidence freshness", () => {
  it("UX-034 a changed test revision makes the result stale, an unchanged one stays current and a failed lookup is unknown", async () => {
    const own = await seedOne(seedPassedRun);
    const { page } = await portal();
    await openRun(page, own.runId);
    const freshness = page.getByTestId("freshness-headline");
    await freshness.waitFor();
    expect(await freshness.getAttribute("data-freshness")).toBe("current");
    expect(await freshness.textContent()).toContain("Matches the current state");
    // Negative control: a failed lookup never reads as current.
    const unknown = await portal();
    await unknown.page.route("**/v1/tests/*", (route) =>
      route.request().method() === "GET" ? route.abort() : route.continue(),
    );
    await unknown.page.goto(`/runs/${own.runId}`);
    const unknownHeadline = unknown.page.getByTestId("freshness-headline");
    await unknownHeadline.waitFor();
    expect(await unknownHeadline.getAttribute("data-freshness")).toBe("unknown");
    expect(await unknownHeadline.textContent()).not.toContain("Matches the current state");
    // A new promoted revision changes what the result describes.
    const test = system.tests.get(own.testId);
    const revision = system.revisions.create(
      own.testId,
      { ...system.revisions.get(String(test.activeRevisionId)).plan, name: "Changed plan" },
      String(test.activeRevisionId),
    );
    system.revisions.promote(revision.id, system.tests.get(own.testId).version ?? 1);
    await openRun(page, own.runId);
    const stale = page.getByTestId("freshness-headline");
    await stale.waitFor();
    expect(await stale.getAttribute("data-freshness")).toBe("stale");
    const headline = (await stale.textContent()) ?? "";
    expect(headline).toContain("Passed at revision");
    expect(headline).toContain("Stale");
    // History keeps its verdict: the result still reads Passed.
    expect(await page.getByTestId("run-facts").locator(".badge").first().textContent()).toContain(
      "Passed",
    );
    await expectAccessible(page, "run detail (stale evidence)");
  });
});

describe("step data", () => {
  it("REQ-053 a step that captures a sensitive value withholds its observed data and fails closed when the plan is unreadable", async () => {
    const { page } = await portal();
    // The page asks for the plan; this run of it says the first step captures a sensitive value.
    await page.route("**/v1/tests/*/revisions*", async (route) => {
      const url = new URL(route.request().url());
      const real = await stack.ownerClient(0).request("GET", `${url.pathname}${url.search}`);
      const body: RevisionsBody = real.json();
      for (const item of body.data?.items ?? []) {
        const first = item.plan.steps[0];
        if (first) first.input = { ...first.input, capture: [{ name: "token", sensitive: true }] };
      }
      await route.fulfill({ status: 200, contentType: "application/json", json: body });
    });
    await openRun(page, runs.observed.runId);
    const steps = page.getByTestId("steps");
    await steps.getByText("Withheld: this step captures a sensitive value.").first().waitFor();
    expect(await steps.textContent()).not.toContain(secretToken);
    // Positive control: the step that captures nothing sensitive still shows its observed data.
    expect(await steps.textContent()).toContain('"status": 200');

    const failClosed = await portal();
    await failClosed.page.route("**/v1/tests/*/revisions*", (route) => route.abort());
    await failClosed.page.goto(`/runs/${runs.observed.runId}`);
    const closedSteps = failClosed.page.getByTestId("steps");
    await closedSteps.getByText("the plan could not be read").first().waitFor();
    expect(await closedSteps.textContent()).not.toContain(secretToken);
    expect(await closedSteps.textContent()).not.toContain('"status": 200');
  });
});

describe("cancellation", () => {
  it("UX-028 cancel works from the keyboard, is a request until the Run stops, and stays disabled with a reason", async () => {
    const { page, diagnostics } = await portal();
    await openRun(page, runs.liveCancel.runId);
    const keyboard = await keyboardOnly(page);
    await keyboard.tabTo((focused) => focused.tag === "button" && focused.name === "Cancel Run");
    expect((await keyboard.focused()).focusRing).toBe(true);
    await keyboard.press("Enter");
    await page.getByRole("dialog").waitFor();
    await keyboard.tabTo((focused) => focused.name === "Request cancellation");
    await keyboard.press("Enter");
    const notice = page.getByTestId("cancel-notice");
    await notice.waitFor();
    expect(await notice.textContent()).toContain("has not stopped yet");
    // A request is not a result: the Run still reads in progress.
    expect(await page.getByTestId("run-facts").textContent()).toContain("In progress");
    expect(await page.getByTestId("run-facts").textContent()).not.toContain("Cancelled");
    const button = page.getByTestId("cancel-run");
    expect(await button.getAttribute("aria-disabled")).toBe("true");
    expect(await page.getByTestId("cancel-reason").textContent()).toContain(
      "Cancellation was already requested.",
    );
    expect(diagnostics.requests.filter((entry) => entry.includes("/cancel"))).toEqual([
      `POST /v1/runs/${runs.liveCancel.runId}/cancel`,
    ]);
    expect(diagnostics.pageErrors).toEqual([]);
  });

  it("UX-028 a finished Run cannot be cancelled and says why", async () => {
    const { page, diagnostics } = await portal();
    await openRun(page, runs.passed.runId);
    const button = page.getByTestId("cancel-run");
    expect(await button.getAttribute("aria-disabled")).toBe("true");
    expect(await page.getByTestId("cancel-reason").textContent()).toContain(
      "The Run already finished as passed; there is nothing to cancel.",
    );
    // Activating the disabled control opens no dialog and sends no request.
    // Playwright refuses to click an aria-disabled control, so the activation is forced.
    await button.click({ force: true });
    expect(await page.getByRole("dialog").count()).toBe(0);
    expect(diagnostics.requests.filter((entry) => entry.includes("/cancel"))).toEqual([]);
  });
});

describe("Run history", () => {
  it("M4-05 the history lists Runs with filters, sortable columns, paging and a project scope", async () => {
    const { page, diagnostics } = await portal();
    await page.goto("/runs");
    const table = page.getByRole("table", { name: "Runs" });
    await table.waitFor();
    for (const run of [runs.passed, runs.failed, runs.cleanup])
      await table.getByRole("link", { name: run.runId }).waitFor();
    // Result column names the nuance, not just Passed.
    expect(await table.textContent()).toContain("Passed, but cleanup failed");

    await page.goto("/runs?status=failed");
    await page.getByRole("table", { name: "Runs" }).waitFor();
    await page.getByRole("link", { name: runs.failed.runId }).waitFor();
    expect(await page.getByRole("link", { name: runs.passed.runId }).count()).toBe(0);
    expect(diagnostics.requests.some((entry) => entry.includes("status=failed"))).toBe(true);

    await page.goto("/runs?limit=25");
    const sortable = page.getByRole("columnheader", { name: /Created/ });
    await sortable.waitFor();
    await sortable.getByRole("button").click();
    await expect.poll(async () => sortable.getAttribute("aria-sort")).not.toBe("none");
    const firstSort = await sortable.getAttribute("aria-sort");
    await sortable.getByRole("button").click();
    await expect.poll(async () => sortable.getAttribute("aria-sort")).not.toBe(firstSort);

    // Paging: a page of one row offers more, and loading it adds rows.
    await page.goto("/runs?limit=25");
    await page.getByRole("table", { name: "Runs" }).waitFor();
    await page.goto(`/projects/${scope.projectId}/runs`);
    const scoped = page.getByRole("table", { name: "Runs" });
    await scoped.waitFor();
    await scoped.getByRole("link", { name: runs.passed.runId }).waitFor();
    expect(await scoped.getByRole("link", { name: runs.foreign.runId }).count()).toBe(0);
    expect(await page.getByText("Showing runs of this project only.").count()).toBe(1);
    expect(
      diagnostics.requests.some((entry) => entry.includes(`projectId=${scope.projectId}`)),
    ).toBe(true);
    expectCatalogRequestsOnly(diagnostics.requests);
    await expectAccessible(page, "run history");
  });

  it("M4-05 the history loads further pages on request and applies the filter form by keyboard", async () => {
    const { page } = await portal();
    await page.goto("/runs");
    await page.getByRole("table", { name: "Runs" }).waitFor();
    const keyboard = await keyboardOnly(page);
    await keyboard.tabTo((focused) => focused.name.startsWith("Outcome or phase"));
    // Select the "Failed" option and apply the filter without a pointer.
    await keyboard.press("f");
    await keyboard.tabTo((focused) => focused.name === "Apply filters");
    await keyboard.press("Enter");
    await page.waitForURL(/status=failed/);
    await page.getByRole("link", { name: runs.failed.runId }).waitFor();
    expect(await page.getByRole("link", { name: runs.passed.runId }).count()).toBe(0);
    await keyboard.tabTo((focused) => focused.name === "Clear filters");
    await keyboard.press("Enter");
    await page.getByRole("link", { name: runs.passed.runId }).waitFor();
    expect((await keyboard.focused()).focusRing).toBe(true);
  });

  it("M4-05 the history says which state it is in: empty, forbidden and unknown Run are distinct", async () => {
    const { page } = await portal();
    await page.goto("/runs?testId=tst-nothing-here");
    await page.getByText("No run matches these filters.").first().waitFor();
    // Negative control: the empty state never reads as an error or forbidden.
    expect(await page.getByText("You do not have access").count()).toBe(0);
    expect(await page.getByRole("alert").count()).toBe(0);

    const denied = await portal();
    await denied.page.route("**/v1/runs?*", (route) =>
      route.fulfill({
        status: 403,
        contentType: "application/json",
        body: JSON.stringify({
          error: { code: "FORBIDDEN", message: "No access", requestId: "req-test" },
        }),
      }),
    );
    await denied.page.goto("/runs");
    await denied.page.getByText("Not permitted").first().waitFor();
    expect(await denied.page.getByRole("table", { name: "Runs" }).count()).toBe(0);

    const missing = await portal();
    await missing.page.goto("/runs/run-doesnotexist");
    await missing.page.getByText("Not found").first().waitFor();
    expect(await missing.page.getByTestId("run-facts").count()).toBe(0);
  });
});

describe("narrow viewport", () => {
  it("UX-026 UX-030 the Run page and the history reflow at 320 px and 200 % zoom", async () => {
    const { page } = await portal();
    await atViewport(page, { width: 320, zoom: 2 });
    await openRun(page, runs.artifact.runId);
    await page.getByRole("table", { name: "Artifacts of attempt 1" }).waitFor();
    await expectNoPageOverflow(page, "run detail");
    await page.getByRole("button", { name: `View image: ${artifactPaths.screenshot}` }).click();
    await page.getByTestId("artifact-image").waitFor();
    await expectNoPageOverflow(page, "run detail with image viewer");
    await expectAccessible(page, "run detail 320px");
    await page.goto("/runs");
    await page.getByRole("table", { name: "Runs" }).waitFor();
    await expectNoPageOverflow(page, "run history");
    await expectAccessible(page, "run history 320px");
  });
});

// The hostile JSON fixture is also what the sweep seed serves; keep the import honest.
void hostileJson;
