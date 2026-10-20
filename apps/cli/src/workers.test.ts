import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Writable } from "node:stream";
import { Application, scaffoldPlan } from "@testmaster/application";
import { afterEach, expect, it, vi } from "vitest";
import {
  AttemptExecutor,
  DockerExecutor,
  readImageLock,
} from "../../../packages/sandbox/src/index.js";
import { runCli } from "./cli.js";
import { Runtime } from "./runtime.js";

const cleanups: (() => Promise<void>)[] = [];
const originalExit = process.exitCode;
afterEach(async () => {
  process.exitCode = originalExit;
  vi.restoreAllMocks();
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

it("worker start drains on the first interruption and stops the attempt in flight on the second", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "tm-cli-worker-"));
  const home = join(cwd, "home");
  await mkdir(home);
  const app = await Application.open({ cwd, home, env: {} });
  cleanups.push(async () => {
    app.close();
    await rm(cwd, { recursive: true, force: true });
  });
  const init = await app.init();
  // Admission and the worker see the checked-in image lock; the attempt never reaches Docker.
  const lock = await readImageLock(
    new URL("../../../containers/images.lock.json", import.meta.url).pathname,
  );
  vi.spyOn(app, "preflight").mockResolvedValue();
  vi.spyOn(app, "images").mockResolvedValue(lock);
  vi.spyOn(app.runs.host, "admittedImages").mockReturnValue(lock);
  vi.spyOn(DockerExecutor.prototype, "listOrphans").mockResolvedValue([]);
  const started = Promise.withResolvers<AbortSignal>();
  vi.spyOn(AttemptExecutor.prototype, "execute").mockImplementation(async (_input, signal) => {
    if (!signal) throw new Error("The worker runs every attempt with an abort signal");
    started.resolve(signal);
    await new Promise((resolve) => signal.addEventListener("abort", resolve, { once: true }));
    return { outcome: "cancelled", reasonCode: "user_cancelled", logDropped: 0, events: [] };
  });
  const test = app.tests.create({ projectId: init.projectId, plan: scaffoldPlan("backend") });
  await app.runs.admit({ testId: test.id, environmentId: init.environmentId }, { wait: true });
  let stdout = "";
  let stderr = "";
  const sink = (append: (text: string) => void) =>
    new Writable({
      write(chunk, _encoding, done) {
        append(String(chunk));
        done();
      },
    });
  const runtime = new Runtime(
    sink((text) => {
      stdout += text;
    }),
    sink((text) => {
      stderr += text;
    }),
  );
  runtime.app = async () => app;
  process.exitCode = 0;
  const command = runCli(["--json", "--cwd", cwd, "worker", "start"], runtime);
  const signal = await started.promise;
  runtime.interrupt("SIGTERM");
  expect(stderr).toContain(
    "worker draining: attempts in flight finish first; interrupt again to stop them now",
  );
  // The draining worker keeps scheduling passes, each a new heartbeat, with the attempt still running.
  const heartbeats = new Set<unknown>();
  await vi.waitFor(
    () => {
      heartbeats.add(app.database.get("SELECT last_heartbeat_at FROM workers")?.last_heartbeat_at);
      if (heartbeats.size < 3) throw new Error("The worker has not scheduled again yet");
    },
    { timeout: 10_000, interval: 10 },
  );
  expect(signal.aborted).toBe(false);
  runtime.interrupt("SIGINT");
  await command;
  expect(signal.aborted).toBe(true);
  // The exit code and the envelope name the interruption that started the stop.
  expect(process.exitCode).toBe(143);
  expect(JSON.parse(stdout)).toMatchObject({
    error: { code: "UNAVAILABLE", details: { signal: "SIGTERM" } },
  });
});
