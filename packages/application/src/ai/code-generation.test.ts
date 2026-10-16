import { once } from "node:events";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ContractError } from "@testmaster/contracts";
import { CODE_IMPORT_RULES } from "@testmaster/planner";
import { afterEach, expect, it, vi } from "vitest";
import { completion, testProvider } from "../../../model-gateway/src/test-support.js";
import { Application } from "../application.js";
import { scaffoldPlan } from "../authoring.js";
import { admissionSnapshot } from "../provenance.js";
import { ModelService } from "./model.js";

const roots: string[] = [];
const apps: Application[] = [];
const servers: Server[] = [];
afterEach(async () => {
  for (const app of apps.splice(0)) app.close();
  for (const server of servers.splice(0)) {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
  delete process.env.FAKE_KEY;
});

const good =
  "import { test, expect } from '@playwright/test';\ntest('health', async ({ request }) => { const response = await request.get('/health'); expect(response.status()).toBe(200); });\n";
// `process.env` is the idiom a model reaches for to find the base URL; the importer refuses it.
const hostAccess = good.replace("'/health'", "process.env.BASE_URL + '/health'");
const generated = (code: string) => ({ code, format: "playwright" });

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "tm-code-generation-"));
  roots.push(root);
  const home = join(root, "home");
  await mkdir(join(home, ".config/testmaster"), { recursive: true });
  let requests = 0;
  let completions = 0;
  const payloads: Record<string, unknown>[] = [];
  const queued: unknown[] = [];
  // Per next completion: true = the server never answers and holds it until the client gives up.
  const hangPlan: boolean[] = [];
  let onHang: () => void = () => undefined;
  let output: unknown = generated(good);
  const server = createServer(async (request, response) => {
    requests++;
    if (request.url === "/v1/models") {
      response.end(JSON.stringify({ data: [{ id: "model" }] }));
      return;
    }
    completions++;
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(Buffer.from(chunk));
    payloads.push(JSON.parse(Buffer.concat(chunks).toString()));
    if (hangPlan.shift()) {
      onHang();
      await once(response, "close");
      return;
    }
    const content = queued.length ? queued.shift() : output;
    response.end(
      JSON.stringify({
        ...completion,
        choices: [{ message: { content: JSON.stringify(content) }, finish_reason: "stop" }],
      }),
    );
  });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Missing address");
  await writeFile(
    join(home, ".config/testmaster/profiles.json"),
    JSON.stringify({
      defaultProfile: "test",
      profiles: {
        test: {
          modelProviders: [{ ...testProvider, baseUrl: `http://127.0.0.1:${address.port}/v1` }],
        },
      },
    }),
  );
  await writeFile(
    join(home, ".config/testmaster/policy.json"),
    JSON.stringify({ allowedModelProviders: ["fake"] }),
  );
  process.env.FAKE_KEY = "fake-key";
  const app = await Application.open({ cwd: root, home, env: { HOME: home } });
  apps.push(app);
  const initialized = await app.init();
  const revisionOf = () =>
    String(
      app.tests.create({ projectId: initialized.projectId, plan: scaffoldPlan("backend") })
        .activeRevisionId,
    );
  const revisionCount = () =>
    Number(app.database.get("SELECT COUNT(*) AS n FROM test_revisions")?.n ?? 0);
  return {
    app,
    projectId: initialized.projectId,
    payloads,
    revisionOf,
    revisionCount,
    setOutput(value: unknown) {
      output = value;
    },
    queueOutputs(...values: unknown[]) {
      queued.push(...values);
    },
    hangCompletions(plan: boolean[], arrived?: () => void) {
      hangPlan.push(...plan);
      if (arrived) onHang = arrived;
    },
    counts: () => ({ requests, completions }),
  };
}

it("every candidate refused after the repairs is an INVALID_ARGUMENT error naming the refused identifier and line", async () => {
  const f = await fixture();
  const revisionId = f.revisionOf();
  const before = f.revisionCount();
  f.setOutput(generated(hostAccess));
  await expect(
    f.app.codeGeneration.generate({ projectId: f.projectId, revisionIds: [revisionId] }),
  ).rejects.toMatchObject({
    code: "INVALID_ARGUMENT",
    message: "No generated candidate passed the import checks",
    details: {
      reasonCode: "generated_code_refused",
      requested: 1,
      validationErrors: [
        {
          path: revisionId,
          message: 'Runtime code, shell and host access are forbidden: "process" at line 2',
        },
      ],
      modelCallIds: [expect.stringMatching(/^mdl_/u)],
    },
  });
  // The importer ran as the response check: the model was asked to repair twice, and every
  // attempt is recorded invalid with the refused rule instead of success.
  expect(f.counts().completions).toBe(3);
  const calls = f.app.usage.get({ projectId: f.projectId }).calls;
  expect(calls.map((call) => call.outcome)).toEqual(["invalid", "invalid", "invalid"]);
  expect(f.revisionCount()).toBe(before);
});

