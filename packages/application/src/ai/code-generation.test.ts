import { randomUUID } from "node:crypto";
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
    root,
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
  // Each candidate names its test and source revision; the retry covers only the rest.
  expect(details.candidates).toEqual([
    {
      revisionId: candidateIds[0],
      testId: f.app.revisions.get(created).testId,
      sourceRevisionId: created,
    },
  ]);
  expect(details.remainingRevisionIds).toEqual([cancelled]);
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

const profileCode = good
  .replace("{ request }", "{ profileRequest }")
  .replace("request.get", "profileRequest.get");

/** A revision whose plan sends its request with the environment's auth profile session. */
function profileRevisionOf(app: Application, projectId: string): string {
  const plan = scaffoldPlan("backend");
  const request = plan.steps.find((step) => step.operation === "request");
  if (request?.operation !== "request") throw new Error("Missing request step");
  request.input.auth = "profile";
  return String(app.tests.create({ projectId, plan }).activeRevisionId);
}

it("refuses code that sends a profile-auth plan step without the profile session, as repair feedback", async () => {
  const f = await fixture();
  const revisionId = profileRevisionOf(f.app, f.projectId);
  f.setOutput(generated(good));
  await expect(
    f.app.codeGeneration.generate({ projectId: f.projectId, revisionIds: [revisionId] }),
  ).rejects.toMatchObject({
    code: "INVALID_ARGUMENT",
    details: {
      validationErrors: [
        { path: revisionId, message: expect.stringContaining('with "auth": "profile"') },
      ],
    },
  });
  // The model was told how to authenticate and asked to repair: names the fixture, never the code.
  expect(secretPrompt(f.payloads[0])).toContain("profileRequest fixture");
  expect(secretPrompt(f.payloads[1])).toContain("destructure profileRequest");
  expect(f.counts().completions).toBe(3);
});

it("accepts the repaired code that uses the profile session and leaves a plan without profile steps alone", async () => {
  const f = await fixture();
  const revisionId = profileRevisionOf(f.app, f.projectId);
  f.queueOutputs(generated(good));
  f.setOutput(generated(profileCode));
  const receipt = await f.app.codeGeneration.generate({
    projectId: f.projectId,
    revisionIds: [revisionId],
  });
  expect(receipt.candidates).toHaveLength(1);
  expect(f.counts().completions).toBe(2);
  // Control: the same unauthenticated code passes for a plan that never asks for the profile.
  f.setOutput(generated(good));
  const plain = await f.app.codeGeneration.generate({
    projectId: f.projectId,
    revisionIds: [f.revisionOf()],
  });
  expect(plain.candidates).toHaveLength(1);
});

const SCHEMA_POINTER = "/paths/~1items/get/responses/200/content/application~1json/schema";
const itemsSchema = {
  type: "object",
  required: ["items"],
  additionalProperties: false,
  properties: { items: { type: "array", items: { type: "string" } } },
};

/** A revision whose plan asserts the response of GET /items against its OpenAPI response schema. */
async function schemaRevisionOf(app: Application, projectId: string, root: string) {
  await writeFile(
    join(root, "openapi.json"),
    JSON.stringify({
      openapi: "3.0.3",
      info: { title: "Items", version: "1" },
      paths: {
        "/items": {
          get: {
            responses: {
              "200": {
                description: "ok",
                content: { "application/json": { schema: { $ref: "#/components/schemas/Items" } } },
              },
            },
          },
        },
      },
      components: { schemas: { Items: itemsSchema } },
    }),
  );
  const source = await app.sources.add({
    projectId,
    role: "api-spec",
    path: join(root, "openapi.json"),
    format: "openapi",
  });
  const plan = scaffoldPlan("backend");
  const request = plan.steps.find((step) => step.operation === "request");
  if (request?.operation !== "request") throw new Error("Missing request step");
  plan.steps.push({
    id: "items-schema",
    kind: "assertion",
    operation: "assert",
    description: "The body matches the declared response schema",
    input: { responseStepId: request.id },
    expectation: {
      predicate: "jsonSchema",
      sourceRevisionId: source.revision.id,
      pointer: SCHEMA_POINTER,
    },
  });
  const revisionId = String(app.tests.create({ projectId, plan }).activeRevisionId);
  const schemaCode = `import { test, expect } from '@playwright/test';\ntest('items', async ({ request, sourceSchemas }) => { const response = await request.get('/items'); expect(response.status()).toBe(200); expect(sourceSchemas.violations('${source.revision.id}', '${SCHEMA_POINTER}', await response.json())).toEqual([]); });\n`;
  return { revisionId, sourceRevisionId: source.revision.id, schemaCode };
}

