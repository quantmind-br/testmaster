import {
  createServer,
  request as httpRequest,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from "node:http";
import { connect, type Socket } from "node:net";
import {
  type ExecutablePlan,
  type PlanStep,
  type RunnerEvent,
  validate,
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
function fixture(baseUrl: string, extra: Partial<RunnerInput> = {}) {
  const events: RunnerEvent[] = [];
  const artifacts = new Map<string, Uint8Array>();
  const controller = new AbortController();
  const protocol = {
    controller,
    emit: async (type: string, payload: unknown) => {
      events.push(
        validate<RunnerEvent>("RunnerEvent", {
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
    secret: async () => "canary-secret",
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

it("captures declared types and keeps sensitive values out of events and artifacts", async () => {
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
  expect(JSON.stringify(events)).not.toContain("captured-canary");
  for (const bytes of artifacts.values())
    expect(Buffer.from(bytes).toString()).not.toContain("captured-canary");
  expect(
    events.some(
      (event) =>
        event.type === "variable.captured" &&
        event.payload.sensitive &&
        event.payload.encryptedValueRef,
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

it("propagates request taint into captures even when capture.sensitive is false", async () => {
  const base = await serve((req, res) =>
    res.end(JSON.stringify({ echo: req.headers.authorization })),
  );
  const { engine, runtime, events } = fixture(base, {
    variables: { auth: { value: "Bearer request-canary", sensitive: true } },
  });
  await engine.perform(
    requestStep("taint", [], {
      headers: { Authorization: { variableRef: "auth" } },
      capture: [
        {
          name: "echo",
          from: "jsonPointer",
          pointer: "/echo",
          valueType: "string",
          sensitive: false,
        },
      ],
    }),
  );
  expect(runtime.variables.get("echo")?.sensitive).toBe(true);
  expect(JSON.stringify(events)).not.toContain("request-canary");
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
