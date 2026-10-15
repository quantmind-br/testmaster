import { createHash } from "node:crypto";
import { unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { scaffoldPlan } from "@testmaster/application";
import type { ExecutablePlan } from "@testmaster/contracts";
import type { Page } from "playwright-core";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  asOwner,
  commitFiles,
  createProject,
  initGitRepository,
  privateEndpointCalls,
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
 * UX-011 / UX-014 / UX-044: sources, source history and discovery previews through the real server
 * profile. The repository the server discovers is a real git checkout under the stack directory;
 * sources arrive through the portal's upload form (hashed in the browser, sent as bytes).
 */
let stack: ServerStack;
let projectId = "";
let baseSha = "";
let headSha = "";
const open: OpenPortal[] = [];
let user: StackUser;
let client: Pick<HttpsClient, "request" | "mutate">;

const sha256 = (value: string) => createHash("sha256").update(value).digest("hex");
const ok = { responses: { "200": { description: "ok" } } };
const api = (paths: Record<string, unknown>) =>
  JSON.stringify({ openapi: "3.0.3", info: { title: "Shop", version: "1" }, paths }, null, 2);
const V1 = api({
  "/orders": { get: ok },
  "/orders/{id}": {
    get: {
      parameters: [{ name: "id", in: "path", required: true, schema: { type: "string" } }],
      responses: { "200": { description: "ok" } },
    },
  },
  "/legacy": { get: ok },
});
const V2 = api({
  "/orders": {
    get: { responses: { "200": { description: "list" }, "404": { description: "none" } } },
  },
  "/orders/{id}": {
    get: {
      parameters: [{ name: "id", in: "path", required: true, schema: { type: "string" } }],
      responses: { "200": { description: "ok" } },
    },
  },
  "/refunds": { post: ok },
});

async function portal(who: StackUser, viewport?: { width: number; height: number }) {
  const opened = await openPortal(
    { baseUrl: stack.baseUrl, spkiSha256: stack.ca.spkiSha256 },
    who,
    viewport ? { viewport } : {},
  );
  open.push(opened);
  return opened;
}

function bearerClient(token: string): Pick<HttpsClient, "request" | "mutate"> {
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

/** The server limits mutations per principal; each test gets its own organization admin. */
const admins: { user: StackUser; client: Pick<HttpsClient, "request" | "mutate"> }[] = [];
let turn = 0;

beforeAll(async () => {
  stack = await startServerStack({ userPolicy: { allowUpload: true } });
  projectId = await createProject(stack, "Sources journey");
  for (let index = 0; index < 3; index++) {
    const member = await stack.addMember("org_admin");
    const token = await stack.issueToken(member.principalId, ["R", "W", "X", "A"]);
    admins.push({ user: member, client: bearerClient(token) });
  }
  await initGitRepository(stack.cwd);
  baseSha = await commitFiles(
    stack.cwd,
    {
      "package.json": JSON.stringify({ name: "shop", dependencies: { express: "4.19.0" } }),
      "src/app.js":
        "import express from 'express';\nconst app = express();\napp.get('/health', (req, res) => res.send('ok'));\n",
      "notes.txt": "Plain notes the code analysis does not interpret.\n",
      ".env": "API_TOKEN=do-not-read-me-0123456789\n",
    },
    "base",
  );
  headSha = await commitFiles(
    stack.cwd,
    {
      "src/app.js":
        "import express from 'express';\nconst app = express();\napp.get('/health', (req, res) => res.send('ok'));\napp.post('/orders', (req, res) => res.status(201).send('created'));\n",
      "src/billing.js":
        "export function register(app) {\n  app.get('/invoices', (req, res) => res.send('[]'));\n}\n",
    },
    "head",
  );
}, 600_000);

beforeEach(() => {
  const next = admins[turn++ % admins.length] as (typeof admins)[number];
  user = next.user;
  client = next.client;
});

afterAll(async () => {
  for (const opened of open.splice(0)) await opened.close().catch(() => undefined);
  await stack?.stop();
});

async function upload(page: Page, name: string, content: string, label = "File") {
  await page
    .getByLabel(label, { exact: true })
    .setInputFiles({ name, mimeType: "application/octet-stream", buffer: Buffer.from(content) });
}

async function sendUpload(page: Page, button: string) {
  await page.getByRole("button", { name: button }).click();
  await page.getByTestId("upload-done").waitFor();
}

describe("sources", () => {
  it("UX-011 an uploaded PRD is hashed in the browser, previewed before sending, and listed with its revision, hash, owner and update status", async () => {
    const { page, diagnostics } = await portal(user);
    await page.goto(`/projects/${projectId}/sources`);
    await page.getByRole("heading", { level: 1, name: "Sources" }).waitFor();
    expect(await page.getByTestId("upload-policy").textContent()).toContain("Accepted formats");
    const prd = "# Shop PRD\n\nThe health endpoint must report ok.\n";
    const before = diagnostics.requests.filter((entry) => entry.includes("/uploads")).length;
    await upload(page, "shop-prd.md", prd);
    const preview = page.getByTestId("upload-preview");
    await preview.waitFor();
    expect(await preview.textContent()).toContain(sha256(prd));
    expect(await preview.textContent()).toContain("shop-prd.md");
    // Nothing was sent just by choosing the file.
    expect(diagnostics.requests.filter((entry) => entry.includes("/uploads")).length).toBe(before);
    await sendUpload(page, "Upload source");
    const row = page.getByRole("row", { name: /shop-prd\.md/ });
    await row.waitFor();
    const text = (await row.innerText()).replace(/\s+/g, " ");
    expect(text).toContain("prd");
    expect(text).toContain("1 of 1");
    expect(text).toContain(sha256(prd).slice(0, 12));
    expect(text).toContain(user.principalId);
    expect(text).toContain("Uploaded");
    // The server holds exactly the bytes that were hashed.
    const listed = (await client.request("GET", `/v1/projects/${projectId}/sources`)).json<{
      data: { items: { displayName: string; overview: { active: { contentHash: string } } }[] };
    }>().data.items;
    const stored = listed.find((item) => item.displayName.includes("shop-prd.md"));
    expect(stored?.overview.active.contentHash).toBe(sha256(prd));
  });

  it("UX-011 a file named like a credential is refused with its reason and no source is created", async () => {
    const { page } = await portal(user);
    await page.goto(`/projects/${projectId}/sources`);
    await page.getByRole("heading", { level: 1, name: "Sources" }).waitFor();
    const countBefore = (await client.request("GET", `/v1/projects/${projectId}/sources`)).json<{
      data: { items: unknown[] };
    }>().data.items.length;
    await upload(page, ".env", "API_TOKEN=do-not-upload-0123456789\n");
    await page.getByTestId("upload-preview").waitFor();
    await page.getByRole("button", { name: "Upload source" }).click();
    const failure = page.getByTestId("upload-failure");
    await failure.waitFor();
    expect(await failure.textContent()).toContain("POLICY_DENIED");
    expect(await page.getByTestId("upload-done").count()).toBe(0);
    const after = (await client.request("GET", `/v1/projects/${projectId}/sources`)).json<{
      data: { items: { displayName: string }[] };
    }>().data.items;
    expect(after).toHaveLength(countBefore);
    expect(after.some((item) => item.displayName === ".env")).toBe(false);
    // The secret never reached any stored source.
    expect(stack.logs()).not.toContain("do-not-upload-0123456789");
  });

  it("UX-044 an updated API specification keeps both revisions, lists added, removed and changed operations, and flags only the tests that rest on them", async () => {
    const { page } = await portal(user);
    const app = await asOwner(stack);
    await page.goto(`/projects/${projectId}/sources`);
    await page.getByRole("heading", { level: 1, name: "Sources" }).waitFor();
    await page.getByLabel("Role", { exact: true }).selectOption("api-spec");
    await upload(page, "shop-openapi.json", V1);
    await page.getByTestId("upload-preview").waitFor();
    await sendUpload(page, "Upload source");
    await page.getByRole("link", { name: /shop-openapi\.json/ }).click();
    await page.getByRole("heading", { level: 1, name: /shop-openapi\.json/ }).waitFor();
    expect(await page.getByTestId("changes-1").count()).toBe(0);
    expect(await page.locator('[data-revision="1"]').textContent()).toContain("First revision");

    // Tests that rest on the specification: one on a changed operation, one on a removed one and
    // one on an operation that did not change.
    const plan = (name: string, path: string): ExecutablePlan => {
      const value = scaffoldPlan("backend");
      value.name = name;
      value.steps = [
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
      return value;
    };
    app.tests.create({ projectId, plan: plan("Orders list", "/orders") });
    app.tests.create({ projectId, plan: plan("Legacy ping", "/legacy") });
    app.tests.create({ projectId, plan: plan("Order detail", "/orders/7") });

    await upload(page, "shop-openapi.json", V2, "File");
    await page.getByTestId("upload-preview").waitFor();
    await page.getByRole("button", { name: "Upload revision" }).click();
    await page.getByTestId("upload-done").waitFor();
    await page.locator('[data-revision="2"]').waitFor();

    const second = page.getByTestId("changes-2");
    expect(await second.locator('[data-change="added"]').textContent()).toContain("POST /refunds");
    expect(await second.locator('[data-change="removed"]').textContent()).toContain("GET /legacy");
    expect(await second.locator('[data-change="changed"]').textContent()).toContain("GET /orders");
    // Negative control: an operation that did not change is not reported as changed.
    expect(await second.textContent()).not.toContain("/orders/{id}");

    // Both revisions are kept, each with its own hash.
    const revisions = page.locator("[data-revision]");
    expect(await revisions.count()).toBe(2);
    expect(await page.locator('[data-revision="1"]').textContent()).toContain(sha256(V1));
    expect(await page.locator('[data-revision="2"]').textContent()).toContain(sha256(V2));
    expect(await page.locator('[data-revision="1"]').textContent()).toContain("Superseded");
    expect(await page.locator('[data-revision="2"]').textContent()).toContain("Active");

    const stale = page.getByTestId("stale-tests");
    const staleText = (await stale.innerText()).replace(/\s+/g, " ");
    expect(staleText).toContain("Orders list — endpoint_changed: GET /orders");
    expect(staleText).toContain("Legacy ping — endpoint_removed: GET /legacy");
    expect(staleText).not.toContain("Order detail");
    expect(await stale.textContent()).toContain("conservative hint, not a verdict");

    // The list reports the update count and the stale tests next to the source.
    await page.getByRole("link", { name: "Back to sources" }).click();
    const row = page.getByRole("row", { name: /shop-openapi\.json/ });
    expect((await row.innerText()).replace(/\s+/g, " ")).toContain("2 of 2");
    expect(await row.innerText()).toContain("2 test(s) may be stale");
  });

  it("UX-044 an update made from an out-of-date page is refused with a revision conflict and changes nothing", async () => {
    const { page } = await portal(user);
    const app = await asOwner(stack);
    await writeFile(join(stack.cwd, "conflict-prd.md"), "# Conflict\n\nVersion one.\n");
    const added = await app.sources.add({
      projectId,
      role: "prd",
      path: "conflict-prd.md",
      format: "markdown",
    });
    await page.goto(`/projects/${projectId}/sources/${added.source.id}`);
    await page.getByRole("heading", { level: 1, name: /conflict-prd\.md/ }).waitFor();
    // Someone else updates the source while this page is open.
    await writeFile(join(stack.cwd, "conflict-prd.md"), "# Conflict\n\nVersion two.\n");
    await app.sources.add({
      projectId,
      role: "prd",
      path: "conflict-prd.md",
      format: "markdown",
      sourceId: added.source.id,
      expectedVersion: Number(added.source.version),
    });
    await upload(page, "conflict-prd.md", "# Conflict\n\nVersion three, from a stale page.\n");
    await page.getByTestId("upload-preview").waitFor();
    await page.getByRole("button", { name: "Upload revision" }).click();
    const failure = page.getByTestId("upload-failure");
    await failure.waitFor();
    expect(await failure.textContent()).toContain("REVISION_CONFLICT");
    const history = (await client.request("GET", `/v1/sources/${added.source.id}/revisions`)).json<{
      data: { revisions: { ordinal: number }[] };
    }>().data;
    expect(history.revisions.map((revision) => revision.ordinal)).toEqual([2, 1]);
    // Positive control: after reloading the page the same update succeeds.
    await page.reload();
    await page.getByRole("heading", { level: 1, name: /conflict-prd\.md/ }).waitFor();
    await upload(page, "conflict-prd.md", "# Conflict\n\nVersion three.\n");
    await page.getByTestId("upload-preview").waitFor();
    await sendUpload(page, "Upload revision");
    await page.locator('[data-revision="3"]').waitFor();
  });

  it("UX-011 a source imported from a repository file shows whether its origin is unchanged, changed or missing", async () => {
    const { page } = await portal(user);
    const app = await asOwner(stack);
    const origin = join(stack.cwd, "origin-prd.md");
    await writeFile(origin, "# Origin\n\nThe shop sells things.\n");
    const added = await app.sources.add({
      projectId,
      role: "prd",
      path: "origin-prd.md",
      format: "markdown",
    });
    const state = async () => {
      await page.goto(`/projects/${projectId}/sources/${added.source.id}`);
      await page.getByRole("heading", { level: 1, name: /origin-prd\.md/ }).waitFor();
      return (await page.getByTestId("origin-state").textContent()) ?? "";
    };
    expect(await state()).toContain("Repository file origin-prd.md — Up to date");
    await writeFile(origin, "# Origin\n\nThe shop sells other things.\n");
    expect(await state()).toContain("Changed at its origin");
    await unlink(origin);
    expect(await state()).toContain("Origin file is missing");
    // The previous revision is still readable although its origin is gone.
    expect(await page.locator('[data-revision="1"]').textContent()).toContain(
      sha256("# Origin\n\nThe shop sells things.\n"),
    );
    const exclusions = await page.getByRole("region", { name: "Exclusions" }).innerText();
    expect(exclusions).toContain(".env, .env.*");
    expect(exclusions).toContain("*.pem");
  });
});

describe("discovery", () => {
  it("UX-014 a full discovery lists what was parsed and what was skipped and never claims the application was fully understood", async () => {
    const { page } = await portal(user);
    await page.goto(`/projects/${projectId}/discovery`);
    await page.getByRole("heading", { level: 1, name: "Discovery" }).waitFor();
    await page.getByRole("button", { name: "Run discovery" }).click();
    await page.getByRole("heading", { level: 1, name: "Discovery preview" }).waitFor();
    const id = page.url().split("/").pop() ?? "";
    const detail = (await client.request("GET", `/v1/discovery/${id}`)).json<{
      data: {
        summary: {
          coverage: string;
          scannedFiles: string[];
          skippedFiles: { path: string; reason: string }[];
        };
      };
    }>().data;
    const statement = (await page.getByTestId("coverage-statement").innerText()).replace(
      /\s+/g,
      " ",
    );
    expect(statement).toContain(`Coverage is ${detail.summary.coverage}`);
    expect(statement).toContain("does not claim the application is fully mapped");
    expect(detail.summary.coverage).not.toBe("complete");
    const counts = await page.getByTestId("file-counts").innerText();
    expect(counts).toContain(String(detail.summary.scannedFiles.length));
    expect(counts).toContain(String(detail.summary.skippedFiles.length));
    const skipped = (await page.getByTestId("skipped-files").innerText()).replace(/\s+/g, " ");
    expect(skipped).toContain("notes.txt");
    expect(skipped).toContain("unsupported_type");
    expect(skipped).toContain(".env");
    expect(skipped).toContain("default_exclude");
    // The excluded file was never read: its content is nowhere in the preview.
    expect(await page.content()).not.toContain("do-not-read-me-0123456789");
    const main = (await page.getByRole("main").innerText()).replace(/\s+/g, " ");
    expect(main).toContain("GET /health");
    expect(main).toContain("Uncertainties");
    // Positive control: the list shows the run with its counts.
    await page.goto(`/projects/${projectId}/discovery`);
    await page.getByRole("row", { name: /Full/ }).first().waitFor();
  });

  it("UX-014 a diff discovery shows the exact base and head SHAs, what changed, the ignored files and the limits of the impact analysis", async () => {
    const { page } = await portal(user);
    await page.goto(`/projects/${projectId}/discovery`);
    await page.getByRole("heading", { level: 1, name: "Discovery" }).waitFor();
    await page.getByLabel(/Diff — only what changed/).check();
    await page.locator("#discovery-base").fill(baseSha);
    await page.locator("#discovery-head").fill(headSha);
    await page.getByRole("button", { name: "Run discovery" }).click();
    await page.getByRole("heading", { level: 1, name: "Discovery preview" }).waitFor();
    expect(await page.getByTestId("base-sha").textContent()).toBe(baseSha);
    expect(await page.getByTestId("head-sha").textContent()).toBe(headSha);
    const impact = (await page.getByTestId("diff-impact").innerText()).replace(/\s+/g, " ");
    expect(impact).toContain("src/billing.js");
    expect(impact).toContain("src/app.js");
    // The changed-files table lists what changed; package.json only appears as an ignored file.
    const changed = impact.split("Files used for the impact analysis")[0] ?? "";
    expect(changed).not.toContain("package.json");
    expect(await page.getByTestId("impact-limits").count()).toBe(1);
    expect(await page.getByTestId("ignored-files").innerText()).toContain("package.json");
    const main = (await page.getByRole("main").innerText()).replace(/\s+/g, " ");
    expect(main).toContain("POST /orders");
  });

  it("UX-014 a diff without a base is refused on the form and by the server, and an unknown base names the problem", async () => {
    const { page, diagnostics } = await portal(user);
    await page.goto(`/projects/${projectId}/discovery`);
    await page.getByRole("heading", { level: 1, name: "Discovery" }).waitFor();
    await page.getByLabel(/Diff — only what changed/).check();
    const posts = () =>
      diagnostics.requests.filter((entry) => entry === `POST /v1/projects/${projectId}/discovery`)
        .length;
    const before = posts();
    await page.getByRole("button", { name: "Run discovery" }).click();
    await page.getByTestId("error-summary").waitFor();
    expect(await page.getByTestId("error-summary").textContent()).toContain("base");
    expect(posts()).toBe(before);
    // The server enforces the same rule for any client.
    const refused = await client.mutate("POST", `/v1/projects/${projectId}/discovery`, {
      projectId,
      sourceRevisionIds: [],
      scope: ["diff"],
      budget: {},
    });
    expect(refused.status).toBe(422);
    expect(refused.text).toContain("PRECONDITION_FAILED");
    // An unknown commit is reported, not silently treated as an empty diff.
    await page.locator("#discovery-base").fill("0".repeat(40));
    await page.locator("#discovery-head").fill(headSha);
    await page.getByRole("button", { name: "Run discovery" }).click();
    await page.getByTestId("discovery-failure").waitFor();
    // Positive control: with a real base the same form succeeds.
    await page.locator("#discovery-base").fill(baseSha);
    await page.getByRole("button", { name: "Run discovery" }).click();
    await page.getByRole("heading", { level: 1, name: "Discovery preview" }).waitFor();
  });

  it("UX-014 a diff against the working tree is labelled as including uncommitted changes", async () => {
    const { page } = await portal(user);
    await writeFile(
      join(stack.cwd, "src/app.js"),
      "import express from 'express';\nconst app = express();\napp.get('/health', (req, res) => res.send('ok'));\napp.post('/orders', (req, res) => res.status(201).send('created'));\napp.delete('/orders/:id', (req, res) => res.status(204).end());\n",
    );
    await page.goto(`/projects/${projectId}/discovery`);
    await page.getByRole("heading", { level: 1, name: "Discovery" }).waitFor();
    await page.getByLabel(/Diff — only what changed/).check();
    await page.locator("#discovery-base").fill(headSha);
    await page.getByLabel(/Include uncommitted changes/).check();
    await page.getByRole("button", { name: "Run discovery" }).click();
    await page.getByRole("heading", { level: 1, name: "Discovery preview" }).waitFor();
    expect((await page.getByRole("main").innerText()).replace(/\s+/g, " ")).toContain(
      "plus uncommitted changes",
    );
    expect(await page.getByTestId("base-sha").textContent()).toBe(headSha);
  });
});

describe("pages", () => {
  it("UX-051 UX-052 the source and discovery pages are axe clean, reflow at 320 px and 200 %, and work with the keyboard alone", async () => {
    const { page } = await portal(user);
    const app = await asOwner(stack);
    const sources = (await client.request("GET", `/v1/projects/${projectId}/sources`)).json<{
      data: { items: { id: string }[] };
    }>().data.items;
    const sourceId = sources[0]?.id ?? "";
    const discovery = await app.discovery.discover({ projectId });
    const paths = [
      `/projects/${projectId}/sources`,
      `/projects/${projectId}/sources/${sourceId}`,
      `/projects/${projectId}/discovery`,
      `/projects/${projectId}/discovery/${discovery.job.id}`,
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
    await keyboard.page.goto(`/projects/${projectId}/discovery`);
    await keyboard.page.getByRole("heading", { level: 1, name: "Discovery" }).waitFor();
    const session = await keyboardOnly(keyboard.page);
    await session.tabTo((element) => element.name === "Run discovery", 120);
    expect((await session.focused()).focusRing).toBe(true);
    await session.press("Enter");
    await keyboard.page.getByRole("heading", { level: 1, name: "Discovery preview" }).waitFor();
    await session.assertNoPointerUsed();
  });

  it("M4-04 the sources and discovery journey called only catalog /v1 routes and its own static assets", async () => {
    const calls = open.flatMap((opened) => opened.diagnostics.requests);
    expect(calls.length).toBeGreaterThan(30);
    expect(privateEndpointCalls(calls)).toEqual([]);
    // Negative control: the checker really rejects an endpoint that is not in the catalog.
    expect(privateEndpointCalls(["POST /v1/private/sources", "GET /api/state"])).toEqual([
      "POST /v1/private/sources",
      "GET /api/state",
    ]);
    expect(calls.some((entry) => entry.startsWith("PUT /v1/uploads/"))).toBe(true);
    expect(open.every((opened) => opened.diagnostics.pageErrors.length === 0)).toBe(true);
  });
});
