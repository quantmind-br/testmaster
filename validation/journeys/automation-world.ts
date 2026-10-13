import { randomBytes } from "node:crypto";
import { scaffoldPlan } from "@testmaster/application";
import { routeCatalog } from "@testmaster/contracts";
import type { Page } from "playwright-core";
import { expect } from "vitest";
import type { HttpsClient } from "./tls-proxy.js";

/**
 * Cross-project seed for the list and schedule journeys (J09, J13 schedule part): two projects that
 * each own an environment called `staging` with a different origin, a different secret and two
 * tests. Everything goes through the public `/v1` surface of the real server profile, so the data
 * is exactly what a person using the API or the portal could have created.
 */
export interface AutomationProject {
  readonly projectId: string;
  readonly name: string;
  readonly environmentId: string;
  readonly origin: string;
  readonly secretId: string;
  readonly testIds: readonly string[];
}

export interface AutomationWorld {
  readonly a: AutomationProject;
  readonly b: AutomationProject;
}

interface Created {
  readonly data: { readonly id: string };
}

async function create(client: HttpsClient, path: string, body: unknown): Promise<string> {
  const response = await client.mutate("POST", path, body);
  if (response.status !== 201 && response.status !== 200)
    throw new Error(`seed ${path} failed: ${response.status} ${response.text}`);
  return response.json<Created>().data.id;
}

async function seedProject(
  client: HttpsClient,
  label: "A" | "B",
  port: number,
): Promise<AutomationProject> {
  const suffix = randomBytes(2).toString("hex");
  const name = `Project ${label} ${suffix}`;
  const origin = `http://127.0.0.1:${port}`;
  const projectId = await create(client, "/v1/projects", { name });
  const environmentId = await create(client, `/v1/projects/${projectId}/environments`, {
    name: "staging",
    baseUrl: origin,
    networkProfile: "local-loopback",
  });
  const secretId = await create(client, "/v1/secrets", {
    name: `token-${label.toLowerCase()}-${suffix}`,
    value: `secret-${label.toLowerCase()}-${randomBytes(6).toString("hex")}`,
    allowedOrigins: [origin],
  });
  const testIds: string[] = [];
  for (const [index, base] of ["checkout", "profile"].entries()) {
    const plan = scaffoldPlan("backend");
    plan.name = `${label.toLowerCase()}-${base}`;
    const step = plan.steps[0];
    // Only the first test of each project uses the project's secret, so the mapping row is real.
    if (index === 0 && step?.operation === "request")
      step.input.headers = { Authorization: { secretRef: secretId } };
    testIds.push(
      await create(client, `/v1/projects/${projectId}/tests`, { plan, origin: "manual" }),
    );
  }
  return { projectId, name, environmentId, origin, secretId, testIds };
}

export async function seedAutomationWorld(client: HttpsClient): Promise<AutomationWorld> {
  return {
    a: await seedProject(client, "A", 4101),
    b: await seedProject(client, "B", 4102),
  };
}

interface MemberRow {
  readonly id: string;
  readonly principalId: string;
  readonly version: number;
}

/**
 * Changes which projects a member may reach, as an administrator would when access is revoked
 * (J09: "revoke B before the next dispatch").
 */
export async function setProjectRestrictions(
  client: HttpsClient,
  workspaceId: string,
  principalId: string,
  projectRestrictions: readonly string[],
): Promise<void> {
  const listed = await client.request("GET", `/v1/workspaces/${workspaceId}/members?limit=100`);
  const data = listed.json<{ data: MemberRow[] | { items: MemberRow[] } }>().data;
  const rows = Array.isArray(data) ? data : data.items;
  const member = rows.find((row) => row.principalId === principalId);
  if (!member) throw new Error(`no member for principal ${principalId}`);
  const changed = await client.mutate(
    "PATCH",
    `/v1/workspaces/${workspaceId}/members/${member.id}`,
    { projectRestrictions },
    { "if-match": `"${member.version}"` },
  );
  if (changed.status !== 200)
    throw new Error(`member update failed: ${changed.status} ${changed.text}`);
}

/**
 * M4-04/M4-05 style proof that a page only used documented routes: every `/v1` request the
 * browser made matches a row of the route catalog (method and path template); everything else
 * must be a static portal asset or a portal page.
 */
export function expectCatalogRequests(requests: readonly string[]): void {
  const templates = routeCatalog.map((route) => ({
    method: route.method,
    pattern: new RegExp(`^/v1${route.path.replace(/\{[^}]+\}/g, "[^/]+")}$`),
  }));
  const used = new Set<string>();
  for (const request of requests) {
    const [method = "", target = ""] = request.split(" ");
    const path = target.split("?")[0] ?? "";
    if (!path.startsWith("/v1/")) {
      expect(method, request).toMatch(/^(GET|HEAD)$/);
      continue;
    }
    const row = templates.find((entry) => entry.method === method && entry.pattern.test(path));
    expect(row, `not a catalog route: ${request}`).toBeDefined();
    used.add(`${method} ${row?.pattern.source}`);
  }
  expect(used.size, "the page made no catalog request at all").toBeGreaterThan(0);
}

/**
 * Creates a dynamic list over both projects through the portal form, choosing `staging` of each
 * project explicitly, and returns its ID once the detail page shows.
 */
export async function createListInPortal(
  page: Page,
  world: AutomationWorld,
  name: string,
): Promise<string> {
  await page.goto("/lists/new");
  await page.getByRole("heading", { level: 1, name: "New list" }).waitFor();
  await page.locator("#list-name").fill(name);
  for (const project of [world.a, world.b]) {
    await page.locator(`#include-${project.projectId}`).check();
    await page.locator(`#environment-${project.projectId}`).selectOption({ label: "staging" });
  }
  await page.getByRole("button", { name: "Create list" }).click();
  await page.waitForURL((url) => /^\/lists\/sui_[^/]+$/.test(url.pathname));
  await page.getByRole("heading", { level: 1, name }).waitFor();
  return new URL(page.url()).pathname.split("/").pop() ?? "";
}
