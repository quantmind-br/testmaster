import { afterEach, expect, it } from "vitest";
import { createListingTest, insertListedRuns } from "../../packages/application/src/ops.testkit.js";
import { type ServerStack, startServerStack } from "./server-stack.js";

const stacks: ServerStack[] = [];
afterEach(async () => {
  for (const stack of stacks.splice(0).reverse()) await stack.stop();
});
async function launch(options: Parameters<typeof startServerStack>[0] = {}): Promise<ServerStack> {
  const stack = await startServerStack(options);
  stacks.push(stack);
  return stack;
}
const bearer = (token: string) => ({ headers: { authorization: `Bearer ${token}` } });
const jsonLines = (text: string): Record<string, unknown>[] =>
  text.split("\n").flatMap((line) => {
    try {
      const parsed: unknown = JSON.parse(line);
      return parsed && typeof parsed === "object" ? [parsed as Record<string, unknown>] : [];
    } catch {
      return [];
    }
  });

it("M4-02 serves the operations routes over HTTPS: the owner pauses admission, a viewer may only read and an anonymous caller is refused", async () => {
  const stack = await launch();
  const owner = stack.ownerClient();
  const viewer = await stack.addMember("viewer");
  const viewerToken = await stack.issueToken(viewer.principalId, ["R"]);
  const anonymous = stack.anonymous();

  const paused = await owner.mutate("POST", "/v1/operations/admission", {
    action: "pause",
    reason: "change window",
  });
  expect(paused.status).toBe(200);
  const status = await owner.request("GET", "/v1/operations/status");
  expect(status.status).toBe(200);
  expect(status.json<{ data: { admission: { state: string } } }>().data.admission.state).toBe(
    "paused",
  );

  const viewerRead = await anonymous.request("GET", "/v1/operations/status", bearer(viewerToken));
  expect(viewerRead.status).toBe(200);
  expect(viewerRead.json<{ data: { admission: { state: string } } }>().data.admission.state).toBe(
    "paused",
  );
  const viewerWrite = await anonymous.request("POST", "/v1/operations/admission", {
    ...bearer(viewerToken),
    body: { action: "resume", reason: "viewers cannot" },
  });
  expect(viewerWrite.status).toBe(403);
  expect((await anonymous.request("GET", "/v1/operations/status")).status).toBe(401);

  const stillPaused = await owner.request("GET", "/v1/operations/status");
  expect(stillPaused.json<{ data: { admission: { state: string } } }>().data.admission.state).toBe(
    "paused",
  );
  const resumed = await owner.mutate("POST", "/v1/operations/admission", {
    action: "resume",
    reason: "done",
  });
  expect(resumed.status).toBe(200);
  const preview = await owner.mutate("POST", "/v1/operations/reconcile", { mode: "preview" });
  expect(preview.status).toBe(200);
  expect(preview.json<{ data: { kind: string; state: string } }>().data).toMatchObject({
    kind: "reconcile",
    state: "completed",
  });
  const applied = await owner.mutate("POST", "/v1/operations/reconcile", { mode: "apply" });
  expect(applied.status).toBe(200);
  const viewerReconcile = await anonymous.request("POST", "/v1/operations/reconcile", {
    ...bearer(viewerToken),
    body: { mode: "apply" },
  });
  expect(viewerReconcile.status).toBe(403);
  const alerts = await owner.request("GET", "/v1/alert-rules");
  expect(alerts.status).toBe(200);
  expect(alerts.json<{ data: { items: unknown[] } }>().data.items.length).toBe(10);
});

it("NFR-010 exposes opt-in Prometheus metrics for the caller's own workspace without tenant-identifying labels", async () => {
  const stack = await launch({
    workspaces: 2,
    config: { telemetry: { metrics: true, logExport: "none" } },
  });
  const first = stack.ownerClient(0);
  const second = stack.ownerClient(1);
  for (let index = 0; index < 3; index++) await first.request("GET", "/v1/operations/slo");
  await second.request("GET", "/v1/operations/status");

  const mine = await first.request("GET", "/v1/metrics");
  expect(mine.status).toBe(200);
  expect(String(mine.headers["content-type"])).toMatch(/^text\/plain/);
  expect(mine.text).toContain(
    'testmaster_api_requests_total{method="GET",route="/v1/operations/slo",status_class="2xx"} 3',
  );
  const theirs = await second.request("GET", "/v1/metrics");
  expect(theirs.text).toContain('route="/v1/operations/status"');
  expect(theirs.text).not.toContain('route="/v1/operations/slo"');
  for (const text of [mine.text, theirs.text]) {
    for (const workspace of stack.workspaces) expect(text).not.toContain(workspace.workspaceId);
    for (const line of text.split("\n").filter((entry) => entry.includes("{")))
      expect(line).not.toMatch(/(workspace|tenant|principal|project|run_id)[a-z_]*=/);
  }
  expect((await stack.anonymous().request("GET", "/v1/metrics")).status).toBe(401);
});

