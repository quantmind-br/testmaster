import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import {
  createServer,
  request as httpRequest,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from "node:http";
import { createServer as createTlsServer } from "node:https";
import { connect, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import {
  type ExecutablePlan,
  type Expectation,
  type PlanStep,
  type RunnerEvent,
  validateRunnerWireEvent,
} from "@testmaster/contracts";
import { Agent } from "undici";
import { afterEach, expect, it, vi } from "vitest";
import {
  assertResponse,
  authorizeUrl,
  HttpEngine,
  jsonPointerValue,
  readAuthorizedArtifact,
  runHttp,
} from "./http.js";
import type { ProtocolClient } from "./protocol.js";
import { type RunnerInput, Runtime } from "./runtime.js";

const servers: Server[] = [];
const engines: HttpEngine[] = [];
const agents: Agent[] = [];
const ATTEMPT = "att_01900000-0000-7000-8000-000000000001";
const SOURCE = "svr_01900000-0000-7000-8000-000000000001";
afterEach(async () => {
  vi.unstubAllEnvs();
  for (const engine of engines.splice(0)) await engine.close();
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
function fixture(
  baseUrl: string,
  extra: Partial<RunnerInput> = {},
  secretValues: Record<string, string> = {},
) {
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
    secret: async (ref: string) => secretValues[ref] ?? "canary-secret",
  } as unknown as ProtocolClient;
  const runtime = new Runtime(
    {
      attemptId: ATTEMPT,
      nonce: "n".repeat(32),
      baseUrl,
      networkPolicy: { allowedOrigins: [baseUrl], networkProfile: "local-loopback" },
      secrets: [],
      ...extra,
    },
    protocol,
    controller.signal,
  );
  const agent = new Agent();
  agents.push(agent);
  const engine = new HttpEngine(runtime, { dispatcher: agent });
  engines.push(engine);
  return { runtime, engine, events, artifacts, controller };
}
function requestStep(
  id: string,
  path: string[],
  input: Partial<Extract<PlanStep, { operation: "request" }>["input"]> = {},
): PlanStep {
  return {
    id,
    kind: "action",
    operation: "request",
    description: id,
    input: { method: "GET", pathSegments: path.map((literal) => ({ literal })), ...input },
  };
}
function responseOf(engine: HttpEngine, id: string) {
  const response = engine.responses.get(id);
  if (!response) throw new Error(`Missing response: ${id}`);
  return response;
}
function plan(steps: PlanStep[], cleanup?: ExecutablePlan["cleanup"]): ExecutablePlan {
  return {
    schemaVersion: "1.0.0",
    kind: "executable",
    name: "HTTP fixture",
    type: "backend",
    runner: "http",
    requirementRefs: [],
    steps,
    ...(cleanup ? { cleanup } : {}),
  };
}

it("escapes path/query once, preserves duplicate query names, and sends JSON through real HTTP", async () => {
  const base = await serve((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk) => chunks.push(chunk));
    req.on("end", () =>
      res.end(
        JSON.stringify({
          url: req.url,
          body: JSON.parse(Buffer.concat(chunks).toString()),
          contentType: req.headers["content-type"],
        }),
      ),
    );
  });
  const { engine, runtime } = fixture(base);
  await engine.perform(
    requestStep("send", ["a/b", "50%", "space here"], {
      method: "POST",
      query: [
        { name: { literal: "q" }, value: { literal: "a&b" } },
        { name: { literal: "q" }, value: { literal: "c d" } },
      ],
      body: { kind: "json", value: { literal: { n: 3 } } },
    }),
  );
  const response = engine.responses.get("send");
  expect(response).toBeDefined();
  await assertResponse(runtime, responseOf(engine, "send"), {
    predicate: "jsonEquals",
    value: {
      literal: {
        url: "/a%2Fb/50%25/space%20here?q=a%26b&q=c+d",
        body: { n: 3 },
        contentType: "application/json",
      },
    },
  });
});

it("treats 401 as a response and fails a semantic negative control even with HTTP 200", async () => {
  const base = await serve((req, res) => {
    res.statusCode = req.url === "/denied" ? 401 : 200;
    res.end('{"status":"degraded"}');
  });
  const { engine, runtime } = fixture(base);
  await engine.perform(requestStep("denied", ["denied"]));
  await assertResponse(runtime, responseOf(engine, "denied"), {
    predicate: "statusIn",
    values: [401],
  });
  await engine.perform(requestStep("health", ["health"]));
  await expect(
    assertResponse(
      runtime,
      responseOf(engine, "health"),
      { predicate: "jsonEquals", value: { literal: "ok" } },
      "/status",
    ),
  ).rejects.toMatchObject({ reasonCode: "assertion_mismatch", outcome: "failed" });
});

it("evaluates header/count/schema expectations against named snapshot schemas", async () => {
  const base = await serve((_req, res) => {
    res.setHeader("X-Count", "2");
    res.end('{"items":[1,2]}');
  });
  const { engine, runtime } = fixture(base, {
    schemas: {
      [SOURCE]: {
        components: {
          schemas: {
            Result: {
              type: "object",
              required: ["items"],
              additionalProperties: false,
              properties: { items: { type: "array", items: { type: "integer" } } },
            },
          },
        },
      },
    },
  });
  await engine.perform(requestStep("read", []));
  const response = responseOf(engine, "read");
  await assertResponse(runtime, response, {
    predicate: "headerEquals",
    header: "X-COUNT",
    value: { literal: "2" },
  });
  await assertResponse(runtime, response, { predicate: "countEquals", value: 2 }, "/items");
  await assertResponse(runtime, response, {
    predicate: "jsonSchema",
    sourceRevisionId: SOURCE,
    pointer: "/components/schemas/Result",
  });
  await expect(
    assertResponse(runtime, response, { predicate: "countEquals", value: 1 }, "/items"),
  ).rejects.toMatchObject({ reasonCode: "assertion_mismatch" });
});
it.each([
  ["countEquals", 3, 3, "passed", 3],
  ["countEquals", 2, 3, "failed", 2],
  ["countAtMost", 3, 3, "passed", { atMost: 3 }],
  ["countAtMost", 2, 3, "failed", { atMost: 2 }],
  ["countAtMost", 4, 3, "passed", { atMost: 4 }],
  ["countAtMost", 0, 0, "passed", { atMost: 0 }],
  ["countAtMost", 0, 1, "failed", { atMost: 0 }],
  ["countAtLeast", 3, 3, "passed", { atLeast: 3 }],
  ["countAtLeast", 4, 3, "failed", { atLeast: 4 }],
  ["countAtLeast", 2, 3, "passed", { atLeast: 2 }],
] as const)(
  "evaluates %s %i over an array of %i items: %s, recording the observed count",
  async (predicate, value, items, status, expected) => {
    const base = await serve((_req, res) =>
      res.end(JSON.stringify({ items: [...Array(items).keys()] })),
    );
    const f = fixture(base);
    const assertion = assertStep("count", "go", { predicate, value });
    const outcome = await f.runtime.runSteps(
      [
        requestStep("go", []),
        { ...assertion, input: { responseStepId: "go", jsonPointer: "/items" } },
      ],
      (step) => f.engine.perform(step),
    );
    if (status === "passed") expect(outcome).toMatchObject({ outcome: "passed" });
    else expect(outcome).toMatchObject({ outcome: "failed", reasonCode: "assertion_mismatch" });
    expect(stepPayload(f.events, "count")).toMatchObject({ status, observed: items, expected });
  },
);
it.each(["countAtMost", "countAtLeast"] as const)(
  "fails %s over a JSON value that is not an array",
  async (predicate) => {
    const base = await serve((_req, res) => res.end('{"items":[1,2,3],"name":"x"}'));
    const { engine, runtime } = fixture(base);
    await engine.perform(requestStep("read", []));
    await expect(
      assertResponse(runtime, responseOf(engine, "read"), { predicate, value: 1 }, "/name"),
    ).rejects.toMatchObject({ reasonCode: "assertion_mismatch", outcome: "failed" });
  },
);
it("fails assertions whose JSON target is absent from a complete response", async () => {
  const base = await serve((_req, res) => res.end('{"items":[],"product":{"price":125}}'));
  const { engine, runtime } = fixture(base);
  await engine.perform(requestStep("read", []));
  const response = responseOf(engine, "read");
  for (const [expectation, pointer] of [
    [{ predicate: "jsonEquals", value: { literal: 1250 } }, "/items/0/totalCents"],
    [{ predicate: "jsonEquals", value: { literal: null } }, "/product/priceCents"],
    [{ predicate: "countEquals", value: 0 }, "/orders"],
  ] as const)
    await expect(
      assertResponse(
        runtime,
        response,
        expectation as Parameters<typeof assertResponse>[2],
        pointer,
      ),
    ).rejects.toMatchObject({ reasonCode: "assertion_mismatch", outcome: "failed" });
});
it("names the status and content type of a body that is not JSON", async () => {
  const base = await serve((_req, res) => {
    res.setHeader("content-type", "text/html; charset=utf-8");
    res.end("<!doctype html><title>app</title>");
  });
  const { engine, runtime } = fixture(base);
  await engine.perform(requestStep("health", ["health"]));
  await expect(
    assertResponse(runtime, responseOf(engine, "health"), {
      predicate: "jsonEquals",
      value: { literal: { status: "ok" } },
    }),
  ).rejects.toMatchObject({
    reasonCode: "assertion_mismatch",
    message: 'Response is not valid JSON (status 200, content-type "text/html; charset=utf-8")',
  });
});
it("records value-free missing-pointer structure and distinguishes empty arrays from absent keys", async () => {
  const base = await serve((_req, res) =>
    res.end(
      JSON.stringify({
        items: [],
        product: { price: 125, "canary-secret": "private-value", ["z".repeat(80)]: 99 },
      }),
    ),
  );
  for (const [pointer, structure] of [
    [
      "/items/0/priceCents",
      { deepestPrefix: "/items", type: "array", length: 0, firstUnresolvedToken: "0" },
    ],
    [
      "/product/priceCents",
      {
        deepestPrefix: "/product",
        type: "object",
        keys: ["[REDACTED]", "price", "z".repeat(64)],
        unlistedKeyCount: 0,
        firstUnresolvedToken: "priceCents",
      },
    ],
  ] as const) {
    const f = fixture(base);
    f.runtime.secrets.add("canary-secret");
    const check: PlanStep = {
      id: "check",
      kind: "assertion",
      operation: "assert",
      description: "Check approved value",
      input: { responseStepId: "read", jsonPointer: pointer },
      expectation: { predicate: "jsonEquals", value: { literal: 1250 } },
    };
    expect(
      await f.runtime.runSteps([requestStep("read", []), check], (step) => f.engine.perform(step)),
    ).toMatchObject({ outcome: "failed", reasonCode: "assertion_mismatch" });
    const event = f.events.find(
      (event) => event.type === "step.finished" && event.payload.stepId === "check",
    )!;
    const payload = event.payload as { error: { message: string }; observed: unknown };
    expect(payload.observed).toBeNull();
    expect(JSON.parse(payload.error.message.split("; missing JSON pointer: ")[1]!)).toEqual(
      structure,
    );
    expect(payload.error.message).not.toContain("private-value");
    expect(payload.error.message).not.toContain("canary-secret");
  }
});
it("cites the response artifact of its request step on a failed and on a passed status assertion", async () => {
  const base = await serve((_req, res) => res.end('{"status":"ok"}'));
  const f = fixture(base);
  const steps = [
    requestStep("get_version", []),
    assertStep("assert_status_ok", "get_version", { predicate: "statusIn", values: [200] }),
    assertStep("assert_status_mismatch", "get_version", { predicate: "statusIn", values: [201] }),
  ];
  expect(await f.runtime.runSteps(steps, (step) => f.engine.perform(step))).toMatchObject({
    outcome: "failed",
    reasonCode: "assertion_mismatch",
  });
  const finished = (stepId: string) =>
    f.events.find((event) => event.type === "step.finished" && event.payload.stepId === stepId)
      ?.payload as { status: string; evidencePaths: string[] };
  expect(finished("get_version")).toMatchObject({
    status: "passed",
    evidencePaths: ["http/get_version.json"],
  });
  expect(finished("assert_status_ok")).toMatchObject({
    status: "passed",
    evidencePaths: ["http/get_version.json"],
  });
  expect(finished("assert_status_mismatch")).toMatchObject({
    status: "failed",
    evidencePaths: ["http/get_version.json"],
  });
  expect(f.artifacts.has("http/get_version.json")).toBe(true);
});
it("bounds structural keys and records no missing diagnostic for a resolved null", async () => {
  const product = Object.fromEntries(
    Array.from({ length: 40 }, (_, i) => [`k${String(i).padStart(2, "0")}`, "private-value"]),
  );
  const base = await serve((_req, res) => res.end(JSON.stringify({ product, present: null })));
  const f = fixture(base);
  await f.engine.perform(requestStep("read", []));
  let message = "";
  try {
    await assertResponse(
      f.runtime,
      responseOf(f.engine, "read"),
      { predicate: "jsonEquals", value: { literal: 1 } },
      "/product/absent",
    );
  } catch (error) {
    message = (error as Error).message;
  }
  const diagnostic = JSON.parse(message.split("; missing JSON pointer: ")[1]!);
  expect(diagnostic.keys).toHaveLength(32);
  expect(diagnostic.unlistedKeyCount).toBe(8);
  expect(message).not.toContain("private-value");
  await expect(
    assertResponse(
      f.runtime,
      responseOf(f.engine, "read"),
      { predicate: "jsonEquals", value: { literal: null } },
      "/present",
    ),
  ).resolves.toBeUndefined();
  await expect(
    assertResponse(
      f.runtime,
      responseOf(f.engine, "read"),
      { predicate: "jsonEquals", value: { literal: 1 } },
      "/present",
    ),
  ).rejects.toMatchObject({ message: "HTTP jsonEquals expectation was not satisfied" });
});

it("keeps a target the egress proxy could not reach inconclusive with its socket error code", async () => {
  const proxy = createServer((_req, res) => {
    res.writeHead(502, { "x-testmaster-upstream-failure": "ECONNRESET", connection: "close" });
    res.end();
  });
  servers.push(proxy);
  await new Promise<void>((resolve) => proxy.listen(0, "127.0.0.1", resolve));
  const address = proxy.address();
  if (!address || typeof address === "string") throw new Error("Missing proxy fixture address");
  vi.stubEnv("TESTMASTER_EGRESS_PROXY", `http://127.0.0.1:${address.port}`);
  const read = fixture("http://127.0.0.1:9", { plan: plan([requestStep("health", [])]) });
  expect(await runHttp(read.runtime)).toMatchObject({
    outcome: "inconclusive",
    reasonCode: "insufficient_evidence",
  });
  expect(
    read.events.find((event) => event.type === "step.finished" && event.payload.stepId === "health")
      ?.payload,
  ).toMatchObject({
    status: "inconclusive",
    // Same transport class as a direct socket loss, so flake studies classify it as infrastructure.
    error: {
      code: "ECONNRESET",
      message: "HTTP transport did not produce a complete usable response",
    },
  });
  // A reset after a mutating request was sent may have reached the target: never retry-safe.
  const create = requestStep("create", ["orders"], {
    method: "POST",
    resource: {
      resourceType: "order",
      correlationKey: { literal: "order-correlation" },
      handle: "/id",
      ownerProof: "/owner",
    },
  });
  const write = fixture("http://127.0.0.1:9", { plan: plan([create]) });
  expect(await runHttp(write.runtime)).toMatchObject({
    outcome: "inconclusive",
    reasonCode: "retry_unsafe_external_effect",
  });
});

it("sends typed sensitive captures only over trusted IPC and keeps artifacts redacted", async () => {
  const base = await serve((_req, res) => {
    res.setHeader("X-Count", "7");
    res.end('{"token":"captured-canary","public":"ok"}');
  });
  const { engine, runtime, events, artifacts } = fixture(base);
  await engine.perform(
    requestStep("capture", [], {
      capture: [
        {
          name: "token",
          from: "jsonPointer",
          pointer: "/token",
          valueType: "string",
          sensitive: true,
        },
        { name: "count", from: "header", header: "X-Count", valueType: "number", sensitive: false },
      ],
    }),
  );
  expect(runtime.variables.get("capture.token")).toEqual({
    value: "captured-canary",
    sensitive: true,
  });
  expect(runtime.variables.get("count")).toEqual({ value: 7, sensitive: false });
  expect(
    JSON.stringify(events.filter((event) => event.type !== "variable.captured")),
  ).not.toContain("captured-canary");
  for (const bytes of artifacts.values())
    expect(Buffer.from(bytes).toString()).not.toContain("captured-canary");
  const captureTrace = JSON.parse(Buffer.from(artifacts.get("http/capture.json") ?? []).toString());
  expect(captureTrace.captures).toContainEqual({
    name: "token",
    variableRef: "capture.token",
    valueType: "string",
    sensitive: true,
    resolved: "[REDACTED]",
  });
  expect(captureTrace.captures).toContainEqual({
    name: "count",
    variableRef: "capture.count",
    valueType: "number",
    sensitive: false,
    resolved: 7,
  });
  await engine.perform(
    requestStep("consume", [], {
      pathSegments: [{ variableRef: "capture.count" }],
      headers: { "x-captured-token": { variableRef: "capture.token" } },
    }),
  );
  const consumeTrace = JSON.parse(Buffer.from(artifacts.get("http/consume.json") ?? []).toString());
  expect(consumeTrace.request.bindings).toEqual([
    { variableRef: "capture.count", sensitive: false, resolved: 7 },
    { variableRef: "capture.token", sensitive: true, resolved: "[REDACTED]" },
  ]);
  expect(JSON.stringify(consumeTrace)).not.toContain("captured-canary");
  expect(
    events.some(
      (event) =>
        event.type === "variable.captured" &&
        event.payload.sensitive &&
        event.payload.value &&
        "literal" in event.payload.value &&
        event.payload.value.literal === "captured-canary",
    ),
  ).toBe(true);
  await expect(
    engine.perform(
      requestStep("bad-type", [], {
        capture: [
          {
            name: "bad",
            from: "jsonPointer",
            pointer: "/token",
            valueType: "number",
            sensitive: false,
          },
        ],
      }),
    ),
  ).rejects.toMatchObject({ reasonCode: "assertion_mismatch" });
});

it("does not taint a capture of a credentialed request unless the capture declares sensitive", async () => {
  const base = await serve((req, res) =>
    res.end(JSON.stringify({ echo: req.headers.authorization })),
  );
  const { engine, runtime, events } = fixture(base, {
    variables: { auth: { value: "Bearer request-canary", sensitive: true } },
  });
  const echo = (name: string, sensitive: boolean) =>
    ({ name, from: "jsonPointer", pointer: "/echo", valueType: "string", sensitive }) as const;
  await engine.perform(
    requestStep("taint", [], {
      headers: { Authorization: { variableRef: "auth" } },
      capture: [echo("plain", false), echo("declared", true)],
    }),
  );
  expect(runtime.variables.get("plain")?.sensitive).toBe(false);
  expect(runtime.variables.get("declared")?.sensitive).toBe(true);
  expect(
    JSON.stringify(events.filter((event) => event.type !== "variable.captured")),
  ).not.toContain("request-canary");
});

it("strips authorization/cookies/API keys on allowed cross-origin redirects", async () => {
  let observed: IncomingMessage["headers"] = {};
  const destination = await serve((req, res) => {
    observed = req.headers;
    res.end("ok");
  });
  const base = await serve((_req, res) => {
    res.writeHead(302, { location: `${destination}/target` });
    res.end();
  });
  const { engine } = fixture(base, {
    networkPolicy: { allowedOrigins: [base, destination], networkProfile: "local-loopback" },
    variables: {
      auth: { value: "Bearer canary", sensitive: true },
      cookie: { value: "sid=canary", sensitive: true },
    },
  });
  await engine.perform(
    requestStep("redirect", [], {
      headers: {
        Authorization: { variableRef: "auth" },
        Cookie: { variableRef: "cookie" },
        "X-Api-Key": { variableRef: "auth" },
      },
    }),
  );
  expect(observed.authorization).toBeUndefined();
  expect(observed.cookie).toBeUndefined();
  expect(observed["x-api-key"]).toBeUndefined();
});

it("enforces ten redirects and reauthorizes each destination", async () => {
  let hits = 0;
  const base = await serve((req, res) => {
    hits++;
    res.writeHead(302, { location: `/hop/${Number(req.url?.split("/").pop() ?? 0) + 1}` });
    res.end();
  });
  const { engine } = fixture(base);
  await expect(engine.perform(requestStep("loop", ["hop", "0"]))).rejects.toMatchObject({
    reasonCode: "egress_denied",
  });
  expect(hits).toBe(11);
  const blocked = await serve((_req, res) => {
    res.writeHead(302, { location: "http://not-allowed.test/" });
    res.end();
  });
  const denied = fixture(blocked);
  await expect(denied.engine.perform(requestStep("denied", []))).rejects.toMatchObject({
    reasonCode: "egress_denied",
  });
});

it("records intent before mutations and executes explicit owned cleanup in reverse creation order", async () => {
  const cleaned: string[] = [];
  const base = await serve((req, res) => {
    if (req.method === "DELETE") {
      cleaned.push(req.url ?? "");
      res.statusCode = 204;
      res.end();
    } else {
      res.statusCode = 201;
      res.end(JSON.stringify({ id: req.url?.slice(1), owner: "attempt-proof" }));
    }
  });
  const steps = [
    requestStep("parent", ["parent"], {
      method: "POST",
      resource: {
        resourceType: "fixture",
        correlationKey: { literal: "parent-correlation" },
        handle: "/id",
        ownerProof: "/owner",
      },
    }),
    requestStep("child", ["child"], {
      method: "POST",
      resource: {
        resourceType: "fixture",
        correlationKey: { literal: "child-correlation" },
        handle: "/id",
        ownerProof: "/owner",
      },
    }),
  ];
  const cleanup: ExecutablePlan["cleanup"] = ["parent", "child"].map((resourceRef) => ({
    resourceRef,
    operation: "request",
    input: { method: "DELETE", pathSegments: [{ variableRef: `${resourceRef}.handle` }] },
    successPredicate: { predicate: "statusIn", values: [204] },
    deadlineMs: 1000,
    required: true,
  }));
  const { engine, events } = fixture(base, { plan: plan(steps, cleanup) });
  for (const step of steps) await engine.perform(step);
  expect(
    events.filter((event) => event.type.startsWith("resource.")).map((event) => event.type),
  ).toEqual(["resource.intent", "resource.created", "resource.intent", "resource.created"]);
  expect(
    await engine.cleanup({ outcome: "passed", reasonCode: "assertions_satisfied" }),
  ).toMatchObject({ outcome: "passed", cleanupOutcome: "passed" });
  expect(cleaned).toEqual(["/child", "/parent"]);
});

it("never cleans an unproven resource and reports uncertain side effects without retry", async () => {
  let calls = 0;
  const base = await serve((req, _res) => {
    calls++;
    req.socket.destroy();
  });
  const { engine, events } = fixture(base);
  await expect(
    engine.perform(
      requestStep("mutate", [], {
        method: "POST",
        resource: {
          resourceType: "fixture",
          correlationKey: { literal: "mutation" },
          handle: "/id",
          ownerProof: "/owner",
        },
      }),
    ),
  ).rejects.toMatchObject({ reasonCode: "retry_unsafe_external_effect" });
  expect(calls).toBe(1);
  expect(events.map((event) => event.type)).toEqual(["resource.intent", "resource.uncertain"]);
  expect(
    await engine.cleanup({ outcome: "inconclusive", reasonCode: "retry_unsafe_external_effect" }),
  ).toMatchObject({ cleanupOutcome: "inconclusive" });
  expect(calls).toBe(1);
});

it("preserves business outcomes when cleanup fails and denies compensation after revocation", async () => {
  let deletes = 0;
  const base = await serve((req, res) => {
    if (req.method === "DELETE") {
      deletes++;
      res.statusCode = 500;
      res.end();
    } else {
      res.statusCode = 201;
      res.end('{"id":"owned","proof":"ours"}');
    }
  });
  const step = requestStep("create", [], {
    method: "POST",
    resource: {
      resourceType: "fixture",
      correlationKey: { literal: "create" },
      handle: "/id",
      ownerProof: "/proof",
    },
  });
  const cleanup: ExecutablePlan["cleanup"] = [
    {
      resourceRef: "create",
      operation: "request",
      input: { method: "DELETE", pathSegments: [{ variableRef: "create.handle" }] },
      successPredicate: { predicate: "statusIn", values: [204] },
      deadlineMs: 1000,
      required: true,
    },
  ];
  const first = fixture(base, { plan: plan([step], cleanup) });
  await first.engine.perform(step);
  expect(
    await first.engine.cleanup({ outcome: "failed", reasonCode: "assertion_mismatch" }),
  ).toEqual({ outcome: "failed", reasonCode: "assertion_mismatch", cleanupOutcome: "failed" });
  const revoked = fixture(base, { plan: plan([step], cleanup) });
  await revoked.engine.perform(step);
  revoked.controller.abort(new Error("credential_revoked"));
  expect(
    (await revoked.engine.cleanup({ outcome: "cancelled", reasonCode: "user_cancelled" }))
      .cleanupOutcome,
  ).toBe("inconclusive");
  expect(deletes).toBe(1);
});

it("rejects secret queries, header injection, unsafe URLs and artifacts before IO", async () => {
  const base = await serve((_req, res) => res.end("ok"));
  const { engine, runtime } = fixture(base, {
    variables: { secret: { value: "canary", sensitive: true } },
    artifacts: { art: { path: "../escape", mimeType: "text/plain", sizeBytes: 1 } },
  });
  await expect(
    engine.perform(
      requestStep("query", [], {
        query: [{ name: { literal: "token" }, value: { variableRef: "secret" } }],
      }),
    ),
  ).rejects.toMatchObject({ reasonCode: "security_precondition_failed" });
  await expect(
    engine.perform(requestStep("header", [], { headers: { Host: { literal: "evil.test" } } })),
  ).rejects.toMatchObject({ reasonCode: "security_precondition_failed" });
  await expect(
    engine.perform(
      requestStep("newline", [], { headers: { "X-Test": { literal: "bad\r\nheader" } } }),
    ),
  ).rejects.toMatchObject({ reasonCode: "security_precondition_failed" });
  expect(() => authorizeUrl(runtime, `${base.replace("127.0.0.1", "2130706433")}/`)).toThrow();
  expect(() => authorizeUrl(runtime, "file:///etc/passwd")).toThrow();
  await expect(readAuthorizedArtifact(runtime, "art")).rejects.toMatchObject({
    reasonCode: "security_precondition_failed",
  });
  for (const path of [
    "/etc/passwd",
    "/run/testmaster/input/../escape",
    "/run/testmaster/input//escape",
    "/run/testmaster/input-other/file",
  ]) {
    const scoped = fixture(base, {
      artifacts: { art: { path, mimeType: "text/plain", sizeBytes: 1 } },
    });
    await expect(readAuthorizedArtifact(scoped.runtime, "art")).rejects.toMatchObject({
      reasonCode: "security_precondition_failed",
    });
  }
  expect(jsonPointerValue({ "a/b": { "~key": null } }, "/a~1b/~0key")).toBeNull();
  expect(() => jsonPointerValue({}, "/absent")).toThrow();
});

it("bounds response bodies and deadlines without converting transport absence into a pass", async () => {
  const base = await serve((req, res) => {
    if (req.url === "/large") res.end("x".repeat(100));
  });
  const { engine } = fixture(base, { bodyBytes: 32 });
  await expect(engine.perform(requestStep("large", ["large"]))).rejects.toMatchObject({
    reasonCode: "artifact_limit_exceeded",
  });
  await expect(
    engine.perform({ ...requestStep("timeout", ["hang"]), timeoutMs: 20 }),
  ).rejects.toMatchObject({ outcome: "inconclusive" });
});

it("times a request out at the per-run step cap even when the step declares a longer timeout", async () => {
  const base = await serve(() => undefined);
  const { engine } = fixture(base, { stepTimeoutCapMs: 20 });
  // The saved step carries the project default of 30 s; the hanging request must end at 20 ms.
  await expect(
    engine.perform({ ...requestStep("capped", ["hang"]), timeoutMs: 30_000 }),
  ).rejects.toMatchObject({ outcome: "inconclusive" });
});

it("does not lengthen a request's own timeout to a higher per-run step cap", async () => {
  const base = await serve(() => undefined);
  const { engine } = fixture(base, { stepTimeoutCapMs: 30_000 });
  await expect(
    engine.perform({ ...requestStep("own", ["hang"]), timeoutMs: 20 }),
  ).rejects.toMatchObject({ outcome: "inconclusive" });
});

it("does not charge the wait for a host model answer to the attempt deadline", async () => {
  vi.useFakeTimers({ toFake: ["performance"] });
  try {
    const base = await serve((_req, res) => res.end("ok"));
    // Control: a minute of attempt time against a 100 ms deadline is expired.
    const expired = fixture(base, { timeoutMs: 100 });
    vi.advanceTimersByTime(60_000);
    await expect(expired.engine.perform(requestStep("late", []))).rejects.toMatchObject({
      reasonCode: "execution_deadline",
    });
    // The same minute spent waiting for the host's model answer is not attempt time.
    const waiting = fixture(base, { timeoutMs: 100 });
    const resume = waiting.runtime.clock.pause();
    vi.advanceTimersByTime(60_000);
    resume();
    await waiting.engine.perform(requestStep("on-time", []));
    expect(responseOf(waiting.engine, "on-time").status).toBe(200);
  } finally {
    vi.useRealTimers();
  }
});

it("requires a proxy in runHttp and can use a real local CONNECT proxy", async () => {
  const target = await serve((_req, res) => res.end('{"healthy":true}'));
  const steps: PlanStep[] = [
    requestStep("health", []),
    {
      id: "assert-health",
      kind: "assertion",
      operation: "assert",
      description: "healthy",
      input: { responseStepId: "health", jsonPointer: "/healthy" },
      expectation: { predicate: "jsonEquals", value: { literal: true } },
    },
  ];
  const { runtime } = fixture(target, { plan: plan(steps) });
  vi.stubEnv("TESTMASTER_EGRESS_PROXY", "");
  expect(await runHttp(runtime)).toMatchObject({
    outcome: "blocked",
    reasonCode: "security_precondition_failed",
  });
  const proxy = createServer((req, res) => {
    if (!req.url) {
      res.writeHead(400);
      res.end();
      return;
    }
    const targetUrl = new URL(req.url);
    const upstream = httpRequest(
      targetUrl,
      { method: req.method, headers: req.headers },
      (response) => {
        res.writeHead(response.statusCode ?? 502, response.headers);
        response.pipe(res);
      },
    );
    upstream.on("error", () => {
      if (!res.headersSent) res.writeHead(502);
      res.end();
    });
    req.pipe(upstream);
  });
  servers.push(proxy);
  const sockets = new Set<Socket>();
  proxy.on("connect", (req, socket, head) => {
    const url = new URL(`http://${req.url}`);
    const upstream = connect(Number(url.port), url.hostname, () => {
      socket.write("HTTP/1.1 200 Connection Established\r\n\r\n");
      if (head.length) upstream.write(head);
      socket.pipe(upstream).pipe(socket);
    });
    sockets.add(upstream);
    upstream.on("close", () => sockets.delete(upstream));
    upstream.on("error", () => socket.destroy());
    socket.on("close", () => upstream.destroy());
  });
  await new Promise<void>((resolve) => proxy.listen(0, "127.0.0.1", resolve));
  const address = proxy.address();
  if (!address || typeof address === "string") throw new Error("Missing proxy fixture address");
  vi.stubEnv("TESTMASTER_EGRESS_PROXY", `http://127.0.0.1:${address.port}`);
  try {
    expect(await runHttp(runtime)).toMatchObject({
      outcome: "passed",
      reasonCode: "assertions_satisfied",
    });
  } finally {
    for (const socket of sockets) socket.destroy();
  }
});

it("retains only bounded error metadata by default while assertions consume full responses in memory", async () => {
  const body = JSON.stringify({
    error: "failed validation",
    message: "Contact person@example.test",
    records: "unnecessary-private-body".repeat(1000),
  });
  const base = await serve((_req, res) => {
    res.writeHead(500, {
      "content-type": "application/json",
      "set-cookie": "sid=never-keep",
      "x-private": "never-keep-header",
    });
    res.end(body);
  });
  const { engine, artifacts } = fixture(base, {
    variables: { payload: { value: { private: "unnecessary-request-body" }, sensitive: false } },
  });
  await engine.perform(
    requestStep("request", [], {
      method: "POST",
      body: { kind: "json", value: { variableRef: "payload" } },
    }),
  );
  expect(engine.responses.get("request")?.body.byteLength).toBe(Buffer.byteLength(body));
  const evidence = JSON.parse(Buffer.from(artifacts.get("http/request.json") ?? []).toString());
  expect(evidence.response).not.toHaveProperty("body");
  expect(evidence.request).not.toHaveProperty("body");
  expect(evidence.response.bodyMetadata.sizeBytes).toBe(Buffer.byteLength(body));
  expect(evidence.response.bodyMetadata.sha256).toMatch(/^[0-9a-f]{64}$/);
  expect(evidence.response.failureExcerpt).toContain("failed validation");
  expect(evidence.response.failureExcerpt.length).toBeLessThanOrEqual(512);
  expect(JSON.stringify(evidence)).not.toMatch(/unnecessary-|person@example|never-keep/);
  expect(artifacts.has("http/request-bodies.json")).toBe(false);
});

it("requires explicit restricted body optin before any request and emits full bodies only separately", async () => {
  let hits = 0;
  const base = await serve((_req, res) => {
    hits++;
    res.setHeader("content-type", "application/json");
    res.end('{"business":"complete-response","token":"sensitive-pattern"}');
  });
  const denied = fixture(base, { policy: { httpBodies: true } });
  await expect(denied.engine.perform(requestStep("denied", []))).rejects.toMatchObject({
    reasonCode: "security_precondition_failed",
  });
  expect(hits).toBe(0);
  const allowed = fixture(base, { policy: { httpBodies: true, restrictedRaw: true } });
  await allowed.engine.perform(requestStep("allowed", []));
  expect(hits).toBe(1);
  const raw = Buffer.from(allowed.artifacts.get("http/allowed-bodies.json") ?? []).toString();
  expect(raw).toContain("complete-response");
  expect(raw).not.toContain("sensitive-pattern");
  expect(Buffer.from(allowed.artifacts.get("http/allowed.json") ?? []).toString()).not.toContain(
    "complete-response",
  );
});

it("emits real HTTP business comparisons and redacts a secret-derived expected value", async () => {
  let price = "12.50";
  const base = await serve((_request, response) => {
    response.setHeader("content-type", "application/json");
    response.end(JSON.stringify({ price }));
  });
  const current = fixture(base);
  const check: PlanStep = {
    id: "price",
    kind: "assertion",
    operation: "assert",
    description: "Exact price",
    input: { responseStepId: "quote", jsonPointer: "/price" },
    expectation: { predicate: "jsonEquals", value: { literal: "12.50" } },
  };
  const steps = [requestStep("quote", []), check];
  expect(
    await current.runtime.runSteps(steps, (step) => current.engine.perform(step)),
  ).toMatchObject({ outcome: "passed" });
  expect(
    current.events.find(
      (event) => event.type === "step.finished" && event.payload.stepId === "price",
    )?.payload,
  ).toMatchObject({ observed: "12.50", expected: "12.50" });
  price = "1.25";
  const broken = fixture(base);
  expect(await broken.runtime.runSteps(steps, (step) => broken.engine.perform(step))).toMatchObject(
    { outcome: "failed", reasonCode: "assertion_mismatch" },
  );
  expect(
    broken.events.find(
      (event) => event.type === "step.finished" && event.payload.stepId === "price",
    )?.payload,
  ).toMatchObject({ observed: "1.25", expected: "12.50" });
  const secret = fixture(base);
  const privateCheck: PlanStep = {
    ...check,
    expectation: { predicate: "jsonEquals", value: { literal: "canary-secret" } },
  };
  secret.runtime.secrets.add("canary-secret");
  expect(
    await secret.runtime.runSteps([requestStep("quote", []), privateCheck], (step) =>
      secret.engine.perform(step),
    ),
  ).toMatchObject({ outcome: "failed" });
  const payload = secret.events.find(
    (event) => event.type === "step.finished" && event.payload.stepId === "price",
  )!.payload;
  expect(payload).not.toHaveProperty("observed");
  expect(payload).not.toHaveProperty("expected");
  expect(JSON.stringify(secret.events)).not.toContain("canary-secret");
});
it("refuses an untrusted self-signed HTTPS target before any request and accepts the same target through a pinned CA", async () => {
  const directory = await mkdtemp(join(tmpdir(), "tm-http-tls-"));
  let hits = 0;
  const secure = createTlsServer({}, (_req, res) => {
    hits++;
    res.end("ok");
  });
  try {
    await promisify(execFile)("openssl", [
      "req",
      "-x509",
      "-newkey",
      "rsa:2048",
      "-nodes",
      "-keyout",
      join(directory, "key.pem"),
      "-out",
      join(directory, "cert.pem"),
      "-days",
      "1",
      "-subj",
      "/CN=127.0.0.1",
      "-addext",
      "subjectAltName=IP:127.0.0.1",
    ]);
    const cert = await readFile(join(directory, "cert.pem"));
    secure.setSecureContext({ key: await readFile(join(directory, "key.pem")), cert });
    await new Promise<void>((resolve) => secure.listen(0, "127.0.0.1", resolve));
    const address = secure.address();
    if (!address || typeof address === "string") throw new Error("Missing TLS fixture address");
    const base = `https://127.0.0.1:${address.port}`;
    // The default dispatcher verifies certificates against the system trust store only.
    const untrusted = fixture(base);
    await expect(untrusted.engine.perform(requestStep("health", []))).rejects.toMatchObject({
      reasonCode: "insufficient_evidence",
    });
    expect(hits).toBe(0);
    const pinned = new Agent({ connect: { ca: cert } });
    agents.push(pinned);
    const trusted = fixture(base);
    const engine = new HttpEngine(trusted.runtime, { dispatcher: pinned });
    engines.push(engine);
    await engine.perform(requestStep("health", []));
    expect(responseOf(engine, "health").status).toBe(200);
    expect(hits).toBe(1);
  } finally {
    secure.closeAllConnections();
    if (secure.listening) await new Promise<void>((resolve) => secure.close(() => resolve()));
    await rm(directory, { recursive: true, force: true });
  }
});
it("refuses storage-state input as unsupported before any HTTP request", async () => {
  let hits = 0;
  const base = await serve((_req, res) => {
    hits++;
    res.end("ok");
  });
  const { runtime } = fixture(base, { plan: plan([requestStep("health", [])]) });
  Object.assign(runtime.input, { storageState: { cookies: [], origins: [] } });
  vi.stubEnv("TESTMASTER_EGRESS_PROXY", base);
  expect(await runHttp(runtime)).toMatchObject({
    outcome: "blocked",
    reasonCode: "unsupported_capability",
  });
  expect(hits).toBe(0);
});

const OPENAPI_MODELS = {
  components: {
    schemas: {
      Models: {
        type: "object",
        required: ["data"],
        // OpenAPI annotations that Ajv strict mode does not know.
        example: { data: [{ id: "gpt-5" }] },
        xml: { name: "models" },
        externalDocs: { url: "https://docs.example.test/models" },
        "x-internal": true,
        properties: {
          data: {
            type: "array",
            items: {
              type: "object",
              required: ["id"],
              properties: {
                id: { type: "string", example: "gpt-5" },
                owned_by: { type: "string", nullable: true, "x-vendor": { note: 1 } },
              },
            },
          },
        },
      },
    },
  },
};
function schemaCheck(pointer = "/components/schemas/Models"): PlanStep {
  return {
    id: "check",
    kind: "assertion",
    operation: "assert",
    description: "Response matches the source schema",
    input: { responseStepId: "read" },
    expectation: { predicate: "jsonSchema", sourceRevisionId: SOURCE, pointer },
  };
}
it("validates a response against an OpenAPI schema that carries example and vendor annotations", async () => {
  const base = await serve((_req, res) =>
    res.end('{"data":[{"id":"gpt-5","owned_by":null},{"id":"o3"}]}'),
  );
  const f = fixture(base, { schemas: { [SOURCE]: OPENAPI_MODELS } });
  expect(
    await f.runtime.runSteps([requestStep("read", []), schemaCheck()], (step) =>
      f.engine.perform(step),
    ),
  ).toMatchObject({ outcome: "passed" });
});
it("fails a non-conforming response with bounded violations, an excerpt and a schema reference", async () => {
  const base = await serve((_req, res) =>
    res.end('{"data":[{"id":7,"extra":"x"},{"owned_by":"o"}]}'),
  );
  const f = fixture(base, { schemas: { [SOURCE]: OPENAPI_MODELS } });
  expect(
    await f.runtime.runSteps([requestStep("read", []), schemaCheck()], (step) =>
      f.engine.perform(step),
    ),
  ).toMatchObject({ outcome: "failed", reasonCode: "assertion_mismatch" });
  const payload = f.events.find(
    (event) => event.type === "step.finished" && event.payload.stepId === "check",
  )!.payload as {
    error: { message: string };
    observed: {
      violations: { path: string; keyword: string; message: string; property?: string }[];
      omittedViolations: number;
      excerpt: unknown;
    };
    expected: unknown;
  };
  expect(payload.error.message).toMatch(
    /^Response does not match source schema: 2 violations; first at \/data\/0\/id: must be string/u,
  );
  expect(payload.observed.violations).toEqual([
    { path: "/data/0/id", keyword: "type", message: "must be string" },
    {
      path: "/data/1",
      keyword: "required",
      message: "must have required property 'id'",
      property: "id",
    },
  ]);
  expect(payload.observed.omittedViolations).toBe(0);
  expect(payload.observed.excerpt).toEqual({
    data: [{ id: 7, extra: "x" }, { owned_by: "o" }],
  });
  expect(payload.expected).toEqual({
    sourceRevisionId: SOURCE,
    pointer: "/components/schemas/Models",
  });
});
it("caps violations and degrades the schema observation instead of dropping it", async () => {
  const rows = Array.from({ length: 30 }, () => ({ id: 1 }));
  const base = await serve((_req, res) => res.end(JSON.stringify({ data: rows })));
  const f = fixture(base, { schemas: { [SOURCE]: OPENAPI_MODELS } });
  f.runtime.secrets.add("gpt-secret");
  await f.runtime.runSteps([requestStep("read", []), schemaCheck()], (step) =>
    f.engine.perform(step),
  );
  const payload = f.events.find(
    (event) => event.type === "step.finished" && event.payload.stepId === "check",
  )!.payload as { observed: { violations: unknown[]; omittedViolations: number } };
  expect(payload.observed.violations).toHaveLength(20);
  expect(payload.observed.omittedViolations).toBe(10);
  // A secret inside the rejected value removes the excerpt but keeps the violations.
  const secretBase = await serve((_req, res) =>
    res.end('{"data":[{"id":"ok"},{"id":"gpt-secret-9"},{}]}'),
  );
  const g = fixture(secretBase, { schemas: { [SOURCE]: OPENAPI_MODELS } });
  g.runtime.secrets.add("gpt-secret-9");
  await g.runtime.runSteps([requestStep("read", []), schemaCheck()], (step) =>
    g.engine.perform(step),
  );
  const secret = g.events.find(
    (event) => event.type === "step.finished" && event.payload.stepId === "check",
  )!.payload as { observed: { violations: unknown[]; excerpt?: unknown } };
  expect(secret.observed.violations).toHaveLength(1);
  expect(secret.observed).not.toHaveProperty("excerpt");
  expect(JSON.stringify(g.events)).not.toContain("gpt-secret-9");
});
it("reports a schema that cannot be compiled as inconclusive, not as an assertion failure", async () => {
  const base = await serve((_req, res) => res.end('{"data":[]}'));
  const f = fixture(base, {
    schemas: {
      [SOURCE]: {
        components: {
          schemas: { Broken: { type: "object", properties: { a: { $ref: "#/$defs/Missing" } } } },
        },
      },
    },
  });
  expect(
    await f.runtime.runSteps(
      [requestStep("read", []), schemaCheck("/components/schemas/Broken")],
      (step) => f.engine.perform(step),
    ),
  ).toMatchObject({ outcome: "inconclusive", reasonCode: "oracle_uncertain" });
  const payload = f.events.find(
    (event) => event.type === "step.finished" && event.payload.stepId === "check",
  )!.payload as { status: string; error: { message: string } };
  expect(payload.status).toBe("inconclusive");
  expect(payload.error.message).toMatch(/^Source schema .*Broken cannot be used for validation: /u);
  expect(payload.error.message).toContain("Missing");
});
it("judges a value against an inline jsonConforms schema and records its violations", async () => {
  const conforms = (jsonPointer?: string): PlanStep => ({
    id: "check",
    kind: "assertion",
    operation: "assert",
    description: "The manifest version is an integer of at least 1",
    input: { responseStepId: "read", ...(jsonPointer ? { jsonPointer } : {}) },
    expectation: {
      predicate: "jsonConforms",
      schema: { type: "integer", minimum: 1 },
    },
  });
  const run = async (body: string, jsonPointer?: string) => {
    const f = fixture(await serve((_req, res) => res.end(body)));
    const result = await f.runtime.runSteps(
      [requestStep("read", []), conforms(jsonPointer)],
      (step) => f.engine.perform(step),
    );
    const payload = f.events.find(
      (event) => event.type === "step.finished" && event.payload.stepId === "check",
    )!.payload as {
      error?: { message: string };
      observed: unknown;
      expected: unknown;
    };
    return { result, payload };
  };
  const passed = await run('{"manifest_version":1,"ui":{}}', "/manifest_version");
  expect(passed.result).toMatchObject({ outcome: "passed" });
  expect(passed.payload.expected).toEqual({ type: "integer", minimum: 1 });
  const failed = await run('{"manifest_version":0}', "/manifest_version");
  expect(failed.result).toMatchObject({ outcome: "failed", reasonCode: "assertion_mismatch" });
  expect(failed.payload.error?.message).toBe(
    "Response does not match inline schema: 1 violation; first at /: must be >= 1",
  );
  expect(failed.payload.observed).toMatchObject({
    violations: [{ path: "", keyword: "minimum", message: "must be >= 1" }],
  });
  const absent = await run('{"ui":{}}', "/manifest_version");
  expect(absent.result).toMatchObject({ outcome: "failed", reasonCode: "assertion_mismatch" });
  expect(absent.payload.error?.message).toMatch(
    /^Response does not match inline schema; missing JSON pointer: /u,
  );
});
it("keeps a bounded excerpt of an oversized value when a JSON assertion fails", async () => {
  const items = Array.from({ length: 400 }, (_, index) => ({ id: `item-${index}`, price: index }));
  const base = await serve((_req, res) => res.end(JSON.stringify({ items })));
  const f = fixture(base);
  const check: PlanStep = {
    id: "check",
    kind: "assertion",
    operation: "assert",
    description: "Items equal the expectation",
    input: { responseStepId: "read", jsonPointer: "/items" },
    expectation: { predicate: "jsonEquals", value: { literal: [] } },
  };
  expect(
    await f.runtime.runSteps([requestStep("read", []), check], (step) => f.engine.perform(step)),
  ).toMatchObject({ outcome: "failed", reasonCode: "assertion_mismatch" });
  const payload = f.events.find(
    (event) => event.type === "step.finished" && event.payload.stepId === "check",
  )!.payload as {
    observed: { truncated: boolean; sizeBytes: number; excerpt: unknown[] };
    expected: unknown;
  };
  expect(payload.observed.truncated).toBe(true);
  expect(payload.observed.sizeBytes).toBeGreaterThan(8192);
  expect(payload.observed.excerpt).toEqual([
    { id: "item-0", price: 0 },
    { id: "item-1", price: 1 },
    { id: "item-2", price: 2 },
    "...(397 more items)",
  ]);
  expect(payload.expected).toEqual([]);
});

function assertStep(id: string, responseStepId: string, expectation: Expectation): PlanStep {
  return {
    id,
    kind: "assertion",
    operation: "assert",
    description: id,
    input: { responseStepId },
    expectation,
  };
}
function evidenceOf(artifacts: Map<string, Uint8Array>, stepId: string) {
  const bytes = artifacts.get(`http/${stepId}.json`);
  if (!bytes) throw new Error(`Missing evidence: http/${stepId}.json`);
  return JSON.parse(new TextDecoder().decode(bytes)) as {
    redirects: { url: string; status: number; location: string }[];
    response: { status: number; url: string; headers: Record<string, string> };
  };
}
function stepPayload(events: RunnerEvent[], stepId: string) {
  return events.find((event) => event.type === "step.finished" && event.payload.stepId === stepId)!
    .payload as { status: string; observed?: unknown; expected?: unknown };
}

it("returns the 3xx response itself with redirect manual and records the chain of a followed redirect", async () => {
  const base = await serve((req, res) => {
    if (req.url === "/dashboard") {
      res.writeHead(307, { location: "/login" });
      res.end();
    } else if (req.url === "/old") {
      res.writeHead(301, { location: "/dashboard" });
      res.end();
    } else res.end("login page");
  });
  const f = fixture(base);
  await f.engine.perform(requestStep("manual", ["dashboard"], { redirect: "manual" }));
  const manual = responseOf(f.engine, "manual");
  expect(manual).toMatchObject({ status: 307, headers: { location: "/login" }, redirects: [] });
  await assertResponse(f.runtime, manual, { predicate: "statusIn", values: [307] });
  await assertResponse(f.runtime, manual, {
    predicate: "headerEquals",
    header: "Location",
    value: { literal: "/login" },
  });
  expect(evidenceOf(f.artifacts, "manual")).toMatchObject({
    redirects: [],
    response: { status: 307, url: `${base}/dashboard`, headers: { location: "/login" } },
  });
  // Default: the same request follows the redirect and the chain is evidence.
  await f.engine.perform(requestStep("followed", ["old"]));
  const followed = responseOf(f.engine, "followed");
  const hops = [
    { url: `${base}/old`, status: 301, location: "/dashboard" },
    { url: `${base}/dashboard`, status: 307, location: "/login" },
  ];
  expect(followed).toMatchObject({ status: 200, url: `${base}/login`, redirects: hops });
  expect(evidenceOf(f.artifacts, "followed")).toMatchObject({
    redirects: hops,
    response: { status: 200, url: `${base}/login` },
  });
  // An explicit "follow" behaves like the default.
  await f.engine.perform(requestStep("explicit", ["old"], { redirect: "follow" }));
  expect(responseOf(f.engine, "explicit").redirects).toEqual(hops);
});

it("applies redirect manual to cleanup requests like to any other request", async () => {
  const base = await serve((req, res) => {
    if (req.method === "POST") {
      res.statusCode = 201;
      res.end(JSON.stringify({ id: "item", owner: "proof" }));
    } else if (req.method === "DELETE") {
      res.writeHead(303, { location: "/list" });
      res.end();
    } else res.end("list");
  });
  const create = requestStep("create", ["item"], {
    method: "POST",
    resource: {
      resourceType: "fixture",
      correlationKey: { literal: "item-correlation" },
      handle: "/id",
      ownerProof: "/owner",
    },
  });
  const cleanup = (redirect: "follow" | "manual"): ExecutablePlan["cleanup"] => [
    {
      resourceRef: "create",
      operation: "request",
      input: { method: "DELETE", pathSegments: [{ variableRef: "create.handle" }], redirect },
      successPredicate: { predicate: "statusIn", values: [303] },
      deadlineMs: 1000,
      required: true,
    },
  ];
  const manual = fixture(base, { plan: plan([create], cleanup("manual")) });
  await manual.engine.perform(create);
  expect(
    await manual.engine.cleanup({ outcome: "passed", reasonCode: "assertions_satisfied" }),
  ).toMatchObject({ cleanupOutcome: "passed" });
  const followed = fixture(base, { plan: plan([create], cleanup("follow")) });
  await followed.engine.perform(create);
  expect(
    await followed.engine.cleanup({ outcome: "passed", reasonCode: "assertions_satisfied" }),
  ).toMatchObject({ cleanupOutcome: "failed" });
});

it("sends a text body verbatim under any explicit media type and still refuses a mismatched json body", async () => {
  const base = await serve((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk) => chunks.push(chunk));
    req.on("end", () =>
      res.end(
        JSON.stringify({
          contentType: req.headers["content-type"],
          body: Buffer.concat(chunks).toString(),
        }),
      ),
    );
  });
  const f = fixture(base);
  for (const [id, contentType, body] of [
    ["malformed", "application/json", '{"a":'],
    ["custom", "application/vnd.api+json; charset=utf-8", "not json at all"],
    ["xml", "application/xml", "<a>"],
  ] as const) {
    await f.engine.perform(
      requestStep(id, [], {
        method: "POST",
        headers: { "Content-Type": { literal: contentType } },
        body: { kind: "text", value: { literal: body } },
      }),
    );
    await assertResponse(f.runtime, responseOf(f.engine, id), {
      predicate: "jsonEquals",
      value: { literal: { contentType, body } },
    });
  }
  await f.engine.perform(
    requestStep("default", [], {
      method: "POST",
      body: { kind: "text", value: { literal: "plain" } },
    }),
  );
  await assertResponse(
    f.runtime,
    responseOf(f.engine, "default"),
    { predicate: "jsonEquals", value: { literal: "text/plain" } },
    "/contentType",
  );
  // The serialization of json, form and artifact bodies defines their type.
  await expect(
    f.engine.perform(
      requestStep("mismatch", [], {
        method: "POST",
        headers: { "Content-Type": { literal: "text/plain" } },
        body: { kind: "json", value: { literal: { a: 1 } } },
      }),
    ),
  ).rejects.toMatchObject({ reasonCode: "security_precondition_failed" });
});

