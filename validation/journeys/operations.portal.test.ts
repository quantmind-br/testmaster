import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Page } from "playwright-core";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eventually } from "./harness.js";
import { createIncident, seedDeadLetter, seedFiringAlerts } from "./operations-support.js";
import {
  type BrowserDiagnostics,
  expectAccessible,
  keyboardOnly,
  type OpenPortal,
  openPortal,
} from "./portal.js";
import { type ServerStack, type StackUser, startServerStack } from "./server-stack.js";
import type { HttpsClient } from "./tls-proxy.js";

/**
 * The operations pages (M4-02, UX-003) against the real server profile: PostgreSQL, a server and
 * a worker as child processes, a TLS proxy and Chromium. Alerts and the dead-letter entry are
 * seeded through the controller-scoped Application on the same database, everything else goes
 * through the portal and is verified through the public API and the audit log.
 */
let stack: ServerStack;
let backupDirectory = "";
let viewer: StackUser;
let orgAdmin: StackUser;
let runnerToken = "";
const open: OpenPortal[] = [];

beforeAll(async () => {
  backupDirectory = await mkdtemp(join(tmpdir(), "tm-ops-ui-backups-"));
  stack = await startServerStack({
    worker: true,
    config: { backup: { destination: backupDirectory, allowSharedAccess: true } },
  });
  viewer = await stack.addMember("viewer");
  orgAdmin = await stack.addMember("org_admin");
  const runner = await stack.addMember("runner");
  runnerToken = await stack.issueToken(runner.principalId, ["R", "X"]);
}, 600_000);

afterAll(async () => {
  for (const portal of open.splice(0)) await portal.close().catch(() => undefined);
  await stack?.stop();
  await rm(backupDirectory, { recursive: true, force: true });
});

async function portal(user: { login: string; password: string }): Promise<OpenPortal> {
  const opened = await openPortal(
    { baseUrl: stack.baseUrl, spkiSha256: stack.ca.spkiSha256 },
    user,
  );
  open.push(opened);
  return opened;
}

async function signedIn(user: StackUser): Promise<HttpsClient> {
  const client = stack.anonymous();
  const login = await client.request("POST", "/v1/identity/login", {
    body: { principal: user.login, password: user.password },
    headers: { origin: stack.baseUrl, "idempotency-key": randomUUID() },
  });
  expect(login.status).toBe(200);
  client.csrfToken = login.json<{ data: { csrfToken: string } }>().data.csrfToken;
  return client;
}

interface ErrorBody {
  error: { code: string; message: string; details: { reasonCode?: string } };
}

/** Admits a Run with a member's bearer token; the ids are well-formed but belong to nothing. */
async function admitRun() {
  return stack.anonymous().request("POST", "/v1/runs", {
    body: {
      testId: `tst_${randomUUID()}`,
      environmentId: `env_${randomUUID()}`,
      mode: "replay",
      healingPolicy: "off",
      origin: "api",
    },
    headers: {
      authorization: `Bearer ${runnerToken}`,
      origin: stack.baseUrl,
      "idempotency-key": randomUUID(),
    },
    cookies: false,
  });
}

async function auditActions(
  like: string,
): Promise<{ action: string; resource_id: string; actor: string }[]> {
  const scope = await stack.scope();
  return scope.database.all<{ action: string; resource_id: string; actor: string }>(
    "SELECT action,resource_id,actor FROM audit_events WHERE workspace_id=? AND action LIKE ? ORDER BY created_at",
    stack.workspaceId,
    like,
  );
}

async function ownerData<T>(path: string): Promise<T> {
  const response = await stack.ownerClient().request("GET", path);
  expect(response.status, `${path}: ${response.text}`).toBe(200);
  return response.json<{ data: T }>().data;
}

const catalogPaths = [
  /^\/v1\/me$/,
  /^\/v1\/operations(\/(status|slo|dlq|dlq\/requeue|admission|backups|isolation\/release))?$/,
  /^\/v1\/alerts$/,
  /^\/v1\/alerts\/alr_[0-9a-f-]+\/acknowledge$/,
  /^\/v1\/alert-rules$/,
  /^\/v1\/incidents$/,
  /^\/v1\/incidents\/inr_[0-9a-f-]+(\/(events|close))?$/,
  /^\/v1\/identity\/(login|logout)$/,
  /^\/v1\/projects$/,
];

/** The portal has no private endpoints: every API call it made is a catalog `/v1` route. */
function expectCatalogOnly(diagnostics: BrowserDiagnostics): void {
  const api = diagnostics.requests
    .map((entry) => entry.split(" ")[1] ?? "")
    .map((path) => path.split("?")[0] ?? "")
    .filter((path) => path.startsWith("/v1/") || path.startsWith("/mcp"));
  expect(api.length).toBeGreaterThan(0);
  const stray = api.filter((path) => !catalogPaths.some((pattern) => pattern.test(path)));
  expect(stray, "non-catalog API paths requested by the portal").toEqual([]);
}

