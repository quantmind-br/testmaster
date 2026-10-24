import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { createServer as createSocketServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Writable } from "node:stream";
import { setTimeout as delay } from "node:timers/promises";
import { Application } from "@testmaster/application";
import { ContractError } from "@testmaster/contracts";
import { afterEach, expect, it, vi } from "vitest";
import { runCli } from "./cli.js";
import { Runtime } from "./runtime.js";

const cleanups: (() => Promise<void>)[] = [];
const originalExit = process.exitCode;
afterEach(async () => {
  process.exitCode = originalExit;
  vi.restoreAllMocks();
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

function freePort(): Promise<number> {
  const { promise, resolve, reject } = Promise.withResolvers<number>();
  const probe = createSocketServer();
  probe.once("error", reject);
  probe.listen(0, "127.0.0.1", () => {
    const address = probe.address();
    const port = typeof address === "object" && address ? address.port : 0;
    probe.close(() => resolve(port));
  });
  return promise;
}
async function fixture() {
  const cwd = await mkdtemp(join(tmpdir(), "tm-cli-server-lifecycle-"));
  const home = join(cwd, "home");
  await mkdir(home);
  const app = await Application.open({ cwd, home, env: {} });
  cleanups.push(async () => {
    app.close();
    await rm(cwd, { recursive: true, force: true });
  });
  await app.init();
  const port = await freePort();
  const invoke = async (
    interruptWhileOpening = false,
    observe?: (runtime: Runtime, stdout: () => string) => void,
  ) => {
    let stdout = "";
    let stderr = "";
    const collect = (sink: (text: string) => void) =>
      new Writable({
        write(chunk, _encoding, done) {
          sink(String(chunk));
          done();
        },
      });
    const runtime = new Runtime(
      collect((text) => {
        stdout += text;
      }),
      collect((text) => {
        stderr += text;
      }),
    );
    observe?.(runtime, () => stdout);
    runtime.app = async () => {
      if (interruptWhileOpening) runtime.interrupt("SIGTERM");
      return app;
    };
    process.exitCode = 0;
    await runCli(["--json", "--cwd", cwd, "server", "start", "--port", String(port)], runtime);
    const documents = stdout
      .split("\n")
      .filter(Boolean)
      .map(
        (line) =>
          JSON.parse(line) as { error?: { code: string; details?: Record<string, unknown> } },
      );
    return { exit: process.exitCode ?? 0, documents, stderr };
  };
  const listening = () =>
    fetch(`http://127.0.0.1:${port}/v1/health/live`).then(
      () => true,
      () => false,
    );
  return { app, invoke, listening };
}

it("a local server whose worker fails stops serving and exits with the worker's typed error", async () => {
  const f = await fixture();
  vi.spyOn(f.app.worker, "run").mockRejectedValue(
    new ContractError("UNAVAILABLE", "Local writer is busy; retry the operation", {
      reasonCode: "writer_contention",
      retryable: true,
    }),
  );
  const result = await f.invoke();
  expect(result.exit).toBe(10);
  expect(result.stderr).toContain("worker failed: UNAVAILABLE");
  expect(result.documents.find((document) => document.error)?.error).toMatchObject({
    code: "UNAVAILABLE",
    details: { reasonCode: "writer_contention", retryable: true },
  });
  // No healthy-looking zombie: the HTTP listener is gone.
  expect(await f.listening()).toBe(false);
}, 30_000);

it("a local server whose worker drains by itself shuts down cleanly instead of serving without a worker", async () => {
  const f = await fixture();
  vi.spyOn(f.app.worker, "run").mockResolvedValue({ workerId: null, drained: true });
  const result = await f.invoke();
  expect(result.exit).toBe(0);
  expect(result.stderr).toContain("worker drained; shutting the server down");
  expect(result.documents.some((document) => document.error)).toBe(false);
  expect(await f.listening()).toBe(false);
}, 30_000);

it("a local server announces itself and listens only once its worker is ready to claim", async () => {
  const f = await fixture();
  const workerReady = Promise.withResolvers<void>();
  vi.spyOn(f.app.worker, "run").mockImplementation(async (options = {}) => {
    await workerReady.promise;
    options.onReady?.("wrk_ready");
    const { signal } = options;
    if (signal && !signal.aborted)
      await new Promise((resolve) => signal.addEventListener("abort", resolve, { once: true }));
    return { workerId: "wrk_ready", drained: true };
  });
  let runtime: Runtime | undefined;
  let stdout = () => "";
  const result = f.invoke(false, (observed, read) => {
    runtime = observed;
    stdout = read;
  });
  // The receipt is what clients wait for; before the worker is ready, a Run sent on it would be
  // refused with "No live worker".
  await delay(1000);
  expect(stdout()).toBe("");
  expect(await f.listening()).toBe(false);
  workerReady.resolve();
  await vi.waitFor(() => expect(stdout()).toContain("tokenPath"), { timeout: 10_000 });
  expect(await f.listening()).toBe(true);
  runtime?.interrupt("SIGTERM");
  await result;
  expect(await f.listening()).toBe(false);
}, 30_000);

it("a local server interrupted while it opens starts neither its worker nor its listener", async () => {
  const f = await fixture();
  const run = vi.spyOn(f.app.worker, "run").mockResolvedValue({ workerId: null, drained: true });
  const result = await f.invoke(true);
  expect(run).not.toHaveBeenCalled();
  expect(result.exit).toBe(143);
  expect(result.stderr).not.toContain("worker draining");
  expect(result.documents.find((document) => document.error)?.error).toMatchObject({
    code: "UNAVAILABLE",
    details: { signal: "SIGTERM" },
  });
  expect(await f.listening()).toBe(false);
}, 30_000);

/** A server whose notifications controller fails once with `failure` while the worker idles briefly. */
async function stderrAfterControllerFailure(failure: Error): Promise<string> {
  const f = await fixture();
  vi.spyOn(f.app.notifications, "tick").mockRejectedValue(failure);
  vi.spyOn(f.app.worker, "run").mockImplementation(async () => {
    await delay(500);
    return { workerId: null, drained: true };
  });
  const result = await f.invoke();
  expect(result.exit).toBe(0);
  return result.stderr;
}

it("a controller failure with an untrusted error prints no name, code, message or errstr it carries", async () => {
  const secret = "sk-live-secret-7f3a";
  const hostile = Object.assign(new Error(`password=${secret} INSERT ... VALUES ('${secret}')`), {
    name: `Failure-${secret}`,
    code: `E_${secret}`,
    errcode: secret,
    errstr: secret,
  });
  const stderr = await stderrAfterControllerFailure(hostile);
  expect(stderr).toContain("controller notifications failed: INTERNAL\n");
  expect(stderr).not.toContain(secret);
  // A spoofed SQLite code still prints only a known errstr and an integer errcode.
  const spoofed = Object.assign(new Error(secret), {
    code: "ERR_SQLITE_ERROR",
    errcode: 5,
    errstr: secret,
  });
  const spoofedStderr = await stderrAfterControllerFailure(spoofed);
  expect(spoofedStderr).toContain(
    "controller notifications failed: INTERNAL (Error ERR_SQLITE_ERROR errcode=5)\n",
  );
  expect(spoofedStderr).not.toContain(secret);
}, 60_000);

it("a controller failure from SQLite names the fixed code and reason so it is diagnosable", async () => {
  const busy = Object.assign(new Error("database is locked"), {
    code: "ERR_SQLITE_ERROR",
    errcode: 5,
    errstr: "database is locked",
  });
  expect(await stderrAfterControllerFailure(busy)).toContain(
    "controller notifications failed: INTERNAL (Error ERR_SQLITE_ERROR errcode=5 database is locked)\n",
  );
  const typed = new ContractError("UNAVAILABLE", "Local writer is busy; retry the operation", {
    reasonCode: "writer_contention",
    retryable: true,
  });
  expect(await stderrAfterControllerFailure(typed)).toContain(
    "controller notifications failed: UNAVAILABLE (writer_contention)\n",
  );
}, 60_000);
