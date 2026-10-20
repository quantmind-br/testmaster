import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { request } from "node:http";
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
  const post = (path: string, body: unknown = {}) =>
    fetch(`${address}/v1${path}`, {
      method: "POST",
      headers: { ...headers, "content-type": "application/json", "idempotency-key": randomUUID() },
      body: JSON.stringify(body),
    });
  const projectId = application.projects.create({ name: "Model routes" }).id;
  return { application, address, headers, post, projectId };
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

/** The `signal` of a service call's input or options, when it carries one. */
function signalIn(value: unknown): AbortSignal | undefined {
  return value &&
    typeof value === "object" &&
    "signal" in value &&
    value.signal instanceof AbortSignal
    ? value.signal
    : undefined;
}

/** The model routes, the service method each one calls and the argument that carries the signal. */
const modelRoutes = [
  {
    route: "POST /v1/runs/{id}/analysis",
    path: () => "/runs/run_slow/analysis",
    body: {},
    service: (application: Application) => application.analysis,
    method: "analyze",
    argument: 2,
  },
  {
    route: "POST /v1/runs/{id}/healing-proposals",
    path: () => "/runs/run_slow/healing-proposals",
    body: {},
    service: (application: Application) => application.healing,
    method: "propose",
    argument: 2,
  },
  {
    route: "POST /v1/projects/{id}/requirements/normalizations",
    path: (projectId: string) => `/projects/${projectId}/requirements/normalizations`,
    body: { sourceRevisionIds: ["svr_00000000-0000-4000-8000-000000000001"] },
    service: (application: Application) => application.requirements,
    method: "normalize",
    argument: 0,
  },
];

it.each(modelRoutes)(
  "a client that closes the connection of $route aborts the call's signal",
  async (route) => {
    const f = await fixture();
    const received = Promise.withResolvers<AbortSignal | undefined>();
    vi.spyOn(Object.getPrototypeOf(route.service(f.application)), route.method).mockImplementation(
      async (...args: unknown[]) => {
        const signal = signalIn(args[route.argument]);
        received.resolve(signal);
        if (!signal) return {};
        const aborted = Promise.withResolvers<void>();
        signal.addEventListener("abort", () => aborted.resolve(), { once: true });
        await aborted.promise;
        return {};
      },
    );
    const payload = JSON.stringify(route.body);
    const client = request(`${f.address}/v1${route.path(f.projectId)}`, {
      method: "POST",
      headers: {
        ...f.headers,
        "content-type": "application/json",
        "content-length": Buffer.byteLength(payload),
        "idempotency-key": randomUUID(),
      },
    });
    // The test destroys the socket itself, so the request's own error is expected.
    client.on("error", () => undefined);
    client.end(payload);
    const signal = await received.promise;
    expect(signal?.aborted).toBe(false);
    client.destroy();
    await expect.poll(() => signal?.aborted, { timeout: 2000 }).toBe(true);
  },
);

it.each(modelRoutes)(
  "a request of $route that completes leaves the call's signal unaborted",
  async (route) => {
    const f = await fixture();
    let received: AbortSignal | undefined;
    vi.spyOn(Object.getPrototypeOf(route.service(f.application)), route.method).mockImplementation(
      async (...args: unknown[]) => {
        received = signalIn(args[route.argument]);
        return {};
      },
    );
    const response = await f.post(route.path(f.projectId), route.body);
    expect(response.status).toBe(200);
    await response.arrayBuffer();
    // The server sees the response's end before this check: a close after the answer aborts nothing.
    await sleep(100);
    expect(received).toBeInstanceOf(AbortSignal);
    expect(received?.aborted).toBe(false);
  },
);
