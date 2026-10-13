import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  type AutomationWorld,
  createListInPortal,
  expectCatalogRequests,
  seedAutomationWorld,
  setProjectRestrictions,
} from "./automation-world.js";
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
 * Lists and schedules in the real portal (UX-041…043, UX-049, M4-06): PostgreSQL, the server
 * profile as a child process, a worker, and a TLS proxy. Everything the pages show comes from
 * catalog `/v1` routes; the journeys below only seed through the same public surface.
 */
let stack: ServerStack;
let world: AutomationWorld;
let qa: StackUser;
let planner: StackUser;
let viewer: StackUser;
const open: OpenPortal[] = [];

beforeAll(async () => {
  stack = await startServerStack({ worker: true });
  world = await seedAutomationWorld(stack.ownerClient());
  qa = await stack.addMember("maintainer", {
    projectRestrictions: [world.a.projectId, world.b.projectId],
  });
  // The server budgets writes per actor; the schedule journeys act as their own member so the seeding above never drains their budget.
  planner = await stack.addMember("maintainer", {
    projectRestrictions: [world.a.projectId, world.b.projectId],
  });
  viewer = await stack.addMember("viewer");
}, 600_000);

afterAll(async () => {
  for (const portal of open.splice(0)) await portal.close().catch(() => undefined);
  await stack?.stop();
});

async function portal(user: { login: string; password: string }, signIn = true) {
  const opened = await openPortal(
    { baseUrl: stack.baseUrl, spkiSha256: stack.ca.spkiSha256 },
    user,
    {
      signIn,
    },
  );
  open.push(opened);
  return opened;
}

interface Envelope<T> {
  data: T;
}
interface BatchView {
  id: string;
  memberRuns: string[];
  /** Members declared as not dispatched, with their reason. */
  rejectedMembers: { memberKey: string; reasonCode: string }[];
  /** The expansion frozen at admission: members, revisions and credential mapping. */
  selectionSnapshot: { suite: { members: unknown[]; mapping: unknown[] } };
  aggregate: { gate: string; counts: Record<string, number> };
}

async function batch(id: string): Promise<BatchView> {
  const response = await stack.ownerClient().request("GET", `/v1/batches/${id}`);
  expect(response.status).toBe(200);
  return response.json<Envelope<BatchView>>().data;
}

