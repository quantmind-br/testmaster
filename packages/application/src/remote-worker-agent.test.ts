import { spawn } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { isTransientFailure, lockWorkerDataDir, RemoteCallError } from "./remote-worker-agent.js";

const refusal = (status: number, code = "INTERNAL") =>
  new RemoteCallError(status, code, `HTTP ${status}`, {});

describe("remote worker retries", () => {
  it("OPS-001 retries a reset connection and a gateway that lost its controller, never a controller's refusal", () => {
    expect(isTransientFailure(new Error("socket hang up"))).toBe(true);
    // A proxy in front of restarting controllers answers 502 or 504 without an error envelope.
    for (const status of [502, 504]) expect(isTransientFailure(refusal(status))).toBe(true);
    expect(isTransientFailure(refusal(503, "UNAVAILABLE"))).toBe(true);
    expect(isTransientFailure(refusal(429, "RATE_LIMITED"))).toBe(true);
    // The controller's own refusals are final: retrying them would repeat a denied effect.
    expect(isTransientFailure(refusal(409, "LEASE_LOST"))).toBe(false);
    expect(isTransientFailure(refusal(403, "FORBIDDEN"))).toBe(false);
    expect(isTransientFailure(refusal(500))).toBe(false);
  });
});

describe("remote worker data-dir lock", () => {
  let dataDir: string;
  beforeEach(async () => {
    dataDir = await mkdtemp(join(tmpdir(), "tm-worker-lock-"));
  });
  afterEach(async () => {
    await rm(dataDir, { recursive: true, force: true });
  });

  it("SEC-043 refuses a second process on a held data dir and frees it on release", async () => {
    const held = await lockWorkerDataDir(dataDir);
    await expect(lockWorkerDataDir(dataDir)).rejects.toMatchObject({
      code: "PRECONDITION_FAILED",
      details: { reasonCode: "lock_busy" },
    });
    await held.release();
    const again = await lockWorkerDataDir(dataDir);
    await again.release();
  });

  it("SEC-043 reclaims the lock of a worker process that died without releasing it", async () => {
    const child = spawn(process.execPath, ["-e", ""], { stdio: "ignore" });
    const pid = child.pid;
    const exited = Promise.withResolvers<void>();
    child.once("exit", () => exited.resolve());
    await exited.promise;
    await writeFile(join(dataDir, "worker.lock"), String(pid), { mode: 0o600 });
    const held = await lockWorkerDataDir(dataDir);
    await held.release();
  });
});
