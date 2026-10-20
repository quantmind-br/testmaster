import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { Application, scaffoldPlan } from "@testmaster/application";
import { afterEach, expect, it, vi } from "vitest";
import { createMcpServer } from "./server.js";

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

it("disconnect detaches waits, explicit negotiated cancellation requests durable cancellation", async () => {
  const temporary = await mkdtemp(join(tmpdir(), "tm-mcp-cancel-"));
  const cwd = join(temporary, "repo");
  await mkdir(cwd);
  const app = await Application.open({
    cwd,
    home: join(temporary, "home"),
    env: { TESTMASTER_DATA_DIR: join(temporary, "data") },
  });
  try {
    const identity = await app.init();
    const test = app.tests.create({ projectId: identity.projectId, plan: scaffoldPlan("backend") });
    for (const explicit of [false, true]) {
      const prepared = app.runs.prepare({
        testId: test.id,
        environmentId: identity.environmentId,
        mode: "replay",
      });
      const receipt = app.database.withTx(() =>
        app.runs.insert(prepared, `cancel-test-key-${explicit}`),
      );
      const mcp = createMcpServer({
        application: app.forIdentity({ principalId: identity.principalId, scopes: ["R", "X"] }),
        roots: [cwd],
      });
      const [left, right] = InMemoryTransport.createLinkedPair();
      await mcp.connect(right);
      const client = new Client({ name: "cancellation", version: "1" });
      await client.connect(left);
      const controller = new AbortController();
      const ready = Promise.withResolvers<void>();
      const call = client
        .callTool(
          { name: "testmaster_get_run", arguments: { runId: receipt.runId, wait: true } },
          undefined,
          { signal: controller.signal, onprogress: () => ready.resolve() },
        )
        .catch(() => null);
      await ready.promise;
      if (explicit) controller.abort();
      else await client.close();
      await call;
      await delay(400);
      expect(
        app.runs.events(receipt.runId).some((event) => event.type === "run.cancel_requested"),
      ).toBe(explicit);
      await client.close();
      await mcp.close();
    }
  } finally {
    app.close();
    await rm(temporary, { recursive: true, force: true });
  }
});

async function fixture() {
  const cwd = await mkdtemp(join(tmpdir(), "tm-mcp-cancellation-"));
  const app = await Application.open({ cwd, home: join(cwd, "home"), env: {} });
  const init = await app.init();
  const server = createMcpServer({
    application: app.forIdentity({ principalId: init.principalId, scopes: ["R", "W", "X"] }),
    roots: [cwd],
  });
  const [left, right] = InMemoryTransport.createLinkedPair();
  await server.connect(right);
  const client = new Client({ name: "cancellation-test", version: "1" });
  await client.connect(left);
  cleanups.push(async () => {
    await client.close();
    await server.close();
    app.close();
    await rm(cwd, { recursive: true, force: true });
  });
  return { app, client };
}

/** The `signal` of a service call's options, when it carries one. */
function signalIn(value: unknown): AbortSignal | undefined {
  return value &&
    typeof value === "object" &&
    "signal" in value &&
    value.signal instanceof AbortSignal
    ? value.signal
    : undefined;
}

const missingRun = "run_019bf434-20c0-7000-8000-000000000001";

it.each([
  {
    tool: "testmaster_analyze_run",
    service: (app: Application) => app.analysis,
    method: "analyze",
  },
  {
    tool: "testmaster_propose_healing",
    service: (app: Application) => app.healing,
    method: "propose",
  },
])("cancelling a $tool request aborts the signal its service received", async (target) => {
  const f = await fixture();
  const received = Promise.withResolvers<AbortSignal | undefined>();
  vi.spyOn(Object.getPrototypeOf(target.service(f.app)), target.method).mockImplementation(
    async (...args: unknown[]) => {
      const signal = signalIn(args[2]);
      received.resolve(signal);
      if (!signal) return {};
      const aborted = Promise.withResolvers<void>();
      signal.addEventListener("abort", () => aborted.resolve(), { once: true });
      await aborted.promise;
      return {};
    },
  );
  const controller = new AbortController();
  const call = f.client.callTool(
    { name: target.tool, arguments: { runId: missingRun } },
    undefined,
    { signal: controller.signal },
  );
  const signal = await received.promise;
  expect(signal?.aborted).toBe(false);
  controller.abort();
  await expect(call).rejects.toThrow();
  await expect.poll(() => signal?.aborted, { timeout: 2000 }).toBe(true);
});

it("a testmaster_analyze_run request that is not cancelled leaves the signal its service received unaborted", async () => {
  const f = await fixture();
  // The real service answers NOT_FOUND for the unknown run: the call completes on its own.
  const analyze = vi.spyOn(Object.getPrototypeOf(f.app.analysis), "analyze");
  const result = await f.client.callTool({
    name: "testmaster_analyze_run",
    arguments: { runId: missingRun },
  });
  expect(result.isError).toBe(true);
  expect(analyze).toHaveBeenCalledTimes(1);
  const signal = signalIn(analyze.mock.calls[0]?.[2]);
  expect(signal).toBeInstanceOf(AbortSignal);
  expect(signal?.aborted).toBe(false);
});