describe("lists in the portal", () => {
  let suiteId = "";

  // Whatever a journey did to the QA engineer's access, the next one starts with both projects.
  afterEach(async () => {
    await setProjectRestrictions(stack.ownerClient(), stack.workspaceId, qa.principalId, [
      world.a.projectId,
      world.b.projectId,
    ]);
  });

  it("REQ-034 UX-041 UX-042 a cross-project list names an explicit staging per project, shows what it expands to and runs one frozen batch", async () => {
    const { page, diagnostics } = await portal(qa);
    suiteId = await createListInPortal(page, world, "Nightly across projects");

    // The expansion is what a run would freeze: four tests, one mapping row per project.
    const tests = page.getByRole("table", { name: "Tests that would run" });
    await tests.waitFor();
    expect(await tests.getByRole("row").count()).toBe(5);
    const mapping = page.getByRole("table", {
      name: "Environment and credential mapping per project",
    });
    const mappingRows = mapping.getByRole("row");
    expect(await mappingRows.count()).toBe(3);
    const mappingText = await mapping.innerText();
    // Same environment name, two different origins and two different credential mappings.
    expect(mappingText.match(/staging/g)?.length).toBeGreaterThanOrEqual(2);
    expect(mappingText).toContain(world.a.origin);
    expect(mappingText).toContain(world.b.origin);
    expect(mappingText.match(/values are never shown/g)?.length).toBe(2);
    const expansion = await stack.ownerClient().request("GET", `/v1/suites/${suiteId}/expansion`);
    const mappings =
      expansion.json<Envelope<{ mapping: { secretRefs: string[] }[] }>>().data.mapping;
    expect(mappings.map((row) => row.secretRefs)).toEqual(
      expect.arrayContaining([[world.a.secretId], [world.b.secretId]]),
    );
    expect(await page.content()).not.toContain("secret-a-");

    await page.getByRole("button", { name: "Run list" }).click();
    const dialog = page.getByRole("dialog");
    await dialog.getByRole("button", { name: "Run list" }).click();
    const receipt = page.getByRole("status").filter({ hasText: "admitted" });
    await receipt.waitFor();
    expect(await receipt.innerText()).toContain("4 of 4 entries were dispatched");
    const batchId = (await receipt.locator("code").first().innerText()).trim();
    const frozen = await batch(batchId);
    expect(frozen.memberRuns).toHaveLength(4);
    expect(frozen.rejectedMembers).toEqual([]);

    // Editing the list after dispatch changes what it expands to, never the admitted batch.
    await page.getByRole("link", { name: "Edit list" }).click();
    await page.locator("#list-name-contains").fill("checkout");
    await page.getByRole("button", { name: "Save list" }).click();
    await page.getByRole("heading", { level: 1, name: "Nightly across projects" }).waitFor();
    await tests.waitFor();
    await expect.poll(() => tests.getByRole("row").count()).toBe(3);
    const after = await batch(batchId);
    expect({
      runs: after.memberRuns,
      suite: after.selectionSnapshot.suite,
      rejected: after.rejectedMembers,
    }).toEqual({
      runs: frozen.memberRuns,
      suite: frozen.selectionSnapshot.suite,
      rejected: frozen.rejectedMembers,
    });
    expect(frozen.selectionSnapshot.suite.members).toHaveLength(4);

    expectCatalogRequests(diagnostics.requests);
    expect(diagnostics.pageErrors).toEqual([]);
  });

  it("UX-043 J09 revoking project B before the next dispatch is declared, never silently omitted, and the confirmed subset leaves a failed gate", async () => {
    const { page } = await portal(qa);
    // Negative control first: with both projects reachable the page offers a full run.
    await page.goto(`/lists/${suiteId}`);
    await page.getByRole("table", { name: "Tests that would run" }).waitFor();
    expect(await page.getByRole("table", { name: "Excluded entries" }).count()).toBe(0);

    await setProjectRestrictions(stack.ownerClient(), stack.workspaceId, qa.principalId, [
      world.a.projectId,
    ]);
    await page.reload();
    const excluded = page.getByRole("table", { name: "Excluded entries" });
    await excluded.waitFor();
    const excludedText = await excluded.innerText();
    expect(excludedText).toContain("access denied");
    expect(await page.getByText("Some entries are unavailable").count()).toBe(1);

    // The run action explains why it is unavailable until the subset is confirmed.
    const run = page.getByRole("button", { name: "Run list" });
    expect(await run.getAttribute("aria-disabled")).toBe("true");
    expect(await page.getByText("Confirm the subset below").count()).toBe(1);
    await run.click({ force: true });
    expect(await page.getByRole("dialog").count()).toBe(0);

    await page.getByLabel(/Run only the available tests/).check();
    expect(await run.getAttribute("aria-disabled")).toBe("false");
    await run.click();
    await page.getByRole("dialog").getByRole("button", { name: "Run list" }).click();
    const receipt = page.getByRole("status").filter({ hasText: "admitted" });
    await receipt.waitFor();
    const text = await receipt.innerText();
    expect(text).toContain("Not dispatched: 1, so the gate stays failed");
    const batchId = (await receipt.locator("code").first().innerText()).trim();
    const view = await batch(batchId);
    // The list was narrowed to `checkout` tests by the previous journey: one per project.
    expect(text).toContain("1 of 2 entries were dispatched");
    expect(view.rejectedMembers).toHaveLength(1);
    expect(view.memberRuns).toHaveLength(1);
    expect(view.aggregate.gate).toBe("failed");

    // A's access never authorizes B: running B's test directly is refused.
    const token = await stack.issueToken(qa.principalId, ["R", "W", "X"]);
    const refused = await stack.anonymous().request("POST", "/v1/runs", {
      cookies: false,
      headers: {
        authorization: `Bearer ${token}`,
        "idempotency-key": crypto.randomUUID(),
      },
      body: {
        testId: world.b.testIds[0],
        environmentId: world.b.environmentId,
        mode: "replay",
        healingPolicy: "off",
        origin: "api",
      },
    });
    expect([403, 404]).toContain(refused.status);
    const allowed = await stack.anonymous().request("POST", "/v1/runs", {
      cookies: false,
      headers: {
        authorization: `Bearer ${token}`,
        "idempotency-key": crypto.randomUUID(),
      },
      body: {
        testId: world.a.testIds[0],
        environmentId: world.a.environmentId,
        mode: "replay",
        healingPolicy: "off",
        origin: "api",
      },
    });
    expect(allowed.status).toBe(202);
  });

  it("UX-005 UX-042 a viewer reads lists but every action explains why it is unavailable", async () => {
    const { page } = await portal(viewer);
    await page.goto("/lists");
    await page.getByRole("heading", { level: 1, name: "Lists" }).waitFor();
    await page.getByRole("link", { name: "Nightly across projects" }).waitFor();
    const create = page.getByRole("button", { name: "New list" });
    expect(await create.getAttribute("aria-disabled")).toBe("true");
    expect(await page.getByText("Your role cannot create lists").count()).toBe(1);

    await page.getByRole("link", { name: "Nightly across projects" }).click();
    await page.getByRole("heading", { level: 1, name: "Nightly across projects" }).waitFor();
    for (const label of ["Run list", "Edit list", "Archive list"]) {
      const button = page.getByRole("button", { name: label });
      expect(await button.getAttribute("aria-disabled"), label).toBe("true");
    }
    // The server enforces the same rule: a viewer's run request is refused.
    const token = await stack.issueToken(viewer.principalId, ["R"]);
    const refused = await stack.anonymous().request("POST", `/v1/suites/${suiteId}/runs`, {
      cookies: false,
      headers: { authorization: `Bearer ${token}`, "idempotency-key": crypto.randomUUID() },
      body: {},
    });
    expect(refused.status).toBe(403);
  });
});