it("offers the cited source schemas by revision and pointer and freezes the checked schema into the code bundle and its export", async () => {
  const f = await fixture();
  const { revisionId, sourceRevisionId, schemaCode } = await schemaRevisionOf(
    f.app,
    f.projectId,
    f.root,
  );
  f.setOutput(generated(schemaCode));
  const receipt = await f.app.codeGeneration.generate({
    projectId: f.projectId,
    revisionIds: [revisionId],
  });
  const prompt = secretPrompt(f.payloads[0]);
  expect(prompt).toContain('"sourceSchemas":[');
  expect(prompt).toContain(sourceRevisionId);
  expect(prompt).toContain(SCHEMA_POINTER);
  // The schema document is frozen into the test, not sent to the model.
  expect(prompt).not.toContain('"required":["items"]');
  const [candidate] = receipt.candidates as unknown as { id: string; testId: string }[];
  if (!candidate) throw new Error("Missing candidate");
  const key = `${sourceRevisionId}${SCHEMA_POINTER}`;
  const { bundle } = await f.app.codeImport.readBundle(candidate.id);
  expect(Object.keys(bundle.schemas ?? {})).toEqual([key]);
  // The $ref is resolved into the frozen document, so the check sees the real constraints.
  expect(JSON.stringify(bundle.schemas)).toContain('"additionalProperties":false');
  const exported = await f.app.codeExport.export(candidate.testId, {
    format: "playwright",
    revisionId: candidate.id,
  });
  expect(JSON.parse(exported.files["testmaster-fixtures/schemas.json"] ?? "")).toEqual(
    bundle.schemas,
  );
});

it("sends code that never checks a cited schema back to the model, and refuses a schema the plan does not cite", async () => {
  const f = await fixture();
  const { revisionId, sourceRevisionId, schemaCode } = await schemaRevisionOf(
    f.app,
    f.projectId,
    f.root,
  );
  f.queueOutputs(generated(good));
  f.setOutput(generated(schemaCode));
  const receipt = await f.app.codeGeneration.generate({
    projectId: f.projectId,
    revisionIds: [revisionId],
  });
  expect(receipt.candidates).toHaveLength(1);
  expect(f.counts().completions).toBe(2);
  // The repair names the step and the schema, so the model can add the check it left out.
  const repair = secretPrompt(f.payloads[1]);
  expect(repair).toContain("against source schema");
  expect(repair).toContain(sourceRevisionId);
  // A schema outside the plan's citations is refused as repair feedback, never frozen in.
  f.setOutput(generated(schemaCode.replace(SCHEMA_POINTER, "/components/schemas/Other")));
  await expect(
    f.app.codeGeneration.generate({ projectId: f.projectId, revisionIds: [revisionId] }),
  ).rejects.toMatchObject({
    code: "INVALID_ARGUMENT",
    details: {
      validationErrors: [{ message: expect.stringContaining("is not available to this test") }],
    },
  });
});

