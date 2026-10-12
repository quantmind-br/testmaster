import { once } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Writable } from "node:stream";
import { Application, type CiResult } from "@testmaster/application";
import { afterEach, expect, it, vi } from "vitest";
import { runCli } from "./cli.js";
import { Runtime } from "./runtime.js";

const sha = "a".repeat(40);
const originalExitCode = process.exitCode;
afterEach(() => {
  process.exitCode = originalExitCode;
  vi.restoreAllMocks();
});
function emptyResult(): CiResult {
  return {
    schemaVersion: "1.0.0",
    kind: "empty",
    batchId: null,
    gate: "not_applicable",
    exitCode: 0,
    counts: { passed: 0, failed: 0, blocked: 0, cancelled: 0, inconclusive: 0, inFlight: 0 },
    provenance: {
      assessedSha: sha,
      checkoutSha: sha,
      binding: "verified",
      targetBinding: "local-checkout",
    },
    selection: {
      requested: 0,
      excluded: [],
      emptyReason: "No applicable tests",
      quarantinePolicy: "exclude",
    },
    outputs: { report: null, junit: null, summary: null, bundleIndex: null },
    bundles: [],
    reportHash: "b".repeat(64),
    error: null,
  };
}

it("lists dead-lettered deliveries and requeues one through the CLI without touching Runs", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "tm-cli-deliveries-"));
  const server = createServer((_req, res) => {
    res.statusCode = 401;
    res.end("{}");
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("HTTP listener missing");
  const first = await Application.open({ cwd, home: cwd });
  await first.init();
  first.close();
  const app = await Application.open({ cwd, home: cwd });
  try {
    await app.delivery.publish(emptyResult(), "owner/repo", sha, "test", {
      apiUrl: `http://127.0.0.1:${address.port}`,
      sleep: async () => {},
    });
    const call = async (args: string[]) => {
      let stdout = "";
      const runtime = new Runtime(
        new Writable({
          write(chunk, _encoding, callback) {
            stdout += String(chunk);
            callback();
          },
        }),
        new Writable({ write: (_chunk, _encoding, callback) => callback() }),
      );
      vi.spyOn(runtime, "app").mockResolvedValue(app);
      await runCli(["--json", ...args], runtime);
      return { document: JSON.parse(stdout), exit: process.exitCode };
    };
    const dead = await call(["ci", "deliveries", "--state", "dead_letter"]);
    expect(dead.exit).toBeFalsy();
    expect(dead.document.data.deliveries.map((row: { state: string }) => row.state)).toEqual([
      "dead_letter",
      "dead_letter",
    ]);
    const bad = await call(["ci", "deliveries", "--state", "lost"]);
    expect(bad.exit).toBe(5);
    expect(bad.document.error).toMatchObject({ code: "INVALID_ARGUMENT" });
    const id = dead.document.data.deliveries[0].id;
    const requeued = await call(["ci", "deliveries-requeue", id]);
    expect(requeued.document.data.delivery).toMatchObject({ id, state: "pending", attempts: 0 });
    const again = await call(["ci", "deliveries-requeue", id]);
    expect(again.document.error).toMatchObject({ code: "PRECONDITION_FAILED" });
    expect(
      (await call(["ci", "deliveries", "--state", "pending"])).document.data.deliveries,
    ).toHaveLength(1);
    expect(app.database.all("SELECT id FROM runs")).toHaveLength(0);
  } finally {
    app.close();
    server.close();
    await once(server, "close");
    await rm(cwd, { recursive: true, force: true });
  }
});