describe("schedules in the portal", () => {
  let scheduleId = "";

  it("REQ-035 UX-049 OPS-016 a schedule previews its next ten occurrences, refuses an unknown time zone and saves a revision", async () => {
    const { page } = await portal(planner);
    await page.goto("/schedules/new");
    await page.getByRole("heading", { level: 1, name: "New schedule" }).waitFor();
    await page.locator("#schedule-name").fill("Weekday smoke");
    await page.locator("#schedule-suite").selectOption({ label: "Nightly across projects" });
    await page.locator("#schedule-cron").fill("30 2 * * 1-5");
    await page.locator("#schedule-timezone").fill("America/New_York");
    await page.getByRole("button", { name: "Preview next ten occurrences" }).click();
    const preview = page.getByRole("table", { name: "Next occurrences" });
    await preview.waitFor();
    expect(await preview.getByRole("row").count()).toBe(11);
    expect(await page.getByText(/Time zone America\/New_York/).count()).toBe(1);

    // An unknown zone is refused, never replaced by UTC, and nothing is saved.
    await page.locator("#schedule-timezone").fill("Mars/Olympus");
    await page.getByRole("button", { name: "Preview next ten occurrences" }).click();
    await page
      .getByRole("alert")
      .filter({ hasText: /time ?zone/i })
      .waitFor();
    await page.getByRole("button", { name: "Create schedule" }).click();
    await page.getByTestId("error-summary").waitFor();
    expect(new URL(page.url()).pathname).toBe("/schedules/new");
    const none = await stack.ownerClient().request("GET", "/v1/schedules");
    expect(JSON.stringify(none.json())).not.toContain("Weekday smoke");

    await page.locator("#schedule-timezone").fill("America/New_York");
    await page.getByRole("button", { name: "Create schedule" }).click();
    await page.waitForURL((url) => /^\/schedules\/sch_[^/]+$/.test(url.pathname));
    scheduleId = new URL(page.url()).pathname.split("/").pop() ?? "";
    await page.getByRole("heading", { level: 1, name: "Weekday smoke" }).waitFor();
    const next = page.getByRole("table", { name: "Next ten occurrences" });
    await next.waitFor();
    expect(await next.getByRole("row").count()).toBe(11);
    const revisions = page.getByRole("table", { name: "Revisions" });
    expect(await revisions.getByRole("row").count()).toBe(2);
    expect(await page.getByRole("button", { name: "Edit schedule" }).count()).toBe(0);
    await page.getByRole("link", { name: "Edit schedule" }).waitFor();
  });

  it("OPS-018 OPS-019 pausing asks for confirmation, records the pause and stops the preview; resuming restores it", async () => {
    const { page } = await portal(planner);
    await page.goto(`/schedules/${scheduleId}`);
    await page.getByRole("heading", { level: 1, name: "Weekday smoke" }).waitFor();
    await page.getByRole("button", { name: "Pause", exact: true }).click();
    const dialog = page.getByRole("dialog");
    expect(await dialog.innerText()).toContain("not replayed on resume");
    await dialog.getByRole("button", { name: "Pause schedule" }).click();
    await page.getByText("Nothing is scheduled").waitFor();
    expect(await page.getByText("Paused", { exact: true }).count()).toBeGreaterThan(0);
    await page.getByRole("button", { name: "Resume" }).click();
    await page.getByRole("dialog").getByRole("button", { name: "Resume schedule" }).click();
    await page.getByRole("table", { name: "Next ten occurrences" }).waitFor();
    expect(await page.getByText("Nothing is scheduled").count()).toBe(0);
  });

  it("OPS-017 OPS-019 the firing history shows a real scheduled firing with its outcome and batch", async () => {
    // Real time on purpose: the scheduler controller runs in the server child process and its
    // lease and tick use the host clock, so the only way to see a firing is to wait for it.
    const anchor = new Date(Date.now() + 3000).toISOString();
    const created = await stack.ownerClient().mutate("POST", "/v1/schedules", {
      name: "Every minute",
      selection: { kind: "suite", suiteId: (await firstSuiteId()) ?? "" },
      trigger: { kind: "interval", everySeconds: 60, anchor },
    });
    expect(created.status).toBe(201);
    const id = created.json<Envelope<{ id: string }>>().data.id;
    const { page } = await portal(stack.owner);
    await page.goto(`/schedules/${id}`);
    const history = page.getByRole("table", { name: "Firing history" });
    // The first occurrence is `claimed` for a moment before the batch is admitted.
    await expect
      .poll(
        async () => {
          await page.reload();
          await page.getByRole("heading", { level: 1, name: "Every minute" }).waitFor();
          const table = page.getByRole("table", { name: "Firing history" });
          if ((await table.count()) === 0) return "none";
          const rows = await table.getByRole("row").allInnerTexts();
          return (
            rows.find((row) => /Dispatched|Skipped|Overlap|Blocked|Misfire/.test(row)) ?? "none"
          );
        },
        { timeout: 120_000, intervals: [4000] },
      )
      .toMatch(/Dispatched/);
    const dispatched = (await history.getByRole("row").allInnerTexts()).find((row) =>
      row.includes("Dispatched"),
    );
    expect(dispatched).toContain("bat_");
    await stack.ownerClient().mutate(
      "POST",
      `/v1/schedules/${id}/pause`,
      {},
      {
        "if-match": `"${(await scheduleVersion(id)) ?? 1}"`,
      },
    );
  }, 240_000);

  it("UX-005 a viewer reads schedules but cannot change them", async () => {
    const { page } = await portal(viewer);
    await page.goto(`/schedules/${scheduleId}`);
    await page.getByRole("heading", { level: 1, name: "Weekday smoke" }).waitFor();
    for (const label of ["Edit schedule", "Pause", "Archive"]) {
      const button = page.getByRole("button", { name: label, exact: true });
      expect(await button.getAttribute("aria-disabled"), label).toBe("true");
    }
    expect(await page.getByText("needs write and execute access").count()).toBeGreaterThan(0);
  });
});