it("evaluates cookieAbsent over every response of the step, redirect hops included, without recording cookie values", async () => {
  const base = await serve((req, res) => {
    if (req.url === "/start") {
      res.writeHead(302, {
        location: "/end",
        "set-cookie": ["sid=hop-secret-value; Path=/; HttpOnly", "theme=dark"],
      });
      res.end();
    } else {
      res.setHeader("set-cookie", "last=1");
      res.end("done");
    }
  });
  const f = fixture(base);
  expect(
    await f.runtime.runSteps(
      [
        requestStep("go", ["start"]),
        assertStep("other", "go", { predicate: "cookieAbsent", name: "other" }),
        assertStep("hop", "go", { predicate: "cookieAbsent", name: "sid" }),
      ],
      (step) => f.engine.perform(step),
    ),
  ).toMatchObject({ outcome: "failed", reasonCode: "assertion_mismatch" });
  expect(responseOf(f.engine, "go").cookieNames).toEqual(["sid", "theme", "last"]);
  expect(stepPayload(f.events, "other").status).toBe("passed");
  expect(stepPayload(f.events, "hop")).toMatchObject({
    status: "failed",
    observed: ["sid", "theme", "last"],
    expected: { absent: "sid" },
  });
  const recorded =
    JSON.stringify(f.events) + new TextDecoder().decode(f.artifacts.get("http/go.json"));
  expect(recorded).not.toContain("hop-secret-value");
  // Without following, only the first response counts.
  await f.engine.perform(requestStep("first", ["start"], { redirect: "manual" }));
  const first = responseOf(f.engine, "first");
  expect(first.cookieNames).toEqual(["sid", "theme"]);
  await assertResponse(f.runtime, first, { predicate: "cookieAbsent", name: "last" });
  await expect(
    assertResponse(f.runtime, first, { predicate: "cookieAbsent", name: "theme" }),
  ).rejects.toMatchObject({ reasonCode: "assertion_mismatch", outcome: "failed" });
});

