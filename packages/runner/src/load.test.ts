import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { LoadProbe, RunnerEvent } from "@testmaster/contracts";
import { validateRunnerWireEvent } from "@testmaster/contracts";
import { Agent } from "undici";
import { afterEach, expect, it } from "vitest";
import { runLoad } from "./load.js";
import type { ProtocolClient } from "./protocol.js";
import { type RunnerInput, Runtime } from "./runtime.js";

const ATTEMPT = "att_01900000-0000-7000-8000-000000000001";
const TOKEN_REF = "sec_01900000-0000-7000-8000-000000000001";
const TOKEN = "Bearer load-canary-5d2e";
const servers: Server[] = [];
const agents: Agent[] = [];
afterEach(async () => {
  for (const agent of agents.splice(0)) await agent.close();
  for (const server of servers.splice(0)) {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

async function serve(
  handler: (request: IncomingMessage, response: ServerResponse) => void,
): Promise<string> {
  const server = createServer(handler);
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Missing fixture address");
  return `http://127.0.0.1:${address.port}`;
}
function fixture(baseUrl: string, probe: LoadProbe, extra: Partial<RunnerInput> = {}) {
  const events: RunnerEvent[] = [];
  const artifacts = new Map<string, Uint8Array>();
  const controller = new AbortController();
  const protocol = {
    controller,
    emit: async (type: string, payload: unknown) => {
      events.push(
        validateRunnerWireEvent({
          protocolVersion: "1.0.0",
          seq: events.length,
          attemptId: ATTEMPT,
          occurredAt: new Date().toISOString(),
          type,
          payload,
        }),
      );
    },
    artifact: async (path: string, _kind: string, _mime: string, bytes: Uint8Array) => {
      artifacts.set(path, bytes);
    },
    secret: async () => TOKEN,
  } as unknown as ProtocolClient;
  const runtime = new Runtime(
    {
      attemptId: ATTEMPT,
      nonce: "n".repeat(32),
      baseUrl,
      networkPolicy: { allowedOrigins: [baseUrl], networkProfile: "local-loopback" },
      secrets: [{ secretRef: TOKEN_REF, secretVersion: 1 }],
      probe,
      ...extra,
    },
    protocol,
    controller.signal,
  );
  const agent = new Agent({ connections: probe.maxConcurrency });
  agents.push(agent);
  return { runtime, events, artifacts, controller, dispatcher: agent };
}
const probeOf = (overrides: Partial<LoadProbe> = {}): LoadProbe => ({
  kind: "load",
  stages: [{ durationSeconds: 1, targetRps: 10 }],
  maxConcurrency: 50,
  request: {
    method: "GET",
    path: "/products?limit=5",
    credentials: [{ header: "authorization", secretRef: TOKEN_REF }],
  },
  stopConditions: { maxErrorRate: 0.5, maxP95Ms: 5000 },
  budget: { maxRequests: 100000, maxDurationSeconds: 600 },
  ...overrides,
});
const finished = (events: RunnerEvent[]) =>
  events.flatMap((event) => (event.type === "step.finished" ? [event.payload] : []));
const summaryOf = (artifacts: Map<string, Uint8Array>) =>
  JSON.parse(Buffer.from(artifacts.get("load/summary.json") ?? []).toString("utf8"));

it("sends at the target rate over a stage and reports a measured summary", async () => {
  let requests = 0;
  const authorizations: (string | undefined)[] = [];
  const base = await serve((request, response) => {
    requests += 1;
    authorizations.push(request.headers.authorization);
    response.end("{}");
  });
  const { runtime, events, artifacts, dispatcher } = fixture(
    base,
    probeOf({ stages: [{ durationSeconds: 2, targetRps: 60 }] }),
  );
  expect(await runLoad(runtime, { dispatcher })).toEqual({
    outcome: "passed",
    reasonCode: "assertions_satisfied",
  });
  const summary = summaryOf(artifacts);
  const [stage] = summary.stages;
  expect(stage.sent).toBe(requests);
  expect(stage.achievedRps).toBeGreaterThan(54);
  expect(stage.achievedRps).toBeLessThan(66);
  expect(summary.target).toMatchObject({ count: requests, errors: 0, errorRate: 0, saturated: 0 });
  expect(summary.target.p95.n).toBe(requests);
  expect(summary.target.p95.valueMs).toBeGreaterThan(0);
  expect(summary.target.p99.valueMs).toBeNull();
  expect(summary.platform.schedulerLagMs.p95.n).toBe(requests);
  expect(summary.dataset).toEqual({ method: "GET", path: "/products?limit=5", bodyBytes: 0 });
  expect(summary.hardware.cpus).toBeGreaterThan(0);
  expect(summary.stopCondition).toBeNull();
  expect(summary.budgetExhausted).toBeNull();
  expect(new Set(authorizations)).toEqual(new Set([TOKEN]));
  expect(finished(events).map((step) => [step.stepId, step.status])).toEqual([
    ["load:stage-1", "passed"],
    ["load", "passed"],
  ]);
  expect(JSON.stringify(events) + JSON.stringify(summary)).not.toContain("canary");
});

it("stops sending and fails when the rolling p95 exceeds its limit", async () => {
  let requests = 0;
  const base = await serve((_request, response) => {
    requests += 1;
    setTimeout(() => response.end("{}"), 150);
  });
  const { runtime, events, artifacts, dispatcher } = fixture(
    base,
    probeOf({
      stages: [{ durationSeconds: 20, targetRps: 100 }],
      stopConditions: { maxErrorRate: 1, maxP95Ms: 50 },
    }),
  );
  expect(await runLoad(runtime, { dispatcher })).toEqual({
    outcome: "failed",
    reasonCode: "assertion_mismatch",
  });
  const [stage, aggregate] = finished(events);
  for (const step of [stage, aggregate])
    expect(step).toMatchObject({
      status: "failed",
      reasonCode: "assertion_mismatch",
      error: { code: "stop_condition" },
      evidencePaths: ["load/summary.json"],
    });
  expect(stage?.stepId).toBe("load:stage-1");
  expect(aggregate?.stepId).toBe("load");
  const summary = summaryOf(artifacts);
  expect(summary.stopCondition).toMatchObject({ name: "maxP95Ms", limit: 50 });
  expect(summary.stopCondition.observed).toBeGreaterThan(50);
  // The test ended seconds before the 20 s stage would have.
  expect(summary.stages[0].sent).toBeLessThan(1000);
  expect(summary.stages[0].sent).toBe(requests);
  expect(summary.target.count).toBe(requests);
});

it("fails on the rolling error rate of an erroring target", async () => {
  const base = await serve((_request, response) => {
    response.statusCode = 503;
    response.end();
  });
  const { runtime, events, artifacts, dispatcher } = fixture(
    base,
    probeOf({
      stages: [{ durationSeconds: 20, targetRps: 100 }],
      stopConditions: { maxErrorRate: 0.1, maxP95Ms: 5000 },
    }),
  );
  expect(await runLoad(runtime, { dispatcher })).toMatchObject({ outcome: "failed" });
  expect(finished(events)[0]).toMatchObject({
    status: "failed",
    error: { code: "stop_condition" },
  });
  const summary = summaryOf(artifacts);
  expect(summary.stopCondition).toMatchObject({ name: "maxErrorRate", observed: 1, limit: 0.1 });
  expect(summary.target.errorRate).toBe(1);
});

it("sends exactly the budgeted requests and withholds percentiles that lack samples", async () => {
  let requests = 0;
  const base = await serve((_request, response) => {
    requests += 1;
    response.end("{}");
  });
  const { runtime, events, artifacts, dispatcher } = fixture(
    base,
    probeOf({
      stages: [{ durationSeconds: 5, targetRps: 100 }],
      budget: { maxRequests: 12, maxDurationSeconds: 60 },
    }),
  );
  expect(await runLoad(runtime, { dispatcher })).toEqual({
    outcome: "inconclusive",
    reasonCode: "insufficient_evidence",
  });
  expect(requests).toBe(12);
  const summary = summaryOf(artifacts);
  expect(summary.budgetExhausted).toBe("maxRequests");
  expect(summary.target.count).toBe(12);
  // Ten samples support a median; a p95 needs a hundred.
  expect(summary.target.p50).toEqual({ valueMs: expect.any(Number), n: 12 });
  expect(summary.target.p95).toEqual({ valueMs: null, n: 12 });
  expect(summary.target.p99).toEqual({ valueMs: null, n: 12 });
  expect(finished(events).map((step) => [step.stepId, step.status])).toEqual([
    ["load:stage-1", "passed"],
    ["load", "inconclusive"],
  ]);
  expect(finished(events)[1]).toMatchObject({ error: { code: "insufficient_samples" } });
});

it("counts a due request that finds the concurrency bound full as saturated and does not send it", async () => {
  let requests = 0;
  const base = await serve((_request, response) => {
    requests += 1;
    setTimeout(() => response.end("{}"), 300);
  });
  const { runtime, artifacts, dispatcher } = fixture(
    base,
    probeOf({ stages: [{ durationSeconds: 1, targetRps: 20 }], maxConcurrency: 1 }),
  );
  await runLoad(runtime, { dispatcher });
  const summary = summaryOf(artifacts);
  expect(summary.target.saturated).toBeGreaterThan(0);
  expect(requests).toBe(summary.stages[0].sent);
  expect(summary.stages[0].sent + summary.target.saturated).toBe(20);
});

it("fails the whole test on the overall rates when no rolling window had enough samples", async () => {
  const base = await serve((_request, response) => {
    response.statusCode = 500;
    response.end();
  });
  const { runtime, events, artifacts, dispatcher } = fixture(
    base,
    probeOf({
      stages: [{ durationSeconds: 1, targetRps: 10 }],
      stopConditions: { maxErrorRate: 0.2, maxP95Ms: 5000 },
    }),
  );
  expect(await runLoad(runtime, { dispatcher })).toEqual({
    outcome: "failed",
    reasonCode: "assertion_mismatch",
  });
  expect(finished(events).map((step) => [step.stepId, step.status])).toEqual([
    ["load:stage-1", "passed"],
    ["load", "failed"],
  ]);
  expect(summaryOf(artifacts).stopCondition).toMatchObject({ name: "maxErrorRate" });
});

it("follows a virtual clock: stages in order, and the duration budget ends the test", async () => {
  const base = await serve((_request, response) => response.end());
  let clock = 0;
  const sendTimes: number[] = [];
  const { runtime, events, artifacts, dispatcher } = fixture(
    base,
    probeOf({
      stages: [
        { durationSeconds: 2, targetRps: 10 },
        { durationSeconds: 100, targetRps: 10 },
        { durationSeconds: 5, targetRps: 10 },
      ],
      budget: { maxRequests: 100000, maxDurationSeconds: 5 },
    }),
  );
  const result = await runLoad(runtime, {
    dispatcher,
    now: () => clock,
    sleep: async (ms) => {
      clock += ms;
    },
    send: async () => {
      sendTimes.push(clock);
      return { status: 200, latencyMs: 2 };
    },
  });
  const summary = summaryOf(artifacts);
  expect(summary.budgetExhausted).toBe("maxDurationSeconds");
  expect(summary.stages.map((stage: { sent: number }) => stage.sent)).toEqual([20, 30]);
  expect(sendTimes.at(-1)).toBeLessThan(5000);
  expect(result).toMatchObject({ outcome: "inconclusive" });
  expect(finished(events).map((step) => [step.stepId, step.status])).toEqual([
    ["load:stage-1", "passed"],
    ["load:stage-2", "passed"],
    ["load", "inconclusive"],
  ]);
  expect(summary.platform.schedulerLagMs.p95.n).toBe(50);
});

it("reports a cancel as cancelled and sends nothing after it", async () => {
  let requests = 0;
  let cancel = () => {};
  const base = await serve((_request, response) => {
    requests += 1;
    if (requests === 3) cancel();
    response.end("{}");
  });
  const { runtime, events, artifacts, controller, dispatcher } = fixture(
    base,
    probeOf({ stages: [{ durationSeconds: 30, targetRps: 20 }] }),
  );
  cancel = () => controller.abort(new Error("user_cancelled"));
  expect(await runLoad(runtime, { dispatcher })).toEqual({
    outcome: "cancelled",
    reasonCode: "user_cancelled",
  });
  expect(requests).toBeLessThan(10);
  expect(artifacts.size).toBe(0);
  expect(finished(events).map((step) => [step.stepId, step.status])).toEqual([
    ["load:stage-1", "cancelled"],
    ["load", "cancelled"],
  ]);
});

it("refuses a path that leaves the target origin before sending anything", async () => {
  let requests = 0;
  const base = await serve((_request, response) => {
    requests += 1;
    response.end();
  });
  const { runtime, events, dispatcher } = fixture(
    base,
    probeOf({ request: { method: "GET", path: "//evil.example/x" } }),
    {
      networkPolicy: {
        allowedOrigins: [base, "http://evil.example"],
        networkProfile: "local-loopback",
      },
    },
  );
  expect(await runLoad(runtime, { dispatcher })).toEqual({
    outcome: "blocked",
    reasonCode: "egress_denied",
  });
  expect(requests).toBe(0);
  expect(finished(events).map((step) => [step.stepId, step.status])).toEqual([["load", "blocked"]]);
});
