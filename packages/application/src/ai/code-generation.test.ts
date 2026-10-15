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
import { CODE_GENERATION_DEADLINE_MS, CODE_GENERATION_DEADLINE_REASON } from "./code-generation.js";
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

it("each revision's model call gets budget.deadlineMs, default 300000, and an out-of-range deadline is refused before any call", async () => {
  const f = await fixture();
  const request = { projectId: f.projectId, revisionIds: [f.revisionOf()] };
  const complete = vi.spyOn(ModelService.prototype, "complete");
  try {
    await f.app.codeGeneration.generate(request);
    expect(complete.mock.calls[0]?.[0].deadlineMs).toBe(CODE_GENERATION_DEADLINE_MS);
    expect(CODE_GENERATION_DEADLINE_MS).toBe(300000);
    await f.app.codeGeneration.generate({ ...request, budget: { deadlineMs: 600000 } });
    expect(complete.mock.calls[1]?.[0].deadlineMs).toBe(600000);
    const calls = complete.mock.calls.length;
    for (const deadlineMs of [0, 600001, 1.5, -1])
      await expect(
        f.app.codeGeneration.generate({ ...request, budget: { deadlineMs } }),
      ).rejects.toMatchObject({ code: "INVALID_ARGUMENT" });
    expect(complete.mock.calls).toHaveLength(calls);
    expect(f.counts().completions).toBe(2);
  } finally {
    complete.mockRestore();
  }
});

it("a revision whose model call reaches the deadline is listed and the next revision still produces a candidate", async () => {
  const f = await fixture();
  const slow = f.revisionOf();
  const next = f.revisionOf();
  f.hangCompletions([true, false]);
  const receipt = await f.app.codeGeneration.generate({
    projectId: f.projectId,
    revisionIds: [slow, next],
    budget: { deadlineMs: 1000 },
  });
  expect(receipt.requested).toBe(2);
  expect(receipt.candidates).toHaveLength(1);
  expect(receipt.validationErrors).toEqual([
    {
      path: slow,
      message: "Model call reached its 1000 ms deadline, repairs included",
      reasonCode: CODE_GENERATION_DEADLINE_REASON,
      // The cut request is recorded and may be billed, so it is named.
      modelCallId: expect.stringMatching(/^mdl_/u),
    },
  ]);
  expect(f.counts().completions).toBe(2);
});

it("every revision reaching the deadline is UPSTREAM_TIMEOUT listing each revision", async () => {
  const f = await fixture();
  const only = f.revisionOf();
  const before = f.revisionCount();
  f.hangCompletions([true]);
  await expect(
    f.app.codeGeneration.generate({
      projectId: f.projectId,
      revisionIds: [only],
      budget: { deadlineMs: 1000 },
    }),
  ).rejects.toMatchObject({
    code: "UPSTREAM_TIMEOUT",
    details: {
      reasonCode: CODE_GENERATION_DEADLINE_REASON,
      requested: 1,
      deadlineMs: 1000,
      validationErrors: [{ path: only, reasonCode: CODE_GENERATION_DEADLINE_REASON }],
      modelCallIds: [expect.stringMatching(/^mdl_/u)],
    },
  });
  expect(f.revisionCount()).toBe(before);
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
