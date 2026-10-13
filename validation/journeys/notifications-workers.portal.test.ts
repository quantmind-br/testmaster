import { routeCatalog } from "@testmaster/contracts";
import type { Locator, Page } from "playwright-core";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  type NotificationFixture,
  seedNotifications,
  seedReadyWorker,
} from "./notifications-fixtures.js";
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
 * The workers and notifications pages against the real server profile (PostgreSQL, the built CLI
 * as a child process and a TLS proxy). Integrations, secrets and workers are created through the
 * API; deliveries and their attempt logs are written into the database because a dead letter takes
 * ten failed attempts over a day to produce. The webhook host is an unresolvable `.invalid` name,
 * so nothing here reaches the network.
 */
const hostileImage = `<img src=x onerror="window.__pwned='img'">`;
const tokenPattern = /tm_wrk_[A-Za-z0-9_-]{43}/u;
const wording = /not sent|failed to send|unsent/iu;

let stack: ServerStack;
let viewer: StackUser;
const open: OpenPortal[] = [];

beforeAll(async () => {
  stack = await startServerStack({ workspaces: 1 });
  viewer = await stack.addMember("viewer");
}, 600_000);

afterAll(async () => {
  for (const portal of open.splice(0)) await portal.close().catch(() => undefined);
  await stack?.stop();
});

async function portal(user: StackUser = stack.owner): Promise<OpenPortal> {
  const opened = await openPortal(
    { baseUrl: stack.baseUrl, spkiSha256: stack.ca.spkiSha256 },
    user,
  );
  open.push(opened);
  return opened;
}

function requestsTo(portalHandle: OpenPortal, pattern: RegExp): string[] {
  return portalHandle.diagnostics.requests.filter((entry) => pattern.test(entry));
}

function row(page: Page, text: string | RegExp): Locator {
  return page.getByRole("row").filter({ hasText: text });
}

/** A row of the integrations table; delivery rows also carry integration names. */
function integrationRow(page: Page, text: string | RegExp): Locator {
  return page
    .getByRole("table", { name: "Notification integrations" })
    .getByRole("row")
    .filter({ hasText: text });
}

async function pwned(page: Page): Promise<unknown> {
  return page.evaluate(() => (window as unknown as { __pwned?: string }).__pwned);
}

async function mainText(page: Page): Promise<string> {
  return page.locator("main").innerText();
}

/** A signed-in client for a member, to prove the API refuses what the portal disables. */
async function memberClient(user: StackUser) {
  const client = stack.anonymous();
  const login = await client.request("POST", "/v1/identity/login", {
    body: { principal: user.login, password: user.password },
    headers: { origin: stack.baseUrl, "idempotency-key": crypto.randomUUID() },
  });
  expect(login.status).toBe(200);
  client.csrfToken = login.json<{ data: { csrfToken: string } }>().data.csrfToken;
  return client;
}

