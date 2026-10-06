import { mkdir, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { join } from "node:path";
import { expect, it } from "vitest";
import { controlledShop, healthPlan, items, journey, object, text } from "./harness.js";
import { source } from "./m2-support.js";

it("VAL-009 token exhaustion mid-normalization preserves an admitted Docker Run and attributed evidence", async () => {
  let completions = 0;
  let release: (() => void) | undefined;
  const received = Promise.withResolvers<void>();
  const provider = createServer(async (request, response) => {
    if (request.url === "/v1/models") {
      response.end(JSON.stringify({ data: [{ id: "accounting-model" }] }));
      return;
    }
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(Buffer.from(chunk));
    const body = JSON.parse(Buffer.concat(chunks).toString()) as {
      messages: { content: string }[];
    };
    const user = body.messages.find((message) => message.content.includes('"untrustedData"'));
    const input = JSON.parse(user?.content ?? "{}").untrustedData as {
      chunks: { evidenceRef: unknown }[];
    };
    completions++;
    received.resolve();
    await new Promise<void>((resolve) => {
      release = resolve;
    });
    response.end(
      JSON.stringify({
        model: "accounting-model",
        choices: [
          {
            finish_reason: "stop",
            message: {
              content: JSON.stringify({
                requirements: [
                  {
                    key: "health",
                    text: "Health reports ok",
                    acceptanceCriteria: ["GET /health status is ok"],
                    sourceRefs: [input.chunks[0]?.evidenceRef],
                    originKind: "explicit",
                    confidence: null,
                    reason: "Explicit PRD",
                  },
                ],
                conflicts: [],
                openQuestions: [],
              }),
            },
          },
        ],
        usage: { prompt_tokens: 20, completion_tokens: 10 },
      }),
    );
  });
  await new Promise<void>((resolve) => provider.listen(0, "127.0.0.1", resolve));
  const address = provider.address();
  if (!address || typeof address === "string") throw new Error("Provider address unavailable");
  try {
    await journey(
      "val009-model-budget-isolation",
      async (session) => {
        const target = await controlledShop("healthy");
        try {
          const config = join(session.home, ".config/testmaster");
          await mkdir(config, { recursive: true });
          await writeFile(
            join(config, "profiles.json"),
            JSON.stringify({
              defaultProfile: "accounting",
              profiles: {
                accounting: {
                  modelProviders: [
                    {
                      id: "accounting",
                      kind: "openai-compatible",
                      baseUrl: `http://127.0.0.1:${address.port}/v1`,
                      apiKeyEnv: "ACCOUNTING_KEY",
                      models: [
                        {
                          id: "accounting-model",
                          capabilities: { structuredJson: true, maxOutputTokens: 1024 },
                        },
                      ],
                    },
                  ],
                },
              },
            }),
          );
          await writeFile(
            join(config, "policy.json"),
            JSON.stringify({ allowedModelProviders: ["accounting"] }),
          );
          session.env.ACCOUNTING_KEY = "local-accounting-key";
          session.env.TESTMASTER_OFFLINE = "false";
          const identity = await session.init(target.url);
          await session.command([
            "consent",
            "grant",
            "--provider",
            "accounting",
            "--data-class",
            "documents",
          ]);
          const prd = await source(
            session,
            "PRD.md",
            Array.from(
              { length: 12 },
              (_, index) =>
                `# Health requirement ${index}\nThe GET /health endpoint must report ok.\n`,
            ).join("\n"),
          );
          const normalize = [
            "requirement",
            "normalize",
            "--source-revision",
            text(object(prd.revision).id),
          ];
          const denied = await session.command(normalize, 9);
          expect(object(denied.error).code).toBe("POLICY_DENIED");
          expect(completions).toBe(0);
          await session.command([
            "consent",
            "grant",
            "--provider",
            "accounting",
            "--allow-unknown-cost",
            "--data-class",
            "documents",
          ]);
          await session.command(["budget", "set", "--tokens", "100000"]);
          const test = await session.createTest(healthPlan());
          await session.worker();
          const admitted = await session.command(["test", "run", text(test.id)]);
          const runId = text(admitted.runId);
          const generating = session.start(normalize);
          await received.promise;
          await session.command(["budget", "set", "--tokens", "30"]);
          release?.();
          const stopped = await generating.result;
          expect(stopped.exitCode, stopped.stdout).toBe(12);
          expect(object(object(stopped.json).error).code).toBe("QUOTA_EXCEEDED");
          expect(completions).toBe(1);
          expect(items((await session.command(["requirement", "list"])).items)).toHaveLength(0);
          const run = await session.observe(runId, (value) => value.phase === "completed");
          expect(run.outcome).toBe("passed");
          const evidence = await session.command(["artifact", "get", runId]);
          const manifest = object(evidence.manifest);
          expect(items(manifest.entries).some((entry) => entry.state === "available")).toBe(true);
          const usage = await session.command(["usage", "--project", text(identity.projectId)]);
          expect(object(usage.tokens)).toMatchObject({ inputTokens: 20, outputTokens: 10 });
          expect(object(usage.tokenBudget)).toMatchObject({ used: 30, remaining: 0 });
          expect(usage.unknownCostCalls).toBe(1);
          expect(Number(usage.runtimeMs)).toBeGreaterThan(0);
          expect(Number(usage.storageBytes)).toBeGreaterThan(0);
          expect(
            items(usage.runs).find((value) => value.runId === runId)?.storageBytes,
          ).toBeGreaterThan(0);
          session.oracles.push({
            check: "modelQuotaDoesNotCancelDeterministicRun",
            runId,
            outcome: run.outcome,
            modelCalls: completions,
            tokenBudget: usage.tokenBudget,
            runtimeMs: usage.runtimeMs,
            storageBytes: usage.storageBytes,
            integrity: evidence.integrity ?? "verified-by-bundle-reader",
          });
        } finally {
          await target.close();
        }
      },
      {
        class: "budget-accounting-e2e",
        runner: "real-cli-docker-and-local-provider",
        externalDependency: "local-reference-shop-and-openai-compatible-http-double",
        limitations: [
          "HTTP double exercises accounting and exhaustion only, not model quality; deterministic target and sandbox are real.",
        ],
      },
    );
  } finally {
    release?.();
    provider.closeAllConnections();
    await new Promise<void>((resolve) => provider.close(() => resolve()));
  }
}, 240000);
