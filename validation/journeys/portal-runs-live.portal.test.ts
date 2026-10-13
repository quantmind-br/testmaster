import type { Application } from "@testmaster/application";
import { routeCatalog } from "@testmaster/contracts";
import { OutboxRepository } from "@testmaster/persistence";
import type { Page } from "playwright";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { expectAccessible, keyboardOnly, type OpenPortal, openPortal } from "./portal.js";
import { createRunsScope, createTest, type RunsScope, seedLiveRun } from "./runs-fixtures.js";
import { type ServerStack, startServerStack } from "./server-stack.js";

/**
 * J05 over the real server profile: live progress, a severed connection, reconnect without losing
 * or repeating events, and cancellation that is a request until the Run actually stops. A second
 * group replays hostile event orderings (duplicates, reordering, a gap, events after the terminal
 * result) so the timeline's monotonic rules are proved in a browser, not only in the reducer.
 */
let stack: ServerStack;
let system: Application;
let scope: RunsScope;
const open: OpenPortal[] = [];

interface LiveRun {
  runId: string;
  attemptId: string;
}

async function seedLive(): Promise<LiveRun> {
  const test = createTest(scope);
  const seeded = await seedLiveRun(scope, String(test.id));
  const attemptId = seeded.attemptIds[0];
  if (!attemptId) throw new Error("the live Run needs an Attempt");
  return { runId: seeded.runId, attemptId };
}

function appendEvent(runId: string, type: string, payload: Record<string, unknown>): void {
  system.database.withTx(() =>
    new OutboxRepository(system.database).append(stack.workspaceId, runId, type, payload),
  );
}

/**
 * The server budgets authentication per client address (20 burst, 1 per second), and every
 * journey browser comes from one address; sign-ins are spaced so the budget never runs dry.
 */
let lastSignIn = 0;
async function portal(): Promise<OpenPortal> {
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
  );
  open.push(opened);
  return opened;
}

const catalogPattern = (path: string): RegExp =>
  new RegExp(`^${path.replace(/\{[^}]+\}/g, "[^/]+")}$`);

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

async function openRun(page: Page, runId: string): Promise<void> {
  await page.goto(`/runs/${runId}`);
  await page.getByTestId("run-facts").waitFor({ timeout: 15_000 });
}

async function stageStates(page: Page): Promise<string[]> {
  return page
    .locator('[data-testid="run-timeline"] li')
    .evaluateAll((items) =>
      items.map((item) => `${item.getAttribute("data-stage")}:${item.getAttribute("data-state")}`),
    );
}

const liveRegionText = (page: Page) => page.locator('[data-testid="live-region"]').textContent();
const eventRequests = (requests: readonly string[], runId: string) =>
  requests.filter((entry) => entry === `GET /v1/runs/${runId}/events`);

beforeAll(async () => {
  stack = await startServerStack({ workspaces: 1 });
  system = (await stack.scope()).forWorkspaceSystem(stack.workspaceId);
  scope = await createRunsScope(system, stack.workspaceId, "Live Run");
}, 900_000);

afterAll(async () => {
  for (const opened of open.splice(0)) await opened.close().catch(() => undefined);
  await stack?.stop();
});

describe("J05 live progress, reconnect and cancel", () => {
  it("J05 UX-026 UX-027 UX-028 progress continues across a severed connection and cancel is a request until the Run stops", async () => {
    const live = await seedLive();
    const { page, diagnostics } = await portal();
    await openRun(page, live.runId);
    const status = page.getByTestId("stream-status");
    await status.filter({ hasText: "Live updates connected" }).waitFor({ timeout: 30_000 });
    // Negative control: nothing terminal has happened, so the Run reads in progress.
    expect(await page.getByTestId("run-facts").textContent()).toContain("In progress");

    // Progress arrives live.
    appendEvent(live.runId, "run.phase_changed", {
      attemptId: live.attemptId,
      phase: "collecting",
    });
    await expect
      .poll(() => liveRegionText(page), { timeout: 30_000 })
      .toContain("Run is now collecting evidence.");
    const connectionsBefore = eventRequests(diagnostics.requests, live.runId).length;

    // The connection dies and the next event is produced while the browser is offline.
    stack.proxy.severConnections();
    appendEvent(live.runId, "run.phase_changed", {
      attemptId: live.attemptId,
      phase: "analyzing",
    });
    await expect
      .poll(() => eventRequests(diagnostics.requests, live.runId).length, { timeout: 30_000 })
      .toBeGreaterThan(connectionsBefore);
    await status.filter({ hasText: "Live updates connected" }).waitFor({ timeout: 30_000 });
    // The event missed during the outage is recovered, announced once, and never replayed twice.
    await expect
      .poll(() => liveRegionText(page), { timeout: 30_000 })
      .toContain("Run is now analyzing.");
    expect(await stageStates(page)).toContain("terminal:pending");

    // Cancel: a request, visibly different from the Run stopping.
    const keyboard = await keyboardOnly(page);
    await keyboard.tabTo((focused) => focused.tag === "button" && focused.name === "Cancel Run");
    await keyboard.press("Enter");
    await page.getByRole("dialog").waitFor();
    await keyboard.tabTo((focused) => focused.name === "Request cancellation");
    await keyboard.press("Enter");
    const notice = page.getByTestId("cancel-notice");
    await notice.waitFor();
    expect(await notice.textContent()).toContain("has not stopped yet");
    expect(await page.getByTestId("run-facts").textContent()).toContain("In progress");
    expect(await page.getByTestId("run-facts").textContent()).not.toContain("Cancelled");
    expect(diagnostics.requests.filter((entry) => entry.includes("/cancel"))).toEqual([
      `POST /v1/runs/${live.runId}/cancel`,
    ]);

    // The terminal confirmation is a separate, later fact.
    appendEvent(live.runId, "run.completed", { attemptId: live.attemptId, outcome: "cancelled" });
    await expect.poll(() => stageStates(page), { timeout: 30_000 }).toContain("terminal:done");
    await expect
      .poll(() => liveRegionText(page), { timeout: 30_000 })
      .toContain("Run finished as cancelled.");
    await keyboard.assertNoPointerUsed();
    await expectAccessible(page, "live Run after cancel");
    expect(diagnostics.pageErrors).toEqual([]);
    expectCatalogRequestsOnly(diagnostics.requests);
  });
});

