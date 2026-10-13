import { type Application, scaffoldPlan } from "@testmaster/application";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { seedRun } from "../../packages/application/src/run-seed.testing.js";
import { nonCatalogApiRequests } from "./catalog-routes.js";
import { expectAccessible, type OpenPortal, openPortal } from "./portal.js";
import { type ServerStack, type StackUser, startServerStack } from "./server-stack.js";

/**
 * UX-048: expiring one artifact from the retention page, against a real admitted Run with stored
 * evidence. The Run is driven through the lease repository exactly as a worker would (seedRun);
 * everything the user does goes through the browser and the public /v1 API.
 */
let stack: ServerStack;
let system: Application;
let projectId = "";
let runId = "";
let viewer: StackUser;
const open: OpenPortal[] = [];

interface BundleEntry {
  artifactId: string;
  relativePath: string;
  state: string;
}

beforeAll(async () => {
  stack = await startServerStack();
  const workspaceId = stack.workspaces[0]?.workspaceId ?? "";
  system = (await stack.scope()).forWorkspaceSystem(workspaceId);
  projectId = String(system.projects.create({ name: "Artifact retention project" }).id);
  const environmentId = String(
    system.environments.create({ projectId, name: "staging", baseUrl: "http://127.0.0.1:9" }).id,
  );
  const testId = String(
    system.tests.create({ projectId, plan: scaffoldPlan("backend"), name: "Checkout flow" }).id,
  );
  const seeded = await seedRun(system, {
    testId,
    environmentId,
    attempts: [
      {
        outcome: "passed",
        steps: [{ stepId: "s1", status: "passed", evidence: ["logs/console.txt"] }],
        artifacts: [
          {
            relativePath: "logs/console.txt",
            kind: "console",
            mimeType: "text/plain",
            body: "console line one\n",
          },
          {
            relativePath: "logs/network.txt",
            kind: "network",
            mimeType: "text/plain",
            body: "GET /health 200\n",
          },
        ],
      },
    ],
  });
  runId = seeded.runId;
  viewer = await stack.addMember("viewer");
}, 600_000);

afterAll(async () => {
  for (const portal of open.splice(0)) await portal.close().catch(() => undefined);
  await stack?.stop();
});

async function portal(user: { login: string; password: string }): Promise<OpenPortal> {
  const opened = await openPortal(
    { baseUrl: stack.baseUrl, spkiSha256: stack.ca.spkiSha256 },
    user,
  );
  open.push(opened);
  return opened;
}

async function bundle(): Promise<BundleEntry[]> {
  const response = await stack.ownerClient().request("GET", `/v1/runs/${runId}/bundle`);
  expect(response.status).toBe(200);
  return response.json<{ data: { manifest: { entries: BundleEntry[] } } }>().data.manifest.entries;
}

