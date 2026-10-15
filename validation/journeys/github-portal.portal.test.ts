import { randomBytes } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ServerConfig } from "@testmaster/application";
import { type GithubWorld, startGithubWorld } from "@testmaster/application/testing";
import { routeCatalog } from "@testmaster/contracts";
import { createTestDatabase, type TestDatabase } from "@testmaster/persistence/testing";
import { createServer } from "@testmaster/server";
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
import { createTestCa, startTlsProxy, type TestCa, type TlsProxy } from "./tls-proxy.js";

/**
 * The GitHub integration pages against the server profile: PostgreSQL, the real HTTP server, a
 * TLS-terminating proxy (so `__Host-` cookies, CSRF and `tls_required` behave as in production) and
 * the fake GitHub behind the application. The pages use only catalog `/v1` routes.
 */
const SHA_A = "a".repeat(40);
const SHA_B = "b1".repeat(20);
const SHA_C = "c2".repeat(20);

let directory = "";
let database: TestDatabase;
let ca: TestCa;
let proxy: TlsProxy;
let world: GithubWorld;
let http: ReturnType<typeof createServer>;
let integrationPath = "";
let completedBatchId = "";
const opened: OpenPortal[] = [];
const requestLog: string[] = [];

beforeAll(async () => {
  directory = await mkdtemp(join(tmpdir(), "tm-github-portal-"));
  await writeFile(join(directory, "master.key"), randomBytes(32), { mode: 0o600 });
  await mkdir(join(directory, "evidence"), { recursive: true });
  database = await createTestDatabase();
  ca = await createTestCa(join(directory, "ca"));
  let port = 0;
  proxy = await startTlsProxy({ ca, upstreamPort: () => port });
  const server: ServerConfig = {
    mode: "server",
    database: { engine: "postgres", ...database.config },
    storage: { kind: "filesystem", root: join(directory, "evidence") },
    server: {
      listen: { host: "127.0.0.1", port: 0 },
      publicOrigin: proxy.origin,
      trustedProxies: ["127.0.0.1"],
      origins: [proxy.origin],
    },
    security: {
      masterKeyFile: join(directory, "master.key"),
      backupKeyFile: join(directory, "backup.key"),
      atRestEncryption: { database: "operator-volume", evidence: "operator-volume" },
    },
  };
  world = await startGithubWorld({ server, publicOrigin: proxy.origin });
  http = createServer({ application: world.runtime, mode: "server", server, mcp: false });
  await http.listen({ host: "127.0.0.1", port: 0 });
  const address = http.server.address();
  port = typeof address === "object" && address ? address.port : 0;

  integrationPath = `/integrations/github/${world.integration.id}`;
  await world.install();
  await world.openPr(7, SHA_A);
  await world.deploy(1, SHA_A);
  await world.drive();
  completedBatchId = String(world.pull(SHA_A).batch_id);
  // A check GitHub rejects permanently ends in the dead letter, which the page lets an operator retry.
  world.fake.failNext("POST /repos/acme/shop/check-runs", 422, {}, 1000);
  await world.openPr(8, SHA_B);
  await world.drive(3);
}, 600_000);

afterAll(async () => {
  for (const portal of opened.splice(0)) await portal.close().catch(() => undefined);
  await http?.close();
  await proxy?.close();
  await world?.stop();
  await database?.drop();
  if (directory) await rm(directory, { recursive: true, force: true });
});

async function portal(signIn = true): Promise<OpenPortal> {
  const user = world.owner;
  if (!user) throw new Error("server-profile world has an owner");
  const result = await openPortal({ baseUrl: proxy.origin, spkiSha256: ca.spkiSha256 }, user, {
    signIn,
  });
  opened.push(result);
  return result;
}

const catalog = routeCatalog.map((route) => ({
  method: route.method,
  pattern: new RegExp(`^/v1${route.path.replaceAll(/\{[^}]+\}/gu, "[^/]+")}$`, "u"),
}));

/** Every `/v1` request a page started must be a documented catalog route; no private endpoint. */
function expectCatalogOnly(requests: readonly string[], label: string): void {
  const api = requests.filter((entry) => entry.split(" ")[1]?.startsWith("/v1/"));
  expect(api.length, `${label}: the page called the API`).toBeGreaterThan(0);
  const unknown = api.filter((entry) => {
    const [method, target] = entry.split(" ");
    const path = (target ?? "").split("?")[0] ?? "";
    return !catalog.some((route) => route.method === method && route.pattern.test(path));
  });
  expect(unknown, `${label}: requests outside the catalog`).toEqual([]);
}

async function openIntegration(page: Page): Promise<void> {
  await page.goto("/integrations/github");
  await page.getByRole("link", { name: world.integration.name }).click();
  await page
    .getByRole("heading", { level: 1, name: new RegExp(world.integration.name, "u") })
    .waitFor();
}