it("cookieAbsent passes when a response clears the cookie instead of setting it", async () => {
  const base = await serve((_req, res) => {
    res.setHeader("set-cookie", [
      // Anonymous redirect clearing a stale session, as OmniRoute's /dashboard does.
      "auth_token=; Path=/; Expires=Thu, 01 Jan 1970 00:00:00 GMT",
      "sid=x; Max-Age=0",
      // Max-Age wins over Expires (RFC 6265 §5.3): this one is set despite the past date.
      "keep=1; Expires=Thu, 01 Jan 1970 00:00:00 GMT; Max-Age=60",
      "late=1; Max-Age=60; Max-Age=-1",
    ]);
    res.writeHead(307, { location: "/login" });
    res.end();
  });
  const f = fixture(base);
  await f.engine.perform(requestStep("anon", ["dashboard"], { redirect: "manual" }));
  const response = responseOf(f.engine, "anon");
  expect(response.cookieNames).toEqual(["keep"]);
  await assertResponse(f.runtime, response, { predicate: "cookieAbsent", name: "auth_token" });
  await assertResponse(f.runtime, response, { predicate: "cookieAbsent", name: "sid" });
  await assertResponse(f.runtime, response, { predicate: "cookieAbsent", name: "late" });
  await expect(
    assertResponse(f.runtime, response, { predicate: "cookieAbsent", name: "keep" }),
  ).rejects.toMatchObject({ reasonCode: "assertion_mismatch", outcome: "failed" });
});

