import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Requirement } from "@testmaster/contracts";
import { canonicalJson } from "@testmaster/domain";
import type { ReportRun, ReportSnapshot } from "@testmaster/reporting";
import { afterEach, expect, it } from "vitest";
import { Application } from "./application.js";
import { scaffoldPlan } from "./authoring.js";
import { entity } from "./context.js";
import { reportCoverage, verifiedRequirementCoverage } from "./coverage.js";

const apps: Application[] = [];
const roots: string[] = [];
afterEach(async () => {
  for (const app of apps.splice(0)) app.close();
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

function seed(
  app: Application,
  projectId: string,
  key: string,
  extensions: Record<string, unknown> = {},
): Requirement {
  const value = entity(app.context, "req", {
    text: key,
    acceptanceCriteria: [key],
    sourceRefs: [],
    originKind: "explicit",
    confidence: null,
    approval: null,
    extensions: { "testmaster:projectId": projectId, "testmaster:key": key, ...extensions },
  }) as unknown as Requirement;
  app.context.entities.insert("Requirement", value, { projectId });
  return value;
}

it("requirement coverage counts only requirements still in scope, not rejected or superseded ones", async () => {
  const root = await mkdtemp(join(tmpdir(), "tm-coverage-"));
  roots.push(root);
  const home = join(root, "home");
  await mkdir(home);
  const app = await Application.open({ cwd: root, home, env: { HOME: home } });
  apps.push(app);
  const { projectId, environmentId } = await app.init();
  const rejection = {
    reason: "Out of scope",
    actorId: "usr_x",
    rejectedAt: new Date().toISOString(),
  };
  const covered = seed(app, projectId, "covered");
  const open = seed(app, projectId, "open");
  const rejected = seed(app, projectId, "rejected", { "testmaster:rejection": rejection });
  const superseded = seed(app, projectId, "superseded");
  app.context.database.run(
    "INSERT INTO operational_state(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value",
    `requirements:${app.context.workspaceId}:${projectId}`,
    canonicalJson({
      version: 1,
      fingerprint: "f",
      openQuestions: [],
      requirements: [covered, open, rejected, superseded],
      conflicts: [
        {
          id: "cfl_1",
          requirementIds: [covered.id, superseded.id],
          resolution: { selectedRequirementId: covered.id },
        },
      ],
    }),
  );
  const plan = scaffoldPlan("backend");
  plan.requirementRefs = [covered.id];
  const test = app.tests.create({ projectId, plan });
  const run = app.runs.prepare({ testId: test.id, environmentId });
  const report = {
    runs: [{ projectId, run, steps: [], result: { outcome: "passed" } }],
    selection: { requestedRunIds: [run.id], notDispatched: [] },
  } as unknown as ReportSnapshot;

  const { requirement: metric } = reportCoverage(app.context, report);

  // Two of the four requirements are decided out: the denominator is the two still in scope.
  expect(metric).toMatchObject({ numerator: 1, denominator: 2 });
});

async function openApp() {
  const root = await mkdtemp(join(tmpdir(), "tm-coverage-"));
  roots.push(root);
  const home = join(root, "home");
  await mkdir(home);
  const app = await Application.open({ cwd: root, home, env: { HOME: home } });
  apps.push(app);
  return { app, root, ...(await app.init()) };
}

function storeRequirements(app: Application, projectId: string, requirements: Requirement[]) {
  app.context.database.run(
    "INSERT INTO operational_state(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value",
    `requirements:${app.context.workspaceId}:${projectId}`,
    canonicalJson({
      version: 1,
      fingerprint: "f",
      openQuestions: [],
      requirements,
      conflicts: [],
    }),
  );
}

const SHARED_SCHEMA = {
  content: { "application/json": { schema: { type: "object" } } },
};

function openApi(paths: Record<string, string[]>): string {
  return JSON.stringify({
    openapi: "3.0.3",
    info: { title: "Shop", version: "1" },
    paths: Object.fromEntries(
      Object.entries(paths).map(([path, statuses]) => [
        path,
        {
          get: {
            parameters: [...path.matchAll(/\{([^}]+)\}/g)].map(([, name]) => ({
              name,
              in: "path",
              required: true,
              schema: { type: "string" },
            })),
            responses: Object.fromEntries(
              statuses.map((status) => [status, { description: status, ...SHARED_SCHEMA }]),
            ),
          },
        },
      ]),
    ),
  });
}

it("operation coverage counts an operation restated by another source once", async () => {
  const { app, root, projectId, environmentId } = await openApp();
  await writeFile(
    join(root, "product.json"),
    openApi({ "/items/{id}": ["200"], "/health": ["200"] }),
  );
  // The contract restates both product operations (one with another path parameter name) and adds a 401.
  await writeFile(
    join(root, "contract.json"),
    openApi({ "/items/{item_id}": ["200", "401"], "/health": ["200"] }),
  );
  await app.sources.add({ projectId, role: "api-spec", path: "product.json" });
  await app.sources.add({ projectId, role: "api-spec", path: "contract.json" });
  const test = app.tests.create({ projectId, plan: scaffoldPlan("backend") });
  const run = app.runs.prepare({ testId: test.id, environmentId });
  const report = {
    runs: [{ projectId, run, steps: [], result: { outcome: "passed" } }],
    selection: { requestedRunIds: [run.id], notDispatched: [] },
  } as unknown as ReportSnapshot;

  const { operation } = reportCoverage(app.context, report);

  // GET /items/{id} 200, GET /health 200 and GET /items/{id} 401: three distinct pairs, not four.
  expect(operation).toMatchObject({ numerator: 0, denominator: 3 });
});

it("operation coverage matches a request with literal ids to its templated operation", async () => {
  const { app, root, projectId, environmentId } = await openApp();
  await writeFile(
    join(root, "product.json"),
    openApi({ "/items/{id}": ["200"], "/health": ["200"] }),
  );
  const { revision } = await app.sources.add({ projectId, role: "api-spec", path: "product.json" });
  const covered = (path: string, citedPath: string) => {
    const plan = scaffoldPlan("backend");
    plan.steps = [
      {
        id: "call",
        kind: "action",
        operation: "request",
        description: "Call the endpoint",
        input: {
          method: "GET",
          pathSegments: path
            .split("/")
            .filter(Boolean)
            .map((literal) => ({ literal })),
        },
      },
      {
        id: "status",
        kind: "assertion",
        operation: "assert",
        description: "Status is 200",
        input: { responseStepId: "call" },
        expectation: { predicate: "statusIn", values: [200] },
      },
      {
        id: "schema",
        kind: "assertion",
        operation: "assert",
        description: "Body matches the declared schema",
        input: { responseStepId: "call" },
        expectation: {
          predicate: "jsonSchema",
          sourceRevisionId: revision.id,
          pointer: `/paths/${citedPath.replaceAll("/", "~1")}/get/responses/200/content/application~1json/schema`,
        },
      },
    ];
    const test = app.tests.create({ projectId, plan });
    const run = app.runs.prepare({ testId: test.id, environmentId });
    const report = {
      runs: [
        {
          projectId,
          run,
          steps: plan.steps.map((step) => ({ planStepId: step.id, status: "passed" })),
          result: { outcome: "passed" },
        },
      ],
      selection: { requestedRunIds: [run.id], notDispatched: [] },
    } as unknown as ReportSnapshot;
    return reportCoverage(app.context, report).operation.numerator;
  };

  expect(covered("/items/7", "/items/{id}")).toBe(1);
  // Negative controls: an extra segment is another path, and a schema cited from another operation
  // does not cover the one the request reached.
  expect(covered("/items/7/parts", "/items/{id}")).toBe(0);
  expect(covered("/items/7", "/health")).toBe(0);
});

function passedItem(
  projectId: string,
  run: ReportRun["run"],
  overrides: Record<string, unknown> = {},
): ReportRun {
  return {
    projectId,
    run,
    title: "t",
    environment: "e",
    steps: [{ planStepId: "check-status", status: "passed" }],
    attempts: [{ number: 1, outcome: "passed" }],
    result: {
      outcome: "passed",
      gate: "passed",
      passedOnRetry: false,
      firstAttemptOutcome: "passed",
    },
    evidenceState: "committed",
    freshness: { state: "current" },
    ...overrides,
  } as unknown as ReportRun;
}

it("verifiedRequirementCoverage counts a requirement only when its test passed fresh and on its own", async () => {
  const { app, projectId, environmentId } = await openApp();
  const verified = seed(app, projectId, "verified");
  const stale = seed(app, projectId, "stale");
  const retried = seed(app, projectId, "retried");
  const unmapped = seed(app, projectId, "unmapped");
  storeRequirements(app, projectId, [verified, stale, retried, unmapped]);
  const runFor = (requirement: Requirement) => {
    const plan = scaffoldPlan("backend");
    plan.requirementRefs = [requirement.id];
    const test = app.tests.create({ projectId, plan });
    return app.runs.prepare({ testId: test.id, environmentId });
  };
  const report = (runs: ReportRun[]) =>
    ({
      runs,
      selection: { requestedRunIds: runs.map((item) => item.run.id), notDispatched: [] },
    }) as unknown as ReportSnapshot;
  const runs = [
    passedItem(projectId, runFor(verified)),
    passedItem(projectId, runFor(stale), { freshness: { state: "stale" } }),
    passedItem(projectId, runFor(retried), {
      attempts: [
        { number: 1, outcome: "failed" },
        { number: 2, outcome: "passed" },
      ],
      result: {
        outcome: "passed",
        gate: "passed",
        passedOnRetry: true,
        firstAttemptOutcome: "failed",
      },
    }),
  ];

  expect(verifiedRequirementCoverage(app.context, report(runs))).toMatchObject({
    numerator: 1,
    denominator: 4,
  });
  // Positive control: the same stale run counts once it is current again.
  expect(
    verifiedRequirementCoverage(
      app.context,
      report([runs[0] as ReportRun, passedItem(projectId, runs[1]?.run as ReportRun["run"])]),
    ),
  ).toMatchObject({ numerator: 2, denominator: 4 });
});