describe("GitHub integration pages on the server profile", () => {
  it("INT-004 INT-017 lists the App and labels a test delivery, accessibly at 320 px", async () => {
    const { page, diagnostics } = await portal();
    await openIntegration(page);
    expect(new URL(page.url()).pathname).toBe(integrationPath);
    await expect(page.getByRole("list", { name: "Consented scopes" }).count()).resolves.toBe(0);
    await expectAccessible(page, "github integration desktop");
    const checkRunsBefore = world.fake.checkRuns.length;
    const commentsBefore = world.fake.comments.length;
    const pullsBefore = world.app.database.all("SELECT id FROM github_pulls").length;
    await page.getByRole("button", { name: "Send test delivery" }).click();
    await page.getByText(/finished as .*labelled test/u).waitFor();
    expect(
      await page.getByRole("status").filter({ hasText: "labelled test" }).textContent(),
    ).toContain("does not represent a GitHub event");
    // The test never becomes a pull request, check, comment or Run of record.
    expect(world.fake.checkRuns.length).toBe(checkRunsBefore);
    expect(world.fake.comments.length).toBe(commentsBefore);
    expect(world.app.database.all("SELECT id FROM github_pulls")).toHaveLength(pullsBefore);

    await atViewport(page, { width: 320, zoom: 2, textScale: 1 });
    await expectNoPageOverflow(page, "github integration at 320 px");
    await expectAccessible(page, "github integration 320px 200%");
    requestLog.push(...diagnostics.requests);
    expectCatalogOnly(diagnostics.requests, "integration page");
  });

  it("INT-014 INT-017 an unknown or foreign integration ID renders the same not-found page as any missing route", async () => {
    const { page } = await portal();
    await page.goto("/integrations/github/int_doesnotexist");
    const missing = await page.getByRole("heading", { level: 1 }).first().textContent();
    await page.goto("/no/such/page");
    const unknown = await page.getByRole("heading", { level: 1 }).first().textContent();
    expect(missing).toBe(unknown);
    // The real page is reachable for the same session, so the difference is the ID alone.
    await page.goto(integrationPath);
    await page
      .getByRole("heading", { level: 1, name: new RegExp(world.integration.name, "u") })
      .waitFor();
  });

  it("OPS-037 INT-015 shows pull requests with their gate, links the portal batch and requires sign-in for the link in the check output", async () => {
    const { page } = await portal();
    await page.goto(integrationPath);
    const pulls = page.getByRole("table", { name: "Pull requests" });
    const completed = pulls.getByRole("row").filter({ hasText: "#7" });
    await completed.getByText("completed").waitFor();
    await completed.getByText("passed", { exact: false }).first().waitFor();
    const batchLink = completed.getByRole("link", { name: `Open batch ${completedBatchId}` });
    expect(await batchLink.getAttribute("href")).toBe(`/batches/${completedBatchId}`);
    const awaiting = pulls.getByRole("row").filter({ hasText: "#8" });
    await awaiting.getByText("Awaiting preview").waitFor();
    await awaiting.getByText("No run yet").waitFor();

    // The URL GitHub shows in the check output is the authenticated portal page, never a public one.
    const detailsUrl = world
      .checks(SHA_A)
      .find((check) => check.name === "TestMaster / result")?.detailsUrl;
    expect(detailsUrl).toBe(`${proxy.origin}/batches/${completedBatchId}`);
    const anonymous = await portal(false);
    await anonymous.page.goto(detailsUrl ?? "");
    await anonymous.page.waitForURL((url) => url.pathname === "/login");
    expect(new URL(anonymous.page.url()).searchParams.get("next")).toBe(
      `/batches/${completedBatchId}`,
    );
    await anonymous.page.getByLabel("Login").fill(world.owner?.login ?? "");
    await anonymous.page.getByLabel("Password").fill(world.owner?.password ?? "");
    await anonymous.page.getByRole("button", { name: "Sign in" }).click();
    await anonymous.page.waitForURL((url) => url.pathname === `/batches/${completedBatchId}`);
  });

  it("INT-023 a dead-lettered check is retried from the keyboard and a delivery problem never changes the verdict", async () => {
    const { page, diagnostics } = await portal();
    await page.goto(integrationPath);
    const checks = page.getByRole("table", { name: "Checks published to GitHub" });
    const deadRows = checks.getByRole("row").filter({ hasText: "Dead letter" });
    await deadRows.first().waitFor();
    expect(await deadRows.count()).toBe(2);
    expect(world.checks(SHA_B)).toEqual([]);
    const completedRows = checks.getByRole("row").filter({ hasText: SHA_A.slice(0, 7) });
    expect(await completedRows.filter({ hasText: "Delivered" }).count()).toBe(2);
    expect(
      await checks.getByRole("button", { name: /Retry delivery of TestMaster \/ result/u }).count(),
    ).toBe(1);
    await expectAccessible(page, "github checks with problems");

    world.fake.clearFaults();
    const keyboard = await keyboardOnly(page);
    await keyboard.tabTo(
      (element) =>
        element.tag === "button" &&
        element.name.startsWith("Retry delivery of TestMaster / result"),
      200,
    );
    expect(
      (await page.evaluate(() => document.activeElement?.className ?? "")).includes("button"),
    ).toBe(true);
    await keyboard.press("Enter");
    await page
      .getByRole("status")
      .filter({
        hasText: `Delivery of TestMaster / result on ${SHA_B.slice(0, 7)} was queued again.`,
      })
      .waitFor();
    await keyboard.tabTo(
      (element) =>
        element.tag === "button" &&
        element.name.startsWith("Retry delivery of TestMaster / required-gate"),
      200,
    );
    await keyboard.press("Enter");
    await page
      .getByRole("status")
      .filter({
        hasText: `Delivery of TestMaster / required-gate on ${SHA_B.slice(0, 7)} was queued again.`,
      })
      .waitFor();
    await world.runtime.controllerScope().github.reconcile();
    await page.reload();
    await checks
      .getByRole("row")
      .filter({ hasText: SHA_B.slice(0, 7) })
      .filter({ hasText: "Delivered" })
      .first()
      .waitFor();
    expect(await checks.getByRole("button", { name: /Retry delivery/u }).count()).toBe(0);
    // The pull request is still waiting for its preview: publishing the queued checks decided nothing.
    expect(
      world
        .checks(SHA_B)
        .map((check) => check.name)
        .sort(),
    ).toEqual(["TestMaster / required-gate", "TestMaster / result"]);
    expect(
      world.checks(SHA_B).find((check) => check.name === "TestMaster / required-gate")?.conclusion,
    ).not.toBe("success");
    expectCatalogOnly(diagnostics.requests, "checks page");
  });

  it("OPS-035 INT-018 INT-020 saves per-repository settings, binds a fork-policy error to its field and shows the saved result", async () => {
    const { page, diagnostics } = await portal();
    await page.goto(integrationPath);
    const form = page.getByRole("form", { name: "Settings for acme/shop" });
    await form.waitFor();
    await form.getByLabel("Pull requests from forks").selectOption("fixture-only");
    await form.getByRole("button", { name: "Save settings for acme/shop" }).click();
    const field = form.getByLabel("Fixture environment");
    await field.waitFor();
    expect(await field.getAttribute("aria-invalid")).toBe("true");
    const describedBy = (await field.getAttribute("aria-describedby")) ?? "";
    expect(describedBy.length).toBeGreaterThan(0);
    await page
      .getByText("Fixture-only fork runs need a secret-free fixture environment.")
      .first()
      .waitFor();
    expect(
      world.app.github.installations(world.integration.id)[0]?.repositories[0]?.forkPolicy,
      "an invalid form sent nothing",
    ).toBe("deny");

    await form.getByLabel("Pull requests from forks").selectOption("deny");
    await form.getByLabel("Preview environment pattern").fill("preview/*");
    await form.getByLabel("Include draft pull requests").check();
    await form.getByRole("button", { name: "Save settings for acme/shop" }).click();
    await page
      .getByRole("status")
      .filter({ hasText: "Settings for acme/shop were saved." })
      .waitFor();
    const saved = world.app.github.installations(world.integration.id)[0]?.repositories[0];
    expect(saved).toMatchObject({
      previewEnvironmentPattern: "preview/*",
      includeDrafts: true,
      forkPolicy: "deny",
      enabled: true,
    });
    await expectAccessible(page, "github repository settings");
    expectCatalogOnly(diagnostics.requests, "settings");
    const writes = diagnostics.requests.filter((entry) => entry.startsWith("PATCH "));
    expect(writes).toHaveLength(1);

    // Restore the defaults the next test relies on.
    world.configureRepository({ includeDrafts: false, preview: { environmentPattern: "*" } });
  });

  it("INT-015 records a manual preview URL after field validation and hands the pull request to the network policy once", async () => {
    world.configureRepository({ preview: { provider: "manual", environmentPattern: "*" } });
    await world.openPr(9, SHA_C);
    const { page, diagnostics } = await portal();
    await page.goto(integrationPath);
    const form = page.getByRole("form", { name: "Record a manual preview" });
    await form.waitFor();
    await form.getByRole("button", { name: "Record preview" }).click();
    await page.getByText("Enter an https:// preview URL.").first().waitFor();
    expect(await form.getByLabel("Preview URL").getAttribute("aria-invalid")).toBe("true");
    expect(
      diagnostics.requests.filter((entry) => entry === "POST /v1/preview-deployments"),
    ).toEqual([]);

    await form.getByLabel("Repository").selectOption({ label: "acme/shop" });
    await form.getByLabel("Pull request number").fill("9");
    await form.getByLabel("Head commit").fill(SHA_C);
    await form.getByLabel("Preview URL").fill(world.target.origin.replace("http://", "https://"));
    await form.getByRole("button", { name: "Record preview" }).click();
    await page.getByRole("status").filter({ hasText: "Preview recorded" }).waitFor();
    // The page attests the origin, and the network policy decides whether it is reachable; it never bypasses it.
    expect(String(world.pull(SHA_C).preview_url)).toContain("https://");
    expect(String(world.pull(SHA_C).state)).not.toBe("awaiting_preview");
    expect(
      diagnostics.requests.filter((entry) => entry === "POST /v1/preview-deployments"),
    ).toHaveLength(1);
    expectCatalogOnly(diagnostics.requests, "manual preview");
  });
});
