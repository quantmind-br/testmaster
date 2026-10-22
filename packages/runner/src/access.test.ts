import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AccessProbe, RunnerEvent } from "@testmaster/contracts";
import { validateRunnerWireEvent } from "@testmaster/contracts";
import { Agent } from "undici";
import { afterEach, expect, it } from "vitest";
import { runAccess } from "./access.js";
import type { ProtocolClient } from "./protocol.js";
import { type RunnerInput, Runtime } from "./runtime.js";

const ATTEMPT = "att_01900000-0000-7000-8000-000000000001";
const OWNER_REF = "sec_01900000-0000-7000-8000-000000000001";
const INTRUDER_REF = "sec_01900000-0000-7000-8000-000000000002";
const OWNER_TOKEN = "Bearer owner-canary-9f3a";
const INTRUDER_TOKEN = "Bearer intruder-canary-71cc";
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
/** A resource only its owner may read: strangers get 403, anonymous callers 401. */
function guarded(request: IncomingMessage, response: ServerResponse): void {
  const authorization = request.headers.authorization;
  response.statusCode = authorization === OWNER_TOKEN ? 200 : authorization ? 403 : 401;
  response.end("{}");
}
function fixture(baseUrl: string, probe: AccessProbe, extra: Partial<RunnerInput> = {}) {
  const events: RunnerEvent[] = [];
  const artifacts = new Map<string, Uint8Array>();
  const controller = new AbortController();
  const secrets: Record<string, string> = {
    [OWNER_REF]: OWNER_TOKEN,
    [INTRUDER_REF]: INTRUDER_TOKEN,
  };
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
    secret: async (ref: string) => secrets[ref] ?? "",
  } as unknown as ProtocolClient;
  const runtime = new Runtime(
    {
      attemptId: ATTEMPT,
      nonce: "n".repeat(32),
      baseUrl,
      networkPolicy: { allowedOrigins: [baseUrl], networkProfile: "local-loopback" },
      secrets: [
        { secretRef: OWNER_REF, secretVersion: 1 },
        { secretRef: INTRUDER_REF, secretVersion: 1 },
      ],
      probe,
      ...extra,
    },
    protocol,
    controller.signal,
  );
  const agent = new Agent();
  agents.push(agent);
  return { runtime, events, artifacts, controller, dispatcher: agent };
}
const probeOf = (operations: AccessProbe["operations"], overrides: Partial<AccessProbe> = {}) =>
  ({
    kind: "access",
    operations,
    owner: [{ header: "authorization", secretRef: OWNER_REF }],
    intruder: [{ header: "authorization", secretRef: INTRUDER_REF }],
    expect: [403],
    ...overrides,
  }) satisfies AccessProbe;
const finished = (events: RunnerEvent[]) =>
  events.flatMap((event) => (event.type === "step.finished" ? [event.payload] : []));
const started = (events: RunnerEvent[]) =>
  events.flatMap((event) => (event.type === "step.started" ? [event.payload.stepId] : []));

it("passes an operation the intruder is refused on and the owner may use", async () => {
  const base = await serve(guarded);
  const { runtime, events, artifacts, dispatcher } = fixture(
    base,
    probeOf([{ method: "GET", path: "/orders/1" }]),
  );
  expect(await runAccess(runtime, { dispatcher })).toEqual({
    outcome: "passed",
    reasonCode: "assertions_satisfied",
  });
  expect(started(events)).toEqual(["access:GET /orders/1", "access"]);
  expect(finished(events).map((step) => [step.stepId, step.status])).toEqual([
    ["access:GET /orders/1", "passed"],
    ["access", "passed"],
  ]);
  expect(artifacts.size).toBe(0);
});

it("fails an intruder that receives data, keeping credentials out of the artifact", async () => {
  const base = await serve((_request, response) => {
    response.end(`{"owner":"${OWNER_TOKEN}"}`);
  });
  const { runtime, events, artifacts, dispatcher } = fixture(
    base,
    probeOf([{ method: "GET", path: "/open" }]),
  );
  expect(await runAccess(runtime, { dispatcher })).toEqual({
    outcome: "failed",
    reasonCode: "assertion_mismatch",
  });
  const [step, aggregate] = finished(events);
  expect(step).toMatchObject({
    stepId: "access:GET /open",
    status: "failed",
    reasonCode: "assertion_mismatch",
    error: { code: "access_granted" },
    evidencePaths: ["access/1.json"],
  });
  expect(aggregate).toMatchObject({ stepId: "access", status: "failed" });
  const artifact = Buffer.from(artifacts.get("access/1.json") ?? []).toString("utf8");
  expect(JSON.parse(artifact)).toEqual({
    operation: { method: "GET", path: "/open" },
    intruderStatus: 200,
    ownerStatus: 200,
    expected: [403],
  });
  for (const secret of [OWNER_TOKEN, INTRUDER_TOKEN, "canary"])
    expect(artifact + JSON.stringify(events)).not.toContain(secret);
});