it("textEquals and textContains judge the whole response body as UTF-8 text", async () => {
  let body: string | Uint8Array = "\uFEFFUser-agent: *\nDisallow: /stats\n";
  const base = await serve((_req, res) => {
    res.setHeader("content-type", "text/plain; charset=utf-8");
    res.end(body);
  });
  const text = (predicate: "textEquals" | "textContains", literal: string): PlanStep => ({
    id: "text",
    kind: "assertion",
    operation: "assert",
    description: "Body text",
    input: { responseStepId: "robots" },
    expectation: { predicate, value: { literal } },
  });
  const judge = async (check: PlanStep) => {
    const f = fixture(base);
    const result = await f.runtime.runSteps(
      [requestStep("robots", ["robots.txt"]), check],
      (step) => f.engine.perform(step),
    );
    const finished = f.events.find(
      (event) => event.type === "step.finished" && event.payload.stepId === "text",
    )?.payload;
    return { result, finished };
  };
  // The BOM is not part of the text, and the comparison is exact.
  expect(
    (await judge(text("textEquals", "User-agent: *\nDisallow: /stats\n"))).result,
  ).toMatchObject({ outcome: "passed" });
  expect((await judge(text("textContains", "Disallow: /stats"))).result).toMatchObject({
    outcome: "passed",
  });
  const missing = await judge(text("textContains", "Disallow: /preferences"));
  expect(missing.result).toMatchObject({ outcome: "failed", reasonCode: "assertion_mismatch" });
  expect(missing.finished).toMatchObject({
    observed: "User-agent: *\nDisallow: /stats\n",
    expected: "Disallow: /preferences",
  });
  expect((await judge(text("textEquals", "User-agent: *"))).result).toMatchObject({
    outcome: "failed",
    reasonCode: "assertion_mismatch",
  });
  // Bytes that are not UTF-8 are not text: the assertion fails instead of comparing mojibake.
  body = Uint8Array.from([0x44, 0x69, 0xff, 0x0a]);
  const binary = await judge(text("textContains", "Di"));
  expect(binary.result).toMatchObject({ outcome: "failed", reasonCode: "assertion_mismatch" });
});

