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
