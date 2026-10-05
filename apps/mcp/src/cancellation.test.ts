import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { Application, scaffoldPlan } from "@testmaster/application";
import { expect, it } from "vitest";
import { createMcpServer } from "./server.js";

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
        application: app.withIdentity({ principalId: identity.principalId, scopes: ["R", "X"] }),
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