interface WireEvent {
  seq: number;
  type: string;
  payload: Record<string, unknown>;
  attemptId?: string | null;
}

function sseBody(runId: string, events: readonly WireEvent[]): string {
  return events
    .map((event) => {
      const envelope = {
        schemaVersion: "1.0.0",
        eventId: `evt-${event.seq}-${event.type}`,
        seq: event.seq,
        type: event.type,
        runId,
        attemptId: event.attemptId ?? null,
        occurredAt: new Date(1_800_000_000_000 + event.seq * 1000).toISOString(),
        payload: event.payload,
      };
      return `id: ${event.seq}\nevent: ${event.type}\ndata: ${JSON.stringify(envelope)}\n\n`;
    })
    .join("");
}

async function replayStream(page: Page, runId: string, events: readonly WireEvent[]) {
  await page.route(`**/v1/runs/${runId}/events`, (route) =>
    route.fulfill({
      status: 200,
      headers: { "content-type": "text/event-stream", "cache-control": "no-store" },
      body: sseBody(runId, events),
    }),
  );
}

const snapshotReads = (requests: readonly string[], runId: string) =>
  requests.filter(
    (entry) =>
      entry === `GET /v1/runs/${runId}/attempts` ||
      entry.startsWith(`GET /v1/runs/${runId}/attempts?`),
  ).length;

describe("event ordering and gaps", () => {
  it("VAL-034 UX-027 duplicates, reordered events and events after the terminal result never regress the Run", async () => {
    const live = await seedLive();
    const attemptId = live.attemptId;
    const { page, diagnostics } = await portal();
    await replayStream(page, live.runId, [
      { seq: 10, type: "run.phase_changed", attemptId, payload: { attemptId, phase: "running" } },
      {
        seq: 11,
        type: "run.phase_changed",
        attemptId,
        payload: { attemptId, phase: "collecting" },
      },
      // Duplicate and stale deliveries: dropped by sequence.
      {
        seq: 11,
        type: "run.phase_changed",
        attemptId,
        payload: { attemptId, phase: "collecting" },
      },
      { seq: 10, type: "run.phase_changed", attemptId, payload: { attemptId, phase: "running" } },
      { seq: 12, type: "run.completed", attemptId, payload: { attemptId, outcome: "passed" } },
      // After the terminal result: a later event must neither reopen nor replace it.
      { seq: 13, type: "run.phase_changed", attemptId, payload: { attemptId, phase: "preparing" } },
      { seq: 14, type: "run.completed", attemptId, payload: { attemptId, outcome: "failed" } },
    ]);
    await openRun(page, live.runId);
    await expect.poll(() => stageStates(page), { timeout: 30_000 }).toContain("terminal:done");
    const facts = (await page.getByTestId("run-facts").textContent()) ?? "";
    // The first terminal result stands; the later contradictory one is ignored.
    expect(facts).not.toContain("Failed");
    const terminal =
      (await page
        .locator('[data-testid="run-timeline"] li[data-stage="terminal"]')
        .textContent()) ?? "";
    expect(terminal.toLowerCase()).toContain("passed");
    expect(terminal.toLowerCase()).not.toContain("failed");
    expect(await stageStates(page)).not.toContain("terminal:pending");
    expect(diagnostics.pageErrors).toEqual([]);
  });

  it("VAL-034 UX-027 a sequence gap refetches the snapshot, a contiguous stream does not", async () => {
    const contiguous = await seedLive();
    const gapped = await seedLive();
    const ordered = (run: LiveRun, seqs: readonly number[]): WireEvent[] => [
      ...seqs.slice(0, -1).map((seq) => ({
        seq,
        type: "run.phase_changed",
        attemptId: run.attemptId,
        payload: { attemptId: run.attemptId, phase: "running" },
      })),
      {
        seq: seqs.at(-1) ?? 0,
        type: "run.completed",
        attemptId: run.attemptId,
        payload: { attemptId: run.attemptId, outcome: "passed" },
      },
    ];
    const first = await portal();
    await replayStream(first.page, contiguous.runId, ordered(contiguous, [20, 21, 22]));
    await openRun(first.page, contiguous.runId);
    await expect
      .poll(() => stageStates(first.page), { timeout: 30_000 })
      .toContain("terminal:done");
    await first.page.waitForLoadState("networkidle");
    const contiguousReads = snapshotReads(first.diagnostics.requests, contiguous.runId);

    const second = await portal();
    await replayStream(second.page, gapped.runId, ordered(gapped, [20, 21, 25]));
    await openRun(second.page, gapped.runId);
    await expect
      .poll(() => stageStates(second.page), { timeout: 30_000 })
      .toContain("terminal:done");
    await second.page.waitForLoadState("networkidle");
    const gappedReads = snapshotReads(second.diagnostics.requests, gapped.runId);
    expect(gappedReads).toBeGreaterThan(contiguousReads);
    // The snapshot refetch did not undo the terminal result already received.
    expect(await stageStates(second.page)).toContain("terminal:done");
    expect(second.diagnostics.pageErrors).toEqual([]);
  });
});
