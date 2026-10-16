import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { Application } from "./application.js";
import { scaffoldPlan } from "./authoring.js";

const apps: Application[] = [];
const roots: string[] = [];
afterEach(async () => {
  for (const app of apps.splice(0)) app.close();
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

it("report freshness: a never-promoted newer revision is a candidate, a replaced one is stale, the active one is current", async () => {
  const root = await mkdtemp(join(tmpdir(), "tm-report-freshness-"));
  roots.push(root);
  const home = join(root, "home");
  await mkdir(home);
  const app = await Application.open({ cwd: root, home, env: { HOME: home } });
  apps.push(app);
  const { projectId, environmentId } = await app.init();
  const test = app.tests.create({ projectId, plan: scaffoldPlan("backend") });
  const baselineRevision = String(test.activeRevisionId);
  const candidateRevision = app.revisions.create(
    test.id,
    scaffoldPlan("backend"),
    baselineRevision,
  );
  const runOf = (revisionId: string) => {
    const run = app.runs.prepare({ testId: test.id, environmentId, revisionId });
    Object.assign(run, { phase: "completed", status: "passed", outcome: "passed", gate: "passed" });
    app.context.entities.insert("Run", run);
    return String(run.id);
  };
  const baseline = runOf(baselineRevision);
  const pinned = runOf(candidateRevision.id);
  const freshness = async (runId: string) => (await app.reports.snapshot(runId)).runs[0]?.freshness;

  // The active revision is current; a candidate that was never promoted and is newer than the active
  // one is not stale, because nothing superseded it.
  expect(await freshness(baseline)).toMatchObject({ state: "current", reasons: [] });
  expect(await freshness(pinned)).toMatchObject({
    state: "candidate",
    reasons: ["revision_not_active"],
    currentRevisionId: baselineRevision,
  });
  const before = await app.reports.metrics([baseline, pinned]);
  expect(before.rates.staleEvidenceRate).toMatchObject({ numerator: 0, denominator: 2 });
  expect(before.counts.candidateRuns).toBe(1);

  // Control: promoting the candidate supersedes the baseline's revision, which is stale now, while
  // the promoted revision's run is current.
  app.revisions.promote(candidateRevision.id, Number(app.tests.get(test.id).version));
  expect(await freshness(baseline)).toMatchObject({
    state: "stale",
    reasons: ["test_revision_changed"],
  });
  expect(await freshness(pinned)).toMatchObject({ state: "current", reasons: [] });
  const after = await app.reports.metrics([baseline, pinned]);
  expect(after.rates.staleEvidenceRate).toMatchObject({ numerator: 1, denominator: 2 });
  expect(after.counts.candidateRuns).toBe(0);

  // Control: promoting the older revision again leaves the replaced newer one stale, not a
  // candidate, because it was active once.
  app.revisions.promote(baselineRevision, Number(app.tests.get(test.id).version));
  expect(await freshness(pinned)).toMatchObject({
    state: "stale",
    reasons: ["test_revision_changed"],
  });
  expect(await freshness(baseline)).toMatchObject({ state: "current", reasons: [] });
});
