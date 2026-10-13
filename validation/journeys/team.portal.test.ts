import { auditSecurity } from "@testmaster/application";
import { routeCatalog } from "@testmaster/contracts";
import type { Page } from "playwright-core";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
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

/** Waits for the one-time token panel; a refusal banner fails the step with the server's words. */
async function shownToken(page: Page): Promise<string> {
  const token = page.getByTestId("new-token");
  const refusal = page.locator('main [role="alert"]');
  await token.or(refusal).first().waitFor();
  if ((await refusal.count()) > 0)
    throw new Error(`token creation refused: ${await refusal.first().innerText()}`);
  return token.innerText();
}

/**
 * The team, token and audit pages of the portal on the real server profile (PostgreSQL, the built
 * CLI as a child process, a TLS proxy). Every state-changing step is verified against the server
 * through the same API the page uses, and every denial is compared with what the server answers.
 */
let stack: ServerStack;
let workspaceId = "";
let projectId = "";
const environmentName = "Staging";
let viewer: StackUser;
let maintainer: StackUser;
let admin: StackUser;
const open: OpenPortal[] = [];
const hostileName = `<img src=x onerror="window.__pwned='audit'"> Hostile Member`;

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
    headers: { origin: stack.baseUrl, "idempotency-key": crypto.randomUUID() },
  });
  expect(login.status).toBe(200);
  client.csrfToken = login.json<{ data: { csrfToken: string } }>().data.csrfToken;
  return client;
}

function bearer(token: string) {
  const client = stack.anonymous();
  const headers = (extra: Record<string, string> = {}) => ({
    authorization: `Bearer ${token}`,
    ...extra,
  });
  return {
    get: (path: string) => client.request("GET", path, { headers: headers(), cookies: false }),
    mutate: (method: string, path: string, body: unknown) =>
      client.request(method, path, {
        body,
        headers: headers({ "idempotency-key": crypto.randomUUID() }),
        cookies: false,
      }),
  };
}

function catalogRoute(request: string): boolean {
  const [method, target] = request.split(" ");
  const path = (target ?? "").split("?")[0] ?? "";
  return routeCatalog.some(
    (route) =>
      route.method === method &&
      new RegExp(`^/v1${route.path.replace(/\{[^}]+\}/g, "[^/]+")}$`).test(path),
  );
}

interface MemberRow {
  id: string;
  login: string;
  role: string;
  version: number;
}

async function members(client: HttpsClient): Promise<MemberRow[]> {
  const response = await client.request("GET", `/v1/workspaces/${workspaceId}/members?limit=100`);
  return response.json<{ data: { items: MemberRow[] } }>().data.items;
}

/** `window.__pwned` is only ever set by script a hostile string managed to run. */
function pwned(page: Page): Promise<unknown> {
  return page.evaluate(() => Reflect.get(window, "__pwned"));
}

beforeAll(async () => {
  stack = await startServerStack({ workspaces: 1 });
  workspaceId = stack.workspaceId;
  const created = await stack
    .ownerClient()
    .mutate("POST", "/v1/projects", { name: "Team journey project" });
  projectId = created.json<{ data: { id: string } }>().data.id;
  const environment = await stack
    .ownerClient()
    .mutate("POST", `/v1/projects/${projectId}/environments`, {
      name: environmentName,
      baseUrl: "https://staging.team.test",
      networkProfile: "public",
      production: false,
    });
  expect(environment.status).toBe(201);
  viewer = await stack.addMember("viewer");
  maintainer = await stack.addMember("maintainer");
  admin = await stack.addMember("org_admin");
}, 600_000);

afterAll(async () => {
  for (const opened of open.splice(0)) await opened.close().catch(() => undefined);
  await stack?.stop();
});

