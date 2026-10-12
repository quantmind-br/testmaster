import { type ChildProcess, spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer, type RequestListener } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ContractError } from "@testmaster/contracts";
import { AuxiliaryLeaseRepository } from "@testmaster/persistence";
import { expect, it } from "vitest";
import { Application } from "./application.js";
import type { CiResult } from "./ci.js";
import { allEntities } from "./context.js";
import {
  ChecksClient,
  checkConclusion,
  deliveryBackoffMs,
  validatePublication,
} from "./delivery.js";

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

async function listen(handler: RequestListener) {
  const server = createServer(handler);
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("HTTP listener missing");
  return {
    apiUrl: `http://127.0.0.1:${address.port}`,
    async close() {
      server.close();
      await once(server, "close");
    },
  };
}
/** A first open initializes the workspace; the reopen is what a later CLI process would see. */
async function openFresh(cwd: string): Promise<Application> {
  const first = await Application.open({ cwd, home: cwd });
  await first.init();
  first.close();
  return Application.open({ cwd, home: cwd });
}
function makeDue(app: Application): void {
  app.database.run(
    "UPDATE job_leases SET available_at=? WHERE queue='delivery'",
    "1970-01-01T00:00:00.000Z",
  );
}
/** `exit` resolves with the signal (it does not reject on SIGKILL), once stdio is drained. */
function spawnChild(
  script: string,
  args: string[],
): {
  process: ChildProcess;
  exit: Promise<{ code: number | null; signal: NodeJS.Signals | null; stderr: string }>;
} {
  const { promise, resolve, reject } = Promise.withResolvers<{
    code: number | null;
    signal: NodeJS.Signals | null;
    stderr: string;
  }>();
  const child = spawn(process.execPath, ["--input-type=module", "-e", script, ...args], {
    stdio: ["ignore", "ignore", "pipe"],
  });
  let stderr = "";
  child.stderr.on("data", (chunk) => {
    stderr += String(chunk);
  });
  child.on("error", reject);
  child.on("close", (code, signal) => resolve({ code, signal, stderr }));
  return { process: child, exit: promise };
}
it("computes exponential jittered delivery backoff capped at 300 s", () => {
  expect(deliveryBackoffMs(1, () => 1)).toBe(1000);
  expect(deliveryBackoffMs(2, () => 1)).toBe(2000);
  expect(deliveryBackoffMs(9, () => 1)).toBe(256000);
  expect(deliveryBackoffMs(10, () => 1)).toBe(300000);
  expect(deliveryBackoffMs(40, () => 1)).toBe(300000);
  expect(deliveryBackoffMs(1, () => 0)).toBe(500);
  expect(deliveryBackoffMs(10, () => 0)).toBe(150000);
  expect(() => deliveryBackoffMs(0)).toThrow("positive integer");
  expect(() => deliveryBackoffMs(1.5)).toThrow("positive integer");
});
it("dead-letters after ten failed attempts and honours jittered backoff between them", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "tm-delivery-"));
  let requests = 0;
  const server = await listen((_req, res) => {
    requests++;
    res.statusCode = 503;
    res.end("{}");
  });
  let app: Application | undefined;
  try {
    app = await openFresh(cwd);
    const result = resultFixture();
    const options = { apiUrl: server.apiUrl, sleep: async () => {}, random: () => 1 };
    for (let attempt = 1; attempt < 10; attempt++) {
      makeDue(app);
      const before = Date.now();
      const rows = await app.delivery.publish(result, "owner/repo", sha, "test", options);
      expect(rows.map((row) => row.state)).toEqual(["pending", "pending"]);
      expect(rows.map((row) => row.attempts)).toEqual([attempt, attempt]);
      for (const row of rows) {
        const wait = Date.parse(String(row.nextAttemptAt)) - before;
        expect(wait).toBeGreaterThanOrEqual(deliveryBackoffMs(attempt, () => 1));
        expect(wait).toBeLessThan(deliveryBackoffMs(attempt, () => 1) + 5000);
      }
      // Inside the backoff window nothing is sent again.
      const seen = requests;
      const early = await app.delivery.publish(result, "owner/repo", sha, "test", options);
      expect(early.map((row) => row.attempts)).toEqual([attempt, attempt]);
      expect(requests).toBe(seen);
    }
    makeDue(app);
    const rows = await app.delivery.publish(result, "owner/repo", sha, "test", options);
    expect(rows.map((row) => row.state)).toEqual(["dead_letter", "dead_letter"]);
    expect(rows.map((row) => row.attempts)).toEqual([10, 10]);
    expect(rows.every((row) => row.nextAttemptAt === null)).toBe(true);
    expect(rows.every((row) => row.lastError === "GitHub Checks HTTP 503")).toBe(true);
    expect(app.database.all("SELECT id FROM runs")).toHaveLength(0);
  } finally {
    app?.close();
    await server.close();
    await rm(cwd, { recursive: true, force: true });
  }
});
it("dead-letters a failing delivery whose 24 hour window elapsed and restarts the window on requeue", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "tm-delivery-"));
  const server = await listen((_req, res) => {
    res.statusCode = 503;
    res.end("{}");
  });
  let app: Application | undefined;
  try {
    app = await openFresh(cwd);
    const options = { apiUrl: server.apiUrl, sleep: async () => {}, random: () => 1 };
    const first = await app.delivery.publish(resultFixture(), "owner/repo", sha, "test", options);
    expect(first.map((row) => row.state)).toEqual(["pending", "pending"]);
    const stale = new Date(Date.now() - 25 * 3_600_000).toISOString();
    app.database.run(
      "UPDATE operational_state SET value=? WHERE key LIKE 'delivery:window:%'",
      stale,
    );
    makeDue(app);
    const second = await app.delivery.publish(resultFixture(), "owner/repo", sha, "test", options);
    expect(second.map((row) => row.state)).toEqual(["dead_letter", "dead_letter"]);
    expect(second.map((row) => row.attempts)).toEqual([2, 2]);
    const dead = second[0];
    if (!dead) throw new Error("Missing delivery");
    const job = new AuxiliaryLeaseRepository(app.database).forTarget(
      app.context.workspaceId,
      "delivery",
      dead.id,
    )[0];
    expect(job?.result).toMatchObject({ state: "dead_letter", reason: "attempts_exhausted" });
    // A fresh cycle starts with a fresh window: one more failure is retried, not dead-lettered.
    expect(app.delivery.requeue(dead.id).attempts).toBe(0);
    const third = await app.delivery.publish(resultFixture(), "owner/repo", sha, "test", options);
    expect(third.map((row) => row.state)).toEqual(["pending", "dead_letter"]);
    expect(third[0]?.attempts).toBe(1);
  } finally {
    app?.close();
    await server.close();
    await rm(cwd, { recursive: true, force: true });
  }
});
it("requeues a dead letter only with write authority and never reruns the local result", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "tm-delivery-"));
  let accept = false;
  const server = await listen((req, res) => {
    res.setHeader("content-type", "application/json");
    if (!accept) {
      res.statusCode = 401;
      res.end("{}");
    } else if (req.method === "GET") res.end('{"check_runs":[]}');
    else {
      res.statusCode = 201;
      res.end('{"id":31}');
    }
  });
  let app: Application | undefined;
  try {
    app = await openFresh(cwd);
    const result = resultFixture();
    const before = JSON.stringify(result);
    const options = { apiUrl: server.apiUrl, sleep: async () => {} };
    const rows = await app.delivery.publish(result, "owner/repo", sha, "test", options);
    expect(rows.map((row) => row.state)).toEqual(["dead_letter", "dead_letter"]);
    const dead = rows[0];
    if (!dead) throw new Error("Missing delivery");
    const authorize = app.context.authorize;
    app.context.authorize = (scope) => {
      if (scope === "W") throw new ContractError("FORBIDDEN", "Read-only principal");
    };
    expect(() => app?.delivery.requeue(dead.id)).toThrow("Read-only principal");
    app.context.authorize = authorize;
    expect(app.delivery.list({ state: "dead_letter" })).toHaveLength(2);
    const requeued = app.delivery.requeue(dead.id);
    expect(requeued.state).toBe("pending");
    expect(requeued.attempts).toBe(0);
    expect(() => app?.delivery.requeue(dead.id)).toThrow(
      "Only dead-lettered deliveries can be requeued",
    );
    expect(
      app.database
        .all("SELECT action FROM audit_events WHERE resource_id=?", dead.id)
        .map((row) => row.action)
        .sort(),
    ).toEqual(["delivery.requeue.allowed", "delivery.requeue.requested"]);
    accept = true;
    const after = await app.delivery.publish(result, "owner/repo", sha, "test", options);
    expect(after.map((row) => row.state)).toEqual(["delivered", "dead_letter"]);
    expect(after[0]?.externalId).toBe("31");
    expect(JSON.stringify(result)).toBe(before);
    expect(app.database.all("SELECT id FROM runs")).toHaveLength(0);
  } finally {
    app?.close();
    await server.close();
    await rm(cwd, { recursive: true, force: true });
  }
});
it("lists dead letters through a read-only query without touching their state", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "tm-delivery-"));
  const server = await listen((_req, res) => {
    res.statusCode = 401;
    res.end("{}");
  });
  let app: Application | undefined;
  try {
    app = await openFresh(cwd);
    const rows = await app.delivery.publish(resultFixture(), "owner/repo", sha, "test", {
      apiUrl: server.apiUrl,
      sleep: async () => {},
    });
    const authorize = app.context.authorize;
    app.context.authorize = (scope) => {
      if (scope !== "R") throw new ContractError("FORBIDDEN", "Read-only principal");
    };
    const versions = app.database.all("SELECT version FROM deliveries ORDER BY id");
    expect(
      app.delivery
        .list({ state: "dead_letter" })
        .map((row) => row.id)
        .sort(),
    ).toEqual(rows.map((row) => row.id).sort());
    expect(app.delivery.list({ state: "pending" })).toEqual([]);
    expect(app.delivery.list().map((row) => row.state)).toEqual(["dead_letter", "dead_letter"]);
    expect(app.database.all("SELECT version FROM deliveries ORDER BY id")).toEqual(versions);
    app.context.authorize = authorize;
  } finally {
    app?.close();
    await server.close();
    await rm(cwd, { recursive: true, force: true });
  }
});
it("keeps delivered rows frozen and lets a dead letter change only by reopening to pending", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "tm-delivery-"));
  let accept = false;
  const server = await listen((req, res) => {
    res.setHeader("content-type", "application/json");
    if (!accept) {
      res.statusCode = 401;
      res.end("{}");
    } else if (req.method === "GET") res.end('{"check_runs":[]}');
    else {
      res.statusCode = 201;
      res.end('{"id":51}');
    }
  });
  let app: Application | undefined;
  try {
    app = await openFresh(cwd);
    const options = { apiUrl: server.apiUrl, sleep: async () => {} };
    const dead = await app.delivery.publish(resultFixture(), "owner/repo", sha, "test", options);
    const [deadId, otherId] = dead.map((row) => row.id);
    accept = true;
    app.delivery.requeue(String(otherId));
    const delivered = await app.delivery.publish(
      resultFixture(),
      "owner/repo",
      sha,
      "test",
      options,
    );
    expect(delivered.map((row) => row.state)).toEqual(["dead_letter", "delivered"]);
    const forbidden: [string, unknown[]][] = [
      // dead_letter: only the reopening to pending is allowed, never another state or a subject edit.
      ["UPDATE deliveries SET state='delivered' WHERE id=?", [deadId]],
      ["UPDATE deliveries SET attempts=99 WHERE id=?", [deadId]],
      ["UPDATE deliveries SET state='pending',payload_hash=? WHERE id=?", ["f".repeat(64), deadId]],
      ["UPDATE deliveries SET state='pending',report_hash=? WHERE id=?", ["f".repeat(64), deadId]],
      ["UPDATE deliveries SET state='pending',subject_sha=? WHERE id=?", ["f".repeat(40), deadId]],
      // delivered is terminal for every edit, including a reopening.
      ["UPDATE deliveries SET state='pending' WHERE id=?", [otherId]],
      ["UPDATE deliveries SET state='dead_letter' WHERE id=?", [otherId]],
      ["UPDATE deliveries SET attempts=99 WHERE id=?", [otherId]],
    ];
    for (const [sql, params] of forbidden)
      expect(() => app?.database.run(sql, ...params), sql).toThrow("delivery_subject_frozen");
    expect(app.delivery.list({ state: "delivered" }).map((row) => row.id)).toEqual([otherId]);
    expect(app.delivery.list({ state: "dead_letter" }).map((row) => row.id)).toEqual([deadId]);
  } finally {
    app?.close();
    await server.close();
    await rm(cwd, { recursive: true, force: true });
  }
});

