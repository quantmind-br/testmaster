import { createServer, type Server } from "node:http";

/**
 * A local OpenAI-compatible provider for journeys that need model answers without any paid call.
 * The portal journeys point the server's model profile at it and script each answer.
 */
export interface FakeModel {
  readonly origin: string;
  /** Request bodies received, oldest first. */
  readonly payloads: Record<string, unknown>[];
  setOutput(value: unknown): void;
  /** Resolves when the next completion request reaches the provider. */
  completionArrived(): Promise<void>;
  /** Resolves when a completion request is abandoned by the caller before it was answered. */
  completionAborted(): Promise<void>;
  /** Makes completions wait until the returned release function is called. */
  holdResponses(): () => void;
  /** Files (relative to HOME) that register this provider as the default profile. */
  homeFiles(): Record<string, string>;
  close(): Promise<void>;
}

export const fakeModelEnv = { FAKE_KEY: "fake-key" } as const;

export async function startFakeModel(): Promise<FakeModel> {
  const payloads: Record<string, unknown>[] = [];
  let output: unknown = {};
  let hold: Promise<void> | null = null;
  let arrival: PromiseWithResolvers<void> | null = null;
  let abandoned: PromiseWithResolvers<void> | null = null;
  const server: Server = createServer(async (request, response) => {
    if (request.url === "/v1/models") {
      response.end(JSON.stringify({ data: [{ id: "model" }] }));
      return;
    }
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(Buffer.from(chunk));
    const payload = JSON.parse(Buffer.concat(chunks).toString()) as Record<string, unknown>;
    payloads.push(payload);
    arrival?.resolve();
    response.once("close", () => {
      if (!response.writableFinished) abandoned?.resolve();
    });
    if (hold) await hold;
    if (response.destroyed) return;
    const reconciliation = (payload.messages as { content: string }[]).some((message) =>
      message.content.includes("Compare the normalized statements"),
    );
    const current = output as { conflicts?: unknown };
    response.end(
      JSON.stringify({
        model: "model",
        choices: [
          {
            message: {
              content: JSON.stringify(
                reconciliation ? { conflicts: current.conflicts ?? [], openQuestions: [] } : output,
              ),
              reasoning_content: "Checked required fields.",
            },
            finish_reason: "stop",
          },
        ],
        usage: {
          prompt_tokens: 20,
          completion_tokens: 10,
          completion_tokens_details: { reasoning_tokens: 3 },
        },
      }),
    );
  });
  const listening = Promise.withResolvers<void>();
  server.listen(0, "127.0.0.1", listening.resolve);
  await listening.promise;
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Fake model has no address");
  const origin = `http://127.0.0.1:${address.port}`;
  return {
    origin,
    payloads,
    setOutput(value) {
      output = value;
    },
    completionArrived() {
      arrival = Promise.withResolvers<void>();
      return arrival.promise;
    },
    completionAborted() {
      abandoned = Promise.withResolvers<void>();
      return abandoned.promise;
    },
    holdResponses() {
      const gate = Promise.withResolvers<void>();
      hold = gate.promise;
      return () => {
        gate.resolve();
        hold = null;
      };
    },
    homeFiles() {
      return {
        ".config/testmaster/profiles.json": JSON.stringify({
          defaultProfile: "test",
          profiles: {
            test: {
              modelProviders: [
                {
                  id: "fake",
                  kind: "openai-compatible",
                  baseUrl: `${origin}/v1`,
                  apiKeyEnv: "FAKE_KEY",
                  models: [
                    {
                      id: "model",
                      capabilities: {
                        structuredJson: true,
                        toolCalls: true,
                        maxOutputTokens: 1024,
                      },
                    },
                  ],
                },
              ],
            },
          },
        }),
        ".config/testmaster/policy.json": JSON.stringify({ allowedModelProviders: ["fake"] }),
      };
    },
    async close() {
      server.closeAllConnections();
      const closed = Promise.withResolvers<void>();
      server.close(() => closed.resolve());
      await closed.promise;
    },
  };
}