describe("expiring an artifact from the retention page", () => {
  it("UX-048 UX-055 expires exactly one artifact after a contextual confirmation, keeps the run and the other artifact, and records a tombstone", async () => {
    const entries = await bundle();
    expect(entries.map((entry) => entry.state)).toEqual(["available", "available"]);
    const { page, diagnostics } = await portal(stack.owner);
    await page.goto(`/projects/${projectId}/retention`);
    await page.getByRole("heading", { level: 1, name: "Retention and deletion" }).waitFor();
    await page.getByRole("button", { name: `Show artifacts of ${runId}` }).click();
    const table = page.getByRole("table", { name: `Artifacts of run ${runId}` });
    await table.waitFor();
    await expectAccessible(page, "retention artifacts");
    expect(await table.innerText()).toContain("logs/console.txt");
    expect(await table.innerText()).toContain("logs/network.txt");

    await page.getByRole("button", { name: "Expire artifact logs/console.txt" }).click();
    const dialog = page.getByRole("dialog");
    const text = await dialog.innerText();
    expect(text).toContain("Artifact retention project");
    expect(text).toContain(runId);
    expect(text).toContain("logs/console.txt");
    expect(text).toContain("legal hold");
    // Negative control: cancelling changes nothing and sends no request.
    await dialog.getByRole("button", { name: "Cancel" }).click();
    expect((await bundle()).map((entry) => entry.state)).toEqual(["available", "available"]);
    expect(diagnostics.requests.filter((entry) => entry.startsWith("DELETE"))).toEqual([]);

    await page.getByRole("button", { name: "Expire artifact logs/console.txt" }).click();
    const confirm = page.getByRole("dialog").getByRole("button", { name: "Expire artifact" });
    await Promise.all([
      confirm.click({ force: true }),
      confirm.click({ force: true, timeout: 2000 }).catch(() => undefined),
    ]);
    await page.getByRole("dialog").waitFor({ state: "detached" });
    await table.getByText("Expired").first().waitFor();

    expect(
      diagnostics.requests.filter((entry) => entry.startsWith("DELETE /v1/artifacts/")),
    ).toHaveLength(1);
    const after = await bundle();
    const byPath = new Map(after.map((entry) => [entry.relativePath, entry.state]));
    expect(byPath.get("logs/console.txt")).toBe("expired");
    expect(byPath.get("logs/network.txt")).toBe("available");
    // The expired row offers no second action, and the page never claims the evidence did not exist.
    expect(
      await page.getByRole("button", { name: "Expire artifact logs/console.txt" }).count(),
    ).toBe(0);
    expect(
      await page.getByRole("button", { name: "Expire artifact logs/network.txt" }).count(),
    ).toBe(1);
    expect(await page.innerText("main")).not.toMatch(/never existed/iu);
    // The Run keeps its result and the deletion is listed with its own operation.
    const run = await stack.ownerClient().request("GET", `/v1/runs/${runId}`);
    expect(run.json<{ data: { status: string } }>().data.status).toBe("passed");
    const operations = await stack
      .ownerClient()
      .request("GET", `/v1/deletion-operations?projectId=${projectId}`);
    const listed = operations.json<{ data: { items: { id: string; resourceRefs: string[] }[] } }>()
      .data.items;
    expect(listed).toHaveLength(1);
    expect(listed[0]?.resourceRefs).toEqual([
      entries.find((entry) => entry.relativePath === "logs/console.txt")?.artifactId,
    ]);
    await page.getByRole("table", { name: "Deletion operations" }).waitFor();
    expect(await page.getByRole("table", { name: "Deletion operations" }).innerText()).toContain(
      listed[0]?.id ?? "",
    );
    expect(nonCatalogApiRequests(diagnostics.requests)).toEqual([]);
  });

  it("UX-048 UX-005 a viewer sees why artifacts cannot be expired and the server refuses the call", async () => {
    const { page } = await portal(viewer);
    await page.goto(`/projects/${projectId}/retention`);
    await page.getByRole("button", { name: `Show artifacts of ${runId}` }).click();
    const table = page.getByRole("table", { name: `Artifacts of run ${runId}` });
    await table.waitFor();
    expect(await page.getByRole("button", { name: /^Expire artifact/ }).count()).toBe(0);
    expect(await page.innerText("main")).toContain("Your role cannot expire artifacts.");
    const entry = (await bundle()).find((item) => item.relativePath === "logs/network.txt");
    const client = stack.anonymous();
    const login = await client.request("POST", "/v1/identity/login", {
      body: { principal: viewer.login, password: viewer.password },
      headers: { origin: stack.baseUrl, "idempotency-key": crypto.randomUUID() },
    });
    expect(login.status).toBe(200);
    client.csrfToken = login.json<{ data: { csrfToken: string } }>().data.csrfToken;
    const refused = await client.mutate("DELETE", `/v1/artifacts/${entry?.artifactId}`, undefined);
    expect(refused.status).toBe(403);
    expect((await bundle()).find((item) => item.relativePath === "logs/network.txt")?.state).toBe(
      "available",
    );
  });
});