it("a refused candidate is repaired from the importer's feedback and the prompt states the rules", async () => {
  const f = await fixture();
  const revisionId = f.revisionOf();
  f.queueOutputs(generated(hostAccess));
  const receipt = await f.app.codeGeneration.generate({
    projectId: f.projectId,
    revisionIds: [revisionId],
  });
  expect(f.counts().completions).toBe(2);
  expect(receipt).toMatchObject({ requested: 1, validationErrors: [] });
  expect(receipt.candidates).toHaveLength(1);
  const prompt = (payload: Record<string, unknown> | undefined) =>
    ((payload?.messages ?? []) as { content: string }[])
      .map((message) => message.content)
      .join("\n");
  // Prompt and importer share one rule list, so the model is told what will be refused.
  for (const rule of CODE_IMPORT_RULES) expect(prompt(f.payloads[0])).toContain(rule);
  // The repair names the rule, the identifier and the line, never the model's code.
  expect(prompt(f.payloads[1])).toContain("Runtime code, shell and host access are forbidden");
  expect(prompt(f.payloads[1])).toContain("process");
  expect(prompt(f.payloads[1])).toContain("at line 2");
  expect(prompt(f.payloads[1])).not.toContain("BASE_URL");
});

it("a partly refused batch keeps the passing candidate and lists the refused one", async () => {
  const f = await fixture();
  const accepted = f.revisionOf();
  const refused = f.revisionOf();
  f.queueOutputs(generated(good));
  f.setOutput(generated(hostAccess));
  const receipt = await f.app.codeGeneration.generate({
    projectId: f.projectId,
    revisionIds: [accepted, refused],
  });
  expect(receipt.requested).toBe(2);
  expect(receipt.candidates).toHaveLength(1);
  expect(receipt.validationErrors).toEqual([
    {
      path: refused,
      message: 'Runtime code, shell and host access are forbidden: "process" at line 2',
    },
  ]);
});

it("an unknown provider or model is refused before any model call, and an explicit choice is forwarded", async () => {
  const f = await fixture();
  const revisionId = f.revisionOf();
  const request = { projectId: f.projectId, revisionIds: [revisionId] };
  await expect(
    f.app.codeGeneration.generate({ ...request, model: "absent" }),
  ).rejects.toMatchObject({
    code: "CAPABILITY_UNAVAILABLE",
    details: { reasonCode: "model_not_configured", availableModels: ["model"] },
  });
  await expect(
    f.app.codeGeneration.generate({ ...request, provider: "missing" }),
  ).rejects.toMatchObject({
    code: "CAPABILITY_UNAVAILABLE",
    details: { reasonCode: "provider_unavailable" },
  });
  expect(f.counts()).toEqual({ requests: 0, completions: 0 });
  expect(f.app.usage.get({ projectId: f.projectId }).calls).toEqual([]);
  // Control: the declared provider and model go through and reach the wire.
  const receipt = await f.app.codeGeneration.generate({
    ...request,
    provider: "fake",
    model: "model",
  });
  expect(receipt.candidates).toHaveLength(1);
  expect(f.payloads[0]).toMatchObject({ model: "model" });
});

it("a cancellation stays fatal and its details list the candidates created before it", async () => {
  const f = await fixture();
  const created = f.revisionOf();
  const cancelled = f.revisionOf();
  const controller = new AbortController();
  // The second revision's call reaches the server and hangs; the caller then cancels.
  f.hangCompletions([false, true], () => controller.abort());
  const failure = await f.app.codeGeneration
    .generate({ projectId: f.projectId, revisionIds: [created, cancelled] }, controller.signal)
    .catch((error: unknown) => error);
  expect(failure).toMatchObject({
    code: "PRECONDITION_FAILED",
    details: { requested: 2, candidateRevisionIds: [expect.stringMatching(/^rev_/u)] },
  });
  const details = (failure as ContractError).details;
  const candidateIds = details.candidateRevisionIds as string[];
  expect(candidateIds).toHaveLength(1);
  expect(f.app.revisions.get(String(candidateIds[0])).id).toBe(candidateIds[0]);
  // The accepted call and the cancelled request, which is recorded and may be billed.
  expect(details.modelCallIds).toEqual([
    expect.stringMatching(/^mdl_/u),
    expect.stringMatching(/^mdl_/u),
  ]);
});

