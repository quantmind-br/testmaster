import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { afterEach, describe, expect, it } from "vitest";
import { MemoryModelCache, ModelGateway } from "./gateway.js";
import {
  completion,
  grantedConsent,
  TestBudgetLedger,
  testProvider,
  testRequest,
} from "./test-support.js";
import type { ModelCallRecord } from "./types.js";

const servers: Server[] = [];
afterEach(async () => {
  for (const server of servers.splice(0)) {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

async function fixture(
  handler?: (req: IncomingMessage, res: ServerResponse, body: string, number: number) => void,
  ledger = new TestBudgetLedger(),
) {
  let requests = 0;
  let completions = 0;
  let consent: typeof grantedConsent | null = grantedConsent;
  const records: ModelCallRecord[] = [];
  const payloads: string[] = [];
  const server = createServer(async (req, res) => {
    requests += 1;
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(Buffer.from(chunk));
    const body = Buffer.concat(chunks).toString();
    payloads.push(body);
    if (req.url === "/v1/models") {
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ data: [{ id: "model" }] }));
      return;
    }
    completions += 1;
    if (handler) handler(req, res, body, completions);
    else res.end(JSON.stringify(completion));
  });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Missing listener address");
  const endpoint = `http://127.0.0.1:${address.port}/v1`;
  const options = {
    providers: [{ ...testProvider, baseUrl: endpoint }],
    allowedProviders: ["fake"],
    allowedEndpoints: [endpoint],
    env: () => "fake-api-key",
    consentStore: {
      async find() {
        return consent;
      },
    },
    budgetLedger: ledger,
    recorder: {
      async record(call: ModelCallRecord) {
        records.push(call);
      },
    },
    cache: new MemoryModelCache(),
  };
  return {
    gateway: new ModelGateway(options),
    options,
    records,
    payloads,
    ledger,
    revoke() {
      consent = null;
    },
    grant() {
      consent = grantedConsent;
    },
    counts() {
      return { requests, completions };
    },
  };
}