describe("workers", () => {
  it("M4-08 REQ-038 an owner enrolls a worker in the portal and the one-time token is shown once, never listed, stored or kept after a reload", async () => {
    const handle = await portal();
    const { page } = handle;
    const listBodies: string[] = [];
    let created = "";
    page.on("response", (response) => {
      const url = new URL(response.url());
      if (url.pathname !== "/v1/workers") return;
      const method = response.request().method();
      void response
        .text()
        .then((text) => {
          if (method === "GET") listBodies.push(text);
          if (method === "POST") created = text;
        })
        .catch(() => undefined);
    });
    await page.goto("/settings/workers");
    await page.getByRole("heading", { level: 1, name: "Workers" }).waitFor();
    // Negative control: before enrolling there is no token anywhere on the page.
    expect(await page.getByTestId("enrollment-token").count()).toBe(0);

    await page.getByLabel("Worker name").fill("pool-ui-1");
    await page.getByLabel("Labels").fill("pool=default\nzone=local");
    await page.getByRole("button", { name: "Create enrollment" }).click();
    const token = page.getByTestId("enrollment-token");
    await token.waitFor();
    const shown = (await token.textContent()) ?? "";
    expect(shown).toMatch(new RegExp(`^${tokenPattern.source}$`, "u"));
    // Positive control: the token on screen is the one the server returned to this one request.
    await page.waitForLoadState("networkidle");
    expect(created).toContain(shown);
    expect(await page.getByText("This token is shown once.").count()).toBe(1);
    expect(await page.getByText("--enroll-token-file").count()).toBe(1);
    const panelBox = await page.getByTestId("enrollment-panel").boundingBox();
    expect(panelBox?.width).toBeGreaterThan(0);

    // The new worker is listed as Enrolling with its labels, and the list never carries the token.
    const workerRow = row(page, "pool-ui-1");
    await workerRow.locator('[data-status="enrolling"]').waitFor();
    expect(await workerRow.innerText()).toContain("pool=default, zone=local");
    expect(await workerRow.innerText()).not.toContain(shown);
    expect(await page.getByRole("table", { name: "Workers" }).innerText()).not.toContain(shown);
    expect(listBodies.length).toBeGreaterThan(0);
    for (const body of listBodies) expect(body).not.toContain(shown);

    const where = await page.evaluate(() => ({
      local: JSON.stringify(localStorage),
      session: JSON.stringify(sessionStorage),
      href: location.href,
    }));
    for (const value of Object.values(where)) expect(value).not.toContain(shown);
    // Negative control: the same inspection does find a token that is put there.
    await page.evaluate((value) => localStorage.setItem("probe", value), shown);
    expect(JSON.stringify(await page.evaluate(() => JSON.stringify(localStorage)))).toContain(
      shown.slice(0, 16),
    );
    await page.evaluate(() => localStorage.removeItem("probe"));

    // Reload: the token is gone from the DOM, from the markup and from every request made since.
    await page.reload();
    await page.getByRole("heading", { level: 1, name: "Workers" }).waitFor();
    await row(page, "pool-ui-1").waitFor();
    expect(await page.getByTestId("enrollment-token").count()).toBe(0);
    expect(await page.content()).not.toContain(shown);
    expect(await mainText(page)).not.toContain(shown);
    for (const body of listBodies) expect(body).not.toContain(shown);
    // Navigating away and back does not bring it back either.
    await page.goto("/");
    await page.goto("/settings/workers");
    await row(page, "pool-ui-1").waitFor();
    expect(await page.content()).not.toContain(shown);

    // Dismissing discards the token without a reload.
    await page.getByLabel("Worker name").fill("pool-ui-2");
    await page.getByRole("button", { name: "Create enrollment" }).click();
    const second = page.getByTestId("enrollment-token");
    await second.waitFor();
    const secondToken = (await second.textContent()) ?? "";
    expect(secondToken).not.toBe(shown);
    await page.getByRole("button", { name: "I saved the token, dismiss it" }).click();
    await second.waitFor({ state: "detached" });
    expect(await page.content()).not.toContain(secondToken);
    // Invalid input is refused before any request is sent.
    const before = requestsTo(handle, /^POST \/v1\/workers$/u).length;
    await page.getByLabel("Worker name").fill("  ");
    await page.getByRole("button", { name: "Create enrollment" }).click();
    await page.getByTestId("error-summary").waitFor();
    expect(await page.getByTestId("error-summary").innerText()).toContain("Enter a worker name");
    expect(requestsTo(handle, /^POST \/v1\/workers$/u).length).toBe(before);
    expect(handle.diagnostics.pageErrors).toEqual([]);
  });

  it("M4-08 REQ-038 drain then revoke change the state badge, revoke asks for confirmation and a double confirm sends one request", async () => {
    const workerId = await seedReadyWorker(stack, "drain-revoke-1", { pool: "a" });
    const handle = await portal();
    const { page } = handle;
    await page.goto("/settings/workers");
    const target = row(page, workerId);
    await target.locator('[data-status="ready"]').waitFor();
    expect(await target.innerText()).toContain("just now");

    await target.getByRole("button", { name: /^Drain / }).click();
    await target.locator('[data-status="draining"]').waitFor();
    // A draining worker cannot be drained again: disabled with its reason, and the click sends nothing.
    const drain = target.getByRole("button", { name: /^Drain / });
    expect(await drain.getAttribute("aria-disabled")).toBe("true");
    expect(await target.innerText()).toContain("This worker is already draining.");
    const drains = () =>
      requestsTo(handle, new RegExp(`^POST /v1/workers/${workerId}/drain$`, "u"));
    expect(drains().length).toBe(1);
    await drain.click({ force: true });
    expect(drains().length).toBe(1);

    // Cancel sends nothing and leaves the state alone.
    await target.getByRole("button", { name: /^Revoke / }).click();
    const dialog = page.getByRole("dialog", { name: "Revoke this worker?" });
    await dialog.waitFor();
    expect(await dialog.innerText()).toContain("drain-revoke-1");
    expect(await dialog.innerText()).toContain(workerId);
    await dialog.getByRole("button", { name: "Cancel" }).click();
    await dialog.waitFor({ state: "hidden" });
    const revokes = () =>
      requestsTo(handle, new RegExp(`^POST /v1/workers/${workerId}/revoke$`, "u"));
    expect(revokes().length).toBe(0);
    await target.locator('[data-status="draining"]').waitFor();

    // Confirm with a double click: one request, and the worker is revoked.
    await target.getByRole("button", { name: /^Revoke / }).click();
    await dialog.waitFor();
    await dialog.getByRole("button", { name: "Revoke worker" }).dblclick();
    await target.locator('[data-status="revoked"]').waitFor();
    expect(revokes().length).toBe(1);
    const detail = await stack.ownerClient().request("GET", `/v1/workers/${workerId}`);
    expect(detail.json<{ data: { state: string } }>().data.state).toBe("revoked");

    // A revoked worker can be neither drained nor revoked again; the controls say why.
    expect(await drain.getAttribute("aria-disabled")).toBe("true");
    expect(
      await target.getByRole("button", { name: /^Revoke / }).getAttribute("aria-disabled"),
    ).toBe("true");
    const text = await target.innerText();
    expect(text).toContain("A revoked worker cannot be drained.");
    expect(text).toContain("This worker is already revoked.");
    await target.getByRole("button", { name: /^Revoke / }).click({ force: true });
    expect(await page.getByRole("dialog").count()).toBe(0);
    await drain.click({ force: true });
    expect(drains().length).toBe(1);
    expect(revokes().length).toBe(1);
    expect(handle.diagnostics.pageErrors).toEqual([]);
  });

  it("M4-08 REQ-038 a viewer gets the forbidden view for workers, not an empty list, and the API refuses the same read", async () => {
    const seeded = await seedReadyWorker(stack, "viewer-hidden-1");
    const { page } = await portal(viewer);
    await page.goto("/settings/workers");
    await page.getByRole("heading", { level: 1, name: "Workers" }).waitFor();
    await page.locator(".view-forbidden").waitFor();
    const text = await mainText(page);
    expect(text).toContain("Not permitted");
    expect(text).not.toContain("viewer-hidden-1");
    expect(text).not.toContain("No workers yet");
    expect(await page.getByRole("table").count()).toBe(0);
    expect(await page.getByRole("button", { name: "Create enrollment" }).count()).toBe(0);
    const member = await memberClient(viewer);
    const list = await member.request("GET", "/v1/workers");
    expect(list.status).toBe(403);
    expect(list.text).not.toContain(seeded);
    // Positive control: the owner sees the same worker in the same page.
    const owner = await portal();
    await owner.page.goto("/settings/workers");
    await row(owner.page, seeded).waitFor();
    expect(await owner.page.locator(".view-forbidden").count()).toBe(0);
  });
});

