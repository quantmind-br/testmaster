import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { ModelGateway, type ModelPrice, type ModelRequest } from "@testmaster/model-gateway";
import {
  SqliteBudgetLedger,
  SqliteConsentStore,
  SqliteModelCallRecorder,
} from "@testmaster/persistence";
import { expect, it } from "vitest";
import { Application } from "../application.js";

it("exports real aborted, repaired and cached calls without double billing and preserves historical prices", async () => {
  const root = await mkdtemp(join(tmpdir(), "tm-ledger-acceptance-"));
  const home = join(root, "home");
  await mkdir(home);
  const app = await Application.open({ cwd: root, home });
  let completions = 0;
  let inventories = 0;
  let mode: "repair" | "abort" | "healthy" = "repair";
  const entered = Promise.withResolvers<void>();
  const received: string[] = [];
  const server = createServer(async (request, response) => {
    if (request.url === "/v1/models") {
      inventories++;
      response.end(JSON.stringify({ data: [{ id: "ledger-model" }] }));
      return;
    }
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(Buffer.from(chunk));
    received.push(Buffer.concat(chunks).toString());
    completions++;
    if (mode === "abort") {
      entered.resolve();
      return;
    }
    const output =
      mode === "repair" && completions === 1
        ? { currency: "USD" }
        : { amount: 1, currency: "USD", scale: 2 };
    response.end(
      JSON.stringify({
        model: "ledger-model",
        choices: [{ message: { content: JSON.stringify(output) }, finish_reason: "stop" }],
        usage: {
          prompt_tokens: 20,
          completion_tokens: 10,
          prompt_tokens_details: { cached_tokens: 7 },
          completion_tokens_details: { reasoning_tokens: 3 },
        },
      }),
    );
  });
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Missing provider address");
  const endpoint = `http://127.0.0.1:${address.port}/v1`;
  const key = "synthetic-ledger-key-must-not-export";
  const prompt = "synthetic-private-prompt-must-not-export";
  try {
    const init = await app.init();
    const consent = new SqliteConsentStore(app.database);
    consent.grant(
      { workspaceId: app.context.workspaceId, projectId: init.projectId, providerId: "ledger" },
      ["documents"],
      app.context.principalId,
      true,
    );
    const create = (price: ModelPrice) =>
      new ModelGateway({
        providers: [
          {
            id: "ledger",
            kind: "openai-compatible",
            baseUrl: endpoint,
            apiKeyEnv: "LEDGER_KEY",
            models: [
              { id: "ledger-model", capabilities: { structuredJson: true, maxOutputTokens: 1024 } },
            ],
            prices: { "ledger-model": price },
          },
        ],
        allowedProviders: ["ledger"],
        allowedEndpoints: [endpoint],
        consentStore: consent,
        budgetLedger: new SqliteBudgetLedger(app.database),
        recorder: new SqliteModelCallRecorder(app.database),
        env: () => key,
      });
    const oldPrice: ModelPrice = {
      currency: "USD",
      scale: 6,
      inputPerMillion: "1000000",
      outputPerMillion: "2000000",
      version: "price-v1",
    };
    const gateway = create(oldPrice);
    const input: ModelRequest = {
      workspaceId: app.context.workspaceId,
      projectId: init.projectId,
      purpose: "normalize",
      provider: "ledger",
      model: "ledger-model",
      messages: [{ role: "user", content: prompt }],
      modelConfigHash: "ledger-config",
      promptVersion: "acceptance-1",
      schemaVersion: "1.0.0",
      sourceRevisionIds: [],
      inputRefs: [],
      locale: "en-US",
      policyHash: app.config.effectiveConfig.policyHash,
      responseSchema: "Money",
      deadlineMs: 5000,
      dataPolicy: {
        dataClasses: ["documents"],
        maxInputBytes: 32768,
        maxInputTokens: 32768,
        allowUnknownCost: true,
      },
    };
    expect((await gateway.complete(input)).output).toEqual({
      amount: 1,
      currency: "USD",
      scale: 2,
    });
    expect(completions).toBe(2);
    const firstRows = app.database.all<{ id: string; data_json: string }>(
      "SELECT id,data_json FROM model_calls ORDER BY created_at,id",
    );
    expect(firstRows.map((row) => JSON.parse(row.data_json).outcome).sort()).toEqual([
      "invalid",
      "success",
    ]);
    expect(firstRows.map((row) => JSON.parse(row.data_json).repairAttempt).sort()).toEqual([0, 1]);
    expect((await gateway.complete(input)).cacheHit).toBe(true);
    expect(completions).toBe(2);
    mode = "abort";
    const controller = new AbortController();
    const aborted = gateway.complete({ ...input, cache: false, signal: controller.signal });
    const rejection = expect(aborted).rejects.toMatchObject({ code: "PRECONDITION_FAILED" });
    await entered.promise;
    controller.abort();
    await rejection;
    expect(completions).toBe(3);
    mode = "healthy";
    await create({ ...oldPrice, version: "price-v2", inputPerMillion: "3000000" }).complete({
      ...input,
      cache: false,
    });
    for (const row of firstRows)
      expect(
        app.database.get("SELECT data_json FROM model_calls WHERE id=?", row.id)?.data_json,
      ).toBe(row.data_json);
    const ledger = app.database
      .all<{ data_json: string }>("SELECT data_json FROM model_calls ORDER BY created_at,id")
      .map((row) => JSON.parse(row.data_json));
    expect(ledger).toHaveLength(5);
    expect(ledger.filter((call) => call.priceTableVersion === "price-v1")).toHaveLength(4);
    expect(ledger.find((call) => call.priceTableVersion === "price-v2").cost.amount).toBe("80");
    expect(ledger.find((call) => call.outcome === "cancelled")).toMatchObject({
      cost: "unknown",
      costBasis: "unknown",
      usage: { inputTokens: null, outputTokens: null },
    });
    expect(ledger.find((call) => call.cacheHit)).toMatchObject({
      costBasis: "not_billed",
      cost: { amount: "0" },
      reservationId: null,
      usage: { inputTokens: 0, outputTokens: 0 },
    });
    expect(app.database.all("SELECT id FROM budget_reservations")).toHaveLength(4);
    expect(
      app.database.get("SELECT COUNT(*) AS n FROM budget_reservations WHERE state='settled'")?.n,
    ).toBe(4);
    const out = join(root, "usage.json");
    const cli = resolve("apps/cli/dist/main.js");
    await promisify(execFile)(
      process.execPath,
      [
        cli,
        "usage",
        "--project",
        init.projectId,
        "--model",
        "ledger-model",
        "--since",
        "2000-01-01T00:00:00.000Z",
        "--until",
        "2099-01-01T00:00:00.000Z",
        "--out",
        out,
        "--output",
        "json",
      ],
      { cwd: root, env: { ...process.env, HOME: home, TESTMASTER_DATA_DIR: app.config.dataDir } },
    );
    const bytes = await readFile(out, "utf8");
    const exported = JSON.parse(bytes);
    expect(exported.calls.map((call: { id: string }) => call.id).sort()).toEqual(
      ledger.map((call) => call.id).sort(),
    );
    expect(exported.estimatedCosts).toEqual([
      {
        amount: ledger
          .filter((call) => call.cost !== "unknown")
          .reduce((sum, call) => sum + BigInt(call.cost.amount), 0n)
          .toString(),
        currency: "USD",
        scale: 6,
      },
    ]);
    expect(exported.estimatedCosts[0].amount).toBe("160");
    expect(exported.billedCosts).toEqual([]);
    expect(exported.billingReconciliation).toMatchObject({
      status: "not_requested",
      divergence: null,
    });
    expect(exported.unknownCostCalls).toBe(1);
    expect(exported.cacheHitCalls).toBe(1);
    expect(exported.cachedInputTokens).toBe(21);
    expect(exported.measuredTokens).toEqual({
      inputTokens: 60,
      outputTokens: 30,
      reasoningTokens: 9,
    });
    expect(exported.tokens.inputTokens).toBeNull();
    expect(bytes).not.toContain(key);
    expect(bytes).not.toContain(prompt);
    expect(
      exported.calls.every((call: Record<string, unknown>) => !Object.hasOwn(call, "rawPrompt")),
    ).toBe(true);
    expect(completions).toBe(4);
    expect(inventories).toBe(3);
    expect(received).toHaveLength(4);
    expect(received.every((payload) => payload.includes(prompt))).toBe(true);
  } finally {
    app.close();
    server.closeAllConnections();
    await new Promise<void>((done) => server.close(() => done()));
    await rm(root, { recursive: true, force: true });
  }
}, 30000);