it("code imported by hand as a revision of a test may check the schemas its plan cites, and no other", async () => {
  const f = await fixture();
  const { revisionId, sourceRevisionId, schemaCode } = await schemaRevisionOf(
    f.app,
    f.projectId,
    f.root,
  );
  const testId = String(f.app.revisions.get(revisionId).testId);
  await writeFile(join(f.root, "items.spec.ts"), schemaCode);
  const candidate = await f.app.codeImport.importRevision({
    testId,
    path: "items.spec.ts",
    format: "playwright",
  });
  const { bundle } = await f.app.codeImport.readBundle(candidate.id);
  expect(Object.keys(bundle.schemas ?? {})).toEqual([`${sourceRevisionId}${SCHEMA_POINTER}`]);
  // Control: a schema the plan does not cite stays refused.
  await writeFile(
    join(f.root, "other.spec.ts"),
    schemaCode.replace(SCHEMA_POINTER, "/components/schemas/Other"),
  );
  await expect(
    f.app.codeImport.importRevision({ testId, path: "other.spec.ts", format: "playwright" }),
  ).rejects.toMatchObject({
    code: "INVALID_ARGUMENT",
    message: expect.stringContaining("plan cites in jsonSchema assertions"),
  });
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

// ------------------------------------------------------------------ candidate repair

const repairedCode = good.replace(
  "toBe(200)",
  "toBe(200); expect(await response.text()).toContain('ok')",
);
/** A generated candidate and a completed Run of it that ended `outcome`, with one recorded step. */
async function candidateRun(
  f: Awaited<ReturnType<typeof fixture>>,
  outcome: "passed" | "failed",
  phase: "completed" | "running" = "completed",
  message = "expect(received).toBe(expected) Expected: 200 Received: 500",
) {
  const source = f.revisionOf();
  const receipt = await f.app.codeGeneration.generate({
    projectId: f.projectId,
    revisionIds: [source],
  });
  const candidate = receipt.candidates[0]!;
  const environment = f.app.environments.list(f.projectId)[0]!;
  const run = f.app.runs.prepare({
    testId: String(candidate.testId),
    environmentId: String(environment.id),
    revisionId: String(candidate.id),
  });
  Object.assign(run, {
    phase,
    status: phase === "completed" ? outcome : phase,
    outcome: phase === "completed" ? outcome : null,
    gate: phase === "completed" ? outcome : "pending",
  });
  const { context } = f.app;
  context.entities.insert("Run", run);
  const now = new Date().toISOString();
  const jobId = `job_${randomUUID()}`;
  const attemptId = `att_${randomUUID()}`;
  context.database.run(
    "INSERT INTO job_leases(workspace_id,id,created_at,queue,resource_id,available_at,data_json) VALUES(?,?,?,?,?,?,?)",
    context.workspaceId,
    jobId,
    now,
    "execution",
    run.id,
    now,
    "{}",
  );
  context.database.run(
    "INSERT INTO attempts(workspace_id,id,created_at,data_json,run_id,number,phase,outcome,job_id,fence,lease_owner) VALUES(?,?,?,?,?,?,?,?,?,?,?)",
    context.workspaceId,
    attemptId,
    now,
    "{}",
    run.id,
    1,
    "completed",
    outcome,
    jobId,
    1,
    "test",
  );
  context.entities.insert("StepResult", {
    id: `stp_${randomUUID()}`,
    attemptId,
    planStepId: "code-step-1",
    title: "health answers 200",
    index: 0,
    status: outcome,
    ...(outcome === "failed" ? { reasonCode: "assertion_mismatch" } : {}),
    expected: 200,
    observed: outcome === "failed" ? 500 : 200,
    error: outcome === "failed" ? { code: "Error", message } : null,
    durationMs: 1,
    evidenceRefs: [],
    workspaceId: context.workspaceId,
  });
  return { source, candidate, run };
}
const promptOf = (payload: Record<string, unknown> | undefined) =>
  ((payload?.messages ?? []) as { content: string }[]).map((message) => message.content).join("\n");

it("repairs a failed candidate from its files, its plan and the run's failed steps into a child candidate", async () => {
  const f = await fixture();
  process.env.TESTMASTER_REPAIR_TOKEN = "repair-secret-value-0042";
  try {
    const { source, candidate, run } = await candidateRun(
      f,
      "failed",
      "completed",
      "Expected: 200 Received: 500 while sending repair-secret-value-0042",
    );
    f.setOutput(generated(repairedCode));
    const before = f.counts().completions;
    const receipt = await f.app.codeGeneration.generate({ projectId: f.projectId, runId: run.id });
    expect(f.counts().completions).toBe(before + 1);
    const prompt = promptOf(f.payloads.at(-1));
    // The candidate's code, the failed step and the plan it was generated from reach the model.
    expect(prompt).toContain("const response = await request.get('/health')");
    expect(prompt).toContain("health answers 200");
    expect(prompt).toContain("Expected: 200 Received: 500");
    expect(prompt).toContain(
      JSON.stringify((f.app.revisions.get(source).plan as { steps: unknown[] }).steps[0]).slice(
        0,
        40,
      ),
    );
    expect(prompt).toContain("never weaken, loosen or drop an assertion");
    // Secret values in the recorded messages are masked before the call.
    expect(prompt).not.toContain("repair-secret-value-0042");
    expect(receipt).toMatchObject({ requested: 1, validationErrors: [] });
    const repaired = receipt.candidates[0]!;
    expect(repaired).toMatchObject({
      testId: candidate.testId,
      parentId: candidate.id,
      origin: "generated",
      plan: null,
      extensions: expect.objectContaining({ "testmaster:repairedFromRunId": run.id }),
    });
    expect(
      (await f.app.codeImport.readBundle(String(repaired.id))).bundle.files["generated.spec.ts"],
    ).toBe(repairedCode);
  } finally {
    delete process.env.TESTMASTER_REPAIR_TOKEN;
  }
});

it("refuses a repair before any model call for a passed or unfinished run, a plan revision and a mixed selection", async () => {
  const f = await fixture();
  const passed = await candidateRun(f, "passed");
  const running = await candidateRun(f, "failed", "running");
  const environment = f.app.environments.list(f.projectId)[0]!;
  const planRun = f.app.runs.prepare({
    testId: String(f.app.revisions.get(passed.source).testId),
    environmentId: String(environment.id),
    revisionId: passed.source,
  });
  Object.assign(planRun, {
    phase: "completed",
    status: "failed",
    outcome: "failed",
    gate: "failed",
  });
  f.app.context.entities.insert("Run", planRun);
  const before = f.counts().completions;
  const revisions = f.revisionCount();
  const refused = (runId: string) =>
    f.app.codeGeneration.generate({ projectId: f.projectId, runId });
  await expect(refused(passed.run.id)).rejects.toMatchObject({
    code: "PRECONDITION_FAILED",
    details: { reasonCode: "run_not_failed" },
  });
  await expect(refused(running.run.id)).rejects.toMatchObject({
    code: "PRECONDITION_FAILED",
    details: { reasonCode: "run_not_completed" },
  });
  await expect(refused(planRun.id)).rejects.toMatchObject({
    code: "PRECONDITION_FAILED",
    details: { reasonCode: "plan_revision" },
    message: expect.stringContaining("testmaster_propose_healing"),
  });
  await expect(
    f.app.codeGeneration.generate({
      projectId: f.projectId,
      runId: passed.run.id,
      revisionIds: [passed.source],
    }),
  ).rejects.toMatchObject({ code: "INVALID_ARGUMENT", message: expect.stringContaining("runId") });
  expect(f.counts().completions).toBe(before);
  expect(f.revisionCount()).toBe(revisions);
});

it("the importer still refuses forbidden code in a repair", async () => {
  const f = await fixture();
  const { run } = await candidateRun(f, "failed");
  const revisions = f.revisionCount();
  f.setOutput(generated(hostAccess));
  await expect(
    f.app.codeGeneration.generate({ projectId: f.projectId, runId: run.id }),
  ).rejects.toMatchObject({
    code: "INVALID_ARGUMENT",
    details: {
      reasonCode: "generated_code_refused",
      validationErrors: [
        { message: 'Runtime code, shell and host access are forbidden: "process" at line 2' },
      ],
    },
  });
  expect(f.revisionCount()).toBe(revisions);
});
