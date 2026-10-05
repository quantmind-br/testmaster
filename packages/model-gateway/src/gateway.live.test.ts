import { validate } from "@testmaster/contracts";
import { expect, it } from "vitest";
import { ModelGateway } from "./gateway.js";
import { grantedConsent, TestBudgetLedger, testRequest } from "./test-support.js";
import type { ModelCallRecord } from "./types.js";

it("QuantForge deepseek-v4.1-flash returns locally validated JSON and measured usage", async () => {
  expect(process.env.QUANTFORGE_API_KEY).toBeTruthy();
  const records: ModelCallRecord[] = [];
  const endpoint = "https://api.quantforge.com.br/v1";
  const ledger = new TestBudgetLedger(10n);
  const gateway = new ModelGateway({
    providers: [
      {
        id: "quantforge",
        kind: "openai-compatible",
        baseUrl: endpoint,
        apiKeyEnv: "QUANTFORGE_API_KEY",
        models: [
          { id: "deepseek-v4.1-flash", capabilities: { structuredJson: true, toolCalls: true } },
        ],
      },
    ],
    allowedProviders: ["quantforge"],
    allowedEndpoints: [endpoint],
    consentStore: {
      async find() {
        return grantedConsent;
      },
    },
    budgetLedger: ledger,
    recorder: {
      async record(call) {
        records.push(call);
      },
    },
  });
  const result = await gateway.complete({
    ...testRequest,
    provider: "quantforge",
    model: "deepseek-v4.1-flash",
    maxOutputTokens: 1024,
    deadlineMs: 60_000,
    cache: false,
  });
  expect(validate("Money", result.output)).toEqual({ amount: 1, currency: "USD", scale: 2 });
  expect(result.resolvedModel).toBe("deepseek-v4.1-flash");
  expect(result.usage.inputTokens).toBeGreaterThan(0);
  expect(result.usage.outputTokens).toBeGreaterThan(0);
  expect(result.cost).toBe("unknown");
  expect(records.at(-1)?.outcome).toBe("success");
  expect(records.at(-1)?.usage).toEqual(result.usage);
  expect(records.every((record) => record.rawPrompt === undefined)).toBe(true);
  expect(ledger.settlements).toHaveLength(records.length);
  console.info(
    JSON.stringify({
      provider: "quantforge",
      model: result.resolvedModel,
      usage: result.usage,
      calls: records.length,
      cost: result.cost,
      responseHash: result.responseHash,
    }),
  );
}, 65_000);
