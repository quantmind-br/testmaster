import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Requirement } from "@testmaster/contracts";
import { canonicalJson } from "@testmaster/domain";
import type { ReportSnapshot } from "@testmaster/reporting";
import { afterEach, expect, it } from "vitest";
import { Application } from "./application.js";
import { scaffoldPlan } from "./authoring.js";
import { entity } from "./context.js";
import { reportCoverage } from "./coverage.js";

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