describe("keyboard and accessibility", () => {
  let fixture: NotificationFixture;
  beforeAll(async () => {
    fixture = await seedNotifications(stack, { integrationName: "Keyboard hook" });
  }, 120_000);

  it("UX-051 UX-052 the workers page and the notifications page are fully operable with the keyboard alone", async () => {
    const workerId = await seedReadyWorker(stack, "keyboard-worker-1");
    const handle = await portal();
    const { page } = handle;
    await page.goto("/settings/workers");
    await row(page, workerId).waitFor();
    const keyboard = await keyboardOnly(page);

    expect(
      await keyboard.tabTo((element) => element.name.startsWith("Worker name"), 40),
    ).toBeGreaterThan(0);
    await keyboard.type("keyboard-enrolled");
    await keyboard.press("Tab");
    expect((await keyboard.focused()).name).toBe("Labels");
    await keyboard.press("Tab");
    expect((await keyboard.focused()).name).toBe("Create enrollment");
    expect((await keyboard.focused()).focusRing).toBe(true);
    await keyboard.press("Enter");
    const token = page.getByTestId("enrollment-token");
    await token.waitFor();
    // The page moves focus to the token panel so a screen reader announces it.
    expect(await page.evaluate(() => document.activeElement?.getAttribute("data-testid"))).toBe(
      "enrollment-panel",
    );
    await keyboard.tabTo((element) => element.name === "Copy token", 5);
    await keyboard.tabTo((element) => element.name.startsWith("I saved the token"), 3);
    await keyboard.press("Enter");
    await token.waitFor({ state: "detached" });

    // Drain, then revoke through the dialog, without a pointer.
    await keyboard.tabTo(
      (element) => element.tag === "button" && element.name.startsWith("Drain keyboard-worker-1"),
      60,
    );
    expect((await keyboard.focused()).focusRing).toBe(true);
    await keyboard.press("Enter");
    await row(page, workerId).locator('[data-status="draining"]').waitFor();
    await keyboard.tabTo((element) => element.name.startsWith("Revoke keyboard-worker-1"), 12);
    await keyboard.press("Enter");
    const dialog = page.getByRole("dialog", { name: "Revoke this worker?" });
    await dialog.waitFor();
    // The destructive dialog opens on its safe choice.
    expect((await keyboard.focused()).name).toBe("Cancel");
    await keyboard.press("Tab");
    expect((await keyboard.focused()).name).toBe("Revoke worker");
    await keyboard.press("Enter");
    await row(page, workerId).locator('[data-status="revoked"]').waitFor();

    // Notifications: open the form, create an integration, filter the history and open a delivery.
    await page.goto("/settings/notifications");
    await page.getByRole("heading", { level: 1, name: "Notifications" }).waitFor();
    await row(page, fixture.deadLetter.id).waitFor();
    await keyboard.tabTo((element) => element.name === "New integration", 40);
    await keyboard.press("Enter");
    await page.getByRole("heading", { level: 2, name: "New integration" }).waitFor();
    await keyboard.tabTo((element) => element.id !== "" && element.name.startsWith("Name"), 8);
    await keyboard.type("Keyboard created hook");
    await keyboard.press("Tab");
    await keyboard.press("Tab");
    await keyboard.press("Space");
    expect(await page.getByLabel("Run failed", { exact: true }).isChecked()).toBe(true);
    await keyboard.tabTo((element) => element.name.startsWith("Webhook URL"), 14);
    await keyboard.type("https://hooks.s8.invalid/keyboard");
    await keyboard.press("Tab");
    expect((await keyboard.focused()).name).toContain("Signing secret");
    await keyboard.press("ArrowDown");
    await keyboard.tabTo((element) => element.name.startsWith("Redaction level"), 6);
    await keyboard.press("Tab");
    await keyboard.press("Space");
    expect(await page.getByRole("checkbox", { name: /notify:webhook/u }).isChecked()).toBe(true);
    await keyboard.tabTo((element) => element.name === "Create integration", 3);
    await keyboard.press("Enter");
    await integrationRow(page, "Keyboard created hook").waitFor();
    expect(await integrationRow(page, "Keyboard created hook").innerText()).toContain("run.failed");

    await keyboard.tabTo((element) => element.id === "filter-state", 80);
    await keyboard.press("ArrowDown");
    await page.waitForURL((url) => url.searchParams.get("state") === "pending");
    await row(page, fixture.pending.id).waitFor();
    expect(await row(page, fixture.deadLetter.id).count()).toBe(0);
    await keyboard.tabTo((element) => element.name === fixture.pending.id, 20);
    expect((await keyboard.focused()).focusRing).toBe(true);
    await keyboard.press("Enter");
    await page.waitForURL((url) => url.pathname.endsWith(`/deliveries/${fixture.pending.id}`));
    await page
      .getByRole("heading", { level: 1, name: new RegExp(fixture.pending.id, "u") })
      .waitFor();
    await keyboard.assertNoPointerUsed();
    expect(handle.diagnostics.pageErrors).toEqual([]);
  });

  it("UX-051 UX-052 UX-053 the workers, notifications and delivery pages are axe clean on desktop and reflow at 320 px and 200 % zoom", async () => {
    await seedReadyWorker(stack, "axe-worker-1", { pool: "axe" });
    const { page } = await portal();
    const pages: { path: string; ready: () => Promise<void>; label: string }[] = [
      {
        label: "workers",
        path: "/settings/workers",
        ready: async () => void (await row(page, "axe-worker-1").waitFor()),
      },
      {
        label: "notifications",
        path: "/settings/notifications",
        ready: async () => void (await row(page, fixture.uncertain.id).waitFor()),
      },
      {
        label: "dead-letter delivery",
        path: `/settings/notifications/deliveries/${fixture.deadLetter.id}`,
        ready: async () =>
          void (await page.getByRole("table", { name: "Delivery attempts" }).waitFor()),
      },
      {
        label: "uncertain delivery",
        path: `/settings/notifications/deliveries/${fixture.uncertain.id}`,
        ready: async () =>
          void (await page.getByRole("table", { name: "Delivery attempts" }).waitFor()),
      },
    ];
    for (const entry of pages) {
      await page.goto(entry.path);
      await page.getByRole("heading", { level: 1 }).first().waitFor();
      await entry.ready();
      await expectAccessible(page, `${entry.label} desktop`);
    }
    // States that are not the default view: the open form and the one-time token panel.
    await page.goto("/settings/notifications");
    await page.getByRole("button", { name: "New integration" }).click();
    await page.getByRole("heading", { level: 2, name: "New integration" }).waitFor();
    await expectAccessible(page, "integration form desktop");
    await page.goto("/settings/workers");
    await page.getByLabel("Worker name").fill("axe-enrolled");
    await page.getByRole("button", { name: "Create enrollment" }).click();
    await page.getByTestId("enrollment-token").waitFor();
    await expectAccessible(page, "token panel desktop");

    await atViewport(page, { width: 320, zoom: 2 });
    for (const entry of pages) {
      await page.goto(entry.path);
      await page.getByRole("heading", { level: 1 }).first().waitFor();
      await entry.ready();
      await expectNoPageOverflow(page, `${entry.label} at 320 px`);
      await expectAccessible(page, `${entry.label} 320px 200%`);
    }
    await page.goto("/settings/notifications");
    await page.getByRole("button", { name: "New integration" }).click();
    await page.getByRole("heading", { level: 2, name: "New integration" }).waitFor();
    await expectNoPageOverflow(page, "integration form at 320 px");
    await expectAccessible(page, "integration form 320px 200%");
    await page.goto("/settings/workers");
    await page.getByLabel("Worker name").fill("axe-enrolled-narrow");
    await page.getByRole("button", { name: "Create enrollment" }).click();
    await page.getByTestId("enrollment-token").waitFor();
    await expectNoPageOverflow(page, "token panel at 320 px");
    await expectAccessible(page, "token panel 320px 200%");
    expect(await page.getByRole("button", { name: "Sign out" }).isVisible()).toBe(true);

    // The forbidden view is accessible too (a viewer opening the workers page).
    const forbidden = await portal(viewer);
    await forbidden.page.goto("/settings/workers");
    await forbidden.page.locator(".view-forbidden").waitFor();
    await expectAccessible(forbidden.page, "workers forbidden desktop");
    await atViewport(forbidden.page, { width: 320, zoom: 2 });
    await forbidden.page.goto("/settings/workers");
    await forbidden.page.locator(".view-forbidden").waitFor();
    await expectNoPageOverflow(forbidden.page, "workers forbidden at 320 px");
    await expectAccessible(forbidden.page, "workers forbidden 320px 200%");
  });
});

