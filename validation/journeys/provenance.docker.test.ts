import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { Application } from "@testmaster/application";
import { LeaseRepository } from "@testmaster/persistence";
import { expect, it } from "vitest";
import { entity } from "../../packages/application/src/context.js";
import { readImageLock } from "../../packages/sandbox/src/images/lock.js";
import { controlledShop, healthPlan, items, journey, object, root, text } from "./harness.js";

it("seals admitted provenance, replays the old environment and refuses tamper and changed images before target effects", async () => {
  await journey("provenance-strict-replay", async (session) => {
    const target = await controlledShop();
    try {
      const identity = await session.init(target.url);
      const test = await session.createTest(healthPlan());
      const executed = await session.command([
        "test",
        "run",
        text(test.id),
        "--wait",
        "--timeout",
        "120",
      ]);
      const original = object(executed.run);
      expect(original.outcome).toBe("passed");
      const runId = text(original.id);
      const originalCell = object(original.matrixCell);
      const pinned = object(originalCell.admissionSnapshot);
      const lock = await readImageLock(join(root, "containers/images.lock.json"));
      const bundle = await session.committed(runId);
      const manifest = object(
        JSON.parse(await readFile(join(bundle.directory, "manifest.json"), "utf8")),
      );
      expect(object(manifest.executionSnapshot)).toMatchObject({
        seed: 0,
        runnerImageDigest: lock["testmaster-runner"].imageId,
        browserImageDigest: lock["testmaster-runner"].baseDigest,
        buildInputsHash: lock["testmaster-runner"].buildInputsHash,
        seccompHash: lock["testmaster-runner"].seccomp.profileSha256,
        policyHash: pinned.policyHash,
      });
      expect(object(manifest.reproduction)).toMatchObject({
        degree: "strict-execution-replay",
        limitations: expect.arrayContaining([
          "source-binding-unavailable",
          "mutable-external-target",
          "browser-platform-rendering",
        ]),
      });
      const environment = await session.command(["env", "get", text(identity.environmentId)]);
      await session.command([
        "env",
        "update",
        text(environment.id),
        "--locale",
        "pt-BR",
        "--expected-version",
        String(environment.version),
      ]);
      const configPath = join(session.cwd, "testmaster.config.json");
      const config = object(JSON.parse(await readFile(configPath, "utf8")));
      config.browser = { ...object(config.browser), viewport: { width: 640, height: 480 } };
      await writeFile(configPath, JSON.stringify(config));
      await mkdir(join(session.home, ".config/testmaster"), { recursive: true });
      await writeFile(
        join(session.home, ".config/testmaster/policy.json"),
        JSON.stringify({ allowCiHealing: true }),
      );
      const replayed = await session.command([
        "test",
        "rerun",
        runId,
        "--wait",
        "--timeout",
        "120",
      ]);
      const replay = object(replayed.run);
      expect(replay).toMatchObject({
        outcome: "passed",
        revisionId: original.revisionId,
        environmentRevisionId: original.environmentRevisionId,
      });
      expect(replay.id).not.toBe(runId);
      expect(object(replay.matrixCell)).toMatchObject({
        originalRunId: runId,
        effectiveConfig: originalCell.effectiveConfig,
        admissionSnapshot: pinned,
      });
      const report = await session.command([
        "report",
        "export",
        text(replay.id),
        "--format",
        "json",
      ]);
      const reportSnapshot = object(JSON.parse(text(report.content)));
      expect(object(items(reportSnapshot.runs)[0]?.reproduction)).toMatchObject({
        degree: "evidence-replay",
        executionDegree: "strict-execution-replay",
      });
      const manifestPath = join(bundle.directory, "manifest.json");
      const originalManifest = await readFile(manifestPath);
      await writeFile(
        manifestPath,
        originalManifest.toString().replace("strict-execution-replay", "fresh-llm-regeneration"),
      );
      const tampered = await session.start(["test", "rerun", runId, "--wait"]).result;
      expect(tampered.exitCode).not.toBe(0);
      await writeFile(manifestPath, originalManifest);
      expect(object(object(tampered.json).error).details).toMatchObject({
        incompatibility: "evidence_hash_mismatch",
      });
      const db = new DatabaseSync(join(session.dataDir, "testmaster.db"));
      try {
        const row = db.prepare("SELECT data_json FROM runs WHERE id=?").get(runId);
        if (!row) throw new Error("Original Run is missing");
        const document = object(JSON.parse(String(row.data_json)));
        object(document.matrixCell).seed = 999;
        expect(() =>
          db.prepare("UPDATE runs SET data_json=? WHERE id=?").run(JSON.stringify(document), runId),
        ).toThrow("terminal_immutable");
      } finally {
        db.close();
      }
      const app = await Application.open({
        cwd: session.cwd,
        home: session.home,
        env: session.env,
      });
      try {
        expect(app.config.effectiveConfig.policyHash).not.toBe(pinned.policyHash);
        await writeFile(
          join(session.cwd, "source.md"),
          "# Health\nThe API reports healthy status.\n",
        );
        const source = await app.sources.add({
          projectId: text(identity.projectId),
          role: "requirements",
          path: "source.md",
        });
        const boundPlan = healthPlan();
        const requirement = entity(app.context, "req", {
          text: "Health reports ok",
          acceptanceCriteria: ["Health status is ok"],
          sourceRefs: [
            { sourceRevisionId: source.revision.id, contentHash: source.revision.contentHash },
          ],
          originKind: "user_spec",
          confidence: null,
          approval: null,
        });
        app.context.entities.insert("Requirement", requirement, {
          projectId: text(identity.projectId),
        });
        boundPlan.requirementRefs = [requirement.id];
        const boundTest = app.tests.create({
          projectId: text(identity.projectId),
          plan: boundPlan,
        });
        app.config.modelProviders.push({
          id: "admitted-model",
          kind: "openai-compatible",
          baseUrl: "http://127.0.0.1:1/v1",
          apiKeyEnv: "ABSENT_KEY",
          models: [{ id: "model-a", capabilities: { structuredJson: true } }],
        });
        const pinnedReceipt = await app.runs.admit(
          { testId: boundTest.id, environmentId: text(identity.environmentId) },
          { wait: true },
        );
        const pinnedBefore = object(app.runs.get(pinnedReceipt.runId).matrixCell).admissionSnapshot;
        await writeFile(
          join(session.cwd, "source.md"),
          "# Health\nChanged input after admission.\n",
        );
        await app.sources.add({
          projectId: text(identity.projectId),
          role: "requirements",
          path: "source.md",
          sourceId: source.source.id,
          expectedVersion: source.source.version,
        });
        const configuredModel = app.config.modelProviders[0]?.models[0];
        if (!configuredModel) throw new Error("Admitted model is missing");
        configuredModel.id = "model-b";
        await app.worker.run({ ephemeral: true, runIds: [pinnedReceipt.runId] });
        expect(app.runs.get(pinnedReceipt.runId).outcome).toBe("passed");
        expect(object(app.runs.get(pinnedReceipt.runId).matrixCell).admissionSnapshot).toEqual(
          pinnedBefore,
        );
        expect(object(pinnedBefore).sourceRevisions).toEqual([
          { id: source.revision.id, contentHash: source.revision.contentHash },
        ]);
        const admitted = await app.runs.admit(
          { testId: text(test.id), environmentId: text(identity.environmentId) },
          { wait: true },
        );
        const before = app.runs.get(admitted.runId);
        const badCell = object(before.matrixCell);
        badCell.seed = 999;
        app.database.run(
          "UPDATE runs SET data_json=? WHERE id=?",
          JSON.stringify(before),
          admitted.runId,
        );
        await app.worker.run({ ephemeral: true, runIds: [admitted.runId] });
        expect(app.runs.get(admitted.runId).outcome).toBe("blocked");
        expect(app.runs.steps(admitted.runId)).toEqual([]);
        expect(app.runs.events(admitted.runId)).toContainEqual(
          expect.objectContaining({
            type: "run.execution_error",
            payload: expect.objectContaining({
              details: expect.objectContaining({ incompatibility: "policy_or_seed_hash_mismatch" }),
            }),
          }),
        );
        const imageReceipt = await app.runs.admit(
          { testId: text(test.id), environmentId: text(identity.environmentId) },
          { wait: true },
        );
        const imageSnapshot = structuredClone(
          object(app.runs.get(imageReceipt.runId).matrixCell).admissionSnapshot,
        );
        const leases = new LeaseRepository(app.database);
        const first = leases.claim({
          workspaceId: app.context.workspaceId,
          queue: "local",
          owner: "provenance-retry",
          runIds: [imageReceipt.runId],
        });
        expect(first).not.toBeNull();
        if (!first) throw new Error("Retry Attempt was not claimed");
        leases.release(first, true);
        const changed = structuredClone(lock);
        changed["testmaster-runner"].buildInputsHash = "a".repeat(64);
        changed["testmaster-runner"].imageId = lock["testmaster-runner-python"].imageId;
        const changedDirectory = join(session.temporary, "changed-lock");
        await mkdir(changedDirectory);
        await writeFile(join(changedDirectory, "images.lock.json"), JSON.stringify(changed));
        await writeFile(
          join(changedDirectory, "seccomp_profile.json"),
          await readFile(join(root, "containers/seccomp_profile.json")),
        );
        Reflect.set(app, "lockPath", join(changedDirectory, "images.lock.json"));
        await app.worker.run({ ephemeral: true, runIds: [imageReceipt.runId] });
        expect(app.runs.get(imageReceipt.runId).outcome).toBe("blocked");
        expect(app.runs.steps(imageReceipt.runId)).toEqual([]);
        expect(object(app.runs.get(imageReceipt.runId).matrixCell).admissionSnapshot).toEqual(
          imageSnapshot,
        );
        expect(app.runs.events(imageReceipt.runId)).toContainEqual(
          expect.objectContaining({
            type: "run.execution_error",
            payload: expect.objectContaining({
              details: expect.objectContaining({ incompatibility: "image_digest_changed" }),
            }),
          }),
        );
        session.oracles.push({
          check: "strictOldRunAndTamperImageRefusal",
          healthy: true,
          originalRunId: runId,
          replayRunId: replay.id,
          blockedRunId: admitted.runId,
          sealedImage: lock["testmaster-runner"].imageId,
        });
        const replacement = app.environments.create({
          projectId: text(identity.projectId),
          name: "replacement",
          baseUrl: target.url,
        });
        const project = app.projects.get(text(identity.projectId));
        app.projects.update(project.id, { defaultEnvironmentId: replacement.id }, project.version);
      } finally {
        app.close();
      }
      const selected = await session.command(["env", "get", text(identity.environmentId)]);
      await session.command([
        "env",
        "archive",
        text(selected.id),
        "--expected-version",
        String(selected.version),
      ]);
      const unavailable = await session.start(["test", "rerun", runId, "--wait"]).result;
      expect(object(object(unavailable.json).error).details).toMatchObject({
        incompatibility: "environment_unavailable",
      });
    } finally {
      await target.close();
    }
  });
}, 240_000);