it("xmlPath counts the selected nodes and reads the first one's text, and fails on a miss or on a body that is not XML", async () => {
  let body =
    '<?xml version="1.0"?><rss><channel><title>q</title><item><title>a &amp; b</title></item><item/><item/><item/></channel></rss>';
  const base = await serve((_req, res) => {
    res.setHeader("content-type", "application/rss+xml; charset=utf-8");
    res.end(body);
  });
  const check = (xmlPath: string, expectation: PlanStep["expectation"]): PlanStep =>
    ({
      id: "xml",
      kind: "assertion",
      operation: "assert",
      description: "Feed",
      input: { responseStepId: "feed", xmlPath },
      expectation,
    }) as PlanStep;
  const judge = async (step: PlanStep) => {
    const f = fixture(base);
    const result = await f.runtime.runSteps([requestStep("feed", ["rss"]), step], (current) =>
      f.engine.perform(current),
    );
    const finished = f.events.find(
      (event) => event.type === "step.finished" && event.payload.stepId === "xml",
    )?.payload;
    return { result, finished };
  };
  const count = (value: number) => ({ predicate: "countEquals", value }) as const;
  expect((await judge(check("/rss/channel/item", count(4)))).result).toMatchObject({
    outcome: "passed",
  });
  const five = await judge(check("/rss/channel/item", count(5)));
  expect(five.result).toMatchObject({ outcome: "failed", reasonCode: "assertion_mismatch" });
  expect(five.finished).toMatchObject({ observed: 4, expected: 5 });
  expect(
    (await judge(check("//item/title", { predicate: "textEquals", value: { literal: "a & b" } })))
      .result,
  ).toMatchObject({ outcome: "passed" });
  const missing = await judge(
    check("/rss/channel/link", { predicate: "textContains", value: { literal: "x" } }),
  );
  expect(missing.result).toMatchObject({ outcome: "failed", reasonCode: "assertion_mismatch" });
  expect(missing.finished).toMatchObject({
    error: { message: expect.stringContaining("the path selects no node") },
  });
  body = '{"items": [1, 2, 3, 4]}';
  const json = await judge(check("/rss/channel/item", count(4)));
  expect(json.result).toMatchObject({ outcome: "failed", reasonCode: "assertion_mismatch" });
  expect(json.finished).toMatchObject({
    error: { message: expect.stringContaining("the response body is not XML") },
  });
});

