import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExecutablePlan, Requirement } from "@testmaster/contracts";
import { canonicalJson } from "@testmaster/domain";
import { afterEach, expect, it } from "vitest";
import { Application } from "./application.js";
import { scaffoldPlan } from "./authoring.js";
import { entity } from "./context.js";

const apps: Application[] = [];
const roots: string[] = [];
afterEach(async () => {
  for (const app of apps.splice(0)) app.close();
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

function requestPlan(name: string, path: string, requirementRefs: string[] = []): ExecutablePlan {
  const plan = scaffoldPlan("backend");
  plan.name = name;
  plan.requirementRefs = requirementRefs;
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
  ];
  return plan;
}

interface Fixture {
  app: Application;
  root: string;
  projectId: string;
  environmentId: string;
}

async function fixture(): Promise<Fixture> {
  const root = await mkdtemp(join(tmpdir(), "tm-feature-map-"));
  roots.push(root);
  const home = join(root, "home");
  await mkdir(home);
  const app = await Application.open({ cwd: root, home, env: { HOME: home } });
  apps.push(app);
  const init = await app.init();
  return { app, root, projectId: init.projectId, environmentId: init.environmentId };
}

/** Writes a requirement snapshot directly: normalization itself is covered with a fake provider elsewhere. */
function seedRequirement(
  f: Fixture,
  key: string,
  text: string,
  sourceRefs: Requirement["sourceRefs"],
): Requirement {
  const value = entity(f.app.context, "req", {
    text,
    acceptanceCriteria: [text],
    sourceRefs,
    originKind: "explicit",
    confidence: null,
    approval: null,
    extensions: { "testmaster:projectId": f.projectId, "testmaster:key": key },
  }) as unknown as Requirement;
  f.app.context.entities.insert("Requirement", value, { projectId: f.projectId });
  const snapshot = f.app.requirements.snapshot(f.projectId);
  const next = {
    ...snapshot,
    version: snapshot.version + 1,
    requirements: [...snapshot.requirements, value],
  };
  f.app.context.database.run(
    "INSERT INTO operational_state(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value",
    `requirements:${f.app.context.workspaceId}:${f.projectId}`,
    canonicalJson(next),
  );
  return value;
}

function recordRun(
  f: Fixture,
  testId: string,
  outcome: "passed" | "failed" | "inconclusive" | "blocked",
) {
  const run = f.app.runs.prepare({ testId, environmentId: f.environmentId });
  Object.assign(run, {
    phase: "completed",
    status: outcome === "passed" ? "passed" : outcome,
    outcome,
    gate: outcome === "passed" ? "passed" : "failed",
  });
  f.app.context.entities.insert("Run", run);
  return run;
}

it("UX-013 shows no coverage, tests without a valid run and valid runs as three different states", async () => {
  const f = await fixture();
  await writeFile(
    join(f.root, "server.ts"),
    "import express from 'express'; const app = express(); app.get('/health', (req,res) => res.json({ok:true})); app.get('/orders', (req,res) => res.json([]));",
  );
  await f.app.discovery.discover({ projectId: f.projectId });
  await writeFile(
    join(f.root, "openapi.json"),
    JSON.stringify({
      openapi: "3.0.3",
      info: { title: "Shop", version: "1" },
      paths: { "/health": { get: { responses: { "200": { description: "ok" } } } } },
    }),
  );
  const spec = await f.app.sources.add({
    projectId: f.projectId,
    role: "api-spec",
    path: "openapi.json",
  });
  const covered = seedRequirement(f, "health", "Health reports ok", [
    {
      sourceRevisionId: spec.revision.id,
      contentHash: spec.chunks[0]?.contentHash,
      jsonPointer: "/paths/~1health/get",
    },
  ]);
  seedRequirement(f, "refunds", "Refunds can be requested", []);
  const withRun = f.app.tests.create({
    projectId: f.projectId,
    plan: requestPlan("Health check", "/health", [covered.id]),
  });
  const withoutRun = f.app.tests.create({
    projectId: f.projectId,
    plan: requestPlan("Orders list", "/orders"),
  });
  recordRun(f, withRun.id, "passed");
  recordRun(f, withoutRun.id, "inconclusive");
  const map = f.app.featureMap.get(f.projectId);
  const byKey = (key: string) => {
    const row = map.rows.find((item) => item.key === key);
    if (!row) throw new Error(`No row ${key}`);
    return row;
  };
  expect(byKey(`requirement:${covered.id}`)).toMatchObject({ coverage: "valid_run" });
  expect(byKey(`requirement:${covered.id}`).tests.map((item) => item.testId)).toEqual([withRun.id]);
  expect(map.rows.find((row) => row.title.startsWith("refunds:"))?.key).toMatch(/^requirement:/u);
  expect(map.rows.find((row) => row.title.startsWith("refunds:"))).toMatchObject({
    coverage: "no_tests",
    tests: [],
    evidence: [],
  });
  // An inconclusive run is not evidence: the endpoint has a test but still no valid run.
  expect(byKey("endpoint:GET:/orders")).toMatchObject({ coverage: "tests_without_valid_run" });
  expect(byKey("endpoint:GET:/orders").evidence).toEqual([
    expect.objectContaining({ outcome: "inconclusive", valid: false }),
  ]);
  expect(byKey("endpoint:GET:/health")).toMatchObject({ coverage: "valid_run" });
  expect(map.summary).toMatchObject({ noTests: 1, testsWithoutValidRun: 1, validRun: 2 });
  // Negative control: a failed Run is still a valid measurement, a blocked one is not.
  recordRun(f, withoutRun.id, "failed");
  expect(
    f.app.featureMap.get(f.projectId).rows.find((row) => row.key === "endpoint:GET:/orders")
      ?.coverage,
  ).toBe("valid_run");
});

it("UX-013 never reports a requirement as covered when no test links to it and says discovery has not run", async () => {
  const f = await fixture();
  seedRequirement(f, "alone", "Alone", []);
  const map = f.app.featureMap.get(f.projectId);
  expect(map.discovery).toBeNull();
  expect(map.rows).toHaveLength(1);
  expect(map.rows[0]?.coverage).toBe("no_tests");
  expect(map.limitations.join(" ")).toContain("No code discovery has run");
  expect(map.summary).toEqual({ noTests: 1, testsWithoutValidRun: 0, validRun: 0 });
  // Negative control: after discovery runs, the limitation disappears and the latest run is named.
  await writeFile(
    join(f.root, "server.ts"),
    "import express from 'express'; const app = express(); app.get('/x', (a,b)=>b.end());",
  );
  const discovered = await f.app.discovery.discover({ projectId: f.projectId });
  const after = f.app.featureMap.get(f.projectId);
  expect(after.discovery?.id).toBe(discovered.job.id);
  expect(after.limitations.join(" ")).not.toContain("No code discovery has run");
});

it("UX-014 lists discovery runs newest first with scope, counts and the files that were skipped", async () => {
  const f = await fixture();
  await writeFile(
    join(f.root, "server.ts"),
    "import express from 'express'; const app = express(); app.get('/health', (a,b)=>b.end());",
  );
  await writeFile(join(f.root, ".env"), "PASSWORD=must-not-disclose");
  expect(f.app.discovery.list(f.projectId)).toEqual([]);
  const first = await f.app.discovery.discover({ projectId: f.projectId });
  await writeFile(
    join(f.root, "other.ts"),
    "import express from 'express'; const app = express(); app.get('/other', (a,b)=>b.end());",
  );
  const second = await f.app.discovery.discover({ projectId: f.projectId });
  const listed = f.app.discovery.list(f.projectId);
  expect(listed.map((item) => item.id)).toEqual([second.job.id, first.job.id]);
  expect(listed[0]).toMatchObject({ scope: "codebase", status: "partial", phase: "completed" });
  expect(listed[0]?.counts.endpoints).toBeGreaterThan(listed[1]?.counts.endpoints ?? 0);
  expect(listed[1]?.counts.skippedFiles).toBeGreaterThan(0);
  // The list carries counts only, never file contents or the skipped paths themselves.
  expect(JSON.stringify(listed)).not.toContain("must-not-disclose");
});