describe("deliveries", () => {
  let dead: NotificationFixture;
  beforeAll(async () => {
    dead = await seedNotifications(stack, { integrationName: "DLQ hook" });
  }, 120_000);

  it("INT-026 OPS-011 a dead letter shows its DLQ state, Requeue moves it to pending through the UI and no Run is rerun", async () => {
    const handle = await portal();
    const { page } = handle;
    await page.goto("/settings/notifications");
    await page.getByRole("heading", { level: 1, name: "Notifications" }).waitFor();
    const letter = row(page, dead.deadLetter.id);
    await letter.waitFor();
    await letter.locator('[data-status="dead_letter"]').waitFor();
    expect(await letter.innerText()).toContain("Dead letter · DLQ");
    // Positive and negative controls on the same page: pending and delivered rows have no Requeue.
    expect(await letter.getByRole("button", { name: /^Requeue / }).count()).toBe(1);
    for (const other of [dead.pending, dead.delivered]) {
      expect(
        await row(page, other.id)
          .getByRole("button", { name: /^Requeue/ })
          .count(),
      ).toBe(0);
    }
    expect(await row(page, dead.delivered.id).locator('[data-status="delivered"]').count()).toBe(1);
    expect(await row(page, dead.pending.id).locator('[data-status="pending"]').count()).toBe(1);

    // The filter lives in the URL: it survives a reload and shows only dead letters.
    await page.getByLabel("State", { exact: true }).selectOption("dead_letter");
    await page.waitForURL((url) => url.searchParams.get("state") === "dead_letter");
    await page.reload();
    await row(page, dead.deadLetter.id).waitFor();
    expect(await page.getByLabel("State", { exact: true }).inputValue()).toBe("dead_letter");
    expect(await row(page, dead.pending.id).count()).toBe(0);
    expect(await row(page, dead.delivered.id).count()).toBe(0);

    const runsBefore = requestsTo(handle, /\/v1\/runs/u).length;
    const retries = () =>
      requestsTo(handle, new RegExp(`^POST /v1/deliveries/${dead.deadLetter.id}/retry$`, "u"));
    await row(page, dead.deadLetter.id)
      .getByRole("button", { name: /^Requeue / })
      .dblclick();
    // Requeued: it leaves the dead-letter view, and the unfiltered history shows it pending.
    await row(page, dead.deadLetter.id).waitFor({ state: "detached" });
    expect(retries().length).toBe(1);
    await page.getByRole("button", { name: "Clear filters" }).click();
    const requeued = row(page, dead.deadLetter.id);
    await requeued.locator('[data-status="pending"]').waitFor();
    expect(await requeued.getByRole("button", { name: /^Requeue/ }).count()).toBe(0);
    // The other dead letter is untouched.
    await row(page, dead.uncertain.id).locator('[data-status="dead_letter"]').waitFor();
    const record = await stack.ownerClient().request("GET", `/v1/deliveries/${dead.deadLetter.id}`);
    const body = record.json<{ data: { state: string; deliveryId: string } }>().data;
    expect(body.state).toBe("pending");
    // The delivery ID is stable across the requeue (receivers deduplicate on it).
    expect(body.deliveryId).toBe(dead.deadLetter.id);
    // A delivery retry never reruns a Run: the portal made no Run request and none exists.
    expect(requestsTo(handle, /\/v1\/runs/u).length).toBe(runsBefore);
    const runs = await stack.ownerClient().request("GET", "/v1/runs");
    expect(runs.json<{ data: { items: unknown[] } }>().data.items).toEqual([]);
    expect(await page.getByText(/never reruns a Run/u).count()).toBeGreaterThan(0);
    expect(handle.diagnostics.pageErrors).toEqual([]);
  });

  it("INT-026 an uncertain attempt says the outcome is uncertain and no page ever says the message was not sent", async () => {
    const { page } = await portal();
    // Sanity: the wording check does flag the phrases it is meant to forbid.
    expect(wording.test("This message was not sent")).toBe(true);
    expect(wording.test("Failed to send")).toBe(true);
    expect(wording.test("Outcome uncertain — the destination may have received it")).toBe(false);

    await page.goto("/settings/notifications");
    await row(page, dead.uncertain.id).waitFor();
    const uncertainRow = await row(page, dead.uncertain.id).innerText();
    expect(uncertainRow).toContain("Outcome uncertain — the destination may have received it");
    // Negative control: the dead letter that really failed with a 503 carries no uncertain note.
    const plainRow = await row(page, dead.deadLetter.id).innerText();
    expect(plainRow).not.toContain("Outcome uncertain");
    expect(wording.test(await page.content())).toBe(false);
    expect(wording.test(await mainText(page))).toBe(false);

    for (const delivery of [dead.uncertain, dead.deadLetter, dead.pending, dead.delivered]) {
      await page.goto(`/settings/notifications/deliveries/${delivery.id}`);
      await page.getByRole("table", { name: "Delivery attempts" }).waitFor();
      expect(wording.test(await page.content()), delivery.id).toBe(false);
      expect(wording.test(await mainText(page)), delivery.id).toBe(false);
    }

    await page.goto(`/settings/notifications/deliveries/${dead.uncertain.id}`);
    await page.getByRole("table", { name: "Delivery attempts" }).waitFor();
    const attempts = page.getByRole("table", { name: "Delivery attempts" });
    const second = attempts
      .getByRole("row")
      .filter({ hasText: "Destination did not answer in time" });
    expect(await second.innerText()).toContain(
      "Outcome uncertain — the destination may have received it",
    );
    expect(await second.locator('[data-status="uncertain"]').count()).toBe(1);
    // The first attempt was a plain 503: a failure, with no uncertain marker.
    const first = attempts.getByRole("row").filter({ hasText: "Destination answered 503" });
    expect(await first.innerText()).not.toContain("Outcome uncertain");
    expect(await first.locator('[data-status="failed"]').count()).toBe(1);
    expect(await page.locator('[data-status="dead_letter"]').count()).toBeGreaterThan(0);
    const summary = await mainText(page);
    expect(summary).toContain("This delivery is in the dead-letter queue.");
    expect(summary).toContain("It is independent of any Run verdict.");
    expect(summary).toContain(`ntd_`);
    expect(summary).toContain("Payload summary");
    expect(summary).toContain("Delivery attempts");
    // Requeue from the detail page works too and the state follows.
    await page.getByRole("button", { name: "Requeue" }).click();
    await page.locator('[data-status="pending"]').first().waitFor();
    expect(await page.getByRole("button", { name: "Requeue" }).count()).toBe(0);
    // An unknown delivery is the same not-found page as one the caller may not read.
    await page.goto("/settings/notifications/deliveries/ntd_00000000-0000-4000-8000-000000000000");
    await page.getByRole("heading", { level: 1, name: "Not found" }).waitFor();
  });

  it("OPS-011 a viewer can read the dead letters but Requeue is disabled with its reason and the API refuses it", async () => {
    const fresh = await seedNotifications(stack, { integrationName: "Viewer DLQ hook" });
    const handle = await portal(viewer);
    const { page } = handle;
    await page.goto("/settings/notifications");
    await page.getByRole("heading", { level: 1, name: "Notifications" }).waitFor();
    const letter = row(page, fresh.deadLetter.id);
    await letter.waitFor();
    // Integrations are admin-only: a distinct forbidden view, while the history stays readable.
    await page.locator(".view-forbidden").waitFor();
    expect(await page.getByRole("table", { name: "Notification integrations" }).count()).toBe(0);
    expect(await mainText(page)).not.toContain("Viewer DLQ hook");
    await letter.locator('[data-status="dead_letter"]').waitFor();
    const requeue = letter.getByRole("button", { name: /^Requeue / });
    expect(await requeue.getAttribute("aria-disabled")).toBe("true");
    expect(await letter.innerText()).toContain("Requeue needs the workspace admin role.");
    await requeue.click({ force: true });
    const retries = () => requestsTo(handle, /\/retry$/u);
    expect(retries().length).toBe(0);

    const member = await memberClient(viewer);
    const refused = await member.mutate("POST", `/v1/deliveries/${fresh.deadLetter.id}/retry`, {});
    expect(refused.status).toBe(403);
    const unchanged = await stack
      .ownerClient()
      .request("GET", `/v1/deliveries/${fresh.deadLetter.id}`);
    expect(unchanged.json<{ data: { state: string } }>().data.state).toBe("dead_letter");
    // Positive control: the owner's Requeue for the same kind of row is enabled.
    const owner = await portal();
    await owner.page.goto("/settings/notifications");
    const ownerRequeue = row(owner.page, fresh.deadLetter.id).getByRole("button", {
      name: /^Requeue /,
    });
    await ownerRequeue.waitFor();
    expect(await ownerRequeue.getAttribute("aria-disabled")).toBe("false");
  });
});

