import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ContractError, type ProbeSpec } from "@testmaster/contracts";
import { afterEach, describe, expect, it } from "vitest";
import { Application } from "./application.js";

const roots: string[] = [];
const apps: Application[] = [];
afterEach(async () => {
  for (const app of apps.splice(0)) app.close();
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

const description = {
  openapi: "3.1.0",
  info: { title: "shop", version: "1" },
  paths: {
    "/api/products": {
      get: { responses: { "200": { description: "ok" } } },
    },
    "/api/products/{id}": {
      parameters: [{ name: "id", in: "path", required: true, schema: { type: "integer" } }],
      get: { responses: { "200": { description: "ok" } } },
    },
  },
};

async function open() {
  const root = await mkdtemp(join(tmpdir(), "tm-probes-"));
  roots.push(root);
  const home = join(root, "home");
  await mkdir(home);
  const app = await Application.open({ cwd: root, home, env: {} });
  apps.push(app);
  const init = await app.init();
  app.preflight = async () => {};
  await writeFile(join(root, "openapi.json"), JSON.stringify(description));
  const source = await app.sources.add({
    projectId: init.projectId,
    role: "api-spec",
    path: join(root, "openapi.json"),
    format: "openapi",
  });
  const probe: ProbeSpec = {
    kind: "property",
    api: "openapi",
    sourceRevisionId: source.revision.id,
    stateful: false,
  };
  return { app, init, probe };
}

async function refusalOf(call: () => unknown): Promise<ContractError> {
  try {
    await call();
  } catch (error) {
    if (error instanceof ContractError) return error;
    throw error;
  }
  throw new Error("the call was accepted");
}

describe("M5-05 property probes", () => {
  it("REQ-050 every probe Run needs its own bound securityProbe approval, outside production too", async () => {
    const { app, init, probe } = await open();
    const test = app.tests.createProbe(init.projectId, { spec: probe });
    const request = {
      testId: test.id,
      environmentId: init.environmentId,
      seed: 7,
      extensions: { "testmaster:executor": "docker" },
    };
    // No worker runs here: admitted Runs stay queued.
    const queue = { wait: true };
    const required = await refusalOf(() => app.runs.admit(request, queue));
    expect(required.code).toBe("POLICY_DENIED");
    expect(required.details.reasonCode).toBe("approval_required");
    const binding = required.details.binding as Record<string, unknown>;
    expect(binding.actionSet).toEqual(["securityProbe"]);
    app.approvals.create({
      revisionHash: String(binding.revisionHash),
      environmentRevisionId: String(binding.environmentRevisionId),
      originSet: binding.originSet as string[],
      actionSet: binding.actionSet as string[],
      policyHash: String(binding.policyHash),
      reason: "Probe the staging shop",
    });

    const { runId } = await app.runs.admit(request, queue);
    expect(app.runs.get(runId)).toMatchObject({ phase: "queued" });
    expect((app.runs.get(runId).matrixCell as Record<string, unknown>).seed).toBe(7);
    // The approval was consumed by that Run: the next one needs a new approval.
    const again = await refusalOf(() => app.runs.admit(request, queue));
    expect(again.details.reasonCode).toBe("approval_required");
  });

  it("REQ-050 a probe runs only in the Docker sandbox", async () => {
    const { app, init, probe } = await open();
    const test = app.tests.createProbe(init.projectId, { spec: probe });
    const refused = await refusalOf(() =>
      app.runs.admit(
        {
          testId: test.id,
          environmentId: init.environmentId,
          extensions: { "testmaster:executor": "process" },
        },
        { wait: true },
      ),
    );
    expect(refused.code).toBe("PRECONDITION_FAILED");
  });

  it("REQ-050 a probe is refused when its source, operations, options or credentials do not fit the project", async () => {
    const { app, init, probe } = await open();
    const code = async (spec: ProbeSpec, projectId = init.projectId) =>
      (await refusalOf(() => app.tests.createProbe(projectId, { spec }))).code;

    expect(await code({ ...probe, operations: ["GET /api/orders"] })).toBe("INVALID_ARGUMENT");
    expect(await code({ ...probe, api: "graphql" })).toBe("INVALID_ARGUMENT");
    expect(
      await code({
        ...probe,
        credentials: [
          { header: "Authorization", secretRef: "sec_01900000-0000-7000-8000-000000000001" },
        ],
      }),
    ).toBe("NOT_FOUND");
    const other = app.projects.create({ name: "Other" });
    expect(await code(probe, other.id)).toBe("INVALID_ARGUMENT");

    const accepted = app.tests.createProbe(init.projectId, {
      spec: { ...probe, operations: ["GET /api/products/{id}"] },
    });
    const revision = app.revisions.get(String(accepted.activeRevisionId));
    expect(revision).toMatchObject({ runnerKind: "probe", plan: null });
    // Defaults are frozen into the revision, so equal probes hash alike.
    expect(revision.probe).toMatchObject({
      maxExamples: 100,
      checks: [
        "not_a_server_error",
        "status_code_conformance",
        "content_type_conformance",
        "response_schema_conformance",
      ],
    });
  });
});

describe("M5-06 security and load probes", () => {
  const load: ProbeSpec = {
    kind: "load",
    stages: [{ durationSeconds: 5, targetRps: 10 }],
    maxConcurrency: 5,
    request: { method: "GET", path: "/api/products" },
    stopConditions: { maxErrorRate: 0.1, maxP95Ms: 1000 },
    budget: { maxRequests: 100, maxDurationSeconds: 10 },
  };
  const dast: ProbeSpec = {
    kind: "dast",
    startPaths: ["/"],
    spider: { maxDurationMinutes: 1, maxChildren: 10 },
    activeScan: true,
    policy: "api-minimal",
    failOn: "high",
  };

  it("REQ-048 REQ-049 a production environment never receives DAST or load traffic, even with a bound approval", async () => {
    const { app, init } = await open();
    const owner = await app.secrets.set("owner-token", "Bearer owner", { ephemeral: true });
    const production = app.environments.create({
      projectId: init.projectId,
      name: "production",
      baseUrl: "http://127.0.0.1:8080",
      production: true,
    });
    const environmentRevisionId = String(production.activeRevisionId);
    const admitted = async (spec: ProbeSpec) => {
      const test = app.tests.createProbe(init.projectId, { spec });
      const revision = app.revisions.get(String(test.activeRevisionId));
      app.approvals.create({
        revisionHash: String(revision.contentHash),
        environmentRevisionId,
        originSet: ["http://127.0.0.1:8080"],
        actionSet: ["securityProbe"],
        policyHash: app.config.effectiveConfig.policyHash,
        reason: "Probe production",
      });
      return refusalOf(() =>
        app.runs.admit(
          {
            testId: test.id,
            environmentId: production.id,
            extensions: { "testmaster:executor": "docker" },
          },
          { wait: true },
        ),
      );
    };
    for (const spec of [load, dast]) {
      const refused = await admitted(spec);
      expect(refused.code).toBe("POLICY_DENIED");
      expect(refused.details.reasonCode).toBe("production_load_refused");
    }
    // An access check sends one request per operation and party: production may run it.
    const access = await admitted({
      kind: "access",
      operations: [{ method: "GET", path: "/api/orders" }],
      owner: [{ header: "Authorization", secretRef: owner.id }],
      intruder: [],
      expect: [401],
    });
    expect(access.details.reasonCode).not.toBe("production_load_refused");
  });

  it("REQ-049 a load test whose schedule outlasts the Attempt is refused before it is queued", async () => {
    const { app, init } = await open();
    const test = app.tests.createProbe(init.projectId, {
      spec: {
        ...load,
        stages: [{ durationSeconds: 400, targetRps: 10 }],
        budget: { maxRequests: 4000, maxDurationSeconds: 400 },
      },
    });
    const request = {
      testId: test.id,
      environmentId: init.environmentId,
      extensions: { "testmaster:executor": "docker" },
    };
    const outlasting = await refusalOf(() => app.runs.admit(request, { wait: true }));
    expect(outlasting.code).toBe("INVALID_ARGUMENT");
    // A longer Attempt admits it as far as the approval it still needs.
    const longer = await refusalOf(() =>
      app.runs.admit({ ...request, limits: { attemptTimeoutMs: 600000 } }, { wait: true }),
    );
    expect(longer.details.reasonCode).toBe("approval_required");
  });

  it("VAL-043 an approval for the environment's origins does not cover a target override", async () => {
    const { app, init } = await open();
    const test = app.tests.createProbe(init.projectId, { spec: load });
    const request = {
      testId: test.id,
      environmentId: init.environmentId,
      extensions: {
        "testmaster:executor": "docker",
        "testmaster:targetUrl": "http://127.0.0.1:9911",
      },
    };
    const required = await refusalOf(() => app.runs.admit(request, { wait: true }));
    const binding = required.details.binding as Record<string, unknown>;
    expect(binding.originSet).toContain("http://127.0.0.1:9911");
    const approve = (originSet: string[]) =>
      app.approvals.create({
        revisionHash: String(binding.revisionHash),
        environmentRevisionId: String(binding.environmentRevisionId),
        originSet,
        actionSet: ["securityProbe"],
        policyHash: String(binding.policyHash),
        reason: "Load the staging shop",
      });
    approve((binding.originSet as string[]).filter((origin) => origin !== "http://127.0.0.1:9911"));
    const environmentOnly = await refusalOf(() => app.runs.admit(request, { wait: true }));
    expect(environmentOnly.details.reasonCode).toBe("approval_required");
    approve(binding.originSet as string[]);
    const { runId } = await app.runs.admit(request, { wait: true });
    expect(app.runs.get(runId)).toMatchObject({ phase: "queued" });
  });

  it("REQ-048 an access intruder holding an owner credential is refused", async () => {
    const { app, init } = await open();
    const owner = await app.secrets.set("owner-token", "Bearer owner", { ephemeral: true });
    const intruder = await app.secrets.set("intruder-token", "Bearer intruder", {
      ephemeral: true,
    });
    const access = (intruders: string[]): ProbeSpec => ({
      kind: "access",
      operations: [{ method: "GET", path: "/api/orders" }],
      owner: [{ header: "Authorization", secretRef: owner.id }],
      intruder: intruders.map((secretRef) => ({ header: "Authorization", secretRef })),
      expect: [401, 403],
    });
    const refused = await refusalOf(() =>
      app.tests.createProbe(init.projectId, { spec: access([owner.id]) }),
    );
    expect(refused.code).toBe("INVALID_ARGUMENT");
    const accepted = app.tests.createProbe(init.projectId, { spec: access([intruder.id]) });
    expect(app.revisions.get(String(accepted.activeRevisionId))).toMatchObject({
      runnerKind: "probe",
      plan: null,
    });
  });
});