const posts = (diagnostics: BrowserDiagnostics, path: string): number =>
  diagnostics.requests.filter((entry) => entry === `POST ${path}`).length;

async function waitForHeading(page: Page, name: string): Promise<void> {
  await page.getByRole("heading", { level: 1, name }).waitFor();
}

/** The visible reason text a guarded control points at through `aria-describedby`. */
async function describedReason(page: Page, accessibleName: string): Promise<string> {
  const button = page.getByRole("button", { name: accessibleName, exact: true });
  await button.waitFor();
  expect(await button.getAttribute("aria-disabled"), `${accessibleName} is disabled`).toBe("true");
  const reasonId = await button.getAttribute("aria-describedby");
  expect(reasonId, `${accessibleName} names its reason`).toBeTruthy();
  return (await page.locator(`[id="${reasonId}"]`).innerText()).replace(/\s+/g, " ");
}

describe("operations pages on the server profile", () => {
  it("M4-02 UX-003 operations status page is accessible, keyboard operable and requests an audited backup", async () => {
    const { page, diagnostics } = await portal(stack.owner);
    await page.goto("/operations");
    await waitForHeading(page, "Operations");
    for (const heading of [
      "Run admission",
      "Restore isolation",
      "Work in flight",
      "Backups",
      "Retention",
      "Recent operations",
    ])
      await page.getByRole("heading", { level: 2, name: heading }).waitFor();
    expect(await page.locator("h1").count()).toBe(1);
    expect(await page.locator("main").count()).toBe(1);

    // The status the server reports, rendered as text plus shape.
    const admission = page.getByTestId("ops-admission");
    expect(await admission.innerText()).toContain("Enabled");
    expect(await admission.locator("svg[data-shape]").count()).toBeGreaterThan(0);
    const backups = page.getByTestId("ops-backup");
    expect(await backups.innerText()).toContain("Backups configured");
    expect(await backups.innerText()).toContain("No successful backup recorded");
    expect(await page.getByTestId("ops-isolation").innerText()).toContain("Not isolated");
    expect(
      await page.getByRole("heading", { name: "Work in flight" }).locator("xpath=..").innerText(),
    ).toContain("Active Runs");

    // The navigation section named in the task, one entry per page.
    const operationsNav = page.getByRole("navigation", { name: "Primary" }).getByRole("region", {
      name: "Operations",
    });
    expect(await operationsNav.getByRole("link").allInnerTexts()).toEqual([
      "Operations status",
      "Dead-letter queue",
      "Alerts",
      "SLO indicators",
      "Incidents",
    ]);

    // Negative control: "resume" is unavailable while admission is already enabled, with the reason.
    expect(await describedReason(page, "Resume admission")).toContain(
      "Admission is already enabled.",
    );
    await expectAccessible(page, "operations status");

    const keyboard = await keyboardOnly(page);
    // Negative control: requesting a backup without a reason is refused before any request is made.
    await keyboard.tabTo((element) => element.name === "Request backup");
    expect((await keyboard.focused()).focusRing).toBe(true);
    await keyboard.press("Enter");
    const summary = page.getByTestId("error-summary");
    await summary.waitFor();
    expect(await summary.innerText()).toContain("Enter the reason for this action.");
    expect(await page.locator("#ops-backup-reason").getAttribute("aria-invalid")).toBe("true");
    expect(await page.locator("#ops-backup-reason").getAttribute("aria-describedby")).toContain(
      "error",
    );
    expect(posts(diagnostics, "/v1/operations/backups")).toBe(0);
    expect(await page.getByRole("dialog").count()).toBe(0);

    // Positive control: with a reason the same keyboard path opens a confirmation, then requests it.
    await keyboard.tabTo((element) => element.id === "ops-backup-reason");
    await keyboard.type("Pre-upgrade backup");
    await keyboard.press("Tab");
    expect((await keyboard.focused()).name).toBe("Request backup");
    await keyboard.press("Enter");
    const dialog = page.getByRole("dialog", { name: "Request a backup now?" });
    await dialog.waitFor();
    expect(await dialog.innerText()).toContain("Pre-upgrade backup");
    await expectAccessible(page, "operations backup confirmation");
    await keyboard.press("Tab");
    expect((await keyboard.focused()).name).toBe("Confirm backup request");
    await keyboard.press("Enter");
    await backups.getByTestId("notice").waitFor();
    expect(await backups.getByTestId("notice").innerText()).toContain("Backup requested");
    await page.waitForFunction(() =>
      document
        .querySelector('[data-testid="live-region"]')
        ?.textContent?.includes("Backup requested"),
    );
    const row = page.getByRole("row", { name: /Backup.*Requested.*Pre-upgrade backup/ });
    await row.waitFor();
    expect(posts(diagnostics, "/v1/operations/backups")).toBe(1);

    const operations = await ownerData<{
      items: { kind: string; state: string; reason: string }[];
    }>("/v1/operations");
    expect(operations.items).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: "backup",
          state: "requested",
          reason: "Pre-upgrade backup",
        }),
      ]),
    );
    expect((await auditActions("ops.backup.request%")).map((entry) => entry.actor)).toContain(
      stack.owner.principalId,
    );

    await keyboard.assertNoPointerUsed();
    expect(diagnostics.pageErrors).toEqual([]);
    expect(diagnostics.console).toEqual([]);
    expectCatalogOnly(diagnostics);
  });

  it("M4-02 admin pauses and resumes admission from the portal and a new run is refused while paused", async () => {
    const { page, diagnostics } = await portal(stack.owner);
    await page.goto("/operations");
    await waitForHeading(page, "Operations");
    const panel = page.getByTestId("ops-admission");

    // Negative control: no reason, no confirmation, no request.
    await page.getByRole("button", { name: "Pause admission", exact: true }).click();
    await page.getByTestId("error-summary").waitFor();
    expect(await panel.innerText()).toContain("Enter the reason for this action.");
    expect(posts(diagnostics, "/v1/operations/admission")).toBe(0);

    // Cancelling the confirmation sends nothing either.
    await page.locator("#ops-admission-reason").fill("Maintenance window");
    await page.getByRole("button", { name: "Pause admission", exact: true }).click();
    const dialog = page.getByRole("dialog", { name: "Pause Run admission?" });
    await dialog.waitFor();
    const context = await dialog.innerText();
    expect(context).toContain("Maintenance window");
    expect(context).toContain("Current state");
    await dialog.getByRole("button", { name: "Cancel" }).click();
    await dialog.waitFor({ state: "hidden" });
    expect(posts(diagnostics, "/v1/operations/admission")).toBe(0);
    expect(
      (await ownerData<{ admission: { state: string } }>("/v1/operations/status")).admission.state,
    ).toBe("enabled");

    // Control before the change: a member's Run request is not refused by admission.
    const before = await eventually(
      async () => {
        const response = await admitRun();
        return { status: response.status, body: response.json<ErrorBody>() };
      },
      (outcome) => outcome.body.error?.message !== "No live worker; start a worker or use --wait",
      90_000,
    );
    expect(before.body.error.details.reasonCode).not.toBe("admission_paused");

    // Positive: confirm the pause.
    await page.getByRole("button", { name: "Pause admission", exact: true }).click();
    await dialog.waitFor();
    await expectAccessible(page, "operations pause confirmation");
    await dialog.getByRole("button", { name: "Confirm pause" }).click();
    await panel.getByTestId("notice").waitFor();
    expect(await panel.getByTestId("notice").innerText()).toContain("Admission paused.");
    await page.waitForFunction(() =>
      document
        .querySelector('[data-testid="live-region"]')
        ?.textContent?.includes("Admission paused."),
    );
    expect(posts(diagnostics, "/v1/operations/admission")).toBe(1);
    expect(await panel.innerText()).toContain("Paused");
    expect(await panel.innerText()).toContain("Maintenance window");
    expect(await describedReason(page, "Pause admission")).toContain(
      "Admission is already paused.",
    );
    expect(
      await page
        .getByRole("button", { name: "Resume admission", exact: true })
        .getAttribute("aria-disabled"),
    ).toBeNull();

    const status = await ownerData<{
      admission: { state: string; reason: string; changedBy: string };
    }>("/v1/operations/status");
    expect(status.admission).toMatchObject({
      state: "paused",
      reason: "Maintenance window",
      changedBy: stack.owner.principalId,
    });
    const refused = await admitRun();
    expect(refused.status).toBeGreaterThanOrEqual(400);
    const refusal = refused.json<ErrorBody>().error;
    expect(refusal.code).toBe("PRECONDITION_FAILED");
    expect(refusal.details.reasonCode).toBe("admission_paused");

    // The paused state survives a reload (it is server state, not page state).
    await page.reload();
    await waitForHeading(page, "Operations");
    expect(await page.getByTestId("ops-admission").innerText()).toContain("Paused");

    // Resume: the Run request is no longer refused by admission.
    await page.locator("#ops-admission-reason").fill("Maintenance finished");
    await page.getByRole("button", { name: "Resume admission", exact: true }).click();
    await page
      .getByRole("dialog", { name: "Resume Run admission?" })
      .getByRole("button", { name: "Confirm resume" })
      .click();
    await page.getByTestId("ops-admission").getByTestId("notice").waitFor();
    expect(await page.getByTestId("ops-admission").innerText()).toContain("Enabled");
    const resumed = await admitRun();
    expect(resumed.json<ErrorBody>().error.details.reasonCode).not.toBe("admission_paused");

    const actions = (await auditActions("ops.admission.%")).map((entry) => entry.action);
    expect(actions).toEqual(["ops.admission.pause.allowed", "ops.admission.resume.allowed"]);
    const table = page.getByRole("table", { name: "Recent administrative operations" });
    await table.getByRole("row", { name: /Admission.*Completed.*Maintenance window/ }).waitFor();
    await table.getByRole("row", { name: /Admission.*Completed.*Maintenance finished/ }).waitFor();
    expect(diagnostics.pageErrors).toEqual([]);
    expectCatalogOnly(diagnostics);
  });

  it("M4-02 alert acknowledge and DLQ requeue are visible and audited", async () => {
    await seedFiringAlerts(stack);
    const liveId = await seedDeadLetter(stack);
    const { page, diagnostics } = await portal(stack.owner);

    // Alerts: filter in the URL, acknowledge, and the acknowledged state afterwards.
    await page.goto("/operations/alerts?state=firing");
    await waitForHeading(page, "Alerts");
    const firingBefore = (
      await ownerData<{ items: { id: string; rule: string }[] }>("/v1/alerts?state=firing")
    ).items;
    expect(firingBefore.length).toBeGreaterThan(0);
    const alertsTable = page.getByRole("table", { name: "Alerts (firing)" });
    await alertsTable.waitFor();
    expect(await alertsTable.locator("tbody tr").count()).toBe(firingBefore.length);
    expect(await page.getByLabel("State", { exact: true }).inputValue()).toBe("firing");
    expect(await alertsTable.innerText()).toMatch(/Critical/);
    await expectAccessible(page, "operations alerts");

    const first = firingBefore[0];
    if (!first) throw new Error("no firing alert was seeded");
    await page
      .getByRole("button", { name: `Acknowledge ${first.rule}` })
      .first()
      .click();
    await page.getByTestId("notice").waitFor();
    expect(await page.getByTestId("notice").innerText()).toContain(
      `Acknowledged alert ${first.rule}.`,
    );
    expect(
      diagnostics.requests.some((entry) =>
        /^POST \/v1\/alerts\/alr_[0-9a-f-]+\/acknowledge$/.test(entry),
      ),
    ).toBe(true);
    const firingAfter = (await ownerData<{ items: { id: string }[] }>("/v1/alerts?state=firing"))
      .items;
    expect(firingAfter.length).toBe(firingBefore.length - 1);
    const acknowledgedId = firingBefore
      .map((alert) => alert.id)
      .find((id) => !firingAfter.some((alert) => alert.id === id));
    expect(acknowledgedId).toBeTruthy();
    const acknowledged = await ownerData<{
      items: { id: string; acknowledgedBy: string; state: string }[];
    }>("/v1/alerts?state=acknowledged");
    expect(acknowledged.items).toEqual([
      expect.objectContaining({
        id: acknowledgedId,
        state: "acknowledged",
        acknowledgedBy: stack.owner.principalId,
      }),
    ]);

    // The filter is part of the address: switching it rewrites the URL and the table.
    await page.getByLabel("State", { exact: true }).selectOption("acknowledged");
    await page.waitForURL((url) => url.searchParams.get("state") === "acknowledged");
    const acknowledgedTable = page.getByRole("table", { name: "Alerts (acknowledged)" });
    await acknowledgedTable.waitFor();
    expect(await acknowledgedTable.locator("tbody tr").count()).toBe(1);
    expect(await acknowledgedTable.innerText()).toContain("Acknowledged by");
    await page.reload();
    expect(await page.getByLabel("State", { exact: true }).inputValue()).toBe("acknowledged");
    // Negative control: acknowledging it again is refused by the server, not just hidden in the UI.
    const again = await stack
      .ownerClient()
      .mutate("POST", `/v1/alerts/${acknowledgedId}/acknowledge`, {});
    expect(again.status).toBeGreaterThanOrEqual(400);
    expect(again.json<ErrorBody>().error.code).toBe("PRECONDITION_FAILED");
    expect((await auditActions("alert.acknowledge.%")).map((entry) => entry.resource_id)).toEqual([
      acknowledgedId,
    ]);

    // Every rule shows who owns it and where its runbook is.
    const rules = (
      await ownerData<{ items: { id: string; owner: string; runbook: string }[] }>(
        "/v1/alert-rules",
      )
    ).items;
    const rulesTable = page.getByRole("table", { name: "Alert rules" });
    await rulesTable.waitFor();
    expect(await rulesTable.locator("tbody tr").count()).toBe(rules.length);
    for (const rule of rules) {
      expect(rule.owner).not.toBe("");
      expect(rule.runbook).not.toBe("");
      const ruleRow = rulesTable.getByRole("row").filter({ hasText: rule.id });
      expect(await ruleRow.innerText()).toContain(rule.owner);
      expect(await ruleRow.innerText()).toContain(rule.runbook);
    }

    // Dead-letter queue: cancel sends nothing, a stale entry is refused inline, a live one requeues.
    const racedId = await seedDeadLetter(stack);
    await page.goto("/operations/dlq");
    await waitForHeading(page, "Dead-letter queue");
    const dlqTable = page.getByRole("table", { name: "Dead-lettered entries" });
    await dlqTable.waitFor();
    expect(await dlqTable.locator("tbody tr").count()).toBe(2);
    expect(await dlqTable.innerText()).toContain(liveId);
    expect(await dlqTable.innerText()).toContain("Auxiliary");
    await expectAccessible(page, "operations dead-letter queue");

    await page.getByRole("button", { name: `Requeue ${racedId}` }).click();
    const dialog = page.getByRole("dialog", { name: "Requeue this entry?" });
    await dialog.waitFor();
    expect(await dialog.innerText()).toContain(racedId);
    await dialog.getByRole("button", { name: "Cancel" }).click();
    await dialog.waitFor({ state: "hidden" });
    expect(posts(diagnostics, "/v1/operations/dlq/requeue")).toBe(0);

    // Another operator requeues it first; the portal's row is now stale and the server says so.
    const raced = await stack
      .ownerClient()
      .mutate("POST", "/v1/operations/dlq/requeue", { source: "auxiliary", id: racedId });
    expect(raced.status).toBe(200);
    await page.getByRole("button", { name: `Requeue ${racedId}` }).click();
    await dialog.waitFor();
    await dialog.getByRole("button", { name: "Confirm requeue" }).click();
    const failure = dialog.getByRole("alert");
    await failure.waitFor();
    expect(await failure.innerText()).toContain("Entry is not dead-lettered");
    expect(await failure.innerText()).toContain("NOT_FOUND");
    expect(await dialog.isVisible()).toBe(true);
    await dialog.getByRole("button", { name: "Cancel" }).click();

    // Positive: requeue the live entry.
    await page.getByRole("button", { name: `Requeue ${liveId}` }).click();
    await dialog.waitFor();
    await dialog.getByRole("button", { name: "Confirm requeue" }).click();
    await dialog.waitFor({ state: "hidden" });
    await page.getByTestId("notice").waitFor();
    expect(await page.getByTestId("notice").innerText()).toContain(`Requeued ${liveId}.`);
    await page.getByText("The queue is empty").waitFor();
    const remaining = await ownerData<{ items: { id: string }[] }>("/v1/operations/dlq");
    expect(remaining.items.map((entry) => entry.id)).not.toContain(liveId);
    const scope = await stack.scope();
    expect(
      scope.database.get(
        "SELECT state FROM job_leases WHERE workspace_id=? AND id=?",
        stack.workspaceId,
        liveId,
      )?.state,
    ).toBe("queued");
    const requeued = (await auditActions("ops.dlq.requeue.%")).map(
      (entry) => `${entry.action} ${entry.resource_id}`,
    );
    expect(requeued).toContain(`ops.dlq.requeue.allowed auxiliary:${liveId}`);
    expect(diagnostics.pageErrors).toEqual([]);
    expectCatalogOnly(diagnostics);
  });

  it("M4-02 SLO page separates proposed target from observed and shows not measured", async () => {
    const { page, diagnostics } = await portal(stack.owner);
    await page.goto("/operations/slo");
    await waitForHeading(page, "SLO indicators");
    const slo = await ownerData<{
      indicators: {
        id: string;
        title: string;
        unit: string;
        measurement: string;
        proposedTarget: number | null;
        observed: number | null;
      }[];
    }>("/v1/operations/slo");
    const measured = slo.indicators.find((indicator) => indicator.measurement === "measured");
    const unmeasured = slo.indicators.find((indicator) => indicator.measurement === "not_measured");
    if (!measured || !unmeasured)
      throw new Error("the stack must report one measured and one unmeasured indicator");
    expect(measured.id).toBe("api_availability");
    expect(unmeasured.observed).toBeNull();

    // Positive control: a measured indicator shows its value in the observed box, labelled measured.
    const measuredCard = page.getByTestId(`slo-${measured.id}`);
    await measuredCard.waitFor();
    const observedBox = measuredCard.getByRole("region", { name: `${measured.title}: observed` });
    const targetBox = measuredCard.getByRole("region", {
      name: `${measured.title}: proposed target`,
    });
    expect(await observedBox.innerText()).toContain("Measured");
    expect(await observedBox.innerText()).not.toContain("Not measured");
    expect(await observedBox.innerText()).toMatch(/\d+\.\d\d%/);
    // The proposal sits in its own box, labelled as not a measurement, and never carries "Measured".
    expect(await targetBox.innerText()).toContain("Proposal, not a measurement");
    expect(await targetBox.innerText()).toContain(
      `${((measured.proposedTarget ?? 0) * 100).toFixed(2)}%`,
    );
    expect(await targetBox.innerText()).not.toMatch(/\bMeasured\b/);
    expect(await observedBox.innerText()).not.toContain("Proposal");

    // Negative control: nothing measured means "Not measured" and the target is not used as a stand-in.
    const unmeasuredCard = page.getByTestId(`slo-${unmeasured.id}`);
    const unmeasuredObserved = unmeasuredCard.getByRole("region", {
      name: `${unmeasured.title}: observed`,
    });
    expect(await unmeasuredObserved.innerText()).toContain("Not measured");
    expect(await unmeasuredObserved.innerText()).not.toMatch(/\d+(\.\d+)?\s?(%|s)\b/);
    const format = (value: number | null, unit: string): string =>
      unit === "ratio" ? `${((value ?? 0) * 100).toFixed(2)}%` : `${value} s`;
    const proposedText = format(unmeasured.proposedTarget, unmeasured.unit);
    const unmeasuredTarget = unmeasuredCard.getByRole("region", {
      name: `${unmeasured.title}: proposed target`,
    });
    expect(await unmeasuredTarget.innerText()).toContain(proposedText);
    expect(await unmeasuredObserved.innerText()).not.toContain(proposedText);

    // The bucket table is the accessible alternative to a histogram.
    const buckets = page.getByRole("table", { name: "API latency p95: bucket counts" });
    await buckets.waitFor();
    expect(await buckets.getByRole("columnheader").allInnerTexts()).toEqual([
      "Upper bound",
      "Observations",
    ]);
    const counts = (await buckets.locator("tbody tr td:nth-child(2)").allInnerTexts()).map(Number);
    expect(counts.length).toBeGreaterThan(3);
    expect(counts.every((count) => Number.isInteger(count))).toBe(true);
    expect([...counts].sort((a, b) => a - b)).toEqual(counts);
    const emptyBuckets = page.getByRole("table", { name: "Backup freshness: bucket counts" });
    expect(await emptyBuckets.count()).toBe(0);
    expect(await page.getByTestId("slo-backup_freshness").innerText()).toContain(
      "No buckets are recorded",
    );

    expect(await page.locator("h1").count()).toBe(1);
    await expectAccessible(page, "operations slo");
    expect(diagnostics.pageErrors).toEqual([]);
    expectCatalogOnly(diagnostics);
  });

  it("M4-02 incident close without evidence for a no-data-affected claim is refused in the UI", async () => {
    const { page, diagnostics } = await portal(stack.owner);
    await page.goto("/operations/incidents");
    await waitForHeading(page, "Incidents");
    await page.getByRole("heading", { level: 2, name: "Open an incident" }).waitFor();

    // Negative control: empty form shows field-bound errors and sends nothing.
    await page.getByRole("button", { name: "Open incident" }).click();
    await page.getByTestId("error-summary").waitFor();
    const title = page.locator("#incident-title");
    expect(await title.getAttribute("aria-invalid")).toBe("true");
    const titleError = await page
      .locator(`[id="${await title.getAttribute("aria-describedby")}"]`)
      .innerText();
    expect(titleError).toContain("Enter a title.");
    expect(posts(diagnostics, "/v1/incidents")).toBe(0);

    // The server's validation error binds to the same field instead of a generic banner.
    await title.fill("x".repeat(201));
    await page.locator("#incident-summary").fill("Stale credential used against the API");
    await page.getByRole("button", { name: "Open incident" }).click();
    await page.waitForFunction(() =>
      document.querySelector("#incident-title-error")?.textContent?.includes("200"),
    );
    expect(await page.locator("#incident-title-error").innerText()).toMatch(/^Title .*200/);
    expect(posts(diagnostics, "/v1/incidents")).toBe(1);

    // Positive: a valid incident opens and lands on its record. Medium severity may close directly.
    await title.fill("Credential rotation incident");
    await page.locator("#incident-severity").selectOption("medium");
    await page.locator("#incident-category").selectOption("secret_exposure");
    await page.locator("#incident-versions").fill("runtime-6138b54");
    await page.locator("#incident-resources").fill("secret:sec-1");
    await page.getByRole("button", { name: "Open incident" }).click();
    await page.waitForURL(/\/operations\/incidents\/inr_/);
    await waitForHeading(page, "Credential rotation incident");
    const incidentId = new URL(page.url()).pathname.split("/").pop() ?? "";
    expect(incidentId).toMatch(/^inr_/);
    expect(await page.getByRole("list", { name: "Incident timeline" }).innerText()).toContain(
      "Stale credential used against the API",
    );
    expect(await page.locator("main").innerText()).toContain("Communication");
    await expectAccessible(page, "operations incident detail");

    // A corrective action that is not verified blocks closing; the server reason is shown inline.
    await page.locator("#event-kind").selectOption("action");
    await page.locator("#event-text").fill("Rotate the exposed credential");
    await page.locator("#event-action-description").fill("Rotate credential");
    await page.locator("#event-action-criterion").fill("Old credential is rejected");
    await page.locator("#event-action-owner").fill("security-oncall");
    await page.getByRole("button", { name: "Add event" }).click();
    const actionsTable = page.getByRole("table", { name: "Corrective actions" });
    await actionsTable.getByRole("row", { name: /Rotate credential.*Not verified/ }).waitFor();

    const closePanel = page.locator('section[aria-labelledby="incident-close-heading"]');
    await closePanel.locator("#close-resolution").fill("Credential rotated and old key revoked");
    await closePanel.locator("#close-data-affected").selectOption({ label: "None, with evidence" });
    await closePanel.getByRole("button", { name: "Close incident" }).click();
    await closePanel.getByTestId("refusal").waitFor();
    expect(await closePanel.getByTestId("refusal-reason").innerText()).toBe("actions_unverified");
    expect(await closePanel.getByTestId("refusal").innerText()).toContain(
      "Corrective actions need verification before closing",
    );

    // Disclosing publicly before notifying affected parties is refused too.
    await page.locator("#event-kind").selectOption("communication");
    await page.locator("#event-text").fill("Public statement");
    await page.locator("#event-communication-state").selectOption("public_disclosed");
    await page.locator("#event-audience").fill("all customers");
    await page.getByRole("button", { name: "Add event" }).click();
    const eventPanel = page.locator('section[aria-labelledby="incident-event-heading"]');
    await eventPanel.getByTestId("refusal").waitFor();
    expect(await eventPanel.getByTestId("refusal-reason").innerText()).toBe(
      "private_notification_required",
    );
    await page.locator("#event-communication-state").selectOption("private_notified");
    await page.locator("#event-text").fill("Affected customers notified");
    await page.getByRole("button", { name: "Add event" }).click();
    await eventPanel.getByTestId("notice").waitFor();
    await page.getByText("Affected parties notified privately").first().waitFor();

    // Verify the action with evidence.
    await page.locator("#event-kind").selectOption("action_verified");
    await page.locator("#event-text").fill("Old credential rejected in production");
    await page.locator("#event-action-id").selectOption({ label: "Rotate credential" });
    await page.locator("#event-evidence").fill("document rotation-report-1");
    await page.getByRole("button", { name: "Add event" }).click();
    await actionsTable.getByRole("row", { name: /Rotate credential.*Verified/ }).waitFor();
    expect(await actionsTable.innerText()).not.toContain("Not verified");

    // The claim "no data affected" without evidence is refused, and the incident stays open.
    await closePanel.getByRole("button", { name: "Close incident" }).click();
    await closePanel.getByTestId("refusal").waitFor();
    expect(await closePanel.getByTestId("refusal-reason").innerText()).toBe(
      "no_data_affected_evidence_required",
    );
    expect(await closePanel.getByTestId("refusal").innerText()).toContain(
      "A no-data-affected claim needs evidence references",
    );
    await expectAccessible(page, "operations incident refusal");
    const stillOpen = await ownerData<{ state: string; closedAt: string | null }>(
      `/v1/incidents/${incidentId}`,
    );
    expect(stillOpen).toMatchObject({ state: "open", closedAt: null });

    // Positive control: the same close with an evidence reference succeeds.
    await closePanel.locator("#close-evidence").fill("document postmortem-1");
    await closePanel.getByRole("button", { name: "Close incident" }).click();
    await page.getByText("Close unavailable: The incident is already closed.").waitFor();
    expect(await page.locator("main").innerText()).toContain("Resolution");
    const closed = await ownerData<{
      state: string;
      dataAffected: string;
      resolution: string;
      timeline: { kind: string }[];
    }>(`/v1/incidents/${incidentId}`);
    expect(closed).toMatchObject({ state: "closed", dataAffected: "none_with_evidence" });
    expect(closed.timeline.map((entry) => entry.kind)).toEqual(
      expect.arrayContaining(["action", "communication", "action_verified"]),
    );
    expect((await auditActions("ops.incident.close%")).map((entry) => entry.resource_id)).toEqual([
      incidentId,
    ]);
    // A closed incident cannot take another event: the control says why.
    expect(await describedReason(page, "Add event")).toContain("The incident is closed");

    await page.goto("/operations/incidents");
    await page.getByRole("link", { name: "Credential rotation incident" }).waitFor();
    expect(await page.getByRole("table", { name: "Incidents" }).innerText()).toContain("Closed");
    expect(diagnostics.pageErrors).toEqual([]);
    expectCatalogOnly(diagnostics);
    // The seeded-incident helper used by the accessibility sweep produces a record this page can open.
    const seeded = await createIncident(stack.ownerClient(), { title: "Seeded incident" });
    await page.goto(`/operations/incidents/${seeded}`);
    await waitForHeading(page, "Seeded incident");
  });

  it("M4-02 viewer sees disabled-with-reason operations controls", async () => {
    await seedFiringAlerts(stack);
    const dlqId = await seedDeadLetter(stack);
    const viewerPortal = await portal(viewer);
    const { page, diagnostics } = viewerPortal;

    await page.goto("/operations");
    await waitForHeading(page, "Operations");
    const adminReason = "Requires the admin permission";
    for (const name of [
      "Pause admission",
      "Drain admission",
      "Resume admission",
      "Release isolation",
      "Request backup",
    ]) {
      const reason = await describedReason(page, name);
      expect(reason, name).toContain(adminReason);
      expect(reason, name).toContain("viewer");
    }
    // The status itself is readable; only the changes are withheld.
    expect(await page.getByTestId("ops-admission").innerText()).toContain("Enabled");
    await page.locator("#ops-admission-reason").fill("Trying anyway");
    await page.getByRole("button", { name: "Pause admission", exact: true }).click({ force: true });
    expect(await page.getByRole("dialog").count()).toBe(0);
    expect(posts(diagnostics, "/v1/operations/admission")).toBe(0);
    expect(await page.getByTestId("error-summary").count()).toBe(0);
    await expectAccessible(page, "operations status as viewer");

    await page.goto("/operations/alerts?state=firing");
    await waitForHeading(page, "Alerts");
    const firing = (await ownerData<{ items: { rule: string }[] }>("/v1/alerts?state=firing"))
      .items;
    const ack = page.getByRole("button", { name: `Acknowledge ${firing[0]?.rule}` }).first();
    await ack.waitFor();
    expect(await ack.getAttribute("aria-disabled")).toBe("true");
    const note = await page
      .locator(`[id="${await ack.getAttribute("aria-describedby")}"]`)
      .innerText();
    expect(note).toContain("Acknowledge unavailable: Requires the admin permission");
    await ack.click({ force: true });
    expect(diagnostics.requests.filter((entry) => entry.includes("/acknowledge")).length).toBe(0);
    await expectAccessible(page, "operations alerts as viewer");

    await page.goto("/operations/dlq");
    await waitForHeading(page, "Dead-letter queue");
    const requeue = page.getByRole("button", { name: `Requeue ${dlqId}` });
    await requeue.waitFor();
    expect(await requeue.getAttribute("aria-disabled")).toBe("true");
    await requeue.click({ force: true });
    expect(await page.getByRole("dialog").count()).toBe(0);
    expect(posts(diagnostics, "/v1/operations/dlq/requeue")).toBe(0);

    // Incident records are admin-only on the server; the portal says so without asking for them.
    await page.goto("/operations/incidents");
    await waitForHeading(page, "Incidents");
    expect(
      await page.getByRole("alert", { name: "Incidents are admin-only" }).innerText(),
    ).toContain(adminReason);
    expect(diagnostics.requests.filter((entry) => entry.startsWith("GET /v1/incidents"))).toEqual(
      [],
    );
    expect(await page.getByRole("button", { name: "Open incident" }).count()).toBe(0);

    // The server enforces the same rule independently of what the page shows.
    const viewerClient = await signedIn(viewer);
    const denied = await viewerClient.mutate("POST", "/v1/operations/admission", {
      action: "pause",
      reason: "viewer attempt",
    });
    expect(denied.status).toBe(403);
    expect(denied.json<ErrorBody>().error.code).toBe("FORBIDDEN");
    expect(
      (await ownerData<{ admission: { state: string } }>("/v1/operations/status")).admission.state,
    ).toBe("enabled");

    // Positive control: an org_admin may change admission but is not the owner, so backups stay disabled.
    const admin = await portal(orgAdmin);
    await admin.page.goto("/operations");
    await waitForHeading(admin.page, "Operations");
    const pause = admin.page.getByRole("button", { name: "Pause admission", exact: true });
    await pause.waitFor();
    expect(await pause.getAttribute("aria-disabled")).toBeNull();
    const ownerOnly = await describedReason(admin.page, "Request backup");
    expect(ownerOnly).toContain("Requires the org_owner role");
    expect(ownerOnly).not.toContain(adminReason);
    const refusedBackup = await (await signedIn(orgAdmin)).mutate(
      "POST",
      "/v1/operations/backups",
      { reason: "admin attempt" },
    );
    expect(refusedBackup.status).toBe(403);
    expect(refusedBackup.json<ErrorBody>().error.details).toMatchObject({
      reason: "owner_required",
    });
    expect(viewerPortal.diagnostics.pageErrors).toEqual([]);
    expect(admin.diagnostics.pageErrors).toEqual([]);
  });
});
