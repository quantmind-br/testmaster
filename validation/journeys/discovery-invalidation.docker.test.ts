import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { Application, entity } from "@testmaster/application";
import { expect, it } from "vitest";
import { controlledShop, healthPlan, journey } from "./harness.js";

it("source and code update supersede authoring descendants while admitted and strict pinned Runs execute", async () => {
  await journey("discovery-descendant-invalidation", async (session) => {
    const shop = await controlledShop();
    const identity = await session.init(shop.url);
    const app = await Application.open({ cwd: session.cwd, home: session.home, env: session.env });
    const projectId = String(identity.projectId);
    try {
      await writeFile(join(session.cwd, "prd.md"), "Health MUST report healthy=true.");
      await writeFile(
        join(session.cwd, "server.ts"),
        "const app={};app.get('/health',()=>({healthy:true}));",
      );
      const source = await app.sources.add({ projectId, role: "prd", path: "prd.md" });
      const firstDiscovery = await app.discovery.discover({ projectId });
      const test = app.tests.create({ projectId, plan: healthPlan() });
      const environmentId = String(identity.environmentId);
      const admitted = await app.runs.admit(
        { testId: test.id, environmentId, mode: "replay" },
        { wait: true },
      );
      const pinned = structuredClone(app.runs.get(admitted.runId));
      const batch = entity(app.context, "pbt", {
        projectId,
        sourceSnapshotId: firstDiscovery.job.inputsFingerprint,
        state: "proposed",
      });
      app.context.entities.insert("ProposalBatch", batch);
      await writeFile(
        join(session.cwd, "prd.md"),
        "Health MUST report healthy=true and stable contract version.",
      );
      await app.sources.add({
        projectId,
        role: "prd",
        path: "prd.md",
        sourceId: source.source.id,
        expectedVersion: source.source.version,
      });
      expect(app.proposals.get(batch.id).state).toBe("stale");
      await writeFile(
        join(session.cwd, "server.ts"),
        "const app={};app.get('/new-health',()=>({healthy:false}));",
      );
      const changed = await app.discovery.discover({ projectId });
      expect(changed.job.inputsFingerprint).not.toBe(firstDiscovery.job.inputsFingerprint);
      expect(app.runs.get(admitted.runId).revisionId).toBe(pinned.revisionId);
      expect(app.runs.get(admitted.runId).matrixCell).toEqual(pinned.matrixCell);
      await app.worker.run({ ephemeral: true, runIds: [admitted.runId] });
      expect(app.runs.get(admitted.runId).outcome).toBe("passed");
      const replay = await app.runs.rerun(admitted.runId, { wait: true });
      await app.worker.run({ ephemeral: true, runIds: [replay.runId] });
      expect(app.runs.get(replay.runId).outcome).toBe("passed");
      expect(app.sources.revision(source.revision.id).revision).toEqual(source.revision);
      session.oracles.push({
        name: "pinned-run-survives-invalidation",
        admittedRunId: admitted.runId,
        replayRunId: replay.runId,
        staleBatchId: batch.id,
        beforeFingerprint: firstDiscovery.job.inputsFingerprint,
        afterFingerprint: changed.job.inputsFingerprint,
      });
    } finally {
      app.close();
      await shop.close();
    }
  });
}, 240000);