it("evaluates headerMatches as an unanchored pattern and never lets a bad pattern crash the runner", async () => {
  const base = await serve((_req, res) => {
    res.setHeader("X-Request-Id", "req-12345");
    res.end("ok");
  });
  const f = fixture(base);
  await f.engine.perform(requestStep("read", []));
  const response = responseOf(f.engine, "read");
  for (const pattern of ["^req-\\d+$", "12345", "^req"])
    await assertResponse(f.runtime, response, {
      predicate: "headerMatches",
      header: "X-REQUEST-ID",
      pattern,
    });
  await expect(
    assertResponse(f.runtime, response, {
      predicate: "headerMatches",
      header: "x-request-id",
      pattern: "^id-",
    }),
  ).rejects.toMatchObject({ reasonCode: "assertion_mismatch", outcome: "failed" });
  // An absent header never matches, not even a pattern the empty string satisfies.
  await expect(
    assertResponse(f.runtime, response, {
      predicate: "headerMatches",
      header: "x-missing",
      pattern: ".*",
    }),
  ).rejects.toMatchObject({ reasonCode: "assertion_mismatch", outcome: "failed" });
  await expect(
    assertResponse(f.runtime, response, {
      predicate: "headerMatches",
      header: "x-request-id",
      pattern: "(",
    }),
  ).rejects.toMatchObject({ reasonCode: "oracle_uncertain", outcome: "inconclusive" });
  expect(
    await f.runtime.runSteps(
      [
        requestStep("again", []),
        assertStep("shape", "again", {
          predicate: "headerMatches",
          header: "x-request-id",
          pattern: "^id-",
        }),
      ],
      (step) => f.engine.perform(step),
    ),
  ).toMatchObject({ outcome: "failed" });
  expect(stepPayload(f.events, "shape")).toMatchObject({
    observed: "req-12345",
    expected: { matches: "^id-" },
  });
});

it("asserts on a credential header against its real value but records only cookie names, never the value", async () => {
  const session = "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJyb290In0.c2lnbmF0dXJl";
  const base = await serve((_req, res) => {
    res.setHeader("set-cookie", `ap_session=${session}; Path=/; HttpOnly`);
    res.setHeader("content-type", "application/json");
    // The session value also comes back in the body, under a key no default redaction pattern knows.
    res.end(JSON.stringify({ session }));
  });
  const f = fixture(base, { policy: { httpBodies: true, restrictedRaw: true } });
  const matches: Expectation = {
    predicate: "headerMatches",
    header: "Set-Cookie",
    pattern: "^ap_session=",
  };
  const mismatch: Expectation = {
    predicate: "headerMatches",
    header: "set-cookie",
    pattern: "^other=",
  };
  expect(
    await f.runtime.runSteps(
      [
        requestStep("login", [], { redirect: "manual" }),
        assertStep("cookie_set", "login", matches),
        assertStep("cookie_other", "login", mismatch),
      ],
      (step) => f.engine.perform(step),
    ),
  ).toMatchObject({ outcome: "failed", reasonCode: "assertion_mismatch" });
  // The assertion still evaluates the real header value: the pattern that fits passes, the other fails.
  expect(stepPayload(f.events, "cookie_set")).toMatchObject({
    status: "passed",
    observed: {
      header: "set-cookie",
      present: true,
      cookies: [{ name: "ap_session", value: "[REDACTED]" }],
      matches: true,
    },
    expected: { matches: "^ap_session=" },
  });
  expect(stepPayload(f.events, "cookie_other")).toMatchObject({
    status: "failed",
    observed: { present: true, matches: false },
  });
  const recorded =
    JSON.stringify(f.events) +
    [...f.artifacts.values()].map((bytes) => new TextDecoder().decode(bytes)).join("");
  expect(recorded).not.toContain(session);
  // The issued value joined the scrub set, so the body evidence is redacted too.
  expect(new TextDecoder().decode(f.artifacts.get("http/login-bodies.json"))).toContain(
    "[REDACTED]",
  );
  const equals = await f.runtime.runSteps(
    [
      requestStep("again", [], { redirect: "manual" }),
      assertStep("cookie_equals", "again", {
        predicate: "headerEquals",
        header: "set-cookie",
        value: { literal: "ap_session=nope" },
      }),
    ],
    (step) => f.engine.perform(step),
  );
  expect(equals).toMatchObject({ outcome: "failed" });
  expect(stepPayload(f.events, "cookie_equals")).toMatchObject({
    status: "failed",
    observed: { header: "set-cookie", present: true, matches: false },
    expected: { value: "[REDACTED]" },
  });
});

