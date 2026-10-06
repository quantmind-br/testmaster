import { readFile } from "node:fs/promises";
import { createServer } from "node:http";
import { join } from "node:path";
import { expect, it } from "vitest";
import { dockerCommand } from "../../packages/sandbox/src/docker/executor.js";
import { controlledShop, healthPlan, journey, object, root, text } from "./harness.js";

it("OPS-004 501-cell admission is refused before a Run and product env cannot enable faults", async () => {
  await journey("ops-004-501-cells", async (session) => {
    const target = await controlledShop();
    try {
      await session.init(target.url);
      const test = await session.createTest(healthPlan());
      const result = await session.start([
        "test",
        "run",
        ...Array.from({ length: 501 }, () => text(test.id)),
        "--wait",
      ]).result;
      expect(result.exitCode).not.toBe(0);
      expect(object(object(result.json).error).code).toBe("INVALID_ARGUMENT");
      const runs = await session.command(["run", "list"]);
      expect(runs.items).toEqual([]);
      expect(target.hits()).toBe(0);
      session.oracles.push({
        check: "501-cellAdmissionNoEffects",
        healthy: true,
        admitted: 0,
        targetRequests: 0,
      });
    } finally {
      await target.close();
    }
  });
}, 60_000);

it("OPS-004 actual Docker log flood retains only the bounded tail and counts discarded bytes", async () => {
  const lock = JSON.parse(
    await readFile(join(root, "containers/images.lock.json"), "utf8"),
  ) as Record<string, { imageId: string }>;
  const total = 24 * 1024 * 1024;
  const result = await dockerCommand([
    "run",
    "--rm",
    "--network",
    "none",
    "--read-only",
    "--cap-drop",
    "ALL",
    "--security-opt",
    "no-new-privileges",
    "--security-opt",
    `seccomp=${join(root, "containers/seccomp_profile.json")}`,
    "--user",
    "1000:1000",
    "--memory",
    "128m",
    "--memory-swap",
    "128m",
    "--pids-limit",
    "32",
    "--entrypoint",
    "node",
    lock["testmaster-runner"]?.imageId ?? "",
    "-e",
    "const b=Buffer.alloc(65536,120);for(let n=0;n<384;n++)require('node:fs').writeSync(1,b)",
  ]);
  expect(result.code).toBe(0);
  expect(result.stdout.length + result.stderr.length).toBeLessThanOrEqual(10 * 1024 * 1024);
  expect(result.droppedBytes + result.stdout.length + result.stderr.length).toBe(total);
  expect(result.droppedBytes).toBeGreaterThan(0);
}, 60_000);

it("OPS-004 infinite HTTP stream is disconnected at the byte ceiling and never reports a pass", async () => {
  await journey("ops-004-infinite-http", async (session) => {
    let bytes = 0;
    let closed = false;
    const server = createServer((_request, response) => {
      response.writeHead(200, { "Content-Type": "application/octet-stream" });
      const block = Buffer.alloc(65536);
      const pump = () => {
        while (!response.destroyed) {
          bytes += block.length;
          if (!response.write(block)) return;
        }
      };
      response.on("drain", pump);
      response.on("close", () => {
        closed = true;
      });
      pump();
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    try {
      const address = server.address();
      if (!address || typeof address === "string") throw new Error("Missing address");
      await session.init(`http://127.0.0.1:${address.port}`);
      const test = await session.createTest(healthPlan());
      const result = await session.start([
        "test",
        "run",
        text(test.id),
        "--wait",
        "--timeout",
        "120",
      ]).result;
      expect(result.exitCode).not.toBe(0);
      expect(closed).toBe(true);
      const run = object(object(result.json).data ?? object(object(result.json).error).details);
      expect(JSON.stringify(run)).not.toContain('"gate":"passed"');
      expect(bytes).toBeLessThan(32 * 1024 * 1024);
      session.oracles.push({
        check: "infiniteStreamDisconnected",
        healthy: true,
        bytesProduced: bytes,
        closed,
        exitCode: result.exitCode,
      });
    } finally {
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
    }
  });
}, 180_000);
