import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect } from "vitest";
import { type Journey, type JourneyMetadata, text } from "./harness.js";

export const provider = "quantforge";
export const model = "qwen3.8-flash";
export const metadata: JourneyMetadata = {
  class: "live-model-e2e",
  runner: "real-cli-and-model",
  externalDependency: "https://api.quantforge.com.br/v1",
  provider,
  model,
  limitations: ["Live model generation and authoring only; no execution or passing-test claim."],
};

export async function configureModel(session: Journey): Promise<string> {
  expect(process.env.QUANTFORGE_API_KEY, "A real model API key is required").toBeTruthy();
  session.env.TESTMASTER_OFFLINE = "false";
  const configHome = join(session.home, ".config/testmaster");
  await mkdir(configHome, { recursive: true });
  await writeFile(
    join(configHome, "profiles.json"),
    JSON.stringify({
      defaultProfile: "live",
      profiles: {
        live: {
          modelProviders: [
            {
              id: provider,
              kind: "openai-compatible",
              baseUrl: metadata.externalDependency,
              apiKeyEnv: "QUANTFORGE_API_KEY",
              models: [
                {
                  id: model,
                  capabilities: {
                    structuredJson: true,
                    toolCalls: true,
                    contextTokens: 128000,
                    maxOutputTokens: 32768,
                  },
                },
              ],
            },
          ],
        },
      },
    }),
  );
  await writeFile(
    join(configHome, "policy.json"),
    JSON.stringify({ allowedModelProviders: [provider] }),
  );
  const identity = await session.init("http://127.0.0.1:8080");
  await session.command([
    "consent",
    "grant",
    "--provider",
    provider,
    "--allow-unknown-cost",
    "--data-class",
    "documents",
    "code_summary",
    "requirements",
    "plans",
  ]);
  const consent = await session.command(["consent", "status", "--provider", provider]);
  expect(consent.consent).toMatchObject({ revokedAt: null });
  return text(identity.projectId);
}

export async function source(
  session: Journey,
  basename: string,
  content: string,
  role = "prd",
  format = "markdown",
) {
  await writeFile(join(session.cwd, basename), content);
  return session.command(["source", "add", basename, "--role", role, "--format", format]);
}
