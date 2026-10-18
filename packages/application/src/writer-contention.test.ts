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
  vi.useRealTimers();
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
  // Bound each synchronous wait for the lock so contention surfaces quickly and deterministically.
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

it("retries only typed writer contention and rethrows anything else at once", async () => {
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
});

it("keeps waiting while the writer stays held, far past the former 20 s budget, and resolves after release", async () => {
  vi.useFakeTimers();
  vi.spyOn(Math, "random").mockReturnValue(0.999);
  const notices: number[] = [];
  let released = false;
  let calls = 0;
  const outcome = retryWriterContention(
    () => {
      calls++;
      if (!released) throw contention();
      return "done";
    },
    { onContended: (elapsedMs) => notices.push(elapsedMs) },
  );
  let settled = false;
  outcome.then(
    () => {
      settled = true;
    },
    () => {
      settled = true;
    },
  );
  await vi.advanceTimersByTimeAsync(60_000);
  // Full jitter is capped at 1 s, so a held writer is retried about once a second, never failed.
  expect(settled).toBe(false);
  expect(calls).toBeGreaterThan(30);
  // The observability callback fires exactly once, after 5 s of waiting.
  expect(notices).toHaveLength(1);
  expect(notices[0]).toBeGreaterThanOrEqual(5000);
  released = true;
  await vi.advanceTimersByTimeAsync(1000);
  await expect(outcome).resolves.toBe("done");
});

it("a throwing observability callback never turns the wait into a failure", async () => {
  vi.useFakeTimers();
  vi.spyOn(Math, "random").mockReturnValue(0.999);
  let released = false;
  const outcome = retryWriterContention(
    () => {
      if (!released) throw contention();
      return "done";
    },
    {
      onContended: () => {
        throw new Error("log sink down");
      },
    },
  );
  await vi.advanceTimersByTimeAsync(7000);
  released = true;
  await vi.advanceTimersByTimeAsync(1000);
  await expect(outcome).resolves.toBe("done");
});

it("abort ends the wait promptly and rethrows the last typed refusal", async () => {
  vi.useFakeTimers();
  const refusal = contention();
  const controller = new AbortController();
  let calls = 0;
  const outcome = retryWriterContention(
    () => {
      calls++;
      throw refusal;
    },
    { signal: controller.signal },
  );
  const assertion = expect(outcome).rejects.toBe(refusal);
  await vi.advanceTimersByTimeAsync(300);
  const attempts = calls;
  expect(attempts).toBeGreaterThan(0);
  controller.abort();
  await assertion;
  expect(calls).toBe(attempts);

  const aborted = new AbortController();
  aborted.abort();
  calls = 0;
  await expect(
    retryWriterContention(
      () => {
        calls++;
        throw contention();
      },
      { signal: aborted.signal },
    ),
  ).rejects.toMatchObject({ details: { reasonCode: "writer_contention" } });
  expect(calls).toBe(1);
});

it("never waits while the caller's own transaction is open", async () => {
  let calls = 0;
  await expect(
    retryWriterContention(
      () => {
        calls++;
        throw contention();
      },
      { inTransaction: () => true },
    ),
  ).rejects.toMatchObject({ code: "INTERNAL", details: { reasonCode: "wait_in_transaction" } });
  expect(calls).toBe(1);
});

it("a worker survives transient writer contention and drains cleanly once the writer is free", async () => {
  const f = await contended();
  // The competing writer commits only after the worker has been refused repeatedly.
  f.onRefused.current = (count) => {
    if (count === 3) f.release();
  };
  await expect(f.application.worker.run({ ephemeral: true, runIds: [] })).resolves.toMatchObject({
    drained: true,
  });
  expect(f.refused.length).toBeGreaterThanOrEqual(3);
});

it("a worker whose writer stays contended keeps waiting instead of failing, and drains once the writer is free", async () => {
  const f = await contended();
  let settled = false;
  const running = f.application.worker.run({ ephemeral: true, runIds: [] });
  running.then(
    () => {
      settled = true;
    },
    () => {
      settled = true;
    },
  );
  const deadline = Date.now() + 10_000;
  while (f.refused.length < 6 && Date.now() < deadline) await delay(20);
  expect(f.refused.length).toBeGreaterThanOrEqual(6);
  expect(settled).toBe(false);
  f.release();
  await expect(running).resolves.toMatchObject({ drained: true });
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
    }),
  ).rejects.toMatchObject({ details: { reasonCode: "writer_contention" } });
  expect(Date.now() - started).toBeLessThan(2000);
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