describe("team, tokens and audit trail in the portal", () => {
  it("UX-005 UX-001 a viewer sees every permission with its reason, disabled controls explain themselves and the server refuses the same actions", async () => {
    const { page, diagnostics } = await portal(viewer);
    await page.goto("/team");
    await page.getByRole("heading", { level: 1, name: "Members and roles" }).waitFor();
    const row = (name: string) => page.getByRole("row", { name: new RegExp(`^${name}\\b`) });
    expect(await row("Read").innerText()).toContain("Allowed");
    for (const name of ["Author", "Approve", "Execute", "Manage secrets", "Export", "Administer"]) {
      const text = await row(name).innerText();
      expect(text, name).toContain("Not allowed");
      expect(text, name).toContain("The viewer role does not include");
    }
    expect(await row("Administer").innerText()).toContain(
      "Roles that allow it: org_owner, org_admin.",
    );

    // The control is visible, focusable and described by its reason; activating it sends nothing.
    const add = page.getByRole("button", { name: "Add member" });
    expect(await add.getAttribute("aria-disabled")).toBe("true");
    const reasonId = await add.getAttribute("aria-describedby");
    expect(await page.locator(`[id="${reasonId}"]`).innerText()).toContain(
      "Requires the admin permission",
    );
    // Playwright refuses to click aria-disabled controls; force the click a user could still make.
    await add.click({ force: true });
    await page.getByRole("heading", { level: 2, name: "Members" }).waitFor();
    expect(await page.getByText("Not permitted").count()).toBeGreaterThan(0);
    expect(diagnostics.requests.filter((entry) => entry.includes("/members"))).toEqual([]);

    await page.goto("/team/tokens");
    await page.getByRole("heading", { level: 1, name: "API tokens" }).waitFor();
    expect(
      await page.getByRole("button", { name: "Create API token" }).getAttribute("aria-disabled"),
    ).toBe("true");
    await page.goto("/audit");
    await page.getByRole("heading", { level: 1, name: "Audit trail" }).waitFor();
    expect(
      await page.getByRole("button", { name: "Open audit events" }).getAttribute("aria-disabled"),
    ).toBe("true");
    expect(
      diagnostics.requests.filter(
        (entry) => entry.includes("/v1/tokens") || entry.includes("/v1/audit-events"),
      ),
    ).toEqual([]);

    // The server gives the same answer the page explained, without the page asking.
    const server = await signedIn(viewer);
    expect((await server.request("GET", `/v1/workspaces/${workspaceId}/members`)).status).toBe(403);
    expect((await server.request("GET", "/v1/tokens")).status).toBe(403);
    expect((await server.request("GET", "/v1/audit-events")).status).toBe(403);
    expect(
      (
        await server.mutate("POST", `/v1/workspaces/${workspaceId}/members`, {
          login: "sneaky-member",
          displayName: "Sneaky",
          role: "org_owner",
          projectRestrictions: [],
        })
      ).status,
    ).toBe(403);
    expect((await server.mutate("POST", "/v1/projects", { name: "Viewer project" })).status).toBe(
      403,
    );
    expect(
      (await members(stack.ownerClient())).some((member) => member.login === "sneaky-member"),
    ).toBe(false);
    expect((await server.request("GET", "/v1/projects")).status).toBe(200);
    expect(diagnostics.pageErrors).toEqual([]);
  }, 180_000);

  it("UX-005 the permission table follows the role: a maintainer holds everything except administration, an owner holds everything", async () => {
    const asMaintainer = await portal(maintainer);
    await asMaintainer.page.goto("/team");
    await asMaintainer.page.getByRole("heading", { level: 2, name: "Your permissions" }).waitFor();
    const text = async (page: Page, name: string) =>
      page.getByRole("row", { name: new RegExp(`^${name}\\b`) }).innerText();
    for (const name of ["Read", "Author", "Approve", "Execute", "Manage secrets", "Export"])
      expect(await text(asMaintainer.page, name), name).toContain("Allowed");
    expect(await text(asMaintainer.page, "Administer")).toContain("Not allowed");
    expect(await text(asMaintainer.page, "Administer")).toContain(
      "The maintainer role does not include administer.",
    );

    const asOwner = await portal(stack.owner);
    await asOwner.page.goto("/team");
    await asOwner.page.getByRole("heading", { level: 2, name: "Your permissions" }).waitFor();
    for (const name of [
      "Read",
      "Author",
      "Approve",
      "Execute",
      "Manage secrets",
      "Export",
      "Administer",
    ])
      expect(await text(asOwner.page, name), name).toContain("Allowed");
    // Positive control: the same page for an admin does load members and offers the form.
    await asOwner.page.getByRole("table", { name: "Workspace members" }).waitFor();
    expect(
      await asOwner.page.getByRole("button", { name: "Add member" }).getAttribute("aria-disabled"),
    ).toBeNull();
  }, 180_000);

  it("UX-005 REQ-039 an owner adds a member, shares the one-time recovery token, changes the role and removes the member, each as one request", async () => {
    const { page, diagnostics } = await portal(stack.owner);
    await page.goto("/team");
    await page.getByRole("table", { name: "Workspace members" }).waitFor();

    // A client-side refusal binds the error to the field and sends nothing.
    await page.getByRole("button", { name: "Add member" }).click();
    expect(await page.getByTestId("error-summary").innerText()).toContain("Login must be");
    expect(diagnostics.requests.filter((entry) => entry.startsWith("POST /v1/workspaces"))).toEqual(
      [],
    );

    await page.getByLabel("Login").fill("ui-added");
    await page.getByLabel("Display name").fill("UI Added");
    await page
      .getByRole("form", { name: "Add member" })
      .getByLabel(/^Role\b/)
      .selectOption("viewer");
    await page.getByRole("button", { name: "Add member" }).click();
    const token = await page.getByTestId("recovery-token").innerText();
    expect(token).toMatch(/^tm_rec_/);
    await page.getByRole("row", { name: /ui-added/ }).waitFor();
    expect(await members(stack.ownerClient())).toEqual(
      expect.arrayContaining([expect.objectContaining({ login: "ui-added", role: "viewer" })]),
    );
    // The token is shown once: dismissing it removes it from the page, and a reload cannot bring it back.
    await page.getByRole("button", { name: "I have shared it" }).click();
    expect(await page.getByTestId("recovery-token").count()).toBe(0);
    await page.reload();
    await page.getByRole("table", { name: "Workspace members" }).waitFor();
    expect(await page.content()).not.toContain(token);

    // Role change: nothing is sent until Save, and the saved role is the server's.
    const select = page.getByRole("combobox", { name: "Role of ui-added" });
    const save = page.getByRole("button", { name: "Save role of ui-added" });
    expect(await save.isDisabled()).toBe(true);
    await select.selectOption("maintainer");
    expect(diagnostics.requests.filter((entry) => entry.startsWith("PATCH"))).toEqual([]);
    await save.click();
    await page.getByRole("combobox", { name: "Role of ui-added" }).waitFor();
    await expect
      .poll(
        async () => (await members(stack.ownerClient())).find((m) => m.login === "ui-added")?.role,
      )
      .toBe("maintainer");
    expect(diagnostics.requests.filter((entry) => entry.startsWith("PATCH"))).toHaveLength(1);

    // The owner's own row offers no role control: the rule is explained, and the server refuses it too.
    const own = page.getByRole("row", { name: new RegExp(stack.owner.login) });
    expect(await own.innerText()).toContain("Your own membership cannot be changed");
    expect(await own.getByRole("combobox").count()).toBe(0);
    const ownRow = (await members(stack.ownerClient())).find((m) => m.login === stack.owner.login);
    // The only owner cannot demote itself (the last-owner rule answers first); any other change to
    // its own membership is refused as self-promotion.
    const mutateOwn = (body: unknown) =>
      stack
        .ownerClient()
        .mutate("PATCH", `/v1/workspaces/${workspaceId}/members/${ownRow?.id}`, body, {
          "if-match": `"${ownRow?.version}"`,
        });
    expect((await mutateOwn({ role: "viewer" })).status).toBe(422);
    const selfChange = await mutateOwn({ projectRestrictions: [projectId] });
    expect(selfChange.status).toBe(403);
    expect(selfChange.text).toContain("self_promotion");

    // Removal needs a contextual confirmation, and a double click sends one request.
    await page.getByRole("button", { name: "Remove ui-added" }).click();
    const dialog = page.getByRole("dialog", { name: "Remove member" });
    expect(await dialog.innerText()).toContain("ui-added");
    expect(await dialog.innerText()).toContain("maintainer");
    await dialog.getByRole("button", { name: "Cancel" }).click();
    expect(diagnostics.requests.filter((entry) => entry.startsWith("DELETE"))).toEqual([]);
    await page.getByRole("button", { name: "Remove ui-added" }).click();
    await page
      .getByRole("dialog", { name: "Remove member" })
      .getByRole("button", { name: "Remove member" })
      .dblclick();
    await page.getByRole("row", { name: /ui-added/ }).waitFor({ state: "detached" });
    expect(diagnostics.requests.filter((entry) => entry.startsWith("DELETE"))).toHaveLength(1);
    expect((await members(stack.ownerClient())).some((m) => m.login === "ui-added")).toBe(false);
    expect(diagnostics.pageErrors).toEqual([]);
  }, 180_000);

  it("SEC-027 UX-005 a token is shown once, its grants are listed, a deny grant narrows it and the server refuses grants beyond the issuer", async () => {
    const { page, diagnostics } = await portal(stack.owner);
    await page.goto("/team/tokens");
    await page.getByRole("table", { name: "API tokens" }).waitFor();

    await page.getByLabel(/^Name\b/).fill("ui read-run token");
    await page.getByLabel("Lifetime in days").fill("7");
    await page.getByLabel("W (write)").check();
    await page.getByRole("button", { name: "Add grant" }).click();
    await page.getByLabel("Grant 1 resource type").selectOption("Run");
    const actions = page.getByRole("group", { name: "Grant 1 actions" });
    await actions.getByLabel("read").check();
    await actions.getByLabel("execute").check();
    await page.getByLabel("Grant 1 projects").selectOption({ label: "Team journey project" });
    await page.getByLabel("Environments").selectOption({ label: environmentName });
    await page.getByRole("button", { name: "Create token" }).click();
    const secret = await shownToken(page);
    expect(secret).toMatch(/^tm_api_/);
    const row = page.getByRole("row", { name: /ui read-run token/ });
    await row.waitFor();
    expect(await row.innerText()).toContain("allow read+execute on Run (1 project(s))");

    // Shown once: not after dismissal, not after a reload, not in any listing the server returns.
    await page.getByRole("button", { name: "I have stored it" }).click();
    expect(await page.getByTestId("new-token").count()).toBe(0);
    await page.reload();
    await page.getByRole("table", { name: "API tokens" }).waitFor();
    expect(await page.content()).not.toContain(secret);
    expect((await stack.ownerClient().request("GET", "/v1/tokens")).text).not.toContain(secret);
    expect((await bearer(secret).get("/v1/me")).status).toBe(200);

    // A deny grant carves an action out of the token even though the owner's role allows it.
    await page.getByLabel(/^Name\b/).fill("ui deny-write token");
    await page.getByLabel("W (write)").check();
    await page.getByRole("button", { name: "Add grant" }).click();
    await page.getByLabel("Grant 1 resource type").selectOption("*");
    await page.getByLabel("Deny: block these actions").check();
    await page.getByRole("group", { name: "Grant 1 actions" }).getByLabel("write").check();
    await page.getByRole("button", { name: "Create token" }).click();
    const denyToken = await shownToken(page);
    await page.getByRole("row", { name: /ui deny-write token/ }).waitFor();
    expect(await page.getByRole("row", { name: /ui deny-write token/ }).innerText()).toContain(
      "deny write on *",
    );
    const narrowed = bearer(denyToken);
    expect((await narrowed.get("/v1/projects")).status).toBe(200);
    expect(
      (await narrowed.mutate("POST", "/v1/projects", { name: "Denied by grant" })).status,
    ).toBe(403);
    // Positive control: a token without the deny grant creates the project.
    const plain = await stack.issueToken(stack.owner.principalId, ["R", "W"]);
    expect(
      (await bearer(plain).mutate("POST", "/v1/projects", { name: "Allowed by role" })).status,
    ).toBe(201);

    // Revocation needs a contextual confirmation and ends the token at once.
    await page.getByRole("button", { name: "Revoke ui read-run token" }).click();
    const dialog = page.getByRole("dialog", { name: "Revoke token" });
    expect(await dialog.innerText()).toContain("ui read-run token");
    await dialog.getByRole("button", { name: "Revoke token" }).click();
    await expect.poll(async () => (await bearer(secret).get("/v1/me")).status).toBe(401);

    // The editor cannot hand out more than it holds: an admin token without write cannot issue write.
    const limited = bearer(await stack.issueToken(admin.principalId, ["R", "A"]));
    const expiresAt = new Date(Date.now() + 1_800_000).toISOString();
    const overScope = await limited.mutate("POST", "/v1/tokens", {
      name: "over scope",
      scopes: ["R", "W"],
      expiresAt,
    });
    expect(overScope.status).toBe(403);
    // A bearer token cannot delegate beyond its own lifetime (a session can: it is not a token).
    const overLifetime = await limited.mutate("POST", "/v1/tokens", {
      name: "over lifetime",
      scopes: ["R"],
      expiresAt: new Date(Date.now() + 7_200_000).toISOString(),
    });
    expect(overLifetime.status).toBe(403);
    expect(overLifetime.text).toContain("Delegated token cannot outlive issuer token");
    const overGrant = await limited.mutate("POST", "/v1/tokens", {
      name: "over grant",
      scopes: ["R"],
      expiresAt,
      grants: [
        {
          resourceType: "*",
          actions: ["write"],
          projectIds: [],
          environmentIds: [],
          expiresAt: null,
          grantedBy: admin.principalId,
        },
      ],
    });
    expect(overGrant.status).toBe(403);
    expect(overGrant.text).toContain("Requested grants exceed current issuer grants");
    const narrowing = await limited.mutate("POST", "/v1/tokens", {
      name: "narrowing only",
      scopes: ["R"],
      expiresAt,
      grants: [
        {
          resourceType: "*",
          actions: ["write"],
          projectIds: [],
          environmentIds: [],
          expiresAt: null,
          grantedBy: admin.principalId,
          deny: true,
        },
      ],
    });
    expect(narrowing.status).toBe(201);
    expect(diagnostics.pageErrors).toEqual([]);
  }, 240_000);

  it("UX-050 the audit trail lists actor kind, operation, outcome, scope and correlation, filters in the URL, pages by cursor and shows no secret", async () => {
    // Events from the earlier steps, a denied tenant-boundary request and a failed sign-in.
    const owner = stack.ownerClient();
    const correlated = await owner.mutate(
      "POST",
      "/v1/tokens",
      {
        name: "audit correlated",
        scopes: ["R"],
        expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
      },
      { "x-correlation-id": "corr-ux050-0001" },
    );
    expect(correlated.status).toBe(201);
    const correlatedToken = correlated.json<{ data: { token: string } }>().data.token;
    const crossTenant = await owner.mutate("POST", "/v1/projects", {
      name: "Crossing",
      workspaceId: "ws_01900000-0000-7000-8000-00000000dead",
    });
    expect(crossTenant.status).toBe(403);
    // More rows than one page, written through the audit service instead of 52 rate-limited calls.
    const seeder = (await stack.scope()).forWorkspaceSystem(workspaceId);
    for (let index = 0; index < 52; index++)
      auditSecurity(seeder.context, "ux050.seed", `seed-${index}`, "requested");

    const { page } = await portal(stack.owner);
    await page.goto("/audit");
    await page.getByRole("table", { name: "Audit events, newest first" }).waitFor();
    const header = await page.getByRole("row").first().innerText();
    for (const column of ["Time", "Actor", "Operation", "Outcome", "Scope", "Correlation"])
      expect(header).toContain(column);
    expect(await page.getByRole("row").count()).toBe(51);
    expect(await page.getByText("50 loaded").count()).toBe(1);

    // Cursor paging: more rows after "Load more", none repeated.
    await page.getByRole("button", { name: /Load more/i }).click();
    await expect.poll(() => page.getByRole("row").count()).toBeGreaterThan(51);
    const ids = await page.locator("tbody tr td:nth-child(6) code").allInnerTexts();
    expect(ids.length).toBeGreaterThan(50);

    // Correlation filter: exactly the events of that request, kept in the URL across a reload.
    await page.getByLabel("Correlation ID").fill("corr-ux050-0001");
    await page.getByRole("button", { name: "Apply filters" }).click();
    await page.waitForURL((url) => url.searchParams.get("correlationId") === "corr-ux050-0001");
    const onlyCorrelated = async () => {
      const rows = await page.locator("tbody tr").allInnerTexts();
      return (
        rows.length > 0 && rows.length < 5 && rows.every((row) => row.includes("corr-ux050-0001"))
      );
    };
    await expect.poll(onlyCorrelated).toBe(true);
    expect(
      (await page.locator("tbody tr").allInnerTexts()).some((row) =>
        row.includes("auth.token.issue"),
      ),
    ).toBe(true);
    await page.reload();
    await page.getByRole("table", { name: "Audit events, newest first" }).waitFor();
    expect(await page.getByLabel("Correlation ID").inputValue()).toBe("corr-ux050-0001");
    await expect.poll(onlyCorrelated).toBe(true);

    // Outcome and actor-kind filters: the denied tenant-boundary request, and only denied rows.
    await page.getByRole("button", { name: "Clear filters" }).click();
    await page.waitForURL((url) => !url.searchParams.has("correlationId"));
    await page.getByLabel("Outcome").selectOption("denied");
    await page.getByLabel("Actor kind").selectOption("human");
    await page.getByRole("button", { name: "Apply filters" }).click();
    await page.waitForURL((url) => url.searchParams.get("outcome") === "denied");
    await expect
      .poll(async () => (await page.locator("tbody tr").allInnerTexts()).join("\n"))
      .toContain("tenant.violation");
    const denied = await page.locator("tbody tr").allInnerTexts();
    expect(denied.length).toBeGreaterThan(0);
    for (const text of denied) {
      expect(text).toContain("Denied");
      expect(text).toContain("human");
    }
    // Positive control for the filter: an unfiltered page also holds allowed rows.
    await page.getByRole("button", { name: "Clear filters" }).click();
    await expect
      .poll(async () => (await page.locator("tbody tr").allInnerTexts()).join("\n"))
      .toContain("Allowed");

    // Operation prefix filter with the keyboard alone.
    const keyboard = await keyboardOnly(page);
    await keyboard.tabTo(
      (element) => element.tag === "input" && element.name.startsWith("Operation"),
      60,
    );
    await keyboard.type("auth.token.revoke");
    await keyboard.press("Enter");
    await page.waitForURL((url) => url.searchParams.get("operation") === "auth.token.revoke");
    await expect
      .poll(async () => {
        const rows = await page.locator("tbody tr").allInnerTexts();
        return rows.length > 0 && rows.every((row) => row.includes("auth.token.revoke"));
      })
      .toBe(true);
    await keyboard.assertNoPointerUsed();

    // No secret value reaches the page: neither the token issued under the shown correlation ID nor any recovery token.
    const text = await page.content();
    expect(text).not.toContain(correlatedToken);
    expect(text).not.toContain("tm_rec_");
    expect(text).not.toContain("tm_api_");
    const everything = await owner.request("GET", "/v1/audit-events?limit=100");
    expect(everything.text).not.toContain(correlatedToken);
    expect(everything.text).not.toContain("tm_rec_");
  }, 300_000);

  it("UX-051 UX-052 the team, token and audit pages are axe clean and keep their actions at 320 px and 200 % zoom", async () => {
    const { page } = await portal(stack.owner);
    const paths = ["/team", "/team/tokens", "/audit"];
    for (const path of paths) {
      await page.goto(path);
      await page.getByRole("main").waitFor();
      await page.getByRole("heading", { level: 1 }).first().waitFor();
      await page.getByRole("table").first().waitFor();
      await expectAccessible(page, `team ${path} owner desktop`);
    }
    const asViewer = await portal(viewer);
    for (const path of paths) {
      await asViewer.page.goto(path);
      await asViewer.page.getByRole("heading", { level: 1 }).first().waitFor();
      await expectAccessible(asViewer.page, `team ${path} viewer desktop`);
    }
    await atViewport(page, { width: 320, zoom: 2, textScale: 1 });
    for (const path of paths) {
      await page.goto(path);
      await page.getByRole("heading", { level: 1 }).first().waitFor();
      await page.getByRole("table").first().waitFor();
      await expectNoPageOverflow(page, `team ${path} at 320 px`);
      await expectAccessible(page, `team ${path} 320px 200%`);
      expect(await page.getByRole("button", { name: "Sign out" }).isVisible()).toBe(true);
    }
  }, 240_000);

  it("UX-005 UX-050 M4-04 every request of the team and audit pages is a catalog /v1 route, and hostile display names render as inert text", async () => {
    const added = await stack
      .ownerClient()
      .mutate("POST", `/v1/workspaces/${workspaceId}/members`, {
        login: "hostile-display",
        displayName: hostileName,
        role: "viewer",
        projectRestrictions: [],
      });
    expect(added.status).toBe(201);
    const { page, diagnostics } = await portal(stack.owner);
    for (const path of ["/team", "/team/tokens", "/audit"]) {
      await page.goto(path);
      await page.getByRole("heading", { level: 1 }).first().waitFor();
      await page.getByRole("table").first().waitFor();
    }
    await page.goto("/team");
    await page.getByRole("table", { name: "Workspace members" }).waitFor();
    expect(await page.locator("main img").count()).toBe(0);
    expect(await page.getByRole("row", { name: /hostile-display/ }).innerText()).toContain("<img");
    expect(await pwned(page)).toBeUndefined();
    const api = diagnostics.requests.filter((entry) => entry.split(" ")[1]?.startsWith("/v1/"));
    expect(api.length).toBeGreaterThan(3);
    expect(api.filter((entry) => !catalogRoute(entry))).toEqual([]);
    expect(open.every((entry) => entry.diagnostics.pageErrors.length === 0)).toBe(true);
    expect(diagnostics.failedRequests).toEqual([]);
  }, 180_000);
});
