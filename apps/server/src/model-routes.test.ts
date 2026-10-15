import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Application, issueLocalToken } from "@testmaster/application";
import { afterEach, expect, it, vi } from "vitest";
import { createServer } from "./server.js";

const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  for (const close of cleanup.splice(0).reverse()) await close();
});

// Real timers on purpose: the behavior under test is the platform's idle socket timer, which fake
// timers do not drive. The configured timeout is shortened so the test costs about one second.
const idleTimeoutMs = 300;
const slowMs = 1200;
const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

async function fixture() {
  const cwd = await mkdtemp(join(tmpdir(), "tm-model-routes-"));
  const home = join(cwd, "home");
  await mkdir(home);
  const application = await Application.open({ cwd, home, env: {} });
  await application.init();
  const issued = await issueLocalToken(application);
  const server = createServer({
    application,
    mcp: false,
    portal: false,
    connectionTimeoutMs: idleTimeoutMs,
  });
  // An ordinary route that, like a model route, writes nothing until it has waited for a while.
  server.get("/v1/slow-control", async () => {
    await sleep(slowMs);
    return { ok: true };
  });
  const address = await server.listen({ host: "127.0.0.1", port: 0 });
  cleanup.push(async () => {
    await server.close();
    application.close();
    await rm(cwd, { recursive: true, force: true });
  });
  const headers = { authorization: `Bearer ${issued.token}` };
  const post = (path: string) =>
    fetch(`${address}/v1${path}`, {
      method: "POST",
      headers: { ...headers, "content-type": "application/json", "idempotency-key": randomUUID() },
      body: "{}",
    });
  return { application, address, headers, post };
}

it("an ordinary route that stays silent past the idle socket timeout loses its connection", async () => {
  const f = await fixture();
  await expect(fetch(`${f.address}/v1/slow-control`, { headers: f.headers })).rejects.toThrow();
});

it("routes that run a model call keep their connection past the idle socket timeout", async () => {
  const f = await fixture();
  const analyze = vi
    .spyOn(Object.getPrototypeOf(f.application.analysis), "analyze")
    .mockImplementation(async () => {
      await sleep(slowMs);
      return { id: "ana_slow" };
    });
  const propose = vi
    .spyOn(Object.getPrototypeOf(f.application.healing), "propose")
    .mockImplementation(async () => {
      await sleep(slowMs);
      return { id: "hpr_slow" };
    });
  const analysis = await f.post("/runs/run_slow/analysis");
  expect(analysis.status).toBe(200);
  expect((await analysis.json()).data).toEqual({ id: "ana_slow" });
  const healing = await f.post("/runs/run_slow/healing-proposals");
  expect(healing.status).toBe(200);
  expect((await healing.json()).data).toEqual({ id: "hpr_slow" });
  expect(analyze).toHaveBeenCalledTimes(1);
  expect(propose).toHaveBeenCalledTimes(1);
});