// The next two tests spawn a child that imports the built package: run them after `pnpm build`.
it("keeps a committed delivery pending after SIGKILL before send and delivers it on the next process", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "tm-delivery-"));
  const methods: string[] = [];
  const server = await listen((req, res) => {
    methods.push(`${req.method} ${req.url?.split("?")[0]}`);
    res.setHeader("content-type", "application/json");
    if (req.method === "GET") res.end('{"check_runs":[]}');
    else {
      res.statusCode = 201;
      res.end('{"id":41}');
    }
  });
  let app: Application | undefined;
  try {
    app = await openFresh(cwd);
    app.close();
    app = undefined;
    const script = `import { Application, ChecksClient } from './packages/application/dist/index.js'; ChecksClient.prototype.publish = async () => { process.kill(process.pid, 'SIGKILL'); }; const app = await Application.open({ cwd: process.argv[1], home: process.argv[1] }); await app.delivery.publish(JSON.parse(process.argv[3]), 'owner/repo', '${sha}', 'test', { apiUrl: process.argv[2] });`;
    const child = await spawnChild(script, [cwd, server.apiUrl, JSON.stringify(resultFixture())])
      .exit;
    expect(child.signal).toBe("SIGKILL");
    app = await Application.open({ cwd, home: cwd });
    const stored = allEntities(app.context, "Delivery");
    expect(stored.map((row) => row.state)).toEqual(["pending"]);
    expect(stored[0]?.attempts).toBe(0);
    expect(methods).toEqual([]);
    const eventId = stored[0]?.eventId;
    // The dead process still holds a 15 minute lease; recovery expires it as the worker would.
    new AuxiliaryLeaseRepository(app.database).expire(
      new Date(Date.now() + 16 * 60_000).toISOString(),
    );
    const rows = await app.delivery.publish(resultFixture(), "owner/repo", sha, "test", {
      apiUrl: server.apiUrl,
      sleep: async () => {},
    });
    expect(rows.map((row) => row.state)).toEqual(["delivered", "delivered"]);
    expect(rows[0]?.eventId).toBe(eventId);
    expect(methods.filter((method) => method.startsWith("POST"))).toHaveLength(2);
  } finally {
    app?.close();
    await server.close();
    await rm(cwd, { recursive: true, force: true });
  }
});
it("reconciles a check created before SIGKILL instead of posting it twice and keeps the event id", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "tm-delivery-"));
  const created: { id: number; name: string; head_sha: string; external_id: string }[] = [];
  const methods: string[] = [];
  let victim: ChildProcess | undefined;
  let killed = false;
  const server = await listen((req, res) => {
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    methods.push(`${req.method} ${url.pathname}`);
    res.setHeader("content-type", "application/json");
    if (req.method === "GET") {
      res.end(
        JSON.stringify({
          check_runs: created.filter((item) => item.name === url.searchParams.get("check_name")),
        }),
      );
      return;
    }
    let body = "";
    req.on("data", (chunk) => {
      body += String(chunk);
    });
    req.on("end", () => {
      if (req.method === "POST") {
        const input = JSON.parse(body);
        created.push({
          id: 40 + created.length + 1,
          name: input.name,
          head_sha: input.head_sha,
          external_id: input.external_id,
        });
        if (!killed) {
          // GitHub created the check, but the acknowledgement is lost with the sender.
          killed = true;
          victim?.kill("SIGKILL");
          return;
        }
      }
      res.statusCode = req.method === "POST" ? 201 : 200;
      res.end(JSON.stringify({ id: Number(url.pathname.split("/").pop()) || 40 + created.length }));
    });
  });
  let app: Application | undefined;
  try {
    app = await openFresh(cwd);
    app.close();
    app = undefined;
    const script = `import { Application } from './packages/application/dist/index.js'; const app = await Application.open({ cwd: process.argv[1], home: process.argv[1] }); await app.delivery.publish(JSON.parse(process.argv[3]), 'owner/repo', '${sha}', 'test', { apiUrl: process.argv[2], sleep: async () => {} });`;
    const spawned = spawnChild(script, [cwd, server.apiUrl, JSON.stringify(resultFixture())]);
    victim = spawned.process;
    const child = await spawned.exit;
    expect(child.signal).toBe("SIGKILL");
    expect(created).toHaveLength(1);
    app = await Application.open({ cwd, home: cwd });
    const stored = allEntities(app.context, "Delivery");
    expect(stored.map((row) => row.state)).toEqual(["pending"]);
    const eventId = stored[0]?.eventId;
    const sent = created[0]?.external_id;
    new AuxiliaryLeaseRepository(app.database).expire(
      new Date(Date.now() + 16 * 60_000).toISOString(),
    );
    const rows = await app.delivery.publish(resultFixture(), "owner/repo", sha, "test", {
      apiUrl: server.apiUrl,
      sleep: async () => {},
    });
    expect(rows.map((row) => row.state)).toEqual(["delivered", "delivered"]);
    expect(rows[0]?.eventId).toBe(eventId);
    expect(rows[0]?.externalId).toBe("41");
    // The lost acknowledgement never produced a second POST for the same external id.
    expect(created.filter((item) => item.external_id === sent)).toHaveLength(1);
    expect(methods.filter((method) => method.startsWith("PATCH"))).toEqual([
      "PATCH /repos/owner/repo/check-runs/41",
    ]);
  } finally {
    app?.close();
    await server.close();
    await rm(cwd, { recursive: true, force: true });
  }
});
