import { once } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { Application } from "./application.js";
import type { CiResult } from "./ci.js";
import { ChecksClient, checkConclusion, validatePublication } from "./delivery.js";

const sha = "a".repeat(40);
export function resultFixture(): CiResult {
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
it("maps informational and required checks without turning empty, partial, cancelled or unbound coverage green", () => {
  const result = resultFixture();
  expect(checkConclusion(result, "TestMaster / result")).toBe("neutral");
  expect(checkConclusion(result, "TestMaster / required-gate")).toBe("failure");
  result.kind = "batch";
  result.gate = "passed";
  expect(checkConclusion(result, "TestMaster / result")).toBe("success");
  expect(checkConclusion(result, "TestMaster / required-gate")).toBe("success");
  result.provenance.binding = "unbound";
  expect(checkConclusion(result, "TestMaster / required-gate")).toBe("failure");
  result.gate = "failed";
  result.counts!.cancelled = 1;
  expect(checkConclusion(result, "TestMaster / result")).toBe("cancelled");
  expect(checkConclusion(result, "TestMaster / required-gate")).toBe("failure");
  result.gate = "pending";
  expect(checkConclusion(result, "TestMaster / result")).toBeNull();
  expect(checkConclusion(result, "TestMaster / required-gate")).toBe("failure");
});
it("uses real HTTP retry responses, bounded backoff and external_id reconciliation before create", async () => {
  const methods: string[] = [];
  const waits: number[] = [];
  let requests = 0;
  const server = createServer((req, res) => {
    methods.push(`${req.method} ${req.url}`);
    res.setHeader("content-type", "application/json");
    if (requests++ < 3) {
      res.statusCode = requests === 1 ? 429 : 503;
      res.setHeader("retry-after", "2");
      res.end("{}");
      return;
    }
    if (req.method === "GET")
      res.end(
        JSON.stringify({
          check_runs: [
            { id: 17, head_sha: sha, external_id: "fixed", name: "TestMaster / required-gate" },
          ],
        }),
      );
    else res.end('{"id":17}');
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  try {
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("HTTP listener missing");
    const client = new ChecksClient("test-token", {
      apiUrl: `http://127.0.0.1:${address.port}`,
      sleep: async (ms) => {
        waits.push(ms);
      },
    });
    const id = await client.publish("owner/repo", {
      name: "TestMaster / required-gate",
      head_sha: sha,
      external_id: "fixed",
      status: "completed",
      conclusion: "failure",
      output: { title: "Gate", summary: "failed" },
    });
    expect(id).toBe("17");
    expect(waits).toEqual([2000, 5000, 30000]);
    expect(methods.at(-1)).toBe("PATCH /repos/owner/repo/check-runs/17");
    expect(methods.some((method) => method.startsWith("POST"))).toBe(false);
  } finally {
    server.close();
    await once(server, "close");
  }
});
it("persists 401 deliveries as dead letters without mutating or rerunning the local result", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "tm-delivery-"));
  const server = createServer((_req, res) => {
    res.statusCode = 401;
    res.end("{}");
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  let app: Application | undefined;
  try {
    app = await Application.open({ cwd, home: cwd });
    await app.init();
    app.close();
    app = await Application.open({ cwd, home: cwd });
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("HTTP listener missing");
    const result = resultFixture();
    const before = JSON.stringify(result);
    const rows = await app.delivery.publish(result, "owner/repo", sha, "test", {
      apiUrl: `http://127.0.0.1:${address.port}`,
    });
    expect(rows.map((row) => row.state)).toEqual(["dead_letter", "dead_letter"]);
    expect(rows.map((row) => row.attempts)).toEqual([1, 1]);
    expect(JSON.stringify(result)).toBe(before);
    expect(app.database.all("SELECT id FROM runs")).toHaveLength(0);
    expect(app.database.all("SELECT id FROM attempts")).toHaveLength(0);
    const repeated = await app.delivery.publish(result, "owner/repo", sha, "test", {
      apiUrl: `http://127.0.0.1:${address.port}`,
    });
    expect(repeated.map((row) => row.id)).toEqual(rows.map((row) => row.id));
  } finally {
    app?.close();
    server.close();
    await once(server, "close");
    await rm(cwd, { recursive: true, force: true });
  }
});
it("refuses publication to a newer SHA instead of retargeting the old snapshot", () => {
  expect(() => validatePublication(resultFixture(), "owner/repo", "c".repeat(40))).toThrow(
    /frozen assessed SHA/,
  );
});
it("reconciles a lost create response before any second POST", async () => {
  let created = false;
  let posts = 0;
  const methods: string[] = [];
  const server = createServer((request, response) => {
    methods.push(request.method ?? "");
    response.setHeader("content-type", "application/json");
    if (request.method === "GET")
      response.end(
        JSON.stringify({
          check_runs: created
            ? [{ id: 23, head_sha: sha, external_id: "lost", name: "TestMaster / result" }]
            : [],
        }),
      );
    else if (request.method === "POST") {
      posts++;
      created = true;
      response.statusCode = 503;
      response.end("{}");
    } else response.end('{"id":23}');
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  try {
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Missing server");
    const client = new ChecksClient("test", {
      apiUrl: `http://127.0.0.1:${address.port}`,
      sleep: async () => {},
    });
    expect(
      await client.publish("owner/repo", {
        name: "TestMaster / result",
        head_sha: sha,
        external_id: "lost",
        status: "completed",
        conclusion: "failure",
        output: { title: "Gate", summary: "failed" },
      }),
    ).toBe("23");
    expect(posts).toBe(1);
    expect(methods).toEqual(["GET", "POST", "GET", "PATCH"]);
  } finally {
    server.close();
    await once(server, "close");
  }
});