async function firstSuiteId(): Promise<string | null> {
  const response = await stack.ownerClient().request("GET", "/v1/suites");
  const data = response.json<Envelope<{ items: { id: string }[] }>>().data;
  return data.items[0]?.id ?? null;
}

async function scheduleVersion(id: string): Promise<number | null> {
  const response = await stack.ownerClient().request("GET", `/v1/schedules/${id}`);
  return response.json<Envelope<{ version: number }>>().data.version ?? null;
}

describe("accessibility of lists and schedules", () => {
  it("UX-051 UX-052 every list and schedule page is axe clean on desktop and reflows at 320 px", async () => {
    const { page } = await portal(stack.owner);
    const suite = (await firstSuiteId()) ?? "";
    const paths = [
      "/lists",
      "/lists/new",
      `/lists/${suite}`,
      `/lists/${suite}/edit`,
      "/schedules",
      "/schedules/new",
    ];
    const schedules = await stack.ownerClient().request("GET", "/v1/schedules");
    const first = schedules.json<Envelope<{ items: { id: string }[] }>>().data.items[0];
    if (first) paths.push(`/schedules/${first.id}`, `/schedules/${first.id}/edit`);
    for (const path of paths) {
      await page.goto(path);
      await page.getByRole("heading", { level: 1 }).first().waitFor();
      await page.waitForLoadState("networkidle");
      await expectAccessible(page, `desktop ${path.replace(/(sui|sch)_[^/]+/, "$1_ID")}`);
    }
    await atViewport(page, { width: 320, zoom: 2 });
    for (const path of paths) {
      await page.goto(path);
      await page.getByRole("heading", { level: 1 }).first().waitFor();
      await page.waitForLoadState("networkidle");
      await expectNoPageOverflow(page, path);
    }
  });

  it("UX-051 a list can be run with the keyboard alone and the focus ring is visible", async () => {
    const { page } = await portal(qa);
    const suite = (await firstSuiteId()) ?? "";
    await page.goto(`/lists/${suite}`);
    await page.getByRole("table", { name: "Tests that would run" }).waitFor();
    const keys = await keyboardOnly(page);
    const reached = await keys.tabTo((focused) => focused.name === "Run list", 60);
    expect(reached).toBeGreaterThan(0);
    expect((await keys.focused()).focusRing).toBe(true);
    await keys.press("Enter");
    const dialog = page.getByRole("dialog");
    await dialog.waitFor();
    const onDialog = await keys.focused();
    if (!(onDialog.name === "Run list" && onDialog.tag === "button"))
      await keys.tabTo((focused) => focused.name === "Run list" && focused.tag === "button", 10);
    await keys.press("Enter");
    await page.getByRole("status").filter({ hasText: "admitted" }).waitFor();
  });
});