it("records output_truncated and charges one completion without blind repairs", async () => {
  const f = await fixture((_req, res) =>
    res.end(
      JSON.stringify({
        ...completion,
        choices: [{ message: { content: '{"amount":' }, finish_reason: "length" }],
        usage: { prompt_tokens: 20, completion_tokens: 128 },
      }),
    ),
  );
  await expect(f.gateway.complete(testRequest)).rejects.toMatchObject({
    code: "PRECONDITION_FAILED",
    details: { reasonCode: "output_truncated" },
  });
  expect(f.counts().completions).toBe(1);
  expect(f.records).toHaveLength(1);
  expect(f.records[0]).toMatchObject({
    finishReason: "length",
    failureReason: "output_truncated",
    repairAttempt: 0,
    usage: { outputTokens: 128 },
  });
  expect(f.ledger.settlements).toHaveLength(1);
});
describe("policy-controlled model requests", () => {
  it("denies absent consent and disallowed providers before any request, with a positive boundary control", async () => {
    const f = await fixture();
    f.revoke();
    await expect(f.gateway.complete(testRequest)).rejects.toMatchObject({ code: "POLICY_DENIED" });
    await expect(
      new ModelGateway({ ...f.options, allowedProviders: [] }).complete(testRequest),
    ).rejects.toMatchObject({ code: "POLICY_DENIED" });
    expect(f.counts().requests).toBe(0);
    f.grant();
    const result = await f.gateway.complete(testRequest);
    expect(result.output).toEqual({ amount: 1, currency: "USD", scale: 2 });
    expect(f.counts()).toEqual({ requests: 2, completions: 1 });
    expect(result.usage).toEqual({ inputTokens: 20, outputTokens: 10, reasoningTokens: 3 });
    expect(result.reasoningContent).toContain("Checked");
    expect(result.cost).toBe("unknown");
  });

  it("leaves generation and reasoning defaults to the provider, including repair requests", async () => {
    const f = await fixture((_req, res, body, number) => {
      const payload = JSON.parse(body) as Record<string, unknown>;
      const unexpected = Object.keys(payload).filter(
        (key) => !["model", "messages", "response_format"].includes(key),
      );
      if (unexpected.length) {
        res.statusCode = 400;
        res.end(JSON.stringify({ error: "Generation overrides are not accepted" }));
        return;
      }
      res.end(
        JSON.stringify(
          number === 1
            ? { ...completion, choices: [{ message: { content: "invalid JSON" } }] }
            : completion,
        ),
      );
    });
    const result = await f.gateway.complete(testRequest);
    expect(result.output).toEqual({ amount: 1, currency: "USD", scale: 2 });
    expect(result.reasoningContent).toBe("Checked required fields.");
    expect(f.records.map((record) => record.outcome)).toEqual(["invalid", "success"]);
    expect(f.counts().completions).toBe(2);
  });

  it("records invalid repairs and never returns invalid-after-two-repairs", async () => {
    const f = await fixture((_req, res) =>
      res.end(
        JSON.stringify({
          ...completion,
          choices: [{ message: { content: '{"amount":"bad"}' }, finish_reason: "stop" }],
        }),
      ),
    );
    await expect(f.gateway.complete(testRequest)).rejects.toMatchObject({
      code: "INVALID_ARGUMENT",
      details: { repairs: 2, candidateStatus: "invalid" },
    });
    expect(f.counts().completions).toBe(3);
    expect(f.records.map((record) => [record.outcome, record.repairAttempt])).toEqual([
      ["invalid", 0],
      ["invalid", 1],
      ["invalid", 2],
    ]);
    expect(f.ledger.settlements).toHaveLength(3);
  });

  it("repairs a schema-invalid candidate successfully", async () => {
    const f = await fixture((_req, res, _body, n) =>
      res.end(
        JSON.stringify(
          n < 3 ? { ...completion, choices: [{ message: { content: "not JSON" } }] } : completion,
        ),
      ),
    );
    expect((await f.gateway.complete(testRequest)).output).toEqual({
      amount: 1,
      currency: "USD",
      scale: 2,
    });
    expect(f.records.map((record) => record.outcome)).toEqual(["invalid", "invalid", "success"]);
  });

  it("preserves unknown usage and unknown costs", async () => {
    const f = await fixture((_req, res) =>
      res.end(JSON.stringify({ model: "model", choices: completion.choices })),
    );
    const result = await f.gateway.complete(testRequest);
    expect(result.usage).toEqual({ inputTokens: null, outputTokens: null, reasoningTokens: null });
    expect(result.cost).toBe("unknown");
    expect(f.records[0]?.usage).toEqual(result.usage);
    expect(f.ledger.settlements[0]?.cost).toBe("unknown");
  });

  it("only retries a lost response, reserving and recording both attempts", async () => {
    const f = await fixture((req, res, _body, n) => {
      if (n === 1) req.socket.destroy();
      else res.end(JSON.stringify(completion));
    });
    await f.gateway.complete(testRequest);
    expect(f.counts().completions).toBe(2);
    expect(
      f.records.map((record) => [record.outcome, record.transportAttempt, record.cost]),
    ).toEqual([
      ["failed", 0, "unknown"],
      ["success", 1, "unknown"],
    ]);
    expect(new Set(f.records.map((record) => record.reservationId)).size).toBe(2);
    const http = await fixture((_req, res) => {
      res.statusCode = 500;
      res.end('{"error":"rejected"}');
    });
    await expect(http.gateway.complete(testRequest)).rejects.toMatchObject({ code: "UNAVAILABLE" });
    expect(http.counts().completions).toBe(1);
    const malformed = await fixture((_req, res) => res.end("bad provider envelope"));
    await expect(malformed.gateway.complete(testRequest)).rejects.toMatchObject({
      code: "UNAVAILABLE",
    });
    expect(malformed.counts().completions).toBe(1);
  });

  it("stops timed-out and cancelled requests without retries and keeps unknown charges", async () => {
    const f = await fixture(() => {});
    await expect(f.gateway.complete({ ...testRequest, deadlineMs: 150 })).rejects.toMatchObject({
      code: "UPSTREAM_TIMEOUT",
    });
    expect(f.counts().completions).toBe(1);
    expect(f.records[0]?.outcome).toBe("cancelled");
    const controller = new AbortController();
    const cancelled = await fixture(() => controller.abort());
    await expect(
      cancelled.gateway.complete({ ...testRequest, signal: controller.signal }),
    ).rejects.toMatchObject({ code: "PRECONDITION_FAILED" });
    expect(cancelled.counts().completions).toBe(1);
    expect(cancelled.ledger.settlements.every((entry) => entry.cost === "unknown")).toBe(true);
  });

  it("atomic reservations cannot spend the last unit twice", async () => {
    const f = await fixture(undefined, new TestBudgetLedger(1n));
    const results = await Promise.allSettled(
      Array.from({ length: 8 }, () => f.gateway.complete({ ...testRequest, cache: false })),
    );
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect(results.filter((result) => result.status === "rejected")).toHaveLength(7);
    expect(f.counts().completions).toBe(1);
    expect(f.ledger.spent).toBe(1n);
  });

  it("scrubs secrets at the outbound boundary, persists raw prompts only opted-in, and scopes cache", async () => {
    const f = await fixture();
    const input = {
      ...testRequest,
      messages: [{ role: "user" as const, content: "canary-credential fake-api-key" }],
      dataPolicy: {
        ...testRequest.dataPolicy,
        secrets: ["canary-credential"],
        recordRawPrompt: true,
      },
    };
    await f.gateway.complete(input);
    expect(f.payloads.join("")).not.toContain("canary-credential");
    expect(f.payloads.join("")).not.toContain("fake-api-key");
    expect(f.records[0]?.rawPrompt).toContain("[REDACTED]");
    const hit = await f.gateway.complete(input);
    expect(hit.cacheHit).toBe(true);
    expect(f.counts().completions).toBe(1);
    expect(f.records[1]?.reservationId).toBeNull();
    await f.gateway.complete({ ...input, projectId: "other-project" });
    expect(f.counts().completions).toBe(2);
    const sourceUpdate = await f.gateway.complete({
      ...input,
      sourceRevisionIds: ["svr_01900000-0000-7000-8000-000000000001"],
    });
    expect(sourceUpdate.cacheHit).toBe(false);
    const diffUpdate = await f.gateway.complete({
      ...input,
      inputRefs: ["diff:new-head-and-dirty-hash"],
    });
    expect(diffUpdate.cacheHit).toBe(false);
    expect(f.counts().completions).toBe(4);
    expect(
      (await f.gateway.complete({ ...input, inputRefs: ["diff:new-head-and-dirty-hash"] }))
        .cacheHit,
    ).toBe(true);
    f.revoke();
    await expect(f.gateway.complete(input)).rejects.toMatchObject({ code: "POLICY_DENIED" });
  });

  it("rejects missing capability, substituted model, and excessive input without a completion", async () => {
    const f = await fixture();
    const configuredProvider = f.options.providers[0];
    if (!configuredProvider) throw new Error("Fixture provider missing");
    const missing = new ModelGateway({
      ...f.options,
      providers: [{ ...configuredProvider, models: [{ id: "model", capabilities: {} }] }],
    });
    await expect(missing.complete(testRequest)).rejects.toMatchObject({
      code: "CAPABILITY_UNAVAILABLE",
    });
    expect(f.counts().requests).toBe(0);
    await expect(
      f.gateway.complete({
        ...testRequest,
        dataPolicy: { ...testRequest.dataPolicy, maxInputBytes: 1 },
      }),
    ).rejects.toMatchObject({ code: "PAYLOAD_TOO_LARGE" });
    expect(f.counts().completions).toBe(0);
    const changed = await fixture((_req, res) =>
      res.end(JSON.stringify({ ...completion, model: "other-model" })),
    );
    await expect(changed.gateway.complete(testRequest)).rejects.toMatchObject({
      code: "CAPABILITY_UNAVAILABLE",
    });
    expect(changed.counts().completions).toBe(1);
  });

  it("reserves priced input plus maximum output, settles actual usage, and denies exhausted budget", async () => {
    const f = await fixture();
    const configured = f.options.providers[0];
    if (!configured) throw new Error("Fixture provider missing");
    const pricing = {
      model: {
        currency: "USD",
        scale: 6,
        inputPerMillion: "1000000",
        outputPerMillion: "2000000",
        version: "price-1",
      },
    };
    const priced = new ModelGateway({
      ...f.options,
      providers: [{ ...configured, prices: pricing }],
    });
    const result = await priced.complete(testRequest);
    expect(result.cost).toEqual({ amount: "40", currency: "USD", scale: 6 });
    expect(f.ledger.spent).toBe(40n);
    const denied = new ModelGateway({
      ...f.options,
      providers: [{ ...configured, prices: pricing }],
      budgetLedger: new TestBudgetLedger(1n),
    });
    await expect(denied.complete({ ...testRequest, cache: false })).rejects.toMatchObject({
      code: "QUOTA_EXCEEDED",
    });
    expect(f.counts().completions).toBe(1);
  });

  it("does not follow a provider redirect or retry HTTP rejection", async () => {
    const f = await fixture((_req, res) => {
      res.statusCode = 302;
      res.setHeader("location", "http://127.0.0.1:1/exfiltrate");
      res.end();
    });
    await expect(f.gateway.complete(testRequest)).rejects.toMatchObject({
      code: "UNAVAILABLE",
      details: { status: 302 },
    });
    expect(f.counts().requests).toBe(2);
    expect(f.records).toHaveLength(1);
  });

  it("rechecks consent before repair and stops without the second call", async () => {
    const f = await fixture((_req, res) =>
      res.end(JSON.stringify({ ...completion, choices: [{ message: { content: "invalid" } }] })),
    );
    f.options.recorder.record = async (record) => {
      f.records.push(record);
      f.revoke();
    };
    await expect(f.gateway.complete(testRequest)).rejects.toMatchObject({ code: "POLICY_DENIED" });
    expect(f.counts().completions).toBe(1);
    expect(f.records[0]?.outcome).toBe("invalid");
  });

  it("validates declared tool-call arguments and parses reasoning", async () => {
    const f = await fixture((_req, res) =>
      res.end(
        JSON.stringify({
          ...completion,
          choices: [
            {
              message: {
                content: null,
                reasoning_content: "reasoning",
                tool_calls: [
                  {
                    id: "call-1",
                    type: "function",
                    function: {
                      name: "money",
                      arguments: '{"amount":1,"currency":"USD","scale":2}',
                    },
                  },
                ],
              },
              finish_reason: "tool_calls",
            },
          ],
        }),
      ),
    );
    const { responseSchema: _schema, ...input } = testRequest;
    const result = await f.gateway.complete({
      ...input,
      tools: [{ name: "money", description: "Money value", argumentsSchema: "Money" }],
    });
    expect(result.toolCalls[0]?.arguments).toEqual({ amount: 1, currency: "USD", scale: 2 });
    expect(result.finishReason).toBe("tool_calls");
    expect(result.reasoningContent).toBe("reasoning");
  });
});