it("writes a plan step id whole into an artifact's stepId field although a secret value occurs inside it", async () => {
  const base = await serve((_req, res) => res.end("ok"));
  const f = fixture(base, { plan: plan([requestStep("assert_root_url", [])]) });
  f.runtime.secrets.add("root");
  await f.runtime.artifact(
    "browser/steps/assert_root_url-locator-0-before.json",
    "locator-evidence",
    "application/json",
    Buffer.from(JSON.stringify({ stepId: "assert_root_url", text: "signed in as root" })),
  );
  expect(
    new TextDecoder().decode(
      f.artifacts.get("browser/steps/assert_root_url-locator-0-before.json"),
    ),
  ).toBe('{"stepId":"assert_root_url","text":"signed in as [REDACTED]"}');
});

it("records the variable references of a step whose id contains a secret value exactly as the plan writes them", async () => {
  const base = await serve((_req, res) => res.end('{"session":"opaque-value"}'));
  const login = requestStep("login_root", [], {
    capture: [
      {
        name: "session",
        from: "jsonPointer",
        pointer: "/session",
        valueType: "string",
        sensitive: false,
      },
    ],
  });
  const consume = requestStep("use_session", [], {
    headers: { "x-session": { variableRef: "login_root.session" } },
  });
  const f = fixture(base, { plan: plan([login, consume]) });
  f.runtime.secrets.add("root");
  await f.engine.perform(login);
  await f.engine.perform(consume);
  const record = (path: string) =>
    JSON.parse(new TextDecoder().decode(f.artifacts.get(path))) as {
      captures: { variableRef: string }[];
      request: { bindings: { variableRef: string }[] };
    };
  expect(record("http/login_root.json").captures[0]?.variableRef).toBe("login_root.session");
  expect(record("http/use_session.json").request.bindings[0]?.variableRef).toBe(
    "login_root.session",
  );
});

it("sends a fresh invalid credential per request without turning a rejection into a credential failure", async () => {
  const seen: string[] = [];
  const base = await serve((req, res) => {
    seen.push(String(req.headers.authorization ?? req.headers["x-api-key"]));
    res.statusCode = 401;
    res.end("{}");
  });
  const f = fixture(base);
  const bearer = { Authorization: { invalidCredential: { scheme: "Bearer" } } };
  await f.engine.perform(requestStep("a", [], { headers: bearer }));
  await f.engine.perform(requestStep("b", [], { headers: bearer }));
  await f.engine.perform(
    requestStep("c", [], { headers: { "X-Api-Key": { invalidCredential: {} } } }),
  );
  await fixture(base).engine.perform(requestStep("d", [], { headers: bearer }));
  expect(seen[0]).toMatch(/^Bearer testmaster-invalid-[0-9a-f]{32}$/u);
  expect(seen[1]).toMatch(/^Bearer testmaster-invalid-[0-9a-f]{32}$/u);
  expect(seen[2]).toMatch(/^testmaster-invalid-[0-9a-f]{32}$/u);
  expect(new Set([seen[0], seen[1], seen[3]]).size).toBe(3);
  // A 401 for a credential the plan made up is the expected answer, not a rejected static credential.
  await expect(
    assertResponse(f.runtime, responseOf(f.engine, "a"), { predicate: "statusIn", values: [200] }),
  ).rejects.toMatchObject({ reasonCode: "assertion_mismatch" });
  const real = fixture(base, {
    variables: { auth: { value: "Bearer real-canary", sensitive: true } },
  });
  await real.engine.perform(
    requestStep("real", [], { headers: { Authorization: { variableRef: "auth" } } }),
  );
  await expect(
    assertResponse(real.runtime, responseOf(real.engine, "real"), {
      predicate: "statusIn",
      values: [200],
    }),
  ).rejects.toMatchObject({ reasonCode: "manual_auth_required" });
  // Real credentials still come only from references; the fake form only fits credential headers.
  const sent = seen.length;
  await expect(
    f.engine.perform(
      requestStep("literal", [], { headers: { Authorization: { literal: "Bearer real" } } }),
    ),
  ).rejects.toMatchObject({ reasonCode: "security_precondition_failed" });
  await expect(
    f.engine.perform(
      requestStep("misplaced", [], { headers: { "X-Test": { invalidCredential: {} } } }),
    ),
  ).rejects.toMatchObject({ reasonCode: "security_precondition_failed" });
  expect(seen).toHaveLength(sent);
});

it("sends a forged session cookie as name=random, records that a forged credential was sent and refuses misplaced forms", async () => {
  const seen: string[] = [];
  const base = await serve((req, res) => {
    seen.push(String(req.headers.cookie));
    res.statusCode = 401;
    res.end("{}");
  });
  const f = fixture(base);
  const forged = { Cookie: { invalidCredential: { cookie: "ap_session" } } };
  await f.engine.perform(requestStep("a", [], { headers: forged }));
  await f.engine.perform(requestStep("b", [], { headers: forged }));
  expect(seen[0]).toMatch(/^ap_session=testmaster-invalid-[0-9a-f]{32}$/u);
  expect(seen[1]).toMatch(/^ap_session=testmaster-invalid-[0-9a-f]{32}$/u);
  expect(seen[0]).not.toBe(seen[1]);
  const evidence = JSON.parse(new TextDecoder().decode(f.artifacts.get("http/a.json"))) as {
    request: { invalidCredentials: unknown[] };
  };
  expect(evidence.request.invalidCredentials).toEqual([{ header: "cookie", cookie: "ap_session" }]);
  expect(JSON.stringify(evidence)).not.toContain("testmaster-invalid-");
  // A rejection of a credential the plan made up is the expected answer, not a credential failure.
  await expect(
    assertResponse(f.runtime, responseOf(f.engine, "a"), { predicate: "statusIn", values: [200] }),
  ).rejects.toMatchObject({ reasonCode: "assertion_mismatch" });
  const sent = seen.length;
  for (const headers of [
    { Cookie: { invalidCredential: { scheme: "Bearer" } } },
    { Cookie: { invalidCredential: {} } },
    { Authorization: { invalidCredential: { cookie: "ap_session" } } },
    { Cookie: { invalidCredential: { cookie: "ap_session", scheme: "Bearer" } } },
    { Cookie: { invalidCredential: { cookie: "bad name" } } },
  ])
    await expect(f.engine.perform(requestStep("misplaced", [], { headers }))).rejects.toMatchObject(
      { reasonCode: "security_precondition_failed" },
    );
  expect(seen).toHaveLength(sent);
});

const SECRET_REF = "sec_01900000-0000-7000-8000-000000000001";
const STATE_REF = "sec_01900000-0000-7000-8000-000000000002";
const TOKEN_REF = "sec_01900000-0000-7000-8000-000000000003";

async function sentBodies(): Promise<{ base: string; bodies: unknown[] }> {
  const bodies: unknown[] = [];
  const base = await serve((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk) => chunks.push(chunk));
    req.on("end", () => {
      bodies.push(JSON.parse(Buffer.concat(chunks).toString()));
      res.end("{}");
    });
  });
  return { base, bodies };
}
function jsonRequest(
  document: unknown,
  set: { pointer: string; value: { literal: unknown } | { secretRef: string } }[],
): PlanStep {
  return requestStep("send", ["login"], {
    method: "POST",
    body: { kind: "json", value: { literal: document }, set },
  });
}

it("places JSON body set values by pointer, scrubs a placed secret and never mutates the plan literal", async () => {
  const { base, bodies } = await sentBodies();
  const { engine, artifacts, runtime } = fixture(
    base,
    { secrets: [{ secretRef: SECRET_REF, secretVersion: 1 }] },
    { [SECRET_REF]: "placed-canary-secret" },
  );
  const document = { username: "root", password: null, list: [0, 1], "a/b": { "c~d": 0 } };
  const step = jsonRequest(document, [
    { pointer: "/password", value: { secretRef: SECRET_REF } },
    { pointer: "/list/1", value: { literal: "second" } },
    { pointer: "/a~1b/c~0d", value: { literal: 7 } },
    { pointer: "/added", value: { literal: true } },
  ]);
  await engine.perform(step);
  await engine.perform(step);
  const expected = {
    username: "root",
    password: "placed-canary-secret",
    list: [0, "second"],
    "a/b": { "c~d": 7 },
    added: true,
  };
  expect(bodies).toEqual([expected, expected]);
  expect(document).toEqual({ username: "root", password: null, list: [0, 1], "a/b": { "c~d": 0 } });
  expect(runtime.scrub("password=placed-canary-secret")).not.toContain("placed-canary-secret");
  for (const bytes of artifacts.values())
    expect(Buffer.from(bytes).toString()).not.toContain("placed-canary-secret");
});

it("refuses a JSON body set entry that has no parent, no array item or no pointer before sending", async () => {
  const { base, bodies } = await sentBodies();
  const { engine } = fixture(base);
  const document = { name: "n", list: [1], nested: { leaf: 1 } };
  for (const pointer of ["", "/missing/child", "/list/5", "/list/-", "/name/x"])
    await expect(
      engine.perform(jsonRequest(document, [{ pointer, value: { literal: 1 } }])),
    ).rejects.toMatchObject({ reasonCode: "security_precondition_failed", outcome: "blocked" });
  expect(bodies).toEqual([]);
  // A member of an existing object is created, so only absent parents are refused.
  await engine.perform(
    jsonRequest(document, [{ pointer: "/nested/added", value: { literal: 2 } }]),
  );
  expect(bodies).toEqual([{ name: "n", list: [1], nested: { leaf: 1, added: 2 } }]);
});

it("does not mark a capture sensitive because the request carried a credential", async () => {
  const base = await serve((_req, res) =>
    res.end(JSON.stringify({ items: ["a", "id", "ok"], flag: true, none: null, name: "x" })),
  );
  const { engine, runtime, artifacts } = fixture(base, {
    variables: { auth: { value: "Bearer request-canary", sensitive: true } },
  });
  const capture = (
    name: string,
    pointer: string,
    valueType: "array" | "boolean" | "null" | "string",
  ) => ({ name, from: "jsonPointer", pointer, valueType, sensitive: false }) as const;
  await engine.perform(
    requestStep("list-step", [], {
      headers: { Authorization: { variableRef: "auth" } },
      capture: [
        capture("list", "/items", "array"),
        capture("flag", "/flag", "boolean"),
        capture("empty", "/none", "null"),
        capture("name", "/name", "string"),
      ],
    }),
  );
  for (const name of ["list", "flag", "empty", "name"])
    expect(runtime.variables.get(name)?.sensitive).toBe(false);
  // Nothing captured became a scrub pattern: step ids and evidence keep their text.
  const text = "list-step id flag a ok true null x";
  expect(runtime.scrub(text)).toBe(text);
  const evidence = JSON.parse(Buffer.from(artifacts.get("http/list-step.json") ?? []).toString());
  expect(evidence.captures.map((entry: { resolved: unknown }) => entry.resolved)).toEqual([
    ["a", "id", "ok"],
    true,
    null,
    "x",
  ]);
});