it("OPS-027 exports redacted JSON log lines on stdout only under the log export policy and never a secret", async () => {
  const exporting = await launch({
    config: { telemetry: { metrics: false, logExport: "stdout-json" } },
  });
  const canary = "canary-secret-7d3f9a1c";
  const client = exporting.ownerClient();
  const viewer = await exporting.addMember("viewer");
  const token = await exporting.issueToken(viewer.principalId, ["R"]);
  await exporting.anonymous().request("GET", `/v1/operations/status?probe=${canary}`, {
    headers: {
      authorization: `Bearer ${token}`,
      "x-canary": canary,
      "x-correlation-id": "corr-export-1",
    },
  });
  await client.mutate("POST", "/v1/operations/admission", { action: "pause", reason: canary });
  await client.mutate("POST", "/v1/operations/admission", { action: "resume", reason: "done" });

  const logs = exporting.logs();
  const requests = jsonLines(logs).filter((line) => line.event === "request.completed");
  expect(requests.length).toBeGreaterThanOrEqual(3);
  expect(
    requests.some((line) => line.correlationId === "corr-export-1" && line.statusCode === 200),
  ).toBe(true);
  expect(Object.keys(requests[0] ?? {}).sort()).toEqual(
    [
      "component",
      "correlationId",
      "droppedCount",
      "event",
      "level",
      "statusCode",
      "timestamp",
    ].sort(),
  );
  expect(logs).not.toContain(canary);
  expect(logs).not.toContain(token);
  expect(logs).not.toMatch(/__Host-tm_session=[A-Za-z0-9_-]{20}/);

  const silent = await launch({ config: { telemetry: { metrics: false, logExport: "none" } } });
  await silent.ownerClient().request("GET", "/v1/operations/status");
  expect(jsonLines(silent.logs()).filter((line) => line.event === "request.completed")).toEqual([]);
});

it("NFR-006 pages GET /v1/runs through a signed cursor over the lazily ordered listing, newest first and filtered", async () => {
  const stack = await launch();
  const scope = (await stack.scope()).forWorkspaceSystem(stack.workspaceId);
  const first = createListingTest(scope, "HTTP listing first");
  const second = createListingTest(scope, "HTTP listing second");
  const passed = insertListedRuns(scope, first, 230);
  const failed = insertListedRuns(scope, second, 20, { from: 300, outcome: "failed" });
  const owner = stack.ownerClient();
  type Page = { data: { items: { id: string }[]; hasMore: boolean; nextCursor: string | null } };

  const collected: string[] = [];
  let cursor: string | null = null;
  let pages = 0;
  do {
    const query: string = `limit=100${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`;
    const response = await owner.request("GET", `/v1/runs?${query}`);
    expect(response.status).toBe(200);
    const body = response.json<Page>().data;
    collected.push(...body.items.map((run) => run.id));
    cursor = body.nextCursor;
    pages++;
  } while (cursor);
  expect(pages).toBe(3);
  expect(collected).toEqual([...passed, ...failed].reverse());

  const filtered = await owner.request("GET", `/v1/runs?status=failed&testId=${second.testId}`);
  expect(
    filtered
      .json<Page>()
      .data.items.map((run) => run.id)
      .sort(),
  ).toEqual([...failed].sort());
  const byProject = await owner.request("GET", `/v1/runs?projectId=${first.projectId}&limit=100`);
  expect(byProject.json<Page>().data.items).toHaveLength(100);
  const none = await owner.request("GET", "/v1/runs?projectId=prj_missing");
  expect(none.json<Page>().data).toEqual({ items: [], hasMore: false, nextCursor: null });

  const firstPage = await owner.request("GET", "/v1/runs?limit=5&status=passed");
  const issued = firstPage.json<Page>().data.nextCursor as string;
  const otherFilter = await owner.request(
    "GET",
    `/v1/runs?limit=5&status=failed&cursor=${encodeURIComponent(issued)}`,
  );
  expect(otherFilter.status).toBe(400);
  const viewer = await stack.addMember("viewer");
  const viewerToken = await stack.issueToken(viewer.principalId, ["R"]);
  const viewerPage = await stack
    .anonymous()
    .request("GET", "/v1/runs?limit=5", bearer(viewerToken));
  expect(viewerPage.status).toBe(200);
  expect(viewerPage.json<Page>().data.items).toHaveLength(5);
  const anonymous = await stack.anonymous().request("GET", "/v1/runs");
  expect(anonymous.status).toBe(401);
});
