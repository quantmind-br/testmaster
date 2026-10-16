import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { ContractError } from "@testmaster/contracts";
import { afterEach, describe, expect, it } from "vitest";
import { FALLBACK_OUTPUT_RESERVATION_TOKENS, MemoryModelCache, ModelGateway } from "./gateway.js";
import { completion, TestBudgetLedger, testProvider, testRequest } from "./test-support.js";
import type { BudgetReservationInput, ModelCallRecord } from "./types.js";

class ReservingLedger extends TestBudgetLedger {
  readonly inputs: BudgetReservationInput[] = [];
  override async reserve(input: BudgetReservationInput) {
    this.inputs.push(input);
    return super.reserve(input);
  }
}

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
  inventory: (listing: number) => string[] = () => ["model"],
) {
  let requests = 0;
  let listings = 0;
  let completions = 0;
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
      listings += 1;
      res.end(JSON.stringify({ data: inventory(listings).map((id) => ({ id })) }));
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
  it("needs no grant, denies disallowed providers and never-sent data classes before any request", async () => {
    const f = await fixture();
    await expect(
      new ModelGateway({ ...f.options, allowedProviders: [] }).complete(testRequest),
    ).rejects.toMatchObject({ code: "POLICY_DENIED" });
    await expect(
      f.gateway.complete({
        ...testRequest,
        dataPolicy: { ...testRequest.dataPolicy, dataClasses: ["source", "env"] },
      }),
    ).rejects.toMatchObject({ code: "POLICY_DENIED" });
    expect(f.counts().requests).toBe(0);
    const result = await f.gateway.complete(testRequest);
    expect(result.output).toEqual({ amount: 1, currency: "USD", scale: 2 });
    expect(f.counts()).toEqual({ requests: 2, completions: 1 });
    expect(result.usage).toEqual({ inputTokens: 20, outputTokens: 10, reasoningTokens: 3 });
    expect(result.reasoningContent).toContain("Checked");
    expect(result.cost).toBe("unknown");
  });

  it("admits an unpriced model when the ledger has room and refuses it before the call when the budget is exhausted", async () => {
    const exhausted = await fixture(undefined, new TestBudgetLedger(0n));
    await expect(exhausted.gateway.complete(testRequest)).rejects.toMatchObject({
      code: "QUOTA_EXCEEDED",
      details: { reasonCode: "budget_exhausted" },
    });
    expect(exhausted.counts().completions).toBe(0);
    const open = await fixture();
    expect((await open.gateway.complete(testRequest)).cost).toBe("unknown");
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

  it("separates cached completions by reasoning effort and preserves effort during repairs", async () => {
    const attempts = new Map<string, number>();
    const f = await fixture((_req, res, body) => {
      const effort = JSON.parse(body).reasoning_effort;
      const attempt = (attempts.get(effort) ?? 0) + 1;
      attempts.set(effort, attempt);
      res.end(
        JSON.stringify({
          ...completion,
          choices: [
            {
              message: {
                content:
                  attempt === 1
                    ? "invalid"
                    : JSON.stringify({
                        amount: effort === "high" ? 2 : 1,
                        currency: "USD",
                        scale: 2,
                      }),
              },
            },
          ],
        }),
      );
    });
    expect(
      (await f.gateway.complete({ ...testRequest, reasoningEffort: "low" })).output,
    ).toMatchObject({ amount: 1 });
    expect(
      (await f.gateway.complete({ ...testRequest, reasoningEffort: "high" })).output,
    ).toMatchObject({ amount: 2 });
    expect((await f.gateway.complete({ ...testRequest, reasoningEffort: "low" })).cacheHit).toBe(
      true,
    );
    expect(attempts).toEqual(
      new Map([
        ["low", 2],
        ["high", 2],
      ]),
    );
    const before = f.counts().requests;
    await expect(
      f.gateway.complete({ ...testRequest, reasoningEffort: "invalid" as "low" }),
    ).rejects.toMatchObject({ code: "INVALID_ARGUMENT" });
    expect(f.counts().requests).toBe(before);
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
      details: {
        repairs: 2,
        candidateStatus: "invalid",
        invalidAttempts: 3,
        validationFailure: {
          code: "INVALID_ARGUMENT",
          issues: expect.arrayContaining([expect.objectContaining({ path: "/amount" })]),
          omittedIssues: 0,
        },
      },
    });
    expect(f.counts().completions).toBe(3);
    expect(f.records.map((record) => [record.outcome, record.repairAttempt])).toEqual([
      ["invalid", 0],
      ["invalid", 1],
      ["invalid", 2],
    ]);
    // Every repair record keeps why its response was refused, never the response itself.
    expect(f.records.map((record) => record.validationFailure?.code)).toEqual([
      "INVALID_ARGUMENT",
      "INVALID_ARGUMENT",
      "INVALID_ARGUMENT",
    ]);
    expect(f.records.every((record) => record.validationFailure?.issues.length)).toBe(true);
    expect(JSON.stringify(f.records[0]?.validationFailure)).not.toContain("bad");
    expect(f.ledger.settlements).toHaveLength(3);
  });

  it("feeds a failed semantic check back as repair feedback and records the call invalid", async () => {
    const f = await fixture((_req, res, _body, number) =>
      res.end(
        JSON.stringify({
          ...completion,
          choices: [
            {
              message: {
                content: JSON.stringify({
                  amount: number === 1 ? 7 : 1,
                  currency: "USD",
                  scale: 2,
                }),
              },
              finish_reason: "stop",
            },
          ],
        }),
      ),
    );
    const check = async (output: unknown) => {
      if (
        typeof output === "object" &&
        output !== null &&
        "amount" in output &&
        output.amount === 7
      )
        throw new ContractError("INVALID_ARGUMENT", "Amount is not allowed", {}, [
          { path: "/amount", rule: "forbidden_amount", message: "Seven is refused" },
        ]);
    };
    const result = await f.gateway.complete({ ...testRequest, check });
    expect(result.output).toMatchObject({ amount: 1 });
    expect(f.counts().completions).toBe(2);
    expect(f.records.map((record) => record.outcome)).toEqual(["invalid", "success"]);
    expect(f.records[0]?.validationFailure).toMatchObject({
      code: "INVALID_ARGUMENT",
      message: "Amount is not allowed",
      issues: [{ path: "/amount", rule: "forbidden_amount", message: "Seven is refused" }],
    });
    // The repair request names the refused path, rule and reason; the refused value is not echoed.
    const repair = f.payloads.at(-1) ?? "";
    expect(repair).toContain("forbidden_amount");
    expect(repair).toContain("Seven is refused");
    // Control: a check that accepts adds no repair and no invalid record.
    const accepting = await fixture();
    await accepting.gateway.complete({ ...testRequest, check: async () => {} });
    expect(accepting.records.map((record) => record.outcome)).toEqual(["success"]);
  });

  it("surfaces the check's own error with the repair account once repairs run out", async () => {
    const f = await fixture();
    const refusal = () =>
      new ContractError("INVALID_ARGUMENT", "Every candidate is refused", {
        atomicity: "all_or_nothing",
      });
    await expect(
      f.gateway.complete({
        ...testRequest,
        check: async () => {
          throw refusal();
        },
      }),
    ).rejects.toMatchObject({
      code: "INVALID_ARGUMENT",
      message: "Every candidate is refused",
      details: {
        atomicity: "all_or_nothing",
        repairs: 2,
        candidateStatus: "invalid",
        invalidAttempts: 3,
        modelCallId: expect.stringMatching(/^mdl_/u),
      },
    });
    expect(f.counts().completions).toBe(3);
    expect(f.records.map((record) => record.outcome)).toEqual(["invalid", "invalid", "invalid"]);
    expect(f.ledger.settlements).toHaveLength(3);
    // The reported call is the last invalid attempt's record.
    const error = await f.gateway
      .complete({
        ...testRequest,
        cache: false,
        check: async () => {
          throw refusal();
        },
      })
      .catch((caught: unknown) => caught);
    expect(error).toMatchObject({ details: { modelCallId: f.records.at(-1)?.id } });
  });

  it("never repairs a defect thrown by the check and re-checks a cached output", async () => {
    const f = await fixture();
    await expect(
      f.gateway.complete({
        ...testRequest,
        check: () => {
          throw new TypeError("check defect");
        },
      }),
    ).rejects.toThrow("check defect");
    expect(f.counts().completions).toBe(1);
    expect(f.records.map((record) => record.outcome)).toEqual(["failed"]);
    // A cached output that fails the check is a miss: the paid path runs and validates it.
    const cached = await fixture();
    await cached.gateway.complete(testRequest);
    let checks = 0;
    const second = await cached.gateway.complete({
      ...testRequest,
      check: () => {
        checks += 1;
        if (checks === 1) throw new ContractError("INVALID_ARGUMENT", "Stale cache entry");
      },
    });
    expect(second.cacheHit).toBe(false);
    expect(checks).toBe(2);
    expect(cached.counts().completions).toBe(2);
    // Control: a cached output that passes the check is still served from the cache.
    const third = await cached.gateway.complete({ ...testRequest, check: () => {} });
    expect(third.cacheHit).toBe(true);
    expect(cached.counts().completions).toBe(2);
  });

  it("reports the last validation failure and the cut request when the caller cancels a repair", async () => {
    const controller = new AbortController();
    const f = await fixture((_req, res, _body, n) => {
      // The first response is invalid; the caller cancels while the repair is unanswered.
      if (n === 1)
        res.end(
          JSON.stringify({
            ...completion,
            choices: [{ message: { content: '{"amount":"bad"}' }, finish_reason: "stop" }],
          }),
        );
      else controller.abort();
    });
    const error = await f.gateway
      .complete({ ...testRequest, signal: controller.signal })
      .catch((caught: unknown) => caught);
    expect(error).toMatchObject({
      code: "PRECONDITION_FAILED",
      message: "Model request cancelled",
      details: {
        candidateStatus: "invalid",
        invalidAttempts: 1,
        validationFailure: { code: "INVALID_ARGUMENT" },
        lastModelCallId: expect.stringMatching(/^mdl_/u),
      },
    });
    expect(f.records.map((record) => record.outcome)).toEqual(["invalid", "cancelled"]);
    expect((error as ContractError).details.lastModelCallId).toBe(f.records[1]?.id);
    // Control: a cancellation with no invalid attempt carries no validation summary.
    const silentController = new AbortController();
    const silent = await fixture(() => silentController.abort());
    const cancelled = await silent.gateway
      .complete({ ...testRequest, signal: silentController.signal })
      .catch((caught: unknown) => caught);
    expect(cancelled).toMatchObject({ code: "PRECONDITION_FAILED" });
    expect(cancelled).not.toHaveProperty("details.validationFailure");
  });

  it("bounds and scrubs the persisted validation summary without model output values", async () => {
    const step = { id: "s", kind: "action", operation: "request", input: { method: "BREW" } };
    const oversized = {
      proposals: [
        {
          plan: {
            schemaVersion: "1.0.0",
            kind: "executable",
            name: "Broken",
            type: "backend",
            runner: "http",
            requirementRefs: [],
            steps: Array.from({ length: 40 }, (_, index) => ({ ...step, id: `s${index}` })),
          },
          requirementRefs: ["req_01900000-0000-7000-8000-000000000001"],
          evidenceIds: ["E1"],
          warnings: [],
        },
      ],
    };
    const big = await fixture((_req, res) =>
      res.end(
        JSON.stringify({
          ...completion,
          choices: [{ message: { content: JSON.stringify(oversized) }, finish_reason: "stop" }],
        }),
      ),
    );
    await expect(
      big.gateway.complete({
        ...testRequest,
        responseSchema: "AIProposalsOutput",
      }),
    ).rejects.toMatchObject({ details: { validationFailure: { code: "INVALID_ARGUMENT" } } });
    for (const record of big.records) {
      const summary = record.validationFailure;
      expect(summary?.issues.length).toBe(5);
      expect(summary?.omittedIssues).toBeGreaterThan(0);
      expect(summary?.message.length).toBeLessThanOrEqual(300);
      for (const issue of summary?.issues ?? []) {
        expect(issue.path.length).toBeLessThanOrEqual(200);
        expect(issue.rule.length).toBeLessThanOrEqual(60);
        expect(issue.message.length).toBeLessThanOrEqual(200);
      }
      expect(JSON.stringify(summary)).not.toContain("BREW");
    }
    // A secret used as a property name never reaches the persisted summary or the error.
    const canaryKey = "canary-credential-key";
    const leaky = await fixture((_req, res) =>
      res.end(
        JSON.stringify({
          ...completion,
          choices: [
            {
              message: {
                content: JSON.stringify({ amount: "value-canary-77", [canaryKey]: "x" }),
              },
              finish_reason: "stop",
            },
          ],
        }),
      ),
    );
    const failure = await leaky.gateway
      .complete({
        ...testRequest,
        dataPolicy: { ...testRequest.dataPolicy, secrets: [canaryKey] },
      })
      .catch((error: unknown) => error);
    if (!(failure instanceof ContractError)) throw new Error("Expected a ContractError");
    expect(failure.code).toBe("INVALID_ARGUMENT");
    const persisted = JSON.stringify([
      leaky.records.map((record) => record.validationFailure),
      failure.details,
    ]);
    expect(persisted).toContain("validationFailure");
    expect(persisted).not.toContain(canaryKey);
    expect(persisted).not.toContain("value-canary-77");
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

  it("repairs analysis limitations longer than the persisted Analysis can hold", async () => {
    const output = (limitation: string) => ({
      failureKind: "unknown",
      hypotheses: [],
      recommendedAction: "collect_more_evidence",
      fixTargetHandle: null,
      limitations: [limitation],
      nextSteps: [],
      evidenceGaps: [],
    });
    const f = await fixture((_req, res, _body, n) =>
      res.end(
        JSON.stringify({
          ...completion,
          choices: [
            {
              message: { content: JSON.stringify(output(n === 1 ? "x".repeat(201) : "short")) },
              finish_reason: "stop",
            },
          ],
        }),
      ),
    );
    const result = await f.gateway.complete({ ...testRequest, responseSchema: "AIAnalysisOutput" });
    expect(result.output).toEqual(output("short"));
    expect(f.records.map((record) => record.outcome)).toEqual(["invalid", "success"]);
  });

  it("bounds repair feedback for union-heavy schema failures", async () => {
    const step = { id: "s", kind: "action", operation: "request", input: { method: "BREW" } };
    const invalid = {
      proposals: [
        {
          plan: {
            schemaVersion: "1.0.0",
            kind: "executable",
            name: "Broken",
            type: "backend",
            runner: "http",
            requirementRefs: [],
            steps: Array.from({ length: 40 }, (_, index) => ({ ...step, id: `s${index}` })),
          },
          requirementRefs: ["req_01900000-0000-7000-8000-000000000001"],
          evidenceIds: ["E1"],
          warnings: [],
        },
      ],
    };
    const f = await fixture((_req, res) =>
      res.end(
        JSON.stringify({
          ...completion,
          choices: [{ message: { content: JSON.stringify(invalid) }, finish_reason: "stop" }],
        }),
      ),
    );
    // Production admission limits (ModelService): repairs must stay within them.
    await expect(
      f.gateway.complete({
        ...testRequest,
        responseSchema: "AIProposalsOutput",
      }),
    ).rejects.toMatchObject({ details: { repairs: 2 } });
    const prompts = f.payloads
      .filter((payload) => payload.includes('"messages"'))
      .map((payload) => JSON.parse(payload).messages as { content: string }[]);
    const feedback = JSON.parse(
      String(prompts[1]?.at(-1)?.content.match(/validation: (\{.*\})\. Return/su)?.[1]),
    ) as { issues: unknown[]; omittedIssues: number };
    expect(feedback.issues).toHaveLength(20);
    expect(feedback.omittedIssues).toBeGreaterThan(0);
    expect(Buffer.byteLength(prompts[1]?.at(-1)?.content ?? "")).toBeLessThan(12000);
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

  it("stops a cancelled request without retries and keeps its unknown charge", async () => {
    const controller = new AbortController();
    const cancelled = await fixture(() => controller.abort());
    await expect(
      cancelled.gateway.complete({ ...testRequest, signal: controller.signal }),
    ).rejects.toMatchObject({ code: "PRECONDITION_FAILED" });
    expect(cancelled.counts().completions).toBe(1);
    expect(cancelled.records.map((record) => record.outcome)).toEqual(["cancelled"]);
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
    const before = f.counts();
    await expect(
      f.gateway.complete({
        ...input,
        dataPolicy: { ...input.dataPolicy, dataClasses: ["credentials"] },
      }),
    ).rejects.toMatchObject({ code: "POLICY_DENIED" });
    expect(f.counts()).toEqual(before);
  });

  it("retries an intermittently missing inventory entry a bounded number of times", async () => {
    const flaky = await fixture(undefined, undefined, (listing) =>
      listing < 3 ? ["other"] : ["model"],
    );
    await expect(flaky.gateway.complete(testRequest)).resolves.toMatchObject({ cacheHit: false });
    expect(flaky.counts().completions).toBe(1);
    const absent = await fixture(undefined, undefined, () => ["other"]);
    const refusal = await absent.gateway.complete(testRequest).catch((error: unknown) => error);
    expect(refusal).toMatchObject({
      code: "CAPABILITY_UNAVAILABLE",
      details: {
        capability: "model",
        provider: "fake",
        reasonCode: "model_not_in_inventory",
        declaredModelsPresent: [],
        declaredModelsAbsent: ["model"],
      },
    });
    // The milestone label never applied to a missing model; the reason code replaces it.
    expect(refusal).not.toHaveProperty("details.milestone");
    expect(absent.counts().completions).toBe(0);
    expect(absent.counts().requests).toBe(4);
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
      details: { capability: "structuredJson", reasonCode: "model_capability_missing" },
    });
    expect(f.counts().requests).toBe(0);
    const bounded = new ModelGateway({
      ...f.options,
      providers: [
        {
          ...configuredProvider,
          models: [{ id: "model", capabilities: { structuredJson: true, contextTokens: 1 } }],
        },
      ],
    });
    await expect(bounded.complete(testRequest)).rejects.toMatchObject({
      code: "PAYLOAD_TOO_LARGE",
      details: { contextTokens: 1 },
    });
    expect(f.counts().requests).toBe(0);
    expect(f.counts().completions).toBe(0);
    const changed = await fixture((_req, res) =>
      res.end(JSON.stringify({ ...completion, model: "other-model" })),
    );
    await expect(changed.gateway.complete(testRequest)).rejects.toMatchObject({
      code: "CAPABILITY_UNAVAILABLE",
      details: {
        reasonCode: "model_substituted",
        requestedModel: "model",
        resolvedModel: "other-model",
      },
    });
    // Undeclared provider and model are distinct, named refusals before any request.
    await expect(f.gateway.complete({ ...testRequest, provider: "ghost" })).rejects.toMatchObject({
      details: { reasonCode: "provider_unavailable", availableProviders: ["fake"] },
    });
    await expect(
      f.gateway.complete({ ...testRequest, model: "ghost-model" }),
    ).rejects.toMatchObject({
      details: { reasonCode: "model_not_declared", declaredModels: ["model"] },
    });
    expect(f.counts().requests).toBe(0);
    expect(changed.counts().completions).toBe(1);
  });

  it("admits a 600 KB prompt for a model declaring a 1,050,000-token context", async () => {
    const f = await fixture();
    const configured = f.options.providers[0];
    if (!configured) throw new Error("Fixture provider missing");
    const large = new ModelGateway({
      ...f.options,
      providers: [
        {
          ...configured,
          models: [
            { id: "model", capabilities: { structuredJson: true, contextTokens: 1_050_000 } },
          ],
        },
      ],
    });
    const result = await large.complete({
      ...testRequest,
      messages: [{ role: "user", content: `Return Money JSON. ${"x".repeat(600_000)}` }],
    });
    expect(result.output).toEqual({ amount: 1, currency: "USD", scale: 2 });
    expect(f.counts().completions).toBe(1);
    expect(Buffer.byteLength(f.payloads.at(-1) ?? "")).toBeGreaterThan(600_000);
  });

  it("refuses a prompt over the declared context before transport, naming its size and the limit", async () => {
    const f = await fixture();
    const configured = f.options.providers[0];
    if (!configured) throw new Error("Fixture provider missing");
    const small = new ModelGateway({
      ...f.options,
      providers: [
        {
          ...configured,
          models: [{ id: "model", capabilities: { structuredJson: true, contextTokens: 1000 } }],
        },
      ],
    });
    const refusal = await small
      .complete({
        ...testRequest,
        messages: [{ role: "user", content: "x".repeat(5000) }],
      })
      .catch((error: unknown) => error);
    expect(refusal).toMatchObject({
      code: "PAYLOAD_TOO_LARGE",
      details: { contextTokens: 1000 },
    });
    expect((refusal as ContractError).details?.promptBytes).toBeGreaterThan(5000);
    expect(f.counts().requests).toBe(0);
  });

  it("reserves a documented fallback output for a model declaring neither output nor context limits", async () => {
    const ledger = new ReservingLedger();
    const f = await fixture(undefined, ledger);
    const configured = f.options.providers[0];
    if (!configured) throw new Error("Fixture provider missing");
    const undeclared = new ModelGateway({
      ...f.options,
      providers: [
        { ...configured, models: [{ id: "model", capabilities: { structuredJson: true } }] },
      ],
    });
    await undeclared.complete(testRequest);
    await new ModelGateway(f.options).complete({ ...testRequest, cache: false });
    const [fallback, declared] = ledger.inputs;
    expect(fallback?.reservedTokens).toBeGreaterThan(FALLBACK_OUTPUT_RESERVATION_TOKENS);
    expect(fallback?.reservedTokens).toBeLessThan(FALLBACK_OUTPUT_RESERVATION_TOKENS + 2000);
    // The fixture model declares maxOutputTokens 1024: the declared limit wins over the fallback.
    expect(declared?.reservedTokens).toBeLessThan(FALLBACK_OUTPUT_RESERVATION_TOKENS);
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

  it("prices provider-reported cached input at the cache-read rate", async () => {
    const f = await fixture((_req, res) =>
      res.end(
        JSON.stringify({
          ...completion,
          usage: {
            prompt_tokens: 20,
            completion_tokens: 10,
            prompt_tokens_details: { cached_tokens: 15 },
          },
        }),
      ),
    );
    const configured = f.options.providers[0];
    if (!configured) throw new Error("Fixture provider missing");
    const price = {
      currency: "USD",
      scale: 6,
      inputPerMillion: "1000000",
      outputPerMillion: "2000000",
      version: "price-1",
    };
    const withCacheRate = new ModelGateway({
      ...f.options,
      providers: [
        { ...configured, prices: { model: { ...price, cacheReadPerMillion: "100000" } } },
      ],
    });
    // 5 uncached x 1 + 15 cached x 0.1 + 10 output x 2 = 26.5 micro-USD, rounded up.
    expect((await withCacheRate.complete(testRequest)).cost).toEqual({
      amount: "27",
      currency: "USD",
      scale: 6,
    });
    const withoutCacheRate = new ModelGateway({
      ...f.options,
      providers: [{ ...configured, prices: { model: price } }],
    });
    expect((await withoutCacheRate.complete({ ...testRequest, cache: false })).cost).toEqual({
      amount: "40",
      currency: "USD",
      scale: 6,
    });
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

  it("rechecks the provider allowlist before repair and stops without the second call", async () => {
    const f = await fixture((_req, res) =>
      res.end(JSON.stringify({ ...completion, choices: [{ message: { content: "invalid" } }] })),
    );
    f.options.recorder.record = async (record) => {
      f.records.push(record);
      f.options.allowedProviders.length = 0;
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

  it("treats an explicit null tool_calls field as no tool calls", async () => {
    const f = await fixture((_req, res) =>
      res.end(
        JSON.stringify({
          ...completion,
          choices: [
            {
              message: {
                role: "assistant",
                content: '{"amount":1,"currency":"USD","scale":2}',
                tool_calls: null,
              },
              finish_reason: "stop",
            },
          ],
        }),
      ),
    );
    const result = await f.gateway.complete(testRequest);
    expect(result.output).toEqual({ amount: 1, currency: "USD", scale: 2 });
    expect(result.toolCalls).toEqual([]);
    expect(f.records.map((record) => record.outcome)).toEqual(["success"]);
  });
});
