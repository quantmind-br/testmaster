import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { setTimeout as delay } from "node:timers/promises";
import { ContractError } from "@testmaster/contracts";
import * as sandbox from "@testmaster/sandbox";
import { afterEach, expect, it, vi } from "vitest";
import { Application } from "./index.js";
import { isWriterContention, retryWriterContention } from "./writer-contention.js";

const directories: string[] = [];
const applications: Application[] = [];
const holders: DatabaseSync[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  for (const holder of holders.splice(0)) holder.close();
  for (const application of applications.splice(0)) application.close();
  for (const directory of directories.splice(0))
    await rm(directory, { recursive: true, force: true });
});
const contention = () =>
  new ContractError("UNAVAILABLE", "Local writer is busy; retry the operation", {
    reasonCode: "writer_contention",
    retryable: true,
  });

/** An application whose writer lock another connection holds until `release` is called. */
async function contended() {
  const directory = await mkdtemp(join(tmpdir(), "tm-worker-contention-"));
  directories.push(directory);
  const application = await Application.open({ cwd: directory, home: directory, env: {} });
  applications.push(application);
  await application.init();
  // Bound each wait for the lock so contention surfaces quickly and deterministically.
  application.database.exec("PRAGMA busy_timeout=10");
  const holder = new DatabaseSync(application.database.path);
  holders.push(holder);
  holder.exec("PRAGMA busy_timeout=5000; BEGIN IMMEDIATE");
  let held = true;
  const release = () => {
    if (!held) return;
    held = false;
    holder.exec("COMMIT");
  };
  // Observes every contended transaction the worker attempts.
  const refused: unknown[] = [];
  const original = application.database.withTx.bind(application.database);
  const onRefused: { current: (count: number) => void } = { current: () => {} };
  vi.spyOn(application.database, "withTx").mockImplementation((fn) => {
    try {
      return original(fn);
    } catch (error) {
      if (isWriterContention(error)) {
        refused.push(error);
        onRefused.current(refused.length);
      }
      throw error;
    }
  });
  return { application, release, refused, onRefused };
}

it("retries only typed writer contention, within the budget, and stops on abort", async () => {
  let calls = 0;
  await expect(
    retryWriterContention(() => {
      if (++calls < 3) throw contention();
      return "done";
    }),
  ).resolves.toBe("done");
  expect(calls).toBe(3);

  const other = new ContractError("UNAVAILABLE", "Upstream down", { reasonCode: "other" });
  calls = 0;
  await expect(
    retryWriterContention(() => {
      calls++;
      throw other;
    }),
  ).rejects.toBe(other);
  expect(calls).toBe(1);

  calls = 0;
  await expect(
    retryWriterContention(
      () => {
        calls++;
        throw contention();
      },
      { budgetMs: 200 },
    ),
  ).rejects.toMatchObject({ code: "UNAVAILABLE", details: { reasonCode: "writer_contention" } });
  expect(calls).toBeGreaterThan(1);

  const controller = new AbortController();
  calls = 0;
  await expect(
    retryWriterContention(
      () => {
        calls++;
        controller.abort();
        throw contention();
      },
      { budgetMs: 60_000, signal: controller.signal },
    ),
  ).rejects.toMatchObject({ details: { reasonCode: "writer_contention" } });
  expect(calls).toBe(1);
});

it("a worker survives transient writer contention and drains cleanly once the writer is free", async () => {
  const f = await contended();
  // The competing writer commits only after the worker has been refused repeatedly.
  f.onRefused.current = (count) => {
    if (count === 3) f.release();
  };
  await expect(
    f.application.worker.run({ ephemeral: true, runIds: [], writerContentionBudgetMs: 30_000 }),
  ).resolves.toMatchObject({ drained: true });
  expect(f.refused.length).toBeGreaterThanOrEqual(3);
});

it("a worker whose contention outlasts the budget fails with the typed retryable error instead of dying silently", async () => {
  const f = await contended();
  await expect(
    f.application.worker.run({ ephemeral: true, runIds: [], writerContentionBudgetMs: 200 }),
  ).rejects.toMatchObject({
    code: "UNAVAILABLE",
    details: { reasonCode: "writer_contention", retryable: true },
  });
  expect(f.refused.length).toBeGreaterThan(1);
  f.release();
});

it("a contended worker stops promptly when its signal aborts", async () => {
  const f = await contended();
  const controller = new AbortController();
  f.onRefused.current = () => controller.abort();
  const started = Date.now();
  await expect(
    f.application.worker.run({
      ephemeral: true,
      runIds: [],
      signal: controller.signal,
      writerContentionBudgetMs: 60_000,
    }),
  ).rejects.toMatchObject({ details: { reasonCode: "writer_contention" } });
  expect(Date.now() - started).toBeLessThan(5000);
  f.release();
});

it("worker registration at startup survives writer contention and creates exactly one ready-then-offline row", async () => {
  const f = await contended();
  const lock = await sandbox.readImageLock(
    new URL("../../../containers/images.lock.json", import.meta.url).pathname,
  );
  vi.spyOn(f.application, "images").mockResolvedValue(lock);
  f.onRefused.current = (count) => {
    if (count === 2) f.release();
  };
  const controller = new AbortController();
  const running = f.application.worker.run({
    signal: controller.signal,
    writerContentionBudgetMs: 30_000,
  });
  // The worker row appears only once registration got through the contention.
  const deadline = Date.now() + 10_000;
  while (
    f.application.database.get("SELECT 1 AS found FROM workers") === undefined &&
    Date.now() < deadline
  )
    await delay(20);
  controller.abort();
  await expect(running).resolves.toMatchObject({ drained: true });
  expect(f.refused.length).toBeGreaterThanOrEqual(2);
  expect(f.application.database.all("SELECT state FROM workers")).toEqual([{ state: "offline" }]);
});

it("the notification dispatcher reports a busy writer as the typed retryable refusal, never a raw SQLite error", async () => {
  const f = await contended();
  // Even with no integration, a scan records its cursor: that write used to be a bare statement
  // whose busy error escaped untyped (logged as `controller notifications failed: INTERNAL`).
  await expect(f.application.notifications.tick()).rejects.toMatchObject({
    code: "UNAVAILABLE",
    details: { reasonCode: "writer_contention", retryable: true },
  });
  expect(f.refused).toHaveLength(1);
  f.release();
  await expect(f.application.notifications.tick()).resolves.toEqual({ created: 0, attempted: 0 });
});