it("fails a refusal outside the expected statuses", async () => {
  const base = await serve((request, response) => {
    response.statusCode = request.headers.authorization === OWNER_TOKEN ? 200 : 500;
    response.end();
  });
  const { runtime, events, artifacts, dispatcher } = fixture(
    base,
    probeOf([{ method: "DELETE", path: "/orders/1" }]),
  );
  expect(await runAccess(runtime, { dispatcher })).toMatchObject({ outcome: "failed" });
  expect(finished(events)[0]).toMatchObject({
    status: "failed",
    error: { code: "unexpected_status" },
    observed: { intruderStatus: 500, ownerStatus: 200 },
  });
  expect(artifacts.has("access/1.json")).toBe(true);
});

it("is inconclusive when the owner is refused too", async () => {
  const base = await serve((_request, response) => {
    response.statusCode = 403;
    response.end();
  });
  const { runtime, events, artifacts, dispatcher } = fixture(
    base,
    probeOf([{ method: "GET", path: "/orders/1" }]),
  );
  expect(await runAccess(runtime, { dispatcher })).toEqual({
    outcome: "inconclusive",
    reasonCode: "insufficient_evidence",
  });
  expect(finished(events)[0]).toMatchObject({
    status: "inconclusive",
    reasonCode: "insufficient_evidence",
    error: { code: "owner_refused" },
  });
  expect(artifacts.size).toBe(0);
});

it("sends an anonymous intruder when no intruder credential exists and sends bodies as JSON", async () => {
  const seen: { authorization: string | undefined; type: string | undefined; body: string }[] = [];
  const base = await serve((request, response) => {
    const chunks: Buffer[] = [];
    request.on("data", (chunk: Buffer) => chunks.push(chunk));
    request.on("end", () => {
      seen.push({
        authorization: request.headers.authorization,
        type: request.headers["content-type"],
        body: Buffer.concat(chunks).toString("utf8"),
      });
      guarded(request, response);
    });
  });
  const { runtime, dispatcher } = fixture(
    base,
    probeOf([{ method: "POST", path: "/orders", body: { id: 7 } }], {
      intruder: [],
      expect: [401],
    }),
  );
  expect(await runAccess(runtime, { dispatcher })).toMatchObject({ outcome: "passed" });
  expect(seen).toEqual([
    { authorization: undefined, type: "application/json", body: '{"id":7}' },
    { authorization: OWNER_TOKEN, type: "application/json", body: '{"id":7}' },
  ]);
});

it("judges every operation and numbers a repeated operation's step", async () => {
  const base = await serve((request, response) => {
    if (request.url === "/open") response.statusCode = 200;
    else guarded(request, response);
    response.end();
  });
  const { runtime, events, dispatcher } = fixture(
    base,
    probeOf([
      { method: "GET", path: "/orders/1" },
      { method: "GET", path: "/open" },
      { method: "GET", path: "/orders/1" },
    ]),
  );
  expect(await runAccess(runtime, { dispatcher })).toMatchObject({ outcome: "failed" });
  expect(finished(events).map((step) => [step.stepId, step.status])).toEqual([
    ["access:GET /orders/1", "passed"],
    ["access:GET /open", "failed"],
    ["access:GET /orders/1 #2", "passed"],
    ["access", "failed"],
  ]);
});

it("is inconclusive when the target cannot be reached", async () => {
  const base = await serve(guarded);
  await new Promise<void>((resolve) => servers.pop()?.close(() => resolve()));
  const { runtime, events, dispatcher } = fixture(
    base,
    probeOf([{ method: "GET", path: "/orders/1" }]),
  );
  expect(await runAccess(runtime, { dispatcher })).toEqual({
    outcome: "inconclusive",
    reasonCode: "insufficient_evidence",
  });
  expect(finished(events)[0]).toMatchObject({
    status: "inconclusive",
    error: { code: "ECONNREFUSED" },
  });
});

it("refuses a path that leaves the target origin before sending anything", async () => {
  let requests = 0;
  const base = await serve((_request, response) => {
    requests += 1;
    response.end();
  });
  const { runtime, events, dispatcher } = fixture(
    base,
    probeOf([{ method: "GET", path: "//evil.example/x" }]),
    {
      networkPolicy: {
        allowedOrigins: [base, "http://evil.example"],
        networkProfile: "local-loopback",
      },
    },
  );
  expect(await runAccess(runtime, { dispatcher })).toEqual({
    outcome: "blocked",
    reasonCode: "egress_denied",
  });
  expect(requests).toBe(0);
  expect(finished(events).map((step) => [step.stepId, step.status])).toEqual([
    ["access", "blocked"],
  ]);
});

it("reports a cancel as cancelled without judging the remaining operations", async () => {
  let cancel = () => {};
  const base = await serve((request, response) => {
    // The request never answers; the cancel arrives while it is in flight.
    if (request.url === "/slow") return cancel();
    guarded(request, response);
  });
  const { runtime, events, controller, dispatcher } = fixture(
    base,
    probeOf([
      { method: "GET", path: "/slow" },
      { method: "GET", path: "/orders/1" },
    ]),
  );
  cancel = () => controller.abort(new Error("user_cancelled"));
  expect(await runAccess(runtime, { dispatcher })).toEqual({
    outcome: "cancelled",
    reasonCode: "user_cancelled",
  });
  expect(finished(events).map((step) => [step.stepId, step.status])).toEqual([
    ["access:GET /slow", "cancelled"],
    ["access", "cancelled"],
  ]);
});