it("scrubs only the string and number leaves of a capture that declares sensitive", async () => {
  const session = { token: "declared-canary", count: 4242, ok: true, none: null };
  const base = await serve((_req, res) => res.end(JSON.stringify({ session })));
  const { engine, runtime } = fixture(base);
  await engine.perform(
    requestStep("declared", [], {
      capture: [
        {
          name: "session",
          from: "jsonPointer",
          pointer: "/session",
          valueType: "object",
          sensitive: true,
        },
      ],
    }),
  );
  expect(runtime.variables.get("session")?.sensitive).toBe(true);
  expect(runtime.scrub("declared-canary 4242")).toBe("[REDACTED] [REDACTED]");
  expect(runtime.scrub("ok true null")).toBe("ok true null");
});

function profileState(base: string): string {
  const host = new URL(base).hostname;
  const cookie = (name: string, extra: Record<string, unknown> = {}) => ({
    name,
    value: `${name}-canary-value`,
    domain: host,
    path: "/",
    expires: -1,
    httpOnly: true,
    secure: false,
    sameSite: "Lax",
    ...extra,
  });
  return JSON.stringify({
    cookies: [
      cookie("sid", { path: "/api" }),
      cookie("wide"),
      cookie("old", { expires: 1 }),
      cookie("foreign", { domain: "other.example" }),
      cookie("secure-only", { secure: true, domain: "other.example" }),
    ],
    origins: [],
  });
}
function profileFixture(base: string, extra: Partial<RunnerInput> = {}) {
  return fixture(
    base,
    {
      secrets: [
        { secretRef: STATE_REF, secretVersion: 1 },
        { secretRef: TOKEN_REF, secretVersion: 1 },
      ],
      auth: { storageState: { secretRef: STATE_REF } },
      ...extra,
    },
    { [STATE_REF]: profileState(base), [TOKEN_REF]: "token-canary-value" },
  );
}

it("auth profile sends only the stored cookies that match the request URL", async () => {
  const seen: [string, string | undefined][] = [];
  const base = await serve((req, res) => {
    seen.push([String(req.url), req.headers.cookie]);
    res.end("{}");
  });
  const { engine } = profileFixture(base);
  await engine.perform(requestStep("api", ["api", "me"], { auth: "profile" }));
  await engine.perform(requestStep("root", [], { auth: "profile" }));
  await engine.perform(requestStep("plain", ["api", "me"]));
  // Expired and other-domain cookies never leave, `/api` cookies stay on `/api`, and a request
  // without `auth` carries no session.
  expect(seen).toEqual([
    ["/api/me", "sid=sid-canary-value; wide=wide-canary-value"],
    ["/", "wide=wide-canary-value"],
    ["/api/me", undefined],
  ]);
});

it("auth profile orders cookies by path and scrubs the session value from evidence", async () => {
  const seen: string[] = [];
  const base = await serve((req, res) => {
    seen.push(String(req.headers.cookie));
    res.end("{}");
  });
  const { engine, runtime, artifacts } = profileFixture(base);
  await engine.perform(requestStep("api", ["api", "me"], { auth: "profile" }));
  expect(seen).toEqual(["sid=sid-canary-value; wide=wide-canary-value"]);
  expect(runtime.scrub("sid-canary-value")).toBe("[REDACTED]");
  for (const bytes of artifacts.values())
    expect(Buffer.from(bytes).toString()).not.toContain("sid-canary-value");
  expect(responseOf(engine, "api").authenticated).toBe(true);
});

it("auth profile sends its header credential with the prefix and keeps it from other origins", async () => {
  let observed: IncomingMessage["headers"] = {};
  const destination = await serve((req, res) => {
    observed = req.headers;
    res.end("ok");
  });
  const received: IncomingMessage["headers"][] = [];
  const base = await serve((req, res) => {
    received.push(req.headers);
    res.writeHead(302, { location: `${destination}/target` });
    res.end();
  });
  const { engine } = profileFixture(base, {
    networkPolicy: {
      allowedOrigins: [base, destination],
      additionalOrigins: [destination],
      networkProfile: "local-loopback",
    },
    auth: { credentials: [{ header: "Authorization", secretRef: TOKEN_REF, prefix: "Bearer " }] },
  });
  await engine.perform(requestStep("redirected", [], { auth: "profile" }));
  expect(received[0]?.authorization).toBe("Bearer token-canary-value");
  expect(observed.authorization).toBeUndefined();
  expect(observed.cookie).toBeUndefined();
});

it("auth profile blocks before sending when there is no session, nothing for the URL or a conflicting header", async () => {
  let hits = 0;
  const base = await serve((_req, res) => {
    hits++;
    res.end("{}");
  });
  const stateOnly = (state: string) =>
    fixture(
      base,
      {
        secrets: [{ secretRef: STATE_REF, secretVersion: 1 }],
        auth: { storageState: { secretRef: STATE_REF } },
      },
      { [STATE_REF]: state },
    );
  await expect(
    fixture(base).engine.perform(requestStep("none", [], { auth: "profile" })),
  ).rejects.toMatchObject({ reasonCode: "missing_secret", outcome: "blocked" });
  await expect(
    stateOnly(JSON.stringify({ cookies: [], origins: [] })).engine.perform(
      requestStep("empty", [], { auth: "profile" }),
    ),
  ).rejects.toMatchObject({ reasonCode: "missing_secret", outcome: "blocked" });
  await expect(
    stateOnly("not json").engine.perform(requestStep("bad", [], { auth: "profile" })),
  ).rejects.toMatchObject({ reasonCode: "manual_auth_required", outcome: "blocked" });
  // Every stored cookie is for the other path, so the session has nothing for this request.
  const state = JSON.parse(profileState(base));
  state.cookies = state.cookies.filter((entry: { name: string }) => entry.name === "sid");
  await expect(
    stateOnly(JSON.stringify(state)).engine.perform(
      requestStep("elsewhere", ["private"], { auth: "profile" }),
    ),
  ).rejects.toMatchObject({ reasonCode: "missing_secret", outcome: "blocked" });
  const conflict = profileFixture(base, {
    auth: { credentials: [{ header: "authorization", secretRef: TOKEN_REF }] },
    variables: { own: { value: "Bearer own-canary", sensitive: true } },
  });
  await expect(
    conflict.engine.perform(
      requestStep("both", [], {
        auth: "profile",
        headers: { Authorization: { variableRef: "own" } },
      }),
    ),
  ).rejects.toMatchObject({ reasonCode: "security_precondition_failed" });
  expect(hits).toBe(0);
});

function requestEvidence(
  artifacts: Map<string, Uint8Array>,
  stepId: string,
): { request: Record<string, unknown> } {
  const bytes = artifacts.get(`http/${stepId}.json`);
  if (!bytes) throw new Error(`Missing evidence: ${stepId}`);
  return JSON.parse(new TextDecoder().decode(bytes)) as { request: Record<string, unknown> };
}

it("records which credentials a request sent by header, source and reference, without any value", async () => {
  const base = await serve((_req, res) => res.end("{}"));
  const { engine, artifacts } = fixture(
    base,
    {
      secrets: [{ secretRef: SECRET_REF, secretVersion: 1 }],
      variables: {
        token: { value: "Bearer variable-canary-token", sensitive: true },
        trace: { value: "trace-123", sensitive: false },
      },
    },
    { [SECRET_REF]: "cookie-canary-secret" },
  );
  await engine.perform(
    requestStep("sent", ["me"], {
      headers: {
        Cookie: { secretRef: SECRET_REF },
        Authorization: { variableRef: "token" },
        "X-Trace": { variableRef: "trace" },
        "X-Api-Key": { invalidCredential: {} },
      },
    }),
  );
  await engine.perform(
    requestStep("plain", ["me"], { headers: { "X-Trace": { variableRef: "trace" } } }),
  );
  const sent = requestEvidence(artifacts, "sent");
  // A forged credential stays in `invalidCredentials`; a plain variable is a binding only.
  expect(sent.request.credentials).toEqual([
    { header: "cookie", source: "secret", secretRef: SECRET_REF },
    { header: "authorization", source: "variable", variableRef: "token" },
  ]);
  expect(sent.request.invalidCredentials).toEqual([{ header: "x-api-key" }]);
  for (const value of ["cookie-canary-secret", "variable-canary-token"])
    expect(JSON.stringify(sent)).not.toContain(value);
  expect(requestEvidence(artifacts, "plain").request).not.toHaveProperty("credentials");
});

it("records the auth profile cookie names and header names a request sent, never their values", async () => {
  const base = await serve((_req, res) => res.end("{}"));
  const { engine, artifacts } = profileFixture(base, {
    auth: {
      storageState: { secretRef: STATE_REF },
      credentials: [{ header: "X-Session-Token", secretRef: TOKEN_REF, prefix: "Bearer " }],
    },
  });
  await engine.perform(requestStep("api", ["api", "me"], { auth: "profile" }));
  await engine.perform(requestStep("root", [], { auth: "profile" }));
  await engine.perform(requestStep("anonymous", ["api", "me"]));
  const api = requestEvidence(artifacts, "api");
  // The `/api` cookie only goes to `/api`, so the same profile sends other cookies to `/`.
  expect(api.request.credentials).toEqual([
    { header: "x-session-token", source: "authProfile" },
    { header: "cookie", source: "authProfile", cookies: ["sid", "wide"] },
  ]);
  expect(requestEvidence(artifacts, "root").request.credentials).toEqual([
    { header: "x-session-token", source: "authProfile" },
    { header: "cookie", source: "authProfile", cookies: ["wide"] },
  ]);
  for (const step of ["api", "root"])
    for (const value of ["sid-canary-value", "wide-canary-value", "token-canary-value"])
      expect(JSON.stringify(requestEvidence(artifacts, step))).not.toContain(value);
  expect(requestEvidence(artifacts, "anonymous").request).not.toHaveProperty("credentials");
});

it("records the credentials of the first hop only when a redirect drops them", async () => {
  let observed: IncomingMessage["headers"] = {};
  const destination = await serve((req, res) => {
    observed = req.headers;
    res.end("ok");
  });
  const base = await serve((_req, res) => {
    res.writeHead(302, { location: `${destination}/target` });
    res.end();
  });
  const { engine, artifacts } = fixture(
    base,
    {
      networkPolicy: {
        allowedOrigins: [base, destination],
        additionalOrigins: [destination],
        networkProfile: "local-loopback",
      },
      secrets: [{ secretRef: SECRET_REF, secretVersion: 1 }],
    },
    { [SECRET_REF]: "bearer-canary-secret" },
  );
  await engine.perform(
    requestStep("redirected", [], { headers: { Authorization: { secretRef: SECRET_REF } } }),
  );
  expect(observed.authorization).toBeUndefined();
  expect(requestEvidence(artifacts, "redirected").request.credentials).toEqual([
    { header: "authorization", source: "secret", secretRef: SECRET_REF },
  ]);
});