describe("integrations", () => {
  it("INT-004 a test delivery is labelled as a test, writes no delivery row, and an integration needs consent, can pause and resume, and ends access when revoked", async () => {
    const fixture = await seedNotifications(stack, { integrationName: "Test delivery hook" });
    const handle = await portal();
    const { page } = handle;
    await page.goto("/settings/notifications");
    const target = integrationRow(page, "Test delivery hook");
    await target.waitFor();
    await row(page, fixture.deadLetter.id).waitFor();
    expect(await target.innerText()).toContain("None yet");
    const deliveryRows = await page
      .getByRole("table", { name: "Deliveries" })
      .getByRole("row")
      .count();

    await target.getByRole("button", { name: /^Send test delivery/ }).click();
    const result = page.getByTestId("test-delivery-result");
    await result.waitFor();
    const text = await result.innerText();
    expect(text).toContain("Test delivery");
    expect(text).toContain("tst_");
    expect(wording.test(text)).toBe(false);
    // The integration row records the labelled test as its last test.
    await target.locator("td", { hasText: /Test delivery\s*Failed/u }).waitFor();
    expect(await target.innerText()).not.toContain("None yet");
    // A test is never a notification of record: the delivery history did not change.
    expect(await page.getByRole("table", { name: "Deliveries" }).getByRole("row").count()).toBe(
      deliveryRows,
    );
    const history = await stack.ownerClient().request("GET", "/v1/deliveries");
    expect(history.text).not.toContain("tst_");
    expect(history.text).not.toContain("test notification");
    expect(requestsTo(handle, /^POST \/v1\/integrations\/int_[^/]+\/test$/u).length).toBe(1);

    // Pause: the test control is disabled with its reason and the click sends nothing.
    await target.getByRole("button", { name: /^Pause / }).click();
    await target.locator('[data-status="paused"]').waitFor();
    const test = target.getByRole("button", { name: /^Send test delivery/ });
    expect(await test.getAttribute("aria-disabled")).toBe("true");
    expect(await target.innerText()).toContain("Resume the integration to send a test delivery.");
    await test.click({ force: true });
    expect(requestsTo(handle, /\/test$/u).length).toBe(1);
    await target.getByRole("button", { name: /^Resume / }).click();
    await target.locator('[data-status="active"]').waitFor();
    expect(await test.getAttribute("aria-disabled")).toBe("false");

    // Consent is required: without it nothing is sent to the server.
    await page.getByRole("button", { name: "New integration" }).click();
    await page.getByRole("textbox", { name: /^Name/u }).fill("No consent hook");
    await page.getByLabel("Run failed", { exact: true }).check();
    await page.getByLabel("Webhook URL").fill("https://hooks.s8.invalid/none");
    await page.getByLabel("Signing secret").selectOption({ index: 1 });
    const created = () => requestsTo(handle, /^POST \/v1\/integrations$/u).length;
    const before = created();
    await page.getByRole("button", { name: "Create integration" }).click();
    const summary = page.getByTestId("error-summary");
    await summary.waitFor();
    expect(await summary.innerText()).toContain("Grant notify:webhook");
    expect(created()).toBe(before);
    expect(await integrationRow(page, "No consent hook").count()).toBe(0);
    // With consent the same form creates the integration.
    await page.getByRole("checkbox", { name: /notify:webhook/u }).check();
    await page.getByRole("button", { name: "Create integration" }).click();
    await integrationRow(page, "No consent hook").waitFor();
    expect(created()).toBe(before + 1);

    // Revoke asks first; revoking is final and ends access with no fallback.
    await target.getByRole("button", { name: /^Revoke / }).click();
    const dialog = page.getByRole("dialog", { name: "Revoke this integration?" });
    await dialog.waitFor();
    await dialog.getByRole("button", { name: "Cancel" }).click();
    await dialog.waitFor({ state: "hidden" });
    await target.locator('[data-status="active"]').waitFor();
    await target.getByRole("button", { name: /^Revoke / }).click();
    await dialog.waitFor();
    await dialog.getByRole("button", { name: "Revoke integration" }).click();
    await target.locator('[data-status="revoked"]').waitFor();
    for (const name of [/^Edit /, /^Send test delivery/, /^Pause |^Resume /, /^Revoke /]) {
      expect(
        await target.getByRole("button", { name }).getAttribute("aria-disabled"),
        String(name),
      ).toBe("true");
    }
    expect(await target.innerText()).toContain("Revoked integrations are final.");
    const stored = await stack.ownerClient().request("GET", "/v1/integrations");
    const revoked = stored
      .json<{
        data: {
          items: {
            id: string;
            state: string;
            consent: { scopes: string[] };
            secretRefs: string[];
          }[];
        };
      }>()
      .data.items.find((item) => item.id === fixture.integrationId);
    expect(revoked).toMatchObject({ state: "revoked", consent: { scopes: [] }, secretRefs: [] });
    expect(handle.diagnostics.pageErrors).toEqual([]);
  });

  it("SEC-013 hostile integration and worker names render as inert text and no script runs", async () => {
    const hostileIntegration = `${hostileImage} Hostile hook`;
    const hostileWorker = `Hostile worker ${hostileImage}<script>window.__pwned='script'</script>`;
    const fixture = await seedNotifications(stack, { integrationName: hostileIntegration });
    await seedReadyWorker(stack, hostileWorker);
    const handle = await portal();
    const { page } = handle;

    await page.goto("/settings/notifications");
    const hostileRow = integrationRow(page, "Hostile hook");
    await hostileRow.waitFor();
    expect(await hostileRow.first().innerText()).toContain("<img src=x");
    expect(await page.locator("main img").count()).toBe(0);
    expect(await pwned(page)).toBeUndefined();
    // The name is also an option in the filter, a dialog line and the aria-label of its controls.
    const option = page.getByLabel("Integration", { exact: true }).locator("option", {
      hasText: "Hostile hook",
    });
    expect(await option.count()).toBe(1);
    await hostileRow
      .first()
      .getByRole("button", { name: /^Revoke / })
      .click();
    const dialog = page.getByRole("dialog", { name: "Revoke this integration?" });
    await dialog.waitFor();
    expect(await dialog.innerText()).toContain("<img src=x");
    expect(await dialog.locator("img").count()).toBe(0);
    await dialog.getByRole("button", { name: "Cancel" }).click();
    await page.goto(`/settings/notifications/deliveries/${fixture.deadLetter.id}`);
    await page.getByRole("table", { name: "Delivery attempts" }).waitFor();
    expect(await page.locator("main img").count()).toBe(0);
    expect(await pwned(page)).toBeUndefined();

    await page.goto("/settings/workers");
    const workerRow = row(page, "Hostile worker");
    await workerRow.waitFor();
    expect(await workerRow.first().innerText()).toContain("<img src=x");
    expect(await page.locator("main img, main script").count()).toBe(0);
    expect(await pwned(page)).toBeUndefined();
    await workerRow
      .first()
      .getByRole("button", { name: /^Revoke / })
      .click();
    const revoke = page.getByRole("dialog", { name: "Revoke this worker?" });
    await revoke.waitFor();
    expect(await revoke.locator("img, script").count()).toBe(0);
    expect(await pwned(page)).toBeUndefined();
    // Negative control: a plain name is shown as typed, so the checks above are not an empty page.
    await revoke.getByRole("button", { name: "Cancel" }).click();
    expect(await page.getByRole("table", { name: "Workers" }).innerText()).toContain(
      "keyboard-worker-1",
    );
    expect(handle.diagnostics.pageErrors).toEqual([]);
  });
});