const secretCode = good.replace(
  "request.get('/health')",
  "request.get('/health', { headers: { authorization: secrets.get('API_KEY') } })",
);
const secretPrompt = (payload: Record<string, unknown> | undefined) =>
  ((payload?.messages ?? []) as { content: string }[]).map((message) => message.content).join("\n");

it("offers the secrets the environment origins allow by name and id, never a value, and stores the bindings with the model call", async () => {
  const f = await fixture();
  const origin = "http://127.0.0.1:4010";
  f.app.environments.create({
    projectId: f.projectId,
    name: "target",
    baseUrl: origin,
    networkProfile: "local-loopback",
    authRefs: [],
  });
  const value = "canary-secret-value-4f9c";
  const api = await f.app.secrets.set("API_KEY", value, {
    allowedOrigins: [origin],
    ephemeral: true,
  });
  await f.app.secrets.set("ELSEWHERE", value, {
    allowedOrigins: ["http://127.0.0.1:4011"],
    ephemeral: true,
  });
  await f.app.secrets.set("UNBOUND", value, { ephemeral: true });
  f.setOutput(generated(secretCode));
  const receipt = await f.app.codeGeneration.generate({
    projectId: f.projectId,
    revisionIds: [f.revisionOf()],
  });
  const prompt = secretPrompt(f.payloads[0]);
  expect(prompt).toContain("secrets.get(NAME)");
  expect(prompt).toContain(api.id);
  expect(prompt).toContain(origin);
  expect(prompt).not.toContain("ELSEWHERE");
  expect(prompt).not.toContain("UNBOUND");
  expect(prompt).not.toContain(value);
  expect(receipt.candidates).toHaveLength(1);
  const [candidate] = receipt.candidates as unknown as {
    codeRef: { secretRefs: unknown[] };
    extensions: Record<string, unknown>;
  }[];
  expect(candidate?.codeRef.secretRefs).toEqual([{ name: "API_KEY", secretRef: api.id }]);
  const calls = f.app.usage.get({ projectId: f.projectId }).calls;
  expect(candidate?.extensions["testmaster:generationModelCallId"]).toBe(calls[0]?.id);
});

it("refuses generated code that reads a secret the environment does not offer", async () => {
  const f = await fixture();
  const origin = "http://127.0.0.1:4010";
  f.app.environments.create({
    projectId: f.projectId,
    name: "target",
    baseUrl: origin,
    networkProfile: "local-loopback",
    authRefs: [],
  });
  await f.app.secrets.set("ELSEWHERE", "v", {
    allowedOrigins: ["http://127.0.0.1:4011"],
    ephemeral: true,
  });
  f.setOutput(generated(secretCode.replace("API_KEY", "ELSEWHERE")));
  await expect(
    f.app.codeGeneration.generate({ projectId: f.projectId, revisionIds: [f.revisionOf()] }),
  ).rejects.toMatchObject({
    code: "INVALID_ARGUMENT",
    details: {
      validationErrors: [{ message: 'Secret "ELSEWHERE" is not declared for this test at line 2' }],
    },
  });
  // The repair feedback names the rule and the secret, never the model's code or a value.
  expect(secretPrompt(f.payloads[1])).toContain("is not declared for this test");
});

it("a generated code revision's admission snapshot names the generating call and its configuration hash", async () => {
  const f = await fixture();
  f.setOutput(generated(good));
  const receipt = await f.app.codeGeneration.generate({
    projectId: f.projectId,
    revisionIds: [f.revisionOf()],
  });
  const candidate = receipt.candidates[0] as { id: string };
  const revision = f.app.revisions.get(candidate.id);
  const environment = f.app.environments.list(f.projectId)[0];
  const envRevision = f.app.context.entities.get(
    "EnvironmentRevision",
    f.app.context.workspaceId,
    String(environment?.activeRevisionId),
  );
  if (!envRevision) throw new Error("Missing environment revision");
  const call = f.app.usage.get({ projectId: f.projectId }).calls[0];
  const snapshot = admissionSnapshot(f.app.context, revision, envRevision, f.app.config, null, 0);
  expect(snapshot.generationModelCallId).toBe(call?.id);
  expect(snapshot.modelConfigHash).toMatch(/^[0-9a-f]{64}$/u);
  expect(snapshot.generationModel).toMatchObject({ id: call?.id });
  expect(snapshot.limitations).not.toContain("generation-model-config-hash-unavailable");
});
