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
import {
  candidateRequirementCoverage,
  reportCoverage,
  verifiedRequirementCoverage,
} from "./coverage.js";

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

it("operation coverage counts and covers Swagger 2 response schemas", async () => {
  const { app, root, projectId, environmentId } = await openApp();
  await writeFile(
    join(root, "swagger.json"),
    JSON.stringify({
      swagger: "2.0",
      info: { title: "Auth", version: "1" },
      basePath: "/api/v1",
      paths: {
        "/auth/me": {
          get: {
            responses: {
              "200": { description: "ok", schema: { type: "object" } },
              "401": { description: "no session" },
            },
          },
        },
      },
    }),
  );
  const { revision } = await app.sources.add({ projectId, role: "api-spec", path: "swagger.json" });
  const plan = scaffoldPlan("backend");
  plan.steps = [
    {
      id: "call",
      kind: "action",
      operation: "request",
      description: "Read the session user under the basePath, as generated plans call it",
      input: {
        method: "GET",
        pathSegments: ["api", "v1", "auth", "me"].map((literal) => ({ literal })),
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
        pointer: "/paths/~1auth~1me/get/responses/200/schema",
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
  // Only the 200 response declares a schema; the 401 has none and is not an operation pair.
  expect(reportCoverage(app.context, report).operation).toMatchObject({
    numerator: 1,
    denominator: 1,
  });
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

it("verifiedRequirementCoverage judges each test by its current revision's latest run, not a later run of another revision", async () => {
  const { app, projectId, environmentId } = await openApp();
  const mixed = seed(app, projectId, "mixed");
  const regressed = seed(app, projectId, "regressed");
  storeRequirements(app, projectId, [mixed, regressed]);
  const testFor = (requirement: Requirement) => {
    const plan = scaffoldPlan("backend");
    plan.requirementRefs = [requirement.id];
    return app.tests.create({ projectId, plan }).id;
  };
  const mixedTest = testFor(mixed);
  const regressedTest = testFor(regressed);
  const prepare = (testId: string) => app.runs.prepare({ testId, environmentId });
  // A suite that pins the active plan and a code revision of the same test: the code revision's
  // run comes later and is stale for the test (another revision), and has no plan assertion.
  const planRun = passedItem(projectId, prepare(mixedTest));
  const codeRun = passedItem(projectId, prepare(mixedTest), {
    steps: [{ planStepId: "imported-code", status: "passed" }],
    freshness: { state: "stale", reasons: ["test_revision_changed"] },
  });
  // Negative control: a later current run of the same revision that failed still supersedes an
  // earlier pass.
  const earlierPass = passedItem(projectId, prepare(regressedTest));
  const laterFailure = passedItem(projectId, prepare(regressedTest), {
    steps: [{ planStepId: "check-status", status: "failed" }],
    result: {
      outcome: "failed",
      gate: "failed",
      passedOnRetry: false,
      firstAttemptOutcome: "failed",
    },
  });
  const runs = [planRun, codeRun, earlierPass, laterFailure];
  const report = {
    runs,
    selection: { requestedRunIds: runs.map((item) => item.run.id), notDispatched: [] },
  } as unknown as ReportSnapshot;

  expect(verifiedRequirementCoverage(app.context, report)).toMatchObject({
    numerator: 1,
    denominator: 2,
  });
});

it("a candidate run verifies nothing, but candidateRequirementCoverage lists what it would verify once promoted", async () => {
  const { app, projectId, environmentId } = await openApp();
  const planned = seed(app, projectId, "planned");
  const generated = seed(app, projectId, "generated");
  const superseded = seed(app, projectId, "superseded");
  const active = seed(app, projectId, "active");
  storeRequirements(app, projectId, [planned, generated, superseded, active]);
  const testFor = (requirement: Requirement) => {
    const plan = scaffoldPlan("backend");
    plan.requirementRefs = [requirement.id];
    return app.tests.create({ projectId, plan });
  };
  const prepare = (testId: string) => app.runs.prepare({ testId, environmentId });
  // A candidate with its own plan verifies through the plan's required assertion.
  const plannedRun = passedItem(projectId, prepare(testFor(planned).id), {
    freshness: { state: "candidate", reasons: ["revision_not_active"] },
  });
  // A generated-code candidate has no plan: it maps to the requirements of its parent's plan.
  const generatedTest = testFor(generated);
  const codeRevision = entity(app.context, "rev", {
    testId: generatedTest.id,
    ordinal: 2,
    contentHash: app.revisions.get(String(generatedTest.activeRevisionId)).contentHash,
    plan: null,
    codeArtifactId: null,
    runnerKind: "playwright",
    author: app.context.principalId,
    parentId: generatedTest.activeRevisionId,
    origin: "generated",
  });
  app.context.entities.insert("TestRevision", codeRevision);
  const codeRun = passedItem(
    projectId,
    { ...prepare(generatedTest.id), revisionId: codeRevision.id } as unknown as ReportRun["run"],
    {
      steps: [{ planStepId: "imported-code", status: "passed" }],
      freshness: { state: "candidate", reasons: ["revision_not_active"] },
    },
  );
  // Controls: a superseded revision and a failed candidate verify nothing, and a requirement
  // already verified by its active revision is not counted twice.
  const supersededRun = passedItem(projectId, prepare(testFor(superseded).id), {
    freshness: { state: "stale", reasons: ["test_revision_changed"] },
  });
  const activeTest = testFor(active);
  const activeRun = passedItem(projectId, prepare(activeTest.id));
  const failedCandidate = passedItem(projectId, prepare(activeTest.id), {
    steps: [{ planStepId: "check-status", status: "failed" }],
    result: {
      outcome: "failed",
      gate: "failed",
      passedOnRetry: false,
      firstAttemptOutcome: "failed",
    },
    freshness: { state: "candidate", reasons: ["revision_not_active"] },
  });
  const runs = [plannedRun, codeRun, supersededRun, activeRun, failedCandidate];
  const report = {
    runs,
    selection: { requestedRunIds: runs.map((item) => item.run.id), notDispatched: [] },
  } as unknown as ReportSnapshot;

  expect(verifiedRequirementCoverage(app.context, report)).toMatchObject({
    numerator: 1,
    denominator: 4,
  });
  expect(candidateRequirementCoverage(app.context, report)).toMatchObject({
    numerator: 2,
    denominator: 4,
  });
});

it("a current code revision verifies the requirements of the plan in its ancestry; code with no plan ancestor verifies none", async () => {
  const { app, projectId, environmentId } = await openApp();
  const generated = seed(app, projectId, "generated");
  const unrelated = seed(app, projectId, "unrelated");
  storeRequirements(app, projectId, [generated, unrelated]);
  const codeRun = (requirement: Requirement, linked: boolean) => {
    const plan = scaffoldPlan("backend");
    plan.requirementRefs = [requirement.id];
    const test = app.tests.create({ projectId, plan });
    const revision = entity(app.context, "rev", {
      testId: test.id,
      ordinal: 2,
      contentHash: app.revisions.get(String(test.activeRevisionId)).contentHash,
      plan: null,
      codeArtifactId: null,
      runnerKind: "playwright",
      author: app.context.principalId,
      parentId: linked ? test.activeRevisionId : null,
      origin: linked ? "generated" : "imported",
    });
    app.context.entities.insert("TestRevision", revision);
    return passedItem(
      projectId,
      {
        ...app.runs.prepare({ testId: test.id, environmentId }),
        revisionId: revision.id,
      } as unknown as ReportRun["run"],
      { steps: [{ planStepId: "imported-code", status: "passed" }] },
    );
  };
  const runs = [codeRun(generated, true), codeRun(unrelated, false)];
  const report = {
    runs,
    selection: { requestedRunIds: runs.map((item) => item.run.id), notDispatched: [] },
  } as unknown as ReportSnapshot;

  expect(verifiedRequirementCoverage(app.context, report)).toMatchObject({
    numerator: 1,
    denominator: 2,
  });
});