describe("network", () => {
  const templates = routeCatalog.map((route) => ({
    method: route.method,
    pattern: new RegExp(`^/v1${route.path.replace(/\{[^}]+\}/gu, "[^/]+")}$`, "u"),
  }));
  const catalogued = (entry: string) => {
    const [method = "", target = ""] = entry.split(" ");
    const path = target.split("?")[0] ?? "";
    return templates.some((template) => template.method === method && template.pattern.test(path));
  };

  it("INT-004 REQ-038 every /v1 request the pages made is a catalog route and nothing else was called", async () => {
    // Negative controls first: the matcher rejects an unknown path and a method the route lacks.
    expect(catalogued("GET /v1/workers/diagnostics/export")).toBe(false);
    expect(catalogued("DELETE /v1/workers/wrk_1")).toBe(false);
    expect(catalogued("GET /v1/private/workers")).toBe(false);
    expect(catalogued("POST /v1/workers/wrk_1/drain")).toBe(true);

    const requests = open.flatMap((handle) => handle.diagnostics.requests);
    const api = requests.filter((entry) => entry.split(" ")[1]?.startsWith("/v1/"));
    const unknown = [...new Set(api.filter((entry) => !catalogued(entry)))];
    expect(unknown).toEqual([]);
    // Positive control: the pages did call the routes this slice owns, so the check is not vacuous.
    const used = new Set(
      api.map((entry) => entry.split("?")[0]?.replace(/(wrk|ntd|int|prj)_[0-9a-f-]+/gu, "$1_ID")),
    );
    for (const expected of [
      "GET /v1/workers",
      "POST /v1/workers",
      "POST /v1/workers/wrk_ID/drain",
      "POST /v1/workers/wrk_ID/revoke",
      "GET /v1/integrations",
      "POST /v1/integrations",
      "PATCH /v1/integrations/int_ID",
      "POST /v1/integrations/int_ID/test",
      "GET /v1/deliveries",
      "GET /v1/deliveries/ntd_ID",
      "POST /v1/deliveries/ntd_ID/retry",
      "GET /v1/secrets",
      "GET /v1/projects",
    ])
      expect(used, expected).toContain(expected);
    // Nothing besides the portal's own origin was contacted.
    for (const handle of open) expect(handle.diagnostics.failedRequests).toEqual([]);
  });
});
