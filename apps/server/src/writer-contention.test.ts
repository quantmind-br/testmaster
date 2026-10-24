import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { Application, issueLocalToken } from "@testmaster/application";
import { afterEach, expect, it } from "vitest";
import { createServer } from "./server.js";

const cleanup: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close();
});
async function fixture() {
  const cwd = await mkdtemp(join(tmpdir(), "tm-writer-contention-"));
  const home = join(cwd, "home");
  await mkdir(home);
  const application = await Application.open({ cwd, home, env: {} });
  await application.init();
  const issued = await issueLocalToken(application);
  const server = createServer({ application, mcp: false });
  const address = await server.listen({ host: "127.0.0.1", port: 0 });
  cleanup.push(async () => {
    await server.close();
    application.close();
    await rm(cwd, { recursive: true, force: true });
  });
  // The wait for the writer lock is bounded so the contended request answers quickly.
  application.database.exec("PRAGMA busy_timeout=20");
  const holder = new DatabaseSync(application.database.path);
  cleanup.push(() => holder.close());
  return {
    issued,
    hold: () => holder.exec("PRAGMA busy_timeout=5000; BEGIN IMMEDIATE"),
    release: () => holder.exec("COMMIT"),
    get: (path: string, authorization?: string) =>
      fetch(`${address}${path}`, authorization ? { headers: { authorization } } : {}),
    post: (path: string, authorization: string) =>
      fetch(`${address}${path}`, {
        method: "POST",
        headers: { authorization, "content-type": "application/json" },
        body: "{}",
      }),
  };
}

async function expectContended(response: Response, label: string) {
  expect(response.status, label).toBe(503);
  expect(response.headers.get("content-type"), label).toContain("application/json");
  const correlation = response.headers.get("x-correlation-id");
  expect(correlation, label).toBeTruthy();
  expect(await response.json(), label).toMatchObject({
    schemaVersion: "1.0.0",
    requestId: correlation,
    error: {
      code: "UNAVAILABLE",
      retryable: true,
      details: { reasonCode: "writer_contention", retryable: true },
      nextActions: [],
    },
  });
}

it("answers authenticated reads under writer contention and refuses audited requests with the enveloped 503, then recovers", async () => {
  const f = await fixture();
  const bearer = `Bearer ${f.issued.token}`;
  // Positive controls before contention: the credential alone decides the outcome.
  expect((await f.get("/v1/projects")).status).toBe(401);
  expect((await f.get("/v1/projects", bearer)).status).toBe(200);
  f.hold();
  try {
    for (const path of ["/v1/me", "/v1/projects"]) {
      // A successful read writes no audit row, so it never waits on the writer.
      expect((await f.get(path, bearer)).status, `${path} authenticated`).toBe(200);
      // A denial is always audited; when that row cannot be written the refusal is the 503.
      await expectContended(await f.get(path), `${path} anonymous`);
    }
    // An authenticated write is audited before its route runs.
    await expectContended(await f.post("/v1/runs/run_missing/cancel", bearer), "write");
  } finally {
    f.release();
  }
  // Liveness: once the writer is free the same server answers normally again.
  expect((await f.get("/v1/projects")).status).toBe(401);
  expect((await f.get("/v1/projects", bearer)).status).toBe(200);
});
